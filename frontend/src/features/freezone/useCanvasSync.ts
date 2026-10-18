// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef, useState } from "react";
import { useReactFlow, type Viewport } from "@xyflow/react";
import { useTranslation } from "react-i18next";
import {
  useCanvasStore,
  type CanvasEdge,
  type CanvasHistorySnapshot,
  type CanvasHistoryState,
  type CanvasNode,
} from "@/stores/canvasStore";
import {
  applyForeignMediaRepairToNodes,
  publishForeignMediaRefs,
  repairForeignMediaRefs,
} from "@/features/canvas/application/canvasMediaScope";
import {
  createCanvasFromPreset,
  generateClientSaveId,
  getFreezoneCanvas,
  putFreezoneCanvas,
  type CanvasBackupStatus,
  type FreezoneCanvasPayload,
  type FreezoneCanvasSaveResult,
  type FreezonePresetCanvasRequest,
} from "@/api/canvas";
import { ApiError } from "@/api/client";
import type { TFn } from "@/lib/i18n-types";
import {
  buildSavePayload,
  checkPayloadLimits,
  classifySaveError,
  decideSaveAction,
  describePayloadViolation,
  MAX_BODY_BYTES,
  type SaveDecision,
  type SaveResponseOutcome,
} from "./canvasSyncCore";
import {
  EMPTY_SHOT_METADATA,
  useShotMetadataStore,
  type ShotMetadata,
} from "./shotMetadataStore";
import { setFreezoneCanvasMetadata } from "./canvasMetadataContext";
import {
  isCanvasAutosaveHeld,
  subscribeCanvasAutosaveRelease,
} from "./canvasAutosaveHold";
import {
  consumeQueuedLocalFreezoneProjections,
  registerFreezoneCanvasRuntime,
} from "./canvasSyncRuntime";
import {
  mergeProjectedCanvasWithLocalCanvas,
  mergeProjectionMetadata,
  removeProjectionFromLocalCanvas,
  removeProjectionMetadata,
} from "./projections";
import {
  createCanvasSaveSession,
  type CanvasSaveSession,
} from "./canvasSaveCoordinator";
import {
  canvasDraftSignature,
  clearCanvasDraft,
  pruneOldCanvasDrafts,
  readCanvasDraft,
  writeCanvasDraft,
  type StoredCanvasDraft,
} from "./canvasDraftStorage";
import { safeLocalStorageSet } from "@/lib/localStorageQuota";
import {
  beginCanvasHydrateBurst,
  notifyCanvasHydrateViewport,
} from "@/features/canvas/application/canvasLod";

const DEBOUNCE_MS = 800;
const DRAFT_DEBOUNCE_MS = 300;
/** Extra app-level retry attempts when ky surfaces a 503 canvas_lock_busy. */
const LOCK_BUSY_MAX_RETRIES = 1;
export const FREEZONE_HYDRATE_RELEASE_GRACE_MS = 50;
/**
 * How long a settled hydrate result may be reused. Switching the top bar between "Canvas" / "Market" unmounts then
 * remounts the canvas, and reuse saves a full round-trip fetch. Only reused when there were no local edits
 * in the meantime (userEditsSinceHydrate === 0).
 *
 * The window is deliberately short: the reused payload and its revision are treated as the latest; if another tab or
 * collaborator changed the same canvas meanwhile, we would draw stale content and later saves would hit 409. 10 seconds
 * covers "switch away and immediately back"; longer would trade correctness for feel.
 */
export const FREEZONE_HYDRATE_SETTLED_REUSE_MS = 10_000;

/**
 * Which canvas's content the store currently holds. Kept across component mounts (FreezoneShell has no key, so switching
 * canvases reruns the effect on the same instance), to distinguish two cases:
 *   - switching canvases: the old content must be unmounted before the request, else unmount and mount merge into one commit;
 *   - re-entering the same canvas (top-bar Canvas/Market toggle): the store already holds the wanted content, clearing only flashes.
 */
let storeCanvasKey: string | null = null;

/**
 * Who owns a canvas's undo mirror. The read-and-discard cleanup was moved behind scheduleIdle, so the callback may run
 * after the user switched away; meanwhile the user may have switched back and edited, and the mirror on disk then belongs
 * to the new hydrate - the stale callback clearing it would delete the undo stack they just wrote.
 */
/**
 * Landing position when no camera was stored. Matches canvasStore's initial currentViewport and ReactFlow's default
 * viewport - i.e. where a freshly remounted ReactFlow would have put it.
 */
const DEFAULT_HYDRATE_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

let hydrateSeq = 0;
const latestHydrateSeq = new Map<string, number>();

function claimHydrate(key: string): number {
  const seq = ++hydrateSeq;
  latestHydrateSeq.set(key, seq);
  return seq;
}

function ownsHydrate(key: string, seq: number): boolean {
  return latestHydrateSeq.get(key) === seq;
}

function storeKeyOf(project: string, canvasId: string): string {
  // The separator is written in escaped form: a literal 0x00 in the source makes GitHub treat the whole .ts as binary,
  // so PR diffs, code search and some scanners would skip this file.
  return `${project}\u0000${canvasId}`;
}

/**
 * Moves work unrelated to "drawing the canvas" off the critical path. The timeout fallback guarantees it runs however busy things are.
 */
function scheduleIdle(run: () => void, timeout = 2_000): void {
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout });
    return;
  }
  window.setTimeout(run, 200);
}

let prunePending = false;

/** Schedule the legacy draft cleanup only once per page lifetime, and once queued let it run to completion. */
function schedulePruneOnce(): void {
  if (prunePending) return;
  prunePending = true;
  const run = () => {
    pruneOldCanvasDrafts();
  };
  if (typeof window.requestIdleCallback === "function") {
    window.requestIdleCallback(run, { timeout: 2_000 });
    return;
  }
  window.setTimeout(run, 300);
}

type HydrateFlight = {
  controller: AbortController;
  promise: Promise<FreezoneCanvasPayload>;
  consumers: number;
  settled: boolean;
  settledAt: number | null;
  releaseTimer: number | null;
};

const hydrateFlights = new Map<string, HydrateFlight>();

function hydrateFlightKey(
  project: string,
  canvasId: string,
  reloadKey: number,
): string {
  return `${project}\u0000${canvasId}\u0000${reloadKey}`;
}

function acquireHydrateFlight(
  project: string,
  canvasId: string,
  reloadKey: number,
): { promise: Promise<FreezoneCanvasPayload>; release: () => void } {
  const key = hydrateFlightKey(project, canvasId, reloadKey);
  let flight = hydrateFlights.get(key);
  if (flight?.settled) {
    const canReuseJustSettledFlight =
      flight.consumers === 0 &&
      flight.releaseTimer != null &&
      flight.settledAt != null &&
      Date.now() - flight.settledAt <= FREEZONE_HYDRATE_SETTLED_REUSE_MS &&
      useCanvasStore.getState().userEditsSinceHydrate === 0;
    if (!canReuseJustSettledFlight) {
      if (flight.releaseTimer != null) {
        window.clearTimeout(flight.releaseTimer);
      }
      hydrateFlights.delete(key);
      flight = undefined;
    }
  }
  if (!flight) {
    const controller = new AbortController();
    const createdFlight: HydrateFlight = {
      controller,
      promise: getFreezoneCanvas(project, canvasId, {
        signal: controller.signal,
      }),
      consumers: 0,
      settled: false,
      settledAt: null,
      releaseTimer: null,
    };
    void createdFlight.promise.then(
      () => {
        createdFlight.settled = true;
        createdFlight.settledAt = Date.now();
      },
      () => {
        createdFlight.settled = true;
        createdFlight.settledAt = Date.now();
      },
    );
    hydrateFlights.set(key, createdFlight);
    flight = createdFlight;
  }
  if (flight.releaseTimer != null) {
    window.clearTimeout(flight.releaseTimer);
    flight.releaseTimer = null;
  }
  flight.consumers += 1;
  let released = false;
  return {
    promise: flight.promise,
    release: () => {
      if (released) return;
      released = true;
      flight.consumers = Math.max(0, flight.consumers - 1);
      if (flight.consumers > 0) return;
      flight.releaseTimer = window.setTimeout(() => {
        if (flight.consumers > 0) return;
        if (hydrateFlights.get(key) !== flight) return;
        if (
          flight.settled &&
          flight.settledAt != null &&
          useCanvasStore.getState().userEditsSinceHydrate === 0
        ) {
          const remaining =
            FREEZONE_HYDRATE_SETTLED_REUSE_MS - (Date.now() - flight.settledAt);
          if (remaining > 0) {
            flight.releaseTimer = window.setTimeout(() => {
              if (flight.consumers === 0 && hydrateFlights.get(key) === flight) {
                hydrateFlights.delete(key);
              }
            }, remaining);
            return;
          }
        }
        if (!flight.settled) {
          flight.controller.abort();
        }
        hydrateFlights.delete(key);
      }, FREEZONE_HYDRATE_RELEASE_GRACE_MS);
    },
  };
}

export function shouldAbortBestEffortPresetRefresh(
  bestEffort: boolean | undefined,
  flushed: boolean,
): boolean {
  return Boolean(bestEffort) && !flushed;
}

export function shouldFlushBeforePresetRefresh(
  bestEffort: boolean | undefined,
  userEditsSinceHydrate: number,
): boolean {
  return !bestEffort || userEditsSinceHydrate > 0;
}

export function shouldDeferPresetRefreshUntilReady(
  bestEffort: boolean | undefined,
  revision: number | null,
  hydratedCanvasId: string | null,
  canvasId: string,
): boolean {
  return Boolean(bestEffort) && (revision == null || hydratedCanvasId !== canvasId);
}

export function saveErrorStatusAndBody(err: unknown): {
  status: number | null;
  body: Parameters<typeof classifySaveError>[1] | undefined;
} {
  if (err instanceof ApiError) {
    return {
      status: err.status,
      body: err.body as Parameters<typeof classifySaveError>[1] | undefined,
    };
  }
  if (typeof err !== "object" || err === null) return { status: null, body: undefined };
  const status = (err as { status?: unknown }).status;
  const body = (err as { body?: unknown }).body;
  return {
    status: typeof status === "number" ? status : null,
    body: body as Parameters<typeof classifySaveError>[1] | undefined,
  };
}

function statusFromError(err: unknown): number | null {
  return saveErrorStatusAndBody(err).status;
}

/**
 * A stable string fingerprint of the *persisted* canvas shape — the business
 * data the backend stores (`nodes` / `edges`). It deliberately omits the
 * ephemeral fields ReactFlow stamps onto nodes for the current view:
 *
 *   - `selected`  — selecting / deselecting a node
 *   - `dragging`  — mid-drag transient flag
 *   - `measured`  — auto-measured render size, updated on every layout pass
 *
 * Save only when this fingerprint changes. Pure view-state changes (zoom, pan,
 * viewport resize, selection, hover, focus, tool dialogs, image preview) never
 * touch it, so they no longer trigger a full PUT.
 */
/**
 * Per-node / per-edge fingerprint cache. Store updates are immutable: one selection or drag only replaces the affected
 * node objects while the other node objects keep their references. Caching slices by object identity drops the signature
 * cost from "stringify the whole graph on every change" to "stringify only the nodes that really changed" - with dozens of
 * image/video nodes on the canvas this was the main source of the frozen frame on page switch.
 */
const nodeSignatureCache = new WeakMap<object, string>();
const edgeSignatureCache = new WeakMap<object, string>();

function nodeSignature(node: CanvasNode): string {
  const cached = nodeSignatureCache.get(node);
  if (cached !== undefined) return cached;
  const signature = JSON.stringify({
    id: node.id,
    type: node.type,
    position: node.position,
    width: node.width,
    height: node.height,
    style: node.style,
    parentId: node.parentId,
    extent: node.extent,
    data: node.data,
  });
  nodeSignatureCache.set(node, signature);
  return signature;
}

function edgeSignature(edge: CanvasEdge): string {
  const cached = edgeSignatureCache.get(edge);
  if (cached !== undefined) return cached;
  const signature = JSON.stringify({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle,
    targetHandle: edge.targetHandle,
    type: edge.type,
    data: edge.data,
  });
  edgeSignatureCache.set(edge, signature);
  return signature;
}

function canvasContentSignature(
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): string {
  return `${nodes.map(nodeSignature).join("")}${edges
    .map(edgeSignature)
    .join("")}`;
}

type HydrateDraftDecision =
  | { kind: "remote" }
  | { kind: "draft"; draft: StoredCanvasDraft }
  | { kind: "conflict"; draft: StoredCanvasDraft; message: string };

function jsonContainsSubset(
  superset: unknown,
  subset: unknown,
): boolean {
  if (subset === undefined) return true;
  if (subset === null || typeof subset !== "object") {
    return Object.is(superset, subset);
  }
  if (Array.isArray(subset)) {
    if (!Array.isArray(superset) || superset.length < subset.length) {
      return false;
    }
    return subset.every((item, index) => jsonContainsSubset(superset[index], item));
  }
  if (!superset || typeof superset !== "object" || Array.isArray(superset)) {
    return false;
  }
  const supersetRecord = superset as Record<string, unknown>;
  const subsetRecord = subset as Record<string, unknown>;
  return Object.keys(subsetRecord).every((key) =>
    jsonContainsSubset(supersetRecord[key], subsetRecord[key]),
  );
}

function decideHydrateDraft(
  draft: StoredCanvasDraft | null,
  remoteRevision: number | null,
  remoteSignature: string,
  remoteNodes: CanvasNode[],
  remoteEdges: CanvasEdge[],
  remoteMetadata: Record<string, unknown> | null,
  t: TFn,
): HydrateDraftDecision {
  if (!draft) return { kind: "remote" };
  if (draft.signature === remoteSignature) {
    return { kind: "remote" };
  }
  const draftContentAlreadySaved =
    canvasContentSignature(draft.nodes, draft.edges) ===
      canvasContentSignature(remoteNodes, remoteEdges) &&
    jsonContainsSubset(remoteMetadata ?? null, draft.metadata ?? null);
  if (draftContentAlreadySaved) {
    return { kind: "remote" };
  }
  if (
    typeof draft.baseRevision === "number" &&
    typeof remoteRevision === "number" &&
    draft.baseRevision === remoteRevision
  ) {
    return { kind: "draft", draft };
  }
  return {
    kind: "conflict",
    draft,
    message: t("freezone.canvasSync.localDraftStale"),
  };
}

/** Narrow an opaque persisted value to a ReactFlow `{x, y, zoom}` viewport. */
function isViewport(value: unknown): value is Viewport {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Partial<Viewport>;
  return (
    typeof v.x === "number" &&
    typeof v.y === "number" &&
    typeof v.zoom === "number"
  );
}

function viewportsEqual(a: Viewport, b: Viewport): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

// Camera position is persisted client-side (localStorage), keyed per
// project+canvas. This makes "refresh restores my position" work without any
// backend change: localStorage writes are synchronous so they survive an
// immediate refresh, unlike a debounced network save. The viewport is still
// included in the canvas PUT too (harmless, forward-compatible) so cross-device
// restore works for free once the backend persists it.
function viewportStorageKey(project: string, canvasId: string): string {
  return `freezone:canvas-viewport:${project}:${canvasId}`;
}

function readStoredViewport(project: string, canvasId: string): Viewport | null {
  try {
    const raw = localStorage.getItem(viewportStorageKey(project, canvasId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return isViewport(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredViewport(
  project: string,
  canvasId: string,
  viewport: Viewport,
): void {
  safeLocalStorageSet(
    viewportStorageKey(project, canvasId),
    JSON.stringify(viewport),
  );
}

// The in-memory undo/redo stacks die on refresh; mirror them to localStorage
// (per canvas) so undo survives a reload. `signature` pins the history to the
// canvas content it belongs to — on hydrate we only restore when the loaded
// content still matches, so we never undo into a state edited elsewhere.
const HISTORY_STORAGE_MAX_BYTES = 1_500_000;
// The persisted mirror only needs to bridge a single refresh, so cap it to the
// most recent N undo/redo steps instead of the full in-memory stack (up to 50
// full-canvas snapshots). This keeps each per-canvas blob small on top of the
// byte budget below.
export const HISTORY_PERSIST_MAX_STEPS = 10;

interface StoredCanvasHistory {
  signature: string;
  past: CanvasHistorySnapshot[];
  future: CanvasHistorySnapshot[];
  // Freshness stamp so `pruneFreezoneCanvasStorage` can TTL-expire orphans
  // (a canvas edited then never reopened). Absent on legacy blobs → pruned.
  updatedAt: number;
}

function historyStorageKey(project: string, canvasId: string): string {
  return `freezone:canvas-history:${project}:${canvasId}`;
}

/** Keep only the most recent N steps of each stack for cross-refresh restore. */
export function trimHistoryForStorage(
  history: CanvasHistoryState,
  maxSteps = HISTORY_PERSIST_MAX_STEPS,
): { past: CanvasHistorySnapshot[]; future: CanvasHistorySnapshot[] } {
  return {
    past: history.past.slice(-maxSteps),
    future: history.future.slice(0, maxSteps),
  };
}

function readStoredHistory(
  project: string,
  canvasId: string,
): StoredCanvasHistory | null {
  try {
    const raw = localStorage.getItem(historyStorageKey(project, canvasId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const value = parsed as Partial<StoredCanvasHistory>;
    if (
      typeof value.signature !== "string" ||
      !Array.isArray(value.past) ||
      !Array.isArray(value.future)
    ) {
      return null;
    }
    return {
      signature: value.signature,
      past: value.past,
      future: value.future,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

function writeStoredHistory(
  project: string,
  canvasId: string,
  signature: string,
  history: CanvasHistoryState,
  now = Date.now(),
): void {
  try {
    const key = historyStorageKey(project, canvasId);
    const trimmed = trimHistoryForStorage(history);
    let past = trimmed.past;
    const future = trimmed.future;
    const serialize = () => JSON.stringify({ signature, past, future, updatedAt: now });
    let serialized = serialize();
    // Each step is a full canvas snapshot; after the step cap, still drop the
    // oldest undo steps until the blob fits the per-canvas byte budget rather
    // than blowing the storage quota.
    while (serialized.length > HISTORY_STORAGE_MAX_BYTES && past.length > 0) {
      past = past.slice(1);
      serialized = serialize();
    }
    if (serialized.length > HISTORY_STORAGE_MAX_BYTES) {
      localStorage.removeItem(key);
      return;
    }
    safeLocalStorageSet(key, serialized);
  } catch {
    // Quota / unavailable storage — cross-refresh undo is best-effort.
  }
}

// The mirror exists only to bridge a refresh; drop it once consumed/stale so
// per-canvas history can't accumulate. See the hydrate path for the read-once
// clear and the write effect for the edit-gated re-persist.
function clearStoredHistory(project: string, canvasId: string): void {
  try {
    localStorage.removeItem(historyStorageKey(project, canvasId));
  } catch {
    // Best-effort cleanup.
  }
}

// "conflict" is from the revision-aware save path (HEAD); kept across merge.
export type CanvasSyncStatus = "loading" | "ready" | "saving" | "error" | "conflict";

/**
 * Shape of the locally-stashed payload written to `localStorage` on a 409.
 * Lets the user grab a JSON dump of their unsaved work even after the
 * overlay forces a refresh.
 */
export interface ConflictSnapshot {
  canvas_id: string;
  nodes: unknown[];
  edges: unknown[];
  viewport: unknown;
  metadata: Record<string, unknown> | null;
  timestamp: string;
}

function conflictStorageKey(canvasId: string): string {
  return `freezone:conflict:${canvasId}`;
}

function readConflictSnapshot(canvasId: string): ConflictSnapshot | null {
  try {
    const raw = localStorage.getItem(conflictStorageKey(canvasId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ConflictSnapshot> | null;
    if (
      !parsed ||
      typeof parsed.canvas_id !== "string" ||
      !Array.isArray(parsed.nodes) ||
      !Array.isArray(parsed.edges)
    ) {
      return null;
    }
    return {
      canvas_id: parsed.canvas_id,
      nodes: parsed.nodes,
      edges: parsed.edges,
      viewport: parsed.viewport ?? null,
      metadata: (parsed.metadata as Record<string, unknown> | null) ?? null,
      timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : "",
    };
  } catch {
    return null;
  }
}

function writeConflictSnapshot(snapshot: ConflictSnapshot): void {
  safeLocalStorageSet(
    conflictStorageKey(snapshot.canvas_id),
    JSON.stringify(snapshot),
  );
}

function clearConflictSnapshot(canvasId: string): void {
  try {
    localStorage.removeItem(conflictStorageKey(canvasId));
  } catch {
    // Best-effort cleanup.
  }
}

export function buildConflictCopyCanvasId(
  sourceCanvasId: string,
  now = Date.now(),
  random = Math.random().toString(36).slice(2, 8),
): string {
  const safeSource = sourceCanvasId
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 32) || "canvas";
  const safeRandom = random.replace(/[^a-z0-9]+/g, "").slice(0, 8) || "copy";
  return `copy_${now}_${safeRandom}_${safeSource}`.slice(0, 64).replace(/_+$/g, "");
}

export function buildConflictCopyMetadata({
  sourceCanvasId,
  metadata,
}: {
  sourceCanvasId: string;
  metadata: Record<string, unknown> | null | undefined;
}): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    canvas_origin: "conflict_copy",
    source_canvas_id: sourceCanvasId,
  };
}

interface CanvasSyncResult {
  status: CanvasSyncStatus;
  error: string | null;
  metadata: Record<string, unknown> | null;
  revision: number | null;
  hydratedCanvasId: string | null;
  /** Project id updated together with `hydratedCanvasId`; same-named canvases across projects can only be told apart by it. */
  hydratedProject: string | null;
  /**
   * Reported by the backend on the last save. `null` means we have not
   * observed any backup info yet (fresh mount). `synced` / `disabled` are
   * silent in the UI; `pending` / `failed` light up the indicator.
   */
  backupStatus: CanvasBackupStatus | null;
  /** Force a save now (e.g. before navigating away). Returns false if saving was blocked. */
  flush: () => Promise<boolean>;
  /** Re-run the initial hydrate after a load error, without a full reload. */
  retry: () => void;
  /** Save current local edits to a new canvas id after a revision conflict. */
  saveCopy: () => Promise<string>;
  /** Rebuild the current mainline preset canvas from the latest project facts. */
  restoreMainlineDefault: (options?: { bestEffort?: boolean }) => Promise<string>;
  /**
   * Read the conflict snapshot stashed by the 409 path. Returns `null` if no
   * snapshot exists for the current canvas. Used by the overlay's "Download local
   * JSON" button.
   */
  readConflictSnapshot: () => ConflictSnapshot | null;
  /** Drop the conflict snapshot once the user has recovered / discarded it. */
  clearConflictSnapshot: () => void;
}

/**
 * Bind a SuperTale freezone canvas (project, canvasId) to the local
 * `useCanvasStore`. On mount the canvas is fetched and pushed into the
 * store; subsequent edits are debounced + PUT back. F4's freezoneAiGateway
 * generates new images that flow into the store the same way upstream did.
 */
export function useCanvasSync(
  project: string,
  canvasId: string,
): CanvasSyncResult {
  const { t } = useTranslation();
  const [status, setStatus] = useState<CanvasSyncStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [metadata, setMetadata] = useState<Record<string, unknown> | null>(null);
  const [revision, setRevision] = useState<number | null>(null);
  const [hydratedCanvasId, setHydratedCanvasId] = useState<string | null>(null);
  // Updated in pairs with hydratedCanvasId and always set in the same event, so the two cannot tear.
  // A personal canvas id derives from the username (personalCanvasIdForUsername) and is the same id across projects,
  // so canvasId alone cannot tell "the project changed"; the project must be reported too.
  const [hydratedProject, setHydratedProject] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // Surfaced backup status from the most recent save. The hook always
  // overwrites this on success; on legacy responses without the field, we
  // store `null` (treated as "no signal" by the UI).
  const [backupStatus, setBackupStatus] = useState<CanvasBackupStatus | null>(
    null,
  );
  // Fingerprint of the canvas content we last observed. A store change only
  // schedules a save when the new content fingerprint differs from this, which
  // is how we ignore pure view-state churn. Seeded on hydrate so the initial
  // measure/select pass after load doesn't fire a redundant save.
  const lastSignatureRef = useRef<string | null>(null);
  // All save scheduling for the currently-loaded canvas. Replaced (and the old
  // one disposed) on every hydrate and every remote refresh, so queued work can
  // never survive into a canvas it was not written for. See
  // `canvasSaveCoordinator`.
  const sessionRef = useRef<CanvasSaveSession | null>(null);
  // Incremented alongside every new session. Outgoing requests are stamped with
  // it so a late response can be recognised as belonging to a canvas load we
  // have already moved past.
  const canvasGenerationRef = useRef(0);
  const debounceTimerRef = useRef<number | null>(null);
  const draftTimerRef = useRef<number | null>(null);
  const suppressNextCanvasAutosaveRef = useRef(false);
  const revisionRef = useRef<number | null>(null);
  const lastPersistedDraftSignatureRef = useRef<string | null>(null);
  const statusRef = useRef<CanvasSyncStatus>("loading");
  const metadataRef = useRef<Record<string, unknown> | null>(null);
  const canvasEnvelopeRef = useRef<Partial<FreezoneCanvasPayload>>({});
  // The idempotency token for the currently pending save attempt. We keep it
  // stable across in-flight retries (network blip, 503 canvas_lock_busy) so the
  // backend can dedupe. A new value is minted when fresh local content needs to
  // be sent (next debounce after a successful save / new edits after failure).
  const pendingClientSaveIdRef = useRef<string | null>(null);
  const pendingClientSaveIdSignatureRef = useRef<string | null>(null);
  // True only after the initial GET hydrate has populated the store. Until
  // then, every store mutation we observe is part of the hydrate, not a user
  // edit, and must not produce a PUT.
  const hydratedRef = useRef(false);
  // True between "canvasId / project changed" and "next hydrate completes".
  // Blocks autosave the same way `!hydrated` does, but is set synchronously
  // at the start of the hydrate effect so saves cannot leak through during
  // the cleanup window of the previous canvas.
  const switchingRef = useRef(false);
  // Node count of the last server-known state. Used by `decideSaveAction` to
  // detect the "remote had nodes, local is suddenly empty" pattern that
  // signals a Zustand reset / HMR accident.
  const lastRemoteNodeCountRef = useRef(0);
  // Last viewport we persisted. Pan/zoom alone never triggers a full PUT (that
  // would re-send the entire canvas blob on every gesture), so we track it here
  // and flush it on tab close, which is enough to restore position on refresh.
  const lastSavedViewportRef = useRef<Viewport | null>(null);
  const setCanvasData = useCanvasStore((s) => s.setCanvasData);
  const applyCanvasDataEdit = useCanvasStore((s) => s.applyCanvasDataEdit);
  const hydrateCanvasDraft = useCanvasStore((s) => s.hydrateCanvasDraft);
  const restoreHistory = useCanvasStore((s) => s.restoreHistory);
  const setViewportState = useCanvasStore((s) => s.setViewportState);
  const reactFlow = useReactFlow();

  const setSyncStatus = (next: CanvasSyncStatus) => {
    statusRef.current = next;
    setStatus(next);
  };

  const writeDraftNow = () => {
    if (!hydratedRef.current || switchingRef.current) {
      return false;
    }
    const canvasState = useCanvasStore.getState();
    const shot = useShotMetadataStore.getState().shot;
    return writeCanvasDraft(project, canvasId, {
      baseRevision: revisionRef.current,
      nodes: canvasState.nodes,
      edges: canvasState.edges,
      viewport: canvasState.currentViewport,
      metadata: buildPersistMetadata(shot),
      history: canvasState.history,
      mutation: {
        userEditsSinceHydrate: canvasState.userEditsSinceHydrate,
        lastMutationSource: canvasState.lastMutationSource,
        pendingClearIntent: canvasState.pendingClearIntent,
      },
      updatedAt: Date.now(),
    });
  };
  // Single source of truth for the persisted metadata blob so every save site
  // (draft write, debounced PUT, flush, beforeunload) carries shotMetadata AND
  // viewportBookmarks. Omitting bookmarks at any PUT site would overwrite the
  // backend copy with nothing — hence: route ALL save sites through here.
  const buildPersistMetadata = (shot: ShotMetadata) => ({
    ...(metadataRef.current ?? {}),
    shotMetadata: shot,
    viewportBookmarks: useCanvasStore.getState().viewportBookmarks,
  });
  const currentDraftSignature = () => {
    const canvasState = useCanvasStore.getState();
    const shot = useShotMetadataStore.getState().shot;
    return canvasDraftSignature(
      canvasState.nodes,
      canvasState.edges,
      buildPersistMetadata(shot),
    );
  };
  const scheduleDraftWrite = () => {
    if (draftTimerRef.current != null) {
      window.clearTimeout(draftTimerRef.current);
    }
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      writeDraftNow();
    }, DRAFT_DEBOUNCE_MS);
  };
  const clearDraftTimerAndDraft = () => {
    if (draftTimerRef.current != null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
    clearCanvasDraft(project, canvasId);
  };

  // Stash local edits to localStorage so the user can grab them via the
  // conflict overlay's "Download local JSON" button even after they refresh.
  const snapshotConflict = (args: SaveArgs) => {
    writeConflictSnapshot({
      canvas_id: args.canvasId,
      nodes: args.nodes,
      edges: args.edges,
      viewport: args.viewport ?? null,
      metadata: args.metadata ?? null,
      timestamp: new Date().toISOString(),
    });
  };
  // Publish the backend's `backup_status` to React state so FreezoneShell
  // can render the pending / failed indicator.
  const publishBackupStatus = (next: CanvasBackupStatus | null) => {
    setBackupStatus(next);
  };

  // One place that describes a save. The session pump calls it immediately
  // before the request goes out, which is what makes a coalesced save carry the
  // newest content instead of the snapshot whichever caller scheduled it held.
  const buildSaveArgs = (
    session: CanvasSaveSession,
    version: number,
  ): SaveArgs => {
    const canvasState = useCanvasStore.getState();
    const shot = useShotMetadataStore.getState().shot;
    const metadata = buildPersistMetadata(shot);
    // What this request actually carries. Compared against the live store when
    // the response comes back, to decide whether the draft is now redundant.
    const sentSignature = canvasDraftSignature(
      canvasState.nodes,
      canvasState.edges,
      metadata,
    );
    return {
      project,
      t,
      canvasId,
      nodes: canvasState.nodes,
      edges: canvasState.edges,
      viewport: canvasState.currentViewport,
      metadata,
      revisionRef,
      statusRef,
      canvasGenerationRef,
      canvasEnvelopeRef,
      pendingClientSaveIdRef,
      pendingClientSaveIdSignatureRef,
      hydratedRef,
      switchingRef,
      lastRemoteNodeCountRef,
      setStatus: setSyncStatus,
      setError,
      snapshotConflict,
      publishBackupStatus,
      publishRevision: setRevision,
      clearDraftAfterSave: () => {
        // This save landing does not make the draft redundant. The user may
        // have kept editing while it was on the wire, and that newer content
        // exists nowhere but localStorage until the queued save lands too.
        if (session.hasUnsavedContentBeyond(version)) return;
        // The autosave debounce is a second blind spot the session can't see:
        // an edit made in the last DEBOUNCE_MS has already been written to the
        // draft, but has not called `requestSave` yet, so no version exists for
        // it. Compare what we sent against what the store holds now — if they
        // differ, the draft is still the only copy of the difference.
        if (sentSignature !== currentDraftSignature()) return;
        clearDraftTimerAndDraft();
      },
      markDraftPersisted: (signature) => {
        lastPersistedDraftSignatureRef.current = signature;
      },
    };
  };

  // Retire the session for the canvas we are leaving and open one for the
  // canvas we are entering. Bumping the generation in lock-step is what lets a
  // response arriving after this point be recognised as stale.
  const startSaveSession = (): CanvasSaveSession => {
    sessionRef.current?.dispose();
    canvasGenerationRef.current += 1;
    const session = createCanvasSaveSession({
      canvasKey: `${project}:${canvasId}`,
      generation: canvasGenerationRef.current,
      runSave: (version, self) => scheduleSave(buildSaveArgs(self, version)),
    });
    sessionRef.current = session;
    return session;
  };

  const requestSave = (): Promise<boolean> =>
    sessionRef.current?.requestSave() ?? Promise.resolve(false);

  // ---- 0a. Retire the last session on unmount ---- //
  // `startSaveSession` only ever disposes its *predecessor*, so without this the
  // final session outlives the hook: its queued follow-up would still fire, and
  // (because it reads the live stores at send time) would PUT the *next*
  // canvas's nodes to the unmounted canvas's id. Bumping the generation matters
  // just as much as disposing — a request already on the wire must also be
  // barred from writing back into revision/status/draft state that now belongs
  // to whoever mounted next.
  useEffect(() => {
    return () => {
      canvasGenerationRef.current += 1;
      const session = sessionRef.current;
      sessionRef.current = null;
      session?.dispose();
    };
    // Mount-scoped on purpose: canvas switches are handled by startSaveSession.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- 0. External-trigger remote canvas refresh ---- //
  // canvasSyncRuntime lets other features (beat-context preset refresh,
  // mainline rebuild) hand us a fresh server payload to apply in place.
  // We mirror the hydrate path: stop any pending debounce, re-anchor the
  // signature/revision/envelope so the next local edit doesn't immediately
  // re-PUT with stale baseline, then push the new content into the store.
  useEffect(() => {
    const saveProjectionEditNow = () => {
      window.setTimeout(() => {
        if (!hydratedRef.current || switchingRef.current) return;
        writeDraftNow();
        if (statusRef.current === "conflict" || statusRef.current === "error") {
          return;
        }
        lastSavedViewportRef.current =
          useCanvasStore.getState().currentViewport;
        void requestSave();
      }, 0);
    };

    return registerFreezoneCanvasRuntime(project, canvasId, (remote, merge) => {
      if (debounceTimerRef.current != null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      // Treat this as a brief "switching" window — the same guard the hydrate
      // path uses to suppress in-flight save callbacks from clobbering the
      // freshly-applied remote content.
      switchingRef.current = true;
      // Fence off every save dispatched before this refresh. We are about to
      // overwrite revisionRef with the remote revision; a PUT already on the
      // wire would otherwise come back with an older revision and roll it
      // backwards, and the next save would 409 against it. A save still queued
      // Queued work is stale for the same reason — the merged content is
      // rescheduled explicitly below when there is local work worth keeping.
      startSaveSession();
      const local = useCanvasStore.getState();
      const remoteNodes = (remote.nodes ?? []) as CanvasNode[];
      const remoteEdges = (remote.edges ?? []) as CanvasEdge[];
      const next = merge
        ? merge(remoteNodes, remoteEdges, local.nodes, local.edges)
        : { nodes: remoteNodes, edges: remoteEdges };
      const remoteSignature = canvasContentSignature(remoteNodes, remoteEdges);
      const nextSignature = canvasContentSignature(next.nodes, next.edges);
      const mergedLocalWork = Boolean(merge) && nextSignature !== remoteSignature;
      const remoteRevision =
        typeof remote.revision === "number" ? remote.revision : null;
      revisionRef.current = remoteRevision;
      setRevision(remoteRevision);
      canvasEnvelopeRef.current = canvasEnvelopeFromRemote(remote);
      // Read-time diagnostics: out-of-project history references reported by the backend are handed to the node mask for display + one-click repair.
      // Replace the whole table: the previous canvas's diagnostics must never carry over (a clean canvas has no such field = clear all).
      publishForeignMediaRefs(project, canvasId, remote.foreign_media ?? []);
      lastSignatureRef.current = nextSignature;
      lastRemoteNodeCountRef.current = remoteNodes.length;
      pendingClientSaveIdRef.current = null;
      pendingClientSaveIdSignatureRef.current = null;
      clearCanvasDraft(project, canvasId);
      const meta = (remote.metadata ?? null) as
        | (Record<string, unknown> & { shotMetadata?: ShotMetadata })
        | null;
      metadataRef.current = meta;
      setMetadata(meta);
      setFreezoneCanvasMetadata(meta);
      useCanvasStore.getState().hydrateViewportBookmarks(meta?.viewportBookmarks);
      useShotMetadataStore
        .getState()
        .hydrate(meta?.shotMetadata ?? EMPTY_SHOT_METADATA);
      setCanvasData(next.nodes, next.edges);
      setSyncStatus("ready");
      setError(null);
      hydratedRef.current = true;
      switchingRef.current = false;
      setHydratedCanvasId(canvasId);
      setHydratedProject(project);
      if (mergedLocalWork) {
        window.setTimeout(() => {
          if (!hydratedRef.current || switchingRef.current) return;
          lastSavedViewportRef.current =
            useCanvasStore.getState().currentViewport;
          void requestSave();
        }, 0);
      }
    }, flush, (projection) => {
      if (!hydratedRef.current || switchingRef.current) {
        return false;
      }
      const local = useCanvasStore.getState();
      const next = mergeProjectedCanvasWithLocalCanvas(
        projection.nodes,
        projection.edges,
        local.nodes,
        local.edges,
        projection.projectionKey,
      );
      metadataRef.current = mergeProjectionMetadata(
        metadataRef.current,
        projection.metadata,
        projection.projectionKey,
      );
      setMetadata(metadataRef.current);
      setFreezoneCanvasMetadata(metadataRef.current);
      suppressNextCanvasAutosaveRef.current = true;
      applyCanvasDataEdit(next.nodes, next.edges);
      saveProjectionEditNow();
      return true;
    }, (projectionKey) => {
      if (!hydratedRef.current || switchingRef.current) {
        return false;
      }
      const local = useCanvasStore.getState();
      const next = removeProjectionFromLocalCanvas(
        local.nodes,
        local.edges,
        projectionKey,
      );
      metadataRef.current = removeProjectionMetadata(metadataRef.current, projectionKey);
      setMetadata(metadataRef.current);
      setFreezoneCanvasMetadata(metadataRef.current);
      suppressNextCanvasAutosaveRef.current = true;
      applyCanvasDataEdit(next.nodes, next.edges);
      saveProjectionEditNow();
      return true;
    });
  }, [applyCanvasDataEdit, project, canvasId, setCanvasData]);

  // ---- 1. Hydrate ---- //
  useEffect(() => {
    let cancelled = false;
    // Cleaning old drafts has to traverse and parse the whole localStorage (drafts are often several MB); on the mount critical
    // path it would stall the page-switch frame, so do it when idle - it has no ordering dependency on this hydrate. Runs once per
    // page and is not cancelled on unmount - otherwise the common path "leave the canvas within two seconds" would never clean up.
    schedulePruneOnce();
    const hydrateFlight = acquireHydrateFlight(project, canvasId, reloadKey);
    setSyncStatus("loading");
    setError(null);
    lastSignatureRef.current = null;
    revisionRef.current = null;
    metadataRef.current = null;
    setRevision(null);
    setHydratedCanvasId(null);
    setHydratedProject(null);
    canvasEnvelopeRef.current = {};
    lastPersistedDraftSignatureRef.current = null;
    hydratedRef.current = false;
    switchingRef.current = true;
    const hydrateKey = storeKeyOf(project, canvasId);
    const hydrateToken = claimHydrate(hydrateKey);
    // Everything queued for the previous canvas is dropped here: the new
    // session owns save scheduling from now on, and the old one can no longer
    // write to anything this canvas reads.
    startSaveSession();
    // On a canvas switch, unmount the old content first instead of waiting for hydrate to return.
    //
    // FreezoneShell has no key, so switching canvases reruns the effect on the same component; if we do not clear here,
    // the old canvas's hundreds of nodes stay mounted until setCanvasData swaps in the new content - React merges
    // "unmount N old" and "mount M new" into one synchronous commit, measured at ~1.4s freeze for 350 nodes. Clearing early
    // splits it into two: this commit only unmounts (the screen then shows FreezoneShell's full-screen loading), and the
    // new content is mounted separately once the request returns.
    //
    // Only clear when the canvas really changed: re-entering the same canvas (top-bar Canvas/Market toggle) means the store already
    // holds the wanted content and clearing only flashes. Disk writes and autosave are all blocked by switchingRef (see the switching
    // branch of decideSaveAction), so the empty store cannot leak out as an overwriting save.
    if (
      storeCanvasKey !== storeKeyOf(project, canvasId) &&
      useCanvasStore.getState().nodes.length > 0
    ) {
      storeCanvasKey = null;
      setCanvasData([], []);
    }
    lastRemoteNodeCountRef.current = 0;
    pendingClientSaveIdRef.current = null;
    pendingClientSaveIdSignatureRef.current = null;
    setBackupStatus(null);

    (async () => {
      try {
        const remote = await hydrateFlight.promise;
        if (cancelled) return;
        const remoteRevision =
          typeof remote.revision === "number" ? remote.revision : null;
        revisionRef.current = remoteRevision;
        setRevision(remoteRevision);
        canvasEnvelopeRef.current = canvasEnvelopeFromRemote(remote);
        // Read-time diagnostics: out-of-project history references reported by the backend are handed to the node mask for display + one-click repair.
        // Replace the whole table: the previous canvas's diagnostics must never carry over (a clean canvas has no such field = clear all).
        publishForeignMediaRefs(project, canvasId, remote.foreign_media ?? []);
        const nodes = (remote.nodes ?? []) as Parameters<typeof setCanvasData>[0];
        const edges = (remote.edges ?? []) as Parameters<typeof setCanvasData>[1];
        const meta = (remote.metadata ?? null) as
          | (Record<string, unknown> & { shotMetadata?: ShotMetadata })
          | null;
        const remoteSignature = canvasDraftSignature(nodes, edges, meta);
        lastPersistedDraftSignatureRef.current = remoteSignature;
        const draft = readCanvasDraft(project, canvasId);
        const draftDecision = decideHydrateDraft(
          draft,
          remoteRevision,
          remoteSignature,
          nodes,
          edges,
          meta,
          t,
        );
        lastRemoteNodeCountRef.current = nodes.length;
        if (draftDecision.kind === "draft") {
          const draftMeta = draftDecision.draft.metadata as
            | (Record<string, unknown> & { shotMetadata?: ShotMetadata })
            | null;
          metadataRef.current = draftMeta;
          setMetadata(draftMeta);
          setFreezoneCanvasMetadata(draftMeta);
          useShotMetadataStore
            .getState()
            .hydrate(draftMeta?.shotMetadata ?? EMPTY_SHOT_METADATA);
          // Seed from the remote state so the atomic draft hydrate is observed
          // as dirty local content and flows through the normal debounced save.
          lastSignatureRef.current = canvasContentSignature(nodes, edges);
          hydratedRef.current = true;
          switchingRef.current = false;
          // Same as the remote branch: place the camera first (the store is empty now, cost near zero), then mount the nodes
          // once at the final zoom tier, shell first, and fill in batches.
          const draftViewport = isViewport(draftDecision.draft.viewport)
            ? draftDecision.draft.viewport
            : readStoredViewport(project, canvasId) ??
              (isViewport(remote.viewport) ? remote.viewport : null);
          const draftHydrateViewport = draftViewport ?? DEFAULT_HYDRATE_VIEWPORT;
          lastSavedViewportRef.current = draftHydrateViewport;
          setViewportState(draftHydrateViewport);
          reactFlow.setViewport(draftHydrateViewport, { duration: 0 });
          notifyCanvasHydrateViewport(draftHydrateViewport.zoom);
          beginCanvasHydrateBurst();
          hydrateCanvasDraft({
            nodes: draftDecision.draft.nodes,
            edges: draftDecision.draft.edges,
            history: draftDecision.draft.history,
            mutation: draftDecision.draft.mutation,
          });
          storeCanvasKey = storeKeyOf(project, canvasId);
          useCanvasStore
            .getState()
            .hydrateViewportBookmarks(draftMeta?.viewportBookmarks);
          // The draft carries its own undo history (hydrateCanvasDraft above),
          // so the separate mirror is redundant here — drop it read-once like
          // the remote branch. The edit-gated write effect re-creates it.
          clearStoredHistory(project, canvasId);
          setHydratedCanvasId(canvasId);
          setHydratedProject(project);
          setSyncStatus("ready");
          return;
        }

        if (draftDecision.kind === "conflict") {
          writeConflictSnapshot({
            canvas_id: canvasId,
            nodes: draftDecision.draft.nodes,
            edges: draftDecision.draft.edges,
            viewport: draftDecision.draft.viewport ?? null,
            metadata: draftDecision.draft.metadata ?? null,
            timestamp: new Date(draftDecision.draft.updatedAt).toISOString(),
          });
        } else if (draft) {
          clearCanvasDraft(project, canvasId);
        }

        // Restore the saved camera position so a refresh lands where the user
        // left off. Prefer the client-side localStorage copy: it's updated on
        // every pan/zoom (debounced + a synchronous beforeunload write), so it
        // always reflects the *last* position. The backend `viewport` only
        // rides along with content (nodes/edges) PUTs, so after a pure pan/zoom
        // it's stale — using it first would yank the camera back to wherever it
        // was during the last content edit. Fall back to the backend value only
        // when there's no local copy (fresh browser / cross-device).
        //
        // The camera must be placed before the nodes. This used to push the viewport to ReactFlow in an rAF after setCanvasData,
        // so the new canvas's nodes were mounted "under the previous canvas's camera": viewport culling was computed wrongly for one
        // batch, then the camera jumped to the right place a frame later and had to recompute; when zoom crossed
        // LOW_DETAIL_ZOOM_THRESHOLD even the onlyRenderVisibleElements switch flipped, so one switch mounted two or three waves.
        // The store has just been cleared above, so setting the viewport reflows no nodes and the cost is near zero; by the time
        // nodes mount below, both the zoom tier and the culling window are final, so they mount only once.
        const savedViewport =
          readStoredViewport(project, canvasId) ??
          (isViewport(remote.viewport) ? remote.viewport : null);
        // Even with no stored camera we must place it explicitly: a new canvas explicitly stores viewport: null, and old data
        // may lack it too. Canvas now stays resident across projects and no longer gets a fresh ReactFlow instance by remounting;
        // without a reset it would keep using the previous canvas's coordinates and zoom - the nodes may land entirely off
        // screen, and the lowDetail tier would also be the previous canvas's.
        const hydrateViewport = savedViewport ?? DEFAULT_HYDRATE_VIEWPORT;
        lastSavedViewportRef.current = hydrateViewport;
        setViewportState(hydrateViewport);
        reactFlow.setViewport(hydrateViewport, { duration: 0 });
        // The culling switch must move together with the camera, else the nodes mount a whole wave at the previous canvas's zoom tier.
        notifyCanvasHydrateViewport(hydrateViewport.zoom);
        // The nodes mounted this time come out as shells first, then the upgrade queue completes them 3 per frame.
        beginCanvasHydrateBurst();
        setCanvasData(nodes, edges);
        storeCanvasKey = storeKeyOf(project, canvasId);
        // Seed the fingerprint from the normalized store state so the first
        // post-hydrate emission (measure/select) is recognized as a no-op.
        const hydrated = useCanvasStore.getState();
        lastSignatureRef.current = canvasContentSignature(
          hydrated.nodes,
          hydrated.edges,
        );
        // Restore the cross-refresh undo/redo stacks, but only when the loaded
        // canvas still matches the content the history was captured against —
        // otherwise (edited on another device, backend newer) we'd let the user
        // undo into a state that never existed here.
        //
        // Do this when idle: readStoredHistory is a synchronous JSON.parse (drafts are often several MB), and
        // restoreHistory runs normalizeCanvasData over up to 100 snapshots (hundreds of nodes each, one createDefaultData per
        // node). This whole block has no ordering dependency on "drawing the canvas" - the user cannot have pressed undo at the
        // moment the canvas first appears - so keeping it on the critical path only lengthens the switching frame.
        const hydratedSignature = lastSignatureRef.current;
        scheduleIdle(() => {
          // Read-once: the mirror only exists to bridge this refresh. Drop it
          // whether or not it was usable so undo stacks don't accumulate per
          // canvas. The write effect re-persists it once the user edits again.
          // This canvas has already been taken over by a later hydrate (switched away and back); the mirror on disk belongs
          // to that one and must not be touched regardless of whether this run was cancelled.
          if (!ownsHydrate(hydrateKey, hydrateToken)) return;
          if (cancelled) {
            clearStoredHistory(project, canvasId);
            return;
          }
          const storedHistory = readStoredHistory(project, canvasId);
          // Running when idle means a real edit may already have happened; that edit's snapshot is already in
          // history, and replacing wholesale now would swallow it, so only restore when nothing has been edited.
          if (
            storedHistory &&
            storedHistory.signature === hydratedSignature &&
            useCanvasStore.getState().userEditsSinceHydrate === 0
          ) {
            restoreHistory({ past: storedHistory.past, future: storedHistory.future });
          }
          // The idle run may be later than the edit-gated mirror write (that effect debounces 400ms, and after
          // hydrate the main thread is busy upgrading 3 shells per frame). Then the mirror on disk is what the user's edit just
          // wrote, not the one we meant to read and discard, and clearing it would delete their cross-refresh
          // undo stack.
          if (useCanvasStore.getState().userEditsSinceHydrate === 0) {
            clearStoredHistory(project, canvasId);
          }
        });
        // Hydrate freezone-specific sidecar metadata.
        metadataRef.current = meta;
        setMetadata(meta);
        setFreezoneCanvasMetadata(meta);
        useCanvasStore.getState().hydrateViewportBookmarks(meta?.viewportBookmarks);
        const hydrate = useShotMetadataStore.getState().hydrate;
        hydrate(meta?.shotMetadata ?? EMPTY_SHOT_METADATA);
        // Order matters: only flip `hydrated → true` after the store is fully
        // seeded, then drop the `switching` gate. Inverting these would let
        // the first signature-change subscription fire while the dangerous-
        // empty guard still thought we were mid-switch.
        hydratedRef.current = true;
        switchingRef.current = false;
        setHydratedCanvasId(canvasId);
        setHydratedProject(project);
        if (draftDecision.kind === "conflict") {
          setError(draftDecision.message);
          setSyncStatus("conflict");
        } else {
          setSyncStatus("ready");
          consumeQueuedLocalFreezoneProjections(project, canvasId);
        }
      } catch (err) {
        if (cancelled) return;
        // Stay non-hydrated on failure so an autosave triggered by a stray
        // store mutation in the error overlay does not slip through.
        hydratedRef.current = false;
        switchingRef.current = false;
        setRevision(null);
        setHydratedCanvasId(null);
        setHydratedProject(null);
        setError(err instanceof Error ? err.message : String(err));
        setSyncStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      hydrateFlight.release();
      setFreezoneCanvasMetadata(null);
    };
    // setCanvasData is a stable Zustand setter; project/canvasId (or a manual
    // retry bumping reloadKey) trigger a fresh hydrate.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, canvasId, reloadKey]);

  // ---- 1b. Mirror the undo/redo history to localStorage ---- //
  // The in-memory history stacks vanish on refresh; mirror them (per canvas)
  // on a short debounce plus a synchronous beforeunload write, the same as the
  // viewport. The hydrate effect above restores them when the loaded content
  // still matches. Only `history` changes are mirrored; writes are gated to
  // post-hydrate so a switch/hydrate never persists a half-loaded state, and
  // to `userEditsSinceHydrate > 0` so a pure hydrate-restore (which re-sets the
  // history) does not immediately re-persist the mirror we just cleared — only
  // a real edit since load re-creates it.
  useEffect(() => {
    let timer: number | null = null;
    const writeNow = () => {
      if (!hydratedRef.current || switchingRef.current) {
        return;
      }
      const state = useCanvasStore.getState();
      if (state.userEditsSinceHydrate <= 0) {
        return;
      }
      writeStoredHistory(
        project,
        canvasId,
        canvasContentSignature(state.nodes, state.edges),
        state.history,
      );
    };
    const unsubscribe = useCanvasStore.subscribe((state, prev) => {
      if (state.history === prev.history) {
        return;
      }
      if (timer != null) {
        window.clearTimeout(timer);
      }
      timer = window.setTimeout(writeNow, 400);
    });
    const handleUnload = () => writeNow();
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      unsubscribe();
      window.removeEventListener("beforeunload", handleUnload);
      if (timer != null) {
        window.clearTimeout(timer);
      }
    };
  }, [project, canvasId]);

  // ---- 2. Debounced save on content changes ---- //
  // Save fires when the persisted canvas shape (nodes/edges) or the
  // shotMetadata changes — never on pure view-state churn.
  useEffect(() => {
    // Saves accumulated during a cross-project paste (canvasAutosaveHold): drafts are still written, but the PUT is sent only after the assets
    // are copied into this project and the URLs rewritten, so the source project's URLs never land in the database first.
    let saveDeferredByHold = false;
    const triggerSave = () => {
      if (!hydratedRef.current || switchingRef.current) return;
      scheduleDraftWrite();
      if (statusRef.current === "conflict" || statusRef.current === "error") {
        return;
      }
      if (debounceTimerRef.current != null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      if (isCanvasAutosaveHeld(project)) {
        saveDeferredByHold = true;
        return;
      }
      debounceTimerRef.current = window.setTimeout(() => {
        lastSavedViewportRef.current =
          useCanvasStore.getState().currentViewport;
        void requestSave();
      }, DEBOUNCE_MS);
    };
    const unsubscribeHold = subscribeCanvasAutosaveRelease((released) => {
      if (released !== project || !saveDeferredByHold) return;
      saveDeferredByHold = false;
      triggerSave();
    });
    // Only react to changes that alter the persisted nodes/edges shape. View
    // state (viewport, selection, dialogs, image viewer) lives in the same
    // store but is filtered out by the content-signature comparison.
    const unsubscribeCanvas = useCanvasStore.subscribe((state, prev) => {
      if (state.viewportBookmarks !== prev.viewportBookmarks) {
        triggerSave();
      }
      // The store also holds pure view state such as viewport, selection and dialogs, whose changes cannot touch nodes/edges.
      // If the array references are unchanged, let it through without even computing the signature - this is a hotspot on page switch.
      if (state.nodes === prev.nodes && state.edges === prev.edges) {
        // The suppression flag is always set right after applyCanvasDataEdit (synchronously, nothing else can slip in between),
        // so it must be consumed here: if that programmatic rewrite happens to produce unchanged arrays, the flag would linger
        // to the next change and swallow the user's real edit, both the save and the draft.
        suppressNextCanvasAutosaveRef.current = false;
        return;
      }
      const nextSignature = canvasContentSignature(state.nodes, state.edges);
      if (suppressNextCanvasAutosaveRef.current) {
        suppressNextCanvasAutosaveRef.current = false;
        lastSignatureRef.current = nextSignature;
        return;
      }
      if (nextSignature === lastSignatureRef.current) return;
      lastSignatureRef.current = nextSignature;
      triggerSave();
    });
    // shotMetadataStore holds only persisted business metadata, so any change
    // there is save-worthy.
    const unsubscribeShot = useShotMetadataStore.subscribe(triggerSave);
    return () => {
      unsubscribeHold();
      unsubscribeCanvas();
      unsubscribeShot();
      if (draftTimerRef.current != null) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
        writeDraftNow();
      }
      if (debounceTimerRef.current != null) {
        window.clearTimeout(debounceTimerRef.current);
      }
    };
  }, [project, canvasId]);

  // ---- 2b. Persist the camera position (pan/zoom) to localStorage ---- //
  // Pan/zoom never triggers the content PUT above, so we mirror the live
  // viewport into localStorage (cheap, synchronous) on a short debounce. This
  // is the source of truth that survives a refresh, no backend required.
  useEffect(() => {
    if (status !== "ready") return;
    let timer: number | null = null;
    const unsubscribe = useCanvasStore.subscribe((state) => {
      const viewport = state.currentViewport;
      if (
        lastSavedViewportRef.current != null &&
        viewportsEqual(lastSavedViewportRef.current, viewport)
      ) {
        return;
      }
      if (timer != null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        lastSavedViewportRef.current = viewport;
        writeStoredViewport(project, canvasId, viewport);
      }, 300);
    });
    return () => {
      unsubscribe();
      if (timer != null) window.clearTimeout(timer);
    };
  }, [project, canvasId, status]);

  const flush = async (): Promise<boolean> => {
    if (debounceTimerRef.current != null) {
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
    }
    lastSavedViewportRef.current = useCanvasStore.getState().currentViewport;
    return await requestSave();
  };

  // Save once more on tab close — best effort, fire-and-forget. Fires when a
  // debounced content edit is still pending, OR when only the viewport moved
  // since the last save (pan/zoom doesn't trigger an in-session PUT, so this is
  // what makes a refresh land back at the last camera position).
  // `sendBeacon` can't be used here: it only issues POST, but the canvas
  // endpoint is PUT. A `keepalive` fetch lets the request outlive the page and
  // keeps the correct method + cookie auth.
  useEffect(() => {
    const handler = () => {
      const currentViewport = useCanvasStore.getState().currentViewport;
      // Final, synchronous guarantee for the refresh case: a pending debounced
      // localStorage write may not have fired yet, so persist the latest
      // position now (localStorage.setItem completes before the page unloads).
      writeStoredViewport(project, canvasId, currentViewport);
      lastSavedViewportRef.current = currentViewport;
      const hasUnsettledContentSave =
        draftTimerRef.current != null ||
        debounceTimerRef.current != null ||
        sessionRef.current?.isSaving() === true ||
        statusRef.current === "saving";
      if (
        !hasUnsettledContentSave ||
        currentDraftSignature() === lastPersistedDraftSignatureRef.current
      ) {
        return;
      }
      if (draftTimerRef.current != null) {
        window.clearTimeout(draftTimerRef.current);
        draftTimerRef.current = null;
      }
      writeDraftNow();
      // The network PUT below is only needed when a content edit is still
      // pending; pure pan/zoom is already covered by the localStorage write.
      if (debounceTimerRef.current == null) return;
      window.clearTimeout(debounceTimerRef.current);
      debounceTimerRef.current = null;
      // Hydrate has not completed (no remote revision yet) → skip the unload
      // PUT. Sending an empty / partial payload at this point would either
      // get rejected by the dangerous-empty guard or, worse, overwrite the
      // server's state with a freshly-mounted, never-hydrated store.
      if (revisionRef.current == null || !hydratedRef.current) {
        return;
      }
      const canvasState = useCanvasStore.getState();
      const shot = useShotMetadataStore.getState().shot;
      const decision = decideSaveAction({
        hydrated: hydratedRef.current,
        switching: switchingRef.current,
        nodeCount: canvasState.nodes.length,
        edgeCount: canvasState.edges.length,
        lastRemoteNodeCount: lastRemoteNodeCountRef.current,
        userEditsSinceHydrate: canvasState.userEditsSinceHydrate,
        lastMutationSource: canvasState.lastMutationSource,
        pendingClearIntent: canvasState.pendingClearIntent,
      });
      if (decision.kind !== "send") {
        // `skip` or `block`: nothing safe to PUT at unload time.
        return;
      }
      // Reuse the pending idempotency token if a save was already in flight,
      // otherwise mint a fresh one so a hypothetical browser-issued retry
      // after the tab reopens still dedupes.
      const contentSignature = JSON.stringify({
        nodes: canvasState.nodes,
        edges: canvasState.edges,
        viewport: currentViewport,
        metadata: buildPersistMetadata(shot),
      });
      if (
        pendingClientSaveIdRef.current == null ||
        pendingClientSaveIdSignatureRef.current !== contentSignature
      ) {
        pendingClientSaveIdRef.current = generateClientSaveId();
        pendingClientSaveIdSignatureRef.current = contentSignature;
      }
      const clientSaveId = pendingClientSaveIdRef.current;
      const payload = buildSavePayload({
        canvasId,
        nodes: canvasState.nodes as unknown[],
        edges: canvasState.edges as unknown[],
        viewport: currentViewport,
        metadata: buildPersistMetadata(shot),
        baseRevision: revisionRef.current,
        clientSaveId,
        decision,
        envelope: canvasEnvelopeRef.current,
      });
      const url = `/api/v1/projects/${encodeURIComponent(project)}/freezone/canvases/${encodeURIComponent(canvasId)}`;
      void fetch(url, {
        method: "PUT",
        credentials: "include",
        keepalive: true,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }).catch(() => {
        // Best-effort; nothing actionable during unload.
      });
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [project, canvasId, metadata]);

  const retry = () => {
    // The user picked "refresh" on the conflict overlay — discard the local
    // snapshot so a future 409 starts fresh. If they wanted to keep it, they
    // would have clicked the "Download local JSON" button first.
    clearConflictSnapshot(canvasId);
    clearCanvasDraft(project, canvasId);
    setReloadKey((k) => k + 1);
  };
  const saveCopy = async () => {
    const snapshot = readConflictSnapshot(canvasId);
    if (!snapshot) {
      throw new Error("No local conflict snapshot is available to save.");
    }
    const copyCanvasId = buildConflictCopyCanvasId(canvasId);
    const shot = useShotMetadataStore.getState().shot;
    const response = await putFreezoneCanvas(project, copyCanvasId, {
      ...canvasEnvelopeRef.current,
      canvas_id: copyCanvasId,
      revision: undefined,
      base_revision: undefined,
      nodes: snapshot.nodes,
      edges: snapshot.edges,
      viewport: snapshot.viewport,
      metadata: buildConflictCopyMetadata({
        sourceCanvasId: canvasId,
        metadata: { ...(snapshot.metadata ?? {}), shotMetadata: shot },
      }),
      client_save_id: generateClientSaveId(),
      save_source: "manual_save",
      allow_empty_overwrite: snapshot.nodes.length === 0,
    });
    revisionRef.current = response.revision ?? 1;
    setRevision(revisionRef.current);
    setBackupStatus(response.backup_status ?? null);
    // Conflict copy is its own fresh save attempt; clear any stale pending id.
    pendingClientSaveIdRef.current = null;
    pendingClientSaveIdSignatureRef.current = null;
    // The local edits are now durable in the copy canvas — drop the snapshot.
    clearConflictSnapshot(canvasId);
    clearCanvasDraft(project, canvasId);
    setSyncStatus("ready");
    setError(null);
    return copyCanvasId;
  };

  // Free workflow copies are no longer a separate canvas mode. Keep the
  // metadata envelope pass-through, but do not read/write dedicated fields.

  const restoreMainlineDefault = async (options?: { bestEffort?: boolean }) => {
    const preset = metadata?.preset as Record<string, unknown> | undefined;
    const request = presetRequestFromMetadata(preset);
    if (!request) {
      throw new Error(t("freezone.canvasSync.notRestorablePreset"));
    }
    if (
      shouldDeferPresetRefreshUntilReady(
        options?.bestEffort,
        revision,
        hydratedCanvasId,
        canvasId,
      )
    ) {
      return canvasId;
    }
    setSyncStatus("saving");
    setError(null);
    try {
      const userEditsSinceHydrate = useCanvasStore.getState().userEditsSinceHydrate;
      if (shouldFlushBeforePresetRefresh(options?.bestEffort, userEditsSinceHydrate)) {
        const flushed = await flush();
        if (!flushed) {
          if (shouldAbortBestEffortPresetRefresh(options?.bestEffort, flushed)) {
            setError(null);
            setSyncStatus("ready");
            return canvasId;
          }
          throw new Error(t("freezone.canvasSync.unsavedConflictBeforeSync"));
        }
      }
      await createCanvasFromPreset(project, {
        ...request,
        canvas_id: canvasId,
        overwrite_existing: true,
        base_revision: revisionRef.current ?? undefined,
      });
      setReloadKey((k) => k + 1);
      return canvasId;
    } catch (err) {
      const status = statusFromError(err);
      if (options?.bestEffort && (status === 409 || status === 503)) {
        setError(null);
        setSyncStatus("ready");
        return canvasId;
      }
      const message =
        status === 409
          ? t("freezone.canvasSync.mainlineUpdatedElsewhere")
          : err instanceof Error
            ? err.message
            : String(err);
      setError(message);
      setSyncStatus("error");
      throw new Error(message);
    }
  };

  return {
    status,
    error,
    metadata,
    revision,
    hydratedCanvasId,
    hydratedProject,
    backupStatus,
    flush,
    retry,
    saveCopy,
    restoreMainlineDefault,
    readConflictSnapshot: () => readConflictSnapshot(canvasId),
    clearConflictSnapshot: () => clearConflictSnapshot(canvasId),
  };
}

interface SaveArgs {
  project: string;
  /** All copy on the save path must follow the UI language; it is passed down from useTranslation by the hook. */
  t: TFn;
  canvasId: string;
  nodes: unknown[];
  edges: unknown[];
  viewport?: Viewport;
  metadata?: Record<string, unknown> | null;
  /**
   * Optional explicit override. When omitted, `scheduleSave` builds the
   * snapshot from `useCanvasStore.getState()` + the refs and lets
   * `decideSaveAction` choose the source/allow-empty bits — the normal
   * autosave path. Explicit overrides are used by saveCopy / manual flows
   * that already know what they are.
   */
  forcedDecision?: Extract<SaveDecision, { kind: "send" }>;
  revisionRef: { current: number | null };
  statusRef: { current: CanvasSyncStatus };
  /**
   * Bumped every time a canvas is loaded into these refs (hydrate or remote
   * refresh). A request stamps itself with the value it saw and refuses to
   * apply its response if the stamp has moved on — `FreezoneShell` is mounted
   * without a key, so a canvas switch reuses the whole ref set.
   */
  canvasGenerationRef: { current: number };
  canvasEnvelopeRef: { current: Partial<FreezoneCanvasPayload> };
  pendingClientSaveIdRef: { current: string | null };
  pendingClientSaveIdSignatureRef: { current: string | null };
  hydratedRef: { current: boolean };
  switchingRef: { current: boolean };
  lastRemoteNodeCountRef: { current: number };
  setStatus: (s: CanvasSyncStatus) => void;
  setError: (e: string | null) => void;
  /**
   * Persist a snapshot of the local edits to `localStorage` so the user can
   * recover them after a 409. Implementation lives in the hook so the keys
   * stay in one place; this is just a hook into the error handler.
   */
  snapshotConflict?: (args: SaveArgs) => void;
  /**
   * Surface the backend's `backup_status` to the UI when it is something
   * other than the default `"synced"` / `"disabled"`. Used by the
   * canvas_backup_pending branch and by `consumeSaveResponse`.
   */
  publishBackupStatus?: (status: CanvasBackupStatus | null) => void;
  publishRevision?: (revision: number | null) => void;
  clearDraftAfterSave?: () => void;
  markDraftPersisted?: (signature: string) => void;
}

async function scheduleSave(args: SaveArgs): Promise<boolean> {
  // Serialisation and coalescing live in `canvasSaveCoordinator` now. This
  // function is only ever entered from a session's pump, one call at a time,
  // with `args` read from the live stores a moment earlier. What is left here
  // is the per-attempt work: re-check the guards, run the decision gate, put
  // the payload on the wire.
  if (
    args.statusRef.current === "conflict" ||
    args.statusRef.current === "error"
  ) {
    // A previous save failed terminally. Callers stop autosaving in this state;
    // a save already queued when that happened must not sneak a doomed PUT
    // past it, nor overwrite the conflict snapshot the overlay offers.
    return false;
  }

  // ---- Decision gate ---- //
  // Ask the pure state-machine whether this content state should produce a
  // PUT at all. `skip` means "the hook is mid-hydrate / mid-switch — wait
  // and try again later" (signature-based subscription will retrigger).
  // `block` means "local is empty but the server still has nodes and the
  // user did not ask for that" — surface as a soft conflict so the user can
  // refresh, without burning a real PUT to get a 400 back.
  const canvasState = useCanvasStore.getState();
  const decision: SaveDecision = args.forcedDecision ?? decideSaveAction({
    hydrated: args.hydratedRef.current,
    switching: args.switchingRef.current,
    nodeCount: canvasState.nodes.length,
    edgeCount: canvasState.edges.length,
    lastRemoteNodeCount: args.lastRemoteNodeCountRef.current,
    userEditsSinceHydrate: canvasState.userEditsSinceHydrate,
    lastMutationSource: canvasState.lastMutationSource,
    pendingClearIntent: canvasState.pendingClearIntent,
  });

  if (decision.kind === "skip") {
    return false;
  }
  if (decision.kind === "block") {
    args.pendingClientSaveIdRef.current = null;
    args.pendingClientSaveIdSignatureRef.current = null;
    args.setError(args.t("freezone.canvasSync.dangerousEmptyBlocked"));
    args.setStatus("conflict");
    return false;
  }

  // Identity for this save attempt. If the previous attempt failed with a
  // retryable code (503 canvas_lock_busy), the ref still holds the same id and
  // we reuse it so the backend can dedupe. If the content shape changed since
  // the last attempt, mint a fresh id instead.
  const contentSignature = JSON.stringify({
    nodes: args.nodes,
    edges: args.edges,
    viewport: args.viewport ?? null,
    metadata: args.metadata ?? null,
  });
  if (
    args.pendingClientSaveIdRef.current == null ||
    args.pendingClientSaveIdSignatureRef.current !== contentSignature
  ) {
    args.pendingClientSaveIdRef.current = generateClientSaveId();
    args.pendingClientSaveIdSignatureRef.current = contentSignature;
  }
  const clientSaveId = args.pendingClientSaveIdRef.current;

  args.setStatus("saving");
  return await performSave(
    args,
    decision,
    clientSaveId,
    0,
    args.canvasGenerationRef.current,
  );
}

async function performSave(
  args: SaveArgs,
  decision: Extract<SaveDecision, { kind: "send" }>,
  clientSaveId: string,
  attempt: number,
  /**
   * The canvas generation this PUT was dispatched under. If the user switches
   * canvases while it is on the wire, the shared refs no longer describe the
   * canvas we saved, and publishing the response into them would corrupt the
   * new canvas's state.
   */
  dispatchGeneration: number,
  /** How many rounds of self-healing have already run for "out-of-project media references". Only one round is allowed, see handleSaveError. */
  mediaScopeAttempt = 0,
): Promise<boolean> {
  const payload = buildSavePayload({
    canvasId: args.canvasId,
    nodes: args.nodes,
    edges: args.edges,
    viewport: args.viewport,
    metadata: args.metadata,
    baseRevision: args.revisionRef.current,
    clientSaveId,
    decision,
    envelope: args.canvasEnvelopeRef.current,
  });

  // Pre-flight size check.
  //
  // Node/edge **counts** are hard caps: the backend's Pydantic validator
  // rejects them with 422, and the only realistic way to hit 50k+ nodes is
  // a runaway loop in client code — we want to stop autosave loudly when
  // that happens. So count violations block the PUT and surface as an
  // error overlay.
  //
  // The 5 MB **body** cap is advisory on the client. Real freezone
  // canvases routinely cross 5 MB once image preview data URLs and per-
  // node metadata pile up, and the backend middleware that would enforce
  // the limit is not deployed everywhere yet. Logging a console warning
  // gives operators a signal without blocking real edits; if the backend
  // actually rejects with 413 once it ships, `classifySaveError` already
  // routes that to a fatal-error overlay (see the `fatal` branch above).
  const countViolation = checkPayloadLimits(
    args.nodes.length,
    args.edges.length,
    null,
  );
  if (countViolation) {
    args.pendingClientSaveIdRef.current = null;
    args.pendingClientSaveIdSignatureRef.current = null;
    args.setError(describePayloadViolation(countViolation, args.t));
    args.setStatus("error");
    return false;
  }
  const bodySize = JSON.stringify(payload).length;
  if (bodySize > MAX_BODY_BYTES) {
    console.warn(
      `[freezone] canvas PUT body ~${Math.round(bodySize / 1024)} KB ` +
        `exceeds ${Math.round(MAX_BODY_BYTES / 1024)} KB advisory cap ` +
        "(canvas_id=" +
        args.canvasId +
        "); proceeding anyway, backend may reject with 413",
    );
  }

  try {
    const response = await putFreezoneCanvas(args.project, args.canvasId, payload);
    if (args.canvasGenerationRef.current !== dispatchGeneration) {
      // The user switched canvases while this PUT was on the wire. The save
      // itself succeeded server-side, but every ref the response would update
      // (revision, envelope, remote node count, draft signature) now belongs to
      // a different canvas — writing this canvas's revision into them would
      // make the new canvas's next save PUT a stale base_revision and 409.
      return true;
    }
    consumeSaveResponse(args, response, decision);
    args.setStatus("ready");
    args.setError(null);
    return true;
  } catch (err) {
    if (args.canvasGenerationRef.current !== dispatchGeneration) {
      // Same reasoning: a failure that belongs to the canvas we left must not
      // flip the new canvas into a conflict/error state or hijack its retry.
      return false;
    }
    return await handleSaveError(
      args,
      err,
      decision,
      clientSaveId,
      attempt,
      dispatchGeneration,
      mediaScopeAttempt,
    );
  }
}

function consumeSaveResponse(
  args: SaveArgs,
  response: FreezoneCanvasSaveResult,
  decision: Extract<SaveDecision, { kind: "send" }>,
): void {
  if (typeof response.revision === "number") {
    args.revisionRef.current = response.revision;
    args.publishRevision?.(response.revision);
    args.canvasEnvelopeRef.current = {
      ...args.canvasEnvelopeRef.current,
      revision: response.revision,
      ...(response.updated_at ? { updated_at: response.updated_at } : {}),
    };
  }
  // Record what the server now sees so the next dangerous-empty check has
  // an up-to-date baseline.
  args.lastRemoteNodeCountRef.current = args.nodes.length;
  args.markDraftPersisted?.(
    canvasDraftSignature(
      args.nodes as CanvasNode[],
      args.edges as CanvasEdge[],
      args.metadata ?? null,
    ),
  );
  // Drop the pending idempotency token — next content change mints a new one.
  args.pendingClientSaveIdRef.current = null;
  args.pendingClientSaveIdSignatureRef.current = null;
  if (args.clearDraftAfterSave) {
    args.clearDraftAfterSave();
  } else {
    clearCanvasDraft(args.project, args.canvasId);
  }
  if (decision.saveSource === "manual_clear") {
    // One-shot intent has been honored by the server. Clear the flag so a
    // subsequent autosave with empty nodes does not auto-promote a second
    // time after the user immediately adds content back.
    useCanvasStore.getState().acknowledgePendingClear();
  }
  const backupStatus: CanvasBackupStatus | undefined = response.backup_status;
  // Always publish the latest server-reported backup_status so the UI can
  // surface or clear "Backing up" / "Backup failed" indicators in lock-step with the
  // wire response. Treat undefined as "no information" (legacy backend);
  // "synced" / "disabled" are silent in the UI.
  args.publishBackupStatus?.(backupStatus ?? null);
  if (backupStatus === "failed") {
    // Local save succeeded, but the async OSS backup failed. Surface a soft
    // warning without flipping into the hard error path — the user's edits
    // are durable on the server, just not yet replicated. The dedicated
    // backupStatus channel above also picks this up for the UI indicator.
    args.setError(args.t("freezone.canvasSync.backupFailed"));
  }
}

async function handleSaveError(
  args: SaveArgs,
  err: unknown,
  decision: Extract<SaveDecision, { kind: "send" }>,
  clientSaveId: string,
  attempt: number,
  dispatchGeneration: number,
  mediaScopeAttempt: number,
): Promise<boolean> {
  const { status, body } = saveErrorStatusAndBody(err);
  const fallback = err instanceof Error ? err.message : String(err);
  const outcome: SaveResponseOutcome = classifySaveError(
    status,
    body,
    fallback,
    args.t,
  );

  // Local helpers — every "terminal" branch drops the pending idempotency
  // token so the next fresh content change mints a new one. Retry branches
  // (only 503 canvas_lock_busy today) keep the token alive.
  const dropPendingId = () => {
    args.pendingClientSaveIdRef.current = null;
    args.pendingClientSaveIdSignatureRef.current = null;
  };

  switch (outcome.kind) {
    case "conflict": {
      // Optimistic-lock conflict: stash the local edits to localStorage so
      // the user can recover them, then surface the overlay.
      dropPendingId();
      args.snapshotConflict?.(args);
      args.setError(outcome.message);
      args.setStatus("conflict");
      return false;
    }
    case "dangerous_empty": {
      // Backend rejected an empty overwrite. Treat as soft conflict so the
      // user refreshes; never auto-retry with an empty payload.
      dropPendingId();
      args.setError(outcome.message);
      args.setStatus("conflict");
      return false;
    }
    case "retry": {
      // 503 canvas_lock_busy: another writer is mid-save. Keep the same
      // client_save_id so the backend's idempotency record dedupes.
      if (attempt < LOCK_BUSY_MAX_RETRIES) {
        await new Promise((resolve) =>
          setTimeout(resolve, outcome.afterMs),
        );
        if (args.canvasGenerationRef.current !== dispatchGeneration) {
          // Switched canvases during the backoff; the retry would PUT the new
          // canvas's content under the old canvas's id.
          return false;
        }
        return await performSave(
          args,
          decision,
          clientSaveId,
          attempt + 1,
          dispatchGeneration,
        );
      }
      // Retry budget exhausted — surface as a generic error so the user
      // knows the save did not stick.
      dropPendingId();
      args.setError(args.t("freezone.canvasSync.lockBusy"));
      args.setStatus("error");
      return false;
    }
    case "ok_with_warning": {
      // 503 canvas_backup_pending: backend persisted locally; OSS backup
      // is in flight. Treat as success; the backupStatus side-channel
      // exposes the "pending" state to the UI.
      dropPendingId();
      if (args.clearDraftAfterSave) {
        args.clearDraftAfterSave();
      } else {
        clearCanvasDraft(args.project, args.canvasId);
      }
      args.publishBackupStatus?.(outcome.backupStatus);
      args.setError(null);
      args.setStatus("ready");
      return true;
    }
    case "media_scope": {
      // The backend blocked the newly introduced out-of-project media reference (static assets are authorized independently by the project id in the URL;
      // saving it would give other members a 403). It can self-heal: copy the assets into this project, rewrite the references and retry.
      // Heal only one round - if the second attempt is still rejected, the copy or rewrite did not take effect, and looping again is an endless loop.
      if (mediaScopeAttempt > 0) {
        dropPendingId();
        args.setError(args.t("freezone.canvasSync.mediaScopeMismatch"));
        args.setStatus("error");
        return false;
      }
      const repair = await repairForeignMediaRefs({
        refs: outcome.refs,
        targetProject: args.project,
        getLiveNodeData: (id) =>
          (useCanvasStore.getState().nodes.find((node) => node.id === id)?.data ??
            null) as never,
        updateNodeData: (id, patch) => {
          // This repairs existing data, it is not a user action: do not push onto the undo stack.
          useCanvasStore
            .getState()
            .updateNodeData(id, patch, { recordHistory: false });
        },
      });
      if (args.canvasGenerationRef.current !== dispatchGeneration) {
        return false;
      }
      if (repair.retryable) {
        // This copy round did not go through (network/5xx); it does not mean "these assets cannot be copied". No field was changed,
        // the original URLs are left as they are, just report an error so the user retries - clearing them is irreversible and must not be traded for a flicker.
        dropPendingId();
        args.setError(args.t("freezone.canvasSync.mediaScopeRetryable"));
        args.setStatus("error");
        return false;
      }
      const repairedNodes = applyForeignMediaRepairToNodes(
        args.nodes as Array<{ id: string; data?: unknown }>,
        outcome.refs,
        repair,
      );
      if (repairedNodes === (args.nodes as unknown)) {
        // Nothing was changed (node deleted / field replaced by the user / path mismatch): retrying would be rejected the same way.
        dropPendingId();
        args.setError(args.t("freezone.canvasSync.mediaScopeMismatch"));
        args.setStatus("error");
        return false;
      }
      // If the payload changed we must use a new client_save_id: reusing the old one would hit the backend's idempotency record and return 409.
      const retryClientSaveId = generateClientSaveId();
      args.pendingClientSaveIdRef.current = retryClientSaveId;
      args.pendingClientSaveIdSignatureRef.current = null;
      return await performSave(
        { ...args, nodes: repairedNodes },
        decision,
        retryClientSaveId,
        attempt,
        dispatchGeneration,
        mediaScopeAttempt + 1,
      );
    }
    case "fatal": {
      // 422 / 413 (payload too large), 500 (canvas_needs_migration /
      // canvas_backup_failed): the data on the server may be inconsistent.
      // Stop autosaving and surface a visible error so the user can take
      // action (delete nodes, contact admin, etc.).
      dropPendingId();
      args.setError(outcome.message);
      args.setStatus("error");
      return false;
    }
    case "ok": {
      dropPendingId();
      clearCanvasDraft(args.project, args.canvasId);
      args.publishBackupStatus?.(outcome.backupStatus ?? null);
      args.setError(null);
      args.setStatus("ready");
      return true;
    }
    case "error":
    default: {
      dropPendingId();
      args.setError(outcome.message);
      args.setStatus("error");
      return false;
    }
  }
}

function canvasEnvelopeFromRemote(
  remote: FreezoneCanvasPayload,
): Partial<FreezoneCanvasPayload> {
  return {
    schema_version: remote.schema_version,
    canvas_id: remote.canvas_id,
    project_id: remote.project_id,
    canvas_scope: remote.canvas_scope,
    owner_principal_type: remote.owner_principal_type,
    owner_principal_id: remote.owner_principal_id,
    access_model: remote.access_model,
    min_project_role: remote.min_project_role,
    episode: remote.episode,
    beat: remote.beat,
    asset_target: remote.asset_target,
    revision: remote.revision,
    created_by: remote.created_by,
    updated_by: remote.updated_by,
    created_at: remote.created_at,
    updated_at: remote.updated_at,
  };
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function presetRequestFromMetadata(
  preset: unknown,
): Omit<FreezonePresetCanvasRequest, "canvas_id" | "overwrite_existing"> | null {
  if (!preset || typeof preset !== "object") return null;
  const data = preset as Record<string, unknown>;
  const scope = typeof data.scope === "string" ? data.scope : "";
  if (scope !== "episode" && scope !== "beat" && scope !== "asset") return null;
  return {
    scope,
    episode: numberOrNull(data.episode),
    beat: numberOrNull(data.beat),
    primary_slot:
      typeof data.primary_slot === "string" ? data.primary_slot : "render",
    asset_kind: stringOrNull(data.asset_kind),
    character: stringOrNull(data.character),
    identity_id: stringOrNull(data.identity_id),
    asset_id: stringOrNull(data.asset_id),
  };
}

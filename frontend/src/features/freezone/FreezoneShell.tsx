import { htmlArtifactNodePatches } from '@/features/html-artifacts/nodeMetadata';
import { HtmlArtifactEditor } from '@/features/html-artifacts/HtmlArtifactEditor';
import { HTML_ARTIFACT_OPEN_EVENT, HTML_ARTIFACT_REFERENCE_EVENT, HTML_ARTIFACT_UPDATED_EVENT, type HtmlArtifactTarget } from '@/features/html-artifacts/api';
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import { useQueryClient } from "@tanstack/react-query";
import {
  Clapperboard,
  PanelRight,
  PanelRightClose,
  PanelRightOpen,
  PictureInPicture2,
  Plus,
  Search,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Canvas } from "@/features/canvas/Canvas";
import { NodeReplaceDragPreview } from "@/features/canvas/ui/NodeReplaceDragPreview";
import { AssetBoardView } from "@/features/canvas/ui/asset-board/AssetBoardView";
import {
  listCharacters,
  listFreezoneProjectAssets,
  type FreezoneProjectAsset,
  type SupertaleProjectSummary,
} from "@/api/projects";
import {
  buildProjectionFromPreset,
  getProjectionStatuses,
  type FreezonePresetCanvasRequest,
} from "@/api/canvas";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import { currentCanvasParam } from "@/lib/app-router";
import { rememberLastCanvas, writeUrl } from "@/lib/url-params";
import { cn } from "@/lib/utils";
import type { TFn } from "@/lib/i18n-types";
import { surfaceAccess, useProductSurfaces } from "@/lib/queries/product-surfaces";
import { api } from "@/lib/api";
import {
  SUPERCHAT_CANVAS_COMMAND_EVENT,
  SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT,
} from "@/features/superchat/use-superchat";
import { mcpDirectCanvasApplyEnabled } from "@/lib/runtime-config";
import { SuperChatPanel } from "@/features/superchat/superchat-panel";
import type { ChatAttachment } from "@/features/superchat/types";
import { CommitDialog } from "./commit/CommitDialog";
import { promoteToAsset } from "./commit/promoteToAsset";
import { commitDirectorRenderFromCanvasSource } from "./commit/directorRenderCommit";
import {
  commitSceneDirectorWorldFromCanvasNode,
  hasDirectorWorldSceneState,
  isDirectorWorldSourceSlotTarget,
} from "./commit/sceneDirectorWorldCommit";
import { nodeDataAfterCommittedSlot } from "./commit/committedNodePatch";
import { isCommitCandidateData } from "./commit/commitEligibility";
import { CreateIdentityDialog } from "@/pipeline-import/CreateIdentityDialog";
import { CompareDialog } from "@/pipeline-import/CompareDialog";
import { MaskEditor } from "@/pipeline-import/MaskEditor";
import { AssetLibraryPanel } from "./AssetLibraryPanel";
import { CanvasDebugPanel } from "./CanvasDebugPanel";
import {
  FREEZONE_DOCK_TRANSITION_VAR,
  FREEZONE_DOCK_WIDTH_VAR,
  freezoneDockOffsetCss,
} from "./dockOffset";
import type { PushResult, PushTarget, PushTargetKind } from "@/api/push";
import { coerceSlotTarget } from "@/features/canvas/domain/mainlineNodeTypes";
import { canvasEventBus } from "@/features/canvas/application/canvasServices";
import { saveOpenDirectorWorldScene } from "@/features/canvas/domain/directorWorldSceneSaveRegistry";
import {
  assetToPushTarget,
  inferDefaultTarget,
  isPlyOrGlbPushTargetKind,
  isScenePushTargetKind,
} from "@/features/freezone/commit/pushTarget";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  deriveNodeDropInfo,
  modelSourceUrlFromNodeData,
  type DropMediaType,
} from "@/stores/assetDropStore";
import { withImageCacheBust } from "@/features/canvas/application/imageData";
import { queryKeys } from "@/lib/query-keys";
import { SESSION_EXPIRED_EVENT } from "@/lib/session-expiry";
import { useCanvasSync, type CanvasSyncStatus, type ConflictSnapshot } from "./useCanvasSync";
import { prefetchFreezoneImageModels } from "@/features/canvas/hooks/useFreezoneImageModels";
import { prefetchFreezoneVideoModels } from "@/features/canvas/hooks/useFreezoneVideoModels";
import { prefetchFreezoneCameraOptions } from "@/features/canvas/hooks/useFreezoneCameraOptions";
import { prefetchFreezoneStyleTemplates } from "@/features/canvas/hooks/useFreezoneStyleTemplates";
import { prefetchFreezoneVideoCameraTemplates } from "@/features/canvas/hooks/useFreezoneVideoCameraTemplates";
import {
  claimExternalCanvasCommand,
  confirmedExternalCanvasCommandKeys,
} from "./externalCanvasCommandDedupe";
import {
  normalizePresetProjectionRequest,
  projectionMetadataWithRequest,
  projectionTargetForCanvasPanel,
} from "@/features/freezone/projections";
import {
  clearCanvasProjectionStatuses,
  markCanvasProjectionFresh,
  setCanvasProjectionStatuses,
} from "@/features/freezone/projectionStatusStore";
import {
  consumeQueuedLocalFreezoneProjections,
  queueLocalFreezoneProjection,
  removeLocalFreezoneProjection,
} from "@/features/freezone/canvasSyncRuntime";
import {
  useFreezoneViewMode,
  type FreezoneViewMode,
} from "@/features/freezone/useFreezoneViewMode";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CanvasEdge, CanvasNode } from "@/stores/canvasStore";
import { resolveNodeDisplayName } from "@/features/canvas/domain/nodeDisplay";
import {
  CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
  canvasCommandEnvelopeMatchesCanvas,
  emitCanvasCommandApproval,
  extractCanvasChatCommandEnvelopes,
  FREEZONE_CANVAS_COMMAND_RESULT_EVENT,
  normalizeCanvasChatCommandEnvelopesForValidation,
  type CanvasChatCommandApplyResult,
} from "@/features/freezone/canvasChatCommands";
import {
  addFreezoneCanvasAgent,
  DEFAULT_FREEZONE_AGENT_ID,
  loadFreezoneCanvasAgentsWithSource,
  mergeFreezoneCanvasAgentsFromServer,
  readFreezoneAgentIdFromUrl,
  selectFreezoneCanvasAgent,
  shouldConnectFreezoneCanvasAgent,
  shouldKeepFreezoneChatPanelMounted,
  updateFreezoneCanvasAgentFromUserMessage,
  type FreezoneCanvasAgent,
  type FreezoneCanvasAgentState,
} from "@/features/freezone/canvasAgents";
import { validateCanvasChatCommandEnvelopes } from "@/features/freezone/context/canvasCommandValidator";
import {
  replayCanvasCommandToolResult,
  reportCanvasCommandToolResult,
} from "@/features/freezone/canvasCommandToolResult";
import {
  emitCanvasContextActivity,
  reportCanvasContextToolResult,
} from "@/features/freezone/canvasContextToolResult";
import {
  buildCanvasNodeReferenceAttachment,
  buildCanvasContextRequestResponses,
  canvasSelectionAttachmentDeliveryKey,
  extractCanvasContextRequestEnvelopes,
} from "@/features/freezone/chatNodeReferences";
import {
  buildCanvasOntologyContext,
  type CanvasOntologyContext,
} from "@/features/canvas/ontology/canvasOntology";
import type { ServerFrame } from "@/features/superchat/types";
import { initializeEmptyFreezoneAgentChat } from "@/features/superchat/freezoneChatScopeCache";
import { WorkflowRunRecoveryBar } from "./WorkflowRunRecoveryBar";

export { hasLegacyPresetCanvasMetadata } from "@/features/freezone/projections";

interface FreezoneShellProps {
  project: SupertaleProjectSummary;
  canvasId: string;
  /**
   * Whether the canvas is the page currently in view. When the top bar switches to "Shrimp Market"
   * the host no longer unmounts this component; it only sets active=false (see FreezoneCanvasHost).
   * Keep-alive avoids dropped frames on switching, at the cost of manually handing off everything
   * that only the foreground should do: global shortcuts (passed through as Canvas `suspended`)
   * and the two polls. Defaults to true so callers mounting FreezoneShell directly keep the old behavior.
   */
  active?: boolean;
}

type CurrentCanvasSelectionItem = {
  nodeId: string;
  nodeType: string | null;
  label: string;
};

const PROJECTION_STATUS_REFRESH_MS = 30_000;
const FREEZONE_CHAT_WIDTH_STORAGE_KEY = "freezone.chatDock.chatWidth";
const FREEZONE_AGENT_HISTORY_WIDTH_STORAGE_KEY = "freezone.chatDock.agentHistoryWidth";
const FREEZONE_CHAT_WIDTH_DEFAULT = 540;
const FREEZONE_CHAT_WIDTH_MIN = 420;
const FREEZONE_CHAT_WIDTH_MAX = 760;
const FREEZONE_AGENT_HISTORY_WIDTH_DEFAULT = 220;
const FREEZONE_AGENT_HISTORY_WIDTH_MIN = 180;
const FREEZONE_AGENT_HISTORY_WIDTH_MAX = 360;
// Keep the multi-session implementation available for a future product mode,
// but Freezone currently defines one Agent session per canvas.
const FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED = false;
/**
 * The narrowest the left content may be squeezed to by the drawer.
 * - Workflow (overlay): the canvas can be arbitrarily narrow; 360 just keeps it from vanishing.
 * - Storyboard (squeeze): three columns with a 200px minimum each + two 12px dividers + container px-4;
 *   below 680 the columns get pushed out of the container by min-width and the right one is clipped.
 */
const FREEZONE_CHAT_MIN_CONTENT_WIDTH = 360;
const FREEZONE_CHAT_MIN_BOARD_CONTENT_WIDTH = 680;
/**
 * The two inner pane widths of the drawer are driven by CSS variables (set on <aside>, read by both panes).
 * While dragging, only this one shell element's style needs updating to drive the shell and both
 * inner panes at once, without touching React - see paint() in startPaneResize.
 */
const CHAT_PANE_WIDTH_VAR = "--freezone-chat-pane-width";
const AGENT_HISTORY_PANE_WIDTH_VAR = "--freezone-agent-history-pane-width";
/**
 * The assistant drawer has two layouts: docked to the right (full-height drawer; the top bar etc. yield
 * according to --freezone-dock-width) or floating (rounded window over the content, draggable, squeezes nothing).
 * The user switches in the chat header; the preference is stored locally.
 */
type FreezoneChatDockMode = "docked" | "floating";
const FREEZONE_CHAT_DOCK_MODE_STORAGE_KEY = "freezone.chatDock.mode";
/** The floating window position is stored as right margin + top margin, so dragging the left edge wider keeps the right edge fixed, matching the docked feel. */
const FREEZONE_CHAT_FLOAT_POS_STORAGE_KEY = "freezone.chatDock.floatPos";
const FREEZONE_CHAT_FLOAT_HEIGHT = 720;
const FREEZONE_CHAT_FLOAT_MARGIN = 12;
/** Leave room for the top bar (48px) and the bottom task status bar (36px) so the floating window is not covered. */
const FREEZONE_CHAT_FLOAT_MIN_TOP = 56;
const FREEZONE_CHAT_FLOAT_BOTTOM_RESERVE = 44;
const FREEZONE_CHAT_FLOAT_DEFAULT_POS = { right: 24, top: FREEZONE_CHAT_FLOAT_MIN_TOP + 8 };
const EXTERNAL_CANVAS_COMMAND_POLL_MS = 800;
const EXTERNAL_CANVAS_REVISION_POLL_MS = 2_000;

/**
 * The two keys of the top-left "Workflow / Storyboard" toggle.
 * Icons only; the text goes in the hover tooltip + aria-label (the text capsules took too much canvas).
 * Order is visual order - the slider offset is computed from the index (the 2nd key is translate-x-7).
 */
function getFreezoneViewModeTabs(t: ReturnType<typeof useTranslation>["t"]): ReadonlyArray<{
  mode: FreezoneViewMode;
  icon: LucideIcon;
  label: string;
}> {
  return [
    { mode: "workflow", icon: Workflow, label: t("freezone.viewMode.workflow") },
    { mode: "board", icon: Clapperboard, label: t("freezone.viewMode.board") },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function loadStoredPanelWidth(key: string, fallback: number, min: number, max: number): number {
  if (typeof window === "undefined") return fallback;
  const parsed = Number(window.localStorage.getItem(key));
  return Number.isFinite(parsed) ? clampNumber(parsed, min, max) : fallback;
}

function storePanelWidth(key: string, value: number): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(key, String(Math.round(value)));
}

function loadChatDockMode(): FreezoneChatDockMode {
  try {
    return window.localStorage.getItem(FREEZONE_CHAT_DOCK_MODE_STORAGE_KEY) === "floating"
      ? "floating"
      : "docked";
  } catch {
    return "docked";
  }
}

function storeChatDockMode(mode: FreezoneChatDockMode): void {
  try {
    window.localStorage.setItem(FREEZONE_CHAT_DOCK_MODE_STORAGE_KEY, mode);
  } catch {
    // If it cannot be stored, the next visit simply returns to the default dock; this switch is unaffected.
  }
}

function loadChatFloatPos(): { right: number; top: number } {
  try {
    const raw = window.localStorage.getItem(FREEZONE_CHAT_FLOAT_POS_STORAGE_KEY);
    if (!raw) return FREEZONE_CHAT_FLOAT_DEFAULT_POS;
    const parsed = JSON.parse(raw) as { right?: unknown; top?: unknown };
    if (typeof parsed.right === "number" && typeof parsed.top === "number") {
      return { right: parsed.right, top: parsed.top };
    }
  } catch {
    // ignore malformed storage
  }
  return FREEZONE_CHAT_FLOAT_DEFAULT_POS;
}

function storeChatFloatPos(pos: { right: number; top: number }): void {
  try {
    window.localStorage.setItem(
      FREEZONE_CHAT_FLOAT_POS_STORAGE_KEY,
      JSON.stringify({ right: Math.round(pos.right), top: Math.round(pos.top) }),
    );
  } catch {
    // ignore storage failures
  }
}

/**
 * Open/closed state of the canvas agent: persisted to localStorage and restored after refresh or
 * re-entering the canvas, so a refresh mid-workflow does not drop an open conversation. The key also
 * avoids the `supertale-` prefix (reset-region-state sweeps would wipe it) - open/closed is just a UI preference.
 */
const CHAT_OPEN_STORAGE_KEY = "st.freezone.chatOpen";

function loadChatOpen(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(CHAT_OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function storeChatOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(CHAT_OPEN_STORAGE_KEY, open ? "1" : "0");
  } catch {
    // storage full / unavailable — open/closed state is simply not persisted
  }
}

async function listServerFreezoneCanvasAgents(
  projectId: string,
  canvasId: string,
): Promise<FreezoneCanvasAgent[]> {
  const response = await api.post("api/v1/chat/freezone-canvas-agents", {
    json: { project_id: projectId, canvas_id: canvasId },
  }).json<{
    ok?: boolean;
    data?: { agents?: FreezoneCanvasAgent[] };
  }>();
  return Array.isArray(response.data?.agents) ? response.data.agents : [];
}

async function listPendingCanvasCommandFrames({
  projectId,
  canvasId,
  agentIds,
  seenKeys,
}: {
  projectId: string;
  canvasId: string;
  agentIds: string[];
  seenKeys: string[];
}): Promise<ServerFrame[]> {
  const response = await api.post("api/v1/chat/pending-canvas-commands", {
    json: {
      project_id: projectId,
      canvas_id: canvasId,
      agent_ids: agentIds,
      seen_keys: seenKeys,
    },
  }).json<{
    ok?: boolean;
    data?: { frames?: ServerFrame[] };
  }>();
  return Array.isArray(response.data?.frames) ? response.data.frames : [];
}

function pushJsonTextCanvasCommandCandidate(candidates: unknown[], text: unknown): void {
  if (typeof text !== "string" || !text.trim()) return;
  try {
    candidates.push(JSON.parse(text));
  } catch {
    // Non-JSON text can appear in tool display messages.
  }
}

function pushCanvasCommandCandidate(candidates: unknown[], value: unknown): void {
  if (!isRecord(value)) return;
  candidates.push(value);
  if (Array.isArray(value.commands) && value.schema_version !== CANVAS_CHAT_COMMANDS_SCHEMA_VERSION) {
    candidates.push({
      schema_version: CANVAS_CHAT_COMMANDS_SCHEMA_VERSION,
      canvas_id: typeof value.canvas_id === "string" ? value.canvas_id : undefined,
      commands: value.commands,
    });
  }
  if (value.envelope) pushCanvasCommandCandidate(candidates, value.envelope);
  if (value.rawInput) pushCanvasCommandCandidate(candidates, value.rawInput);
  if (value.raw_input) pushCanvasCommandCandidate(candidates, value.raw_input);
  pushJsonTextCanvasCommandCandidate(candidates, value.text);
}

function canvasCommandCandidatesFromFrame(frame: ServerFrame): unknown[] {
  const candidates: unknown[] = [];
  const record = frame as Record<string, unknown>;
  pushCanvasCommandCandidate(candidates, record.envelope);
  pushCanvasCommandCandidate(candidates, record.input);
  pushCanvasCommandCandidate(candidates, record.raw);
  pushJsonTextCanvasCommandCandidate(candidates, record.text);
  return candidates;
}

function canvasContextRequestCandidatesFromDetail(detail: Record<string, unknown>): unknown[] {
  return [
    detail.envelope,
    detail.request,
    detail.requests,
    detail.input,
    detail.raw,
    detail,
  ];
}

async function loadMainlineProjectionAssets(project: string): Promise<FreezoneProjectAsset[]> {
  const [assets, characters] = await Promise.all([
    listFreezoneProjectAssets(project),
    listCharacters(project),
  ]);
  const characterAssets: FreezoneProjectAsset[] = characters
    .map((character): FreezoneProjectAsset | null => {
      const name = typeof character.name === "string" ? character.name.trim() : "";
      if (!name) return null;
      const displayName =
        typeof character.display_name === "string" && character.display_name.trim()
          ? character.display_name.trim()
          : name;
      return {
        id: `character:${name}`,
        tab: "characters",
        kind: "character",
        role: "character_profile",
        label: displayName,
        sublabel: typeof character.role === "string" && character.role.trim() ? character.role.trim() : undefined,
        url: typeof character.portrait_url === "string" && character.portrait_url.trim()
          ? character.portrait_url.trim()
          : null,
        exists: true,
        media_type: character.portrait_url ? "image" : "text",
        meta: { character: name },
      };
    })
    .filter((asset): asset is FreezoneProjectAsset => Boolean(asset));
  return [...assets, ...characterAssets];
}

function canvasCommandValidationFailureResult(errors: string[]): CanvasChatCommandApplyResult {
  return {
    applied: 0,
    openedUiActions: 0,
    createdNodeIds: [],
    errors,
    commandResults: [
      {
        commandIndex: -1,
        type: "validate",
        status: "error",
        label: i18n.t("freezone.shell.validateCanvasCommand"),
        error: errors.join("; "),
      },
    ],
  };
}

function persistCanvasCommandResult({
  projectId,
  canvasId,
  turnId,
  envelopes,
  result,
  anchorTextPrefix,
  receivedAt,
  bridgeKey,
}: {
  projectId: string;
  canvasId: string;
  turnId: string | null;
  envelopes: ReturnType<typeof extractCanvasChatCommandEnvelopes>;
  result: CanvasChatCommandApplyResult;
  anchorTextPrefix?: string | null;
  receivedAt?: number;
  bridgeKey?: string | null;
}) {
  if (!turnId) return;
  void api.post("api/v1/chat/ui-events", {
    json: {
      scope: {
        kind: "project",
        id: projectId,
        surface: "freezone",
        canvasId,
      },
      turn_id: turnId,
      event: {
        schema_version: "canvas_command_result.v1",
        type: "canvas_command_result",
        canvas_id: canvasId,
        bridge_key: bridgeKey ?? null,
        envelopes,
        result,
        anchor_text_prefix: anchorTextPrefix ?? null,
        received_at: receivedAt ?? Date.now(),
      },
    },
  }).catch((error) => {
    console.warn("[freezone-canvas-command] failed to persist canvas command result", {
      canvasId,
      turnId,
      error,
    });
  });
}

function persistCanvasCommandApproval({
  projectId,
  canvasId,
  turnId,
  envelopes,
  anchorTextPrefix,
  receivedAt,
  externalMcpCommand,
  bridgeKey,
}: {
  projectId: string;
  canvasId: string;
  turnId: string | null;
  envelopes: ReturnType<typeof extractCanvasChatCommandEnvelopes>;
  anchorTextPrefix?: string | null;
  receivedAt?: number;
  externalMcpCommand?: boolean;
  bridgeKey?: string | null;
}) {
  if (!turnId) return;
  void api.post("api/v1/chat/ui-events", {
    json: {
      scope: {
        kind: "project",
        id: projectId,
        surface: "freezone",
        canvasId,
      },
      turn_id: turnId,
      event: {
        schema_version: "canvas_command_approval.v1",
        type: "canvas_command_approval",
        canvas_id: canvasId,
        bridge_key: bridgeKey ?? null,
        envelopes,
        anchor_text_prefix: anchorTextPrefix ?? null,
        received_at: receivedAt ?? Date.now(),
        ...(externalMcpCommand === true ? { external_mcp_command: true } : {}),
      },
    },
  }).catch((error) => {
    console.warn("[freezone-canvas-command] failed to persist canvas command approval", {
      canvasId,
      turnId,
      error,
    });
  });
}

function persistCanvasCommandValidationActivity({
  projectId,
  canvasId,
  turnId,
  bridgeKey,
  ok,
  errors,
  anchorTextPrefix,
  receivedAt,
  externalMcpCommand,
}: {
  projectId: string;
  canvasId: string;
  turnId: string | null;
  bridgeKey: string;
  ok: boolean;
  errors: string[];
  anchorTextPrefix?: string | null;
  receivedAt?: number;
  externalMcpCommand?: boolean;
}) {
  if (!turnId) return;
  void api.post("api/v1/chat/ui-events", {
    json: {
      scope: {
        kind: "project",
        id: projectId,
        surface: "freezone",
        canvasId,
      },
      turn_id: turnId,
      event: {
        schema_version: "canvas_context_result.v1",
        type: "canvas_context_result",
        canvas_id: canvasId,
        bridge_key: bridgeKey,
        result: {
          ok,
          responses: [{ type: "validate_canvas_commands" }],
          errors,
        },
        anchor_text_prefix: anchorTextPrefix ?? null,
        received_at: receivedAt ?? Date.now(),
        ...(externalMcpCommand === true ? { external_mcp_command: true } : {}),
      },
    },
  }).catch((error) => {
    console.warn("[freezone-canvas-command] failed to persist canvas command validation activity", {
      canvasId,
      turnId,
      error,
    });
  });
}

/**
 * Register every trigger that refreshes projection status and tear them all
 * down synchronously when the shared API layer confirms session expiry.
 */
export function startProjectionStatusRefresh(
  refresh: () => void,
  onSessionExpired: () => void,
): () => void {
  let stopped = false;
  const handleVisibilityChange = () => {
    if (document.visibilityState === "visible") refresh();
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    window.removeEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
    window.clearInterval(timer);
  };
  const handleSessionExpired = () => {
    stop();
    onSessionExpired();
  };

  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", handleVisibilityChange);
  window.addEventListener(SESSION_EXPIRED_EVENT, handleSessionExpired);
  const timer = window.setInterval(refresh, PROJECTION_STATUS_REFRESH_MS);
  return stop;
}

function renderCommitSuccessMessage(target: PushTarget, result: PushResult, t: TFn): string {
  if (target.kind === "director_render") {
    return t("freezone.commit.success.directorRender", { path: result.target_path });
  }
  if (target.kind === "scene_director_world") {
    return t("freezone.commit.success.directorWorld", { path: result.target_path });
  }
  return t("freezone.commit.success.default", { path: result.target_path });
}

function sceneDirectorWorldDataForManifest(
  nodeData: Record<string, unknown>,
  target: PushTarget,
  result: PushResult,
  projectId: string | undefined,
  t: TFn,
): Record<string, unknown> | null {
  const manifestNodeData = nodeDataPatchAfterCommittedSourceSlot(nodeData, target, result, projectId, t);
  return hasDirectorWorldSceneState(manifestNodeData) ? manifestNodeData : null;
}

export function nodeDataPatchAfterCommittedSourceSlot(
  nodeData: Record<string, unknown>,
  target: PushTarget,
  result: PushResult,
  projectId: string | undefined,
  t: TFn,
): Record<string, unknown> | null {
  if (!isDirectorWorldSourceSlotTarget(target)) return null;
  return nodeDataAfterCommittedSlot(nodeData, target, result, projectId, t);
}

export function nodeDataPatchAfterCommittedTarget(
  nodeData: Record<string, unknown>,
  target: PushTarget,
  result: PushResult,
  projectId: string | undefined,
  t: TFn,
): Record<string, unknown> | null {
  if (isDirectorWorldSourceSlotTarget(target)) return null;
  return nodeDataAfterCommittedSlot(nodeData, target, result, projectId, t);
}

function latestCanvasNodeData(nodeId: string): Record<string, unknown> | null {
  const node = useCanvasStore.getState().nodes.find((candidate) => candidate.id === nodeId);
  return node?.data && typeof node.data === "object"
    ? node.data as Record<string, unknown>
    : null;
}

export function resolveSubmitNodeData(
  latest: Record<string, unknown> | null | undefined,
  fallback: Record<string, unknown> | null | undefined,
): Record<string, unknown> | null {
  return latest ?? fallback ?? null;
}

export function shouldRefreshCommittedTargetNodes(target: PushTarget): boolean {
  // scene_director_world is a structured manifest/state commit, not a media file
  // replacement. Refreshing canvas node URLs with its result corrupts the visual
  // node into a broken image/manifest preview.
  return target.kind !== "scene_director_world";
}

export function shouldClearProjectionStatuses({
  canvasId,
  hydratedCanvasId,
  projectionKeyCount,
  project,
  hydratedProject,
}: {
  canvasId: string;
  hydratedCanvasId: string | null;
  projectionKeyCount: number;
  /** When omitted the project is not checked (legacy callers / single-canvas scenarios). */
  project?: string;
  hydratedProject?: string | null;
}): boolean {
  // Personal canvases share the same id across projects, so comparing canvasId alone cannot detect "still on the previous project's data".
  if (project !== undefined && hydratedProject !== project) return true;
  return hydratedCanvasId !== canvasId || projectionKeyCount === 0;
}

export function shouldFetchProjectionStatuses({
  canvasId,
  hydratedCanvasId,
  projectionKeyCount,
  revision,
  sessionExpired = false,
  syncStatus,
  project,
  hydratedProject,
}: {
  canvasId: string;
  hydratedCanvasId: string | null;
  projectionKeyCount: number;
  revision: number | null;
  sessionExpired?: boolean;
  syncStatus: CanvasSyncStatus;
  project?: string;
  hydratedProject?: string | null;
}): boolean {
  if (sessionExpired) return false;
  if (shouldClearProjectionStatuses({
    canvasId,
    hydratedCanvasId,
    projectionKeyCount,
    project,
    hydratedProject,
  })) {
    return false;
  }
  return syncStatus === "ready" && revision != null;
}

export function shouldSkipProjectionStatusRevision({
  canvasId,
  revision,
  refreshToken,
  lastChecked,
  project,
}: {
  canvasId: string;
  revision: number;
  refreshToken: number;
  lastChecked: {
    canvasId: string;
    revision: number;
    refreshToken: number;
    project?: string;
  } | null;
  project?: string;
}): boolean {
  if (lastChecked?.canvasId !== canvasId) return false;
  // revision is a small per-canvas integer, and collisions across projects are common; without comparing
  // the project, "the previous project already checked rev 5" would be mistaken for "this project's rev 5 was checked too", skipping the real pull.
  if (project !== undefined && lastChecked.project !== project) return false;
  return lastChecked.revision === revision && lastChecked.refreshToken === refreshToken;
}

function projectionKeysFromMetadata(metadata: Record<string, unknown> | null | undefined): string[] {
  const projections = metadata?.projections;
  if (!projections || typeof projections !== "object") return [];
  return Object.keys(projections).filter((key) => key.trim());
}

export function requestFromProjectionMetadata(
  metadata: Record<string, unknown> | null | undefined,
  projectionKey: string,
): Omit<FreezonePresetCanvasRequest, "canvas_id" | "overwrite_existing" | "base_revision"> | null {
  const projections = metadata?.projections;
  if (!projections || typeof projections !== "object") return null;
  const projection = (projections as Record<string, unknown>)[projectionKey];
  if (!projection || typeof projection !== "object") return null;
  const projectionRecord = projection as Record<string, unknown>;
  const request = projectionRecord.request && typeof projectionRecord.request === "object"
    ? projectionRecord.request as Record<string, unknown>
    : fallbackProjectionRequest(projectionRecord, projectionKey);
  if (!request) return null;
  const scope = (request as { scope?: unknown }).scope;
  if (scope !== "episode" && scope !== "beat" && scope !== "asset" && scope !== "blank") {
    return null;
  }
  return normalizePresetProjectionRequest({
    scope,
    episode: typeof (request as { episode?: unknown }).episode === "number"
      ? (request as { episode: number }).episode
      : undefined,
    beat: typeof (request as { beat?: unknown }).beat === "number"
      ? (request as { beat: number }).beat
      : undefined,
    primary_slot: typeof (request as { primary_slot?: unknown }).primary_slot === "string"
      ? (request as { primary_slot: string }).primary_slot
      : undefined,
    asset_kind: typeof (request as { asset_kind?: unknown }).asset_kind === "string"
      ? (request as { asset_kind: string }).asset_kind
      : undefined,
    character: typeof (request as { character?: unknown }).character === "string"
      ? (request as { character: string }).character
      : undefined,
    identity_id: typeof (request as { identity_id?: unknown }).identity_id === "string"
      ? (request as { identity_id: string }).identity_id
      : undefined,
    asset_id: typeof (request as { asset_id?: unknown }).asset_id === "string"
      ? (request as { asset_id: string }).asset_id
      : undefined,
  });
}

function fallbackProjectionRequest(
  projection: Record<string, unknown>,
  projectionKey: string,
): Record<string, unknown> | null {
  const scope = typeof projection.scope === "string"
    ? projection.scope
    : scopeFromProjectionKey(projectionKey);
  if (scope === "beat") {
    const parsed = parseBeatProjectionKey(projectionKey);
    return {
      scope,
      episode: numberOrUndefined(projection.episode) ?? parsed?.episode,
      beat: numberOrUndefined(projection.beat) ?? parsed?.beat,
      primary_slot: typeof projection.primary_slot === "string"
        ? projection.primary_slot
        : "render",
    };
  }
  if (scope === "episode") {
    return {
      scope,
      episode: numberOrUndefined(projection.episode) ?? parseEpisodeProjectionKey(projectionKey),
    };
  }
  if (scope === "asset") {
    const parsed = parseAssetProjectionKey(projectionKey);
    return {
      scope,
      asset_kind: stringOrUndefined(projection.asset_kind) ?? parsed?.asset_kind,
      asset_id: stringOrUndefined(projection.asset_id) ?? parsed?.asset_id,
      character: stringOrUndefined(projection.character),
      identity_id: stringOrUndefined(projection.identity_id),
    };
  }
  if (scope === "blank") {
    return { scope };
  }
  return null;
}

function scopeFromProjectionKey(projectionKey: string): string | null {
  if (projectionKey.startsWith("beat:")) return "beat";
  if (projectionKey.startsWith("episode:")) return "episode";
  if (projectionKey.startsWith("asset:")) return "asset";
  if (projectionKey.startsWith("blank:")) return "blank";
  return null;
}

function parseBeatProjectionKey(projectionKey: string): { episode: number; beat: number } | null {
  const [, episodeRaw, beatRaw] = projectionKey.split(":");
  const episode = Number(episodeRaw);
  const beat = Number(beatRaw);
  if (!Number.isFinite(episode) || !Number.isFinite(beat)) return null;
  return { episode, beat };
}

function parseEpisodeProjectionKey(projectionKey: string): number | undefined {
  const [, episodeRaw] = projectionKey.split(":");
  const episode = Number(episodeRaw);
  return Number.isFinite(episode) ? episode : undefined;
}

function parseAssetProjectionKey(
  projectionKey: string,
): { asset_kind: string; asset_id: string } | null {
  const [, assetKind, ...assetParts] = projectionKey.split(":");
  const assetId = assetParts.join(":");
  if (!assetKind || !assetId) return null;
  return { asset_kind: assetKind, asset_id: assetId };
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Mounts the shared xyflow canvas inside the SuperTale Beat Workbench shell.
 * Canvas switching lives inside the left AssetLibraryPanel (Mainline Assets / Canvas tabs).
 * Commit still lives on eligible canvas nodes. Sync status is
 * intentionally not shown — `useCanvasSync` still loads + persists via
 * /api/v1/projects/<project_id>/freezone/canvases and surfaces conflict /
 * error states via the overlays below; ready/saving states are silent.
 * The outer SPA sidebar already exposes project switching and the task center,
 * so this shell omits the back button, project picker, import/extract/
 * video-ref/3GS triggers, and the top-right Beat Workbench task entry.
 */
const canvasKey = (projectId: string, canvasId: string) => `${projectId}::${canvasId}`;
/** The canvas that was last actually drawn; kept across mounts to decide whether re-entry can reuse the store contents directly. */
let lastRenderedCanvasKey: string | null = null;

export function FreezoneShell({
  project,
  canvasId,
  active = true,
}: FreezoneShellProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const projectId = project.id;
  const [pushState, setPushState] = useState<PushPrompt | null>(null);
  const [comparePair, setComparePair] = useState<
    | {
        left: { url: string; label: string };
        right: { url: string; label: string };
      }
    | null
  >(null);
  const [createIdentitySource, setCreateIdentitySource] =
    useState<SelectedImageSummary | null>(null);
  const [maskTarget, setMaskTarget] = useState<{
    url: string;
    label: string;
  } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [assetLibraryReloadToken, setAssetLibraryReloadToken] = useState(0);
  const [assetPanelCollapsed, setAssetPanelCollapsed] = useState(true);
  const [debugPanelOpen, setDebugPanelOpen] = useState(false);
  const [chatOpen, setChatOpen] = useState(loadChatOpen);
  const [pendingChatAttachments, setPendingChatAttachments] = useState<ChatAttachment[]>([]);
  const [pendingChatNodeMentions, setPendingChatNodeMentions] = useState<string[]>([]);
  const deliveredSelectionAttachmentKeyRef = useRef<string | null>(null);
  const handlePendingChatAttachmentsConsumed = useCallback(() => {
    setPendingChatAttachments([]);
  }, []);
  const handlePendingChatNodeMentionsConsumed = useCallback(() => {
    setPendingChatNodeMentions([]);
  }, []);
  const [htmlTarget, setHtmlTarget] = useState<HtmlArtifactTarget | null>(null);
  useEffect(() => {
    const open = (event: Event) => {
      const target = (event as CustomEvent<HtmlArtifactTarget>).detail;
      if (!active || target?.projectId !== projectId || !target.artifactId) return;
      setHtmlTarget(target);
      setChatOpen(true);
    };
    const reference = (event: Event) => {
      if ((event as CustomEvent).detail?.projectId === projectId && active) setChatOpen(true);
    };
    const updated = (event: Event) => {
      const value = (event as CustomEvent).detail;
      if (!active || value?.projectId !== projectId || !value.artifact) return;
      const store = useCanvasStore.getState();
      for (const patch of htmlArtifactNodePatches(store.nodes, value.artifact)) {
        if (!value.nodeId || patch.id === value.nodeId) store.updateNodeData(patch.id, patch.data);
      }
    };
    window.addEventListener(HTML_ARTIFACT_UPDATED_EVENT, updated);
    window.addEventListener(HTML_ARTIFACT_OPEN_EVENT, open);
    window.addEventListener(HTML_ARTIFACT_REFERENCE_EVENT, reference);
    return () => { window.removeEventListener(HTML_ARTIFACT_UPDATED_EVENT, updated); window.removeEventListener(HTML_ARTIFACT_OPEN_EVENT, open); window.removeEventListener(HTML_ARTIFACT_REFERENCE_EVENT, reference); };
  }, [projectId, active]);
  useEffect(() => { setHtmlTarget(null); }, [projectId, canvasId]);

  const productSurfaces = useProductSurfaces();
  const showChatDock = Boolean(
    surfaceAccess(productSurfaces.data, "freezone_assistant")?.available,
  );
  // Re-entrancy guard for in-flight projection sync/remove lives in the refs;
  // there is no UI bound to a syncing/removing value, so no state is kept.
  const syncingProjectionRef = useRef<string | null>(null);
  const removingProjectionRef = useRef<string | null>(null);
  const emittedExternalCanvasCommandKeysRef = useRef<Set<string>>(new Set());
  // Switching the top bar between "Canvas" and "Market" unmounts then remounts this component, but the canvas data
  // stays in the global store. Starting from false here would first replace the view with "Loading canvas...",
  // and only redraw after hydrate returns - which looks janky. Re-entering the same canvas renders the existing
  // store content directly, with only a light overlay during hydrate.
  //
  // What is stored is "which canvas was already drawn" rather than a boolean: this component has no key, so switching
  // canvases reruns the effect on the same instance; with a boolean, once true it would never go back, and the old
  // canvas's hundreds of nodes would stay on screen (under a translucent mask) until the new content replaces them -
  // unmounting the old and mounting the new in one commit is the main cause of switch jank. Recording per canvas
  // returns to the full-screen loading immediately on the switching frame, splitting unmount and mount into two commits.
  const currentCanvasKey = canvasKey(projectId, canvasId);
  const [renderedCanvasKey, setRenderedCanvasKey] = useState<string | null>(() =>
    lastRenderedCanvasKey === currentCanvasKey &&
    useCanvasStore.getState().nodes.length > 0
      ? currentCanvasKey
      : null,
  );
  if (renderedCanvasKey !== null && renderedCanvasKey !== currentCanvasKey) {
    // Setting same-component state during render is the React-sanctioned "derived state" pattern; it takes effect in this commit.
    setRenderedCanvasKey(null);
  }
  const hasRenderedCanvas = renderedCanvasKey === currentCanvasKey;
  const [projectionStatusRefreshToken, setProjectionStatusRefreshToken] = useState(0);
  const [projectionMonitoringExpired, setProjectionMonitoringExpired] = useState(false);
  const lastProjectionStatusRevisionRef = useRef<{
    canvasId: string;
    revision: number;
    refreshToken: number;
    project: string;
  } | null>(null);
  // These three projection states used to reset because switching projects always remounted; since _app.tsx
  // removed the project id from routeTransitionKey, freezone no longer remounts, so it resets itself per project + canvas.
  const [projectionScopeKey, setProjectionScopeKey] = useState(currentCanvasKey);
  if (projectionScopeKey !== currentCanvasKey) {
    setProjectionScopeKey(currentCanvasKey);
    setProjectionStatusRefreshToken(0);
    setProjectionMonitoringExpired(false);
    lastProjectionStatusRevisionRef.current = null;
  }
  // The dialog/overlay states above hold "some asset of project A" and also relied on remounting to reset. Without
  // remounting, if a commit / create-identity / mask panel is open and browser back/forward switches to project B,
  // the panel keeps showing A's asset while the commit button gets the new projectId - writing A's resource into B.
  // So always close them on a project change; a canvas change leaves them alone (it never remounted, so behavior is unchanged).
  const [projectScopeId, setProjectScopeId] = useState(projectId);
  if (projectScopeId !== projectId) {
    setProjectScopeId(projectId);
    setPushState(null);
    setComparePair(null);
    setCreateIdentitySource(null);
    setMaskTarget(null);
    setToast(null);
  }

  const [viewMode, setViewMode] = useFreezoneViewMode();
  // Lazy mount: AssetBoardView mounts the first time the storyboard is opened, then stays alive (visible toggles visibility).
  const [boardMounted, setBoardMounted] = useState(viewMode === "board");
  const handleViewModeChange = useCallback(
    (mode: FreezoneViewMode) => {
      if (mode === "board") {
        setBoardMounted(true);
        // Entering the storyboard expands the assistant by default so the user can chat right against the assets.
        setChatOpen(true);
      }
      setViewMode(mode);
    },
    [setViewMode],
  );
  const handleLocateNode = useCallback(
    (nodeId: string) => {
      setViewMode("workflow");
      useCanvasStore.getState().requestFocusNode(nodeId);
    },
    [setViewMode],
  );

  const invalidateCommittedTargetQueries = useCallback((target: PushTarget) => {
    if (isDirectorWorldSourceSlotTarget(target) || target.kind === "scene_director_world") {
      queryClient.invalidateQueries({
        queryKey: queryKeys.sceneDirectorStageManifest(projectId, target.scene_id),
      });
      queryClient.invalidateQueries({ queryKey: queryKeys.scenes(projectId) });
      return;
    }
    if (isScenePushTargetKind(target.kind) && "scene_id" in target) {
      queryClient.invalidateQueries({ queryKey: queryKeys.scenes(projectId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.scene(projectId, target.scene_id) });
    }
  }, [projectId, queryClient]);
  const sync = useCanvasSync(projectId, canvasId);
  const canvasNodes = useCanvasStore((state) => state.nodes);
  const canvasEdges = useCanvasStore((state) => state.edges);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const syncRetryRef = useRef(sync.retry);
  useEffect(() => {
    syncRetryRef.current = sync.retry;
  }, [sync.retry]);
  const visibleSelectedCanvasNodes = useMemo(() => {
    const selectedNodes = canvasNodes.filter((node) => node.selected);
    return selectedNodes.length > 0
      ? selectedNodes
      : selectedNodeId
        ? canvasNodes.filter((node) => node.id === selectedNodeId)
        : [];
  }, [canvasNodes, selectedNodeId]);
  const chatReferenceCanvasNodes = useMemo(() => {
    if (visibleSelectedCanvasNodes.length === 0) return [];
    const selectedIds = new Set(visibleSelectedCanvasNodes.map((node) => node.id));
    const expandedIds = new Set(selectedIds);
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of canvasNodes) {
        if (!node.parentId || !expandedIds.has(node.parentId) || expandedIds.has(node.id)) continue;
        expandedIds.add(node.id);
        changed = true;
      }
    }
    return canvasNodes.filter((node) => expandedIds.has(node.id));
  }, [canvasNodes, visibleSelectedCanvasNodes]);
  const currentCanvasSelectionAttachmentKey = useMemo(
    () =>
      canvasSelectionAttachmentDeliveryKey(
        visibleSelectedCanvasNodes,
        chatReferenceCanvasNodes,
      ),
    [chatReferenceCanvasNodes, visibleSelectedCanvasNodes],
  );
  const currentCanvasSelection = useMemo<CurrentCanvasSelectionItem[]>(
    () =>
      visibleSelectedCanvasNodes.map((node) => ({
        nodeId: node.id,
        nodeType: node.type ?? null,
        label: resolveNodeDisplayName(node.type, node.data),
      })),
    [visibleSelectedCanvasNodes],
  );
  const currentCanvasSelectionAttachment = useMemo(
    () =>
      buildCanvasNodeReferenceAttachment(
        projectId,
        canvasId,
        chatReferenceCanvasNodes,
        canvasEdges,
        canvasNodes,
        { displayNodes: visibleSelectedCanvasNodes },
      ),
    [canvasEdges, canvasId, canvasNodes, chatReferenceCanvasNodes, projectId, visibleSelectedCanvasNodes],
  );
  const attachCurrentSelectionToChat = useCallback(() => {
    if (!currentCanvasSelectionAttachment || !currentCanvasSelectionAttachmentKey) {
      return false;
    }
    deliveredSelectionAttachmentKeyRef.current = currentCanvasSelectionAttachmentKey;
    setPendingChatAttachments([currentCanvasSelectionAttachment]);
    return true;
  }, [currentCanvasSelectionAttachment, currentCanvasSelectionAttachmentKey]);
  const handleChatOpenChange = useCallback(
    (nextOpen: boolean) => {
      if (nextOpen) {
        attachCurrentSelectionToChat();
      }
      setChatOpen(nextOpen);
    },
    [attachCurrentSelectionToChat],
  );
  const currentCanvasOntologyContext = useMemo(
    () =>
      buildCanvasOntologyContext(canvasNodes, canvasEdges, {
        canvasId,
        selectedNodeIds: chatReferenceCanvasNodes.map((node) => node.id),
      }),
    [canvasEdges, canvasId, canvasNodes, chatReferenceCanvasNodes],
  );
  useEffect(() => {
    if (
      !chatOpen ||
      !currentCanvasSelectionAttachment ||
      !currentCanvasSelectionAttachmentKey
    ) {
      deliveredSelectionAttachmentKeyRef.current = null;
      return;
    }
    // React Flow updates node geometry repeatedly while a large approved graph
    // mounts. The attachment payload includes positions, so rebuilding it on
    // every measurement used to make this effect publish again while
    // SuperChatPanel consumed the previous value. Parent and child then kept
    // setting state until React raised "Maximum update depth exceeded".
    // Delivery identity follows the semantic selection/topology instead of
    // transient node geometry.
    if (
      deliveredSelectionAttachmentKeyRef.current === currentCanvasSelectionAttachmentKey
    ) {
      return;
    }
    deliveredSelectionAttachmentKeyRef.current = currentCanvasSelectionAttachmentKey;
    setPendingChatAttachments([currentCanvasSelectionAttachment]);
  }, [chatOpen, currentCanvasSelectionAttachment, currentCanvasSelectionAttachmentKey]);
  // Persist the open/closed state: restored via useState(loadChatOpen) after refresh or re-entering the canvas.
  // All toggle paths (manual button, command auto-expand, blank click) go through chatOpen, so one effect covers them.
  useEffect(() => {
    storeChatOpen(chatOpen);
  }, [chatOpen]);

  useEffect(() => {
    if (!showChatDock) {
      setChatOpen(false);
    }
  }, [showChatDock]);

  const handleBlankPaneClick = useCallback(() => {
    setAssetPanelCollapsed(true);
    setDebugPanelOpen(false);
    // Clicking the blank canvas no longer auto-closes the canvas agent: it can only be closed manually via the
    // panel's top-right close button (onOpenChange(false)), so a stray click mid-workflow does not drop the conversation.
  }, []);

  useEffect(() => {
    prefetchFreezoneImageModels(projectId);
    prefetchFreezoneVideoModels(projectId);
    prefetchFreezoneCameraOptions(projectId);
    prefetchFreezoneStyleTemplates(projectId);
    prefetchFreezoneVideoCameraTemplates(projectId);
  }, [projectId]);

  // `active` is in the dependencies because the address bar's ?canvas= disappears with the route when leaving the canvas,
  // and with keep-alive canvasId / projectId stay pinned - this effect would not rerun on switching back, leaving a
  // canvas on screen with a bare /freezone address bar, and copied links could not open this canvas.
  // Skip when inactive: the address bar then belongs to the Market.
  useEffect(() => {
    if (!active) return;
    rememberLastCanvas(projectId, canvasId);
    if (canvasId !== "default" && currentCanvasParam() !== canvasId) {
      writeUrl({ canvas: canvasId }, { replace: true, notify: false });
    }
  }, [active, canvasId, projectId]);

  useEffect(() => {
    // Must compare hydratedProject too: personal canvas ids derive from the username, so the same canvasId spans
    // projects, and in the commit that switches project sync.* still holds the previous project's values (the
    // useCanvasSync hydrate effect only "queues" the status change to loading; the closure still reads ready).
    // Skipping this comparison treats a project switch as "the new canvas is already drawn", the full-screen loading
    // never appears, and the user sees the just-cleared canvas under a translucent mask.
    if (
      sync.status === "ready" &&
      sync.hydratedCanvasId === canvasId &&
      sync.hydratedProject === projectId
    ) {
      lastRenderedCanvasKey = canvasKey(projectId, canvasId);
      setRenderedCanvasKey(lastRenderedCanvasKey);
    }
  }, [canvasId, projectId, sync.hydratedCanvasId, sync.hydratedProject, sync.status]);

  useEffect(() => {
    if (!mcpDirectCanvasApplyEnabled()) return;
    // Do not poll while in Market: nobody is looking at the canvas during keep-alive, so no need to hold request quota.
    // `active` is in the dependencies, so switching back reruns this effect and the immediate call at the end also
    // covers "was the canvas modified elsewhere while away". This used to be guaranteed by a full remount triggering
    // hydrate; with keep-alive this is the only compensation point.
    if (!active) return;
    if (
      sync.status !== "ready" ||
      sync.hydratedCanvasId !== canvasId ||
      sync.revision == null
    ) {
      return;
    }
    let cancelled = false;
    let inFlight = false;
    const pollRemoteRevision = async () => {
      if (cancelled || inFlight || document.visibilityState === "hidden") return;
      inFlight = true;
      try {
        const response = await api
          .get(
            `api/v1/projects/${encodeURIComponent(projectId)}/freezone/canvases/${encodeURIComponent(canvasId)}/revision`,
          )
          .json<{ data?: { revision?: number } }>();
        const remoteRevision = response.data?.revision;
        if (
          !cancelled &&
          typeof remoteRevision === "number" &&
          sync.revision != null &&
          remoteRevision > sync.revision
        ) {
          syncRetryRef.current();
        }
      } catch {
        // Best effort: missing a poll is fine; the next tick or page refresh catches up.
      } finally {
        inFlight = false;
      }
    };
    const timer = window.setInterval(pollRemoteRevision, EXTERNAL_CANVAS_REVISION_POLL_MS);
    const handleFocus = () => {
      void pollRemoteRevision();
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") void pollRemoteRevision();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    void pollRemoteRevision();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [
    active,
    canvasId,
    projectId,
    sync.hydratedCanvasId,
    sync.revision,
    sync.status,
  ]);

  const projectionKeys = useMemo(
    () => projectionKeysFromMetadata(sync.metadata),
    [sync.metadata],
  );
  useEffect(() => {
    // Same as above: during keep-alive, stop the 30s projection-status refresh. It only keeps the beat (it issues no
    // request itself; it bumps a token and the effect below pulls), so the immediate catch-up on switching back is
    // handled by the dedicated "reactivate" effect - restarting the timer here only keeps later beats going.
    if (!active) return;
    if (projectionMonitoringExpired) return;
    if (!shouldFetchProjectionStatuses({
      canvasId,
      hydratedCanvasId: sync.hydratedCanvasId,
      projectionKeyCount: projectionKeys.length,
      revision: sync.revision,
      sessionExpired: projectionMonitoringExpired,
      syncStatus: sync.status,
      project: projectId,
      hydratedProject: sync.hydratedProject,
    })) {
      return;
    }
    const bump = () => setProjectionStatusRefreshToken((value) => value + 1);
    return startProjectionStatusRefresh(bump, () => {
      setProjectionMonitoringExpired(true);
    });
  }, [
    active,
    canvasId,
    projectId,
    projectionMonitoringExpired,
    projectionKeys.length,
    sync.hydratedCanvasId,
    sync.hydratedProject,
    sync.revision,
    sync.status,
  ]);
  // Refresh projection status when switching from Market back to Canvas. The fetch effect below dedups by
  // (canvasId, revision, refreshToken), so merely adding `active` to its dependencies would not refetch; bumping the
  // token is the signal it recognizes. Only trigger on the false -> true edge, to avoid an extra request on every dependency change.
  const wasActiveRef = useRef(active);
  useEffect(() => {
    const reactivated = active && !wasActiveRef.current;
    wasActiveRef.current = active;
    if (reactivated) {
      setProjectionStatusRefreshToken((value) => value + 1);
    }
  }, [active]);
  useEffect(() => {
    if (projectionMonitoringExpired) return;
    if (shouldClearProjectionStatuses({
      canvasId,
      hydratedCanvasId: sync.hydratedCanvasId,
      projectionKeyCount: projectionKeys.length,
      project: projectId,
      hydratedProject: sync.hydratedProject,
    })) {
      clearCanvasProjectionStatuses();
      return;
    }
    const revision = sync.revision;
    if (!shouldFetchProjectionStatuses({
      canvasId,
      hydratedCanvasId: sync.hydratedCanvasId,
      projectionKeyCount: projectionKeys.length,
      revision,
      sessionExpired: projectionMonitoringExpired,
      syncStatus: sync.status,
      project: projectId,
      hydratedProject: sync.hydratedProject,
    })) {
      return;
    }
    // shouldFetchProjectionStatuses already returns false when revision is null;
    // this redundant guard narrows the type for the non-null usages below.
    if (revision == null) {
      return;
    }
    if (shouldSkipProjectionStatusRevision({
      canvasId,
      revision,
      refreshToken: projectionStatusRefreshToken,
      lastChecked: lastProjectionStatusRevisionRef.current,
      project: projectId,
    })) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await getProjectionStatuses(projectId, canvasId, projectionKeys);
        if (!cancelled) {
          lastProjectionStatusRevisionRef.current = {
            canvasId,
            revision,
            refreshToken: projectionStatusRefreshToken,
            project: projectId,
          };
          setCanvasProjectionStatuses(result.projections);
        }
      } catch {
        if (!cancelled) {
          clearCanvasProjectionStatuses();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    canvasId,
    projectId,
    projectionMonitoringExpired,
    projectionKeys,
    projectionStatusRefreshToken,
    sync.hydratedCanvasId,
    sync.hydratedProject,
    sync.revision,
    sync.status,
  ]);

  const handleSyncProjection = useCallback(async (projectionKey: string) => {
    if (syncingProjectionRef.current) return;
    const request = requestFromProjectionMetadata(sync.metadata, projectionKey);
    if (!request) {
      setToast(t("freezone.projections.syncMissingRequest"));
      return;
    }
    syncingProjectionRef.current = projectionKey;
    try {
      const target = projectionTargetForCanvasPanel({ currentCanvasId: canvasId, request });
      const projection = await buildProjectionFromPreset(projectId, {
        ...request,
        projection_key: target.projectionKey,
        base_revision: 0,
        force_refresh: true,
      });
      queueLocalFreezoneProjection(projectId, target.targetCanvasId, {
        projectionKey: target.projectionKey,
        nodes: (projection.nodes ?? []) as CanvasNode[],
        edges: (projection.edges ?? []) as CanvasEdge[],
        metadata: projectionMetadataWithRequest(
          projection.metadata ?? null,
          target.projectionKey,
          request,
          projection.facts_signature,
        ),
      });
      consumeQueuedLocalFreezoneProjections(projectId, target.targetCanvasId);
      markCanvasProjectionFresh(target.projectionKey);
      setToast(t("freezone.projections.syncSuccess"));
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      syncingProjectionRef.current = null;
    }
  }, [canvasId, projectId, sync.metadata, t]);

  const handleRemoveProjection = useCallback(async (projectionKey: string) => {
    if (removingProjectionRef.current) return;
    removingProjectionRef.current = projectionKey;
    try {
      const removed = removeLocalFreezoneProjection(projectId, canvasId, projectionKey);
      if (!removed) {
        throw new Error(t("freezone.projections.removeBlocked"));
      }
      setToast(t("freezone.projections.removeSuccess"));
    } catch (error) {
      setToast(error instanceof Error ? error.message : String(error));
    } finally {
      removingProjectionRef.current = null;
    }
  }, [canvasId, projectId, sync, t]);

  // The Commit button on the node toolbar fires through canvasEventBus; subscribe here, look up the node,
  // and push CommitDialog. More lenient than AssetLibraryPanel's Commit: any node with an imageUrl may be committed,
  // slot_target is only a default for the dialog, and a missing one still lets the user pick a target manually.
  useEffect(() => {
    return canvasEventBus.subscribe("freezone/commit-node", ({ nodeId, auto, successMessage }) => {
      const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
      if (!node) {
        setToast(t("freezone.shell.nodeNoCommittable"));
        return;
      }
      // Generalized: no longer only imageUrl; infer the media url by node type (image/video/audio/3GS).
      const info = deriveNodeDropInfo(node);
      if (!info?.sourceUrl) {
        setToast(t("freezone.shell.nodeNoCommittable"));
        return;
      }
      const sourceUrl = info.sourceUrl;
      const data = (node.data ?? {}) as Record<string, unknown>;
      const preview =
        typeof data.previewImageUrl === "string" && data.previewImageUrl
          ? data.previewImageUrl
          : info.mediaType === "image"
            ? sourceUrl
            : null;
      const sourceMeta = data.__freezone_source as Record<string, unknown> | undefined;
      const defaultTarget =
        coerceSlotTarget(data.slot_target) ??
        coerceSlotTarget(data.capabilityDefaultPushTarget) ??
        assetToPushTarget(sourceMeta) ??
        undefined;
      if (!auto) {
        void (async () => {
          try {
            const savedOpenScene = await saveOpenDirectorWorldScene(nodeId);
            if (savedOpenScene) {
              const flushed = await sync.flush();
              if (!flushed) {
                throw new Error(t("freezone.shell.canvasSaveBlocked"));
              }
            }
            const latestNode = useCanvasStore.getState().nodes.find((candidate) => candidate.id === nodeId);
            if (!latestNode) {
              setToast(t("freezone.shell.nodeNoCommittable"));
              return;
            }
            const latestInfo = deriveNodeDropInfo(latestNode);
            if (!latestInfo?.sourceUrl) {
              setToast(t("freezone.shell.nodeNoCommittable"));
              return;
            }
            const latestData = (latestNode.data ?? {}) as Record<string, unknown>;
            const latestPreview =
              typeof latestData.previewImageUrl === "string" && latestData.previewImageUrl
                ? latestData.previewImageUrl
                : latestInfo.mediaType === "image"
                  ? latestInfo.sourceUrl
                  : null;
            const latestSourceMeta = latestData.__freezone_source as Record<string, unknown> | undefined;
            setPushState({
              nodeId,
              sourceUrl: latestInfo.sourceUrl,
              previewUrl: latestPreview,
              mediaType: latestInfo.mediaType,
              defaultTarget:
                coerceSlotTarget(latestData.slot_target) ??
                coerceSlotTarget(latestData.capabilityDefaultPushTarget) ??
                assetToPushTarget(latestSourceMeta) ??
                defaultTarget,
              sourceLabel: latestInfo.label,
              directorControlBundle: latestInfo.directorControlBundle,
              nodeData: latestData,
            });
          } catch (err) {
            setToast(err instanceof Error ? err.message : String(err));
          }
        })();
        return;
      }
      if (!defaultTarget) {
        setToast(t("freezone.shell.noAutoCommitTarget"));
        return;
      }
      void (async () => {
        setToast(t("freezone.shell.writingBackground"));
        try {
          const flushed = await sync.flush();
          if (!flushed) {
            throw new Error(t("freezone.shell.canvasSaveBlocked"));
          }
          const latestData = resolveSubmitNodeData(latestCanvasNodeData(nodeId), data) ?? data;
          const latestSourceUrl =
            info.mediaType === "model"
              ? modelSourceUrlFromNodeData(latestData) ?? sourceUrl
              : sourceUrl;
          const target = defaultTarget as PushTarget;
          const result = target.kind === "director_render"
            ? await commitDirectorRenderFromCanvasSource(projectId, target, {
                sourceUrl: latestSourceUrl,
                previewUrl: preview,
                bundle: info.directorControlBundle,
                sourceNodeId: nodeId,
                label: typeof latestData.displayName === "string" ? latestData.displayName : undefined,
              })
            : target.kind === "scene_director_world"
              ? await commitSceneDirectorWorldFromCanvasNode(projectId, target, latestData, t)
              : await promoteToAsset(projectId, latestSourceUrl, target, {
                mark_stale: false,
              });
          const nodeDataPatch = nodeDataPatchAfterCommittedTarget(latestData, target, result, projectId, t);
          if (nodeDataPatch) {
            useCanvasStore.getState().updateNodeData(nodeId, nodeDataPatch);
          }
          const manifestNodeData = nodeDataPatch && hasDirectorWorldSceneState(nodeDataPatch)
            ? nodeDataPatch
            : sceneDirectorWorldDataForManifest(latestData, target, result, projectId, t);
          if (manifestNodeData && isDirectorWorldSourceSlotTarget(target)) {
            await commitSceneDirectorWorldFromCanvasNode(projectId, {
              kind: "scene_director_world",
              scene_id: target.scene_id,
            }, manifestNodeData, t, { pruneStale: false });
          }
          refreshCommittedTargetNodes(target, result);
          invalidateCommittedTargetQueries(target);
          markCommitCandidatePushed(nodeId, target, result);
          setAssetLibraryReloadToken((token) => token + 1);
          setToast(
            successMessage ??
              `${renderCommitSuccessMessage(target, result, t)}${
                manifestNodeData ? t("freezone.commit.success.directorWorldSynced") : ""
              }`,
          );
          void sync.flush();
        } catch (err) {
          setToast(err instanceof Error ? err.message : String(err));
        }
      })();
    });
  }, [projectId, sync, t]);

  useEffect(() => {
    const unsubscribeSync = canvasEventBus.subscribe(
      "freezone/projection-sync",
      ({ projectionKey }) => {
        void handleSyncProjection(projectionKey);
      },
    );
    const unsubscribeRemove = canvasEventBus.subscribe(
      "freezone/projection-remove",
      ({ projectionKey }) => {
        void handleRemoveProjection(projectionKey);
      },
    );

    return () => {
      unsubscribeSync();
      unsubscribeRemove();
    };
  }, [handleRemoveProjection, handleSyncProjection]);

  useEffect(() => {
    return canvasEventBus.subscribe("freezone/assets-updated", () => {
      setAssetLibraryReloadToken((token) => token + 1);
    });
  }, []);

  // "Add to chat" from canvas nodes / storyboard cards / detail headers - both views are two projections of the same
  // node data, so the entry only emits an event and the landing is handled here (append an inline mention + expand chat),
  // avoiding behavior drift from two separate implementations. Same model as the @ menu: no canvas node selection and no
  // reference bar; an inline @[node name](id) chip is inserted into the assistant draft instead (drained in SuperChatPanel).
  // Filter out ids that no longer exist on the canvas: if all are ghosts, do not expand the chat.
  useEffect(() => {
    return canvasEventBus.subscribe("freezone/add-nodes-to-chat", ({ nodeIds }) => {
      const onCanvas = new Set(useCanvasStore.getState().nodes.map((node) => node.id));
      const valid = nodeIds.filter((id) => onCanvas.has(id));
      if (valid.length === 0) return;
      setPendingChatNodeMentions(valid);
      setChatOpen(true);
    });
  }, []);

  useEffect(() => {
    const handleCanvasCommand = (event: Event) => {
      const detail = (event as CustomEvent<{
        frame?: ServerFrame;
        anchorTextPrefix?: string | null;
        receivedAt?: number;
        externalMcpCommand?: boolean;
      }>).detail;
      const frame = detail?.frame;
      if (!frame || frame.type !== "canvas.command") return;
      const claim = claimExternalCanvasCommand(
        emittedExternalCanvasCommandKeysRef.current,
        frame,
        detail?.externalMcpCommand === true,
      );
      if (!claim.accepted) {
        if (claim.terminalReceipt) replayCanvasCommandToolResult(claim.terminalReceipt);
        return;
      }
      const isExternalMcpCommand = claim.externalMcpCommand;
      const turnId = typeof frame.turn_id === "string" ? frame.turn_id : null;
      const bridgeKey = claim.bridgeKey;
      const agentId =
        typeof frame.agent_id === "string"
          ? frame.agent_id
          : typeof frame.agentId === "string"
            ? frame.agentId
            : null;
      const eventReceivedAt = detail?.receivedAt ?? Date.now();
      const validationBridgeKey = bridgeKey
        ? `${bridgeKey}:validation`
        : `validation:${turnId ?? canvasId}:${eventReceivedAt}`;
      emitCanvasContextActivity({
        turnId,
        anchorTextPrefix: detail?.anchorTextPrefix ?? null,
        bridgeKey: validationBridgeKey,
        canvasId,
        agentId,
        status: "running",
        labels: [i18n.t("freezone.shell.commandValidation")],
        receivedAt: eventReceivedAt,
        surfaceOrder: eventReceivedAt,
        externalMcpCommand: isExternalMcpCommand,
      });
      const candidates = canvasCommandCandidatesFromFrame(frame);
      const envelopes = extractCanvasChatCommandEnvelopes(candidates)
        .filter((envelope) => canvasCommandEnvelopeMatchesCanvas(envelope, canvasId));

      console.info("[freezone-canvas-command] frame received", {
        bridgeKey,
        turnId,
        externalMcpCommand: isExternalMcpCommand,
        candidateCount: candidates.length,
        envelopeCount: envelopes.length,
      });

      if (envelopes.length === 0) {
        const errors = [
          "Canvas command format is invalid or does not belong to the current canvas; the frontend did not execute it.",
          "Unable to parse the canvas_chat_commands.v1 command; check that the command field is at the correct level.",
        ];
        console.warn("[freezone-canvas-command] frame rejected: no valid envelope", {
          bridgeKey,
          turnId,
          candidateCount: candidates.length,
        });
        emitCanvasContextActivity({
          turnId,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          bridgeKey: validationBridgeKey,
          canvasId,
          agentId,
          status: "failed",
          labels: [i18n.t("freezone.shell.commandValidation")],
          errors,
          receivedAt: eventReceivedAt + 1,
          surfaceOrder: eventReceivedAt + 1,
          externalMcpCommand: isExternalMcpCommand,
        });
        persistCanvasCommandValidationActivity({
          projectId,
          canvasId,
          turnId,
          bridgeKey: validationBridgeKey,
          ok: false,
          errors,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          receivedAt: eventReceivedAt + 1,
          externalMcpCommand: isExternalMcpCommand,
        });
        const result: CanvasChatCommandApplyResult = {
          applied: 0,
          openedUiActions: 0,
          createdNodeIds: [],
          errors,
          commandResults: [
            {
              commandIndex: -1,
              type: "validate",
              status: "error",
              label: i18n.t("freezone.shell.invalidCanvasCommand"),
              error: "Unable to parse the canvas_chat_commands.v1 command; check that the command field is at the correct level.",
            },
          ],
        };
        reportCanvasCommandToolResult({
          bridgeKey,
          turnId,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          projectId,
          canvasId,
          agentId,
          result,
        });
        persistCanvasCommandResult({
          projectId,
          canvasId,
          turnId,
          envelopes: [],
          result,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          receivedAt: detail?.receivedAt,
          bridgeKey,
        });
        window.dispatchEvent(new CustomEvent(FREEZONE_CANVAS_COMMAND_RESULT_EVENT, {
          detail: {
            canvasId,
            agentId,
            turnId,
            bridgeKey,
            anchorMessageId: null,
            envelopes: [],
            result,
            anchorTextPrefix: detail?.anchorTextPrefix ?? null,
            receivedAt: eventReceivedAt + 2,
          },
        }));
        if (!isExternalMcpCommand) setChatOpen(true);
        return;
      }

      const currentState = useCanvasStore.getState();
      const normalizedEnvelopes = normalizeCanvasChatCommandEnvelopesForValidation(
        envelopes,
        currentState.nodes.map((node) => node.id),
      );
      const validation = validateCanvasChatCommandEnvelopes(
        normalizedEnvelopes,
        currentState.nodes,
        currentState.edges,
      );
      if (!validation.ok) {
        const errors = [
          "Canvas command pre-validation failed; the frontend showed no confirmation card and did not execute it.",
          ...validation.issues.map((issue) => `${issue.path}: ${issue.message}`),
        ];
        console.warn("[freezone-canvas-command] validation failed", {
          bridgeKey,
          turnId,
          envelopeCount: normalizedEnvelopes.length,
          issueCount: validation.issues.length,
          issues: validation.issues.slice(0, 12).map((issue) => `${issue.path}: ${issue.message}`),
        });
        emitCanvasContextActivity({
          turnId,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          bridgeKey: validationBridgeKey,
          canvasId,
          agentId,
          status: "failed",
          labels: [i18n.t("freezone.shell.commandValidation")],
          errors,
          receivedAt: eventReceivedAt + 1,
          surfaceOrder: eventReceivedAt + 1,
          externalMcpCommand: isExternalMcpCommand,
        });
        persistCanvasCommandValidationActivity({
          projectId,
          canvasId,
          turnId,
          bridgeKey: validationBridgeKey,
          ok: false,
          errors,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          receivedAt: eventReceivedAt + 1,
          externalMcpCommand: isExternalMcpCommand,
        });
        const result = canvasCommandValidationFailureResult(errors);
        reportCanvasCommandToolResult({
          bridgeKey,
          turnId,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          projectId,
          canvasId,
          agentId,
          result,
        });
        persistCanvasCommandResult({
          projectId,
          canvasId,
          turnId,
          envelopes: normalizedEnvelopes,
          result,
          anchorTextPrefix: detail?.anchorTextPrefix ?? null,
          receivedAt: detail?.receivedAt,
          bridgeKey,
        });
        window.dispatchEvent(new CustomEvent(FREEZONE_CANVAS_COMMAND_RESULT_EVENT, {
          detail: {
            canvasId,
            agentId,
            turnId,
            bridgeKey,
            anchorMessageId: null,
            envelopes: normalizedEnvelopes,
            result,
            anchorTextPrefix: detail?.anchorTextPrefix ?? null,
            receivedAt: eventReceivedAt + 2,
          },
        }));
        if (!isExternalMcpCommand) setChatOpen(true);
        return;
      }

      emitCanvasContextActivity({
        turnId,
        anchorTextPrefix: detail?.anchorTextPrefix ?? null,
        bridgeKey: validationBridgeKey,
        canvasId,
        agentId,
        status: "done",
        labels: [i18n.t("freezone.shell.commandValidation")],
        receivedAt: eventReceivedAt + 1,
        surfaceOrder: eventReceivedAt + 1,
        externalMcpCommand: isExternalMcpCommand,
      });
      persistCanvasCommandValidationActivity({
        projectId,
        canvasId,
        turnId,
        bridgeKey: validationBridgeKey,
        ok: true,
        errors: [],
        anchorTextPrefix: detail?.anchorTextPrefix ?? null,
        receivedAt: eventReceivedAt + 1,
        externalMcpCommand: isExternalMcpCommand,
      });
      persistCanvasCommandApproval({
        projectId,
        canvasId,
        turnId,
        envelopes: normalizedEnvelopes,
        anchorTextPrefix: detail?.anchorTextPrefix ?? null,
        receivedAt: eventReceivedAt + 2,
        bridgeKey,
        externalMcpCommand: isExternalMcpCommand,
      });
      console.info("[freezone-canvas-command] approval emitted", {
        bridgeKey,
        turnId,
        envelopeCount: normalizedEnvelopes.length,
        commandCount: normalizedEnvelopes.reduce((sum, envelope) => sum + envelope.commands.length, 0),
        externalMcpCommand: isExternalMcpCommand,
      });
      setChatOpen(true);
      window.setTimeout(() => emitCanvasCommandApproval({
        canvasId,
        agentId,
        turnId,
        anchorMessageId: null,
        anchorTextPrefix: detail?.anchorTextPrefix ?? null,
        bridgeKey,
        envelopes: normalizedEnvelopes,
        receivedAt: eventReceivedAt + 2,
        externalMcpCommand: isExternalMcpCommand,
      }), 0);
    };

    window.addEventListener(SUPERCHAT_CANVAS_COMMAND_EVENT, handleCanvasCommand);
    return () => {
      window.removeEventListener(SUPERCHAT_CANVAS_COMMAND_EVENT, handleCanvasCommand);
    };
  }, [canvasId, projectId]);

  useEffect(() => {
    emittedExternalCanvasCommandKeysRef.current.clear();
  }, [canvasId, projectId]);

  useEffect(() => {
    let cancelled = false;
    let timer: number | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const seenKeys = confirmedExternalCanvasCommandKeys(
          emittedExternalCanvasCommandKeysRef.current,
        ).slice(-200);
        const agentIds = loadFreezoneCanvasAgentsWithSource(projectId, canvasId).state.agents
          .map((agent) => agent.id);
        const frames = await listPendingCanvasCommandFrames({
          projectId,
          canvasId,
          agentIds,
          seenKeys,
        });
        if (frames.length > 0) {
          console.info("[freezone-canvas-command] pending frames polled", {
            count: frames.length,
            bridgeKeys: frames
              .map((frame) => {
                const record = frame as Record<string, unknown>;
                return typeof record.bridge_key === "string" ? record.bridge_key : null;
              })
              .filter((key): key is string => Boolean(key)),
          });
        }
        const now = Date.now();
        frames.forEach((frame, index) => {
          const frameRecord = frame as Record<string, unknown>;
          const bridgeKey =
            typeof frameRecord.bridge_key === "string"
              ? frameRecord.bridge_key
              : typeof frameRecord.bridgeKey === "string"
                ? frameRecord.bridgeKey
                : null;
          if (!bridgeKey) return;
          window.dispatchEvent(new CustomEvent(SUPERCHAT_CANVAS_COMMAND_EVENT, {
            detail: {
              frame,
              anchorTextPrefix: i18n.t("freezone.shell.externalAgent"),
              receivedAt: now + index,
              externalMcpCommand: true,
            },
          }));
        });
      } catch {
        // The page can be open before auth/API is ready. Retry quietly.
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(tick, EXTERNAL_CANVAS_COMMAND_POLL_MS);
        }
      }
    };

    timer = window.setTimeout(tick, EXTERNAL_CANVAS_COMMAND_POLL_MS);
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [canvasId, projectId]);

  useEffect(() => {
    const handleCanvasContextRequest = (event: Event) => {
      const detail = (event as CustomEvent<Record<string, unknown>>).detail;
      if (!detail) return;
      const requestedCanvasId =
        typeof detail.canvas_id === "string"
          ? detail.canvas_id
          : typeof detail.canvasId === "string"
            ? detail.canvasId
            : null;
      if (requestedCanvasId && requestedCanvasId !== canvasId) return;

      const bridgeKey = typeof detail.bridge_key === "string" ? detail.bridge_key : null;
      const agentId =
        typeof detail.agent_id === "string"
          ? detail.agent_id
          : typeof detail.agentId === "string"
            ? detail.agentId
            : null;
      const turnId = typeof detail.turn_id === "string" ? detail.turn_id : null;
      const anchorTextPrefix =
        typeof detail.anchorTextPrefix === "string"
          ? detail.anchorTextPrefix
          : typeof detail.anchor_text_prefix === "string"
            ? detail.anchor_text_prefix
            : null;
      const envelopes = extractCanvasContextRequestEnvelopes(
        canvasContextRequestCandidatesFromDetail(detail),
      );
      if (envelopes.length === 0) {
        reportCanvasContextToolResult({
          bridgeKey,
          turnId,
          anchorTextPrefix,
          projectId,
          canvasId,
          agentId,
          responses: [],
          errors: ["Unable to parse the canvas_context_request.v1 request."],
        });
        setChatOpen(true);
        return;
      }

      void (async () => {
        const currentState = useCanvasStore.getState();
        const selectedNodeIds = currentState.nodes
          .filter((node) => node.selected || currentState.selectedNodeId === node.id)
          .map((node) => node.id);
        try {
          const responses = await buildCanvasContextRequestResponses({
            project: projectId,
            canvasId,
            nodes: currentState.nodes,
            edges: currentState.edges,
            ontologyContext: buildCanvasOntologyContext(currentState.nodes, currentState.edges, {
              canvasId,
              selectedNodeIds,
            }),
            selectedNodeIds,
            envelopes,
            canvasMetadata: sync.metadata as Record<string, unknown> | null,
            loadMainlineProjectionAssets: () => loadMainlineProjectionAssets(projectId),
          });
          reportCanvasContextToolResult({
            bridgeKey,
            turnId,
            anchorTextPrefix,
            projectId,
            canvasId,
            agentId,
            responses: responses ?? [],
            errors: [],
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error || "unknown error");
          const errors = [`Failed to read canvas context: ${message}`];
          emitCanvasContextActivity({
            turnId,
            anchorTextPrefix,
            bridgeKey: bridgeKey ?? `context:${turnId ?? canvasId}:${Date.now()}`,
            canvasId,
            agentId,
            status: "failed",
            labels: [i18n.t("freezone.shell.canvasContext")],
            errors,
            receivedAt: Date.now(),
          });
          reportCanvasContextToolResult({
            bridgeKey,
            turnId,
            anchorTextPrefix,
            projectId,
            canvasId,
            agentId,
            responses: [],
            errors,
          });
        } finally {
          setChatOpen(true);
        }
      })();
    };

    window.addEventListener(SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT, handleCanvasContextRequest);
    return () => {
      window.removeEventListener(SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT, handleCanvasContextRequest);
    };
  }, [canvasId, projectId, sync.metadata]);

  const canvasDefaultTarget = normalizePushTarget(
    (sync.metadata?.default_push_target ?? null) as
      | (Partial<PushTarget> & { kind?: PushTargetKind })
      | null,
  );
  const presetDefaultCharacter =
    defaultCharacterFromMetadata(sync.metadata) ??
    (
      canvasDefaultTarget?.kind === "identity" ||
      canvasDefaultTarget?.kind === "identity_costume" ||
      canvasDefaultTarget?.kind === "identity_portrait" ||
      canvasDefaultTarget?.kind === "portrait"
        ? canvasDefaultTarget.character
        : null
    );

  const handleMaskEditResult = async (newUrl: string) => {
    const { CANVAS_NODE_TYPES, DEFAULT_NODE_WIDTH } = await import(
      "@/features/canvas/domain/canvasNodes"
    );
    const addNode = useCanvasStore.getState().addNode;
    const baseLabel = maskTarget?.label ?? "edit";
    addNode(
      CANVAS_NODE_TYPES.upload,
      { x: 100, y: 1100 },
      {
        displayName: `${baseLabel} (mask)`,
        imageUrl: newUrl,
        previewImageUrl: newUrl,
        aspectRatio: "1:1",
        sourceFileName: `${baseLabel}-mask`,
      } as Record<string, unknown>,
    );
    setToast(t("freezone.shell.maskEditDone"));
    void DEFAULT_NODE_WIDTH; // unused but keep import alive
  };

  // Do not decide by status === "loading": on the frame the canvas switches, status is still the old canvas's "ready",
  // and only flips to loading after the hydrate effect runs, exposing the old canvas for one frame. Block whenever the
  // current canvas has not been drawn yet, except in failed states - those two overlays must stay visible and clickable.
  const showBlockingLoading =
    !hasRenderedCanvas && sync.status !== "error" && sync.status !== "conflict";
  const showLoadingOverlay = sync.status === "loading" && hasRenderedCanvas;

  return (
    <div className="relative w-full h-full flex flex-col overflow-hidden">
      <div className="relative flex flex-1 min-h-0">
        <main className="relative h-full min-w-0 flex-1">
          {showBlockingLoading ? (
            <CanvasLoadingScreen />
          ) : (
            <Canvas
              projectId={projectId}
              canvasId={canvasId}
              onBlankPaneClick={handleBlankPaneClick}
              controlsPlacement="bottom-right"
              // Keep-alive in Market also counts as suspended: Canvas's 6 window/document keyboard listeners (including the
              // capture phase) all read this switch; otherwise typing in a Market input would be intercepted by canvas shortcuts.
              suspended={!active || viewMode === "board" || Boolean(htmlTarget)}
            />
          )}
          {showLoadingOverlay && <CanvasLoadingOverlay />}
          {sync.status === "error" && (
            <CanvasErrorOverlay error={sync.error} onRetry={sync.retry} />
          )}
          {sync.status === "conflict" && (
            <CanvasConflictOverlay
              error={sync.error}
              canvasId={canvasId}
              onRefresh={sync.retry}
              onSaveCopy={async () => {
                const copyCanvasId = await sync.saveCopy();
                setAssetLibraryReloadToken((token) => token + 1);
                writeUrl({ canvas: copyCanvasId });
              }}
              readConflictSnapshot={sync.readConflictSnapshot}
            />
          )}
          <BackupStatusIndicator status={sync.backupStatus} />
          {active && sync.status === "ready" && sync.hydratedCanvasId === canvasId && (
            // Has its own 15s polling; not mounted during keep-alive.
            <WorkflowRunRecoveryBar projectId={projectId} canvasId={canvasId} />
          )}
          {/* Debug panel temporarily hidden; remove `false &&` to restore */}
          {false && import.meta.env.DEV && (
            <CanvasDebugPanel
              project={projectId}
              canvasId={canvasId}
              open={debugPanelOpen}
              onOpenChange={setDebugPanelOpen}
              placement="top-right"
              status={sync.status}
              backupStatus={sync.backupStatus}
              error={sync.error}
              onRehydrate={sync.retry}
            />
          )}
          <AssetLibraryPanel
            project={projectId}
            metadata={sync.metadata}
            collapsed={assetPanelCollapsed}
            onCollapsedChange={setAssetPanelCollapsed}
            currentCanvasId={canvasId}
            reloadToken={assetLibraryReloadToken}
            onRestoreMainlineDefault={async () => {
              try {
                await sync.restoreMainlineDefault();
                setToast(t("freezone.shell.mainlineRestored"));
              } catch (err) {
                setToast(err instanceof Error ? err.message : String(err));
              }
            }}
            onReplaced={(payload, message) => {
              if (payload) {
                refreshCommittedTargetNodes(payload.target, payload.result);
                setAssetLibraryReloadToken((token) => token + 1);
              }
              setToast(message);
            }}
          />
          {/* Storyboard view: lazy mount + keep-alive (switches instantly while preserving scroll/filter state). */}
          {!showBlockingLoading && boardMounted && (
            <AssetBoardView
              // Must pass active: the storyboard keep-alive uses `visibility: visible`
              // (AssetBoardView.tsx:435), which pierces the host container's invisible -
              // without this switch, switching to Market from the storyboard view would float it over the Market page.
              // It also stops its subscription to the canvas store and media playback (paused={!visible}).
              visible={active && viewMode === "board" && !htmlTarget}
              onLocateNode={handleLocateNode}
            />
          )}
          {/* Workflow/Storyboard toggle: floats top-left, above the storyboard overlay (z-30).
              Icons only, no text - the earlier two 88px-wide text capsules hovered right over the canvas and covered
              the center strip; the labels are now given by hover tooltip and read by screen readers via
              aria-label. The tooltip uses shadcn Tooltip rather than native title: native needs about a second of hover to appear
              and its style differs from other product tooltips (same trade-off as AddNodeToChatButton).

                  left-4: aligns with the storyboard content's px-4 left padding so the toggle does not jump between views;
                  in workflow mode the side asset drawer's handle/cards have moved down to clear this top strip (AssetLibraryPanel).
                  The selected-state style still matches the header's Canvas/Market product switch (project-header-navigation.tsx
                  ProjectHeaderNavigation): hand-drawn capsule + slider, slider width shrinks to 44px with the buttons.
                  The container background keeps the hard-coded #262626 (same as the storyboard background), with 10px rounded corners. */}
          {!showBlockingLoading && !htmlTarget && (
            <div className="absolute left-4 top-1.5 z-40">
              <TooltipProvider delay={80}>
                <nav
                  aria-label={t("freezone.shell.viewSwitch")}
                  className="relative flex h-8 items-center rounded-[10px] bg-[#262626] p-0.5 shadow-lg"
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "absolute left-0.5 top-1/2 h-7 w-11 -translate-y-1/2 rounded-[8px] bg-foreground transition-transform duration-300 ease-[var(--ease-out-quint)]",
                      viewMode === "board" && "translate-x-11",
                    )}
                  />
                  {getFreezoneViewModeTabs(t).map(({ mode, icon: Icon, label }) => (
                    <Tooltip key={mode}>
                      <TooltipTrigger
                        render={
                          <button
                            type="button"
                            data-testid={`freezone-view-${mode}`}
                            onClick={() => handleViewModeChange(mode)}
                            aria-label={label}
                            aria-pressed={viewMode === mode}
                            className={cn(
                              // w-11: icon-only does not mean squeezing into a 28px square - wider keys are easier to hit
                              // and look more like a segmented control (user feedback: "the capsule width should be wider").
                              "relative z-10 inline-flex h-7 w-11 items-center justify-center rounded-[8px] transition-colors",
                              viewMode === mode
                                ? "text-background"
                                : "text-muted-foreground hover:text-foreground",
                            )}
                          />
                        }
                      >
                        <Icon className="size-4" />
                      </TooltipTrigger>
                      {/* side=bottom: the toggle sits against the content's top edge; a tooltip pointing up would be covered by the top bar. */}
                      <TooltipContent side="bottom">{label}</TooltipContent>
                    </Tooltip>
                  ))}
                </nav>
              </TooltipProvider>
            </div>
          )}
          {htmlTarget && active && <HtmlArtifactEditor key={htmlTarget.artifactId} {...htmlTarget} onClose={() => setHtmlTarget(null)} />}
        </main>
        {showChatDock && (
          <FreezoneChatDock
            projectId={projectId}
            canvasId={canvasId}
            currentCanvasMetadata={sync.metadata}
            currentCanvasSelection={currentCanvasSelection}
            currentCanvasOntologyContext={currentCanvasOntologyContext}
            pendingAttachments={pendingChatAttachments}
            onPendingAttachmentsConsumed={handlePendingChatAttachmentsConsumed}
            pendingNodeMentions={pendingChatNodeMentions}
            onPendingNodeMentionsConsumed={handlePendingChatNodeMentionsConsumed}
            open={chatOpen}
            onOpenChange={handleChatOpenChange}
            // The drawer broadcasts --freezone-dock-width on <html>; the top bar / task status bar / task panel shrink left
            // accordingly. Leaving the canvas used to unmount everything and effect cleanup removed the variable; with keep-alive
            // nothing unmounts, so the Market top bar would keep the assistant drawer's yield (top bar squeezed narrow, the
            // Canvas/Market switch and the top-right entries shifted left). So when inactive, broadcast as "drawer not open".
            hostActive={active}
            // Storyboard: the drawer squeezes the left content width; workflow: it floats over the canvas and the canvas
            // viewport is unaffected (otherwise every chat open/close would make ReactFlow re-layout the viewport).
            pushesContent={viewMode === "board" || Boolean(htmlTarget)}
            title={t("freezone.chat.title")}
            description={t("freezone.chat.description")}
            toggleLabel={t("freezone.chat.toggle")}
          />
        )}
      </div>
      <NodeReplaceDragPreview />
      {pushState && (
        <CommitDialog
          project={projectId}
          sourceUrl={pushState.sourceUrl}
          previewUrl={pushState.previewUrl ?? undefined}
          sourceLabelOverride={pushState.sourceLabel}
          mediaType={pushState.mediaType}
          defaultTarget={pushState.defaultTarget}
          directorControlBundle={pushState.directorControlBundle}
          nodeData={pushState.nodeData}
          getNodeData={() => resolveSubmitNodeData(latestCanvasNodeData(pushState.nodeId), pushState.nodeData)}
          onClose={() => setPushState(null)}
          onSuccess={(msg, result, target, nodeDataPatch) => {
            if (nodeDataPatch) {
              useCanvasStore.getState().updateNodeData(pushState.nodeId, nodeDataPatch);
            }
            refreshCommittedTargetNodes(target, result);
            invalidateCommittedTargetQueries(target);
            markCommitCandidatePushed(pushState.nodeId, target, result);
            setAssetLibraryReloadToken((token) => token + 1);
            setPushState(null);
            setToast(msg);
          }}
        />
      )}
      {createIdentitySource && (
        <CreateIdentityDialog
          project={projectId}
          sourceUrl={createIdentitySource.imageUrl}
          previewUrl={createIdentitySource.previewUrl ?? undefined}
          defaultCharacter={presetDefaultCharacter}
          onClose={() => setCreateIdentitySource(null)}
          onSuccess={(msg) => {
            setCreateIdentitySource(null);
            setToast(msg);
          }}
        />
      )}
      {comparePair && (
        <CompareDialog
          left={comparePair.left}
          right={comparePair.right}
          onClose={() => setComparePair(null)}
        />
      )}
      {maskTarget && (
        <MaskEditor
          project={projectId}
          baseUrl={maskTarget.url}
          baseLabel={maskTarget.label}
          onClose={() => setMaskTarget(null)}
          onResult={handleMaskEditResult}
        />
      )}
      {toast && <Toast text={toast} onClose={() => setToast(null)} />}
    </div>
  );
}

function FreezoneChatDock({
  projectId,
  canvasId,
  currentCanvasMetadata,
  currentCanvasSelection,
  currentCanvasOntologyContext,
  pendingAttachments,
  onPendingAttachmentsConsumed,
  pendingNodeMentions,
  onPendingNodeMentionsConsumed,
  open,
  onOpenChange,
  pushesContent,
  title,
  description,
  toggleLabel,
  hostActive,
}: {
  projectId: string;
  canvasId: string;
  currentCanvasMetadata: Record<string, unknown> | null;
  currentCanvasSelection: CurrentCanvasSelectionItem[];
  currentCanvasOntologyContext: CanvasOntologyContext;
  pendingAttachments: ChatAttachment[];
  onPendingAttachmentsConsumed: () => void;
  pendingNodeMentions: string[];
  onPendingNodeMentionsConsumed: () => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** true = the drawer takes space in the flex row (left content is squeezed); false = pure overlay, left content stays put. */
  pushesContent: boolean;
  title: string;
  description: string;
  toggleLabel: string;
  /** Whether the canvas is in the foreground. When false the drawer stops broadcasting the yield width globally (see the effect below). */
  hostActive: boolean;
}) {
  const { t } = useTranslation();
  const isDesktop = useMediaQuery("(min-width: 1024px)");
  const [shouldRenderPanel, setShouldRenderPanel] = useState(open);
  const [panelVisible, setPanelVisible] = useState(open);
  const [agentHistoryOpen, setAgentHistoryOpen] = useState(false);
  const [agentSearch, setAgentSearch] = useState("");
  const [chatWidth, setChatWidth] = useState(() =>
    loadStoredPanelWidth(
      FREEZONE_CHAT_WIDTH_STORAGE_KEY,
      FREEZONE_CHAT_WIDTH_DEFAULT,
      FREEZONE_CHAT_WIDTH_MIN,
      FREEZONE_CHAT_WIDTH_MAX,
    ),
  );
  const [agentHistoryWidth, setAgentHistoryWidth] = useState(() =>
    loadStoredPanelWidth(
      FREEZONE_AGENT_HISTORY_WIDTH_STORAGE_KEY,
      FREEZONE_AGENT_HISTORY_WIDTH_DEFAULT,
      FREEZONE_AGENT_HISTORY_WIDTH_MIN,
      FREEZONE_AGENT_HISTORY_WIDTH_MAX,
    ),
  );
  const [resizingPane, setResizingPane] = useState<"chat" | "history" | null>(null);
  const [dockMode, setDockMode] = useState<FreezoneChatDockMode>(loadChatDockMode);
  // Narrow screens use a Sheet; there is no floating window.
  const floating = isDesktop && dockMode === "floating";
  const [floatPos, setFloatPos] = useState(loadChatFloatPos);
  const [draggingFloat, setDraggingFloat] = useState(false);
  const [viewportSize, setViewportSize] = useState(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
  }));
  const asideRef = useRef<HTMLElement | null>(null);
  const spacerRef = useRef<HTMLDivElement | null>(null);
  const localAgentSelectionRef = useRef(false);
  const [agentState, setAgentState] = useState<FreezoneCanvasAgentState>(() => {
    const loaded = loadFreezoneCanvasAgentsWithSource(projectId, canvasId);
    localAgentSelectionRef.current = loaded.hadStoredState;
    return FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED
      ? loaded.state
      : selectFreezoneCanvasAgent(projectId, canvasId, DEFAULT_FREEZONE_AGENT_ID);
  });
  const [busyAgentIds, setBusyAgentIds] = useState<Set<string>>(() => new Set());
  const activeAgentId = agentState.activeAgentId;

  useEffect(() => {
    const loaded = loadFreezoneCanvasAgentsWithSource(projectId, canvasId);
    localAgentSelectionRef.current = loaded.hadStoredState;
    setAgentState(
      FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED
        ? loaded.state
        : selectFreezoneCanvasAgent(projectId, canvasId, DEFAULT_FREEZONE_AGENT_ID),
    );
  }, [canvasId, projectId]);

  useEffect(() => {
    let cancelled = false;
    const hadLocalSelection = localAgentSelectionRef.current;
    const explicitAgentId = FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED
      ? readFreezoneAgentIdFromUrl()
      : null;
    void listServerFreezoneCanvasAgents(projectId, canvasId)
      .then((serverAgents) => {
        if (cancelled || serverAgents.length === 0) return;
        setAgentState(
          mergeFreezoneCanvasAgentsFromServer(projectId, canvasId, serverAgents, {
            explicitAgentId,
            preferServerActive:
              FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED
              && !hadLocalSelection
              && !explicitAgentId,
          }),
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [canvasId, projectId]);

  const handleSelectAgent = useCallback((agentId: string) => {
    localAgentSelectionRef.current = true;
    setAgentState(selectFreezoneCanvasAgent(projectId, canvasId, agentId));
  }, [canvasId, projectId]);

  const handleAddAgent = useCallback(() => {
    localAgentSelectionRef.current = true;
    const result = addFreezoneCanvasAgent(projectId, canvasId);
    initializeEmptyFreezoneAgentChat(projectId, canvasId, result.agent.id, result.agent.createdAt);
    setAgentState(result.state);
  }, [canvasId, projectId]);

  const handleHeaderAddAgent = useCallback(() => {
    localAgentSelectionRef.current = true;
    const result = addFreezoneCanvasAgent(projectId, canvasId);
    initializeEmptyFreezoneAgentChat(projectId, canvasId, result.agent.id, result.agent.createdAt);
    setAgentState(result.state);
  }, [canvasId, projectId]);

  const handleAgentUserMessage = useCallback((agentId: string, message: string, timestamp: number) => {
    localAgentSelectionRef.current = true;
    setAgentState(updateFreezoneCanvasAgentFromUserMessage(projectId, canvasId, agentId, message, timestamp));
  }, [canvasId, projectId]);

  const handleAgentConnectionState = useCallback((agentId: string, state: { busy: boolean }) => {
    setBusyAgentIds((current) => {
      const hasAgent = current.has(agentId);
      if (state.busy === hasAgent) return current;
      const next = new Set(current);
      if (state.busy) {
        next.add(agentId);
      } else {
        next.delete(agentId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const validAgentIds = new Set(agentState.agents.map((agent) => agent.id));
    setBusyAgentIds((current) => {
      const next = new Set([...current].filter((agentId) => validAgentIds.has(agentId)));
      return next.size === current.size ? current : next;
    });
  }, [agentState.agents]);

  const minContentWidth = pushesContent
    ? FREEZONE_CHAT_MIN_BOARD_CONTENT_WIDTH
    : FREEZONE_CHAT_MIN_CONTENT_WIDTH;

  const startPaneResize = useCallback((
    pane: "chat" | "history",
    event: ReactPointerEvent<HTMLDivElement>,
  ) => {
    event.preventDefault();
    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startChatWidth = chatWidth;
    const startHistoryWidth = agentHistoryWidth;
    let cleaned = false;

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizingPane(pane);

    // The floating window does not squeeze the canvas and only needs side margins in the viewport; docked mode must reserve a minimum canvas width.
    const reservedWidth = floating ? FREEZONE_CHAT_FLOAT_MARGIN * 2 : minContentWidth;
    const clampChatWidth = (value: number) => {
      const maxByViewport = Math.max(
        FREEZONE_CHAT_WIDTH_MIN,
        window.innerWidth - reservedWidth - (agentHistoryOpen ? agentHistoryWidth : 0),
      );
      return clampNumber(
        value,
        FREEZONE_CHAT_WIDTH_MIN,
        Math.min(FREEZONE_CHAT_WIDTH_MAX, maxByViewport),
      );
    };
    const clampHistoryWidth = (value: number) => {
      const maxByViewport = Math.max(
        FREEZONE_AGENT_HISTORY_WIDTH_MIN,
        window.innerWidth - reservedWidth - chatWidth,
      );
      return clampNumber(
        value,
        FREEZONE_AGENT_HISTORY_WIDTH_MIN,
        Math.min(FREEZONE_AGENT_HISTORY_WIDTH_MAX, maxByViewport),
      );
    };

    // While dragging, bypass React: only change the DOM width (shell width + the CSS variables the two inner panes read);
    // write back state / persist only on release. A setState on every move would re-render the whole SuperChatPanel
    // (message list + input) and a frame could never finish, making the drag feel stuck and laggy.
    let nextChatWidth = startChatWidth;
    let nextHistoryWidth = startHistoryWidth;
    let pointerX = startX;
    let frame = 0;

    const measure = () => {
      const delta = startX - pointerX;
      if (pane === "chat") {
        nextChatWidth = clampChatWidth(startChatWidth + delta);
      } else {
        nextHistoryWidth = clampHistoryWidth(startHistoryWidth + delta);
      }
    };

    const paint = () => {
      frame = 0;
      measure();
      const dockWidth = agentHistoryOpen ? nextChatWidth + nextHistoryWidth + 8 : nextChatWidth;
      const aside = asideRef.current;
      if (aside) {
        aside.style.width = `${dockWidth}px`;
        aside.style.setProperty(CHAT_PANE_WIDTH_VAR, `${nextChatWidth}px`);
        aside.style.setProperty(AGENT_HISTORY_PANE_WIDTH_VAR, `${nextHistoryWidth}px`);
      }
      if (spacerRef.current) spacerRef.current.style.width = `${dockWidth}px`;
      // The top bar / bottom status bar yield in the same frame (the transition is compressed to 0ms), otherwise they trail behind the hand.
      // The floating window takes no space, so it yields nothing.
      if (!floating) {
        document.documentElement.style.setProperty(
          FREEZONE_DOCK_WIDTH_VAR,
          freezoneDockOffsetCss(dockWidth, minContentWidth),
        );
      }
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      pointerX = moveEvent.clientX;
      // Paint once per frame: a high-refresh mouse/trackpad can push a dozen pointermoves per frame, and changing width
      // each time means a dozen layouts per frame; the wasted work is never displayed.
      if (frame === 0) frame = window.requestAnimationFrame(paint);
    };

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        frame = 0;
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("blur", cleanup);
      target.removeEventListener("lostpointercapture", cleanup);
      try {
        if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
      } catch {
        // Pointer capture can already be released by the browser.
      }
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      // The cancelled frame still holds the last pointermove; compute it first, then persist,
      // otherwise the width jumps back one frame the moment the pointer is released.
      measure();
      setChatWidth(nextChatWidth);
      setAgentHistoryWidth(nextHistoryWidth);
      storePanelWidth(FREEZONE_CHAT_WIDTH_STORAGE_KEY, nextChatWidth);
      storePanelWidth(FREEZONE_AGENT_HISTORY_WIDTH_STORAGE_KEY, nextHistoryWidth);
      setResizingPane(null);
    };

    try {
      target.setPointerCapture(pointerId);
    } catch {
      // Some browsers may reject capture for non-primary pointers.
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("blur", cleanup);
    target.addEventListener("lostpointercapture", cleanup);
  }, [agentHistoryOpen, agentHistoryWidth, chatWidth, floating, minContentWidth]);

  const toggleDockMode = useCallback(() => {
    setDockMode((current) => {
      const next = current === "floating" ? "docked" : "floating";
      storeChatDockMode(next);
      return next;
    });
  }, []);
  const dockModeToggleLabel = floating ? t("freezone.chat.dockRight") : t("freezone.chat.floatWindow");

  const agentHeaderActions = (
    <>
      {FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={handleHeaderAddAgent}
          aria-label={t("freezone.shell.newAgent")}
          title={t("freezone.shell.newAgent")}
          className="text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
        >
          <Plus className="size-4" />
        </Button>
      )}
      {FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          onClick={() => setAgentHistoryOpen((value) => !value)}
          aria-pressed={agentHistoryOpen}
          aria-label={agentHistoryOpen ? t("freezone.shell.hideAgentHistory") : t("freezone.shell.showAgentHistory")}
          title={agentHistoryOpen ? t("freezone.shell.hideAgentHistory") : t("freezone.shell.showAgentHistory")}
          className={cn(
            "text-muted-foreground hover:bg-white/[0.08] hover:text-foreground",
            agentHistoryOpen && "bg-white/[0.08] text-foreground",
          )}
        >
          {agentHistoryOpen ? <PanelRightClose className="size-4" /> : <PanelRightOpen className="size-4" />}
        </Button>
      )}
      {isDesktop && (
        <TooltipProvider delay={80}>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  onClick={toggleDockMode}
                  aria-label={dockModeToggleLabel}
                  className="text-muted-foreground hover:bg-white/[0.08] hover:text-foreground"
                />
              }
            >
              {floating ? <PanelRight className="size-4" /> : <PictureInPicture2 className="size-4" />}
            </TooltipTrigger>
            <TooltipContent side="bottom">{dockModeToggleLabel}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}
    </>
  );

  const agentHistoryPanel = (
    <FreezoneAgentHistoryPanel
      agents={agentState.agents}
      activeAgentId={activeAgentId}
      search={agentSearch}
      onSearchChange={setAgentSearch}
      onSelect={handleSelectAgent}
      onAdd={handleAddAgent}
    />
  );
  const agentPanels = agentState.agents.map((agent) => {
    const active = agent.id === activeAgentId;
    const busy = busyAgentIds.has(agent.id);
    const connectionEnabled = shouldConnectFreezoneCanvasAgent({ active, busy });
    return (
      <div
        key={`${projectId}:${canvasId}:${agent.id}`}
        className={cn("h-full min-h-0 w-full", !active && "hidden")}
        aria-hidden={!active}
      >
        <SuperChatPanel
          variant="freezone"
          freezoneCanvasId={canvasId}
          freezoneAgentId={agent.id}
          connectionEnabled={connectionEnabled}
          workflowStatusEnabled={active}
          currentCanvasMetadata={currentCanvasMetadata}
          currentCanvasSelection={currentCanvasSelection}
          currentCanvasOntologyContext={currentCanvasOntologyContext}
          pendingAttachments={active ? pendingAttachments : []}
          onPendingAttachmentsConsumed={active ? onPendingAttachmentsConsumed : undefined}
          pendingNodeMentions={active ? pendingNodeMentions : []}
          onPendingNodeMentionsConsumed={active ? onPendingNodeMentionsConsumed : undefined}
          onRequestClose={() => onOpenChange(false)}
          freezoneHeaderActions={agentHeaderActions}
          onFreezoneUserMessage={(message, timestamp) => handleAgentUserMessage(agent.id, message, timestamp)}
          onConnectionStateChange={(state) => handleAgentConnectionState(agent.id, state)}
        />
      </div>
    );
  });
  const shouldKeepPanelMounted = shouldKeepFreezoneChatPanelMounted({
    open,
    busy: busyAgentIds.size > 0,
  });

  useEffect(() => {
    if (!isDesktop) {
      setShouldRenderPanel(open);
      setPanelVisible(open);
      return;
    }
    if (open) {
      setShouldRenderPanel(true);
      const frame = window.requestAnimationFrame(() => setPanelVisible(true));
      return () => window.cancelAnimationFrame(frame);
    }
    if (shouldKeepPanelMounted) {
      setShouldRenderPanel(true);
      setPanelVisible(false);
      return;
    }
    setPanelVisible(false);
    const timeout = window.setTimeout(() => setShouldRenderPanel(false), 320);
    return () => window.clearTimeout(timeout);
  }, [isDesktop, open, shouldKeepPanelMounted]);

  // Total drawer width (chat + optional history-agent column, with an 8px divider in between). The placeholder block
  // uses the same value so the squeezed left content fits the drawer exactly.
  const dockWidth = agentHistoryOpen ? chatWidth + agentHistoryWidth + 8 : chatWidth;
  const resizing = resizingPane !== null;

  // The drawer is a full-height overlay (above the top bar) and squeezes no one; it can only broadcast "how much of the
  // right side I occupy" so the full-width top bar / bottom status bar / task panel shrink left themselves - the
  // top-right entries yield with them. See ./dockOffset for the protocol and consumers.
  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty(
      FREEZONE_DOCK_WIDTH_VAR,
      isDesktop && panelVisible && hostActive && !floating
        ? freezoneDockOffsetCss(dockWidth, minContentWidth)
        : "0px",
    );
    return () => {
      root.style.removeProperty(FREEZONE_DOCK_WIDTH_VAR);
    };
  }, [dockWidth, floating, hostActive, isDesktop, minContentWidth, panelVisible]);

  // The floating window must re-clamp to the window size, otherwise after shrinking the window the title bar can leave the viewport and never be dragged back.
  useEffect(() => {
    if (!floating) return;
    const handleResize = () => setViewportSize({ width: window.innerWidth, height: window.innerHeight });
    handleResize();
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, [floating]);

  // The available height is a hard cap: in a short window the floating window should get shorter rather than cover the
  // bottom status area or overflow the viewport, leaving the input unreachable.
  const floatHeight = Math.max(
    0,
    Math.min(
      FREEZONE_CHAT_FLOAT_HEIGHT,
      viewportSize.height - FREEZONE_CHAT_FLOAT_MIN_TOP - FREEZONE_CHAT_FLOAT_BOTTOM_RESERVE,
    ),
  );
  const clampFloatPos = useCallback((pos: { right: number; top: number }, width: number) => ({
    right: clampNumber(
      pos.right,
      FREEZONE_CHAT_FLOAT_MARGIN,
      Math.max(FREEZONE_CHAT_FLOAT_MARGIN, window.innerWidth - width - FREEZONE_CHAT_FLOAT_MARGIN),
    ),
    top: clampNumber(
      pos.top,
      FREEZONE_CHAT_FLOAT_MIN_TOP,
      Math.max(
        FREEZONE_CHAT_FLOAT_MIN_TOP,
        window.innerHeight - floatHeight - FREEZONE_CHAT_FLOAT_BOTTOM_RESERVE,
      ),
    ),
  }), [floatHeight]);
  // Clamp on every render: viewportSize changes trigger a re-render, and clamping reads the live window size.
  const renderedFloatPos = clampFloatPos(floatPos, dockWidth);

  // The floating window drags by the chat header. Pressing a button/menu in the header does not count as a drag (left to the button).
  // Same as width dragging: only change the DOM right/top while dragging, write back state and persist on release.
  const startFloatDrag = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    if (!floating || event.button !== 0) return;
    const target = event.target as HTMLElement | null;
    if (!target?.closest("[data-freezone-chat-drag-handle]")) return;
    if (target.closest("button, a, input, textarea, select, [role='button'], [role='menuitem']")) return;
    event.preventDefault();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    const start = renderedFloatPos;
    let latest = start;
    let frame = 0;
    let pointerX = startX;
    let pointerY = startY;

    document.body.style.userSelect = "none";
    setDraggingFloat(true);

    const paint = () => {
      frame = 0;
      latest = clampFloatPos(
        { right: start.right - (pointerX - startX), top: start.top + (pointerY - startY) },
        dockWidth,
      );
      const aside = asideRef.current;
      if (aside) {
        aside.style.right = `${latest.right}px`;
        aside.style.top = `${latest.top}px`;
      }
    };
    const handlePointerMove = (moveEvent: PointerEvent) => {
      if (moveEvent.pointerId !== pointerId) return;
      pointerX = moveEvent.clientX;
      pointerY = moveEvent.clientY;
      if (frame === 0) frame = window.requestAnimationFrame(paint);
    };
    const cleanup = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", cleanup);
      window.removeEventListener("pointercancel", cleanup);
      window.removeEventListener("blur", cleanup);
      if (frame !== 0) {
        window.cancelAnimationFrame(frame);
        paint();
      }
      document.body.style.userSelect = "";
      setDraggingFloat(false);
      setFloatPos(latest);
      storeChatFloatPos(latest);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", cleanup);
    window.addEventListener("pointercancel", cleanup);
    window.addEventListener("blur", cleanup);
  }, [clampFloatPos, dockWidth, floating, renderedFloatPos]);

  // While width-dragging, compress the yield animation to 0ms: a 300ms easing would schedule a fresh easing every frame,
  // and the top-bar edge would trail behind the drawer like a rubber band.
  useEffect(() => {
    if (!resizing) return;
    const root = document.documentElement;
    root.style.setProperty(FREEZONE_DOCK_TRANSITION_VAR, "0ms");
    return () => {
      root.style.removeProperty(FREEZONE_DOCK_TRANSITION_VAR);
    };
  }, [resizing]);

  if (!isDesktop) {
    return (
      <>
        <FreezoneChatToggleButton
          label={toggleLabel}
          expanded={open}
          onClick={() => onOpenChange(true)}
        />
        <Sheet open={open} onOpenChange={onOpenChange}>
          <SheetContent
            side="right"
            className="flex w-full flex-col gap-0 bg-[#212121] p-0 sm:!max-w-[560px]"
          >
            <SheetHeader className="sr-only">
              <SheetTitle>{title}</SheetTitle>
              <SheetDescription>{description}</SheetDescription>
            </SheetHeader>
            <div className="relative flex min-h-0 flex-1 overflow-hidden">
              <div className="min-h-0 flex-1">{agentPanels}</div>
              {FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED && (
                <div
                  className={cn(
                    "absolute inset-y-0 right-0 z-20 w-[220px] border-l border-white/[0.08] bg-[#212121] shadow-[-16px_0_32px_rgba(0,0,0,0.18)] transition-transform duration-200",
                    agentHistoryOpen ? "translate-x-0" : "translate-x-full",
                  )}
                >
                  {agentHistoryPanel}
                </div>
              )}
            </div>
          </SheetContent>
        </Sheet>
      </>
    );
  }

  if (!shouldRenderPanel) {
    return (
      <FreezoneChatToggleButton
        label={toggleLabel}
        expanded={false}
        onClick={() => onOpenChange(true)}
      />
    );
  }

  // A CSS-side backstop: after resizing the window, or switching from workflow to storyboard with a wide drawer, the stored
  // width may already exceed the limit - clamp it here instead of rewriting the user's width preference.
  const dockMaxWidth = `calc(100vw - ${minContentWidth}px)`;
  // Width transitions smoothly on open/close / collapsing the history column; it must be fully disabled while dragging - the same
  // width is being dragged, and keeping the transition would schedule a 300ms easing every frame, making it feel like a rubber band.
  const dockTransition = resizing
    ? "transition-none"
    : "transition-[opacity,transform,width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]";
  const dockStyle = {
    width: dockWidth,
    maxWidth: floating ? `calc(100vw - ${FREEZONE_CHAT_FLOAT_MARGIN * 2}px)` : dockMaxWidth,
    [CHAT_PANE_WIDTH_VAR]: `${chatWidth}px`,
    [AGENT_HISTORY_PANE_WIDTH_VAR]: `${agentHistoryWidth}px`,
    ...(floating
      ? { right: renderedFloatPos.right, top: renderedFloatPos.top, height: floatHeight }
      : null),
  } as CSSProperties;

  return (
    <>
      {!open && (
        <FreezoneChatToggleButton
          label={toggleLabel}
          expanded={false}
          onClick={() => onOpenChange(true)}
        />
      )}
      {/* Storyboard: takes one slot in the flex row, squeezing <main>(flex-1) narrower - the drawer itself is still an
          absolutely positioned overlay that exactly covers this slot. So open/close/resize only moves this placeholder, and the
          drawer's internal layout shares one code path with workflow mode. The width transition is off while dragging, else following lags a frame. */}
      {pushesContent && !floating && (
        <div
          ref={spacerRef}
          aria-hidden="true"
          className={cn(
            "hidden shrink-0 lg:block",
            resizing
              ? "transition-none"
              : "transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
          )}
          style={{ width: panelVisible ? dockWidth : 0, maxWidth: dockMaxWidth }}
        />
      )}
      <aside
        ref={asideRef}
        className={cn(
          // Pinned right, full height: fixed rather than absolute - the drawer must span from the very top to the very bottom of
          // the screen, not just the content area. The top bar / task panel / bottom status bar are not pushed aside by z, but
          // shrink left by --freezone-dock-width themselves (see dockOffset); both sides use the same clamp, so in steady state they never overlap.
          // z must be <50: shadcn overlays (dropdown/select/popover/tooltip/dialog) all portal to body with an isolate z-50
          // positioning layer; once the drawer is above 50, every menu inside it is covered by its own solid background -
          // which looks like "clicking does nothing". 45 only needs to exceed the task panel (z-40) and its mask (z-30).
          // Floating: the same fixed shell becomes a rounded floating window, position/height via style; drag the header to move.
          floating
            ? "fixed z-[45] hidden flex-col overflow-hidden rounded-2xl border border-white/[0.12] shadow-[0_24px_64px_rgba(0,0,0,0.55)] lg:flex [&_[data-freezone-chat-drag-handle]]:cursor-grab"
            : "fixed inset-y-0 right-0 z-[45] hidden flex-col overflow-hidden border-l border-white/[0.12] shadow-none lg:flex",
          draggingFloat && "[&_[data-freezone-chat-drag-handle]]:cursor-grabbing",
          // Solid #212121 (user specified): one step darker than the storyboard panel's #262626; the agent drawer is no longer a translucent
          // frosted glass. backdrop-blur-2xl is removed too - a large-radius blur over a full-height area must be re-rasterized every
          // frame, the main cause of resizing not keeping up with the hand, and with a solid background there is nothing to blur anyway.
          // Exception for the floating window: over the canvas/preview, translucency + blur shows the content below (matching the reference design).
          // The floating window is only 720px tall with a small area, so the blur's rasterization cost is far lower than the full-height drawer's.
          floating ? "bg-[#212121]/25 backdrop-blur-md" : "bg-[#212121]",
          dockTransition,
          panelVisible
            ? floating ? "scale-100 opacity-100" : "translate-x-0 opacity-100"
            : floating ? "scale-95 opacity-0" : "translate-x-10 opacity-0",
          !panelVisible && "pointer-events-none",
        )}
        style={dockStyle}
        aria-label={title}
        onPointerDown={startFloatDrag}
      >
        {/* The hit area sits entirely inside the panel edge (12px): the shell is overflow-hidden, so any part of the handle
            translated out toward the canvas would be clipped along with its hit area - the old -translate-x-1 left only
            4px grabbable, which was half the reason dragging felt awkward.
            Visually it is just a thin line along the left border: thicker and brighter on hover, kept highlighted while dragging. */}
        <div
          className="group absolute inset-y-0 left-0 z-30 flex w-3 cursor-col-resize touch-none items-stretch justify-start"
          role="separator"
          aria-orientation="vertical"
          aria-label={t("freezone.shell.resizeChat")}
          title={t("freezone.shell.resizeChat")}
          onPointerDown={(event) => startPaneResize("chat", event)}
        >
          <span
            className={cn(
              "h-full w-px transition-[width,background-color,opacity] duration-150 ease-out",
              resizingPane === "chat"
                ? "w-[3px] bg-white/45 opacity-100"
                : "bg-white/25 opacity-0 group-hover:w-[3px] group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          />
        </div>
        {resizing && <div className="fixed inset-0 z-50 cursor-col-resize" aria-hidden="true" />}
        <div className="flex min-h-0 flex-1">
          <div className="min-w-0 shrink-0" style={{ width: `var(${CHAT_PANE_WIDTH_VAR})` }}>
            {agentPanels}
          </div>
          {FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED && agentHistoryOpen && (
            <div
              className="group relative z-20 flex w-2 shrink-0 cursor-col-resize touch-none items-stretch justify-center bg-white/[0.03] transition-colors hover:bg-white/[0.08]"
              role="separator"
              aria-orientation="vertical"
              aria-label={t("freezone.shell.resizeAgentHistory")}
              title={t("freezone.shell.resizeAgentHistory")}
              onPointerDown={(event) => startPaneResize("history", event)}
            >
              <span
                className={cn(
                  "h-full w-px transition-colors",
                  resizingPane === "history" ? "bg-white/45" : "bg-white/14 group-hover:bg-white/35",
                )}
              />
            </div>
          )}
          <div
            className={cn(
              // Same background as the chat area: the left border is enough to divide the columns. The old zinc-950/45 was a darkening layer over
              // the translucent drawer; with a solid drawer background it would become a noticeably blacker sidebar.
              "min-h-0 overflow-hidden border-l border-white/[0.08] bg-[#212121]",
              // On the same timeline as the shell: collapse/expand run 300ms together, and both are turned off during dragging.
              resizing
                ? "transition-none"
                : "transition-[width,opacity] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)]",
              agentHistoryOpen ? "opacity-100" : "w-0 opacity-0",
            )}
            style={{ width: agentHistoryOpen ? `var(${AGENT_HISTORY_PANE_WIDTH_VAR})` : 0 }}
            aria-hidden={!agentHistoryOpen}
          >
            {agentHistoryPanel}
          </div>
        </div>
      </aside>
    </>
  );
}

function FreezoneAgentHistoryPanel({
  agents,
  activeAgentId,
  search,
  onSearchChange,
  onSelect,
  onAdd,
}: {
  agents: FreezoneCanvasAgentState["agents"];
  activeAgentId: string;
  search: string;
  onSearchChange: (value: string) => void;
  onSelect: (agentId: string) => void;
  onAdd: () => void;
}) {
  const normalizedSearch = search.trim().toLowerCase();
  const visibleAgents = agents
    .filter((agent) => {
      if (!normalizedSearch) return true;
      return agent.name.toLowerCase().includes(normalizedSearch) || agent.id.toLowerCase().includes(normalizedSearch);
    })
    .sort((left, right) => right.createdAt - left.createdAt);

  return (
    <div className="flex h-full min-h-0 w-full flex-col bg-zinc-950/35 p-3">
      <label className="flex h-9 shrink-0 items-center gap-2 rounded-lg bg-white/[0.07] px-3 text-zinc-400">
        <Search className="size-4 shrink-0" />
        <input
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
          placeholder={i18n.t("freezone.shell.searchSessions")}
          className="min-w-0 flex-1 bg-transparent text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
      </label>
      <div className="mt-3 min-h-0 flex-1 space-y-2 overflow-y-auto pr-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {visibleAgents.map((agent) => {
          const active = agent.id === activeAgentId;
          return (
            <button
              key={agent.id}
              type="button"
              onClick={() => onSelect(agent.id)}
              className={cn(
                // A list row is not a card: corner radius down to 6px, row height one step smaller, and don't brighten the background too much - a 0.14
                // fill is one big gray block on a near-black panel; the left vertical bar is enough to show the selected state.
                "relative flex min-h-[44px] w-full flex-col items-start justify-center rounded-md px-3 py-2 text-left transition-colors",
                active
                  ? "bg-white/[0.08] text-white before:absolute before:inset-y-2 before:left-0 before:w-px before:rounded-full before:bg-white/70"
                  : "text-zinc-400 hover:bg-white/[0.045] hover:text-zinc-100",
              )}
              title={agent.name}
            >
              <span className="flex w-full items-center gap-2">
                <span
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    active ? "bg-emerald-400" : "bg-zinc-600",
                  )}
                />
                <span className="min-w-0 truncate text-sm font-medium">{agent.name}</span>
              </span>
              <span className="ml-4 mt-0.5 text-[11px] leading-none text-zinc-500">
                {formatAgentHistoryTime(agent.createdAt)}
              </span>
            </button>
          );
        })}
        {visibleAgents.length === 0 && (
          <div className="px-2 py-8 text-center text-xs text-zinc-500">
            {i18n.t("freezone.shell.noMatchingAgent")}
          </div>
        )}
      </div>
      {FREEZONE_MULTI_AGENT_SESSION_UI_ENABLED && (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="mt-3 h-9 shrink-0 rounded-lg bg-white/[0.10] text-sm text-zinc-100 hover:bg-white/[0.16]"
          onClick={onAdd}
        >
          <Plus className="mr-1.5 size-4" />
          {i18n.t("freezone.shell.newAgent")}
        </Button>
      )}
    </div>
  );
}

function formatAgentHistoryTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Intl.DateTimeFormat(i18n.language || undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(timestamp));
}

/**
 * Position of the assistant entry (right/bottom offsets relative to the container's bottom-right corner, px).
 * Note the key avoids the `supertale-` prefix - that prefix is wiped by the reset-region-state localStorage
 * sweep; this is only a UI position preference and is fine to keep across regions.
 */
const CHAT_LAUNCHER_POS_STORAGE_KEY = "st.freezone.chatLauncherPos";
const CHAT_LAUNCHER_VISUAL_WIDTH = 96;
const CHAT_LAUNCHER_VISUAL_HEIGHT = 35;
const CHAT_LAUNCHER_HIT_HEIGHT = 44;
const CHAT_LAUNCHER_MARGIN = 8;
/** Raised above the MiniMap by default (about 150px tall + 15px margin) so it does not cover the canvas thumbnail. */
const CHAT_LAUNCHER_DEFAULT_POS = { right: 16, bottom: 180 };
const CHAT_LAUNCHER_DRAG_THRESHOLD = 4;

function loadChatLauncherPos(): { right: number; bottom: number } {
  try {
    const raw = window.localStorage.getItem(CHAT_LAUNCHER_POS_STORAGE_KEY);
    if (!raw) return CHAT_LAUNCHER_DEFAULT_POS;
    const parsed = JSON.parse(raw) as { right?: unknown; bottom?: unknown };
    if (typeof parsed.right === "number" && typeof parsed.bottom === "number") {
      return { right: parsed.right, bottom: parsed.bottom };
    }
  } catch {
    // ignore malformed storage
  }
  return CHAT_LAUNCHER_DEFAULT_POS;
}

function FreezoneChatToggleButton({
  label,
  expanded,
  onClick,
}: {
  label: string;
  expanded: boolean;
  onClick: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [entered, setEntered] = useState(false);
  const [pos, setPos] = useState(loadChatLauncherPos);
  // Suppress the click right after pointerup following a drag, so finishing a drag does not open the panel.
  const suppressClickRef = useRef(false);

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setEntered(true));
    return () => window.cancelAnimationFrame(frame);
  }, []);

  // On mount, clamp the stored position back into the container - after shrinking the window the old coordinates may be
  // outside the viewport, and once the button flies out it can never be dragged back.
  useEffect(() => {
    const parent = buttonRef.current?.offsetParent as HTMLElement | null;
    if (!parent) return;
    const rect = parent.getBoundingClientRect();
    const maxRight = Math.max(
      CHAT_LAUNCHER_MARGIN,
      rect.width - CHAT_LAUNCHER_VISUAL_WIDTH - CHAT_LAUNCHER_MARGIN,
    );
    const maxBottom = Math.max(
      CHAT_LAUNCHER_MARGIN,
      rect.height - CHAT_LAUNCHER_HIT_HEIGHT - CHAT_LAUNCHER_MARGIN,
    );
    setPos((current) => {
      const clamped = {
        right: Math.min(Math.max(current.right, CHAT_LAUNCHER_MARGIN), maxRight),
        bottom: Math.min(Math.max(current.bottom, CHAT_LAUNCHER_MARGIN), maxBottom),
      };
      return clamped.right === current.right && clamped.bottom === current.bottom
        ? current
        : clamped;
    });
  }, []);

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      const parent = buttonRef.current?.offsetParent as HTMLElement | null;
      const parentRect = parent?.getBoundingClientRect();
      const start = {
        x: event.clientX,
        y: event.clientY,
        right: pos.right,
        bottom: pos.bottom,
      };
      let dragged = false;
      let latest = { right: pos.right, bottom: pos.bottom };

      const clamp = (value: number, max: number) =>
        Math.min(Math.max(value, CHAT_LAUNCHER_MARGIN), max);

      const onMove = (ev: PointerEvent) => {
        const dx = ev.clientX - start.x;
        const dy = ev.clientY - start.y;
        if (!dragged && Math.hypot(dx, dy) < CHAT_LAUNCHER_DRAG_THRESHOLD) return;
        dragged = true;
        const maxRight = parentRect
          ? Math.max(
              CHAT_LAUNCHER_MARGIN,
              parentRect.width - CHAT_LAUNCHER_VISUAL_WIDTH - CHAT_LAUNCHER_MARGIN,
            )
          : Number.MAX_SAFE_INTEGER;
        const maxBottom = parentRect
          ? Math.max(
              CHAT_LAUNCHER_MARGIN,
              parentRect.height - CHAT_LAUNCHER_HIT_HEIGHT - CHAT_LAUNCHER_MARGIN,
            )
          : Number.MAX_SAFE_INTEGER;
        latest = {
          right: clamp(start.right - dx, maxRight),
          bottom: clamp(start.bottom - dy, maxBottom),
        };
        setPos(latest);
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        if (dragged) {
          suppressClickRef.current = true;
          try {
            window.localStorage.setItem(
              CHAT_LAUNCHER_POS_STORAGE_KEY,
              JSON.stringify(latest),
            );
          } catch {
            // storage full / unavailable — position just won't persist
          }
        }
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [pos.bottom, pos.right],
  );

  const handleClick = useCallback(() => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onClick();
  }, [onClick]);

  const playMotion = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = 0;
    void video.play().catch(() => undefined);
  }, []);

  const stopMotion = useCallback(() => {
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.currentTime = 0;
    }
  }, []);

  return (
    <Button
      ref={buttonRef}
      type="button"
      size="icon-lg"
      variant="secondary"
      className={cn(
        "group/xia-dao absolute z-50 cursor-grab touch-none overflow-visible border-0 bg-transparent p-0 transition-opacity duration-200 ease-out hover:bg-transparent active:cursor-grabbing",
        entered ? "opacity-100" : "opacity-0",
      )}
      style={{
        right: pos.right,
        bottom: pos.bottom,
        width: CHAT_LAUNCHER_VISUAL_WIDTH,
        height: CHAT_LAUNCHER_HIT_HEIGHT,
      }}
      aria-label={label}
      aria-expanded={expanded}
      onMouseEnter={playMotion}
      onMouseLeave={stopMotion}
      onFocus={playMotion}
      onBlur={stopMotion}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
    >
      <video
        ref={videoRef}
        src="/images/xia-dao-launcher.mp4"
        muted
        loop
        playsInline
        preload="auto"
        className="pointer-events-none absolute left-0 top-1/2 w-full -translate-y-1/2 rounded-[6px] object-cover brightness-[1.08] saturate-[1.02] shadow-[0_4px_10px_rgba(0,0,0,0.2)] transition-[filter] duration-200 ease-out group-hover/xia-dao:brightness-[1.16] group-focus-visible/xia-dao:brightness-[1.16]"
        style={{ height: CHAT_LAUNCHER_VISUAL_HEIGHT }}
        aria-hidden="true"
      />
    </Button>
  );
}

function normalizePushTarget(
  target: (Partial<PushTarget> & { kind?: PushTargetKind }) | null,
): (Partial<PushTarget> & { kind: PushTargetKind }) | null {
  if (!target?.kind) return null;
  return target as Partial<PushTarget> & { kind: PushTargetKind };
}

function refreshCommittedTargetNodes(
  target: PushTarget,
  result: PushResult,
): void {
  if (!shouldRefreshCommittedTargetNodes(target)) return;
  const targetUrl = result.target_url;
  if (!targetUrl) return;
  const previewUrl = withImageCacheBust(targetUrl, Date.now());

  const store = useCanvasStore.getState();
  for (const node of store.nodes) {
    const data = (node.data ?? {}) as Record<string, unknown>;
    if (data.user_spawned === true) continue;
    const sourceMeta = data.__freezone_source as
      | { kind?: string; role?: string; meta?: Record<string, unknown> }
      | undefined;
    const nodeTarget =
      coerceSlotTarget(data.slot_target) ??
      inferCanonicalRefreshTarget(sourceMeta);
    if (!nodeTarget || !pushTargetsEqual(nodeTarget, target)) continue;

    const baseUpdate =
      target.kind === "video"
        ? { videoUrl: targetUrl, previewImageUrl: previewUrl }
        : target.kind === "beat_audio"
          ? { audioUrl: targetUrl, url: targetUrl }
          : isPlyOrGlbPushTargetKind(target.kind)
            ? { fileUrl: targetUrl, modelUrl: targetUrl, plyUrl: targetUrl, url: targetUrl }
            : { imageUrl: targetUrl, previewImageUrl: previewUrl };
    store.updateNodeData(node.id, {
      ...baseUpdate,
      committed_slot_url: targetUrl,
    } as Record<string, unknown>);
  }
}

function markCommitCandidatePushed(
  nodeId: string,
  target: PushTarget,
  result: PushResult,
): void {
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === nodeId);
  const data = (node?.data ?? {}) as Record<string, unknown>;
  if (!isCommitCandidateData(data)) return;
  const slot = coerceSlotTarget(data.slot_target);
  if (!slot || !pushTargetsEqual(slot, target)) return;

  const update: Record<string, unknown> = {
    committed_at: new Date().toISOString(),
  };
  if (typeof result.target_url === "string" && result.target_url.length > 0) {
    update.committed_slot_url = result.target_url;
  }
  store.updateNodeData(nodeId, update);
}

function inferCanonicalRefreshTarget(
  source:
    | { kind?: string; role?: string; meta?: Record<string, unknown> }
    | undefined,
): (Partial<PushTarget> & { kind: PushTargetKind }) | undefined {
  if (!source?.kind) return undefined;
  return inferDefaultTarget(source);
}

function pushTargetsEqual(
  a: Partial<PushTarget> & { kind: PushTargetKind },
  b: PushTarget,
): boolean {
  if (a.kind !== b.kind) return false;
  const av = a as Record<string, unknown>;
  if (
    b.kind === "frame" ||
    b.kind === "sketch" ||
    b.kind === "director_render" ||
    b.kind === "selected_background" ||
    b.kind === "video" ||
    b.kind === "beat_audio"
  ) {
    return av.episode === b.episode && av.beat === b.beat;
  }
  if (
    b.kind === "identity" ||
    b.kind === "identity_costume" ||
    b.kind === "identity_portrait"
  ) {
    return av.character === b.character && av.identity_id === b.identity_id;
  }
  if (b.kind === "portrait") {
    return av.character === b.character;
  }
  if (isScenePushTargetKind(b.kind)) {
    return av.scene_id === (b as unknown as Record<string, unknown>).scene_id;
  }
  if (b.kind === "prop_ref") {
    return av.prop_id === b.prop_id;
  }
  return false;
}

function defaultCharacterFromMetadata(metadata: Record<string, unknown> | null): string | null {
  const preset = metadata?.preset as { character?: unknown } | undefined;
  return typeof preset?.character === "string" && preset.character ? preset.character : null;
}

interface PushPrompt {
  nodeId: string;
  sourceUrl: string;
  previewUrl: string | null;
  sourceLabel: string;
  mediaType: DropMediaType;
  defaultTarget?: Partial<PushTarget> & { kind: PushTargetKind };
  directorControlBundle?: Record<string, unknown> | null;
  nodeData?: Record<string, unknown> | null;
}

interface SelectedImageSummary {
  nodeId: string;
  imageUrl: string;
  previewUrl: string | null;
  defaultTarget?: Partial<PushTarget> & { kind: PushTargetKind };
  label: string;
}

function Toast({ text, onClose }: { text: string; onClose: () => void }) {
  return (
    <div className="absolute left-1/2 top-16 z-40 max-w-md -translate-x-1/2 rounded-lg border border-border-default bg-surface/95 px-4 py-2 text-sm text-text shadow-xl backdrop-blur">
      <div className="flex items-center gap-3">
        <span className="break-words flex-1 min-w-0">{text}</span>
        <button
          type="button"
          onClick={onClose}
          className="text-text-muted hover:text-text text-xs"
        >
          ✕
        </button>
      </div>
    </div>
  );
}

function CanvasConflictOverlay({
  error,
  canvasId,
  onRefresh,
  onSaveCopy,
  readConflictSnapshot,
}: {
  error: string | null;
  canvasId: string;
  onRefresh: () => void;
  onSaveCopy: () => Promise<void>;
  readConflictSnapshot: () => ConflictSnapshot | null;
}) {
  const { t } = useTranslation();
  const [savingCopy, setSavingCopy] = useState(false);
  const [copyError, setCopyError] = useState<string | null>(null);
  // Read once on mount so the "Download local JSON" button always renders against
  // the snapshot captured at the moment the 409 fired, even if a later save
  // would have rewritten it.
  const snapshot = useMemo(() => readConflictSnapshot(), [readConflictSnapshot]);

  const handleDownload = () => {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const stamp = snapshot.timestamp
      ? snapshot.timestamp.replace(/[:.]/g, "-")
      : new Date().toISOString().replace(/[:.]/g, "-");
    anchor.download = `freezone-${canvasId}-conflict-${stamp}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="absolute inset-0 z-50 bg-bg-dark/60 flex items-center justify-center">
      <div className="px-4 py-3 rounded-lg bg-surface border border-amber-400/50 text-sm text-amber-100 max-w-md flex flex-col gap-3">
        <div className="font-medium">{t("freezone.shell.conflict.title")}</div>
        <div className="text-text-muted">
          {error ?? t("freezone.shell.conflict.detail")}
        </div>
        {snapshot && (
          <div className="text-[11px] text-text-muted/80">
            {t("freezone.shell.conflict.snapshotHint")}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={onRefresh}
            className="px-3 py-1 rounded-md border border-amber-400/40 text-amber-100 hover:bg-amber-400/10 transition-colors"
          >
            {t("freezone.shell.conflict.refresh")}
          </button>
          <button
            type="button"
            disabled={savingCopy || !snapshot}
            onClick={() => {
              setSavingCopy(true);
              setCopyError(null);
              onSaveCopy()
                .catch((err) => {
                  setCopyError(err instanceof Error ? err.message : String(err));
                })
                .finally(() => setSavingCopy(false));
            }}
            className="px-3 py-1 rounded-md border border-cyan-300/45 bg-cyan-400/18 text-cyan-50 shadow-[0_0_18px_rgba(34,211,238,0.12)] transition-colors hover:border-cyan-200/70 hover:bg-cyan-400/28 disabled:border-white/10 disabled:bg-white/[0.04] disabled:text-white/30 disabled:shadow-none"
            title={snapshot ? undefined : t("freezone.canvases.noConflictSnapshot")}
          >
            {savingCopy ? t("freezone.shell.conflict.savingCopy") : t("freezone.shell.conflict.saveCopy")}
          </button>
          {snapshot && (
            <button
              type="button"
              onClick={handleDownload}
              className="px-3 py-1 rounded-md border border-[var(--ui-border-soft)] text-text hover:bg-bg-dark/50 transition-colors"
              title={t("freezone.shell.conflict.downloadTitle", { nodes: snapshot.nodes.length, edges: snapshot.edges.length })}
            >
              {t("freezone.shell.conflict.download")}
            </button>
          )}
        </div>
        {copyError && (
          <div className="text-[11px] text-red-300">
            {copyError}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Lightweight indicator for the backend's `backup_status` channel. Only
 * renders for `pending` (still uploading to OSS) and `failed` (local save is
 * durable but OSS replication did not stick); `synced` / `disabled` / `null`
 * stay silent so the canvas does not gain chrome for the happy path.
 *
 * The badge floats above ReactFlow's bottom-right zoom controls
 * (`bottom-3 right-3` is taken by `MiniMap`; the offset puts us just
 * above it without overlapping).
 */
function BackupStatusIndicator({
  status,
}: {
  status: import("@/api/canvas").CanvasBackupStatus | null;
}) {
  const { t } = useTranslation();
  if (status !== "pending" && status !== "failed") {
    return null;
  }
  const isFailed = status === "failed";
  const label = isFailed ? t("freezone.shell.backup.failedLabel") : t("freezone.shell.backup.pendingLabel");
  const detail = isFailed
    ? t("freezone.shell.backup.failedDetail")
    : t("freezone.shell.backup.pendingDetail");
  const palette = isFailed
    ? "border-red-500/45 bg-red-500/10 text-red-200"
    : "border-amber-300/40 bg-amber-300/10 text-amber-100";
  const dot = isFailed ? "bg-red-400" : "bg-amber-300 animate-pulse";
  return (
    <div
      role={isFailed ? "alert" : "status"}
      className={`absolute bottom-16 right-3 z-30 inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-none shadow-sm ${palette}`}
      title={detail}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
      {label}
    </div>
  );
}

/**
 * Full-screen blocking layer while switching canvases.
 *
 * Deliberately an opaque layer on top of Canvas rather than swapping Canvas out: the ReactFlow instance must stay
 * alive so hydrate can first place the camera at the new canvas's position before mounting nodes (see the savedViewport
 * section of useCanvasSync). It also swallows pointer events - the canvas underneath is empty at that moment, and any
 * action landing on it would be overwritten by the following setCanvasData.
 */
function CanvasLoadingScreen() {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-bg-dark cursor-wait text-text-muted text-sm">
      {t("freezone.shell.loading")}
    </div>
  );
}

function CanvasLoadingOverlay() {
  // While hydrate is in flight, edits on the canvas are neither queued for saving nor survive the following
  // setCanvasData(remote) overwrite. So this mask must really swallow pointer events, not just dim visually.
  return (
    <div
      className="absolute inset-0 z-20 cursor-wait bg-bg-dark/10 backdrop-blur-[1px]"
      aria-hidden="true"
    />
  );
}

function CanvasErrorOverlay({
  error,
  onRetry,
}: {
  error: string | null;
  onRetry: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-bg-dark/45 px-6">
      <div className="flex w-full max-w-2xl flex-col gap-3 rounded-xl border border-red-400/25 bg-red-950/[0.14] px-4 py-3 text-sm shadow-[0_18px_60px_rgba(0,0,0,0.28)] backdrop-blur-xl">
        <div className="font-medium text-red-200">{t("freezone.shell.syncFailed")}</div>
        <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded-lg border border-white/[0.06] bg-black/20 px-3 py-2 text-xs leading-5 text-red-100/75">
          {error}
        </div>
        <button
          type="button"
          onClick={onRetry}
          className="self-start rounded-lg border border-red-300/25 bg-red-950/20 px-3 py-1.5 text-xs font-medium text-red-100/80 transition-colors hover:border-red-200/40 hover:bg-red-500/10 hover:text-red-50"
        >
          {t("freezone.shell.retry")}
        </button>
      </div>
    </div>
  );
}

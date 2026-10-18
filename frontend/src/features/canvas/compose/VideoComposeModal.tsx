// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import i18n from "i18next";
import {
  ArrowLeftToLine,
  ArrowRightToLine,
  ChevronDown,
  ChevronUp,
  Copy,
  Download,
  Film,
  Gauge,
  Image as ImageIcon,
  LayoutGrid,
  Loader2,
  Magnet,
  Maximize,
  Minus,
  Music,
  Pause,
  Play,
  Plus,
  Redo2,
  RotateCcw,
  Rows3,
  Split,
  Trash2,
  Undo2,
  Video as VideoIcon,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";

import { useCanvasStore } from "@/stores/canvasStore";
import { resolveImageDisplayUrl } from "@/features/canvas/application/imageData";
import { resolveAudioKind } from "@/features/canvas/application/audioSpeechText";
import {
  isAudioNode,
  isVideoNode,
} from "@/features/canvas/domain/canvasNodes";
import {
  submitFreezoneVideoCompose,
  fetchFreezoneJobResult,
  uploadFreezoneVideo,
  type FreezoneVideoComposeResolution,
} from "@/api/ops";
import { awaitTaskCompletion, isTaskPollTimeoutError } from "@/api/tasks";
import { notifyTaskStillRunning } from "@/features/canvas/application/errorDialog";
import { useViewerImmersiveBody } from "@/features/viewer-kit/useViewerImmersiveBody";
import {
  getCachedAudioPeaks,
  loadAudioPeaks,
  PEAK_BUCKETS_PER_SEC,
} from "./audioPeaks";
import {
  activeClipAt,
  applyProbedDurations,
  buildComposePayload,
  clipLengthMs,
  compactVideoTracks,
  FALLBACK_CLIP_MS,
  hasExportableClips,
  hasOverlappingVideoClips,
  layoutTrack,
  overlappingVideoClipIds,
  packTrackClips,
  reorderIndexForDrag,
  AUDIO_TRACK_ID,
  MIN_CLIP_MS,
  sourceSpanMs,
  timelineDurationMs,
  VIDEO_TRACK_ID,
  type ComposeClip,
  type ComposeCover,
  type ComposeTimelineState,
  type ComposeTrack,
  type ComposeTrackKind,
} from "./timelineModel";
import { CoverEditor } from "./CoverEditor";
import { useComposePlayback } from "./useComposePlayback";
import { getFilmstrip, pickFrame, type FilmstripFrame } from "./filmstrip";

const BACKGROUND_MUSIC_TRACK_ID = `${AUDIO_TRACK_ID}_background_music`;

export interface VideoComposeModalProps {
  project: string;
  canvasId: string;
  /** Ids of the nodes selected on the canvas, used to initialize the timeline (in selection order). */
  seedNodeIds: string[];
  onClose: () => void;
  /** Callback after a successful compose, with the final video url + cover url (null when no cover is set). */
  onComposed: (url: string, coverUrl: string | null) => void;
  /** The last saved draft timeline; when provided it takes priority for initialization (instead of re-laying out from upstream). */
  initialTimeline?: ComposeTimelineState | null;
  /** Passes the current timeline back when the dialog closes, so the host can persist it as a draft. */
  onPersistDraft?: (timeline: ComposeTimelineState) => void;
}

interface SelectedClipRef {
  trackId: string;
  clipId: string;
}

const DEFAULT_PX_PER_SEC = 80;
const MIN_PX_PER_SEC = 20;
const MAX_PX_PER_SEC = 240;
const ZOOM_STEP = 1.5;
const RULER_MIN_SECONDS = 10;
const FILMSTRIP_THUMB_W = 72;
const SNAP_GRID_MS = 500;
const SNAP_PX = 8;
const HISTORY_LIMIT = 50;
const SPEED_MIN = 0.25;
const SPEED_MAX = 4;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function makeClipId(): string {
  return `clip_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makeTrackId(): string {
  return `track_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** Clip duration timecode HH:MM:SS:FF (default 30fps), used for clip labels. */
function formatTimecode(ms: number, fps = 30): string {
  const totalMs = Math.max(0, Math.round(ms));
  const totalSec = Math.floor(totalMs / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  const f = Math.min(fps - 1, Math.floor(((totalMs % 1000) / 1000) * fps));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

/**
 * Probe timeout: when the URL network stalls the element fires neither loadedmetadata nor error, and auto compose
 * would await here forever. A timeout is treated as a probe failure.
 */
export const PROBE_TIMEOUT_MS = 15_000;

/** Probe a media file's intrinsic duration (ms) via an offscreen element. */
function probeMediaDuration(
  url: string,
  kind: ComposeTrackKind,
): Promise<number | null> {
  return new Promise((resolve) => {
    const el = document.createElement(kind === "audio" ? "audio" : "video");
    el.preload = "metadata";
    el.muted = true;
    let settled = false;
    const timer = setTimeout(() => done(null), PROBE_TIMEOUT_MS);
    const done = (value: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.removeAttribute("src");
      try {
        el.load();
      } catch {
        /* ignore */
      }
      resolve(value);
    };
    el.addEventListener(
      "loadedmetadata",
      () => {
        const d = el.duration;
        done(Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : null);
      },
      { once: true },
    );
    el.addEventListener("error", () => done(null), { once: true });
    el.src = resolveImageDisplayUrl(url);
    try {
      el.load();
    } catch {
      done(null);
    }
  });
}

/**
 * For clips whose source duration is unknown (durationMs empty, still laid out with the 5s fallback), probe the real duration and write it back.
 * Auto compose does not go through the dialog and has no probe effect from it, so it must go through here before submitting; otherwise the fallback
 * length would be exported as a trim range (two 10s clips composing to 15s). Throws when a video clip probe fails;
 * better to not compose than to silently truncate.
 */
export async function resolveUnknownClipDurations(
  state: ComposeTimelineState,
): Promise<ComposeTimelineState> {
  const pending = state.tracks.flatMap((track) =>
    track.clips.filter((clip) => clip.durationMs == null),
  );
  if (pending.length === 0) return state;
  const probed = new Map<string, number>();
  await Promise.all(
    pending.map(async (clip) => {
      const durationMs = await probeMediaDuration(clip.sourceUrl, clip.kind);
      if (durationMs != null) {
        probed.set(clip.id, durationMs);
      } else if (clip.kind === "video") {
        throw new Error(
          i18n.t("videoCompose.error.probeFailed", {
            name: clip.displayName ?? clip.sourceUrl,
          }),
        );
      }
    }),
  );
  return applyProbedDurations(state, probed);
}

/** Seed an initial timeline from the selected video/audio canvas nodes. */
export function buildInitialTimeline(seedNodeIds: string[]): ComposeTimelineState {
  const nodes = useCanvasStore.getState().nodes;
  const byId = new Map(nodes.map((node) => [node.id, node] as const));
  const videoClips: ComposeClip[] = [];
  const audioClips: ComposeClip[] = [];
  const backgroundMusicClips: ComposeClip[] = [];
  // Initially lay out clips of the same kind end to end in order (same as the old behavior); they can be dragged freely afterwards.
  let videoCursor = 0;
  let audioCursor = 0;
  const videoStartByWorkflowInstance = new Map<string, number>();

  for (const nodeId of seedNodeIds) {
    const node = byId.get(nodeId);
    if (!node || !isVideoNode(node) || !node.data.videoUrl) continue;
    const durationMs =
      typeof node.data.durationMs === "number" ? node.data.durationMs : null;
    const key = workflowTimelineInstanceKey(node.data);
    if (key) videoStartByWorkflowInstance.set(key, videoCursor);
    videoCursor += durationMs ?? FALLBACK_CLIP_MS;
  }
  const totalVideoDurationMs = videoCursor;
  videoCursor = 0;

  for (const nodeId of seedNodeIds) {
    const node = byId.get(nodeId);
    if (!node) continue;
    if (isVideoNode(node) && node.data.videoUrl) {
      const durationMs =
        typeof node.data.durationMs === "number" ? node.data.durationMs : null;
      const len = durationMs ?? FALLBACK_CLIP_MS;
      videoClips.push({
        id: makeClipId(),
        nodeId,
        kind: "video",
        sourceUrl: node.data.videoUrl,
        displayName: node.data.displayName ?? null,
        thumbUrl: node.data.previewImageUrl ?? null,
        durationMs,
        timelineStartMs: videoCursor,
        trimStartMs: 0,
        trimEndMs: len,
        volume: 1,
        muted: false,
        speed: 1,
      });
      videoCursor += len;
    } else if (isAudioNode(node) && node.data.audioUrl) {
      const durationMs =
        typeof node.data.durationMs === "number" ? node.data.durationMs : null;
      const len = durationMs ?? FALLBACK_CLIP_MS;
      const timelineRole = workflowTimelineRole(node.data);
      const alignedStart =
        timelineRole === "shot_voice"
          ? videoStartByWorkflowInstance.get(workflowTimelineInstanceKey(node.data) ?? "")
          : undefined;
      const clip: ComposeClip = {
        id: makeClipId(),
        nodeId,
        kind: "audio",
        sourceUrl: node.data.audioUrl,
        displayName: node.data.displayName ?? null,
        thumbUrl: null,
        durationMs,
        timelineStartMs:
          timelineRole === "background_music" ? 0 : alignedStart ?? audioCursor,
        trimStartMs: 0,
        trimEndMs:
          timelineRole === "background_music" && totalVideoDurationMs > 0
            ? Math.min(len, totalVideoDurationMs)
            : len,
        volume: timelineRole === "background_music" ? 0.25 : 1,
        muted: false,
        speed: 1,
      };
      if (timelineRole === "background_music") {
        backgroundMusicClips.push(clip);
      } else {
        audioClips.push(clip);
        audioCursor = Math.max(audioCursor, clip.timelineStartMs + len);
      }
    }
  }

  const tracks: ComposeTrack[] = [
    { id: VIDEO_TRACK_ID, kind: "video", clips: videoClips },
  ];
  if (audioClips.length > 0) {
    tracks.push({ id: AUDIO_TRACK_ID, kind: "audio", clips: audioClips });
  }
  if (backgroundMusicClips.length > 0) {
    tracks.push({
      id: BACKGROUND_MUSIC_TRACK_ID,
      kind: "audio",
      clips: backgroundMusicClips,
    });
  }
  return { tracks, resolution: "1080p" };
}

function workflowTimelineCatalog(data: unknown): Record<string, unknown> | null {
  if (!data || typeof data !== "object") return null;
  const catalog = (data as { workflowCatalog?: unknown }).workflowCatalog;
  return catalog && typeof catalog === "object"
    ? catalog as Record<string, unknown>
    : null;
}

function workflowTimelineRole(data: unknown): string {
  const catalog = workflowTimelineCatalog(data);
  if (!catalog) return "";
  const value = catalog.timelineRole;
  if (typeof value === "string" && value) {
    const normalized = value.trim().toLowerCase();
    if (["music", "bgm", "background_music"].includes(normalized)) {
      return "background_music";
    }
    if (["voiceover", "narration", "shot_voice"].includes(normalized)) {
      return "shot_voice";
    }
    return normalized;
  }
  const source = data as Parameters<typeof resolveAudioKind>[0];
  return resolveAudioKind({
    audioKind: source.audioKind,
    workflowCatalog: source.workflowCatalog,
  }) === "music"
    ? "background_music"
    : "";
}

function workflowTimelineInstanceKey(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const record = data as { workflowInstanceId?: unknown };
  const catalog = workflowTimelineCatalog(data);
  const workflowInstanceId =
    typeof record.workflowInstanceId === "string" ? record.workflowInstanceId : "";
  const stepInstance = catalog?.stepInstance;
  if (!workflowInstanceId || typeof stepInstance !== "number") return null;
  return `${workflowInstanceId}:${stepInstance}`;
}

/**
 * Reconcile the draft timeline with the "currently connected upstream":
 *  - clips whose upstream is disconnected (nodeId no longer connected) -> dropped;
 *  - upstreams currently connected but with no matching clip in the draft (newly connected / deleted then reconnected) -> added back;
 *  - clips still connected keep all edits in the draft (trim / order / volume / split).
 * So the compose node's input always equals the materials currently connected on the canvas; no "connected but not shown".
 * Cost: deleting a clip that is still connected gets it added back on reopen - to remove it fully, disconnect the node on the canvas.
 */
export function reconcileDraftWithUpstream(
  draft: ComposeTimelineState,
  seedNodeIds: string[],
): ComposeTimelineState {
  const connected = new Set(seedNodeIds);
  const nodeById = new Map(
    useCanvasStore.getState().nodes.map((node) => [node.id, node] as const),
  );
  // 1) Drop clips whose upstream is disconnected (kept when an external asset's nodeId is empty).
  const tracks: ComposeTrack[] = draft.tracks.map((track) => ({
    ...track,
    clips: track.clips
      .filter((clip) => clip.nodeId == null || connected.has(clip.nodeId))
      .map((clip) => {
        if (!clip.nodeId) return clip;
        const node = nodeById.get(clip.nodeId);
        const sourceUrl =
          clip.kind === "video" && node && isVideoNode(node)
            ? node.data.videoUrl
            : clip.kind === "audio" && node && isAudioNode(node)
              ? node.data.audioUrl
              : null;
        if (!sourceUrl || sourceUrl === clip.sourceUrl) return clip;

        const durationMs =
          typeof node?.data.durationMs === "number" ? node.data.durationMs : null;
        return {
          ...clip,
          sourceUrl,
          displayName: node?.data.displayName ?? clip.displayName,
          thumbUrl:
            clip.kind === "video" && node && isVideoNode(node)
              ? node.data.previewImageUrl ?? null
              : null,
          durationMs,
          trimStartMs: 0,
          trimEndMs: durationMs ?? FALLBACK_CLIP_MS,
        };
      }),
  }));
  // 2) Upstreams connected but without clips in the draft -> generate with the initial layout and append to the end of the matching kind of track.
  const present = new Set(
    tracks
      .flatMap((track) => track.clips.map((clip) => clip.nodeId))
      .filter((id): id is string => Boolean(id)),
  );
  const missing = seedNodeIds.filter((id) => !present.has(id));
  if (missing.length > 0) {
    const fresh = buildInitialTimeline(missing);
    for (const freshTrack of fresh.tracks) {
      if (freshTrack.clips.length === 0) continue;
      const target =
        tracks.find((track) => track.id === freshTrack.id)
        ?? tracks.find((track) => track.kind === freshTrack.kind);
      if (!target) {
        tracks.push(freshTrack);
        continue;
      }
      let cursor = layoutTrack(target).reduce(
        (max, laid) => Math.max(max, laid.timelineEndMs),
        0,
      );
      for (const clip of freshTrack.clips) {
        target.clips.push({ ...clip, timelineStartMs: Math.round(cursor) });
        cursor += clipLengthMs(clip);
      }
    }
  }
  // Video track gap-filling, keeping it seamless.
  return compactVideoTracks({ ...draft, tracks });
}

/**
 * Drive a single <video>/<audio> element off the master playhead. The clock in
 * {@link useComposePlayback} owns progress — this only swaps src at clip
 * boundaries, seeks while scrubbing, mirrors play/pause/volume, and applies the
 * per-clip playback rate (speed change).
 */
function useTrackMediaSync<T extends HTMLMediaElement>(
  ref: RefObject<T | null>,
  track: ComposeTrack | null,
  playheadMs: number,
  isPlaying: boolean,
  forceMuted: boolean,
): void {
  const active = useMemo(
    () => (track ? activeClipAt(track, playheadMs) : null),
    [track, playheadMs],
  );
  const activeRef = useRef(active);
  activeRef.current = active;
  const isPlayingRef = useRef(isPlaying);
  isPlayingRef.current = isPlaying;

  const activeClipId = active?.laid.clip.id ?? null;
  const sourceUrl = active?.laid.clip.sourceUrl ?? null;
  const speed = active?.laid.clip.speed ?? 1;

  // (1) swap source when the active clip changes, then seek once metadata loads.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!sourceUrl) {
      el.pause();
      el.removeAttribute("src");
      delete el.dataset.clipId;
      try {
        el.load();
      } catch {
        /* ignore */
      }
      return;
    }
    // Marks which clip the element is actually loading - the media master clock uses it to verify that the clip used for mapping
    // matches the clip the element is really playing, so a wrong mapping at the instant of a boundary source swap cannot push the playhead back to the previous clip.
    el.dataset.clipId = activeClipId ?? "";
    el.src = resolveImageDisplayUrl(sourceUrl);
    try {
      el.load();
    } catch {
      /* ignore */
    }
    const onReady = () => {
      const a = activeRef.current;
      try {
        el.currentTime = (a ? a.sourceMs : 0) / 1000;
      } catch {
        /* ignore */
      }
      if (isPlayingRef.current) void el.play().catch(() => {});
    };
    el.addEventListener("loadedmetadata", onReady, { once: true });
    return () => el.removeEventListener("loadedmetadata", onReady);
  }, [activeClipId, sourceUrl, ref]);

  // (2) play / pause + per-clip volume + playback rate.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const a = activeRef.current;
    el.volume = a ? a.laid.clip.volume : 1;
    el.muted = forceMuted || (a ? a.laid.clip.muted : false);
    el.playbackRate = speed > 0 ? speed : 1;
    if (isPlaying && activeClipId) void el.play().catch(() => {});
    else el.pause();
  }, [isPlaying, activeClipId, forceMuted, speed, ref]);

  // (3) scrub: while paused, mirror the playhead into the media element. The key is "coalescing seeks": when dragging quickly, do not
  // write currentTime every time, otherwise a flood of seeks jams the decoder and the preview stutters.
  // Approach: always record the latest target time desiredSourceSecRef; while a seek is in progress only update the target and do not
  // issue a new seek; after the seek completes (see the seeked listener below) chase once more if the target changed. This way the picture follows
  // at the fastest speed the decoder can manage, with no pile-up.
  const desiredSourceSecRef = useRef<number | null>(null);
  useEffect(() => {
    if (isPlaying) return;
    const el = ref.current;
    const a = activeRef.current;
    if (!el || !a) return;
    const target = a.sourceMs / 1000;
    desiredSourceSecRef.current = target;
    if (el.seeking || el.readyState < 1) return;
    try {
      el.currentTime = target;
    } catch {
      /* ignore */
    }
    // Dependencies include active: when a clip is dragged to another track with the playhead still (sourceMs changed but playheadMs
    // did not), currentTime must also be realigned, otherwise the preview stays at the old position.
  }, [playheadMs, isPlaying, ref, active]);

  // When a seek completes, if the target moved elsewhere during the drag, chase the latest target immediately. This squeezes the "intermediate seeks
  // piled up during the drag" into "always chase only the last one", the core of a smooth scrub.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onSeeked = () => {
      if (isPlayingRef.current) return;
      const want = desiredSourceSecRef.current;
      if (want != null && Math.abs(el.currentTime - want) > 0.05) {
        try {
          el.currentTime = want;
        } catch {
          /* ignore */
        }
      }
    };
    el.addEventListener("seeked", onSeeked);
    return () => el.removeEventListener("seeked", onSeeked);
  }, [ref]);
}

function SyncedAudioTrack({
  track,
  playheadMs,
  isPlaying,
}: {
  track: ComposeTrack;
  playheadMs: number;
  isPlaying: boolean;
}) {
  const ref = useRef<HTMLAudioElement | null>(null);
  useTrackMediaSync(ref, track, playheadMs, isPlaying, false);
  return <audio ref={ref} className="hidden" />;
}

export function VideoComposeModal({
  project,
  canvasId,
  seedNodeIds,
  onClose,
  onComposed,
  initialTimeline,
  onPersistDraft,
}: VideoComposeModalProps) {
  const { t } = useTranslation();
  // While the compose dialog is open mark it "immersive": the canvas's global shortcuts (Delete node, Cmd+C/Cmd+V, Cmd+Z...)
  // all yield, so pressing Delete in the dialog to delete a clip does not also delete the video compose node on the canvas and pop back to the canvas.
  useViewerImmersiveBody(true);
  const [timeline, setTimeline] = useState<ComposeTimelineState>(() =>
    // If there is a draft, restore it, but reconcile with the "currently connected upstream" (drop disconnected, add back newly connected);
    // with no draft, lay out the upstream materials for the first time.
    initialTimeline && initialTimeline.tracks?.length
      ? reconcileDraftWithUpstream(initialTimeline, seedNodeIds)
      : buildInitialTimeline(seedNodeIds),
  );
  const [past, setPast] = useState<ComposeTimelineState[]>([]);
  const [future, setFuture] = useState<ComposeTimelineState[]>([]);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [snapEnabled, setSnapEnabled] = useState(true);
  // selected = primary selection (drives the speed/volume/split edit panels); selectedIds = all selected clip ids
  // (highlight + bulk delete). Shift/Cmd click adds to selectedIds; a plain click collapses to a single selection.
  const [selected, setSelected] = useState<SelectedClipRef | null>(null);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  // "Projection trail" while dragging: the dragged clip leaves a semi-transparent projection at the drop slot, while a ghost copy
  // floats along with the pointer (libtv / CapCut style). null = no clip is being dragged.
  const [dragGhost, setDragGhost] = useState<{
    clipId: string;
    trackId: string;
    /** Left edge of the ghost copy following the pointer (px, relative to the content area of its track). */
    ghostLeftPx: number;
  } | null>(null);
  // The clip being trimmed (used to float a "trimmed duration" bubble at its edge). null = not trimming.
  const [trimEdit, setTrimEdit] = useState<{
    clipId: string;
    edge: "start" | "end";
  } | null>(null);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [exportDialog, setExportDialog] = useState<{
    open: boolean;
    location: "local" | "canvas";
    resolution: FreezoneVideoComposeResolution;
  }>({ open: false, location: "local", resolution: "1080p" });
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [coverEditorOpen, setCoverEditorOpen] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const trackScrollRef = useRef<HTMLDivElement | null>(null);
  // Cleanup function for the drag in progress (clip move / trim / scrub). Used to: (1) allow only one drag at a time
  // (multi-finger / multi-touch must not attach duplicate listeners); (2) on component unmount (dialog close) clear leftover window listeners,
  // avoiding setState on an unmounted component.
  const activeDragCleanupRef = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      activeDragCleanupRef.current?.();
      activeDragCleanupRef.current = null;
    },
    [],
  );

  // Collapse to a single selection: set both the primary selection and the highlight set to this clip (or clear).
  const selectOnly = useCallback((ref: SelectedClipRef | null) => {
    setSelected(ref);
    setSelectedIds(ref ? new Set([ref.clipId]) : new Set());
  }, []);
  const clearSelection = useCallback(() => {
    setSelected(null);
    setSelectedIds(new Set());
  }, []);
  // Shift/Cmd additive click: add/remove the clip in the highlight set; when adding, make it the primary selection.
  // If the one being removed is the primary selection, selected must be cleared too - otherwise it remains the target of
  // highlight/delete/edit panel, showing up as "shift-click cannot deselect the primary clip".
  const toggleInSelection = useCallback(
    (ref: SelectedClipRef) => {
      const removing = selectedIds.has(ref.clipId);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (removing) next.delete(ref.clipId);
        else next.add(ref.clipId);
        return next;
      });
      if (removing) {
        setSelected((cur) => (cur?.clipId === ref.clipId ? null : cur));
      } else {
        setSelected(ref);
      }
    },
    [selectedIds],
  );

  const pxPerMs = pxPerSec / 1000;
  const pxPerMsRef = useRef(pxPerMs);
  pxPerMsRef.current = pxPerMs;
  const snapRef = useRef(snapEnabled);
  snapRef.current = snapEnabled;
  const timelineRef = useRef(timeline);
  timelineRef.current = timeline;
  // Snapshot of clips copied with Cmd+C (Cmd+V inserts a copy of it).
  const clipboardRef = useRef<ComposeClip | null>(null);

  const durationMs = useMemo(() => timelineDurationMs(timeline), [timeline]);

  // Playhead line driven directly on the DOM: the rAF clock changes transform through this ref every frame, bypassing React re-rendering,
  // so the whole timeline (filmstrip etc.) is no longer re-rendered by the playhead every frame.
  const playheadElRef = useRef<HTMLDivElement>(null);
  const playingRef = useRef(false);
  const positionPlayhead = useCallback((ms: number) => {
    const x = ms * pxPerMsRef.current;
    const el = playheadElRef.current;
    if (el) el.style.transform = `translateX(${x}px)`;
    // While playing, make the timeline follow the playhead smoothly: imperatively change scrollLeft (no React re-render),
    // scrolling only when the playhead nears the left/right edge of the viewport so it stays within the margin - during continuous playback this shows
    // as the timeline following at a steady speed. No follow during manual scrub / paused (playingRef is false).
    if (playingRef.current) {
      const cont = trackScrollRef.current;
      if (cont) {
        const view = cont.clientWidth;
        const margin = Math.min(96, view * 0.2);
        const left = cont.scrollLeft;
        if (x > left + view - margin) cont.scrollLeft = x - view + margin;
        else if (x < left + margin) cont.scrollLeft = Math.max(0, x - margin);
      }
    }
  }, []);

  // The horizontal scrollbar is hidden (ui-scrollbar-vertical); use Ctrl + wheel for horizontal scrolling instead.
  // A native non-passive listener is required to preventDefault the browser's default Ctrl+wheel zoom
  // - React's synthetic onWheel is passive on the root, so preventDefault has no effect.
  useEffect(() => {
    const cont = trackScrollRef.current;
    if (!cont) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      cont.scrollLeft += event.deltaY !== 0 ? event.deltaY : event.deltaX;
    };
    cont.addEventListener("wheel", onWheel, { passive: false });
    return () => cont.removeEventListener("wheel", onWheel);
  }, []);

  // Media master clock while playing: map the playing video element's currentTime back to timeline ms so the playhead line
  // follows the real decoded frame, with picture and line in perfect sync (libtv effect). At boundaries / buffering / no video it returns
  // null and hands control back to wall-clock advance. activeVideoRef is updated below with the active clip.
  const activeVideoRef = useRef<{
    clipId: string;
    timelineStartMs: number;
    timelineEndMs: number;
    trimStartMs: number;
    speed: number;
  } | null>(null);
  const mediaClockMs = useCallback((): number | null => {
    const el = videoRef.current;
    const a = activeVideoRef.current;
    if (!el || !a) return null;
    if (el.paused || el.seeking || el.readyState < 2) return null;
    // The clip the element currently loads must match the clip used for the mapping; when they differ at the instant of a source swap, hand back to wall-clock advance,
    // otherwise the wrong clip's timeline offset would push the playhead back to the previous clip (the picture is already the next one).
    if (el.dataset.clipId !== a.clipId) return null;
    const speed = a.speed > 0 ? a.speed : 1;
    const ms = a.timelineStartMs + (el.currentTime * 1000 - a.trimStartMs) / speed;
    if (ms < a.timelineStartMs - 60 || ms > a.timelineEndMs + 60) return null;
    return ms;
  }, []);

  const { playheadMs, isPlaying, play, toggle, seek } = useComposePlayback(
    durationMs,
    positionPlayhead,
    mediaClockMs,
  );
  // Ref of the current playhead value - lets the shortcut (left/right nudge) read the latest value, so playheadMs need not be a dependency of the
  // keydown effect (which would re-attach the listener every frame during playback).
  const playheadRef = useRef(playheadMs);
  playheadRef.current = playheadMs;

  // Fullscreen playback: request fullscreen on the preview stage container (not the <video> itself) so fullscreen is not exited when a clip swaps source;
  // play the whole timeline from the start.
  const previewStageRef = useRef<HTMLDivElement>(null);
  const handleFullscreenPlay = useCallback(() => {
    const el = previewStageRef.current;
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => {});
    seek(0);
    play();
  }, [play, seek]);
  playingRef.current = isPlaying;

  // When not playing (seek / paused / zoom) React state provides the fallback positioning; while playing it is left to onFrame
  // to drive every frame, avoiding being pulled back by throttled state and jumping.
  useEffect(() => {
    if (!isPlaying) positionPlayhead(playheadMs);
  }, [playheadMs, pxPerSec, isPlaying, positionPlayhead]);

  // The video preview takes the topmost track that has a clip at the playhead; audio tracks mount players separately so narration and background music
  // preview simultaneously on the timeline. The final export is still composed by the backend from all tracks.
  const videoTrack = useMemo(() => {
    const vids = timeline.tracks.filter((track) => track.kind === "video");
    for (let i = vids.length - 1; i >= 0; i -= 1) {
      if (activeClipAt(vids[i], playheadMs)) return vids[i];
    }
    return vids[0] ?? null;
  }, [timeline, playheadMs]);
  const audioTracks = useMemo(
    () =>
      timeline.tracks.filter(
        (track) => track.kind === "audio" && track.clips.length > 0,
      ),
    [timeline],
  );
  const primaryAudioTrack = useMemo(
    () =>
      audioTracks.find((track) => track.id === AUDIO_TRACK_ID) ??
      audioTracks[0] ??
      null,
    [audioTracks],
  );
  const hasAudioTrack = audioTracks.length > 0;

  useTrackMediaSync(videoRef, videoTrack, playheadMs, isPlaying, hasAudioTrack);

  // ── history (undo / redo) ────────────────────────────────────────────────
  const pushHistory = useCallback(() => {
    setPast((prev) => [...prev, timelineRef.current].slice(-HISTORY_LIMIT));
    setFuture([]);
  }, []);

  const undo = useCallback(() => {
    setPast((prev) => {
      if (prev.length === 0) return prev;
      const previous = prev[prev.length - 1];
      setFuture((f) => [timelineRef.current, ...f]);
      setTimeline(previous);
      return prev.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setFuture((prev) => {
      if (prev.length === 0) return prev;
      const next = prev[0];
      setPast((p) => [...p, timelineRef.current].slice(-HISTORY_LIMIT));
      setTimeline(next);
      return prev.slice(1);
    });
  }, []);

  // ── duration probing (no history) ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const pending = timeline.tracks.flatMap((track) =>
      track.clips
        .filter((clip) => clip.durationMs == null)
        .map((clip) => ({ clip, kind: track.kind })),
    );
    if (pending.length === 0) return;
    void Promise.all(
      pending.map(async ({ clip, kind }) => {
        const probed = await probeMediaDuration(clip.sourceUrl, kind);
        if (cancelled || probed == null) return;
        setTimeline((prev) =>
          applyProbedDurations(prev, new Map([[clip.id, probed]])),
        );
      }),
    );
    return () => {
      cancelled = true;
    };
  }, [
    timeline.tracks
      .flatMap((track) => track.clips.map((c) => `${c.id}:${c.durationMs == null}`))
      .join(","),
  ]);

  // ── clip mutations (history-tracked) ─────────────────────────────────────
  const updateClip = useCallback(
    (trackId: string, clipId: string, patch: Partial<ComposeClip>) => {
      setTimeline((prev) => ({
        ...prev,
        tracks: prev.tracks.map((track) =>
          track.id !== trackId
            ? track
            : {
                ...track,
                clips: track.clips.map((clip) =>
                  clip.id === clipId ? { ...clip, ...patch } : clip,
                ),
              },
        ),
      }));
    },
    [],
  );

  // Video track ripple gap-filling: called after delete / trim / speed change to remove gaps (audio tracks untouched).
  const compactVideoNow = useCallback(() => {
    setTimeline((prev) => compactVideoTracks(prev));
  }, []);

  // On dialog close (unmount) pass the current timeline back to the host to save as a draft, restored on reopen/refresh.
  const onPersistDraftRef = useRef(onPersistDraft);
  onPersistDraftRef.current = onPersistDraft;
  useEffect(() => {
    return () => {
      onPersistDraftRef.current?.(timelineRef.current);
    };
  }, []);

  // Set / update the cover (history-tracked) and close the cover editor.
  const applyCover = useCallback(
    (cover: ComposeCover) => {
      pushHistory();
      setTimeline((prev) => ({ ...prev, cover }));
      setCoverEditorOpen(false);
    },
    [pushHistory],
  );

  // Re-lay out from upstream materials (discarding current draft edits) - use it to reset after upstream adds/changes materials.
  const resetToUpstream = useCallback(() => {
    pushHistory();
    setTimeline(buildInitialTimeline(seedNodeIds));
    clearSelection();
  }, [clearSelection, pushHistory, seedNodeIds]);

  // While dragging, magnet-snap the clip's left/right edges to other clips' boundaries or 0 (excluding itself); original value when not snapping.
  const snapClipStart = useCallback(
    (clipId: string, start: number, lengthMs: number): number => {
      if (!snapRef.current) return Math.max(0, start);
      const px = pxPerMsRef.current;
      const targets: number[] = [0];
      for (const tr of timelineRef.current.tracks) {
        for (const l of layoutTrack(tr)) {
          if (l.clip.id === clipId) continue;
          targets.push(l.timelineStartMs, l.timelineEndMs);
        }
      }
      let best = start;
      let bestPx = SNAP_PX;
      for (const b of targets) {
        const dStart = Math.abs(b - start) * px;
        if (dStart < bestPx) {
          bestPx = dStart;
          best = b;
        }
        const dEnd = Math.abs(b - (start + lengthMs)) * px;
        if (dEnd < bestPx) {
          bestPx = dEnd;
          best = b - lengthMs;
        }
      }
      return Math.max(0, best);
    },
    [],
  );

  // Pointer Y hits the target track: inside a same-kind track row -> that track; below all same-kind rows ->
  // "new" (drag out a new row); between rows / above -> null (track unchanged). Hit by DOM row rects.
  const resolveDropTrack = useCallback(
    (kind: ComposeTrackKind, clientY: number): { trackId: string } | "new" | null => {
      const rows = Array.from(
        document.querySelectorAll<HTMLElement>("[data-compose-track-id]"),
      )
        .filter((el) => el.dataset.composeTrackKind === kind)
        .map((el) => ({
          id: el.dataset.composeTrackId as string,
          rect: el.getBoundingClientRect(),
        }))
        .sort((a, b) => a.rect.top - b.rect.top);
      if (rows.length === 0) return null;
      for (const row of rows) {
        if (clientY >= row.rect.top && clientY <= row.rect.bottom) {
          return { trackId: row.id };
        }
      }
      const last = rows[rows.length - 1];
      return clientY > last.rect.bottom ? "new" : null;
    },
    [],
  );

  // Drag the clip body: horizontal changes the time position (no overlap within a track + magnet snap); dragging vertically to a new row creates a new same-kind
  // track to hold it; dragging back to an existing track deletes the newly created, now empty track. A 4px threshold distinguishes click from drag.
  // Uses window listeners (not setPointerCapture) - the DOM is remounted when a clip crosses tracks, so capture would be lost.
  const startClipMove = useCallback(
    (event: ReactPointerEvent, track: ComposeTrack, clip: ComposeClip) => {
      event.stopPropagation();
      event.preventDefault();
      // Shift/Cmd click: add/remove the clip from the selection without starting a drag.
      if (event.shiftKey || event.metaKey || event.ctrlKey) {
        toggleInSelection({ trackId: track.id, clipId: clip.id });
        return;
      }
      if (activeDragCleanupRef.current) return; // A drag is already in progress; ignore the concurrent trigger
      selectOnly({ trackId: track.id, clipId: clip.id });
      const startX = event.clientX;
      const startY = event.clientY;
      const origStart = clip.timelineStartMs;
      const lengthMs = clipLengthMs(clip);
      const kind = clip.kind;
      const clipId = clip.id;
      let currentTrackId = track.id;
      let autoCreatedTrackId: string | null = null;
      let moved = false;
      let rafId = 0;
      let latest = { x: startX, y: startY };

      const apply = () => {
        rafId = 0;
        const { x: clientX, y: clientY } = latest;
        const dxMs = (clientX - startX) / pxPerMsRef.current;
        // Compute the whole frame's result synchronously from the "latest committed state", with defensive skipping before landing -
        // on failure the whole frame does nothing (no state change, no closure variable change) and the clip stays at its last legal position.
        const snapshot = timelineRef.current;
        const fromTrack = snapshot.tracks.find((t) =>
          t.clips.some((c) => c.id === clipId),
        );
        const movingClip = fromTrack?.clips.find((c) => c.id === clipId);
        if (!fromTrack || !movingClip) return;

        const drop = resolveDropTrack(kind, clientY);
        const prevAuto = autoCreatedTrackId;
        const createId = drop === "new" && !prevAuto ? makeTrackId() : null;
        let destId = currentTrackId;
        if (drop === "new") destId = prevAuto ?? (createId as string);
        else if (drop) destId = drop.trackId;

        // resolveDropTrack reads the DOM, which may lag; when it hits a track already deleted from state, skip
        // this frame and never put a clip into a nonexistent track (otherwise after removal there is nowhere to put it -> the clip is lost).
        if (!createId && !snapshot.tracks.some((t) => t.id === destId)) return;

        // Only the "main video track" uses CapCut-style magnet reordering: dragging only decides the insertion order, and the whole track always stays seamless and auto re-flows.
        // Additional video tracks (the second/third dragged out) take the free-positioning branch below and can be placed at any time position;
        // otherwise they would be forced to snap to 0 and could only reorder with same-track clips, showing as "cannot drag".
        if (kind === "video" && destId === VIDEO_TRACK_ID) {
          let tracks = snapshot.tracks.map((t) => ({
            ...t,
            clips: t.clips.filter((c) => c.id !== clipId),
          }));
          if (createId) {
            const srcIdx = tracks.findIndex((t) => t.id === fromTrack.id);
            tracks.splice(srcIdx + 1, 0, { id: createId, kind, clips: [] });
          }
          const destTrack = tracks.find((t) => t.id === destId);
          if (!destTrack) return;
          // siblings take the target track's "current timeline order"; the dragged clip is inserted at the pointer drop position and the whole is re-flowed.
          const siblings = [...destTrack.clips].sort(
            (a, b) => a.timelineStartMs - b.timelineStartMs,
          );
          const index = reorderIndexForDrag(siblings, origStart + dxMs, lengthMs);
          const ordered = [...siblings];
          ordered.splice(index, 0, movingClip);
          const packed = packTrackClips(ordered);
          tracks = tracks.map((t) =>
            t.id === destId ? { ...t, clips: packed } : t,
          );
          if (prevAuto && prevAuto !== destId) {
            tracks = tracks.filter((t) => t.id !== prevAuto || t.clips.length > 0);
          }
          setTimeline((prev) => ({ ...prev, tracks }));
          // The ghost copy follows the pointer (grab point unchanged): the original clip's left edge + pointer displacement.
          const ghostLeftPx = Math.max(
            0,
            origStart * pxPerMsRef.current + (clientX - startX),
          );
          setDragGhost({ clipId, trackId: destId, ghostLeftPx });
          if (createId) autoCreatedTrackId = createId;
          else if (destId !== prevAuto) autoCreatedTrackId = null;
          currentTrackId = destId;
          return;
        }

        // Free-positioning branch (audio tracks + additional video tracks): target position = magnet snap + same-track no-overlap clamp.
        // Overlap prevention only considers clips in "this track", so additional video tracks can be placed at any time (time overlap with the main/other tracks
        // is highlighted by overlappingVideoClipIds and blocked before export, not by stalling the drag here).
        setDragGhost(null); // In free positioning the clip body follows the hand directly; clear any leftover magnet ghost
        const blockingLaid = snapshot.tracks
          .filter((t) => t.id === destId)
          .flatMap((t) => layoutTrack(t))
          .filter((l) => l.clip.id !== clipId);
        let nextStart = snapClipStart(clipId, origStart + dxMs, lengthMs);
        let lo = 0;
        let hi = Number.POSITIVE_INFINITY;
        for (const l of blockingLaid) {
          if (l.timelineStartMs <= nextStart) lo = Math.max(lo, l.timelineEndMs);
          else hi = Math.min(hi, l.timelineStartMs - lengthMs);
        }
        // The gap is too small for the clip (hi < lo) -> skip this frame, keep the last legal position, never overlap.
        if (hi < lo) return;
        nextStart = Math.max(0, clamp(nextStart, lo, hi));

        const placed: ComposeClip = {
          ...movingClip,
          timelineStartMs: Math.round(nextStart),
        };
        let tracks = snapshot.tracks.map((t) => ({
          ...t,
          clips: t.clips.filter((c) => c.id !== clipId),
        }));
        if (createId) {
          const srcIdx = tracks.findIndex((t) => t.id === fromTrack.id);
          tracks.splice(srcIdx + 1, 0, { id: createId, kind, clips: [] });
        }
        tracks = tracks.map((t) =>
          t.id === destId ? { ...t, clips: [...t.clips, placed] } : t,
        );
        // Delete a track newly created in this drag that became empty because the clip left
        if (prevAuto && prevAuto !== destId) {
          tracks = tracks.filter((t) => t.id !== prevAuto || t.clips.length > 0);
        }
        setTimeline((prev) => ({ ...prev, tracks }));

        // Maintain the closure only after a "successful landing": newly created -> remember it; clip left an auto track (pruned) -> clear it,
        // so the next drag of a "new row" does not reuse a deleted id and lose the clip. currentTrackId always points to a valid track.
        if (createId) autoCreatedTrackId = createId;
        else if (destId !== prevAuto) autoCreatedTrackId = null;
        currentTrackId = destId;
      };

      const onMove = (ev: PointerEvent) => {
        if (!moved && Math.hypot(ev.clientX - startX, ev.clientY - startY) < 4) return;
        if (!moved) {
          moved = true;
          pushHistory();
        }
        latest = { x: ev.clientX, y: ev.clientY };
        if (!rafId) rafId = requestAnimationFrame(apply);
      };
      const end = () => {
        if (rafId) cancelAnimationFrame(rafId);
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", end);
        window.removeEventListener("pointercancel", end);
        activeDragCleanupRef.current = null;
        setDragGhost(null); // Hide the drag projection/ghost
        if (!moved) return;
        // Wrap-up: clear all emptied non-default tracks and move the selection to the clip's final track.
        setTimeline((prev) => {
          const tracks = prev.tracks.filter(
            (t) =>
              t.clips.length > 0 ||
              t.id === VIDEO_TRACK_ID ||
              t.id === AUDIO_TRACK_ID,
          );
          return tracks.length === prev.tracks.length ? prev : { ...prev, tracks };
        });
        selectOnly({ trackId: currentTrackId, clipId });
      };
      activeDragCleanupRef.current = end;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", end);
      window.addEventListener("pointercancel", end);
    },
    [pushHistory, resolveDropTrack, selectOnly, snapClipStart, toggleInSelection],
  );

  // Move the clip to a "new row": create a new same-kind track to hold the clip (keeping its time position) and remove it from the original track;
  // clear any non-default tracks that become empty as a result.
  const moveToNewTrack = useCallback(
    (trackId: string, clipId: string) => {
      const src = timelineRef.current.tracks.find((t) => t.id === trackId);
      const clip = src?.clips.find((c) => c.id === clipId);
      if (!src || !clip) return;
      const newTrackId = makeTrackId();
      pushHistory();
      setTimeline((prev) => {
        const source = prev.tracks.find((t) => t.id === trackId);
        const moving = source?.clips.find((c) => c.id === clipId);
        if (!source || !moving) return prev;
        const stripped = prev.tracks.map((t) =>
          t.id === trackId
            ? { ...t, clips: t.clips.filter((c) => c.id !== clipId) }
            : t,
        );
        const idx = stripped.findIndex((t) => t.id === trackId);
        stripped.splice(idx + 1, 0, {
          id: newTrackId,
          kind: source.kind,
          clips: [moving],
        });
        const kept = stripped.filter(
          (t) =>
            t.clips.length > 0 ||
            t.id === VIDEO_TRACK_ID ||
            t.id === AUDIO_TRACK_ID,
        );
        return { ...prev, tracks: kept };
      });
      selectOnly({ trackId: newTrackId, clipId });
    },
    [pushHistory, selectOnly],
  );

  const removeClip = useCallback(
    (trackId: string, clipId: string) => {
      pushHistory();
      setTimeline((prev) => {
        const tracks = prev.tracks
          .map((track) =>
            track.id !== trackId
              ? track
              : {
                  ...track,
                  clips: track.clips.filter((clip) => clip.id !== clipId),
                },
          )
          // Also clear emptied non-default tracks, leaving no empty rows; default video/audio tracks are kept.
          .filter(
            (track) =>
              track.clips.length > 0 ||
              track.id === VIDEO_TRACK_ID ||
              track.id === AUDIO_TRACK_ID,
          );
        // After deletion the video track ripple-fills, so the gap closes automatically (audio tracks stay in place).
        return compactVideoTracks({ ...prev, tracks });
      });
      setSelected((cur) => (cur?.clipId === clipId ? null : cur));
      setSelectedIds((prev) => {
        if (!prev.has(clipId)) return prev;
        const next = new Set(prev);
        next.delete(clipId);
        return next;
      });
    },
    [pushHistory],
  );

  // ── selected clip + playhead-relative source position ────────────────────
  const selectedClip = useMemo(() => {
    if (!selected) return null;
    const track = timeline.tracks.find((tr) => tr.id === selected.trackId);
    const clip = track?.clips.find((c) => c.id === selected.clipId);
    if (!track || !clip) return null;
    const laid = layoutTrack(track).find((l) => l.clip.id === clip.id);
    return laid ? { track, clip, laid } : null;
  }, [selected, timeline]);

  /** Source-time (ms) inside the selected clip at the playhead, or null. */
  const selectedSourceMs = useMemo(() => {
    if (!selectedClip) return null;
    const { clip, laid } = selectedClip;
    if (playheadMs <= laid.timelineStartMs || playheadMs >= laid.timelineEndMs) {
      return null;
    }
    const speed = clip.speed > 0 ? clip.speed : 1;
    return clip.trimStartMs + (playheadMs - laid.timelineStartMs) * speed;
  }, [selectedClip, playheadMs]);

  const canSplitInside =
    selectedSourceMs != null &&
    selectedClip != null &&
    selectedSourceMs > selectedClip.clip.trimStartMs + MIN_CLIP_MS &&
    selectedSourceMs < selectedClip.clip.trimEndMs - MIN_CLIP_MS;

  const splitSelected = useCallback(() => {
    if (!selectedClip || selectedSourceMs == null || !canSplitInside) return;
    const { track, clip } = selectedClip;
    const leftId = makeClipId();
    const rightId = makeClipId();
    pushHistory();
    setTimeline((prev) => ({
      ...prev,
      tracks: prev.tracks.map((tr) => {
        if (tr.id !== track.id) return tr;
        const idx = tr.clips.findIndex((c) => c.id === clip.id);
        if (idx < 0) return tr;
        const speed = clip.speed > 0 ? clip.speed : 1;
        const leftLenMs = (selectedSourceMs - clip.trimStartMs) / speed;
        const left: ComposeClip = { ...clip, id: leftId, trimEndMs: selectedSourceMs };
        const right: ComposeClip = {
          ...clip,
          id: rightId,
          trimStartMs: selectedSourceMs,
          timelineStartMs: clip.timelineStartMs + leftLenMs,
        };
        const clips = [...tr.clips];
        clips.splice(idx, 1, left, right);
        return { ...tr, clips };
      }),
    }));
    selectOnly({ trackId: track.id, clipId: leftId });
  }, [canSplitInside, pushHistory, selectOnly, selectedClip, selectedSourceMs]);

  // Split left / split right - delete the part of the selected clip on one side of the playhead (trim away rather than keep two pieces).
  const trimSelectedToPlayhead = useCallback(
    (side: "left" | "right") => {
      if (!selectedClip || selectedSourceMs == null || !canSplitInside) return;
      const { track, clip } = selectedClip;
      pushHistory();
      updateClip(
        track.id,
        clip.id,
        side === "left"
          ? // Trim away the left half: the kept part starts at the playhead, the left edge moves to the playhead's timeline position (right edge fixed).
            { trimStartMs: selectedSourceMs, timelineStartMs: playheadMs }
          : // Trim away the right half: left edge fixed, only shorten the source out point.
            { trimEndMs: selectedSourceMs },
      );
      // Fill the gap on the video track after trimming one side.
      compactVideoNow();
    },
    [
      canSplitInside,
      compactVideoNow,
      playheadMs,
      pushHistory,
      selectedClip,
      selectedSourceMs,
      updateClip,
    ],
  );

  const setSelectedSpeed = useCallback(
    (speed: number) => {
      if (!selectedClip) return;
      pushHistory();
      updateClip(selectedClip.track.id, selectedClip.clip.id, {
        speed: clamp(speed, SPEED_MIN, SPEED_MAX),
      });
      // A speed change alters the clip's timeline length -> fill gaps on the video track to avoid creating/leaving gaps.
      compactVideoNow();
    },
    [compactVideoNow, pushHistory, selectedClip, updateClip],
  );

  // The volume slider's onChange fires dozens of times in one drag - the history snapshot is pushed only once at gesture start
  // (see VolumePopover's onGestureStart); otherwise a single drag would flush the whole undo stack.
  const setSelectedVolume = useCallback(
    (volume: number) => {
      if (!selectedClip) return;
      const v = clamp(volume, 0, 1);
      // Dragging the volume cancels mute (volume 0 counts as muted), same as CapCut.
      updateClip(selectedClip.track.id, selectedClip.clip.id, {
        volume: v,
        muted: v <= 0,
      });
    },
    [selectedClip, updateClip],
  );

  const toggleSelectedMute = useCallback(() => {
    if (!selectedClip) return;
    pushHistory();
    updateClip(selectedClip.track.id, selectedClip.clip.id, {
      muted: !selectedClip.clip.muted,
    });
  }, [pushHistory, selectedClip, updateClip]);

  // -- Copy / paste / duplicate -----------------------------------------------------
  // Copy sourceClip (new id) and insert it into the target track: on a video track insert after afterClipId and re-flow the whole thing
  // seamlessly; on an audio track append to the end (avoiding overlap with existing clips). Returns the new clip id and selects it.
  const insertDuplicate = useCallback(
    (sourceClip: ComposeClip, trackId: string, afterClipId: string | null) => {
      const copyId = makeClipId();
      pushHistory();
      setTimeline((prev) => ({
        ...prev,
        tracks: prev.tracks.map((tr) => {
          if (tr.id !== trackId) return tr;
          const copy: ComposeClip = { ...sourceClip, id: copyId };
          if (tr.kind === "video") {
            const ordered = [...tr.clips].sort(
              (a, b) => a.timelineStartMs - b.timelineStartMs,
            );
            const idx = afterClipId
              ? ordered.findIndex((c) => c.id === afterClipId)
              : ordered.length - 1;
            ordered.splice(idx + 1, 0, copy);
            return { ...tr, clips: packTrackClips(ordered) };
          }
          // Audio: append to the end of the track, not overlapping existing clips.
          const end = layoutTrack(tr).reduce(
            (m, l) => Math.max(m, l.timelineEndMs),
            0,
          );
          return {
            ...tr,
            clips: [...tr.clips, { ...copy, timelineStartMs: Math.round(end) }],
          };
        }),
      }));
      selectOnly({ trackId, clipId: copyId });
    },
    [pushHistory, selectOnly],
  );

  const duplicateSelected = useCallback(() => {
    if (!selectedClip) return;
    insertDuplicate(selectedClip.clip, selectedClip.track.id, selectedClip.clip.id);
  }, [insertDuplicate, selectedClip]);

  const copySelected = useCallback(() => {
    if (!selectedClip) return;
    clipboardRef.current = { ...selectedClip.clip };
  }, [selectedClip]);

  const pasteClipboard = useCallback(() => {
    const src = clipboardRef.current;
    if (!src) return;
    // Land on the default track of the same type; if the selected clip is also on that track insert right after it, otherwise append.
    const targetTrackId =
      src.kind === "video" ? videoTrack?.id : primaryAudioTrack?.id;
    if (!targetTrackId) return;
    const afterId =
      selectedClip && selectedClip.track.id === targetTrackId
        ? selectedClip.clip.id
        : null;
    insertDuplicate(src, targetTrackId, afterId);
  }, [insertDuplicate, primaryAudioTrack, selectedClip, videoTrack]);

  // Bulk delete all currently selected clips (including the primary selection); after deletion fill gaps on the video track and clear the selection.
  const removeSelected = useCallback(() => {
    const ids = new Set(selectedIds);
    if (selected) ids.add(selected.clipId);
    if (ids.size === 0) return;
    pushHistory();
    setTimeline((prev) => {
      const tracks = prev.tracks
        .map((track) => ({
          ...track,
          clips: track.clips.filter((clip) => !ids.has(clip.id)),
        }))
        .filter(
          (track) =>
            track.clips.length > 0 ||
            track.id === VIDEO_TRACK_ID ||
            track.id === AUDIO_TRACK_ID,
        );
      return compactVideoTracks({ ...prev, tracks });
    });
    clearSelection();
  }, [clearSelection, pushHistory, selected, selectedIds]);

  // ── snapping ──────────────────────────────────────────────────────────────
  const boundaryList = useCallback((): number[] => {
    const out: number[] = [0];
    for (const track of timelineRef.current.tracks) {
      for (const laid of layoutTrack(track)) {
        out.push(laid.timelineStartMs, laid.timelineEndMs);
      }
    }
    return out;
  }, []);

  const snapPlayhead = useCallback(
    (ms: number) => {
      if (!snapRef.current) return ms;
      const px = pxPerMsRef.current;
      let best: number | null = null;
      let bestPx = SNAP_PX;
      for (const boundary of boundaryList()) {
        const d = Math.abs(boundary - ms) * px;
        if (d < bestPx) {
          bestPx = d;
          best = boundary;
        }
      }
      // Magnet-snap to the boundary only when near a clip edge; otherwise return ms as is so the playhead follows the hand with pixel-level continuity.
      // Previously the position was rounded to a 500ms grid here, making dragging jump "every half second" and not follow the hand at all.
      return best != null ? best : ms;
    },
    [boundaryList],
  );

  // ── trim drag ─────────────────────────────────────────────────────────────
  const startTrim = useCallback(
    (
      event: ReactPointerEvent,
      track: ComposeTrack,
      clip: ComposeClip,
      edge: "start" | "end",
    ) => {
      event.stopPropagation();
      event.preventDefault();
      if (activeDragCleanupRef.current) return; // A drag is already in progress; ignore the concurrent trigger
      selectOnly({ trackId: track.id, clipId: clip.id });
      setTrimEdit({ clipId: clip.id, edge });
      pushHistory();
      const startX = event.clientX;
      const origStart = clip.trimStartMs;
      const origEnd = clip.trimEndMs;
      const origTimelineStart = clip.timelineStartMs;
      const speed = clip.speed > 0 ? clip.speed : 1;
      const sourceMaxEnd = clip.durationMs ?? Math.max(origEnd, FALLBACK_CLIP_MS);
      // When stretching right, the clip must not overlap the next adjacent clip on the timeline (video is checked across all video tracks, audio within its own track):
      // clamp the source out point upper bound to the "distance to the next clip start converted back to source duration".
      const nextNeighborStartMs = (() => {
        const blocking = (
          clip.kind === "video"
            ? timelineRef.current.tracks.filter((t) => t.kind === "video")
            : timelineRef.current.tracks.filter((t) => t.id === track.id)
        )
          .flatMap((t) => layoutTrack(t))
          .filter((l) => l.clip.id !== clip.id && l.timelineStartMs >= origTimelineStart);
        return blocking.reduce(
          (min, l) => Math.min(min, l.timelineStartMs),
          Number.POSITIVE_INFINITY,
        );
      })();
      const maxEnd = Number.isFinite(nextNeighborStartMs)
        ? Math.min(
            sourceMaxEnd,
            origStart + (nextNeighborStartMs - origTimelineStart) * speed,
          )
        : sourceMaxEnd;
      const snapSource = (ms: number) =>
        snapRef.current ? Math.round(ms / SNAP_GRID_MS) * SNAP_GRID_MS : ms;
      const onMove = (ev: PointerEvent) => {
        // drag is in timeline px → source ms uses the clip's speed.
        const dms = ((ev.clientX - startX) / pxPerMsRef.current) * speed;
        if (edge === "start") {
          const next = clamp(snapSource(origStart + dms), 0, origEnd - MIN_CLIP_MS);
          // Dragging the left handle: the source in point changes and the left edge shifts with it so the right edge stays fixed.
          const nextTimelineStart = Math.max(
            0,
            Math.round(origTimelineStart + (next - origStart) / speed),
          );
          updateClip(track.id, clip.id, {
            trimStartMs: Math.round(next),
            timelineStartMs: nextTimelineStart,
          });
        } else {
          const next = clamp(snapSource(origEnd + dms), origStart + MIN_CLIP_MS, maxEnd);
          updateClip(track.id, clip.id, { trimEndMs: Math.round(next) });
        }
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        window.removeEventListener("pointercancel", onUp);
        activeDragCleanupRef.current = null;
        setTrimEdit(null); // Hide the trim duration bubble
        // After trimming, ripple-fill the video track to close the gap left by trimming.
        compactVideoNow();
      };
      activeDragCleanupRef.current = onUp;
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
      window.addEventListener("pointercancel", onUp);
    },
    [compactVideoNow, pushHistory, selectOnly, updateClip],
  );

  // ── playhead seek / drag ──────────────────────────────────────────────────
  const seekFromClientX = useCallback(
    (clientX: number) => {
      const cont = trackScrollRef.current;
      if (!cont) return;
      const rect = cont.getBoundingClientRect();
      const x = clientX - rect.left + cont.scrollLeft;
      seek(snapPlayhead(x / pxPerMsRef.current));
    },
    [seek, snapPlayhead],
  );

  // Unified "scrub on press": setPointerCapture locks later move/up to the pressed
  // element, and pointercancel is listened to - the old implementation attached window listeners and only listened to pointerup; on
  // pointercancel (trackpad gesture / pointer taken over by the system etc.) cleanup was missed and the move listener lingered, so
  // moving the mouse over blank areas would still drag the playhead. Pointer capture + the cancel fallback eliminate this leak.
  const startScrub = useCallback(
    (event: ReactPointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (activeDragCleanupRef.current) return; // A drag is already in progress; ignore the concurrent trigger
      const el = event.currentTarget as HTMLElement;
      const pointerId = event.pointerId;
      try {
        el.setPointerCapture(pointerId);
      } catch {
        /* ignore */
      }
      seekFromClientX(event.clientX);
      // Coalesce high-frequency pointermove to once per frame: during a drag only record the latest X and handle it once in rAF.
      // This avoids dozens to hundreds of seeks + setState in one drag flooding the main thread (which would starve decode/paint
      // and show as preview stutter).
      let latestX = event.clientX;
      let rafId = 0;
      const pump = () => {
        rafId = 0;
        seekFromClientX(latestX);
      };
      const onMove = (ev: PointerEvent) => {
        latestX = ev.clientX;
        if (!rafId) rafId = requestAnimationFrame(pump);
      };
      const end = () => {
        if (rafId) cancelAnimationFrame(rafId);
        el.removeEventListener("pointermove", onMove);
        el.removeEventListener("pointerup", end);
        el.removeEventListener("pointercancel", end);
        try {
          el.releasePointerCapture(pointerId);
        } catch {
          /* ignore */
        }
        activeDragCleanupRef.current = null;
        seekFromClientX(latestX); // Land exactly on the last position
      };
      activeDragCleanupRef.current = end;
      el.addEventListener("pointermove", onMove);
      el.addEventListener("pointerup", end);
      el.addEventListener("pointercancel", end);
    },
    [seekFromClientX],
  );

  // ── zoom ───────────────────────────────────────────────────────────────────
  const zoomIn = useCallback(
    () => setPxPerSec((v) => clamp(v * ZOOM_STEP, MIN_PX_PER_SEC, MAX_PX_PER_SEC)),
    [],
  );
  const zoomOut = useCallback(
    () => setPxPerSec((v) => clamp(v / ZOOM_STEP, MIN_PX_PER_SEC, MAX_PX_PER_SEC)),
    [],
  );

  // ── export ──────────────────────────────────────────────────────────────────
  // Fetch the compose output (temporary job URL) as a blob, used as the source for download or re-upload.
  const fetchComposedBlob = useCallback(async (url: string): Promise<Blob> => {
    const resolved = resolveImageDisplayUrl(url) || url;
    const res = await fetch(resolved, { credentials: "include" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.blob();
  }, []);

  const composedFileName = useCallback(
    (url: string) =>
      url.split("?")[0]?.split("/").pop() || `compose-${Date.now()}.mp4`,
    [],
  );

  // Export to local: download the edited video directly to local.
  const exportToLocal = useCallback(
    async (url: string) => {
      const blob = await fetchComposedBlob(url);
      const objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = objectUrl;
      anchor.download = composedFileName(url);
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(objectUrl);
    },
    [composedFileName, fetchComposedBlob],
  );

  // Export to canvas: first persist the composed video as a stable asset via the upload API, then echo it onto this node's compose result.
  const exportToCanvas = useCallback(
    async (url: string, coverUrl?: string | null) => {
      const blob = await fetchComposedBlob(url);
      const uploaded = await uploadFreezoneVideo(
        project,
        blob,
        composedFileName(url),
      );
      onComposed(uploaded.url, coverUrl ?? timelineRef.current.cover?.url ?? null);
    },
    [composedFileName, fetchComposedBlob, onComposed, project],
  );

  const runExport = useCallback(
    async (
      target: "local" | "canvas",
      resolution: FreezoneVideoComposeResolution,
    ) => {
      if (isExporting || !hasExportableClips(timeline)) return;
      // The MVP backend does not support overlapping video compose; block before export and give a clear message instead of letting the backend error.
      if (hasOverlappingVideoClips(timeline)) {
        setExportError(t("videoCompose.error.overlap"));
        return;
      }
      setIsExporting(true);
      setExportError(null);
      try {
        const payload = buildComposePayload(
          { ...timeline, resolution },
          { canvasId, fps: 30 },
        );
        const ref = await submitFreezoneVideoCompose(project, payload);
        await awaitTaskCompletion(ref.task_key, project, {
          taskType: ref.task_type,
        });
        const result = await fetchFreezoneJobResult(
          project,
          "freezone_video_compose",
          ref.job_id,
        );
        if (!result.url) {
          setExportError(t("videoCompose.error.noUrl"));
          return;
        }
        if (target === "local") await exportToLocal(result.url);
        else await exportToCanvas(result.url, result.cover_url);
      } catch (error) {
        // Detaching from listening != compose failure: do not write the red error area, show a neutral message, and keep the task handle
        // queryable in the task center (a compose has no node to hang the handle on, so the user can only be told to retrieve it later).
        if (isTaskPollTimeoutError(error)) {
          console.warn('[video-compose] detached from a still-running compose', {
            taskKey: error.taskKey,
            idleMs: error.idleMs,
          });
          notifyTaskStillRunning(t);
          return;
        }
        setExportError(error instanceof Error ? error.message : String(error));
      } finally {
        setIsExporting(false);
      }
    },
    [canvasId, exportToCanvas, exportToLocal, isExporting, project, t, timeline],
  );

  // Close on Escape (unless a popover/export is busy).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (coverEditorOpen) setCoverEditorOpen(false);
      else if (exportMenuOpen) setExportMenuOpen(false);
      else if (speedOpen) setSpeedOpen(false);
      else if (volumeOpen) setVolumeOpen(false);
      else if (!isExporting) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [coverEditorOpen, exportMenuOpen, isExporting, onClose, speedOpen, volumeOpen]);

  // Edit shortcuts: Space play/pause, Delete delete clip, Cmd+Z/Shift+Cmd+Z undo/redo, Cmd+C/Cmd+V/Cmd+D copy/paste/duplicate,
  // Left/Right nudge the playhead (1 frame, Shift for 1 second). Not intercepted when focus is in an input / the export dialog is open.
  useEffect(() => {
    const FRAME_MS = 1000 / 30;
    const isTyping = (el: EventTarget | null) => {
      const node = el as HTMLElement | null;
      if (!node) return false;
      const tag = node.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        node.isContentEditable
      );
    };
    const onKey = (event: KeyboardEvent) => {
      if (isExporting || exportDialog.open || coverEditorOpen || isTyping(event.target))
        return;
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key;

      if (mod && (key === "z" || key === "Z")) {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
        return;
      }
      if (mod && (key === "y" || key === "Y")) {
        event.preventDefault();
        redo();
        return;
      }
      if (mod && (key === "c" || key === "C")) {
        event.preventDefault();
        copySelected();
        return;
      }
      if (mod && (key === "v" || key === "V")) {
        event.preventDefault();
        pasteClipboard();
        return;
      }
      if (mod && (key === "d" || key === "D")) {
        event.preventDefault();
        duplicateSelected();
        return;
      }
      if (mod) return; // Other modifier combinations are left to the browser/system

      if (key === " " || key === "Spacebar") {
        event.preventDefault();
        toggle();
        return;
      }
      if (key === "Delete" || key === "Backspace") {
        event.preventDefault();
        removeSelected();
        return;
      }
      if (key === "ArrowLeft" || key === "ArrowRight") {
        event.preventDefault();
        const step = (event.shiftKey ? 1000 : FRAME_MS) * (key === "ArrowLeft" ? -1 : 1);
        seek(clamp(playheadRef.current + step, 0, durationMs));
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    copySelected,
    coverEditorOpen,
    duplicateSelected,
    durationMs,
    exportDialog.open,
    isExporting,
    pasteClipboard,
    redo,
    removeSelected,
    seek,
    toggle,
    undo,
  ]);

  const rulerSeconds = Math.max(RULER_MIN_SECONDS, Math.ceil(durationMs / 1000));
  const timelineWidthPx = rulerSeconds * pxPerSec;
  const canExport = hasExportableClips(timeline) && !isExporting;
  // Ids of overlapping video clips on the timeline - used to highlight conflicting clips (red frame) to warn the user.
  const overlapClipIds = useMemo(() => overlappingVideoClipIds(timeline), [timeline]);

  const videoActive = useMemo(
    () => (videoTrack ? activeClipAt(videoTrack, playheadMs) : null),
    [videoTrack, playheadMs],
  );
  // For the media master clock: feed the active video clip's timeline/trim/speed mapping to mediaClockMs.
  activeVideoRef.current = videoActive
    ? {
        clipId: videoActive.laid.clip.id,
        timelineStartMs: videoActive.laid.timelineStartMs,
        timelineEndMs: videoActive.laid.timelineEndMs,
        trimStartMs: videoActive.laid.clip.trimStartMs,
        speed: videoActive.laid.clip.speed > 0 ? videoActive.laid.clip.speed : 1,
      }
    : null;
  const videoSource = useMemo(
    () => (videoActive ? resolveImageDisplayUrl(videoActive.laid.clip.sourceUrl) : null),
    [videoActive],
  );

  const selectedSpeed = selectedClip?.clip.speed ?? 1;
  const selectedSourceSpanMs = selectedClip ? sourceSpanMs(selectedClip.clip) : 0;
  const selectedVolume = selectedClip?.clip.volume ?? 1;
  const selectedMuted = selectedClip?.clip.muted ?? false;

  return createPortal(
    <div className="fixed inset-0 z-[120] flex flex-col bg-bg-dark/95 backdrop-blur-sm">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-border-dark px-5 py-3">
        <div className="flex items-center gap-2 text-text-dark">
          <Film className="h-5 w-5 text-text-muted" />
          <span className="text-sm font-semibold">{t("videoCompose.title")}</span>
        </div>
        <div className="flex items-center gap-3">
          {/* Set cover: a separate entry that opens the cover editor (pick a frame / upload). When a cover is set, a thumbnail shows on the left. */}
          <button
            type="button"
            onClick={() => setCoverEditorOpen(true)}
            disabled={!hasExportableClips(timeline)}
            className="flex items-center gap-2 rounded-full border border-border-dark px-3 py-1.5 text-sm text-text-dark transition-colors hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {timeline.cover?.url ? (
              <img
                src={resolveImageDisplayUrl(timeline.cover.url)}
                alt=""
                className="h-5 w-[34px] rounded-[4px] object-cover"
              />
            ) : (
              <ImageIcon className="h-4 w-4" />
            )}
            {t("videoCompose.cover.button")}
          </button>
          {/* No more 720p/1080p switch: export keeps the source video quality (default 1080p, no downsampling). */}
          {/* Export dropdown: a self-built lightweight popover - the shared Base UI DropdownMenu portals its menu to
          body with a fixed z-50 Positioner, which this dialog's z-[120] fully covers (clicks seem to do nothing).
          Like SpeedPopover, use an in-modal relatively positioned floating layer here to avoid the z conflict. */}
          {/* Expands on hover (not click). onMouseLeave only closes when the pointer leaves the button + menu as a whole:
          the menu is a DOM child of the wrapper, and pt-2 bridges the visual gap so it does not close on the way to the menu. */}
          <div
            className="relative"
            onMouseEnter={() =>
              canExport && !exportDialog.open && setExportMenuOpen(true)
            }
            onMouseLeave={() => setExportMenuOpen(false)}
          >
            <button
              type="button"
              disabled={!canExport}
              className="flex items-center gap-1.5 rounded-full bg-primary px-4 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isExporting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Film className="h-4 w-4" />
              )}
              {isExporting
                ? t("videoCompose.exporting")
                : t("videoCompose.export")}
              <ChevronDown className="h-3.5 w-3.5 opacity-80" />
            </button>
            {exportMenuOpen && canExport && !exportDialog.open && (
              <div className="absolute right-0 top-full z-30 pt-2">
                <div className="min-w-[180px] rounded-lg border border-border-dark bg-surface-dark p-1 shadow-2xl">
                  <div className="px-2 py-1 text-xs text-text-muted">
                    {t("videoCompose.exportLocation")}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false);
                      setExportDialog({ open: true, location: "local", resolution: "1080p" });
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-dark transition-colors hover:bg-white/8"
                  >
                    <Download className="h-4 w-4" />
                    {t("videoCompose.exportToLocal")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setExportMenuOpen(false);
                      setExportDialog({ open: true, location: "canvas", resolution: "1080p" });
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm text-text-dark transition-colors hover:bg-white/8"
                  >
                    <LayoutGrid className="h-4 w-4" />
                    {t("videoCompose.exportToCanvas")}
                  </button>
                </div>
              </div>
            )}
            {/* Export settings dialog: anchored directly below the "Export" button (like libtv), not screen-centered. */}
            {exportDialog.open && (
              <>
                <div
                  className="fixed inset-0 z-[135]"
                  onClick={() =>
                    !isExporting && setExportDialog((d) => ({ ...d, open: false }))
                  }
                />
                <div className="absolute right-0 top-full z-[140] mt-2 w-[360px] rounded-xl border border-border-dark bg-surface-dark p-5 text-left shadow-2xl">
                  <h3 className="mb-4 text-sm font-semibold text-text-dark">
                    {t("videoCompose.exportDialog.title")}
                  </h3>
                  <div className="space-y-3">
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-xs text-text-muted">
                        {t("videoCompose.exportDialog.location")}
                      </span>
                      <select
                        value={exportDialog.location}
                        onChange={(e) =>
                          setExportDialog((d) => ({
                            ...d,
                            location: e.target.value as "local" | "canvas",
                          }))
                        }
                        className="min-w-[160px] rounded-md border border-border-dark bg-bg-dark px-3 py-1.5 text-sm text-text-dark outline-none"
                      >
                        <option value="local">{t("videoCompose.exportToLocal")}</option>
                        <option value="canvas">{t("videoCompose.exportToCanvas")}</option>
                      </select>
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-xs text-text-muted">
                        {t("videoCompose.exportDialog.resolution")}
                      </span>
                      <select
                        value={exportDialog.resolution}
                        onChange={(e) =>
                          setExportDialog((d) => ({
                            ...d,
                            resolution: e.target.value as FreezoneVideoComposeResolution,
                          }))
                        }
                        className="min-w-[160px] rounded-md border border-border-dark bg-bg-dark px-3 py-1.5 text-sm text-text-dark outline-none"
                      >
                        <option value="720p">720P</option>
                        <option value="1080p">1080P</option>
                      </select>
                    </label>
                    <label className="flex items-center justify-between gap-3">
                      <span className="text-xs text-text-muted">
                        {t("videoCompose.exportDialog.format")}
                      </span>
                      <select
                        value="mp4"
                        disabled
                        className="min-w-[160px] cursor-not-allowed rounded-md border border-border-dark bg-bg-dark px-3 py-1.5 text-sm text-text-muted opacity-70 outline-none"
                      >
                        <option value="mp4">MP4</option>
                      </select>
                    </label>
                  </div>
                  <div className="mt-5 flex justify-end gap-2">
                    <button
                      type="button"
                      disabled={isExporting}
                      onClick={() => setExportDialog((d) => ({ ...d, open: false }))}
                      className="rounded-md border border-border-dark px-4 py-1.5 text-sm text-text-dark transition-colors hover:bg-white/[0.06] disabled:opacity-50"
                    >
                      {t("common.cancel")}
                    </button>
                    <button
                      type="button"
                      disabled={isExporting}
                      onClick={() => {
                        const { location, resolution } = exportDialog;
                        setExportDialog((d) => ({ ...d, open: false }));
                        void runExport(location, resolution);
                      }}
                      className="rounded-md bg-primary px-5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                    >
                      {t("common.confirm")}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isExporting}
            className="rounded-full p-1.5 text-text-muted transition-colors hover:bg-surface-dark hover:text-text-dark disabled:opacity-50"
            aria-label={t("common.close")}
          >
            <X className="h-5 w-5" />
          </button>
        </div>
      </header>

      {exportError && (
        <div className="border-b border-red-500/30 bg-red-500/10 px-5 py-2 text-xs text-red-200">
          {t("videoCompose.error.prefix")}: {exportError}
        </div>
      )}

      {/* Preview stage */}
      <div
        ref={previewStageRef}
        className="flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black/60 p-4"
      >
        <video
          ref={videoRef}
          className="max-h-full max-w-full rounded-lg bg-black"
          playsInline
          style={{ display: videoSource ? "block" : "none" }}
        />
        {!videoSource && (
          <div className="text-sm text-text-muted">
            {t("videoCompose.emptyPreview")}
          </div>
        )}
        {audioTracks.map((track) => (
          <SyncedAudioTrack
            key={track.id}
            track={track}
            playheadMs={playheadMs}
            isPlaying={isPlaying}
          />
        ))}
      </div>

      {/* Toolbar */}
      <div className="relative flex items-center justify-between gap-4 border-t border-border-dark px-4 py-2">
        {/* Left: edit actions */}
        <div className="flex items-center gap-0.5">
          <ToolButton icon={Undo2} label={t("videoCompose.undo")} disabled={past.length === 0} onClick={undo} />
          <ToolButton icon={Redo2} label={t("videoCompose.redo")} disabled={future.length === 0} onClick={redo} />
          <ToolDivider />
          <ToolButton icon={Split} label={t("videoCompose.split")} disabled={!canSplitInside} onClick={splitSelected} />
          <ToolButton
            icon={ArrowLeftToLine}
            label={t("videoCompose.splitLeft")}
            disabled={!canSplitInside}
            onClick={() => trimSelectedToPlayhead("left")}
          />
          <ToolButton
            icon={ArrowRightToLine}
            label={t("videoCompose.splitRight")}
            disabled={!canSplitInside}
            onClick={() => trimSelectedToPlayhead("right")}
          />
          <div className="relative">
            <ToolButton
              icon={Gauge}
              label={t("videoCompose.speed")}
              disabled={!selectedClip}
              active={speedOpen}
              onClick={() => setSpeedOpen((open) => !open)}
            />
            {speedOpen && selectedClip && (
              <SpeedPopover
                speed={selectedSpeed}
                sourceSpanMs={selectedSourceSpanMs}
                onChange={setSelectedSpeed}
                onClose={() => setSpeedOpen(false)}
              />
            )}
          </div>
          <div className="relative">
            <ToolButton
              icon={selectedMuted || selectedVolume <= 0 ? VolumeX : Volume2}
              label={t("videoCompose.volume")}
              disabled={!selectedClip}
              active={volumeOpen}
              onClick={() => setVolumeOpen((open) => !open)}
            />
            {volumeOpen && selectedClip && (
              <VolumePopover
                volume={selectedVolume}
                muted={selectedMuted}
                onChange={setSelectedVolume}
                onGestureStart={pushHistory}
                onToggleMute={toggleSelectedMute}
                onClose={() => setVolumeOpen(false)}
              />
            )}
          </div>
          <ToolButton
            icon={Copy}
            label={t("videoCompose.duplicate")}
            disabled={!selectedClip}
            onClick={duplicateSelected}
          />
          <ToolButton
            icon={Trash2}
            label={t("videoCompose.removeClip")}
            disabled={!selectedClip}
            onClick={removeSelected}
          />
        </div>

        {/* Center: transport + snap */}
        <div className="flex items-center gap-3">
          <span className="font-mono text-xs tabular-nums text-text-muted">
            {formatTime(playheadMs)}
          </span>
          <button
            type="button"
            onClick={toggle}
            disabled={durationMs <= 0}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-surface-dark text-text-dark transition-colors hover:bg-bg-dark disabled:opacity-40"
            aria-label={isPlaying ? t("videoCompose.pause") : t("videoCompose.play")}
          >
            {isPlaying ? <Pause className="h-4 w-4" /> : <Play className="h-4 w-4" />}
          </button>
          <span className="font-mono text-xs tabular-nums text-text-muted">
            {formatTime(durationMs)}
          </span>
        </div>

        {/* Right: reset + snap + zoom + fullscreen */}
        <div className="flex items-center gap-1">
          <ToolButton
            icon={RotateCcw}
            label={t("videoCompose.resetToUpstream")}
            onClick={resetToUpstream}
          />
          <ToolDivider />
          <ToolButton
            icon={Magnet}
            label={t("videoCompose.snap")}
            active={snapEnabled}
            onClick={() => setSnapEnabled((v) => !v)}
          />
          <ToolDivider />
          <ToolButton icon={ZoomOutGlyph} label={t("videoCompose.zoomOut")} disabled={pxPerSec <= MIN_PX_PER_SEC} onClick={zoomOut} />
          <input
            type="range"
            min={MIN_PX_PER_SEC}
            max={MAX_PX_PER_SEC}
            step={1}
            value={pxPerSec}
            onChange={(e) => setPxPerSec(Number(e.target.value))}
            className="h-1 w-24 cursor-pointer accent-primary"
            aria-label={t("videoCompose.zoom")}
          />
          <ToolButton icon={ZoomInGlyph} label={t("videoCompose.zoomIn")} disabled={pxPerSec >= MAX_PX_PER_SEC} onClick={zoomIn} />
          <ToolDivider />
          <ToolButton
            icon={Maximize}
            label={t("videoCompose.fullscreenPlay")}
            disabled={durationMs <= 0}
            onClick={handleFullscreenPlay}
          />
        </div>
      </div>

      {/* Timeline */}
      <div className="h-[260px] shrink-0 overflow-hidden border-t border-border-dark bg-surface-dark/40">
        <div ref={trackScrollRef} className="ui-scrollbar-vertical h-full overflow-auto">
          <div className="relative min-h-full" style={{ width: timelineWidthPx, minWidth: "100%" }}>
            {/* Ruler */}
            <div
              className="relative h-7 cursor-pointer select-none border-b border-border-dark"
              onPointerDown={startScrub}
            >
              {Array.from({ length: rulerSeconds + 1 }, (_, sec) => (
                <div
                  key={sec}
                  className="absolute top-0 flex h-full flex-col justify-center"
                  style={{ left: sec * pxPerSec }}
                >
                  <div className="h-2 w-px bg-border-dark" />
                  <span className="ml-1 text-[10px] tabular-nums text-text-muted">
                    {formatTime(sec * 1000)}
                  </span>
                </div>
              ))}
            </div>

            {/* Tracks */}
            <div className="space-y-2 p-2" onPointerDown={() => clearSelection()}>
              {timeline.tracks.map((track) => (
                <TrackRow
                  key={track.id}
                  track={track}
                  pxPerMs={pxPerMs}
                  selectedClipId={selected?.clipId ?? null}
                  selectedIds={selectedIds}
                  overlapClipIds={overlapClipIds}
                  draggingClipId={dragGhost?.clipId ?? null}
                  ghostLeftPx={
                    dragGhost && dragGhost.trackId === track.id
                      ? dragGhost.ghostLeftPx
                      : null
                  }
                  trimmingClipId={trimEdit?.clipId ?? null}
                  trimEdge={trimEdit?.edge ?? null}
                  onStartClipMove={startClipMove}
                  onTrim={startTrim}
                  onMoveToNewTrack={moveToNewTrack}
                  onRemove={removeClip}
                  onToggleMute={(clipId, muted) => {
                    pushHistory();
                    updateClip(track.id, clipId, { muted });
                  }}
                />
              ))}
            </div>

            {/* Playhead (draggable) - position is written imperatively to transform by positionPlayhead,
            not bound to React state, to avoid the whole tree re-rendering and stuttering during playback. translateX goes through the compositor layer
            and does not trigger layout. */}
            <div
              ref={playheadElRef}
              className="pointer-events-none absolute top-0 bottom-0 left-0 z-20"
              // transform is not put into the JSX style: otherwise a throttled state re-render during playback would pull the playhead
              // back to the old position and then onFrame would pull it forward again, causing jitter. The position is always set imperatively.
              style={{ willChange: "transform" }}
            >
              {/* Visible thin vertical line */}
              <div className="pointer-events-none absolute inset-y-0 left-0 w-px bg-primary" />
              {/* Widened transparent grab bar (hit target): covers the full height, centered on the line, so it can be grabbed
              at any height. Only ~11px wide, it sits on the line and moves with it, with minimal impact on clip clicks. */}
              <div
                className="pointer-events-auto absolute inset-y-0 -left-[5px] w-[11px] cursor-ew-resize"
                onPointerDown={startScrub}
              />
              {/* Top dot handle */}
              <div
                className="pointer-events-auto absolute -left-[5px] -top-1 h-3 w-3 cursor-ew-resize rounded-full bg-primary shadow"
                onPointerDown={startScrub}
              />
            </div>
          </div>
        </div>
      </div>

      {coverEditorOpen && (
        <CoverEditor
          project={project}
          timeline={timeline}
          durationMs={durationMs}
          defaultFrameMs={playheadMs}
          cover={timeline.cover ?? null}
          onCancel={() => setCoverEditorOpen(false)}
          onApply={applyCover}
        />
      )}
    </div>,
    document.body,
  );
}

// Wrap zoom icons so ToolButton's `icon` typing stays a single component type.
function ZoomInGlyph(props: { className?: string }) {
  return <Plus {...props} />;
}
function ZoomOutGlyph(props: { className?: string }) {
  return <Minus {...props} />;
}

function ToolDivider() {
  return <div className="mx-1 h-5 w-px bg-border-dark" />;
}

function ToolButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  active,
}: {
  icon: React.ElementType;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={`flex h-8 w-8 items-center justify-center rounded-md transition-colors disabled:cursor-not-allowed disabled:opacity-35 ${
        active
          ? "bg-primary/20 text-primary"
          : "text-text-muted hover:bg-surface-dark hover:text-text-dark"
      }`}
    >
      <Icon className="h-4 w-4" />
    </button>
  );
}

function Stepper({
  value,
  onStep,
}: {
  value: string;
  onStep: (dir: 1 | -1) => void;
}) {
  return (
    <div className="flex items-center gap-1 rounded-md border border-border-dark bg-bg-dark px-2 py-1">
      <span className="min-w-[48px] text-right font-mono text-xs tabular-nums text-text-dark">
        {value}
      </span>
      <div className="flex flex-col">
        <button
          type="button"
          onClick={() => onStep(1)}
          className="text-text-muted transition-colors hover:text-text-dark"
          aria-label="+"
        >
          <ChevronUp className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={() => onStep(-1)}
          className="text-text-muted transition-colors hover:text-text-dark"
          aria-label="−"
        >
          <ChevronDown className="h-3 w-3" />
        </button>
      </div>
    </div>
  );
}

/**
 * Speed popover - multiplier / duration linked both ways. The speed is the single source of truth, duration = source trim length / speed,
 * and adjusting duration in turn gives speed = source length / duration. Both values can be dragged on a slider or stepped up/down.
 */
function SpeedPopover({
  speed,
  sourceSpanMs: span,
  onChange,
  onClose,
}: {
  speed: number;
  sourceSpanMs: number;
  onChange: (speed: number) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const safeSpan = span > 0 ? span : 1;
  const lengthMs = safeSpan / (speed > 0 ? speed : 1);
  // speed ∈ [MIN,MAX] ⇒ length ∈ [span/MAX, span/MIN].
  const minLen = safeSpan / SPEED_MAX;
  const maxLen = safeSpan / SPEED_MIN;

  const setSpeed = (next: number) =>
    onChange(clamp(Math.round(next * 100) / 100, SPEED_MIN, SPEED_MAX));
  const setLength = (nextMs: number) => {
    const len = clamp(nextMs, minLen, maxLen);
    onChange(clamp(safeSpan / len, SPEED_MIN, SPEED_MAX));
  };

  return (
    <div className="absolute bottom-full left-0 z-30 mb-2 w-80 rounded-xl border border-border-dark bg-surface-dark p-4 shadow-2xl">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-text-dark">
          {t("videoCompose.speed")}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-text-muted hover:text-text-dark"
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Multiplier */}
      <div className="mb-3">
        <div className="mb-1 text-xs text-text-muted">
          {t("videoCompose.speedMultiplier")}
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={SPEED_MIN}
            max={SPEED_MAX}
            step={0.01}
            value={speed}
            onChange={(e) => setSpeed(Number(e.target.value))}
            list="video-compose-speed-ticks"
            className="h-1 flex-1 cursor-pointer accent-primary"
          />
          <datalist id="video-compose-speed-ticks">
            <option value="0.5" />
            <option value="1" />
            <option value="2" />
            <option value="3" />
            <option value="4" />
          </datalist>
          <Stepper
            value={`${speed.toFixed(2)}x`}
            onStep={(dir) => setSpeed(speed + dir * 0.05)}
          />
        </div>
      </div>

      {/* Duration */}
      <div>
        <div className="mb-1 text-xs text-text-muted">
          {t("videoCompose.duration")}
        </div>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={minLen}
            max={maxLen}
            step={10}
            value={lengthMs}
            onChange={(e) => setLength(Number(e.target.value))}
            className="h-1 flex-1 cursor-pointer accent-primary"
          />
          <Stepper
            value={`${(lengthMs / 1000).toFixed(1)}s`}
            onStep={(dir) => setLength(lengthMs + dir * 100)}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Volume popover - 0~100% slider + one-click mute. Volume 0 means muted; dragging the slider away from 0 unmutes automatically.
 */
function VolumePopover({
  volume,
  muted,
  onChange,
  onGestureStart,
  onToggleMute,
  onClose,
}: {
  volume: number;
  muted: boolean;
  onChange: (volume: number) => void;
  /** Called when an adjustment gesture starts (pointer down / a single key press) - the host uses it to push history only once. */
  onGestureStart: () => void;
  onToggleMute: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const effective = muted ? 0 : volume;
  const percent = Math.round(effective * 100);
  return (
    <div className="absolute bottom-full left-0 z-30 mb-2 w-72 rounded-xl border border-border-dark bg-surface-dark p-4 shadow-2xl">
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-medium text-text-dark">
          {t("videoCompose.volume")}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-0.5 text-text-muted hover:text-text-dark"
          aria-label={t("common.close")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onToggleMute}
          className="shrink-0 rounded p-1 text-text-muted transition-colors hover:text-text-dark"
          aria-label={muted ? t("videoCompose.unmute") : t("videoCompose.mute")}
          title={muted ? t("videoCompose.unmute") : t("videoCompose.mute")}
        >
          {muted || volume <= 0 ? (
            <VolumeX className="h-4 w-4" />
          ) : (
            <Volume2 className="h-4 w-4" />
          )}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.01}
          value={effective}
          onPointerDown={onGestureStart}
          onKeyDown={(e) => {
            // Keyboard stepping: each independent key press counts as one gesture (holding the key for auto-repeat records only once).
            if (!e.repeat && e.key.startsWith("Arrow")) onGestureStart();
          }}
          onChange={(e) => onChange(Number(e.target.value))}
          className="h-1 flex-1 cursor-pointer accent-primary"
        />
        <span className="min-w-[40px] text-right font-mono text-xs tabular-nums text-text-dark">
          {percent}%
        </span>
      </div>
    </div>
  );
}

/**
 * Tile sampled video frames across a clip's displayed width, windowed to its
 * trim range — the libtv-style filmstrip. Frames are captured once per source
 * and cached, so trimming only re-picks frames (no re-capture).
 */
// libtv-style "loading" placeholder: diagonal-stripe base + label on the left. Laid over the clip when thumbnails / media are not ready.
function ClipLoadingStripe({ label }: { label: string }) {
  return (
    <div
      className="absolute inset-0 flex items-center overflow-hidden"
      style={{
        backgroundImage:
          "repeating-linear-gradient(45deg, rgba(255,255,255,0.05) 0px, rgba(255,255,255,0.05) 8px, rgba(255,255,255,0.11) 8px, rgba(255,255,255,0.11) 16px)",
      }}
    >
      <span className="truncate px-2 text-[10px] text-white/70">{label}</span>
    </div>
  );
}

function ClipFilmstrip({
  sourceUrl,
  trimStartMs,
  trimEndMs,
  width,
}: {
  sourceUrl: string;
  trimStartMs: number;
  trimEndMs: number;
  width: number;
}) {
  const { t } = useTranslation();
  const [frames, setFrames] = useState<FilmstripFrame[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getFilmstrip(sourceUrl)
      .then((result) => {
        if (!cancelled) {
          setFrames(result);
          setLoading(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceUrl]);

  // While thumbnails are still being captured, lay a libtv-style diagonal stripe + "Video loading..." placeholder.
  if (frames.length === 0) {
    return loading ? <ClipLoadingStripe label={t("videoCompose.clipLoading")} /> : null;
  }
  const len = Math.max(1, trimEndMs - trimStartMs);
  const slots = Math.max(1, Math.ceil(width / FILMSTRIP_THUMB_W));
  return (
    <div className="absolute inset-0 flex overflow-hidden">
      {Array.from({ length: slots }, (_, i) => {
        const center = trimStartMs + ((i + 0.5) / slots) * len;
        const frame = pickFrame(frames, center);
        return (
          <div
            key={i}
            className="h-full shrink-0 border-r border-black/20 last:border-r-0"
            style={{ width: FILMSTRIP_THUMB_W }}
          >
            {frame && (
              <img
                src={frame.url}
                alt=""
                className="h-full w-full object-cover"
                draggable={false}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

/**
 * Audio clip waveform - decode the source audio peaks and draw them to a canvas by the trim window, redrawn live with clip width/trim.
 * Peaks have a module-level cache, so the same src is decoded only once. Before decoding finishes the base color (outer gradient) is the fallback.
 */
function ClipWaveform({
  sourceUrl,
  trimStartMs,
  trimEndMs,
  width,
}: {
  sourceUrl: string;
  trimStartMs: number;
  trimEndMs: number;
  width: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(() =>
    getCachedAudioPeaks(sourceUrl),
  );

  useEffect(() => {
    let cancelled = false;
    const cached = getCachedAudioPeaks(sourceUrl);
    if (cached) {
      setPeaks(cached);
      return;
    }
    setPeaks(null);
    loadAudioPeaks(sourceUrl)
      .then((p) => {
        if (!cancelled) setPeaks(p);
      })
      .catch(() => {
        // Decoding failed (CORS / unsupported format) -> keep the base color, draw no waveform.
      });
    return () => {
      cancelled = true;
    };
  }, [sourceUrl]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !peaks || peaks.length === 0) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const h = canvas.clientHeight || 64;
    const w = Math.max(1, Math.round(width));
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const startBucket = (trimStartMs / 1000) * PEAK_BUCKETS_PER_SEC;
    const endBucket = (trimEndMs / 1000) * PEAK_BUCKETS_PER_SEC;
    const span = Math.max(1, endBucket - startBucket);
    const mid = h / 2;
    const maxBar = h * 0.42;
    ctx.fillStyle = "rgba(56, 189, 248, 0.85)";
    for (let x = 0; x < w; x += 1) {
      const b0 = startBucket + (x / w) * span;
      const b1 = startBucket + ((x + 1) / w) * span;
      let peak = 0;
      for (let b = Math.floor(b0); b < Math.max(Math.floor(b0) + 1, Math.ceil(b1)); b += 1) {
        const v = peaks[b] ?? 0;
        if (v > peak) peak = v;
      }
      const bar = Math.max(1, peak * maxBar);
      ctx.fillRect(x, mid - bar, 1, bar * 2);
    }
  }, [peaks, trimStartMs, trimEndMs, width]);

  return (
    <canvas
      ref={canvasRef}
      className="pointer-events-none absolute inset-0 h-full w-full"
    />
  );
}

function TrackRow({
  track,
  pxPerMs,
  selectedClipId,
  selectedIds,
  overlapClipIds,
  draggingClipId,
  ghostLeftPx,
  trimmingClipId,
  trimEdge,
  onStartClipMove,
  onTrim,
  onMoveToNewTrack,
  onRemove,
  onToggleMute,
}: {
  track: ComposeTrack;
  pxPerMs: number;
  selectedClipId: string | null;
  /** All selected clip ids (for highlight); includes several when multi-selected. */
  selectedIds: ReadonlySet<string>;
  overlapClipIds: ReadonlySet<string>;
  /** Id of the clip being dragged (used to draw a semi-transparent projection at the drop spot). */
  draggingClipId: string | null;
  /** Left edge of the ghost copy following the pointer (px); non-null only when the dragged clip is in this track. */
  ghostLeftPx: number | null;
  /** Id of the clip being trimmed (used to float the trimmed-duration bubble at its edge). */
  trimmingClipId: string | null;
  /** The edge being trimmed (start = left / end = right), deciding which side the bubble sticks to. */
  trimEdge: "start" | "end" | null;
  onStartClipMove: (
    event: ReactPointerEvent,
    track: ComposeTrack,
    clip: ComposeClip,
  ) => void;
  onTrim: (
    event: ReactPointerEvent,
    track: ComposeTrack,
    clip: ComposeClip,
    edge: "start" | "end",
  ) => void;
  onMoveToNewTrack: (trackId: string, clipId: string) => void;
  onRemove: (trackId: string, clipId: string) => void;
  onToggleMute: (clipId: string, muted: boolean) => void;
}) {
  const { t } = useTranslation();
  const laid = layoutTrack(track);
  const Icon = track.kind === "video" ? VideoIcon : Music;
  // The clip for the ghost copy floating with the pointer (only when the dragged clip lands in this track).
  const ghostClip =
    ghostLeftPx != null && draggingClipId
      ? track.clips.find((c) => c.id === draggingClipId) ?? null
      : null;
  // Start of the drop slot while dragging (ms) - the bubble shows "will land at mm:ss".
  const ghostStartMs = ghostClip
    ? laid.find((l) => l.clip.id === draggingClipId)?.timelineStartMs ?? 0
    : 0;
  // The clip being trimmed (floats a "trimmed duration" bubble at its edge).
  const trimLaid = trimmingClipId
    ? laid.find((l) => l.clip.id === trimmingClipId) ?? null
    : null;
  return (
    <div className="flex items-center gap-2">
      <div className="flex w-6 shrink-0 justify-center text-text-muted">
        <Icon className="h-4 w-4" />
      </div>
      <div
        className="relative h-16 flex-1"
        data-compose-track-id={track.id}
        data-compose-track-kind={track.kind}
      >
        {laid.length === 0 && (
          <div className="flex h-full items-center rounded-md border border-dashed border-border-dark px-3 text-[11px] text-text-muted">
            {t("videoCompose.trackEmpty")}
          </div>
        )}
        {laid.map(({ clip, timelineStartMs }) => {
          const width = Math.max(24, clipLengthMs(clip) * pxPerMs);
          const isPrimary = clip.id === selectedClipId;
          const isSelected = isPrimary || selectedIds.has(clip.id);
          const isOverlapping = overlapClipIds.has(clip.id);
          // Dragged clip: draw a semi-transparent cyan "projection" at the slot it will land in; the ghost copy floats with the pointer below it.
          const isDragging = clip.id === draggingClipId;
          return (
            <div
              key={clip.id}
              onPointerDown={(event) => onStartClipMove(event, track, clip)}
              title={isOverlapping ? t("videoCompose.error.overlap") : undefined}
              className={`absolute top-0 h-16 cursor-grab overflow-hidden rounded-md border bg-bg-dark transition-[opacity] active:cursor-grabbing ${
                isDragging
                  ? "border-dashed border-cyan-300/80 bg-cyan-400/10 opacity-40"
                  : isOverlapping
                    ? "border-red-400 ring-2 ring-red-400/70"
                    : isSelected
                      ? // Multi-selected clips all get a white outline; the primary selection (driving the edit panel) is outlined brighter.
                        `border-white ring-2 ${isPrimary ? "ring-white" : "ring-white/60"}`
                      : "border-border-dark"
              }`}
              style={{ left: timelineStartMs * pxPerMs, width }}
            >
              {/* Background: filmstrip for video clips, gradient fallback. */}
              <div className="absolute inset-0 bg-gradient-to-r from-primary/25 to-primary/5" />
              {track.kind === "video" && (
                <ClipFilmstrip
                  sourceUrl={clip.sourceUrl}
                  trimStartMs={clip.trimStartMs}
                  trimEndMs={clip.trimEndMs}
                  width={width}
                />
              )}
              {track.kind === "audio" && (
                <ClipWaveform
                  sourceUrl={clip.sourceUrl}
                  trimStartMs={clip.trimStartMs}
                  trimEndMs={clip.trimEndMs}
                  width={width}
                />
              )}
              {/* Scrim so overlaid chips stay legible over bright frames. */}
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/30" />
              <div className="absolute inset-0 flex flex-col justify-between p-1">
                <div className="flex items-center justify-between gap-1">
                  <span className="truncate rounded bg-black/50 px-1 text-[10px] text-white">
                    {clip.speed !== 1
                      ? `${t("videoCompose.speedPrefix")} ${clip.speed.toFixed(2)}X `
                      : ""}
                    {clip.displayName || t(`videoCompose.kind.${track.kind}`)}
                    {" "}
                    {formatTimecode(clipLengthMs(clip))}
                  </span>
                  <div className="flex items-center gap-0.5">
                    {/* Both video and audio clips can be muted individually (for video it mutes its own audio track). */}
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onToggleMute(clip.id, !clip.muted)}
                      className="rounded bg-black/50 p-0.5 text-white/80 hover:text-white"
                      aria-label={clip.muted ? t("videoCompose.unmute") : t("videoCompose.mute")}
                    >
                      {clip.muted ? (
                        <VolumeX className="h-3 w-3" />
                      ) : (
                        <Volume2 className="h-3 w-3" />
                      )}
                    </button>
                    {/* Move to a new row (create a new same-kind track) */}
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onMoveToNewTrack(track.id, clip.id)}
                      className="rounded bg-black/50 p-0.5 text-white/80 hover:text-white"
                      aria-label={t("videoCompose.moveToNewTrack")}
                      title={t("videoCompose.moveToNewTrack")}
                    >
                      <Rows3 className="h-3 w-3" />
                    </button>
                    <button
                      type="button"
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => onRemove(track.id, clip.id)}
                      className="rounded bg-black/50 p-0.5 text-white/80 hover:text-red-300"
                      aria-label={t("videoCompose.removeClip")}
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
                <div className="flex items-center justify-end gap-1">
                  <span className="rounded bg-black/50 px-1 text-[10px] tabular-nums text-white/80">
                    {(clipLengthMs(clip) / 1000).toFixed(1)}s
                  </span>
                </div>
              </div>
              {/* Trim handles — invisible hit areas, faint hint on hover only. */}
              <div
                className="absolute inset-y-0 left-0 z-10 w-2 cursor-ew-resize bg-transparent transition-colors hover:bg-white/30"
                onPointerDown={(e) => onTrim(e, track, clip, "start")}
              />
              <div
                className="absolute inset-y-0 right-0 z-10 w-2 cursor-ew-resize bg-transparent transition-colors hover:bg-white/30"
                onPointerDown={(e) => onTrim(e, track, clip, "end")}
              />
            </div>
          );
        })}

        {/* Drag ghost copy: floats with the pointer (slight lift + shadow + highlighted outline), echoing the cyan projection at the drop spot,
        clearly showing "this clip is being dragged". Display only, all pointer-events off, takes no part in hit-testing. */}
        {ghostClip && ghostLeftPx != null && (
          <div
            className="pointer-events-none absolute top-0 z-30 h-16 -translate-y-1.5 overflow-hidden rounded-md border border-white/90 bg-bg-dark opacity-95 shadow-[0_10px_24px_rgba(0,0,0,0.5)] ring-2 ring-cyan-300/60"
            style={{
              left: ghostLeftPx,
              width: Math.max(24, clipLengthMs(ghostClip) * pxPerMs),
            }}
          >
            <div className="absolute inset-0 bg-gradient-to-r from-primary/25 to-primary/5" />
            {track.kind === "video" && (
              <ClipFilmstrip
                sourceUrl={ghostClip.sourceUrl}
                trimStartMs={ghostClip.trimStartMs}
                trimEndMs={ghostClip.trimEndMs}
                width={Math.max(24, clipLengthMs(ghostClip) * pxPerMs)}
              />
            )}
            <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/45 via-transparent to-black/30" />
            <div className="absolute inset-x-1 top-1">
              <span className="truncate rounded bg-black/55 px-1 text-[10px] text-white">
                {ghostClip.displayName || t(`videoCompose.kind.${track.kind}`)}
                {" "}
                {formatTimecode(clipLengthMs(ghostClip))}
              </span>
            </div>
          </div>
        )}

        {/* Drag time bubble: the timecode of the drop start, following the ghost copy. */}
        {ghostClip && ghostLeftPx != null && (
          <div
            className="pointer-events-none absolute top-0 z-40 -translate-y-[18px] rounded bg-cyan-500/90 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white shadow"
            style={{ left: ghostLeftPx }}
          >
            {formatTimecode(ghostStartMs)}
          </div>
        )}

        {/* Trim duration bubble: sticks to the trimmed edge and shows the trimmed clip duration live. */}
        {trimLaid && (
          <div
            className="pointer-events-none absolute top-0 z-40 rounded bg-cyan-500/90 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white shadow"
            style={{
              left:
                trimEdge === "end"
                  ? trimLaid.timelineEndMs * pxPerMs
                  : trimLaid.timelineStartMs * pxPerMs,
              transform:
                trimEdge === "end"
                  ? "translate(-100%, -18px)"
                  : "translate(0, -18px)",
            }}
          >
            {formatTimecode(clipLengthMs(trimLaid.clip))}
          </div>
        )}
      </div>
    </div>
  );
}

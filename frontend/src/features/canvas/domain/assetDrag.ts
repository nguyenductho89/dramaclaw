// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { CANVAS_NODE_TYPES, type CanvasNodeData } from "./canvasNodes";
import { coerceSlotTarget } from "./mainlineNodeTypes";
import type { useCanvasStore } from "@/stores/canvasStore";
import type { DirectorWorldSource } from "@/features/viewer-kit/three-d/directorManifest";
import type { ThreeDSceneSnapshot } from "@/features/viewer-kit/three-d/engine/viewerApp";

/**
 * Custom drag MIME - the payload type carried through dataTransfer when a sidebar asset card is dragged into the canvas.
 * A dedicated type rather than text/plain, to avoid mis-triggering with system file drops / text drops.
 */
export const CANVAS_ASSET_DRAG_MIME = "application/x-freezone-asset";

export type CanvasAssetDragKind = "image" | "video" | "audio" | "model";

/**
 * The minimal description serialized when a sidebar asset is dragged into the canvas. All fields are plain data (JSON-serializable),
 * and after landing {@link spawnAssetNode} restores it into a canvas node of the matching type.
 */
export interface CanvasAssetDragPayload {
  kind: CanvasAssetDragKind;
  label: string;
  /**
   * The prompt of a generation-type node (video / image). Brought over from the matching record by the history "Use" flow, used to backfill
   * the new node's prompt box; sidebar drags / live-canvas copies do not carry this field (label is a display name, not a prompt).
   */
  prompt?: string;
  /**
   * Set true only by history "Use": indicates this is a "generation product" rather than an uploaded reference image. Images are restored accordingly into
   * a finished "image node" (imageGen) - bringing back the prompt, adapting the ratio to the image, and showing the resolution badge;
   * when unset (ordinary drag / asset library reference image) an upload node is still built (replace material).
   */
  restoreAsGeneratedImage?: boolean;
  /** Registry model id of the original generation (for restoration). */
  model?: string;
  /** Original generation mode (for restoration). */
  genMode?: string;
  url: string;
  aspectRatio?: string;
  /** 3GS borrows the cover image of the same scene; empty for other types. */
  coverUrl?: string | null;
  /** Director World source list for scene assets that aggregate pano + SOG sources. */
  modelSources?: DirectorWorldSource[];
  activeSourceId?: string | null;
  plyUrl?: string | null;
  panoUrl?: string | null;
  scene?: ThreeDSceneSnapshot | null;
  scenesBySourceId?: Record<string, ThreeDSceneSnapshot>;
  /** 3GS source file name (derived from rel_path); other types fall back to label. */
  sourceFileName?: string;
  /** __freezone_source passed through to the node (for commit / replace provenance). */
  source: Record<string, unknown>;
  /** The mainline_context array (optional). */
  mainlineContext?: unknown[];
}

type CanvasStore = ReturnType<typeof useCanvasStore.getState>;

/**
 * Generate a canvas node at the given coordinates by payload type, returning the new node id.
 * The "Add" button (viewport center) and the drag drop point share the same node construction, avoiding a fork in the two places.
 * Note: this function only builds the node; focusing / selecting is decided by the caller (the button focuses, a drop selects).
 */
export function spawnAssetNode(
  store: CanvasStore,
  payload: CanvasAssetDragPayload,
  position: { x: number; y: number },
): string {
  const mainlineData =
    payload.mainlineContext && payload.mainlineContext.length
      ? { mainline_context: payload.mainlineContext }
      : {};
  const sourceMeta = { ...payload.source };
  const slotTarget = coerceSlotTarget(sourceMeta.slot_target);
  const slotData = slotTarget
    ? { slot_target: slotTarget, committed_slot_url: payload.url }
    : {};
  const directorControlBundle =
    sourceMeta.director_control_bundle && typeof sourceMeta.director_control_bundle === "object"
      ? { director_control_bundle: sourceMeta.director_control_bundle }
      : {};
  const candidateData = { user_spawned: true as const };

  switch (payload.kind) {
    case "model": {
      const modelSources = payload.modelSources?.length ? payload.modelSources : undefined;
      const activeSource =
        modelSources?.find((source) => source.id && source.id === payload.activeSourceId) ??
        modelSources?.find((source) => source.current) ??
        modelSources?.[0];
      const activePlyUrl =
        activeSource?.ply_url ??
        (activeSource?.source_type === "sog" ? activeSource.url : undefined);
      const activePanoUrl =
        activeSource?.pano_url ??
        (activeSource?.source_type === "pano360" ? activeSource.url : undefined);
      const plyUrl = payload.plyUrl ?? activePlyUrl ?? (modelSources ? null : payload.url);
      const panoUrl = payload.panoUrl ?? activePanoUrl ?? null;
      return store.addNode(
        CANVAS_NODE_TYPES.threeDWorld,
        position,
        {
          displayName: payload.label,
          plyUrl,
          panoUrl,
          sources: modelSources,
          activeSourceId: payload.activeSourceId ?? activeSource?.id ?? null,
          scene: payload.scene ?? null,
          scenesBySourceId: payload.scenesBySourceId,
          previewImageUrl: payload.coverUrl ?? null,
          sourceFileName: payload.sourceFileName ?? payload.label,
          __freezone_source: sourceMeta,
          ...candidateData,
          ...directorControlBundle,
          ...mainlineData,
          ...slotData,
        } as Record<string, unknown> as Partial<CanvasNodeData>,
      );
    }
    case "video":
      return store.addNode(
        CANVAS_NODE_TYPES.video,
        position,
        {
          displayName: payload.label,
          videoUrl: payload.url,
          previewImageUrl: null,
          aspectRatio: payload.aspectRatio,
          sourceFileName: payload.label,
          // When history "Use" brings the record's original prompt, backfill it into the video node's prompt box;
          // with no prompt (drag/live-canvas) do not write it, keeping the placeholder.
          ...(payload.prompt ? { prompt: payload.prompt } : {}),
          // When history "Use" brings the original registry model / generation mode, backfill them so the restored video node is consistent with
          // the original generation (VideoNode reads data.model / data.genMode); when absent do not write, using the node default.
          ...(payload.model ? { model: payload.model } : {}),
          ...(payload.genMode ? { genMode: payload.genMode } : {}),
          __freezone_source: sourceMeta,
          ...candidateData,
          ...directorControlBundle,
          ...mainlineData,
          ...slotData,
        } as Record<string, unknown> as Partial<CanvasNodeData>,
      );
    case "audio":
      return store.addNode(
        CANVAS_NODE_TYPES.audio,
        position,
        {
          displayName: payload.label,
          audioUrl: payload.url,
          sourceFileName: payload.label,
          __freezone_source: sourceMeta,
          ...candidateData,
          ...directorControlBundle,
          ...mainlineData,
          ...slotData,
        } as Record<string, unknown> as Partial<CanvasNodeData>,
      );
    case "image":
    default:
      // History "Use" restoring a generation product -> build a finished "image node" (imageGen): bringing back the prompt and the operation area,
      // with onLoad adapting the ratio to the image's natural size and showing the resolution badge (see ImageGenNode). Writing
      // committed_* makes it consistent with the node fields that land after generation completes (the finished image is shown directly and can be regenerated).
      // Ordinary drags / asset library reference images (without this marker) still build upload nodes (replace material).
      if (payload.restoreAsGeneratedImage) {
        return store.addNode(
          CANVAS_NODE_TYPES.imageGen,
          position,
          {
            displayName: payload.label,
            imageUrl: payload.url,
            previewImageUrl: payload.url,
            committed_at: new Date().toISOString(),
            committed_slot_url: payload.url,
            ...(payload.prompt ? { prompt: payload.prompt } : {}),
            // When history "Use" brings the original registry model id, backfill it so the restored finished image node uses the same
            // model as the original generation (ImageGenNode reads data.model); when absent do not write, and the node seeds its default model itself.
            ...(payload.model ? { model: payload.model } : {}),
            __freezone_source: sourceMeta,
            ...candidateData,
            ...directorControlBundle,
            ...mainlineData,
            ...slotData,
          } as Record<string, unknown> as Partial<CanvasNodeData>,
        );
      }
      return store.addNode(
        CANVAS_NODE_TYPES.upload,
        position,
        {
          displayName: payload.label,
          imageUrl: payload.url,
          previewImageUrl: payload.url,
          aspectRatio: payload.aspectRatio,
          sourceFileName: payload.label,
          __freezone_source: sourceMeta,
          ...candidateData,
          ...directorControlBundle,
          ...mainlineData,
          ...slotData,
        } as Record<string, unknown> as Partial<CanvasNodeData>,
      );
  }
}

/** Parse the asset drag payload from dataTransfer; returns null for a non-asset drag. */
export function readAssetDragPayload(
  dataTransfer: DataTransfer,
): CanvasAssetDragPayload | null {
  const raw = dataTransfer.getData(CANVAS_ASSET_DRAG_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CanvasAssetDragPayload;
    if (!parsed || typeof parsed.url !== "string" || !parsed.url) return null;
    return parsed;
  } catch {
    return null;
  }
}

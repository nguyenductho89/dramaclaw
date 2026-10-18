// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// This uses the default i18next instance (the one `@/i18n` initializes). `@/i18n` itself is not imported,
// because that module also pulls in react-i18next / HttpBackend, and putting it on this widely imported low-level chain
// would make every test that mocks react-i18next blow up at import time.
import i18n from 'i18next';
import { create } from 'zustand';
import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

/** The media type used for "same type" matching when dragging a node -> asset. */
export type DropMediaType = 'image' | 'video' | 'audio' | 'model';

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

function sourceRecordUrl(record: Record<string, unknown>): string | null {
  for (const key of ['url', 'ply_url', 'pano_url', 'fs', 'pano_fs']) {
    const value = record[key];
    if (typeof value === 'string' && value) return value;
  }
  return null;
}

export function modelSourceUrlFromNodeData(data: Record<string, unknown>): string | null {
  const str = (key: string): string | null => stringValue(data[key]);
  const sources = Array.isArray(data.sources) ? data.sources : [];
  const records = sources.filter((source): source is Record<string, unknown> =>
    Boolean(source && typeof source === 'object'),
  );
  const activeSourceId = str('activeSourceId');
  const activeSource = activeSourceId
    ? records.find((source) => source.id === activeSourceId)
    : undefined;
  return (
    (activeSource ? sourceRecordUrl(activeSource) : null) ??
    sourceRecordUrl(records.find((source) => source.current === true) ?? {}) ??
    sourceRecordUrl(records[0] ?? {}) ??
    str('plyUrl') ??
    str('modelUrl') ??
    str('fileUrl') ??
    str('panoUrl')
  );
}

/**
 * Infer from a canvas node the media type and resource address usable for "drag to replace material".
 * Only image/video/audio/3GS model nodes can take part in replacement; the rest return null.
 */
export function deriveNodeDropInfo(node: CanvasNode): {
  mediaType: DropMediaType;
  sourceUrl: string | null;
  /** Thumbnail address for the drag preview overlay (the image itself / the cover of a video or model); audio has no thumbnail. */
  thumbUrl: string | null;
  label: string;
  /** If the node still carries the full director bundle, commit writes back by the bundle first; ordinary images are packaged at the commit layer. */
  directorControlBundle: Record<string, unknown> | null;
} | null {
  const data = (node.data ?? {}) as Record<string, unknown>;
  const str = (key: string): string | null =>
    stringValue(data[key]);
  const label = str('displayName') ?? str('sourceFileName') ?? i18n.t('canvas.assetDrop.fallbackNodeLabel');
  const directorControlBundle =
    data.director_control_bundle && typeof data.director_control_bundle === 'object'
      ? (data.director_control_bundle as Record<string, unknown>)
      : null;

  switch (node.type) {
    case CANVAS_NODE_TYPES.video:
      return {
        mediaType: 'video',
        sourceUrl: str('videoUrl'),
        thumbUrl: str('previewImageUrl'),
        label,
        directorControlBundle,
      };
    case CANVAS_NODE_TYPES.audio:
      return { mediaType: 'audio', sourceUrl: str('audioUrl'), thumbUrl: null, label, directorControlBundle };
    case CANVAS_NODE_TYPES.threeDWorld:
      return {
        mediaType: 'model',
        sourceUrl: modelSourceUrlFromNodeData(data),
        thumbUrl: str('previewImageUrl') ?? str('coverUrl'),
        label,
        directorControlBundle,
      };
    case CANVAS_NODE_TYPES.upload:
    case CANVAS_NODE_TYPES.imageEdit:
    case CANVAS_NODE_TYPES.imageGen:
    case CANVAS_NODE_TYPES.exportImage:
    case CANVAS_NODE_TYPES.storyboardGen:
    case CANVAS_NODE_TYPES.pano360Viewer: {
      const imageUrl = str('imageUrl') ?? str('previewImageUrl');
      return { mediaType: 'image', sourceUrl: imageUrl, thumbUrl: imageUrl, label, directorControlBundle };
    }
    default:
      return null;
  }
}

export interface ActiveNodeDrag {
  /** The id of the canvas node being dragged. */
  nodeId: string;
  /** The node's media type, used for same-type matching with sidebar assets. */
  mediaType: DropMediaType;
  /** The resource address the node can currently submit (image/video/audio/model). */
  sourceUrl: string | null;
  /** Thumbnail address for the drag preview overlay; null when there is none, such as for audio. */
  thumbUrl: string | null;
  /** The node display name, used for confirmation text. */
  label: string;
  directorControlBundle: Record<string, unknown> | null;
}

/** The replace request sent to the sidebar after a canvas node is dragged onto a sidebar asset and released. */
export interface PendingAssetReplace {
  assetId: string;
  nodeId: string;
  sourceUrl: string;
  label: string;
  directorControlBundle: Record<string, unknown> | null;
  /** A monotonically increasing signal, ensuring the same combination can trigger repeatedly. */
  token: number;
}

interface AssetDropState {
  /** Info of the node currently being dragged; null when not dragging. */
  activeDrag: ActiveNodeDrag | null;
  /** The id of the asset currently hovered with a matching type; used by the sidebar to draw a dashed frame. */
  hoverAssetId: string | null;
  /** The replace request produced after release; the sidebar clears it after consuming. */
  pendingReplace: PendingAssetReplace | null;

  beginDrag: (drag: ActiveNodeDrag) => void;
  setHoverAsset: (assetId: string | null) => void;
  /** End the drag. If commit=true and the current hover is valid, generate a pendingReplace. */
  endDrag: (commit: boolean) => void;
  clearPendingReplace: () => void;
}

let replaceToken = 0;

export const useAssetDropStore = create<AssetDropState>((set, get) => ({
  activeDrag: null,
  hoverAssetId: null,
  pendingReplace: null,

  beginDrag: (drag) => set({ activeDrag: drag, hoverAssetId: null }),

  setHoverAsset: (assetId) => {
    if (get().hoverAssetId === assetId) return;
    set({ hoverAssetId: assetId });
  },

  endDrag: (commit) => {
    const { activeDrag, hoverAssetId } = get();
    if (commit && activeDrag && hoverAssetId && activeDrag.sourceUrl) {
      replaceToken += 1;
      set({
        pendingReplace: {
          assetId: hoverAssetId,
          nodeId: activeDrag.nodeId,
          sourceUrl: activeDrag.sourceUrl,
          label: activeDrag.label,
          directorControlBundle: activeDrag.directorControlBundle,
          token: replaceToken,
        },
        activeDrag: null,
        hoverAssetId: null,
      });
      return;
    }
    set({ activeDrag: null, hoverAssetId: null });
  },

  clearPendingReplace: () => set({ pendingReplace: null }),
}));

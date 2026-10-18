// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Lightweight shell for nodes at the canvas low-zoom tier (zoom < LOW_DETAIL_ZOOM_THRESHOLD).
 *
 * Why it exists: measured (300 nodes / zoom 0.1) fast panning ran at only ~20fps, and the main-thread time was neither in
 * JS nor in painting (hiding all images left the frame rate unchanged, and so did visibility:hidden on whole nodes); it was in
 * "after each frame's transform change, the rendering pipeline walks all ~13.5k live elements under the moved subtree" — the cost
 * is proportional to the render tree size and independent of what is drawn. After replacing each node's ~45 elements with the ~4 here,
 * the same canvas measured back at full frame rate (75fps).
 *
 * Why "replace rendering" rather than CSS content-visibility: for nodes that are already hidden at mount,
 * React Flow's first measurement writes the handle's all-zero getBoundingClientRect as "present but wrong"
 * handleBounds (@xyflow/system getHandleBounds), so edges all anchor to the viewport's top-left and never
 * self-heal (ResizeObserver only watches the root box size). The shell renders real <Handle>s, with positions identical to the full
 * component (Left/Right + vertically centered, id always 'target'/'source', and global CSS already
 * sets opacity:0), so the first measurement is naturally correct and switching tiers needs no forced re-measure.
 *
 * For exemptions see LOD_SHELL_EXEMPT_TYPES in [[canvasLod]] and the media-active signal.
 */
import {
  memo,
  useEffect,
  useState,
  useSyncExternalStore,
  type ComponentType,
  type CSSProperties,
} from 'react';
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react';

import {
  LOD_SHELL_EXEMPT_TYPES,
  isCanvasGestureActive,
  isCanvasHydrateBurstActive,
  isLowDetailZoom,
  isNodeMediaActive,
  requestShellUpgrade,
} from '@/features/canvas/application/canvasLod';
import { useCanvasStore } from '@/stores/canvasStore';
import { ReferencePickNodeOverlay } from '@/features/canvas/ui/ReferencePickNodeOverlay';
import { AssetMigrationNodeOverlay } from '@/features/canvas/ui/AssetMigrationNodeOverlay';
import { ForeignMediaNodeOverlay } from '@/features/canvas/ui/ForeignMediaNodeOverlay';
import {
  getLodStill,
  requestLodStill,
  subscribeLodStills,
} from '@/features/canvas/application/videoFrameCapture';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { useNodeBodyVariant } from '@/features/canvas/hooks/useNodeBodyVariantBudget';
import { withMediaVariant, type MediaVariant } from '@/lib/media-url';
import {
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import type { CanvasNodeType } from '@/features/canvas/domain/canvasNodes';

/**
 * Fallback size for nodes that are unmeasured and have no explicit size (restored at first paint in the low-zoom tier and never rendered).
 * Aligned with each component's DEFAULT_WIDTH/HEIGHT; it only affects the first-frame box size, and once zoomed in across the tier the full component
 * renders and triggers a ResizeObserver re-measure that corrects it automatically.
 */
// Exported only so tests can ratchet: a new node type must either register its size here or join the LOD exemption list,
// otherwise it gets the generic 400×300 fallback and the box is visibly wrong at first paint in low zoom.
export const SHELL_FALLBACK_SIZES: Partial<Record<string, { width: number; height: number }>> = {
  vectorSvgNode: { width: 360, height: 192 },
  animatedGifNode: { width: 360, height: 192 },
  htmlArtifactNode: { width: 384, height: 226 },
  uploadNode: { width: 320, height: 350 },
  imageNode: { width: 580, height: 360 },
  imageGenNode: { width: 580, height: 360 },
  exportImageNode: { width: 533, height: 300 },
  videoNode: { width: 580, height: 380 },
  textAnnotationNode: { width: 440, height: 320 },
  scriptNode: { width: 480, height: 320 },
  audioNode: { width: 480, height: 210 },
  videoStoryNode: { width: 720, height: 360 },
  videoComposeNode: { width: 240, height: 136 },
  pano360ViewerNode: { width: 900, height: 540 },
  threeDWorldNode: { width: 340, height: 210 },
  storyboardNode: { width: 800, height: 600 },
  storyboardGenNode: { width: 800, height: 600 },
  styleNode: { width: 220, height: 124 },
};

const DEFAULT_SHELL_SIZE = { width: 400, height: 300 };

type ShellData = {
  imageUrl?: string | null;
  previewImageUrl?: string | null;
  referenceImageUrl?: string | null;
  videoUrl?: string | null;
  isGenerating?: boolean;
  isUploading?: boolean;
};

/**
 * Which variant tier the image in the shell is fed, picked by how many device pixels this cell actually needs.
 *
 * The shell appears only at zoom < 0.35, where even the widest node (900px) takes only 315 CSS px on screen,
 * and the common imageNode only 203 px; yet this tier is exactly when there are the most nodes — dozens to hundreds
 * on one screen. Decode cost depends only on source pixel count, so the original is pure waste here: one 5504x3072 pays
 * 16.9MP, versus 0.06MP for a 320px variant.
 *
 * The frontend only requests the 320px thumb that production pre-warms. Nodes over budget use the original in the node body; the LOD shell
 * still always falls back to the thumb, because it is used only at low zoom with many nodes at once, avoiding decoding dozens
 * to hundreds of full originals at the same time.
 *
 * When a variant does not apply (blob: preview, legacy path, captured-frame data:) withMediaVariant returns as is,
 * behaving as before the change. The shell has no onLoad, does not measure size, and does not enter the viewer/export, so here there is
 * none of the node body's concern about "knowing the real size before swapping".
 */
function resolveShellImage(
  type: string,
  data: ShellData,
  variant: MediaVariant,
): string | null {
  const pick = (...candidates: Array<string | null | undefined>) => {
    for (const c of candidates) {
      if (c) return withMediaVariant(resolveImageDisplayUrl(c), variant);
    }
    return null;
  };
  switch (type) {
    case 'imageGenNode':
      return pick(data.imageUrl, data.previewImageUrl, data.referenceImageUrl);
    case 'uploadNode':
    case 'imageNode':
    case 'exportImageNode':
      return pick(data.imageUrl, data.previewImageUrl);
    case 'videoNode':
      // Prefer the static first frame captured off-screen (see videoFrameCapture), and fall back to the cover field otherwise.
      return null; // Video goes through the lodStill subscription, handled in the component
    default:
      return pick(data.previewImageUrl);
  }
}

function LodShell({ type, id, data, selected, width, height }: {
  type: string;
  id: string;
  data: ShellData;
  selected: boolean | undefined;
  width: number | undefined;
  height: number | undefined;
}) {
  const fallback = SHELL_FALLBACK_SIZES[type] ?? DEFAULT_SHELL_SIZE;
  const w = width ?? fallback.width;
  const h = height ?? fallback.height;
  // Even when one cell cannot cover it, keep feeding the thumb: the whole premise of the shell is that there are too many nodes to decode originals at once.
  const variant = useNodeBodyVariant({ width: w, height: h }) ?? 'thumb';

  // Video thumbnail: subscribe to the module-level frame-capture cache; when the node never mounted the full component (low zoom at first paint),
  // this queues the capture task into the idle queue, without depending on the full component ever having appeared.
  const videoSource =
    type === 'videoNode' && data.videoUrl ? resolveImageDisplayUrl(data.videoUrl) : null;
  const lodStill = useSyncExternalStore(subscribeLodStills, () =>
    getLodStill(videoSource)
  );
  useEffect(() => {
    requestLodStill(videoSource);
  }, [videoSource]);

  const imageSrc =
    type === 'videoNode'
      ? (lodStill
          ?? (data.previewImageUrl
            ? withMediaVariant(resolveImageDisplayUrl(data.previewImageUrl), variant)
            : null))
      : resolveShellImage(type, data, variant);

  const busy = Boolean(data.isGenerating || data.isUploading);

  const style: CSSProperties = { width: w, height: h };

  return (
    <div className={`dc-lod-shell${selected ? ' dc-lod-shell--selected' : ''}`} style={style}>
      {nodeHasTargetHandle(type as CanvasNodeType) && (
        <Handle type="target" position={Position.Left} id="target" />
      )}
      {nodeHasSourceHandle(type as CanvasNodeType) && (
        <Handle type="source" position={Position.Right} id="source" />
      )}
      {imageSrc ? (
        <img src={imageSrc} alt="" draggable={false} className="dc-lod-shell__thumb" />
      ) : null}
      {busy ? <span className="dc-lod-shell__busy" data-node-id={id} /> : null}
    </div>
  );
}

const lowDetailSelector = (state: { transform: [number, number, number] }) =>
  isLowDetailZoom(state.transform[2]);

/**
 * Wraps a node component as "render the shell at the low-zoom tier, render the original component otherwise".
 *
 * The selector returns a boolean; during panning transform[0]/[1] change every frame but the return value does not, so there is no
 * per-frame re-render; everything switches only once when zoom crosses the threshold. A switch is a mount/unmount of the full component,
 * isomorphic with onlyRenderVisibleElements viewport culling — components were long required to keep important state in the
 * store / module-level caches (stated in many in-component comments), so no new state-loss surface is introduced here.
 */
// Each node component's props are its own narrowed XxxNodeProps (the interface data does not satisfy the structural constraint of
// Record<string, unknown>); here, like React Flow's NodeTypes, they are accepted as a wide type;
// at runtime React Flow passes in full NodeProps anyway.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyNodeComponent = ComponentType<any>;

export function withLodShell(
  type: string,
  Component: AnyNodeComponent
): ComponentType<NodeProps> {
  const exempt = LOD_SHELL_EXEMPT_TYPES.has(type);
  const Wrapped = (props: NodeProps) => {
    const lowDetail = useStore(lowDetailSelector);
    // The node singly selected on the canvas (canvasStore.selectedNodeId) is not shelled:
    //   - A node created at low zoom (the placement flow calls setSelectedNode(newNodeId)) must appear immediately as the full
    //     component — the shell is a small untitled gray block, and at 10% the user would think "it was not created";
    //   - Clicking a node at low zoom (React Flow selection syncs back to selectedNodeId via
    //     onSelectionChange) must be able to summon the full component and operations panel, as before the split.
    // Box-select / select-all do not write selectedNodeId (synced to null on multi-select), so the downgrade is not broken through.
    // The selector returns a boolean that flips only when this node is selected/deselected, so no re-render storm.
    const isActiveSelection = useCanvasStore(
      (state) => state.selectedNodeId === props.id
    );
    const wantShell =
      lowDetail && !exempt && !isActiveSelection && !isNodeMediaActive(props.id);

    // The shell → full component switch always goes through the upgrade queue (a limited number per frame, none during gestures):
    //   - Nodes newly mounted during a gesture (swapped in by viewport culling) start from the shell, avoiding
    //     the steady-state frame-drop spikes of dozens of full mounts per second during fast panning;
    //   - On zoom-in all shells in the viewport upgrade in batches, flattening the long frame of a single commit.
    //   - Nodes mounted in the first frame of a canvas hydrate (see the hydrate burst in canvasLod): hundreds of
    //     nodes mounting in one commit is the main source of lag when switching canvases; shells appear first, then fill in batches.
    // The opposite direction (full → shell) takes effect immediately: the downgrade must land in the same commit as the culling switch (see the Canvas
    // applyLowDetailClass comment), and swapping to the shell is cheap anyway.
    const [heldShell, setHeldShell] = useState(
      () =>
        wantShell ||
        (!exempt &&
          !isActiveSelection &&
          (isCanvasGestureActive() || isCanvasHydrateBurstActive()))
    );
    if (wantShell && !heldShell) {
      // Same-component setState during render is the React-sanctioned "derived state" pattern, re-rendering immediately.
      setHeldShell(true);
    }
    useEffect(() => {
      if (!heldShell || wantShell) return;
      // The returned cancel function removes itself from the queue on unmount / re-downgrade.
      return requestShellUpgrade(() => setHeldShell(false));
    }, [heldShell, wantShell]);

    // The placeholder mask for assets pasted across projects and the reference-pick mask both hang on every node (the shell tier needs them too):
    // `.react-flow__node` is itself a positioned element, so the mask with inset-0 fits this node's box exactly,
    // with no need to recompute positionAbsolute × zoom at the canvas layer. When not in pick state it renders null.
    if (heldShell) {
      return (
        <>
          <LodShell
            type={type}
            id={props.id}
            data={props.data as ShellData}
            selected={props.selected}
            width={props.width}
            height={props.height}
          />
          <AssetMigrationNodeOverlay nodeId={props.id} data={props.data} />
          <ForeignMediaNodeOverlay nodeId={props.id} />
          <ReferencePickNodeOverlay nodeId={props.id} />
        </>
      );
    }
    return (
      <>
        <Component {...props} />
        <AssetMigrationNodeOverlay nodeId={props.id} data={props.data} />
        <ForeignMediaNodeOverlay nodeId={props.id} />
        <ReferencePickNodeOverlay nodeId={props.id} />
      </>
    );
  };
  Wrapped.displayName = `withLodShell(${type})`;
  return memo(Wrapped);
}

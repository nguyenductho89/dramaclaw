// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import {
  Handle,
  NodeToolbar as ReactFlowNodeToolbar,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  Camera,
  Globe,
  Grid2x2,
  Grid3x3,
  ImageDown,
  Loader2,
  Lock,
  Maximize2,
  RotateCcw,
  Save,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Viewer, CONSTANTS } from '@photo-sphere-viewer/core';
import '@photo-sphere-viewer/core/index.css';

const { ROTATE_UP, ROTATE_DOWN, ROTATE_LEFT, ROTATE_RIGHT, ZOOM_IN, ZOOM_OUT } = CONSTANTS.ACTIONS;

import {
  CANVAS_NODE_TYPES,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isStoryboardGenNode,
  isUploadNode,
  type CanvasNode,
  type Pano360ViewerNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { localizeNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { dataUrlToBlob, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { CANVAS_NODE_PANEL_SURFACE_CLASS, canvasNodeFrameClass } from '@/features/canvas/ui/nodeFrameStyles';
import { NODE_INLINE_ERROR_MESSAGE_CLASS } from '@/features/canvas/ui/nodeControlStyles';
import { uploadLocalImageToBackend } from '@/features/canvas/application/uploadToolOutput';
import { useUpstreamNodes } from '@/features/canvas/application/useUpstreamGraph';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  publishNodeActionAccepted,
  publishNodeActionError,
  publishNodeActionSuccess,
  subscribeNodeAction,
} from '@/features/canvas/application/nodeActionResult';
import {
  uploadAndAutoCommitSelectedBackgroundCandidate,
} from '@/features/canvas/application/selectedBackgroundSlot';
import { getFreezoneCanvasMetadata } from '@/features/freezone/canvasMetadataContext';

type Pano360ViewerNodeProps = NodeProps & {
  id: string;
  data: Pano360ViewerNodeData;
  selected?: boolean;
};

// Upstream linked nodes (upload / imageGen / imageEdit / exportImage / storyboardGen)
// may all provide us with the panorama texture.
function upstreamPanoUrl(node: CanvasNode | undefined | null): string | null {
  if (!node) return null;
  if (isImageGenNode(node)) {
    const data = node.data;
    const ref =
      typeof data.referenceImageUrl === 'string' && data.referenceImageUrl.length > 0
        ? data.referenceImageUrl
        : null;
    return data.imageUrl || ref;
  }
  if (
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node) ||
    isStoryboardGenNode(node)
  ) {
    return node.data.imageUrl || null;
  }
  return null;
}

const D = Math.PI / 180;
const FOV_MIN = 5;
const FOV_MAX = 170;

const fovToFocal = (fov: number) => Math.round(18 / Math.tan((fov / 2) * D));
const fovToZoom = (fov: number) => ((FOV_MAX - fov) / (FOV_MAX - FOV_MIN)) * 100;
const zoomToFov = (zoom: number) => FOV_MAX - (zoom / 100) * (FOV_MAX - FOV_MIN);
const wrapDeg = (value: number) => ((Number(value) + 540) % 360) - 180;

const clampPitch = (value: number) => Math.max(-90, Math.min(90, value));
const clampFov = (value: number) => Math.max(FOV_MIN, Math.min(FOV_MAX, value));

const DIRECTION_OFFSETS: Record<string, number> = {
  front: 0,
  right: 90,
  back: 180,
  left: -90,
  seam: -180,
};

// Frame names end up in the display text of canvas nodes, but these tables are module-level constants that cannot reach t,
// so only i18n keys are stored, translated when captureToGroup actually creates the nodes.
type CaptureFrameSpec = { yawOffset: number; pitch: number; labelKeys: string[] };

// 2×2: four horizontal directions at eye level, laid out in two columns and two rows.
const GRID_2X2_FRAMES: CaptureFrameSpec[] = [
  { yawOffset: DIRECTION_OFFSETS.front, pitch: 0, labelKeys: ['node.pano360.dir.front'] },
  { yawOffset: DIRECTION_OFFSETS.right, pitch: 0, labelKeys: ['node.pano360.dir.right'] },
  { yawOffset: DIRECTION_OFFSETS.back, pitch: 0, labelKeys: ['node.pano360.dir.back'] },
  { yawOffset: DIRECTION_OFFSETS.left, pitch: 0, labelKeys: ['node.pano360.dir.left'] },
];

// 4×3: four directions × three pitches (up / level / down), 12 images in total, one pitch per row.
const GRID_4X3_DIRS: { offset: number; nameKey: string }[] = [
  { offset: DIRECTION_OFFSETS.front, nameKey: 'node.pano360.dir.front' },
  { offset: DIRECTION_OFFSETS.right, nameKey: 'node.pano360.dir.right' },
  { offset: DIRECTION_OFFSETS.back, nameKey: 'node.pano360.dir.back' },
  { offset: DIRECTION_OFFSETS.left, nameKey: 'node.pano360.dir.left' },
];
const GRID_4X3_PITCHES: { value: number; nameKey: string }[] = [
  { value: 40, nameKey: 'node.pano360.pitch.up' },
  { value: 0, nameKey: 'node.pano360.pitch.level' },
  { value: -40, nameKey: 'node.pano360.pitch.down' },
];
const GRID_4X3_FRAMES: CaptureFrameSpec[] = GRID_4X3_PITCHES.flatMap((pitch) =>
  GRID_4X3_DIRS.map((dir) => ({
    yawOffset: dir.offset,
    pitch: pitch.value,
    labelKeys: [dir.nameKey, pitch.nameKey],
  })),
);

// Center-crop a screenshot of any ratio to 16:9, so image nodes landing on the canvas are uniformly widescreen.
async function cropDataUrlTo16x9(
  dataUrl: string,
  width: number,
  height: number,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const TARGET = 16 / 9;
  const srcRatio = width / Math.max(1, height);
  let cropW = width;
  let cropH = height;
  if (srcRatio > TARGET) {
    cropW = Math.round(height * TARGET);
  } else {
    cropH = Math.round(width / TARGET);
  }
  const sx = Math.round((width - cropW) / 2);
  const sy = Math.round((height - cropH) / 2);
  const out = document.createElement('canvas');
  out.width = cropW;
  out.height = cropH;
  const ctx = out.getContext('2d');
  if (!ctx) return { dataUrl, width, height };
  const image = new Image();
  image.src = dataUrl;
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('image load failed'));
  });
  ctx.drawImage(image, sx, sy, cropW, cropH, 0, 0, cropW, cropH);
  return { dataUrl: out.toDataURL('image/png'), width: cropW, height: cropH };
}

const waitFrames = (count = 3) =>
  new Promise<void>((resolve) => {
    let remaining = count;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) {
        resolve();
        return;
      }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });

function resolveNodeDimension(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return Math.round(value);
  }
  return fallback;
}

type SliderRowProps = {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  onChange: (next: number) => void;
};

function SliderRow({ label, value, min, max, step = 0.1, unit = '°', onChange }: SliderRowProps) {
  const handleNumber = (raw: string) => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.max(min, Math.min(max, parsed)));
  };
  return (
    <div className="flex w-full items-center gap-2 text-[11px] text-text-dark/78">
      <span className="w-12 shrink-0 text-left tabular-nums text-text-dark/72">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => handleNumber(event.target.value)}
        onPointerDown={(event) => event.stopPropagation()}
        className="pano360-slider nodrag min-w-0 flex-1"
      />
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isFinite(value) ? Number(value.toFixed(2)) : 0}
        onChange={(event) => handleNumber(event.target.value)}
        onPointerDown={(event) => event.stopPropagation()}
        className="nodrag h-7 w-[58px] rounded-[7px] border border-white/[0.14] bg-transparent px-1.5 text-right text-[11px] tabular-nums text-text-dark/92 outline-none transition-colors hover:border-white/[0.22] focus:border-white/28"
      />
      <span className="w-3 text-[11px] text-text-dark/58">{unit}</span>
    </div>
  );
}

type ChipButtonProps = {
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
  tone?: 'default' | 'accent';
};

function ChipButton({ onClick, title, disabled, children, tone = 'default' }: ChipButtonProps) {
  const toneClass =
    tone === 'accent'
      ? 'border-[rgb(var(--accent-rgb))]/35 bg-[rgb(var(--accent-rgb))]/14 text-[rgb(var(--accent-rgb))] hover:bg-[rgb(var(--accent-rgb))]/22'
      : 'border-white/[0.12] bg-transparent text-text-dark/72 hover:border-white/[0.2] hover:bg-white/[0.06] hover:text-text-dark';
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className={`nodrag inline-flex h-7 items-center gap-1 rounded-full border px-2.5 text-[11px] transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${toneClass}`}
    >
      {children}
    </button>
  );
}

type PanoToolbarButtonProps = {
  onClick: () => void;
  title?: string;
  disabled?: boolean;
  children: React.ReactNode;
};

function PanoToolbarButton({ onClick, title, disabled, children }: PanoToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className="nodrag inline-flex h-8 w-8 items-center justify-center rounded-full text-text-dark/72 transition-colors hover:bg-white/[0.08] hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-50"
    >
      {children}
    </button>
  );
}

function PanoViewportButton({ onClick, title, children }: PanoToolbarButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      className="nodrag inline-flex h-7 w-7 items-center justify-center rounded-full text-white/70 transition-colors hover:text-white/92 active:text-white"
    >
      {children}
    </button>
  );
}

export const Pano360ViewerNode = memo(({ id, data, selected, width, height }: Pano360ViewerNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const requestFocusNode = useCanvasStore((state) => state.requestFocusNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addPanoCaptureGroup = useCanvasStore((state) => state.addPanoCaptureGroup);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);

  // With group selection / multi-select React Flow also marks the group's child nodes as selected, but then the panorama interaction should not be woken up
  // (drag / wheel) nor the screenshot toolbar popped up — that would be "wrongly activating the 360 node". It counts as truly activated only when this node
  // is the sole selected item on the canvas (selectedNodeId === id); the node border highlight still follows
  // the original selected, so with group selection the child nodes can still be seen box-selected.
  const isActive = Boolean(selected) && selectedNodeId === id;

  const resolvedWidth = Math.max(900, resolveNodeDimension(width, 900));
  const resolvedHeight = Math.max(540, resolveNodeDimension(height, 540));

  // Subscribe to ONLY one-hop upstream (not the whole nodes array) so unrelated
  // node drags don't re-render this node. See useUpstreamGraph.
  const upstreamNodes = useUpstreamNodes(id);

  // Image URLs connected from upstream nodes, following the project convention of "ascending by y coordinate".
  const upstreamPano = useMemo(() => {
    const upstream = [...upstreamNodes];
    upstream.sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));
    for (const node of upstream) {
      const url = upstreamPanoUrl(node);
      if (url) {
        return { nodeId: node.id, url };
      }
    }
    return null;
  }, [upstreamNodes]);

  // Upstream image changes → sync into data.imageUrl, convenient for saving / screenshot labels.
  useEffect(() => {
    if (upstreamPano) {
      if (
        upstreamPano.url !== data.imageUrl ||
        upstreamPano.nodeId !== (data.sourceNodeId ?? null)
      ) {
        updateNodeData(id, { imageUrl: upstreamPano.url, sourceNodeId: upstreamPano.nodeId });
      }
      return;
    }
    // With no upstream connection, keep the node's own imageUrl (e.g. a panorama a preset stuffed in directly);
    // clear it after disconnecting only if the current image came from upstream (sourceNodeId has a value).
    if (data.sourceNodeId) {
      updateNodeData(id, { imageUrl: null, sourceNodeId: null });
    }
  }, [data.imageUrl, data.sourceNodeId, id, updateNodeData, upstreamPano]);

  const resolvedTitle = useMemo(
    () => localizeNodeDisplayName(CANVAS_NODE_TYPES.pano360Viewer, data, t),
    [data, t],
  );

  const viewerHostRef = useRef<HTMLDivElement | null>(null);
  const viewerRef = useRef<Viewer | null>(null);
  const dataRef = useRef(data);
  dataRef.current = data;
  const selectedRef = useRef(isActive);
  selectedRef.current = isActive;
  // PSV's own fullscreen state (reliable across browsers, independent of document.fullscreenElement — the latter can be
  // null in Safari/WebKit/simulated fullscreen, making the in-fullscreen drag check fail outright).
  const isFsRef = useRef(false);

  const [status, setStatus] = useState<string>('');
  const [viewerError, setViewerError] = useState<string>('');
  const [livePos, setLivePos] = useState<{ yawDeg: number; pitchDeg: number; fovDeg: number }>({
    yawDeg: 0,
    pitchDeg: 0,
    fovDeg: data.fovDeg,
  });
  const [isPanelOpen, setIsPanelOpen] = useState(true);
  const [isCapturing, setIsCapturing] = useState(false);
  const [planetBackup, setPlanetBackup] = useState<{ fov: number; yawDeg: number; pitchDeg: number } | null>(null);

  // The display URL goes through the project's /static proxy.
  const displayUrl = useMemo(
    () => (data.imageUrl ? resolveImageDisplayUrl(data.imageUrl) : null),
    [data.imageUrl],
  );

  const applyCorrectionOn = useCallback((viewer: Viewer) => {
    // PSV's setOption('sphereCorrection') directly accesses meshContainer.rotation,
    // and meshContainer is created only by setPanorama → setTexture. Calling it before the first load completes
    // (e.g. the user drags the correction slider while the panorama is still Loading) throws
    // "Cannot read properties of undefined (reading 'rotation')".
    // Guarded here by viewer.state.ready; the slider's value is already written to dataRef,
    // and both setPanorama.then and the 'ready' callback apply the latest value, so nothing is lost.
    if (!viewer.state.ready) return;
    const { roll, pitch, yaw } = dataRef.current.sphereCorrectionDeg;
    viewer.setOption('sphereCorrection', {
      pan: yaw * D,
      tilt: pitch * D,
      roll: roll * D,
    });
  }, []);

  const applyFovOn = useCallback((viewer: Viewer, fovDeg: number) => {
    if (!viewer.state.ready) return;
    viewer.zoom(fovToZoom(fovDeg));
  }, []);

  const applyCorrection = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    applyCorrectionOn(viewer);
  }, [applyCorrectionOn]);

  const applyFov = useCallback((fovDeg: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    applyFovOn(viewer, fovDeg);
  }, [applyFovOn]);

  // Create / switch images. On every displayUrl change: clean up the old viewer, create a new one + attach listeners + load.
  // Under StrictMode the effect runs twice: the first cleanup destroys Viewer A, the second creates Viewer B.
  // Viewer A's listener must not keep accessing viewerRef.current after destroy (by then it
  // points to Viewer B), otherwise applyCorrection in the ready callback would call setSphereCorrection
  // before Viewer B has created its mesh → meshContainer === undefined → "Cannot read properties
  // of undefined (reading 'rotation')".
  useEffect(() => {
    const host = viewerHostRef.current;
    if (!host) return;
    if (!displayUrl) {
      if (viewerRef.current) {
        viewerRef.current.destroy();
        viewerRef.current = null;
      }
      setStatus('');
      setViewerError('');
      return;
    }

    const fovDeg = clampFov(dataRef.current.fovDeg || 70);
    let cancelled = false;
    let viewer: Viewer | null = null;

    // Defer the Viewer construction to the next frame: under StrictMode mount→cleanup→mount runs both rounds
    // in the same microtask, so cancelAnimationFrame first and then create — the first round's RAF
    // is cancelled before it fires, and the whole viewer chain takes only the second, truly surviving mount.
    // Equivalent to running just one clean effect on "disconnect and reconnect", avoiding double-instance pollution.
    const rafId = requestAnimationFrame(() => {
      if (cancelled) return;
      try {
        viewer = new Viewer({
          container: host,
          defaultZoomLvl: fovToZoom(fovDeg),
          navbar: false,
          minFov: FOV_MIN,
          maxFov: FOV_MAX,
          // Drag rotation / wheel zoom both use PSV natively: inside the window toggled with node selection, in fullscreen forced on by PSV's
          // fullscreen event (see v.addEventListener('fullscreen') below).
          mousemove: isActive,
          mousewheel: isActive,
          // In fullscreen use arrow keys / WASD to turn the view and +- to zoom (plan C).
          keyboard: 'fullscreen',
          // Override the default mapping to add WASD (including the shift uppercase form).
          keyboardActions: {
            ArrowUp: ROTATE_UP,
            ArrowDown: ROTATE_DOWN,
            ArrowLeft: ROTATE_LEFT,
            ArrowRight: ROTATE_RIGHT,
            w: ROTATE_UP,
            W: ROTATE_UP,
            s: ROTATE_DOWN,
            S: ROTATE_DOWN,
            a: ROTATE_LEFT,
            A: ROTATE_LEFT,
            d: ROTATE_RIGHT,
            D: ROTATE_RIGHT,
            PageUp: ZOOM_IN,
            PageDown: ZOOM_OUT,
            '+': ZOOM_IN,
            '-': ZOOM_OUT,
          },
          // Turn off the default transition globally — switching images no longer does an old→new fade+rotation transition.
          // A single-image viewer does not need it, and this avoids PSV's transition.rotation NPE in some timings.
          // PSV's type signature says TransitionOptions | undefined, but at runtime (CONFIG_PARSERS)
          // explicitly supports null, which is more accurate than the type — just cast.
          defaultTransition: null as unknown as undefined,
          rendererParameters: { preserveDrawingBuffer: true },
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : t('node.pano360.status.initFailed', { detail: String(error) });
        setViewerError(message);
        setStatus(message);
        return;
      }
      viewerRef.current = viewer;
      setViewerError('');

      const v = viewer;
      // All listeners take `v` from the closure rather than reading viewerRef live — viewerRef may already
      // have been overwritten by a later effect with another instance. `cancelled` also uses the closure, preventing a destroyed viewer's
      // delayed callback from updating React state.
      v.addEventListener('ready', () => {
        if (cancelled) return;
        setStatus(t('node.pano360.status.ready'));
        applyCorrectionOn(v);
        applyFovOn(v, clampFov(dataRef.current.fovDeg || 70));
      });
      v.addEventListener('panorama-loaded', () => {
        if (cancelled) return;
        setStatus(t('node.pano360.status.loaded'));
      });
      v.addEventListener('panorama-error', (event: unknown) => {
        if (cancelled) return;
        const err = event as { error?: Error | string; panorama?: string } | null;
        const errorObj = err?.error;
        const message =
          errorObj instanceof Error ? errorObj.message : typeof errorObj === 'string' ? errorObj : t('node.pano360.status.loadFailed');
        setStatus(message);
        setViewerError(message);
      });
      v.addEventListener('position-updated', ({ position }: { position: { yaw: number; pitch: number } }) => {
        if (cancelled) return;
        setLivePos((prev) => ({
          ...prev,
          yawDeg: position.yaw / D,
          pitchDeg: position.pitch / D,
        }));
      });
      v.addEventListener('zoom-updated', ({ zoomLevel }: { zoomLevel: number }) => {
        if (cancelled) return;
        const fov = zoomToFov(zoomLevel);
        setLivePos((prev) => ({ ...prev, fovDeg: fov }));
      });
      // PSV's fullscreen switch (reliable across browsers): in fullscreen, drag + wheel are forced on even if the node is not selected.
      v.addEventListener('fullscreen', ({ fullscreenEnabled }: { fullscreenEnabled: boolean }) => {
        isFsRef.current = fullscreenEnabled;
        const on = fullscreenEnabled || selectedRef.current;
        v.setOption('mousemove', on);
        v.setOption('mousewheel', on);
      });

      setStatus(t('node.pano360.status.loading'));
      // showLoader: false here actually only takes effect for "later" image switches (PSV source line 6148
      // is `||`, and the first load is forced to show the loader by `!state.ready`). What truly keeps PSV's
      // loader from getting stuck is the `[&_.psv-loader-container]:!hidden`
      // CSS on viewerHost, cutting it off at the render layer; false is kept here as belt-and-suspenders.
      v.setPanorama(displayUrl, { showLoader: false, transition: false })
        .then(() => {
          if (cancelled) return;
          setStatus(t('node.pano360.status.loaded'));
          applyCorrectionOn(v);
          applyFovOn(v, clampFov(dataRef.current.fovDeg || 70));
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          const message = error instanceof Error ? error.message : t('node.pano360.status.loadFailedDetail', { detail: String(error) });
          setStatus(message);
          setViewerError(message);
        });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      if (viewer) {
        if (viewerRef.current === viewer) {
          viewerRef.current = null;
        }
        viewer.destroy();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyCorrectionOn, applyFovOn, displayUrl]);

  // Drag + wheel: turned off when unselected so canvas events pass through; forced on in fullscreen (the node may not be
  // selected in fullscreen). The fullscreen state follows PSV's own event (isFsRef); entering/leaving fullscreen is synced by that event.
  useEffect(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const on = isFsRef.current || isActive;
    viewer.setOption('mousemove', on);
    viewer.setOption('mousewheel', on);
  }, [isActive, displayUrl]);

  // "Infinite drag" overlay (does not replace PSV native drag, just sits on top):
  //   Press left button → request Pointer Lock (hide and lock the cursor).
  //   After locking succeeds, the cursor's clientX/Y are frozen, the displacement PSV native drag computes is always 0 (naturally disabled),
  //   and rotation is driven here by movementX/Y increments instead — the mouse never hits the screen edge and can turn continuously in one go.
  //   If locking fails (rejected / disabled by policy) do nothing; PSV native bounded drag still serves as the fallback, no deadlock.
  // Attach mousedown in the capture phase to make sure it fires ahead of child nodes / React's stopPropagation.
  useEffect(() => {
    const host = viewerHostRef.current;
    if (!host) return;

    // We record ourselves whether "dragging" (left button down to up). We cannot rely on
    // document.pointerLockElement alone to judge rotation — browsers throttle "request then exit immediately",
    // so a single click in the selected state may succeed in the lock request while exitPointerLock does not take effect, and the lock stays;
    // afterwards any mouse movement produces movementX/Y → the view keeps turning (and the cursor is hidden).
    let dragging = false;

    const radPerPx = () => {
      const fovRad = clampFov(dataRef.current.fovDeg || 70) * D;
      return fovRad / (host.clientHeight || 1);
    };
    const rotateBy = (dx: number, dy: number) => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      const k = radPerPx();
      const pos = viewer.getPosition();
      viewer.rotate({ yaw: pos.yaw - dx * k, pitch: pos.pitch + dy * k });
    };

    const onMouseDown = (event: MouseEvent) => {
      if (event.button !== 0) return; // Left button only
      // Always enabled in fullscreen; inside the window enabled only when the node is selected. Use PSV's fullscreen state, not depending on
      // document.fullscreenElement (can be null in Safari/WebKit/simulated fullscreen).
      if (!isFsRef.current && !selectedRef.current) return;
      // Presses on the control panel / custom buttons (nodrag) and the PSV navbar are not hijacked.
      if ((event.target as HTMLElement | null)?.closest('.nodrag, .psv-navbar')) return;
      dragging = true;
      // Lock the fullscreen element (in fullscreen only the fullscreen element or its descendants are accepted); fall back to locking the host.
      const fsEl = (document.fullscreenElement ||
        (document as Document & { webkitFullscreenElement?: Element }).webkitFullscreenElement ||
        null) as HTMLElement | null;
      const target = fsEl ?? host;
      try {
        const ret = target.requestPointerLock?.() as unknown;
        if (ret && typeof (ret as Promise<void>).catch === 'function') {
          (ret as Promise<void>).catch(() => {});
        }
      } catch {
        /* Unsupported / rejected — PSV native drag as fallback */
      }
    };

    const onMove = (event: MouseEvent) => {
      const lockEl = document.pointerLockElement as HTMLElement | null;
      if (!lockEl) return; // Take over rotation only while the pointer is locked
      // Take over rotation only when "the locked element belongs to this node" — otherwise every viewer on the canvas has attached a
      // window mousemove, and dragging one would turn all viewers together. In the window the host is locked;
      // in fullscreen the PSV container inside the host is locked (covered by host.contains).
      if (lockEl !== host && !host.contains(lockEl)) return;
      if (!dragging) {
        // The lock belongs to this node but we are not dragging (mostly the "leftover lock after a single click" mentioned above).
        // Exit actively, restoring the cursor and stopping rotation, instead of continuing to consume movementX/Y to turn the view.
        document.exitPointerLock();
        return;
      }
      event.preventDefault();
      rotateBy(event.movementX, event.movementY);
    };

    const onMouseUp = () => {
      dragging = false;
      if (document.pointerLockElement) document.exitPointerLock();
    };

    host.addEventListener('mousedown', onMouseDown, true);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      host.removeEventListener('mousedown', onMouseDown, true);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  const updateCorrectionAxis = useCallback(
    (axis: 'roll' | 'pitch' | 'yaw', next: number) => {
      const wrapped = axis === 'pitch' ? clampPitch(next) : wrapDeg(next);
      const current = dataRef.current.sphereCorrectionDeg;
      updateNodeData(id, {
        sphereCorrectionDeg: { ...current, [axis]: wrapped },
      });
      requestAnimationFrame(() => applyCorrection());
    },
    [applyCorrection, id, updateNodeData],
  );

  const resetCorrection = useCallback(() => {
    updateNodeData(id, { sphereCorrectionDeg: { roll: 0, pitch: 0, yaw: 0 } });
    requestAnimationFrame(() => applyCorrection());
  }, [applyCorrection, id, updateNodeData]);

  const resetView = useCallback(() => {
    viewerRef.current?.rotate({ yaw: 0, pitch: 0 });
  }, []);

  const toggleFullscreen = useCallback(() => {
    viewerRef.current?.toggleFullscreen();
  }, []);

  // Bake the current view's yaw / pitch into the correction parameters.
  const lockCurrentView = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const pos = viewer.getPosition();
    const current = dataRef.current.sphereCorrectionDeg;
    let nextYaw = current.yaw + pos.yaw / D;
    let nextPitch = current.pitch + pos.pitch / D;
    nextYaw = wrapDeg(nextYaw);
    nextPitch = clampPitch(nextPitch);
    updateNodeData(id, {
      sphereCorrectionDeg: { roll: current.roll, pitch: nextPitch, yaw: nextYaw },
    });
    requestAnimationFrame(() => {
      applyCorrection();
      viewer.rotate({ yaw: 0, pitch: 0 });
    });
  }, [applyCorrection, id, updateNodeData]);

  const setFrontYawFromView = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const pos = viewer.getPosition();
    const yawDeg = wrapDeg(pos.yaw / D);
    updateNodeData(id, { frontYawDeg: yawDeg });
    setStatus(t('node.pano360.status.frontSet', { yaw: yawDeg.toFixed(1) }));
  }, [id, updateNodeData]);

  const setFovDeg = useCallback(
    (next: number) => {
      const clamped = clampFov(next);
      updateNodeData(id, { fovDeg: clamped });
      applyFov(clamped);
    },
    [applyFov, id, updateNodeData],
  );

  const rotateToDirection = useCallback(
    (dir: keyof typeof DIRECTION_OFFSETS) => {
      const viewer = viewerRef.current;
      if (!viewer) return;
      const yaw = wrapDeg(dataRef.current.frontYawDeg + DIRECTION_OFFSETS[dir]);
      viewer.rotate({ yaw: yaw * D, pitch: 0 });
    },
    [],
  );

  const enterPlanet = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const pos = viewer.getPosition();
    setPlanetBackup({
      fov: dataRef.current.fovDeg,
      yawDeg: pos.yaw / D,
      pitchDeg: pos.pitch / D,
    });
    setFovDeg(160);
    viewer.rotate({ yaw: 0, pitch: -Math.PI / 2 });
  }, [setFovDeg]);

  const exitPlanet = useCallback(() => {
    const viewer = viewerRef.current;
    if (!viewer || !planetBackup) return;
    setFovDeg(planetBackup.fov);
    viewer.rotate({ yaw: planetBackup.yawDeg * D, pitch: planetBackup.pitchDeg * D });
    setPlanetBackup(null);
  }, [planetBackup, setFovDeg]);

  // Export the correction parameters as JSON and copy to the clipboard (replacing the original viewer's /__dramaclaw endpoint).
  const buildCorrectionEntry = useCallback(() => {
    const { roll, pitch, yaw } = dataRef.current.sphereCorrectionDeg;
    const front = dataRef.current.frontYawDeg;
    return {
      pano_url: dataRef.current.imageUrl,
      front_yaw_deg: front,
      sphere_correction_deg: { roll, pitch, yaw },
      sphere_correction_rad: {
        roll: +(roll * D).toFixed(6),
        tilt: +(pitch * D).toFixed(6),
        pan: +(yaw * D).toFixed(6),
      },
      cubemap_contract: {
        front_yaw_deg: front,
        right_yaw_deg: wrapDeg(front + DIRECTION_OFFSETS.right),
        back_yaw_deg: wrapDeg(front + DIRECTION_OFFSETS.back),
        left_yaw_deg: wrapDeg(front + DIRECTION_OFFSETS.left),
        seam_yaw_deg: wrapDeg(front + DIRECTION_OFFSETS.seam),
      },
      fov_deg: dataRef.current.fovDeg,
      ts: new Date().toISOString(),
    };
  }, []);

  const copyCorrectionJson = useCallback(async () => {
    const entry = buildCorrectionEntry();
    updateNodeData(id, { lastExportedEntry: entry });
    const text = JSON.stringify(entry, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setStatus(t('node.pano360.status.jsonCopied'));
    } catch (error) {
      console.warn('[pano360] clipboard write failed', error);
      setStatus(t('node.pano360.status.jsonNoClipboard'));
      console.info('[pano360] correction JSON:\n' + text);
    }
  }, [buildCorrectionEntry, id, updateNodeData]);

  const getViewerCanvas = useCallback((): HTMLCanvasElement | null => {
    return viewerHostRef.current?.querySelector('canvas') ?? null;
  }, []);

  const snapCurrent = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer || !data.imageUrl) return;
    setIsCapturing(true);
    try {
      await waitFrames();
      const canvas = getViewerCanvas();
      if (!canvas) return;
      const cropped = await cropDataUrlTo16x9(
        canvas.toDataURL('image/png'),
        canvas.width,
        canvas.height,
      );
      // Upload so the node's imageUrl is a real backend URL (not base64).
      const uploadedUrl = await uploadLocalImageToBackend(
        cropped.dataUrl,
        `pano-${id}-${Date.now()}.png`,
      );
      const nodeId = addPanoCaptureGroup(id, [{ ...cropped, uploadedUrl, label: t('node.pano360.currentView') }]);
      if (nodeId) {
        requestFocusNode(nodeId);
      }
      setStatus(t(nodeId ? 'node.pano360.status.snapDone' : 'node.pano360.status.snapFailed'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(t('node.pano360.status.snapFailedDetail', { detail: message }));
    } finally {
      setIsCapturing(false);
    }
  }, [addPanoCaptureGroup, data.imageUrl, getViewerCanvas, id, requestFocusNode]);

  // "Use as background source": crop the current viewer view (the frame decided by yaw/pitch/fov) to 16:9,
  // first generate the current-background candidate node, then go through the mainline commit to write selected_background.
  // Difference from snapCurrent: snapCurrent only generates a plain screenshot node; what is generated here is a committable
  // mainline candidate node.
  // The Viewer itself is the cropper (the user frames with yaw/pitch/fov), so no extra
  // BackgroundCropperDialog is needed — the user has already adjusted the "16:9 frame they want" in the viewer.
  const snapAsBackgroundAnchor = useCallback(async () => {
    const viewer = viewerRef.current;
    if (!viewer || !data.imageUrl) return;
    const canvasMeta = getFreezoneCanvasMetadata();
    const presetMeta = (canvasMeta?.preset as
      | { episode?: number; beat?: number }
      | undefined) ?? undefined;
    const episode = typeof presetMeta?.episode === 'number' ? presetMeta.episode : null;
    const beat = typeof presetMeta?.beat === 'number' ? presetMeta.beat : null;
    if (episode === null || beat === null) {
      setStatus(t('node.pano360.status.notInShotContext'));
      return;
    }
    setIsCapturing(true);
    try {
      await waitFrames();
      const canvas = getViewerCanvas();
      if (!canvas) return;
      const cropped = await cropDataUrlTo16x9(
        canvas.toDataURL('image/png'),
        canvas.width,
        canvas.height,
      );
      // dataUrl → Blob (the fetch trick is cleaner than atob)
      // CSP `connect-src 'self'` blocks fetching data: URLs in production.
      const blob = dataUrlToBlob(cropped.dataUrl);
      await uploadAndAutoCommitSelectedBackgroundCandidate(
        { episode, beat },
        blob,
        `background_pano360_${Date.now()}.png`,
        {
          sourceNodeId: id,
          label: t('node.pano360.currentBackground'),
          successMessage: t('node.pano360.status.backgroundSet'),
        },
      );
      setStatus(t('node.pano360.status.backgroundSubmitted'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStatus(t('node.pano360.status.setFailedDetail', { detail: message }));
    } finally {
      setIsCapturing(false);
    }
  }, [data.imageUrl, getViewerCanvas]);

  const captureFrame = useCallback(
    async (yawDeg: number, pitchDeg: number, fovDeg: number) => {
      const viewer = viewerRef.current;
      if (!viewer) throw new Error('viewer not ready');
      viewer.zoom(fovToZoom(fovDeg));
      viewer.rotate({ yaw: yawDeg * D, pitch: pitchDeg * D });
      await waitFrames(3);
      const canvas = getViewerCanvas();
      if (!canvas) throw new Error('canvas not found');
      return { dataUrl: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height };
    },
    [getViewerCanvas],
  );

  // Multi-direction screenshot: capture frame by frame, then each becomes an independent image node, placed into a frontend-display
  // group (no new group node type is created). yaw is based on the "front" the user set.
  const captureToGroup = useCallback(
    async (cols: number, frames: CaptureFrameSpec[], fov: number, groupName: string) => {
      const viewer = viewerRef.current;
      if (!viewer || !data.imageUrl) return;
      setIsCapturing(true);
      const savedPos = viewer.getPosition();
      const savedFov = dataRef.current.fovDeg;
      try {
        setStatus(t('node.pano360.status.capturing', { count: frames.length }));
        const frontYaw = dataRef.current.frontYawDeg;
        const captures: {
          dataUrl: string;
          width: number;
          height: number;
          label: string;
          uploadedUrl?: string;
        }[] = [];
        for (const frame of frames) {
          const yaw = wrapDeg(frontYaw + frame.yawOffset);
          const shot = await captureFrame(yaw, frame.pitch, fov);
          const cropped = await cropDataUrlTo16x9(shot.dataUrl, shot.width, shot.height);
          captures.push({
            ...cropped,
            label: frame.labelKeys.map((key) => t(key)).join('·'),
          });
        }
        viewer.rotate(savedPos);
        applyFov(savedFov);
        // Upload every frame so each child node's imageUrl is a real backend URL;
        // per-frame best-effort, dataUrl stays as the preview.
        setStatus(t('node.pano360.status.uploadingCount', { count: captures.length }));
        await Promise.all(
          captures.map(async (capture, index) => {
            capture.uploadedUrl = await uploadLocalImageToBackend(
              capture.dataUrl,
              `pano-${id}-${Date.now()}-${index}.png`,
            );
          }),
        );
        const groupId = addPanoCaptureGroup(id, captures, { cols, groupName });
        if (groupId) {
          requestFocusNode(groupId);
        }
        setStatus(
          groupId
            ? t('node.pano360.status.capturedCount', { count: captures.length })
            : t('node.pano360.status.snapFailed'),
        );
      } catch (error) {
        viewer.rotate(savedPos);
        applyFov(savedFov);
        const message = error instanceof Error ? error.message : String(error);
        setStatus(t('node.pano360.status.snapFailedDetail', { detail: message }));
      } finally {
        setIsCapturing(false);
      }
    },
    [addPanoCaptureGroup, applyFov, captureFrame, data.imageUrl, id, requestFocusNode],
  );

  const snap2x2 = useCallback(
    () => captureToGroup(2, GRID_2X2_FRAMES, 90, t('node.pano360.captureGroup2x2')),
    [captureToGroup],
  );
  const snap4x3 = useCallback(
    () => captureToGroup(4, GRID_4X3_FRAMES, 75, t('node.pano360.captureGroup4x3')),
    [captureToGroup],
  );

  useEffect(() => {
    return subscribeNodeAction(({ nodeId, action, requestId }) => {
      if (nodeId !== id) return;

      if (action === 'capture_pano_current_view') {
        publishNodeActionAccepted(requestId, id, action);
        snapCurrent()
          .then(() => publishNodeActionSuccess(requestId, id, action, { submitted: true }))
          .catch((error) => publishNodeActionError(requestId, id, action, error));
        return;
      }

      if (action === 'capture_pano_2x2_views') {
        publishNodeActionAccepted(requestId, id, action);
        snap2x2()
          .then(() => publishNodeActionSuccess(requestId, id, action, { submitted: true }))
          .catch((error) => publishNodeActionError(requestId, id, action, error));
        return;
      }

      if (action === 'capture_pano_4x3_views') {
        publishNodeActionAccepted(requestId, id, action);
        snap4x3()
          .then(() => publishNodeActionSuccess(requestId, id, action, { submitted: true }))
          .catch((error) => publishNodeActionError(requestId, id, action, error));
        return;
      }

      if (action === 'set_pano_current_view_as_background') {
        publishNodeActionAccepted(requestId, id, action);
        snapAsBackgroundAnchor()
          .then(() => publishNodeActionSuccess(requestId, id, action, { submitted: true }))
          .catch((error) => publishNodeActionError(requestId, id, action, error));
        return;
      }

      if (action === 'reset_pano_view') {
        try {
          publishNodeActionAccepted(requestId, id, action);
          resetView();
          publishNodeActionSuccess(requestId, id, action, { reset: true });
        } catch (error) {
          publishNodeActionError(requestId, id, action, error);
        }
      }
    });
  }, [id, resetView, snap2x2, snap4x3, snapAsBackgroundAnchor, snapCurrent]);

  const handleNodeClick = useCallback(() => {
    setSelectedNode(id);
  }, [id, setSelectedNode]);

  const zoomViewportBy = useCallback(
    (deltaFov: number) => {
      const baseFov = dataRef.current.fovDeg || livePos.fovDeg || 70;
      setFovDeg(baseFov + deltaFov);
    },
    [livePos.fovDeg, setFovDeg],
  );

  const rotateViewportBy = useCallback((yawDeltaDeg: number, pitchDeltaDeg: number) => {
    const viewer = viewerRef.current;
    if (!viewer) return;
    const position = viewer.getPosition();
    viewer.rotate({
      yaw: position.yaw + yawDeltaDeg * D,
      pitch: clampPitch(position.pitch / D + pitchDeltaDeg) * D,
    });
  }, []);

  const containerStyle: CSSProperties = {
    width: resolvedWidth,
    height: resolvedHeight,
  };

  const correction = data.sphereCorrectionDeg;
  const liveFov = livePos.fovDeg || data.fovDeg;
  const focal = Number.isFinite(liveFov) ? fovToFocal(clampFov(liveFov)) : null;

  return (
    <div
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border ${CANVAS_NODE_PANEL_SURFACE_CLASS} p-0 transition-colors duration-150
        ${canvasNodeFrameClass({ selected })}
      `}
      style={containerStyle}
      onClick={handleNodeClick}
    >
      {/* Screenshot toolbar: placed directly above the node (the delete pill is hidden, so it can sit close to the node). */}
      <ReactFlowNodeToolbar
        nodeId={id}
        isVisible={isActive && Boolean(data.imageUrl)}
        position={Position.Top}
        align="center"
        offset={16}
        className="pointer-events-auto"
      >
        <div className="flex items-center gap-1 rounded-full border border-white/[0.12] bg-[#282828]/95 px-1.5 py-1 shadow-[0_10px_24px_rgba(0,0,0,0.32)] backdrop-blur-md">
          <PanoToolbarButton onClick={snapCurrent} disabled={isCapturing} title={t('node.pano360.snapCurrent')}>
            {isCapturing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
          </PanoToolbarButton>
          <PanoToolbarButton onClick={snap2x2} disabled={isCapturing} title={t('node.pano360.snap2x2')}>
            <Grid2x2 className="h-4 w-4" />
          </PanoToolbarButton>
          <PanoToolbarButton onClick={snap4x3} disabled={isCapturing} title={t('node.pano360.snap4x3')}>
            <Grid3x3 className="h-4 w-4" />
          </PanoToolbarButton>
          <span className="mx-1 h-5 w-px bg-white/15" aria-hidden />
          {/* Use as background source: the viewer itself is the cropper, cropping the current view's 16:9 region and writing
              beat selected_background.png (no dialog). Valid only in a shot context. */}
          <PanoToolbarButton
            onClick={snapAsBackgroundAnchor}
            disabled={isCapturing}
            title={t('node.pano360.useAsBackground')}
          >
            <ImageDown className="h-4 w-4" />
          </PanoToolbarButton>
          <span className="mx-1 h-5 w-px bg-white/15" aria-hidden />
          <PanoToolbarButton onClick={resetView} title={t('node.pano360.resetView')}>
            <RotateCcw className="h-4 w-4" />
          </PanoToolbarButton>
        </div>
      </ReactFlowNodeToolbar>

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Globe className="h-4 w-4" />}
        titleText={resolvedTitle}
        metaText={
          status ||
          t(data.imageUrl ? 'node.pano360.metaViewer' : 'node.pano360.metaWaiting')
        }
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <div className="flex h-full w-full overflow-hidden rounded-[var(--node-radius)] bg-[#282828]">
        {/* Render area. When active, PSV exclusively takes drag / wheel (nopan nowheel + stopPropagation);
            when inactive events pass through, and canvas pan / zoom / node selection work normally. */}
        <div className="relative flex-1 min-w-0">
          {/* We must cut off two PSV visual overlays:
              - `[&_.psv-loader-container]:!hidden`: PSV's own loader is not hidden
                on the AbortError path (source line 6134 `isAbortError`
                short-circuits done()), so cut it off permanently at the DOM layer.
              - `[&_.psv-container]:[background:transparent_!important]`:
                PSV by default gives the container a white→gray radial gradient (index.css line 17-25),
                using the `background:` shorthand (background image). You cannot use
                `bg-transparent` (that only changes background-color and cannot kill
                background-image). The whole group must be overridden with an arbitrary value.
              The header's status text is the only source of loading state. */}
          <div
            ref={viewerHostRef}
            className={`pano360-viewer-host absolute inset-0 bg-black [&_.psv-loader-container]:!hidden [&_.psv-container]:[background:transparent_!important] ${isActive ? 'nopan nowheel' : ''}`}
            onPointerDown={isActive ? (event) => event.stopPropagation() : undefined}
            onWheel={isActive ? (event) => event.stopPropagation() : undefined}
          />
          {!data.imageUrl ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-2 text-text-muted/85">
              <Globe className="h-7 w-7 opacity-60" />
              <span className="px-3 text-center text-[12px] leading-6">
                {t('node.pano360.connectUpstream')}
              </span>
            </div>
          ) : null}

          {viewerError ? (
            <div className={`pointer-events-none absolute left-2 right-2 top-2 max-h-24 overflow-y-auto ${NODE_INLINE_ERROR_MESSAGE_CLASS}`}>
              {viewerError}
            </div>
          ) : null}

          {/* Live value HUD at the top left */}
          {data.imageUrl ? (
            <div className="pointer-events-none absolute left-3 top-3 rounded-full bg-black/34 px-2.5 py-1 text-[10px] tabular-nums text-white/74 backdrop-blur-sm">
              yaw {livePos.yawDeg.toFixed(1)}° · pitch {livePos.pitchDeg.toFixed(1)}° · fov {liveFov.toFixed(0)}°{focal ? ` · ${focal}mm` : ''}
            </div>
          ) : null}

          {data.imageUrl ? (
            <div
              className="nodrag absolute bottom-3 left-3 flex items-center gap-1 rounded-full border border-white/[0.08] bg-black/28 px-1.5 py-1 backdrop-blur-sm"
              onPointerDown={(event) => event.stopPropagation()}
              onWheel={(event) => event.stopPropagation()}
            >
              <PanoViewportButton onClick={() => zoomViewportBy(10)} title={t('node.pano360.zoomOut')}>
                <ZoomOut className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
              <PanoViewportButton onClick={() => zoomViewportBy(-10)} title={t('node.pano360.zoomIn')}>
                <ZoomIn className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
              <PanoViewportButton onClick={() => rotateViewportBy(-12, 0)} title={t('node.pano360.panLeft')}>
                <ArrowLeft className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
              <PanoViewportButton onClick={() => rotateViewportBy(12, 0)} title={t('node.pano360.panRight')}>
                <ArrowRight className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
              <PanoViewportButton onClick={() => rotateViewportBy(0, 8)} title={t('node.pano360.panUp')}>
                <ArrowUp className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
              <PanoViewportButton onClick={() => rotateViewportBy(0, -8)} title={t('node.pano360.panDown')}>
                <ArrowDown className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
              <PanoViewportButton onClick={toggleFullscreen} title={t('node.pano360.enterFullscreen')}>
                <Maximize2 className="h-4 w-4" strokeWidth={1.8} />
              </PanoViewportButton>
            </div>
          ) : null}

          {/* Top right: panel collapse */}
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              setIsPanelOpen((open) => !open);
            }}
            onPointerDown={(event) => event.stopPropagation()}
            title={t(isPanelOpen ? 'node.pano360.collapsePanel' : 'node.pano360.expandPanel')}
            className="nodrag absolute right-2 top-2 inline-flex h-7 w-7 items-center justify-center rounded-full border border-white/[0.1] bg-black/35 text-white/72 backdrop-blur-sm transition-colors hover:bg-black/50 hover:text-white"
          >
            {isPanelOpen ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
          </button>
        </div>

        {/* Right control panel */}
        {isPanelOpen ? (
          <div
            className="pano360-control-panel nopan nowheel flex h-full w-[336px] shrink-0 flex-col gap-4 overflow-y-auto overflow-x-hidden border-l border-white/[0.08] bg-[#191a1f]/94 p-4 text-[12px] text-text-dark backdrop-blur-sm"
            onWheel={(event) => event.stopPropagation()}
          >
            {/* FOV */}
            <section className="flex flex-col gap-2">
              <header className="flex items-center justify-between gap-3 text-[11px] font-medium text-text-dark/72">
                <span>{t('node.pano360.fov')}</span>
                <span className="tabular-nums text-text-dark/64">{liveFov.toFixed(0)}° · {focal ?? '—'}mm</span>
              </header>
              <SliderRow
                label="fov"
                value={data.fovDeg}
                min={FOV_MIN}
                max={FOV_MAX}
                step={1}
                onChange={setFovDeg}
              />
              <div className="flex flex-wrap gap-1.5">
                {[20, 35, 50, 70, 90, 120, 150].map((preset) => (
                  <ChipButton key={preset} onClick={() => setFovDeg(preset)}>
                    {preset}°
                  </ChipButton>
                ))}
              </div>
            </section>

            {/* Correction */}
            <section className="flex flex-col gap-2">
              <header className="flex items-center justify-between gap-3 text-[11px] font-medium text-text-dark/72">
                <span>{t('node.pano360.sphereCorrection')}</span>
                <button
                  type="button"
                  className="nodrag rounded-full px-2 py-1 text-[11px] text-text-dark/62 transition-colors hover:bg-white/[0.06] hover:text-text-dark"
                  onClick={(event) => {
                    event.stopPropagation();
                    resetCorrection();
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  {t('node.pano360.reset')}
                </button>
              </header>
              <SliderRow
                label="roll"
                value={correction.roll}
                min={-180}
                max={180}
                onChange={(next) => updateCorrectionAxis('roll', next)}
              />
              <SliderRow
                label="pitch"
                value={correction.pitch}
                min={-90}
                max={90}
                onChange={(next) => updateCorrectionAxis('pitch', next)}
              />
              <SliderRow
                label="yaw"
                value={correction.yaw}
                min={-180}
                max={180}
                onChange={(next) => updateCorrectionAxis('yaw', next)}
              />
              <div className="flex flex-wrap gap-1.5">
                <ChipButton onClick={lockCurrentView} title={t('node.pano360.lockViewTitle')}>
                  <Lock className="h-3 w-3" /> {t('node.pano360.lockView')}
                </ChipButton>
              </div>
            </section>

            {/* Direction */}
            <section className="flex flex-col gap-2">
              <header className="flex items-center justify-between gap-3 text-[11px] font-medium text-text-dark/72">
                <span>{t('node.pano360.front')}</span>
                <span className="tabular-nums text-text-dark/64">{data.frontYawDeg.toFixed(1)}°</span>
              </header>
              <SliderRow
                label="front"
                value={data.frontYawDeg}
                min={-180}
                max={180}
                onChange={(next) => updateNodeData(id, { frontYawDeg: wrapDeg(next) })}
              />
              <div className="flex flex-wrap gap-1.5">
                <ChipButton onClick={setFrontYawFromView} title={t('node.pano360.setFrontYawTitle')}>
                  {t('node.pano360.setAsCurrentView')}
                </ChipButton>
                {(['front', 'right', 'back', 'left', 'seam'] as const).map((dir) => (
                  <ChipButton key={dir} onClick={() => rotateToDirection(dir)}>
                    {dir}
                  </ChipButton>
                ))}
              </div>
            </section>

            {/* Little planet / screenshot / export */}
            <section className="flex flex-col gap-2">
              <header className="text-[11px] font-medium text-text-dark/72">{t('node.pano360.effectsAndExport')}</header>
              <div className="flex flex-wrap gap-1.5">
                {planetBackup ? (
                  <ChipButton onClick={exitPlanet} tone="accent">
                    {t('node.pano360.exitPlanet')}
                  </ChipButton>
                ) : (
                  <ChipButton onClick={enterPlanet}>{t('node.pano360.planetMode')}</ChipButton>
                )}
              </div>
              <div className="flex flex-wrap gap-1.5">
                <ChipButton onClick={copyCorrectionJson} title={t('node.pano360.copyCorrectionJsonTitle')}>
                  <Save className="h-3 w-3" /> {t('node.pano360.copyCorrectionJson')}
                </ChipButton>
              </div>
            </section>
          </div>
        ) : null}
      </div>

      <Handle
        type="target"
        id="target"
        position={Position.Left}
        className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
      />
      <Handle
        type="source"
        id="source"
        position={Position.Right}
        className="!h-2 !w-2 !border-surface-dark !bg-[rgb(148,163,184)]"
      />
      <NodeResizeHandle
        minWidth={900}
        minHeight={540}
        maxWidth={1600}
        maxHeight={1200}
      />
    </div>
  );
});

Pano360ViewerNode.displayName = 'Pano360ViewerNode';

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position, useViewport } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import {
  ArrowUp,
  Brush,
  ChevronDown,
  Eraser,
  Redo2,
  Spline,
  Square,
  Undo2,
  X,
} from 'lucide-react';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  FREEZONE_REDRAW_ASPECT_RATIOS,
  fetchFreezoneJobResult,
  submitFreezoneRedraw,
  uploadFreezoneImage,
  type FreezoneRedrawAspectRatio,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { notifyTaskStillRunning } from '@/features/canvas/application/errorDialog';
import { buildRedHighlightMaskBlob } from '@/lib/mask-highlight';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { GENERATION_ERROR_CLEARED_PATCH } from '@/features/canvas/application/generationTaskArbitration';
import { buildImageFeatureBillingParams } from '@/features/canvas/domain/imageBilling';
import {
  pickAllowedOption,
  resolveModelAspectOptions,
  resolveModelQualityOptions,
  resolveModelSizeOptions,
} from '@/features/canvas/domain/mediaModelOptions';
import { readUrl } from '@/lib/url-params';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { CANVAS_NODE_TOOLBAR_PILL_CLASS } from './nodeFrameStyles';
import {
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
} from './nodeControlStyles';
import { CreditCostPill } from '@/components/credits/credit-visual';
import { useFreezoneImageModels } from '@/features/canvas/hooks/useFreezoneImageModels';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { BillingRuleNotConfiguredError } from '@/lib/api-errors';
import { FREEZONE_IMAGE_FEATURES } from '@/features/canvas/application/freezoneImageFeatureBilling';

interface EraseOverlayProps {
  node: CanvasNode;
  imageSource: string;
  onClose: () => void;
}

type Tool = 'brush' | 'rect' | 'eraser';

// Ratio and resolution tiers come from the backend "media models" config for the selected model; only the entry key for the tier to be rewritten is kept here
// (shown as the raw value when not hit).
const ASPECT_RATIO_LABEL_KEYS: Partial<Record<FreezoneRedrawAspectRatio, string>> = {
  original: 'canvas.paintTools.aspectOriginal',
};

const NUM_IMAGE_OPTIONS = [1, 2, 3, 4] as const;
const BRUSH_MIN = 4;
const BRUSH_MAX = 200;
const DEFAULT_BRUSH = 40;
const PAINT_FILL = 'rgba(239, 68, 68, 0.55)';
const PAINT_STROKE = 'rgba(239, 68, 68, 0.55)';
const RESULT_STACK_GAP = 24;
const ERASE_TOOLBAR_CLASS =
  'flex items-center gap-1 rounded-full border border-white/[0.12] bg-[#282828]/95 px-1.5 py-1 shadow-[0_10px_24px_rgba(0,0,0,0.32)] backdrop-blur-md';
const ERASE_TOOLBAR_BUTTON_CLASS =
  'nodrag inline-flex h-8 w-8 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50';
const ERASE_SLIDER_CLASS =
  'nodrag nopan h-0.5 w-24 cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#5b8cff] [&::-webkit-slider-thumb]:shadow-none [&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[#5b8cff]';

export const EraseOverlay = memo(({ node, imageSource, onClose }: EraseOverlayProps) => {
  const { t } = useTranslation();
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const { zoom } = useViewport();

  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const rectStartRef = useRef<{ x: number; y: number } | null>(null);
  const undoStackRef = useRef<ImageData[]>([]);
  const redoStackRef = useRef<ImageData[]>([]);
  const baseUrlRef = useRef(imageSource.split('?')[0]);
  // The loaded source image, used as the base of the red highlight when exporting the mask (the backend treats the mask as a visual reference image).
  const sourceImgRef = useRef<HTMLImageElement | null>(null);

  const [tool, setTool] = useState<Tool>('brush');
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH);
  const [imageDims, setImageDims] = useState<{ w: number; h: number } | null>(null);
  const [hasMask, setHasMask] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [imageSize, setImageSize] = useState<string>('2K');
  const [numImages, setNumImages] = useState<number>(1);
  const [aspectRatio, setAspectRatio] = useState<FreezoneRedrawAspectRatio>('16:9');
  const { models: imageModels } = useFreezoneImageModels();
  const selectedModel = imageModels[0];
  // Size / ratio / quality follow the backend's config for that model; the ratio must also fall within the values the erase (redraw) endpoint
  // itself supports.
  const sizeOptions = useMemo(
    () => resolveModelSizeOptions(selectedModel),
    [selectedModel],
  );
  const aspectRatioOptions = useMemo<FreezoneRedrawAspectRatio[]>(
    () =>
      resolveModelAspectOptions(selectedModel).filter(
        (ratio): ratio is FreezoneRedrawAspectRatio =>
          ratio !== 'original'
          && (FREEZONE_REDRAW_ASPECT_RATIOS as readonly string[]).includes(ratio),
      ),
    [selectedModel],
  );
  const qualityOptions = useMemo(
    () => resolveModelQualityOptions(selectedModel),
    [selectedModel],
  );
  const effectiveImageSize = pickAllowedOption(imageSize, sizeOptions);
  const effectiveAspectRatio = pickAllowedOption(
    aspectRatio,
    aspectRatioOptions,
  ) as FreezoneRedrawAspectRatio;
  const creditCost = useGenerationCreditCost(
    'feature',
    selectedModel ? FREEZONE_IMAGE_FEATURES.edit : null,
    {
      surface: 'canvas',
      params: buildImageFeatureBillingParams(selectedModel, {
        size: effectiveImageSize,
        ...(qualityOptions.length > 0
          ? { quality: pickAllowedOption('medium', qualityOptions) }
          : {}),
        operation: 'erase',
        pricing_quantity: Math.min(Math.max(numImages, 1), 4),
      }),
      quantity: Math.min(Math.max(numImages, 1), 4),
    },
  );
  const billingRuleMissing =
    creditCost.error instanceof BillingRuleNotConfiguredError;
  const costDisplay =
    creditCost.data?.data.display ??
    (billingRuleMissing ? t('common.billingRuleNotConfiguredShort') : null);

  // The node's size in the canvas coordinate system (flow units). The mask canvas must fit the image on the node at the current zoom.
  const nodeWidth =
    typeof node.measured?.width === 'number'
      ? node.measured.width
      : typeof node.width === 'number'
        ? node.width
        : DEFAULT_NODE_WIDTH;
  const nodeHeight =
    typeof node.measured?.height === 'number'
      ? node.measured.height
      : typeof node.height === 'number'
        ? node.height
        : nodeWidth;

  // A node shows the image with object-contain: compute the rectangle where the image is actually displayed (there may be black bars),
  // the mask covers only this area, and is multiplied by the current zoom to convert to screen pixels, ensuring alignment at any zoom.
  const display = useMemo(() => {
    if (!imageDims) {
      return { width: nodeWidth * zoom, height: nodeHeight * zoom };
    }
    const fit = Math.min(nodeWidth / imageDims.w, nodeHeight / imageDims.h);
    return { width: imageDims.w * fit * zoom, height: imageDims.h * fit * zoom };
  }, [imageDims, nodeHeight, nodeWidth, zoom]);

  // Load base image just to size the mask canvases at native resolution.
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageSource;
    img.onload = () => {
      const maskCanvas = maskCanvasRef.current;
      const previewCanvas = previewCanvasRef.current;
      if (!maskCanvas || !previewCanvas) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      [maskCanvas, previewCanvas].forEach((c) => {
        c.width = w;
        c.height = h;
      });
      sourceImgRef.current = img;
      setImageDims({ w, h });
    };
    img.onerror = () => setError(t('canvas.paintTools.loadSourceFailed'));
  }, [imageSource, t]);

  // Esc exits erasing.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, submitting]);

  const recomputeHasMask = useCallback(() => {
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) {
      setHasMask(false);
      return;
    }
    const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    for (let i = 3; i < data.length; i += 16 * 4) {
      if (data[i] > 8) {
        setHasMask(true);
        return;
      }
    }
    setHasMask(false);
  }, []);

  const syncHistoryFlags = useCallback(() => {
    setCanUndo(undoStackRef.current.length > 0);
    setCanRedo(redoStackRef.current.length > 0);
  }, []);

  const snapshot = useCallback((): ImageData | null => {
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return null;
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }, []);

  const pushUndoSnapshot = useCallback(() => {
    const snap = snapshot();
    if (!snap) return;
    if (undoStackRef.current.length >= 32) undoStackRef.current.shift();
    undoStackRef.current.push(snap);
    redoStackRef.current = []; // A new operation invalidates redo
    syncHistoryFlags();
  }, [snapshot, syncHistoryFlags]);

  const handleUndo = useCallback(() => {
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const prev = undoStackRef.current.pop();
    if (!prev) return;
    const current = snapshot();
    if (current) redoStackRef.current.push(current);
    ctx.putImageData(prev, 0, 0);
    syncHistoryFlags();
    recomputeHasMask();
  }, [recomputeHasMask, snapshot, syncHistoryFlags]);

  const handleRedo = useCallback(() => {
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const next = redoStackRef.current.pop();
    if (!next) return;
    const current = snapshot();
    if (current) undoStackRef.current.push(current);
    ctx.putImageData(next, 0, 0);
    syncHistoryFlags();
    recomputeHasMask();
  }, [recomputeHasMask, snapshot, syncHistoryFlags]);

  const canvasToImageCoords = useCallback((clientX: number, clientY: number) => {
    const canvas = previewCanvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }, []);

  const drawDot = useCallback(
    (x: number, y: number) => {
      const canvas = maskCanvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      if (tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = PAINT_FILL;
      }
      ctx.beginPath();
      ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2);
      ctx.fill();
    },
    [brushSize, tool],
  );

  const drawLine = useCallback(
    (from: { x: number; y: number }, to: { x: number; y: number }) => {
      const canvas = maskCanvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.lineWidth = brushSize;
      if (tool === 'eraser') {
        ctx.globalCompositeOperation = 'destination-out';
        ctx.strokeStyle = 'rgba(0,0,0,1)';
      } else {
        ctx.globalCompositeOperation = 'source-over';
        ctx.strokeStyle = PAINT_STROKE;
      }
      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.stroke();
    },
    [brushSize, tool],
  );

  const drawRectPreview = useCallback(
    (start: { x: number; y: number }, end: { x: number; y: number }) => {
      const canvas = previewCanvasRef.current;
      const ctx = canvas?.getContext('2d');
      if (!canvas || !ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = PAINT_FILL;
      ctx.strokeStyle = 'rgba(239,68,68,0.85)';
      ctx.lineWidth = Math.max(1, brushSize / 8);
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      ctx.fillRect(x, y, w, h);
      ctx.strokeRect(x, y, w, h);
    },
    [brushSize],
  );

  const commitRect = useCallback(
    (start: { x: number; y: number }, end: { x: number; y: number }) => {
      const maskCanvas = maskCanvasRef.current;
      const previewCanvas = previewCanvasRef.current;
      const maskCtx = maskCanvas?.getContext('2d');
      const previewCtx = previewCanvas?.getContext('2d');
      if (!maskCanvas || !maskCtx || !previewCanvas || !previewCtx) return;
      const x = Math.min(start.x, end.x);
      const y = Math.min(start.y, end.y);
      const w = Math.abs(end.x - start.x);
      const h = Math.abs(end.y - start.y);
      if (w < 2 || h < 2) {
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        return;
      }
      maskCtx.globalCompositeOperation = 'source-over';
      maskCtx.fillStyle = PAINT_FILL;
      maskCtx.fillRect(x, y, w, h);
      previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    },
    [],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (submitting || !imageDims) return;
      event.preventDefault();
      event.stopPropagation();
      (event.target as HTMLCanvasElement).setPointerCapture(event.pointerId);
      const coord = canvasToImageCoords(event.clientX, event.clientY);
      if (!coord) return;
      pushUndoSnapshot();
      drawingRef.current = true;
      lastPointRef.current = coord;
      if (tool === 'rect') {
        rectStartRef.current = coord;
      } else {
        drawDot(coord.x, coord.y);
      }
    },
    [canvasToImageCoords, drawDot, imageDims, pushUndoSnapshot, submitting, tool],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      const coord = canvasToImageCoords(event.clientX, event.clientY);
      if (!coord) return;
      if (tool === 'rect') {
        if (rectStartRef.current) drawRectPreview(rectStartRef.current, coord);
      } else {
        if (lastPointRef.current) drawLine(lastPointRef.current, coord);
        lastPointRef.current = coord;
      }
    },
    [canvasToImageCoords, drawLine, drawRectPreview, tool],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement>) => {
      if (!drawingRef.current) return;
      drawingRef.current = false;
      try {
        (event.target as HTMLCanvasElement).releasePointerCapture(event.pointerId);
      } catch {
        // pointer may already be released
      }
      if (tool === 'rect' && rectStartRef.current) {
        const coord = canvasToImageCoords(event.clientX, event.clientY) ?? rectStartRef.current;
        commitRect(rectStartRef.current, coord);
        rectStartRef.current = null;
      }
      lastPointRef.current = null;
      recomputeHasMask();
    },
    [canvasToImageCoords, commitRect, recomputeHasMask, tool],
  );

  // Mask export (for vision models to recognize): the source image + the brushed area binarized into a uniform semi-transparent red highlight, see mask-highlight.ts.
  const buildMaskBlob = useCallback(async (): Promise<Blob> => {
    const mask = maskCanvasRef.current;
    const baseImg = sourceImgRef.current;
    if (!mask) throw new Error('mask canvas not ready');
    if (!baseImg) throw new Error('source image not ready');
    return await buildRedHighlightMaskBlob(baseImg, mask);
  }, []);

  // Build a loading result node and connect an edge, returning the node id immediately (synchronous, not waiting for upload/generation).
  const createEraseNode = useCallback(
    (resultAspectRatio: string, position: { x: number; y: number }) => {
      const generationStartedAt = Date.now();
      const nextNodeId = addNode(CANVAS_NODE_TYPES.exportImage, position, {
        displayName: t('canvas.eraseOverlay.displayName'),
        imageUrl: null,
        previewImageUrl: null,
        aspectRatio: resultAspectRatio,
        resultKind: 'generic',
        isGenerating: true,
        generationStartedAt,
        generationDurationMs: 60000,
      });
      addEdge(node.id, nextNodeId);
      return nextNodeId;
    },
    [addEdge, addNode, node.id],
  );

  // Submit a single-image erase (going through the redraw endpoint) for the already built node -> poll -> backfill.
  const runEraseGeneration = useCallback(
    async (
      project: string,
      nodeId: string,
      sourceUrl: string,
      maskUrl: string,
      resultAspectRatio: string,
    ) => {
      // After a failure the "Regenerate" button reruns the same erase from this (going through the redraw endpoint).
      updateNodeData(nodeId, {
        freezoneRedrawRequest: {
          sourceUrl,
          maskUrl,
          aspectRatio: resultAspectRatio,
          imageSize: effectiveImageSize,
        },
      });
      try {
        const ref = await submitFreezoneRedraw(project, {
          sourceUrl,
          maskUrl,
          aspectRatio: resultAspectRatio as FreezoneRedrawAspectRatio,
          numImages: 1,
          imageSize: effectiveImageSize,
        });
        updateNodeData(nodeId, generationTaskDescriptor(ref));
        const completed = await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
        const directUrl = completed.result?.['output_url'] as string | undefined;
        let url = directUrl;
        if (!url) {
          const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
          url = fallback.url;
        }
        updateNodeData(nodeId, {
          imageUrl: url,
          previewImageUrl: url,
          isGenerating: false,
          generationStartedAt: null,
          ...GENERATION_ERROR_CLEARED_PATCH,
          // Clear the task handle, avoiding a resume scan after refresh misjudging it as "still generating" and polling again.
          generationTaskKey: null,
          generationTaskType: null,
          generationTaskJobId: null,
        });
      } catch (err) {
        // A poll timeout != generation failure: the backend is still running and the task handle on the node can still be resumed.
        // Writing an error banner would mark a live task as failed and clear the handle.
        if (isTaskPollTimeoutError(err)) {
          notifyTaskStillRunning(t);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error('[erase] generation failed', err);
        updateNodeData(nodeId, {
          isGenerating: false,
          generationStartedAt: null,
          generationError: message,
          generationTaskKey: null,
          generationTaskType: null,
          generationTaskJobId: null,
        });
      }
    },
    [effectiveImageSize, t, updateNodeData],
  );

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    const project = readUrl().project;
    if (!project) {
      setError(t('canvas.paintTools.noProject'));
      return;
    }
    if (!hasMask) {
      setError(t('canvas.eraseOverlay.needMask'));
      return;
    }
    setError(null);
    setSubmitting(true);

    const resultAspectRatio = effectiveAspectRatio;
    const base = findNodePosition(
      node.id,
      EXPORT_RESULT_NODE_DEFAULT_WIDTH,
      EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
    );

    // Count > 1: first build all loading nodes at once (staggered vertically), then upload the mask and launch single-image requests.
    const count = Math.max(1, numImages);
    const nodeIds = Array.from({ length: count }, (_unused, i) =>
      createEraseNode(resultAspectRatio, {
        x: base.x,
        y: base.y + i * (EXPORT_RESULT_NODE_LAYOUT_HEIGHT + RESULT_STACK_GAP),
      }),
    );
    setSelectedNode(nodeIds[0]);
    onClose();

    try {
      const sourceUrl = baseUrlRef.current;
      const maskBlob = await buildMaskBlob();
      const maskFile = new File([maskBlob], `mask-${node.id}-${Date.now()}.png`, {
        type: 'image/png',
      });
      const uploaded = await uploadFreezoneImage(project, maskFile);
      const maskUrl = uploaded.url.split('?')[0];

      nodeIds.forEach((id) =>
        void runEraseGeneration(project, id, sourceUrl, maskUrl, resultAspectRatio),
      );
    } catch (err) {
      // A prerequisite step such as mask upload failed: mark all the placeholder nodes as failed.
      const message = err instanceof Error ? err.message : String(err);
      console.error('[erase] submit failed', err);
      nodeIds.forEach((id) =>
        updateNodeData(id, {
          isGenerating: false,
          generationStartedAt: null,
          generationError: message,
        }),
      );
    } finally {
      setSubmitting(false);
    }
  }, [
    effectiveAspectRatio,
    buildMaskBlob,
    createEraseNode,
    findNodePosition,
    hasMask,
    node,
    numImages,
    onClose,
    runEraseGeneration,
    setSelectedNode,
    submitting,
    updateNodeData,
  ]);

  const cursor = useMemo(() => {
    if (tool === 'eraser') return 'cell';
    return 'crosshair';
  }, [tool]);
  const brushPercent = ((brushSize - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN)) * 100;
  const brushSliderStyle = {
    background: `linear-gradient(to right, #5b8cff 0%, #5b8cff ${brushPercent}%, rgba(255,255,255,0.28) ${brushPercent}%, rgba(255,255,255,0.28) 100%)`,
  };

  return (
    <>
      {/* Mask drawing layer: covers the image shown on the node (aligned with zoom). */}
      <ReactFlowNodeToolbar
        nodeId={node.id}
        isVisible
        position={Position.Top}
        align="center"
        offset={0}
        className={NODE_TOOLBAR_CLASS}
      >
        <div className="relative" style={{ width: 0, height: 0 }}>
          <div
            className="absolute overflow-hidden rounded-[var(--node-radius)]"
            style={{
              width: display.width,
              height: display.height,
              left: '50%',
              top: (nodeHeight * zoom) / 2,
              transform: 'translate(-50%, -50%)',
              cursor,
            }}
          >
            <canvas
              ref={maskCanvasRef}
              className="pointer-events-none absolute inset-0 h-full w-full"
            />
            <canvas
              ref={previewCanvasRef}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              className="absolute inset-0 h-full w-full"
              style={{ touchAction: 'none' }}
            />
          </div>
        </div>
      </ReactFlowNodeToolbar>

      {/* Top erase toolbar. */}
      <ReactFlowNodeToolbar
        nodeId={node.id}
        isVisible
        position={Position.Top}
        align="center"
        offset={16}
        className={NODE_TOOLBAR_CLASS}
      >
        <div
          className={ERASE_TOOLBAR_CLASS}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className={`${ERASE_TOOLBAR_BUTTON_CLASS} text-text-dark/72 hover:bg-white/[0.08] hover:text-text-dark`}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            title={t('canvas.eraseOverlay.close')}
            aria-label={t('canvas.eraseOverlay.close')}
          >
            <X className="h-4 w-4" />
          </button>

          <ToolbarDivider />

          <ToolBtn active={tool === 'brush'} onClick={() => setTool('brush')} title={t('canvas.paintTools.brush')}>
            <Brush className="h-4 w-4" />
          </ToolBtn>
          <ToolBtn active={tool === 'rect'} onClick={() => setTool('rect')} title={t('canvas.paintTools.rect')}>
            <Square className="h-4 w-4" />
          </ToolBtn>
          <ToolBtn active={tool === 'eraser'} onClick={() => setTool('eraser')} title={t('canvas.paintTools.eraser')}>
            <Eraser className="h-4 w-4" />
          </ToolBtn>

          <ToolbarDivider />

          <div className="flex items-center gap-2 px-1.5 text-text-muted">
            <Spline className="h-4 w-4 shrink-0" />
            <input
              type="range"
              min={BRUSH_MIN}
              max={BRUSH_MAX}
              step={2}
              value={brushSize}
              onChange={(event) => setBrushSize(Number(event.target.value))}
              onPointerDown={(event) => event.stopPropagation()}
              onMouseDown={(event) => event.stopPropagation()}
              className={ERASE_SLIDER_CLASS}
              style={brushSliderStyle}
              title={t('canvas.paintTools.brushSize')}
            />
          </div>

          <ToolbarDivider />

          <IconBtn onClick={handleUndo} disabled={!canUndo} title={t('canvas.paintTools.undo')}>
            <Undo2 className="h-4 w-4" />
          </IconBtn>
          <IconBtn onClick={handleRedo} disabled={!canRedo} title={t('canvas.paintTools.redo')}>
            <Redo2 className="h-4 w-4" />
          </IconBtn>
        </div>
      </ReactFlowNodeToolbar>

      {/* Bottom generation control bar: ratio / resolution / count / submit (no model selection, no prompt). */}
      <ReactFlowNodeToolbar
        nodeId={node.id}
        isVisible
        position={Position.Bottom}
        align="center"
        offset={12}
        className={NODE_TOOLBAR_CLASS}
      >
        <div
          className={`flex items-center gap-1 ${CANVAS_NODE_TOOLBAR_PILL_CLASS}`}
          onClick={(event) => event.stopPropagation()}
        >
          <EraseDropdown<FreezoneRedrawAspectRatio>
            label={t('canvas.paintTools.aspect')}
            value={effectiveAspectRatio}
            options={aspectRatioOptions}
            renderLabel={(v) => {
              const key = ASPECT_RATIO_LABEL_KEYS[v];
              return key ? t(key) : v;
            }}
            onChange={setAspectRatio}
          />
          <EraseDropdown<string>
            label={t('canvas.paintTools.resolution')}
            value={effectiveImageSize}
            options={sizeOptions}
            renderLabel={(v) => v}
            onChange={setImageSize}
          />
          <EraseDropdown<number>
            label={t('canvas.paintTools.count')}
            value={numImages}
            options={NUM_IMAGE_OPTIONS}
            renderLabel={(v) => t('canvas.paintTools.countValue', { n: v })}
            onChange={setNumImages}
          />

          {error && <span className="max-w-[160px] truncate px-1 text-xs text-red-400">{error}</span>}
          <CreditCostPill
            display={costDisplay}
            promotion={creditCost.data?.data.promotion}
            className={NODE_CREDIT_PILL_FLAT_CLASS}
          />

          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || !imageDims || billingRuleMissing}
            className={`ml-1 shrink-0 ${NODE_GENERATE_BUTTON_BASE_CLASS} ${NODE_GENERATE_BUTTON_ENABLED_CLASS} disabled:cursor-not-allowed disabled:opacity-50`}
            title={t('canvas.eraseOverlay.submit')}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </ReactFlowNodeToolbar>
    </>
  );
});

EraseOverlay.displayName = 'EraseOverlay';

function ToolbarDivider() {
  return <span className="mx-1 h-5 w-px bg-white/15" aria-hidden />;
}

function ToolBtn({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      title={title}
      aria-label={title}
      className={
        `${ERASE_TOOLBAR_BUTTON_CLASS} ` +
        (active
          ? 'text-[#5b8cff]'
          : 'text-text-dark/42 hover:bg-white/[0.08] hover:text-text-dark/72')
      }
    >
      {children}
    </button>
  );
}

function IconBtn({
  onClick,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
      disabled={disabled}
      title={title}
      aria-label={title}
      className={`${ERASE_TOOLBAR_BUTTON_CLASS} text-text-dark/72 hover:bg-white/[0.08] hover:text-text-dark disabled:opacity-30`}
    >
      {children}
    </button>
  );
}

interface EraseDropdownProps<T extends string | number> {
  label: string;
  value: T;
  options: readonly T[];
  renderLabel: (value: T) => string;
  onChange: (next: T) => void;
}

function EraseDropdown<T extends string | number>({
  label,
  value,
  options,
  renderLabel,
  onChange,
}: EraseDropdownProps<T>) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [isOpen]);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={label}
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className="inline-flex h-8 items-center gap-1 rounded-full px-2.5 text-xs font-medium text-text-dark transition-colors hover:bg-white/[0.08]"
      >
        <span>{renderLabel(value)}</span>
        <ChevronDown className="h-3 w-3 text-text-muted" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          role="listbox"
          className="absolute bottom-full left-1/2 z-50 mb-2 min-w-[96px] -translate-x-1/2 rounded-xl border border-white/10 bg-surface-dark/95 p-1 shadow-2xl backdrop-blur-md"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="mb-1 px-2 py-1 text-[11px] uppercase tracking-wide text-text-muted">
            {label}
          </div>
          {options.map((option) => {
            const isActive = option === value;
            return (
              <button
                key={String(option)}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  onChange(option);
                  setIsOpen(false);
                }}
                className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-xs font-medium transition-colors ${
                  isActive
                    ? 'bg-[rgb(var(--accent-rgb))] text-white'
                    : 'text-text-muted hover:bg-white/[0.08] hover:text-text-dark'
                }`}
              >
                {renderLabel(option)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

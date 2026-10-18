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
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Brush,
  ChevronDown,
  Eraser,
  RotateCcw,
  Square,
  Undo2,
  X,
} from 'lucide-react';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
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
import {
  DEFAULT_SHARED_MODEL_ID,
  ProviderModelPicker,
} from '@/features/canvas/ui/ProviderModelPicker';
import {
  CANVAS_NODE_INPUT_PLACEHOLDER_CLASS,
} from '@/features/canvas/ui/nodeFrameStyles';
import {
  isAuthoritativeEmptyCatalog,
  useFreezoneImageModels,
} from '@/features/canvas/hooks/useFreezoneImageModels';
import { inheritMainlineFields } from '@/features/canvas/domain/inheritMainlineFields';
import { CreditCostPill } from '@/components/credits/credit-visual';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { BillingRuleNotConfiguredError } from '@/lib/api-errors';
import { FREEZONE_IMAGE_FEATURES } from '@/features/canvas/application/freezoneImageFeatureBilling';
import { NODE_CREDIT_PILL_FLAT_CLASS } from './nodeControlStyles';

interface RedrawOverlayProps {
  node: CanvasNode;
  imageSource: string;
  onClose: () => void;
}

type Tool = 'brush' | 'rect' | 'eraser';

// "Keep the original aspect ratio" is not the capability of a model but semantics built into the redraw endpoint, and always comes before the
// ratio tiers configured in the backend. The remaining tiers come from the selected model's catalog config.
const ORIGINAL_ASPECT_RATIO: FreezoneRedrawAspectRatio = 'original';

const NUM_IMAGE_OPTIONS = [1, 2, 3, 4] as const;
// Spacing by which multiple result nodes are staggered vertically when count > 1.
const RESULT_STACK_GAP = 24;
const BRUSH_MIN = 4;
const BRUSH_MAX = 200;
const DEFAULT_BRUSH = 40;
const PAINT_FILL = 'rgba(239, 68, 68, 0.55)';
const PAINT_STROKE = 'rgba(239, 68, 68, 0.55)';
const REDRAW_MODAL_CLASS =
  'relative flex h-[min(700px,78vh)] w-[min(860px,86vw)] flex-col overflow-hidden rounded-[10px] border border-white/[0.12] bg-[#15161b]/96 shadow-[0_18px_48px_rgba(0,0,0,0.45)] backdrop-blur-md';
const REDRAW_TEXT_BUTTON_CLASS =
  'inline-flex items-center gap-1 rounded px-1.5 text-xs text-text-dark/62 transition-colors hover:text-text-dark disabled:opacity-30';
const REDRAW_SELECT_CLASS =
  'h-7 appearance-none rounded border border-transparent bg-transparent py-0 pl-0 pr-4 text-xs text-text-dark outline-none transition-colors hover:text-white disabled:opacity-45';
const REDRAW_PROMPT_CLASS =
  'h-[72px] w-full resize-none rounded-[8px] border border-white/[0.08] bg-bg-dark/42 px-3 py-2 text-sm text-text-dark outline-none transition-colors placeholder:text-text-dark/52 focus:border-white/[0.16]';
const BRUSH_SLIDER_CLASS =
  'h-0.5 w-24 cursor-pointer appearance-none rounded-full [&::-webkit-slider-thumb]:h-2.5 [&::-webkit-slider-thumb]:w-2.5 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-[#5b8cff] [&::-webkit-slider-thumb]:shadow-none [&::-moz-range-thumb]:h-2.5 [&::-moz-range-thumb]:w-2.5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-[#5b8cff]';
const REDRAW_CONFIRM_BUTTON_CLASS =
  'inline-flex h-8 items-center justify-center rounded-[8px] bg-white px-4 text-sm font-medium text-bg-dark transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/5 disabled:text-text-muted/40';

export const RedrawOverlay = memo(({ node, imageSource, onClose }: RedrawOverlayProps) => {
  const { t } = useTranslation();
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  const baseCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const maskCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);
  const lastPointRef = useRef<{ x: number; y: number } | null>(null);
  const rectStartRef = useRef<{ x: number; y: number } | null>(null);
  const undoStackRef = useRef<ImageData[]>([]);
  const baseUrlRef = useRef(imageSource.split('?')[0]);

  const [tool, setTool] = useState<Tool>('brush');
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH);
  const [imageReady, setImageReady] = useState(false);
  const [hasMask, setHasMask] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [prompt, setPrompt] = useState('');
  const [modelId, setModelId] = useState<string>(DEFAULT_SHARED_MODEL_ID);
  const imageCatalog = useFreezoneImageModels();
  const availableModels = imageCatalog.models;
  // Submission is forbidden when the backend has really configured not a single image model: the backend `_resolve_catalog_request`
  // returns 409 straight away for an empty catalog, and making the user click once only to receive an error is the worst experience.
  const catalogIsEmpty = isAuthoritativeEmptyCatalog(imageCatalog);
  const [imageSize, setImageSize] = useState<string>('2K');
  const [numImages, setNumImages] = useState<number>(1);
  const [aspectRatio, setAspectRatio] = useState<FreezoneRedrawAspectRatio>(
    ORIGINAL_ASPECT_RATIO,
  );
  // When the catalog is empty, deliberately leave selectedModel undefined. There used to be a trailing
  // `?? SHARED_MODELS.find(...)` here, which revives the frontend hard-coded model as an available one -
  // exactly the source of "the backend configured no model yet the UI still looks usable".
  const selectedModel =
    availableModels.find((m) => m.id === modelId) ?? availableModels[0];
  // Size / ratio / quality all follow the backend's config for that model, and out-of-range old selections are pulled back when the model changes.
  const sizeOptions = useMemo(() => resolveModelSizeOptions(selectedModel), [selectedModel]);
  const aspectRatioOptions = useMemo<FreezoneRedrawAspectRatio[]>(() => {
    const configured = resolveModelAspectOptions(selectedModel).filter(
      (ratio): ratio is FreezoneRedrawAspectRatio =>
        ratio !== ORIGINAL_ASPECT_RATIO
        && (FREEZONE_REDRAW_ASPECT_RATIOS as readonly string[]).includes(ratio),
    );
    return [ORIGINAL_ASPECT_RATIO, ...configured];
  }, [selectedModel]);
  const effectiveImageSize = pickAllowedOption(imageSize, sizeOptions);
  const effectiveAspectRatio = pickAllowedOption(
    aspectRatio,
    aspectRatioOptions,
  ) as FreezoneRedrawAspectRatio;
  const qualityOptions = useMemo(
    () => resolveModelQualityOptions(selectedModel),
    [selectedModel],
  );
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
        operation: 'redraw',
        pricing_quantity: Math.min(Math.max(numImages, 1), 4),
      }),
      quantity: Math.min(Math.max(numImages, 1), 4),
    },
  );
  const billingRuleMissing =
    creditCost.error instanceof BillingRuleNotConfiguredError;
  const submitDisabled =
    submitting || !imageReady || billingRuleMissing || catalogIsEmpty;
  const costDisplay =
    creditCost.data?.data.display ??
    (billingRuleMissing ? t('common.billingRuleNotConfiguredShort') : null);

  // Load base image, size all canvases.
  useEffect(() => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.src = imageSource;
    img.onload = () => {
      const baseCanvas = baseCanvasRef.current;
      const maskCanvas = maskCanvasRef.current;
      const previewCanvas = previewCanvasRef.current;
      if (!baseCanvas || !maskCanvas || !previewCanvas) return;
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      [baseCanvas, maskCanvas, previewCanvas].forEach((c) => {
        c.width = w;
        c.height = h;
      });
      baseCanvas.getContext('2d')?.drawImage(img, 0, 0);
      setImageReady(true);
    };
    img.onerror = () => setError(t('canvas.paintTools.loadSourceFailed'));
  }, [imageSource, t]);

  const recomputeHasMask = useCallback(() => {
    const canvas = maskCanvasRef.current;
    if (!canvas) {
      setHasMask(false);
      return;
    }
    const ctx = canvas.getContext('2d');
    if (!ctx) {
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

  const pushUndoSnapshot = useCallback(() => {
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    if (undoStackRef.current.length >= 32) {
      undoStackRef.current.shift();
    }
    undoStackRef.current.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
  }, []);

  const handleUndo = useCallback(() => {
    const canvas = maskCanvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const snap = undoStackRef.current.pop();
    if (!snap) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    } else {
      ctx.putImageData(snap, 0, 0);
    }
    recomputeHasMask();
  }, [recomputeHasMask]);

  const handleReset = useCallback(() => {
    const canvas = maskCanvasRef.current;
    const previewCanvas = previewCanvasRef.current;
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
    previewCanvas?.getContext('2d')?.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
    undoStackRef.current = [];
    setHasMask(false);
  }, []);

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
      if (submitting || !imageReady) return;
      event.preventDefault();
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
    [canvasToImageCoords, drawDot, imageReady, pushUndoSnapshot, submitting, tool],
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
  // baseCanvas was already drawn when the source image was loaded.
  const buildMaskBlob = useCallback(async (): Promise<Blob> => {
    const mask = maskCanvasRef.current;
    const baseCanvas = baseCanvasRef.current;
    if (!mask) throw new Error('mask canvas not ready');
    if (!baseCanvas) throw new Error('source image not ready');
    return await buildRedHighlightMaskBlob(baseCanvas, mask);
  }, []);

  // Build a loading result node and connect an edge, returning the node id immediately (synchronous, not waiting for upload/generation).
  const createRedrawNode = useCallback(
    (sourceAspectRatio: string, masked: boolean, position: { x: number; y: number }) => {
      const generationStartedAt = Date.now();
      const displayName = masked
        ? t('canvas.redrawOverlay.maskedDisplayName')
        : t('canvas.redrawOverlay.displayName');
      // 1→1 redraw / mask-redraw: inherit source's mainline fields so the
      // child still targets the same canonical slot at Push. user_spawned is
      // stamped by inheritMainlineFields; preset_managed never set.
      const initialData = inheritMainlineFields(
        { data: node.data as Record<string, unknown> },
        {
          displayName,
          imageUrl: null,
          previewImageUrl: null,
          aspectRatio: sourceAspectRatio,
          resultKind: 'generic',
          isGenerating: true,
          generationStartedAt,
          generationDurationMs: 60000,
        },
      );
      const nextNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        position,
        initialData as unknown as Parameters<typeof addNode>[2],
      );
      addEdge(node.id, nextNodeId);
      return nextNodeId;
    },
    [addEdge, addNode, node],
  );

  // Submit a single-image redraw (num_images=1) for the already built node -> poll -> backfill.
  const runRedrawGeneration = useCallback(
    async (
      project: string,
      nodeId: string,
      sourceUrl: string,
      maskUrl: string | null,
      apiModel: string,
    ) => {
      try {
        const ref = await submitFreezoneRedraw(project, {
          sourceUrl,
          maskUrl,
          prompt,
          aspectRatio: effectiveAspectRatio,
          numImages: 1,
          imageSize: effectiveImageSize,
          model: apiModel,
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
        });
      } catch (err) {
        // A poll timeout != generation failure: the backend is still running and the task handle on the node can still be resumed.
        // Writing an error banner would mark a live task as failed and clear the handle.
        if (isTaskPollTimeoutError(err)) {
          notifyTaskStillRunning(t);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error('[redraw] generation failed', err);
        updateNodeData(nodeId, {
          isGenerating: false,
          generationStartedAt: null,
          generationError: message,
        });
      }
    },
    [effectiveAspectRatio, effectiveImageSize, prompt, t, updateNodeData],
  );

  const handleSubmit = useCallback(async () => {
    if (submitting) return;
    // The button is already disabled, so block once more here: with no available model a request must never be sent.
    if (catalogIsEmpty) {
      setError(t('modelParams.noModelsAvailable'));
      return;
    }
    const project = readUrl().project;
    if (!project) {
      setError(t('canvas.paintTools.noProject'));
      return;
    }
    if (!hasMask && !prompt.trim()) {
      setError(t('canvas.redrawOverlay.needPromptOrMask'));
      return;
    }
    setError(null);
    setSubmitting(true);

    const sourceAspectRatio =
      typeof (node.data as { aspectRatio?: unknown }).aspectRatio === 'string'
        ? ((node.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
        : DEFAULT_ASPECT_RATIO;
    const base = findNodePosition(
      node.id,
      EXPORT_RESULT_NODE_DEFAULT_WIDTH,
      EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
    );

    // The backend redraw produces only 1 image at a time: choosing N images builds N loading nodes (staggered vertically),
    // the mask is uploaded only once and shared by all, then N single-image requests are launched each with independent polling/backfill/error reporting.
    const count = Math.max(1, numImages);
    const nodeIds = Array.from({ length: count }, (_unused, i) =>
      createRedrawNode(sourceAspectRatio, hasMask, {
        x: base.x,
        y: base.y + i * (EXPORT_RESULT_NODE_LAYOUT_HEIGHT + RESULT_STACK_GAP),
      }),
    );
    setSelectedNode(nodeIds[0]);
    onClose();

    try {
      const sourceUrl = baseUrlRef.current;
      // The mask only needs uploading once, shared by all the images.
      let maskUrl: string | null = null;
      if (hasMask) {
        const maskBlob = await buildMaskBlob();
        const maskFile = new File([maskBlob], `mask-${node.id}-${Date.now()}.png`, {
          type: 'image/png',
        });
        const uploaded = await uploadFreezoneImage(project, maskFile);
        maskUrl = uploaded.url.split('?')[0];
      }
      const apiModel = selectedModel?.apiModel ?? modelId;
      nodeIds.forEach((id) =>
        void runRedrawGeneration(project, id, sourceUrl, maskUrl, apiModel),
      );
    } catch (err) {
      // A prerequisite step such as mask upload failed: mark all the placeholder nodes as failed.
      const message = err instanceof Error ? err.message : String(err);
      console.error('[redraw] submit failed', err);
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
    buildMaskBlob,
    catalogIsEmpty,
    createRedrawNode,
    findNodePosition,
    hasMask,
    modelId,
    node,
    numImages,
    onClose,
    prompt,
    runRedrawGeneration,
    selectedModel,
    setSelectedNode,
    submitting,
    t,
    updateNodeData,
  ]);

  const cursor = useMemo(() => {
    if (!imageReady) return 'default';
    if (tool === 'rect') return 'crosshair';
    if (tool === 'eraser') return 'cell';
    return 'crosshair';
  }, [imageReady, tool]);

  const submitLabel = hasMask
    ? t('canvas.redrawOverlay.submitMasked')
    : t('canvas.redrawOverlay.submitWhole');
  const brushPercent = ((brushSize - BRUSH_MIN) / (BRUSH_MAX - BRUSH_MIN)) * 100;
  const brushSliderStyle = {
    background: `linear-gradient(to right, #5b8cff 0%, #5b8cff ${brushPercent}%, rgba(255,255,255,0.28) ${brushPercent}%, rgba(255,255,255,0.28) 100%)`,
  };

  const overlay = (
    <div
      className="fixed inset-0 z-[300] flex items-center justify-center bg-black/72 p-4 backdrop-blur-sm"
      onClick={(event) => {
        if (event.target === event.currentTarget && !submitting) {
          onClose();
        }
      }}
    >
      <div
        className={REDRAW_MODAL_CLASS}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="pointer-events-none absolute left-4 right-4 top-3 z-10 flex h-9 items-center justify-between gap-3">
          <div className="pointer-events-auto flex items-center gap-5">
            <div className="flex items-center gap-2">
              <ToolBtn active={tool === 'brush'} onClick={() => setTool('brush')} title={t('canvas.paintTools.brush')}>
                <Brush className="h-4 w-4" />
              </ToolBtn>
              <ToolBtn active={tool === 'rect'} onClick={() => setTool('rect')} title={t('canvas.paintTools.rect')}>
                <Square className="h-4 w-4" />
              </ToolBtn>
              <ToolBtn active={tool === 'eraser'} onClick={() => setTool('eraser')} title={t('canvas.paintTools.eraser')}>
                <Eraser className="h-4 w-4" />
              </ToolBtn>
            </div>

            <div className="flex items-center gap-2 text-xs text-text-dark/68">
              <span className="whitespace-nowrap">{t('canvas.paintTools.thickness')}</span>
              <input
                type="range"
                min={BRUSH_MIN}
                max={BRUSH_MAX}
                step={2}
                value={brushSize}
                onChange={(event) => setBrushSize(Number(event.target.value))}
                className={BRUSH_SLIDER_CLASS}
                style={brushSliderStyle}
              />
              <span className="w-7 tabular-nums text-right text-text-dark/62">{brushSize}</span>
            </div>
          </div>

          <div className="pointer-events-auto flex items-center gap-1">
            <button
              type="button"
              onClick={handleUndo}
              disabled={submitting || undoStackRef.current.length === 0}
              className={REDRAW_TEXT_BUTTON_CLASS}
              title={t('canvas.paintTools.undo')}
            >
              <Undo2 className="h-3.5 w-3.5" />
              {t('canvas.paintTools.undoShort')}
            </button>
            <button
              type="button"
              onClick={handleReset}
              disabled={submitting}
              className={REDRAW_TEXT_BUTTON_CLASS}
              title={t('canvas.redrawOverlay.clearMask')}
            >
              <RotateCcw className="h-3.5 w-3.5" />
              {t('canvas.paintTools.reset')}
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={submitting}
              className={REDRAW_TEXT_BUTTON_CLASS}
            >
              <X className="h-3.5 w-3.5" />
              {t('canvas.redrawOverlay.exit')}
            </button>
          </div>
        </div>

        <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-[#111214]/80 p-4 pt-14">
          {!imageReady && (
            <div className="text-sm text-text-muted">{t('canvas.paintTools.loadingSource')}</div>
          )}
          <div
            className={`relative max-h-full max-w-full ${imageReady ? '' : 'hidden'}`}
            style={{ cursor }}
          >
            <canvas
              ref={baseCanvasRef}
              className="pointer-events-none block max-h-[calc(78vh-265px)] max-w-full"
            />
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

        <div className="shrink-0 space-y-3 bg-[#242426]/95 px-4 py-3">
          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={submitting}
            placeholder={
              hasMask
                ? t('canvas.redrawOverlay.promptPlaceholderMasked')
                : t('canvas.redrawOverlay.promptPlaceholderWhole')
            }
            className={`${REDRAW_PROMPT_CLASS} ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
          />

          <div className="flex flex-wrap items-center gap-5 text-xs text-text-dark/58">
            <Field label={t('modelPicker.model')}>
              <ProviderModelPicker
                selectedModelId={modelId}
                onChange={setModelId}
                popoverPlacement="top"
              />
            </Field>
            <Field label="image_size">
              <RedrawSelect
                value={effectiveImageSize}
                onChange={(event) => setImageSize(event.target.value)}
                disabled={submitting}
              >
                {sizeOptions.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </RedrawSelect>
            </Field>
            <Field label={t('canvas.paintTools.count')}>
              <RedrawSelect
                value={numImages}
                onChange={(event) => setNumImages(Number(event.target.value))}
                disabled={submitting}
              >
                {NUM_IMAGE_OPTIONS.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </RedrawSelect>
            </Field>
            <Field label={t('canvas.redrawOverlay.targetAspect')}>
              <RedrawSelect
                value={effectiveAspectRatio}
                onChange={(event) =>
                  setAspectRatio(event.target.value as FreezoneRedrawAspectRatio)
                }
                disabled={submitting}
              >
                {aspectRatioOptions.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </RedrawSelect>
            </Field>

            <div className="ml-auto flex items-center gap-2">
              {error && <span className="text-red-400">{error}</span>}
              <CreditCostPill
                display={costDisplay}
                promotion={creditCost.data?.data.promotion}
                className={NODE_CREDIT_PILL_FLAT_CLASS}
              />
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitDisabled}
                className={REDRAW_CONFIRM_BUTTON_CLASS}
                title={
                  catalogIsEmpty ? t('modelParams.noModelsAvailable') : submitLabel
                }
              >
                {t('toolDialog.confirm')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  if (typeof document === 'undefined') {
    return overlay;
  }

  return createPortal(overlay, document.body);
});

RedrawOverlay.displayName = 'RedrawOverlay';

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
        'flex h-8 w-8 items-center justify-center rounded-full transition-colors ' +
        (active
          ? 'text-[#5b8cff]'
          : 'text-text-dark/42 hover:bg-white/[0.06] hover:text-text-dark/76')
      }
    >
      {children}
    </button>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center gap-1.5">
      <span>{label}</span>
      {children}
    </label>
  );
}

function RedrawSelect({
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <span className="relative inline-flex items-center">
      <select {...props} className={REDRAW_SELECT_CLASS}>
        {children}
      </select>
      <ChevronDown className="pointer-events-none absolute right-0 h-3 w-3 text-text-dark/52" />
    </span>
  );
}

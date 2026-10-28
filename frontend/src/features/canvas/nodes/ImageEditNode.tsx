// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  memo,
  useMemo,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react';
import { Handle, Position, useUpdateNodeInternals, type NodeProps } from '@xyflow/react';
import { ImageIcon, Maximize2, Sparkles, UploadCloud } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  AUTO_REQUEST_ASPECT_RATIO,
  CANVAS_NODE_TYPES,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  type ImageEditNodeData,
  type ImageSize,
} from '@/features/canvas/domain/canvasNodes';
import { localizeNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { coerceSlotTarget } from '@/features/canvas/domain/mainlineNodeTypes';
import { AddNodeToChatButton } from '@/features/canvas/ui/AddNodeToChatButton';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { ReferenceDetachButton } from '@/features/canvas/nodes/shared/ReferenceDetachButton';
import { ReferenceTextChip } from '@/features/canvas/nodes/shared/ReferenceTextChip';
import {
  AssetLibraryModal,
  type AssetLibrarySelection,
} from '@/features/canvas/ui/AssetLibraryModal';
import { useModelTaskAccess } from '@/lib/model-task-access';
import { readUrl } from '@/lib/url-params';
import { useDetachUpstream } from '@/features/canvas/hooks/useDetachUpstream';
import { useReferenceMentionSync } from '@/features/canvas/nodes/useReferenceMentionSync';
import { canvasAiGateway } from '@/features/canvas/application/canvasServices';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import {
  collectUpstreamReferenceUrls,
  joinUpstreamText,
} from '@/features/canvas/application/graphContentResolver';
import {
  useUpstreamContents,
  useUpstreamImages,
} from '@/features/canvas/application/useUpstreamGraph';
import { resolveErrorContent, showErrorDialog } from '@/features/canvas/application/errorDialog';
import { backendErrorToastMessage } from '@/lib/api-errors';
import {
  detectAspectRatio,
  parseAspectRatio,
  pickClosestAspectRatio,
  resolveImageDisplayUrl,
} from '@/features/canvas/application/imageData';
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
  createReferenceImagePlaceholders,
  getRuntimeDiagnostics,
  resolveGenerationErrorDiagnostics,
  type GenerationDebugContext,
} from '@/features/canvas/application/generationErrorReport';
import {
  findReferenceTokens,
  findReferenceTokenAtSelection,
  insertReferenceToken,
  removeTextRange,
  replaceReferenceToken,
  resolveReferenceAwareDeleteRange,
} from '@/features/canvas/application/referenceTokenEditing';
import {
  resolveImageModelResolution,
  resolveImageModelResolutions,
} from '@/features/canvas/models';
import {
  EMPTY_CATALOG_IMAGE_MODEL,
  useCatalogImageModels,
} from '@/features/canvas/domain/catalogImageModels';
import { MediaModelParameterChip } from '@/features/canvas/ui/MediaModelParameterChip';
import { resolveModelPriceDisplay } from '@/features/canvas/pricing';
import {
  NODE_CONTROL_CHIP_CLASS,
  NODE_CONTROL_ICON_CLASS,
  NODE_CONTROL_MODEL_CHIP_CLASS,
  NODE_CONTROL_PARAMS_CHIP_CLASS,
  NODE_CONTROL_PRIMARY_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { ModelParamsControls } from '@/features/canvas/ui/ModelParamsControls';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { NodePriceBadge } from '@/features/canvas/ui/NodePriceBadge';
import {
  CANVAS_NODE_INPUT_FRAME_CLASS,
  CANVAS_NODE_INPUT_PLACEHOLDER_CLASS,
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  CANVAS_NODE_PANEL_SURFACE_CLASS,
  canvasNodeFrameClass,
} from '@/features/canvas/ui/nodeFrameStyles';
import {
  defaultCapabilityParams,
  getCapability,
  listCapabilities,
  stringifyParamValue,
  type CapabilityParamDefinition,
} from '@/features/freezone/capabilities/capabilityRegistry';
import { UiButton } from '@/components/ui';
import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';

type ImageEditNodeProps = NodeProps & {
  id: string;
  data: ImageEditNodeData;
  selected?: boolean;
};

interface AspectRatioChoice {
  value: string;
  label: string;
}

interface PickerAnchor {
  left: number;
  top: number;
}

const PICKER_FALLBACK_ANCHOR: PickerAnchor = { left: 8, top: 8 };
const PICKER_Y_OFFSET_PX = 20;
const IMAGE_EDIT_NODE_MIN_WIDTH = 520;
const IMAGE_EDIT_NODE_MIN_HEIGHT = 420;
const IMAGE_EDIT_NODE_MAX_WIDTH = 1400;
const IMAGE_EDIT_NODE_MAX_HEIGHT = 1000;
const IMAGE_EDIT_NODE_DEFAULT_WIDTH = 640;
const IMAGE_EDIT_NODE_DEFAULT_HEIGHT = 520;

type FreezoneSourceMeta = {
  kind?: string;
  role?: string;
  label?: string;
  rel_path?: string;
  meta?: Record<string, unknown>;
  [key: string]: unknown;
};

function getTextareaCaretOffset(
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  const mirror = document.createElement('div');
  const computed = window.getComputedStyle(textarea);
  const mirrorStyle = mirror.style;

  mirrorStyle.position = 'absolute';
  mirrorStyle.visibility = 'hidden';
  mirrorStyle.pointerEvents = 'none';
  mirrorStyle.whiteSpace = 'pre-wrap';
  mirrorStyle.overflowWrap = 'break-word';
  mirrorStyle.wordBreak = 'break-word';
  mirrorStyle.boxSizing = computed.boxSizing;
  mirrorStyle.width = `${textarea.clientWidth}px`;
  mirrorStyle.font = computed.font;
  mirrorStyle.lineHeight = computed.lineHeight;
  mirrorStyle.letterSpacing = computed.letterSpacing;
  mirrorStyle.padding = computed.padding;
  mirrorStyle.border = computed.border;
  mirrorStyle.textTransform = computed.textTransform;
  mirrorStyle.textIndent = computed.textIndent;

  mirror.textContent = textarea.value.slice(0, caretIndex);

  const marker = document.createElement('span');
  marker.textContent = textarea.value.slice(caretIndex, caretIndex + 1) || ' ';
  mirror.appendChild(marker);

  document.body.appendChild(mirror);

  const left = marker.offsetLeft - textarea.scrollLeft;
  const top = marker.offsetTop - textarea.scrollTop;

  document.body.removeChild(mirror);

  return {
    left: Math.max(0, left),
    top: Math.max(0, top),
  };
}

function resolvePickerAnchor(
  container: HTMLDivElement | null,
  textarea: HTMLTextAreaElement,
  caretIndex: number
): PickerAnchor {
  if (!container) {
    return PICKER_FALLBACK_ANCHOR;
  }

  const containerRect = container.getBoundingClientRect();
  const textareaRect = textarea.getBoundingClientRect();
  const caretOffset = getTextareaCaretOffset(textarea, caretIndex);

  return {
    left: Math.max(0, textareaRect.left - containerRect.left + caretOffset.left),
    top: Math.max(0, textareaRect.top - containerRect.top + caretOffset.top + PICKER_Y_OFFSET_PX),
  };
}

function renderPromptWithHighlights(prompt: string, maxImageCount: number): ReactNode {
  if (!prompt) {
    return ' ';
  }

  const segments: ReactNode[] = [];
  let lastIndex = 0;
  const referenceTokens = findReferenceTokens(prompt, maxImageCount);
  for (const token of referenceTokens) {
    const matchStart = token.start;
    const matchText = token.token;

    if (matchStart > lastIndex) {
      segments.push(
        <span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex, matchStart)}</span>
      );
    }

    segments.push(
      <span
        key={`ref-${matchStart}`}
        className="relative z-0 text-white [text-shadow:0.24px_0_currentColor,-0.24px_0_currentColor] before:absolute before:-inset-x-[4px] before:-inset-y-[1px] before:-z-10 before:rounded-[7px] before:bg-accent/55 before:content-['']"
      >
        {matchText}
      </span>
    );

    lastIndex = matchStart + matchText.length;
  }

  if (lastIndex < prompt.length) {
    segments.push(<span key={`plain-${lastIndex}`}>{prompt.slice(lastIndex)}</span>);
  }

  return segments;
}

function buildAiResultNodeTitle(prompt: string, fallbackTitle: string): string {
  const normalizedPrompt = prompt.trim();
  if (!normalizedPrompt) {
    return fallbackTitle;
  }

  return normalizedPrompt;
}

function collectInputSourceMeta(
  nodeId: string,
  nodes: Array<{ id: string; data?: unknown }>,
  edges: Array<{ source: string; target: string }>
): FreezoneSourceMeta | null {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sourceIds = edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
  for (const sourceId of sourceIds) {
    const sourceNode = nodeById.get(sourceId);
    const data = sourceNode?.data as Record<string, unknown> | undefined;
    const source = data?.__freezone_source as FreezoneSourceMeta | undefined;
    if (source?.kind) {
      return source;
    }
  }
  return null;
}

function collectInputSlotTarget(
  nodeId: string,
  nodes: Array<{ id: string; data?: unknown }>,
  edges: Array<{ source: string; target: string }>
) {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const sourceIds = edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source);
  for (const sourceId of sourceIds) {
    const sourceNode = nodeById.get(sourceId);
    const data = sourceNode?.data as Record<string, unknown> | undefined;
    const slotTarget = coerceSlotTarget(data?.slot_target);
    if (slotTarget) return slotTarget;
    const source = data?.__freezone_source as FreezoneSourceMeta | undefined;
    const sourceSlotTarget = coerceSlotTarget(source?.slot_target);
    if (sourceSlotTarget) return sourceSlotTarget;
  }
  return null;
}

function mergeCandidateSourceMeta(
  origin: FreezoneSourceMeta | null,
  capability: { id: string; outputKind: string } | null,
  capabilityDefaultTarget: Record<string, unknown> | undefined,
  capabilityOutputKind: string | undefined
): FreezoneSourceMeta {
  const baseMeta =
    origin && typeof origin.meta === 'object' && origin.meta
      ? { ...origin.meta }
      : {};
  const capabilityMeta =
    typeof capabilityDefaultTarget === 'object' && capabilityDefaultTarget
      ? capabilityDefaultTarget
      : {};

  if (capability) {
    return {
      kind: capabilityOutputKind ?? capability.outputKind,
      role: 'candidate',
      label: origin?.label,
      meta: {
        ...baseMeta,
        ...capabilityMeta,
        capability_id: capability.id,
        output_kind: capabilityOutputKind ?? capability.outputKind,
        origin: origin ?? null,
      },
    };
  }

  if (origin?.kind) {
    return {
      ...origin,
      role: 'candidate',
      meta: {
        ...baseMeta,
        origin,
      },
    };
  }

  return { kind: 'generic', role: 'candidate', meta: {} };
}

export const ImageEditNode = memo(({ id, data, selected, width, height }: ImageEditNodeProps) => {
  const { t, i18n } = useTranslation();
  const modelTaskAccess = useModelTaskAccess();
  const updateNodeInternals = useUpdateNodeInternals();
  const [error, setError] = useState<string | null>(null);

  const rootRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const promptHighlightRef = useRef<HTMLDivElement>(null);
  const [promptDraft, setPromptDraft] = useState(() => data.prompt ?? '');
  const promptDraftRef = useRef(promptDraft);
  const [showImagePicker, setShowImagePicker] = useState(false);
  const [pickerCursor, setPickerCursor] = useState<number | null>(null);
  const [pickerActiveIndex, setPickerActiveIndex] = useState(0);
  const [pickerAnchor, setPickerAnchor] = useState<PickerAnchor>(PICKER_FALLBACK_ANCHOR);
  // The range of the @image1 token hit by a double-click: when non-null the picker is in "replace" mode and the selected candidate replaces this span
  // instead of being inserted at the caret. Covers the "swap a reference image" shortcut (no need to delete @image1 first and re-@).
  const [replaceTokenRange, setReplaceTokenRange] = useState<
    { start: number; end: number } | null
  >(null);

  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const showNodePrice = useSettingsStore((state) => state.showNodePrice);
  const priceDisplayCurrencyMode = useSettingsStore((state) => state.priceDisplayCurrencyMode);
  const usdToCnyRate = useSettingsStore((state) => state.usdToCnyRate);
  const preferDiscountedPrice = useSettingsStore((state) => state.preferDiscountedPrice);
  const grsaiCreditTierId = useSettingsStore((state) => state.grsaiCreditTierId);

  const incomingImages = useUpstreamImages(id);

  const upstreamContents = useUpstreamContents(id);
  const upstreamTextContents = useMemo(
    () =>
      upstreamContents.filter(
        (content) => typeof content.text === 'string' && content.text.trim().length > 0
      ),
    [upstreamContents]
  );
  const upstreamTextJoined = useMemo(
    () => joinUpstreamText(upstreamContents),
    [upstreamContents]
  );
  // All upstream image / video URLs (including ImageGen results, VideoNode videos and other types
  // graphImageResolver does not recognize), merged with incomingImages and deduped,
  // then sent to the backend together as reference_urls.
  const upstreamReferenceUrls = useMemo(
    () => collectUpstreamReferenceUrls(upstreamContents),
    [upstreamContents]
  );

  // Reverse-lookup which direct upstream node each upstream URL comes from, to precisely locate the edge for "remove reference".
  const imageUrlToNodeId = useMemo(() => {
    const map = new Map<string, string>();
    upstreamContents.forEach((content) => {
      [content.imageUrl, content.videoUrl].forEach((url) => {
        if (typeof url === 'string' && url && !map.has(url)) {
          map.set(url, content.nodeId);
        }
      });
    });
    return map;
  }, [upstreamContents]);

  const detachUpstream = useDetachUpstream(id);

  // "image1" is a reference token written into the prompt and parsed by the backend, not UI copy, so it is not translated.
  const incomingImageItems = useMemo(
    () =>
      incomingImages.map((imageUrl, index) => ({
        imageUrl,
        displayUrl: resolveImageDisplayUrl(imageUrl),
        label: `image${index + 1}`,
        sourceNodeId: imageUrlToNodeId.get(imageUrl),
      })),
    [incomingImages, imageUrlToNodeId]
  );
  const incomingImageViewerList = useMemo(
    () => incomingImageItems.map((item) => resolveImageDisplayUrl(item.imageUrl)),
    [incomingImageItems]
  );

  // The model list and each model's resolution / ratio / extra params all come from the admin "Media models" config.
  const {
    models: imageModels,
    getModel,
    isEmpty: imageModelsEmpty,
    isLoading: imageModelsLoading,
  } = useCatalogImageModels();

  // getModel returns undefined when the admin has configured no image model. The placeholder definition only keeps the picker standing;
  // submission is blocked by imageModelsEmpty (the backend answers 409 for an empty catalog).
  const selectedModel =
    useMemo(() => getModel(data.model), [getModel, data.model])
    ?? EMPTY_CATALOG_IMAGE_MODEL;
  const effectiveExtraParams = useMemo(
    () => ({ ...(data.extraParams ?? {}) }),
    [data.extraParams]
  );
  const resolutionOptions = useMemo(
    () => resolveImageModelResolutions(selectedModel, { extraParams: effectiveExtraParams }),
    [effectiveExtraParams, selectedModel]
  );

  const selectedResolution = useMemo(
    () => resolveImageModelResolution(selectedModel, data.size, { extraParams: effectiveExtraParams }),
    [data.size, effectiveExtraParams, selectedModel]
  );

  const aspectRatioOptions = useMemo<AspectRatioChoice[]>(
    () => [{
      value: AUTO_REQUEST_ASPECT_RATIO,
      label: t('modelParams.autoAspectRatio'),
    }, ...selectedModel.aspectRatios],
    [selectedModel.aspectRatios, t]
  );

  const selectedAspectRatio = useMemo(
    () =>
      aspectRatioOptions.find((item) => item.value === data.requestAspectRatio) ??
      aspectRatioOptions[0],
    [aspectRatioOptions, data.requestAspectRatio]
  );

  const requestResolution = selectedModel.resolveRequest({
    referenceImageCount: incomingImages.length,
  });
  const showWebSearchToggle = false;
  const webSearchEnabled = false;
  const resolvedPriceDisplay = useMemo(
    () =>
      showNodePrice
        ? resolveModelPriceDisplay(selectedModel, {
          resolution: selectedResolution.value,
          extraParams: effectiveExtraParams,
          language: i18n.language,
          settings: {
            displayCurrencyMode: priceDisplayCurrencyMode,
            usdToCnyRate,
            preferDiscountedPrice,
            grsaiCreditTierId,
          },
        })
        : null,
    [
      grsaiCreditTierId,
      i18n.language,
      preferDiscountedPrice,
      priceDisplayCurrencyMode,
      effectiveExtraParams,
      selectedModel,
      selectedResolution.value,
      showNodePrice,
      usdToCnyRate,
    ]
  );
  const resolvedPriceTooltip = useMemo(() => {
    if (!resolvedPriceDisplay) {
      return undefined;
    }

    const lines = [resolvedPriceDisplay.label];
    if (resolvedPriceDisplay.nativeLabel) {
      lines.push(t('pricing.nativePrice', { value: resolvedPriceDisplay.nativeLabel }));
    }
    if (resolvedPriceDisplay.originalLabel) {
      lines.push(t('pricing.originalPrice', { value: resolvedPriceDisplay.originalLabel }));
    }
    if (resolvedPriceDisplay.pointsCost) {
      lines.push(t('pricing.pointsCost', { count: resolvedPriceDisplay.pointsCost }));
    }
    if (resolvedPriceDisplay.grsaiCreditTier) {
      lines.push(
        t('pricing.grsaiTier', {
          price: resolvedPriceDisplay.grsaiCreditTier.priceCny.toFixed(2),
          credits: resolvedPriceDisplay.grsaiCreditTier.credits.toLocaleString(
            i18n.language.startsWith('zh') ? 'zh-CN' : i18n.language.startsWith('pt') ? 'pt-PT' : i18n.language.startsWith('vi') ? 'vi-VN' : 'en-US'
          ),
        })
      );
    }
    return lines.join('\n');
  }, [i18n.language, resolvedPriceDisplay, t]);

  const supportedAspectRatioValues = useMemo(
    () => selectedModel.aspectRatios.map((item) => item.value),
    [selectedModel.aspectRatios]
  );

  const resolvedTitle = useMemo(
    () => localizeNodeDisplayName(CANVAS_NODE_TYPES.imageEdit, data, t),
    [data, t]
  );
  const capability = useMemo(() => getCapability(data.capabilityId), [data.capabilityId]);
  const structuredCapabilities = useMemo(() => listCapabilities(), []);
  const generationMode = data.generationMode ?? (
    incomingImages.length > 0 ? 'all_reference' : 'text_to_image'
  );

  const resolvedWidth = Math.max(IMAGE_EDIT_NODE_MIN_WIDTH, Math.round(width ?? IMAGE_EDIT_NODE_DEFAULT_WIDTH));
  const resolvedHeight = Math.max(IMAGE_EDIT_NODE_MIN_HEIGHT, Math.round(height ?? IMAGE_EDIT_NODE_DEFAULT_HEIGHT));

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  useEffect(() => {
    const externalPrompt = data.prompt ?? '';
    if (externalPrompt !== promptDraftRef.current) {
      promptDraftRef.current = externalPrompt;
      setPromptDraft(externalPrompt);
    }
  }, [data.prompt]);

  const commitPromptDraft = useCallback((nextPrompt: string) => {
    promptDraftRef.current = nextPrompt;
    updateNodeData(id, { prompt: nextPrompt });
  }, [id, updateNodeData]);

  // Keep @image1 in the prompt following the upstream image reference numbering: after deleting / reordering / adding reference edges,
  // "image1" is renumbered; here the numbers in the prompt are rewritten accordingly and mentions of deleted references are removed.
  // Ordered baseline = incomingImages (deduped URLs, connection order, consistent with the "image1" numbering).
  const applyPromptRemap = useCallback(
    (next: string) => {
      setPromptDraft(next);
      commitPromptDraft(next);
    },
    [commitPromptDraft],
  );
  useReferenceMentionSync(
    promptDraft,
    [{ prefix: "image", ids: incomingImages }],
    applyPromptRemap,
  );

  const updateCapabilityParam = useCallback((key: string, value: unknown) => {
    updateNodeData(id, {
      capabilityParams: {
        ...(data.capabilityParams ?? {}),
        [key]: value,
      },
    });
  }, [data.capabilityParams, id, updateNodeData]);

  useEffect(() => {
    // Do not write back while the catalog has not settled (models is still the fallback list) or the admin configured no models at all: at that moment
    // selectedModel is the fallback first item / placeholder definition, and writing it would wash out the model the user really selected,
    // and this step is persisted, so it cannot be recovered when the catalog comes back.
    if (imageModelsLoading || imageModelsEmpty) return;
    if (data.model !== selectedModel.id) {
      updateNodeData(id, { model: selectedModel.id });
    }

    if (data.size !== selectedResolution.value) {
      updateNodeData(id, { size: selectedResolution.value as ImageSize });
    }

    if (data.requestAspectRatio !== selectedAspectRatio.value) {
      updateNodeData(id, { requestAspectRatio: selectedAspectRatio.value });
    }
  }, [
    data.model,
    data.requestAspectRatio,
    data.size,
    id,
    imageModelsEmpty,
    imageModelsLoading,
    selectedAspectRatio.value,
    selectedModel.id,
    selectedResolution.value,
    updateNodeData,
  ]);

  useEffect(() => {
    if (incomingImages.length === 0) {
      setShowImagePicker(false);
      setPickerCursor(null);
      setPickerActiveIndex(0);
      return;
    }

    setPickerActiveIndex((previous) => Math.min(previous, incomingImages.length - 1));
  }, [incomingImages.length]);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (rootRef.current?.contains(event.target as globalThis.Node)) {
        return;
      }

      setShowImagePicker(false);
      setPickerCursor(null);
      setReplaceTokenRange(null);
    };

    document.addEventListener('mousedown', handleOutside, true);
    return () => {
      document.removeEventListener('mousedown', handleOutside, true);
    };
  }, []);

  const handleGenerate = useCallback(async () => {
    // Do not let through when an organization member is not eligible to start model tasks: the backend would reject, so state the reason here first.
    if (modelTaskAccess.blocked) {
      if (modelTaskAccess.message) setError(modelTaskAccess.message);
      return;
    }
    // Do not let through when the admin configured no image model: selectedModel is a placeholder definition, and once submitted the backend
    // `_resolve_catalog_request` answers 409 right away, so it is better to say so here.
    if (imageModelsEmpty) {
      const errorMessage = t('node.imageEdit.noModelAvailable');
      setError(errorMessage);
      void showErrorDialog(errorMessage, t('common.error'));
      return;
    }
    const ownPrompt = promptDraft.replace(/@(?=image\d+)/g, '').trim();
    // "Read upstream live": the content of upstream text nodes (text / script / image-to-prompt etc.)
    // is automatically prepended to the prompt on every submit, so the user need not copy it by hand.
    const fallbackPrompt = [upstreamTextJoined, ownPrompt]
      .filter((s) => s.length > 0)
      .join('\n\n');
    if (!fallbackPrompt && !capability) {
      const errorMessage = t('node.imageEdit.promptRequired');
      setError(errorMessage);
      void showErrorDialog(errorMessage, t('common.error'));
      return;
    }

    const prompt = await compileWorkflowNodePrompt({
      nodeId: id,
      nodeData: data,
      nodeKind: 'image',
      nodePrompt: ownPrompt,
      upstreamText: upstreamTextJoined,
      upstreamContents,
      fallbackPrompt,
      referenceMedia: [...incomingImages, ...upstreamReferenceUrls].map((_, index) => ({
        kind: 'image',
        label: `reference-${index + 1}`,
      })),
      onCompileMetadata: ({ mode, prompt: compiledPrompt, recipeIds }) => updateNodeData(id, {
        workflowRecipeCompileMode: mode,
        workflowRecipeCompiledAt: new Date().toISOString(),
        workflowRecipeCompiledPrompt: compiledPrompt,
        prompt: compiledPrompt,
        workflowRecipeIds: recipeIds,
      }),
    });
    const generationDurationMs = selectedModel.expectedDurationMs ?? 60000;
    const generationStartedAt = Date.now();
    const resultNodeTitle = capability
      ? t('canvas.capabilities.candidateResultTitle', { name: t(capability.shortNameKey) })
      : buildAiResultNodeTitle(prompt, t('node.imageEdit.resultTitle'));
    const runtimeDiagnostics = await getRuntimeDiagnostics();
    const { nodes: currentNodes, edges: currentEdges } = useCanvasStore.getState();
    const originSource = collectInputSourceMeta(id, currentNodes, currentEdges);
    const originSlotTarget = collectInputSlotTarget(id, currentNodes, currentEdges);
    const candidateSource = mergeCandidateSourceMeta(
      originSource,
      capability,
      data.capabilityDefaultPushTarget,
      data.capabilityOutputKind
    );
    const candidateSlotTarget =
      coerceSlotTarget(data.capabilityDefaultPushTarget) ??
      originSlotTarget;
    setError(null);

    const newNodePosition = findNodePosition(
      id,
      EXPORT_RESULT_NODE_DEFAULT_WIDTH,
      EXPORT_RESULT_NODE_LAYOUT_HEIGHT
    );
    const newNodeId = addNode(
      CANVAS_NODE_TYPES.exportImage,
      newNodePosition,
      {
        isGenerating: true,
        generationStartedAt,
        generationDurationMs,
        resultKind: 'generic',
        displayName: resultNodeTitle,
        __freezone_source: candidateSource,
        ...(candidateSlotTarget ? { slot_target: candidateSlotTarget } : {}),
      }
    );
    addEdge(id, newNodeId);

    const mergedReferenceImages = Array.from(
      new Set([...incomingImages, ...upstreamReferenceUrls]),
    );

    // Resolve aspect ratio + build the re-submittable payload BEFORE the submit
    // try/catch, so the payload is in scope on the failure path too. The retry
    // button keys off generationRequestPayload, so a failed result node must
    // always carry it — otherwise there's no way to re-trigger generation.
    let resolvedRequestAspectRatio = selectedAspectRatio.value;
    if (resolvedRequestAspectRatio === AUTO_REQUEST_ASPECT_RATIO) {
      if (incomingImages.length > 0) {
        try {
          const sourceAspectRatio = await detectAspectRatio(incomingImages[0]);
          const sourceAspectRatioValue = parseAspectRatio(sourceAspectRatio);
          resolvedRequestAspectRatio = pickClosestAspectRatio(
            sourceAspectRatioValue,
            supportedAspectRatioValues
          );
        } catch {
          resolvedRequestAspectRatio = pickClosestAspectRatio(1, supportedAspectRatioValues);
        }
      } else {
        resolvedRequestAspectRatio = pickClosestAspectRatio(1, supportedAspectRatioValues);
      }
    }

    const regenerationPayload = {
      prompt,
      model: requestResolution.requestModel,
      modelId: selectedModel.id,
      // Use the derived mode, not the bare `data.generationMode` — when no mode was ever chosen manually the latter is
      // undefined, the backend gets no mode and filters as "no mode", and catalog params that declare modes are
      // all dropped. The UI highlights this derived value too, so both sides must use the same basis.
      generationMode,
      size: selectedResolution.value,
      aspectRatio: resolvedRequestAspectRatio,
      referenceImages: mergedReferenceImages,
      extraParams: effectiveExtraParams,
      // Dynamic params declared by the catalog (model_params), on the same basis as ImageGenNode: submitted as is,
      // keys that do not match the mode are filtered by the backend `_resolve_catalog_request`.
      modelParams: data.modelParams,
      capabilityId: data.capabilityId,
      nodeId: id,
      capabilityParams: data.capabilityParams,
      capabilityInputs: data.capabilityInputs,
    };

    try {
      const { jobId, ref } = await canvasAiGateway.submitGenerateImageJob(regenerationPayload);
      const generationDebugContext: GenerationDebugContext = {
        sourceType: 'imageEdit',
        providerId: selectedModel.providerId,
        requestModel: requestResolution.requestModel,
        requestSize: selectedResolution.value,
        requestAspectRatio: resolvedRequestAspectRatio,
        prompt,
        extraParams: effectiveExtraParams,
        referenceImageCount: mergedReferenceImages.length,
        referenceImagePlaceholders: createReferenceImagePlaceholders(mergedReferenceImages.length),
        appVersion: runtimeDiagnostics.appVersion,
        osName: runtimeDiagnostics.osName,
        osVersion: runtimeDiagnostics.osVersion,
        osBuild: runtimeDiagnostics.osBuild,
        userAgent: runtimeDiagnostics.userAgent,
      };
      updateNodeData(newNodeId, {
        generationJobId: jobId,
        generationSourceType: 'imageEdit',
        generationProviderId: selectedModel.providerId,
        generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
        generationDebugContext,
        generationRequestPayload: regenerationPayload,
        // Backend task handle: jobId lives only in this session's in-memory Map; after detaching from the listener these three
        // fields drive refresh-and-reattach (see SubmittedImageJob / generationTaskDescriptor).
        ...generationTaskDescriptor(ref),
      });
    } catch (generationError) {
      const resolvedError = resolveErrorContent(generationError, t('ai.error'));
      const displayErrorMessage = backendErrorToastMessage(generationError, t);
      const diagnostics = resolveGenerationErrorDiagnostics(
        generationError,
        resolvedError.details,
      );
      const generationDebugContext: GenerationDebugContext = {
        sourceType: 'imageEdit',
        providerId: selectedModel.providerId,
        requestModel: requestResolution.requestModel,
        requestSize: selectedResolution.value,
        requestAspectRatio: selectedAspectRatio.value,
        prompt,
        extraParams: effectiveExtraParams,
        referenceImageCount: mergedReferenceImages.length,
        referenceImagePlaceholders: createReferenceImagePlaceholders(mergedReferenceImages.length),
        appVersion: runtimeDiagnostics.appVersion,
        osName: runtimeDiagnostics.osName,
        osVersion: runtimeDiagnostics.osVersion,
        osBuild: runtimeDiagnostics.osBuild,
        userAgent: runtimeDiagnostics.userAgent,
      };
      const reportText = buildGenerationErrorReport({
        errorMessage: displayErrorMessage,
        errorDetails: diagnostics.details ?? undefined,
        context: generationDebugContext,
      });
      setError(displayErrorMessage);
      void showErrorDialog(
        displayErrorMessage,
        t('common.error'),
        diagnostics.details ?? undefined,
        reportText
      );
      updateNodeData(newNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationJobId: null,
        generationProviderId: null,
        generationClientSessionId: null,
        // Keep the payload so retry stays available even when the request throws
        // before a job is created.
        generationRequestPayload: regenerationPayload,
        generationError: displayErrorMessage,
        generationErrorDetails: diagnostics.details,
        generationErrorRequestId: diagnostics.requestId,
        generationDebugContext,
      });
    }
  }, [
    addNode,
    addEdge,
    findNodePosition,
    promptDraft,
    effectiveExtraParams,
    id,
    incomingImages,
    requestResolution.requestModel,
    data,
    data.capabilityDefaultPushTarget,
    data.capabilityId,
    data.capabilityInputs,
    data.capabilityOutputKind,
    data.capabilityParams,
    data.modelParams,
    capability,
    imageModelsEmpty,
    modelTaskAccess,
    selectedAspectRatio.value,
    selectedModel.id,
    selectedModel.expectedDurationMs,
    selectedModel.providerId,
    selectedResolution.value,
    supportedAspectRatioValues,
    t,
    updateNodeData,
    upstreamContents,
    upstreamReferenceUrls,
    upstreamTextJoined,
  ]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ nodeId?: string }>).detail;
      if (detail?.nodeId === id) {
        void handleGenerate();
      }
    };
    window.addEventListener("freezone:run-node", handler);
    return () => window.removeEventListener("freezone:run-node", handler);
  }, [handleGenerate, id]);

  const syncPromptHighlightScroll = () => {
    if (!promptRef.current || !promptHighlightRef.current) {
      return;
    }

    promptHighlightRef.current.scrollTop = promptRef.current.scrollTop;
    promptHighlightRef.current.scrollLeft = promptRef.current.scrollLeft;
  };

  const insertImageReference = useCallback((imageIndex: number) => {
    const marker = `@image${imageIndex + 1}`;
    const currentPrompt = promptDraftRef.current;
    let nextPrompt: string;
    let nextCursor: number;
    if (replaceTokenRange) {
      // Double-click replace: swap the hit @image1 token span wholesale for a new marker; the reference queue is unchanged, only this
      // mention is re-pointed to another existing reference image.
      ({ nextText: nextPrompt, nextCursor } = replaceReferenceToken(
        currentPrompt,
        replaceTokenRange,
        marker,
      ));
    } else {
      const cursor = pickerCursor ?? currentPrompt.length;
      ({ nextText: nextPrompt, nextCursor } = insertReferenceToken(
        currentPrompt,
        cursor,
        marker,
      ));
    }

    setPromptDraft(nextPrompt);
    commitPromptDraft(nextPrompt);
    setShowImagePicker(false);
    setPickerCursor(null);
    setReplaceTokenRange(null);
    setPickerActiveIndex(0);

    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextCursor, nextCursor);
      syncPromptHighlightScroll();
    });
  }, [commitPromptDraft, pickerCursor, replaceTokenRange]);

  // Double-click an @image1 token in the textarea → open the picker below it to "replace" that reference.
  const handlePromptDoubleClick = (event: ReactMouseEvent<HTMLTextAreaElement>) => {
    if (incomingImages.length === 0) return;
    const textarea = event.currentTarget;
    const selStart = textarea.selectionStart ?? 0;
    const selEnd = textarea.selectionEnd ?? selStart;
    // A double-click selects one "word" of the token (such as "image1"); use range overlap to decide which @image1 was hit.
    const hit = findReferenceTokenAtSelection(
      promptDraftRef.current,
      selStart,
      selEnd,
      incomingImages.length,
    );
    if (!hit) return;
    event.preventDefault();
    setPickerAnchor(resolvePickerAnchor(rootRef.current, textarea, hit.start));
    setPickerCursor(hit.start);
    setReplaceTokenRange({ start: hit.start, end: hit.end });
    setShowImagePicker(true);
    setPickerActiveIndex(0);
  };

  const applyPromptSuggestion = useCallback((nextPrompt: string) => {
    setPromptDraft(nextPrompt);
    commitPromptDraft(nextPrompt);
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(nextPrompt.length, nextPrompt.length);
      syncPromptHighlightScroll();
    });
  }, [commitPromptDraft]);

  const [isAssetLibraryOpen, setIsAssetLibraryOpen] = useState(false);

  // Spawn upload reference nodes from selected asset-library images — stacked to
  // the left of this node and wired upstream so they become @-mention references
  // for the edit. Image-only (modal opened with allowedMedia=['image']).
  const spawnAssetLibraryReferences = useCallback(
    (selections: ReadonlyArray<AssetLibrarySelection>) => {
      const imageSelections = selections.filter((sel) => sel.media === 'image');
      if (imageSelections.length === 0) return;
      const state = useCanvasStore.getState();
      const self = state.nodes.find((n) => n.id === id);
      if (!self) return;
      const UPLOAD_WIDTH = 320;
      const UPLOAD_HEIGHT = 240;
      const GAP_X = 40;
      const GAP_Y = 24;
      const baseX = self.position.x - UPLOAD_WIDTH - GAP_X;
      const totalH =
        UPLOAD_HEIGHT * imageSelections.length + GAP_Y * (imageSelections.length - 1);
      const startY =
        self.position.y +
        ((self.height ?? IMAGE_EDIT_NODE_DEFAULT_HEIGHT) - totalH) / 2;
      const newIds: string[] = [];
      imageSelections.forEach((sel, idx) => {
        const y = startY + idx * (UPLOAD_HEIGHT + GAP_Y);
        const newId = addNode(
          CANVAS_NODE_TYPES.upload,
          { x: baseX, y },
          {
            imageUrl: sel.url,
            previewImageUrl: sel.url,
            displayName: sel.name || undefined,
          },
        );
        addEdge(newId, id);
        newIds.push(newId);
      });
      state.autoGroupSpawn(id, newIds, {
        label: t('node.imageEdit.referenceGroupLabel'),
      });
    },
    [addEdge, addNode, id, t],
  );

  const handlePromptKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const currentPrompt = promptDraftRef.current;
      const selectionStart = event.currentTarget.selectionStart ?? currentPrompt.length;
      const selectionEnd = event.currentTarget.selectionEnd ?? selectionStart;
      const deletionDirection = event.key === 'Backspace' ? 'backward' : 'forward';
      const deleteRange = resolveReferenceAwareDeleteRange(
        currentPrompt,
        selectionStart,
        selectionEnd,
        deletionDirection,
        incomingImages.length
      );
      if (deleteRange) {
        event.preventDefault();
        const { nextText, nextCursor } = removeTextRange(currentPrompt, deleteRange);
        setPromptDraft(nextText);
        commitPromptDraft(nextText);
        requestAnimationFrame(() => {
          promptRef.current?.focus();
          promptRef.current?.setSelectionRange(nextCursor, nextCursor);
          syncPromptHighlightScroll();
        });
        return;
      }
    }

    if (showImagePicker && incomingImages.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setPickerActiveIndex((previous) => (previous + 1) % incomingImages.length);
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setPickerActiveIndex((previous) =>
          previous === 0 ? incomingImages.length - 1 : previous - 1
        );
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        insertImageReference(pickerActiveIndex);
        return;
      }
    }

    if (event.key === '@' && incomingImages.length > 0) {
      event.preventDefault();
      const cursor = event.currentTarget.selectionStart ?? promptDraftRef.current.length;
      setPickerAnchor(resolvePickerAnchor(rootRef.current, event.currentTarget, cursor));
      setPickerCursor(cursor);
      setReplaceTokenRange(null);
      setShowImagePicker(true);
      setPickerActiveIndex(0);
      return;
    }

    if (event.key === 'Escape' && showImagePicker) {
      event.preventDefault();
      setShowImagePicker(false);
      setPickerCursor(null);
      setReplaceTokenRange(null);
      setPickerActiveIndex(0);
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      void handleGenerate();
    }
  };

  return (
    <div
      ref={rootRef}
      className={`
        group relative flex h-full flex-col overflow-visible rounded-[var(--node-radius)] border ${CANVAS_NODE_PANEL_SURFACE_CLASS} p-2 transition-colors duration-150
        ${canvasNodeFrameClass({ selected })}
      `}
      style={{ width: `${resolvedWidth}px`, height: `${resolvedHeight}px` }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Sparkles className="h-4 w-4" />}
        titleText={resolvedTitle}
        rightSlot={
          resolvedPriceDisplay ? (
            <NodePriceBadge
              label={resolvedPriceDisplay.label}
              title={resolvedPriceTooltip}
            />
          ) : undefined
        }
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      {/* The root container has p-2; move in one step so it lands inside the image area rather than on the card border. */}
      <AddNodeToChatButton nodeId={id} className="right-3 top-3" />

      <div className={`flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border ${CANVAS_NODE_INPUT_SURFACE_CLASS} ${CANVAS_NODE_INPUT_FRAME_CLASS}`}>
        <div className="relative min-h-[190px] flex-[1.25] border-b border-[rgba(255,255,255,0.08)] bg-black/20">
          <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-1.5 rounded-full bg-black/40 px-2 py-1 text-[11px] text-text-muted">
            <ImageIcon className="h-3.5 w-3.5" />
            {t('node.imageEdit.imageNodeBadge')}{' '}
            {incomingImageItems.length > 0 ? incomingImageItems.length : ''}
          </div>
          {incomingImageItems.length > 0 ? (
            <div className={`grid h-full gap-2 p-3 ${incomingImageItems.length === 1 ? 'grid-cols-1' : 'grid-cols-2'}`}>
              {incomingImageItems.slice(0, 4).map((item, index) => (
                <div
                  key={`${item.imageUrl}-${index}`}
                  className="group relative min-h-0 overflow-hidden rounded-xl border border-[rgba(255,255,255,0.12)] bg-black/30"
                >
                  <CanvasNodeImage
                    src={item.displayUrl}
                    alt={item.label}
                    viewerSourceUrl={resolveImageDisplayUrl(item.imageUrl)}
                    viewerImageList={incomingImageViewerList}
                    className="h-full w-full object-contain"
                    draggable={false}
                  />
                  <div className="absolute left-2 top-2 rounded-full border border-[rgba(255,255,255,0.12)] bg-black/55 px-2 py-0.5 text-[10px] text-text-dark">
                    {item.label}
                  </div>
                  {item.sourceNodeId && (
                    <ReferenceDetachButton
                      nodeId={item.sourceNodeId}
                      onDetach={detachUpstream}
                      className="nodrag absolute right-1.5 top-1.5 z-10 hidden h-5 w-5 items-center justify-center rounded-full bg-black/65 text-white transition-colors hover:bg-red-500 group-hover:flex"
                    />
                  )}
                </div>
              ))}
              {incomingImageItems.length > 4 && (
                <div className="absolute bottom-3 left-3 rounded-full border border-[rgba(255,255,255,0.12)] bg-black/55 px-2 py-0.5 text-[11px] text-text-dark">
                  {t('node.imageEdit.moreRefs', { count: incomingImageItems.length - 4 })}
                </div>
              )}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-4 text-text-muted">
              <ImageIcon className="h-12 w-12 opacity-45" />
              <button
                type="button"
                className="nodrag inline-flex items-center gap-2 rounded-full border border-[rgba(255,255,255,0.14)] bg-white/8 px-4 py-2 text-sm text-text-dark transition hover:bg-white/12"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  promptRef.current?.focus();
                }}
                title={t('node.imageEdit.connectRefTitle')}
              >
                <UploadCloud className="h-4 w-4" />
                {t('node.imageEdit.connectRef')}
              </button>
              <div className="flex items-center gap-3 text-xs">
                <span className="text-[var(--canvas-node-input-helper)]">{t('node.imageEdit.tryLabel')}</span>
                <button
                  type="button"
                  className="nodrag rounded-full bg-white/8 px-2 py-1 text-text-dark transition hover:bg-white/12"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    applyPromptSuggestion(t('node.imageEdit.suggest.img2imgPrompt'));
                  }}
                >
                  {t('node.imageEdit.suggest.img2img')}
                </button>
                <button
                  type="button"
                  className="nodrag rounded-full bg-white/8 px-2 py-1 text-text-dark transition hover:bg-white/12"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    applyPromptSuggestion(t('node.imageEdit.suggest.upscalePrompt'));
                  }}
                >
                  {t('node.imageEdit.suggest.upscale')}
                </button>
              </div>
            </div>
          )}

          <button
            type="button"
            className="nodrag absolute bottom-3 right-3 rounded-full border border-[rgba(255,255,255,0.14)] bg-black/45 p-2 text-text-muted transition hover:text-text-dark"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={(event) => {
              event.stopPropagation();
              promptRef.current?.focus();
            }}
            title={t('node.imageEdit.focusPrompt')}
          >
            <Maximize2 className="h-4 w-4" />
          </button>
        </div>

        <div className="relative flex min-h-[180px] flex-1 flex-col p-3">
          <div className="mb-2 flex flex-wrap gap-2">
            {[
              { key: 'text_to_image', disabled: incomingImages.length > 0 },
              { key: 'all_reference', disabled: false },
              { key: 'image_reference', disabled: false },
              { key: 'image_to_image', disabled: false },
              { key: 'image_to_video', disabled: true },
              { key: 'first_last_frame', disabled: true },
            ].map((item) => {
              const active = generationMode === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  disabled={item.disabled}
                  className={`nodrag rounded-lg border px-3 py-1.5 text-xs transition ${active
                      ? 'border-[rgb(var(--accent-rgb)/0.55)] bg-[rgb(var(--accent-rgb)/0.18)] text-accent'
                      : item.disabled
                        ? 'cursor-not-allowed border-[rgba(255,255,255,0.06)] bg-white/5 text-text-muted/45'
                        : 'border-[rgba(255,255,255,0.1)] bg-white/8 text-text-muted hover:bg-white/12 hover:text-text-dark'
                    }`}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    updateNodeData(id, {
                      generationMode: item.key as ImageEditNodeData['generationMode'],
                      capabilityId: undefined,
                      capabilityParams: undefined,
                      capabilityInputs: undefined,
                      capabilityOutputKind: undefined,
                      capabilityDefaultPushTarget: undefined,
                      compiledPromptPreview: undefined,
                    });
                  }}
                >
                  {t(`node.imageEdit.modes.${item.key}`)}
                </button>
              );
            })}
            <span className="mx-1 h-7 w-px bg-[rgba(255,255,255,0.14)]" />
            {structuredCapabilities.map((capability) => {
              const active = data.capabilityId === capability.id;
              return (
                <button
                  key={capability.id}
                  type="button"
                  className={`nodrag rounded-lg border px-3 py-1.5 text-xs transition ${active
                      ? 'border-[rgb(var(--accent-rgb)/0.55)] bg-[rgb(var(--accent-rgb)/0.18)] text-accent'
                      : 'border-[rgba(255,255,255,0.1)] bg-white/8 text-text-muted hover:bg-white/12 hover:text-text-dark'
                    }`}
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    updateNodeData(id, {
                      displayName: t(capability.nameKey),
                      generationMode: 'image_reference',
                      model: capability.model,
                      size: capability.imageSize as ImageEditNodeData['size'],
                      aspectRatio: capability.aspectRatio,
                      requestAspectRatio: capability.aspectRatio,
                      capabilityId: capability.id,
                      capabilityParams: defaultCapabilityParams(capability),
                      capabilityOutputKind: capability.outputKind,
                    });
                  }}
                >
                  {t(capability.shortNameKey)}⚙
                </button>
              );
            })}
          </div>

          {capability && capability.params.length > 0 && (
            <div className="mb-2 rounded-xl border border-[rgba(255,255,255,0.1)] bg-black/18 p-2">
              <div className="mb-2 flex items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="truncate text-xs font-medium text-text-dark">
                    {t(capability.nameKey)}
                  </div>
                  <div className="truncate text-[10px] text-text-muted">
                    {t('canvas.capabilities.candidateHint')}
                  </div>
                </div>
                <button
                  type="button"
                  className="nodrag rounded-lg border border-[rgba(255,255,255,0.1)] px-2 py-1 text-[10px] text-text-muted transition hover:bg-white/10 hover:text-text-dark"
                  onMouseDown={(event) => event.stopPropagation()}
                  onClick={(event) => {
                    event.stopPropagation();
                    updateNodeData(id, {
                      capabilityId: undefined,
                      capabilityParams: undefined,
                      capabilityInputs: undefined,
                      capabilityOutputKind: undefined,
                      capabilityDefaultPushTarget: undefined,
                      compiledPromptPreview: undefined,
                    });
                  }}
                >
                  {t('canvas.capabilities.freePrompt')}
                </button>
              </div>
              <div
                className="ui-scrollbar nowheel grid max-h-56 grid-cols-2 gap-2 overflow-y-auto pr-1"
                onWheel={(event) => event.stopPropagation()}
                onMouseDown={(event) => event.stopPropagation()}
              >
                {capability.params.map((param) => (
                  <InlineCapabilityParamControl
                    key={param.key}
                    param={param}
                    value={(data.capabilityParams ?? {})[param.key]}
                    onChange={(value) => updateCapabilityParam(param.key, value)}
                  />
                ))}
              </div>
            </div>
          )}

          <div className="mb-2 flex min-h-10 items-center gap-2 overflow-x-auto pb-1">
            <button
              type="button"
              className="nodrag shrink-0 rounded-lg border border-[rgba(255,255,255,0.1)] bg-white/8 px-3 py-2 text-xs text-text-muted transition hover:bg-white/12 hover:text-text-dark"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                promptRef.current?.focus();
              }}
            >
              {t('node.imageEdit.markButton')}
            </button>
            <button
              type="button"
              className="nodrag shrink-0 rounded-lg border border-[rgba(255,255,255,0.1)] bg-white/8 px-3 py-2 text-xs text-text-muted transition hover:bg-white/12 hover:text-text-dark"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                applyPromptSuggestion(
                  `${promptDraft}${promptDraft ? '\n' : ''}${t('node.imageEdit.suggest.cameraPrompt')}`,
                );
              }}
            >
              {t('node.imageEdit.cameraButton')}
            </button>
            <button
              type="button"
              className="nodrag shrink-0 rounded-lg border border-[rgba(255,255,255,0.1)] bg-white/8 px-3 py-2 text-xs text-text-muted transition hover:bg-white/12 hover:text-text-dark"
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => {
                event.stopPropagation();
                setIsAssetLibraryOpen(true);
              }}
              title={t('node.imageEdit.assetLibraryTitle')}
            >
              {t('node.imageEdit.assetLibrary')}
            </button>
            {upstreamTextContents.map((content) => (
              <ReferenceTextChip
                key={`upstream-text-${content.nodeId}`}
                nodeId={content.nodeId}
                text={content.text ?? ''}
                sourceLabel={content.displayName ?? content.nodeType}
                onDetach={detachUpstream}
                triggerClassName="nodrag flex h-10 w-10 items-center justify-center rounded-lg bg-white/12 transition-colors hover:bg-white/20"
              />
            ))}
            {incomingImageItems.slice(0, 5).map((item, index) => (
              <button
                key={`ref-chip-${item.imageUrl}-${index}`}
                type="button"
                className="group nodrag relative h-10 w-10 shrink-0 overflow-hidden rounded-lg border border-[rgba(255,255,255,0.14)] bg-white/8"
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  insertImageReference(index);
                }}
                title={t('node.imageEdit.insertRef', { label: item.label })}
              >
                <CanvasNodeImage
                  src={item.displayUrl}
                  alt={item.label}
                  viewerSourceUrl={resolveImageDisplayUrl(item.imageUrl)}
                  viewerImageList={incomingImageViewerList}
                  className="h-full w-full object-cover"
                  draggable={false}
                />
                <span className="absolute right-0.5 top-0.5 rounded bg-black/65 px-1 text-[9px] text-text-dark group-hover:opacity-0">
                  {index + 1}
                </span>
                {item.sourceNodeId && (
                  <ReferenceDetachButton nodeId={item.sourceNodeId} onDetach={detachUpstream} />
                )}
              </button>
            ))}
          </div>
          <div className="relative min-h-[96px] flex-1">
          <div
            ref={promptHighlightRef}
            aria-hidden="true"
            className="ui-scrollbar pointer-events-none absolute inset-0 overflow-y-auto overflow-x-hidden text-sm leading-6 text-text-dark"
            style={{ scrollbarGutter: 'stable' }}
          >
            <div className="min-h-full whitespace-pre-wrap break-words px-1 py-0.5">
              {renderPromptWithHighlights(promptDraft, incomingImages.length)}
            </div>
          </div>

          <textarea
            ref={promptRef}
            value={promptDraft}
            onChange={(event) => {
              const nextValue = event.target.value;
              // Typing shifts token positions, so the range in replace mode becomes invalid → leave replace mode and close the picker.
              if (replaceTokenRange) {
                setReplaceTokenRange(null);
                setShowImagePicker(false);
                setPickerCursor(null);
              }
              setPromptDraft(nextValue);
              commitPromptDraft(nextValue);
            }}
            onKeyDown={handlePromptKeyDown}
            onDoubleClick={handlePromptDoubleClick}
            onScroll={syncPromptHighlightScroll}
            onMouseDown={(event) => event.stopPropagation()}
            placeholder={t('node.imageEdit.promptPlaceholder')}
            className={`ui-scrollbar nodrag nowheel relative z-10 h-full w-full resize-none overflow-y-auto overflow-x-hidden border-none bg-transparent px-1 py-0.5 text-sm leading-6 text-transparent caret-text-dark outline-none focus:border-transparent whitespace-pre-wrap break-words ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
            style={{ scrollbarGutter: 'stable' }}
          />
        </div>
        </div>

        {showImagePicker && incomingImageItems.length > 0 && (
          <div
            className="nowheel absolute z-30 w-[120px] overflow-hidden rounded-xl border border-[rgba(255,255,255,0.16)] bg-surface-dark shadow-xl"
            style={{ left: pickerAnchor.left, top: pickerAnchor.top }}
            onMouseDown={(event) => event.stopPropagation()}
            onWheelCapture={(event) => event.stopPropagation()}
          >
            <div
              className="ui-scrollbar nowheel max-h-[180px] overflow-y-auto"
              onWheelCapture={(event) => event.stopPropagation()}
            >
              {incomingImageItems.map((item, index) => (
                <button
                  key={`${item.imageUrl}-${index}`}
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    insertImageReference(index);
                  }}
                  onMouseEnter={() => setPickerActiveIndex(index)}
                  className={`flex w-full items-center gap-2 border border-transparent bg-bg-dark/70 px-2 py-2 text-left text-sm text-text-dark transition-colors hover:border-[rgba(255,255,255,0.18)] ${pickerActiveIndex === index
                      ? 'border-[rgba(255,255,255,0.24)] bg-bg-dark'
                      : ''
                    }`}
                >
                  <CanvasNodeImage
                    src={item.displayUrl}
                    alt={item.label}
                    viewerSourceUrl={resolveImageDisplayUrl(item.imageUrl)}
                    viewerImageList={incomingImageViewerList}
                    className="h-8 w-8 rounded object-cover"
                    draggable={false}
                  />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="mt-2 flex shrink-0 items-center gap-1">
        <ModelParamsControls
          imageModels={imageModels}
          selectedModel={selectedModel}
          resolutionOptions={resolutionOptions}
          selectedResolution={selectedResolution}
          selectedAspectRatio={selectedAspectRatio}
          aspectRatioOptions={aspectRatioOptions}
          onModelChange={(modelId) => {
            // Catalog params are declared per model; after switching models the old values mostly do not exist in the new model's schema,
            // and carrying them along would be judged unknown model parameters by the backend. Clear them all.
            //
            // The old extraParams likewise: quality / enable_web_search inside them are picked per model
            // capability, and the gateway sends quality through as is; without clearing, the new model would be
            // requested with the previous model's quality tier.
            updateNodeData(id, { model: modelId, modelParams: {}, extraParams: {} });
          }}
          onResolutionChange={(resolution) => {
            updateNodeData(id, { size: resolution as ImageSize });
          }
          }
          onAspectRatioChange={(aspectRatio) => {
            updateNodeData(id, { requestAspectRatio: aspectRatio });
          }
          }
          extraParams={data.extraParams}
          onExtraParamChange={(key, value) =>
            updateNodeData(id, {
              extraParams: {
                ...(data.extraParams ?? {}),
                [key]: value,
              },
            })
          }
          showWebSearchToggle={showWebSearchToggle}
          webSearchEnabled={webSearchEnabled}
          onWebSearchToggle={(enabled) =>
            updateNodeData(id, {
              extraParams: {
                ...(data.extraParams ?? {}),
                enable_web_search: enabled,
              },
            })
          }
          triggerSize="sm"
          chipClassName={NODE_CONTROL_CHIP_CLASS}
          modelChipClassName={NODE_CONTROL_MODEL_CHIP_CLASS}
          paramsChipClassName={NODE_CONTROL_PARAMS_CHIP_CLASS}
        />

        {/* Dynamic params declared by the admin "Media models". The component returns null itself when none are declared. */}
        <MediaModelParameterChip
          parameters={selectedModel.requestParameters}
          values={data.modelParams}
          mode={generationMode}
          onChange={(modelParams) => updateNodeData(id, { modelParams })}
        />

        <div className="ml-auto" />

        <UiButton
          onClick={(event) => {
            event.stopPropagation();
            void handleGenerate();
          }}
          disabled={modelTaskAccess.blocked}
          title={modelTaskAccess.message ?? undefined}
          variant="primary"
          className={`shrink-0 ${NODE_CONTROL_PRIMARY_BUTTON_CLASS}`}
        >
          <Sparkles className={NODE_CONTROL_ICON_CLASS} strokeWidth={2.8} />
          {t('canvas.generate')}
        </UiButton>
      </div>

      {error && <div className="mt-1 shrink-0 text-xs text-red-400 break-words [overflow-wrap:anywhere]">{error}</div>}

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
        minWidth={IMAGE_EDIT_NODE_MIN_WIDTH}
        minHeight={IMAGE_EDIT_NODE_MIN_HEIGHT}
        maxWidth={IMAGE_EDIT_NODE_MAX_WIDTH}
        maxHeight={IMAGE_EDIT_NODE_MAX_HEIGHT}
        keepAspectRatio
      />
      <AssetLibraryModal
        mode="pick"
        open={isAssetLibraryOpen}
        project={readUrl().project ?? null}
        allowedMedia={['image']}
        onClose={() => setIsAssetLibraryOpen(false)}
        onConfirm={(selections) => spawnAssetLibraryReferences(selections)}
      />
    </div>
  );
});

function InlineCapabilityParamControl({
  param,
  value,
  onChange,
}: {
  param: CapabilityParamDefinition;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useTranslation();

  if (param.type === 'enum') {
    return (
      <label className="nodrag block min-w-0 text-[10px] text-text-muted">
        <span className="mb-1 block truncate">{t(param.labelKey)}</span>
        <select
          value={stringifyParamValue(value ?? param.defaultValue)}
          onChange={(event) => onChange(event.target.value)}
          onMouseDown={(event) => event.stopPropagation()}
          className="w-full rounded-lg border border-[rgba(255,255,255,0.1)] bg-bg-dark px-2 py-1.5 text-xs text-text-dark outline-none"
        >
          {(param.options ?? []).map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </select>
      </label>
    );
  }

  if (param.type === 'multiselect') {
    const selected = new Set(Array.isArray(value) ? value.map(String) : []);
    return (
      <div className="nodrag col-span-2 text-[10px] text-text-muted">
        <div className="mb-1">{t(param.labelKey)}</div>
        <div className="flex flex-wrap gap-1">
          {(param.options ?? []).map((option) => {
            const active = selected.has(option.value);
            return (
              <button
                key={option.value}
                type="button"
                className={`rounded-full border px-2 py-1 text-[10px] transition ${active
                    ? 'border-[rgb(var(--accent-rgb)/0.5)] bg-[rgb(var(--accent-rgb)/0.16)] text-accent'
                    : 'border-[rgba(255,255,255,0.1)] bg-white/5 text-text-muted hover:bg-white/10 hover:text-text-dark'
                  }`}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  const next = new Set(selected);
                  if (active) next.delete(option.value);
                  else next.add(option.value);
                  onChange([...next]);
                }}
              >
                {t(option.labelKey)}
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  if (param.type === 'boolean') {
    return (
      <label className="nodrag flex items-center gap-2 text-xs text-text-muted">
        <input
          type="checkbox"
          checked={Boolean(value ?? param.defaultValue)}
          onChange={(event) => onChange(event.target.checked)}
          onMouseDown={(event) => event.stopPropagation()}
          className="accent-accent"
        />
        <span>{t(param.labelKey)}</span>
      </label>
    );
  }

  if (param.type === 'slider') {
    const numericValue =
      typeof value === 'number' ? value : typeof param.defaultValue === 'number' ? param.defaultValue : 0;
    return (
      <label className="nodrag col-span-2 block text-[10px] text-text-muted">
        <span className="mb-1 flex justify-between">
          <span>{t(param.labelKey)}</span>
          <span>{numericValue}</span>
        </span>
        <input
          type="range"
          min={param.min ?? 0}
          max={param.max ?? 100}
          step={param.step ?? 1}
          value={numericValue}
          onChange={(event) => onChange(Number(event.target.value))}
          onMouseDown={(event) => event.stopPropagation()}
          className="w-full accent-accent"
        />
      </label>
    );
  }

  return (
    <label className="nodrag col-span-2 block text-[10px] text-text-muted">
      <span className="mb-1 block">{t(param.labelKey)}</span>
      <textarea
        value={stringifyParamValue(value ?? param.defaultValue)}
        onChange={(event) => onChange(event.target.value)}
        onMouseDown={(event) => event.stopPropagation()}
        className="ui-scrollbar min-h-12 w-full resize-y rounded-lg border border-[rgba(255,255,255,0.1)] bg-bg-dark px-2 py-1.5 text-xs text-text-dark outline-none"
        placeholder={param.descriptionKey ? t(param.descriptionKey) : undefined}
      />
    </label>
  );
}

ImageEditNode.displayName = 'ImageEditNode';

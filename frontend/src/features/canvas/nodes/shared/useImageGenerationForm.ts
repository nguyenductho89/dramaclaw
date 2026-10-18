// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

import type {
  ImageGenCameraSelection,
  ImageGenCount,
  ImageGenNodeData,
  ImageQuality,
} from '@/features/canvas/domain/canvasNodes';
import {
  resolveImageDisplayUrl,
  snapToAllowedAspectRatio,
} from '@/features/canvas/application/imageData';
import { buildImageFeatureBillingParams } from '@/features/canvas/domain/imageBilling';
import {
  IMAGE_ASPECT_OPTIONS,
  IMAGE_SIZE_OPTIONS,
} from '@/features/canvas/nodes/shared/imageGenerationOptions';
import { isSystemManagedNodeData } from '@/features/canvas/domain/mainlineNodeFlags';
import { setAlbumPendingTotal } from '@/features/canvas/nodes/shared/albumPendingTotals';
import { resolveImageGenerationCompletionMode } from '@/features/canvas/nodes/imageGenCompletionMode';
import { compileWorkflowNodePrompt } from '@/features/canvas/application/workflowRecipeRuntime';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  fetchFreezoneJobResult,
  submitFreezoneGen,
  type FreezoneProvider,
} from '@/api/ops';
import { translateNodeText } from '@/features/canvas/application/translateText';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { awaitTaskCompletion } from '@/api/tasks';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import {
  BillingRuleNotConfiguredError,
  backendErrorToastMessage,
} from '@/lib/api-errors';
import { readUrl } from '@/lib/url-params';
import { SHARED_MODELS } from '@/features/canvas/ui/ProviderModelPicker';
import { extractRequestId } from '@/features/canvas/application/generationErrorReport';
import { useFreezoneImageModels } from '@/features/canvas/hooks/useFreezoneImageModels';
import { describeCameraSelection } from '@/features/canvas/nodes/CameraPickerPopover';
import {
  buildImageGenerationSuccessPatch,
  isStaleGenerationTask,
  shouldWriteGenerationError,
} from '@/features/canvas/application/generationTaskArbitration';
import { useFreezoneCameraOptions } from '@/features/canvas/hooks/useFreezoneCameraOptions';
import { describeStyleSelection } from '@/features/canvas/nodes/StylePickerPopover';
import { useFreezoneStyleTemplates } from '@/features/canvas/hooks/useFreezoneStyleTemplates';
import { extractUpstreamContent, joinUpstreamText } from '@/features/canvas/application/graphContentResolver';
import { useUpstreamContents } from '@/features/canvas/application/useUpstreamGraph';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { type MentionCandidate } from '@/features/canvas/nodes/PromptMentionEditor';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { hasImageGenPromptOverride } from '@/features/canvas/nodes/imageGenPrompt';
import { orderedReferenceUrlsWithOwnFirst, upstreamNodesInEdgeOrder } from '@/features/canvas/nodes/referenceOrdering';
import { matchesReference, referenceIssueName, referenceIssues, type ReferenceIssue } from '@/features/canvas/nodes/shared/ReferenceValidationDialog';
import { useReferenceMentionSync } from '@/features/canvas/nodes/useReferenceMentionSync';
import type { ImageGenerationFormProps } from '@/features/canvas/nodes/shared/ImageGenerationForm';

const DEFAULT_IMAGE_QUALITY: ImageQuality = 'medium';

// Unified billing (#210): image generation is quoted by feature key, with the model identity put into params.
const IMAGE_GENERATE_FEATURE_KEY = 'freezone.image_generate';

// Empty-data fallback for when the node is deleted / not yet in the store, keeping the hook free of early returns
// (the number of hooks must be the same every frame).
const EMPTY_NODE_DATA = {} as ImageGenNodeData;

function resolveOutputUrl(result: Record<string, unknown> | null | undefined): string | null {
  if (!result) return null;
  for (const key of ['output_url', 'image_url', 'url']) {
    const value = result[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * The part of the props of `ImageGenerationForm` that this hook is responsible for supplying.
 *
 * The remaining two (`onStylePickerOpenChange` / `onOpenAssetLibrary`) are **the host's own
 * popover orchestration** — the former lets the host temporarily hide the history strip stacked below, the latter opens the material library
 * dialog held by the host — unrelated to the generation form's data/submit, so they do not enter the hook.
 */
export type ImageGenerationFormBoundProps = Omit<
  ImageGenerationFormProps,
  'onStylePickerOpenChange' | 'onOpenAssetLibrary'
>;

export interface UseImageGenerationFormOptions {
  /**
   * Fired after a batch of generations (including N concurrent calls) has all settled. The node uses it to refresh the "generation history"
   * strip; hosts that do not care about history may omit it.
   */
  onGenerationSettled?: () => void;
}

export interface UseImageGenerationFormResult {
  /** Spread directly into `<ImageGenerationForm {...formProps} />`. */
  formProps: ImageGenerationFormBoundProps;
  /**
   * The values below also exist in formProps, but the host needs them itself:
   * - isGenerating / submitDisabled / submit: the retry button of the "generation failed" banner on the node,
   *   and the "non-destructive preview" branch when a history entry is clicked;
   * - canAutoCommitOnGenerate: decides whether a mainline-managed node is read-only;
   * - referenceImageUrl: the placeholder image of the node body / the "remove reference image" button.
   */
  isGenerating: boolean;
  submitDisabled: boolean;
  /**
   * Submit generation. With completionMode='submitted' it returns the task handle once submitted, and the result is backfilled in the background
   * (used when a workflow recipe runs a single node); by default 'completed' returns only after the result lands.
   */
  submit: (
    options?: { completionMode?: 'submitted' | 'completed' },
  ) => Promise<Record<string, unknown> | undefined>;
  canAutoCommitOnGenerate: boolean;
  referenceImageUrl: string | null;
  referenceErrors: ReferenceIssue[];
  referenceErrorsOpen: boolean;
  closeReferenceErrors: () => void;
  openReferenceErrors: () => void;
  /**
   * Void in-flight generation (#224). Every host path where "the user actively swaps the image on the node" must call this first,
   * otherwise requests of the previous batch still in flight would cover the image just swapped in when they return, or stick on a mismatched failure banner.
   */
  invalidateInFlightGeneration: () => void;
}

/**
 * The **parent state and submit orchestration** of the image generation form: prompt draft + IME composition state, upstream text/
 * images, @image1 numbering and reordering, model/params/compute cost, translation, and the concurrent image-producing handleSubmit.
 *
 * Like `ImageGenerationForm` it touches no React Flow context — node data is always taken from
 * `useCanvasStore` by id (the nodes the canvas feeds to ReactFlow are the same ones in the store,
 * so they are the same object as the `data` prop the node component receives). This way standalone
 * layouts such as the storyboard detail can also get the whole set of capabilities directly via `useImageGenerationForm(nodeId)`.
 */
export function useImageGenerationForm(
  nodeId: string,
  options?: UseImageGenerationFormOptions,
): UseImageGenerationFormResult {
  const { t } = useTranslation();
  const onGenerationSettled = options?.onGenerationSettled;
  const id = nodeId;

  const data = (useCanvasStore(
    (state) => state.nodes.find((node) => node.id === nodeId)?.data,
  ) ?? EMPTY_NODE_DATA) as ImageGenNodeData;
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);

  // Local prompt buffer keeps the textarea's React `value` in lockstep with
  // user input even during IME composition (input method). Committing to the
  // Zustand store on every keystroke triggers a global re-render that can
  // clobber the in-flight composition; the buffer absorbs that race.
  const externalPrompt = typeof data.prompt === 'string' ? data.prompt : '';
  const [promptDraft, setPromptDraft] = useState(externalPrompt);
  const isComposingRef = useRef(false);
  const hasUserEditedPromptRef = useRef(false);
  const submittingRef = useRef(false);
  // A manual image swap by the user (restoring history etc.) voids requests of the previous batch still in flight: when an async completion returns it must
  // first match this counter before it may write the result or error back to the node, otherwise the new image just swapped in is overwritten by the old batch,
  // or a mismatched failure banner is stuck on. Host image-swap paths call invalidateInFlightGeneration().
  const generationAttemptRef = useRef(0);
  // Wait queue for in-flight submissions: a recipe run may trigger submit concurrently on the same node, and a later call
  // does not start another generation but hangs here waiting for the previous one's result (consistent with the workflow side).
  const submitWaitersRef = useRef<Array<(value: Record<string, unknown> | undefined) => void>>([]);
  useEffect(() => {
    if (isComposingRef.current) return;
    setPromptDraft(externalPrompt);
  }, [externalPrompt]);
  const prompt = promptDraft;
  const aspectRatio = typeof data.aspectRatio === 'string' && data.aspectRatio
    ? data.aspectRatio
    : '16:9';
  // The catalog may declare arbitrary resolution tiers for a model (not limited to 1K/2K/4K), so read as a bare string here.
  const size = typeof data.size === 'string' && data.size.trim() ? data.size : '2K';
  const quality = (data.quality ?? DEFAULT_IMAGE_QUALITY) as ImageQuality;
  const count = (data.count ?? 1) as ImageGenCount;
  const autoCommitOnGenerate = data.autoCommitOnGenerate === true;
  const canAutoCommitOnGenerate =
    autoCommitOnGenerate &&
    isSystemManagedNodeData(data);
  const effectiveCount = canAutoCommitOnGenerate ? 1 : count;
  const { isGenerating } = useNodeGenerationTaskState(data);
  const cameraSelection = (data.cameraSelection ?? null) as ImageGenCameraSelection | null;
  const styleTemplateId =
    typeof data.styleTemplateId === 'string' && data.styleTemplateId.length > 0
      ? data.styleTemplateId
      : null;
  const referenceImageUrl =
    typeof data.referenceImageUrl === 'string' && data.referenceImageUrl.length > 0
      ? data.referenceImageUrl
      : null;
  const [isTranslatingPrompt, setIsTranslatingPrompt] = useState(false);
  const [referenceErrors, setReferenceErrors] = useState<ReferenceIssue[]>([]);
  const [referenceErrorsOpen, setReferenceErrorsOpen] = useState(false);

  const {
    models: availableModels,
    isLoading: imageModelsLoading,
    isFallback: imageModelsFallback,
  } = useFreezoneImageModels();

  // Resolve the model against the LIVE model list and derive BOTH the picker's
  // displayed id and the submit apiModel from this one object, so they can
  // never diverge.
  //
  // The node's default `data.model` is seeded to the static
  // `DEFAULT_SHARED_MODEL_ID` (`huimeng/gpt-image-2`), which is normally NOT in
  // the live `/freezone/image/models` list. Trusting it blindly is the bug:
  // ProviderModelPicker silently falls back to showing `availableModels[0]`
  // (e.g. LingShan-G2) when the id isn't found, while submit resolves the stale
  // id through SHARED_MODELS to `huimeng_gpt_image2` — display ≠ value sent.
  // Reconciling here keeps them in lockstep: an unknown persisted id falls back
  // to the first live model (exactly what the picker shows).
  const selectedModel = useMemo(() => {
    const persisted =
      typeof data.model === 'string' && data.model.length > 0 ? data.model : null;
    return (
      (persisted ? availableModels.find((m) => m.id === persisted) : undefined)
      ?? availableModels[0]
    );
  }, [data.model, availableModels]);
  const modelId = selectedModel?.id ?? '';
  // The resolution/ratio/quality tiers are all driven by the media catalog (admin-configurable) and no longer guessed by a model-name regex.
  // When the catalog declares nothing, fall back to the built-in constants, so old models and the offline fallback list keep working as usual.
  const modelSizeOptions = useMemo(() => {
    const configured = selectedModel?.resolutionOptions
      ?.map((item) => item.trim())
      .filter(Boolean);
    return configured?.length ? configured : IMAGE_SIZE_OPTIONS;
  }, [selectedModel]);
  const modelAspectOptions = useMemo(() => {
    const configured = (selectedModel?.ratioOptions ?? [])
      .map((item) => item.trim())
      .filter(Boolean)
      .map((value) => ({
        value,
        label: IMAGE_ASPECT_OPTIONS.find((item) => item.value === value)?.label ?? value,
      }));
    return configured.length ? configured : IMAGE_ASPECT_OPTIONS;
  }, [selectedModel]);
  const effectiveImageSize = modelSizeOptions.includes(size) ? size : modelSizeOptions[0];
  const effectiveAspectRatio = snapToAllowedAspectRatio(
    aspectRatio,
    modelAspectOptions.map((item) => item.value),
    modelAspectOptions[0]?.value ?? '1:1',
  );
  const qualityOptions = useMemo(
    () => (selectedModel?.qualityOptions ?? []).map((item) => item.trim()).filter(Boolean),
    [selectedModel],
  );
  const supportsImageQuality = qualityOptions.length > 0;
  const effectiveQuality =
    qualityOptions.find((option) => option.toLowerCase() === quality.toLowerCase())
    ?? qualityOptions.find((option) => option.toLowerCase() === DEFAULT_IMAGE_QUALITY)
    ?? qualityOptions[0]
    ?? DEFAULT_IMAGE_QUALITY;
  const imageSelectionForCost =
    imageModelsLoading || imageModelsFallback ? null : selectedModel?.apiModel ?? null;
  const imageQuantity = Math.min(Math.max(effectiveCount, 1), 4);
  // Unified billing (#210): quote by feature key, with the model identity spliced into params via buildImageFeatureBillingParams.
  // It must be verbatim identical to ImageGenNode's former code, otherwise the same node would report different prices in the workflow
  // and storyboard views.
  const imageCreditCost = useGenerationCreditCost(
    'feature',
    imageSelectionForCost ? IMAGE_GENERATE_FEATURE_KEY : null,
    {
      surface: 'canvas',
      params: buildImageFeatureBillingParams(selectedModel, {
        size: effectiveImageSize,
        ...(supportsImageQuality ? { quality: effectiveQuality } : {}),
        pricing_quantity: imageQuantity,
      }),
      quantity: imageQuantity,
    },
  );
  const imageBillingRuleMissing =
    imageCreditCost.error instanceof BillingRuleNotConfiguredError;
  const billingRuleMissingSubmitMessage = imageBillingRuleMissing
    ? t('node.imageGenNode.billingRuleMissingSubmit', {
        defaultValue:
          'Image generation did not start: billing rules are not configured. Contact an administrator to set credit rules and retry.',
      })
    : null;
  // Use the server-issued `display`, do not format `cost` yourself: during a promotion display is "original→current",
  // and CreditCostPill renders the struck-through original price and the promo label precisely through this `→` (credit-visual.tsx:117).
  // A self-assembled one has only a single number, and the whole promo display would vanish. Same basis as ImageGenNode.
  const totalCreditCostDisplay = useMemo(() => {
    const display = imageCreditCost.data?.data.display;
    if (!display) {
      return imageBillingRuleMissing
        ? t('common.billingRuleNotConfiguredShort')
        : null;
    }
    return display;
  }, [imageBillingRuleMissing, imageCreditCost.data?.data.display, t]);
  // display and promotion must be issued as a pair: with only the former the label falls back to the generic "On sale",
  // and the real copy like "50% off for a limited time" cannot be obtained.
  const creditPromotion = imageCreditCost.data?.data.promotion ?? null;
  const { options: cameraOptions } = useFreezoneCameraOptions();
  const cameraSummary = describeCameraSelection(cameraSelection, cameraOptions);
  const { templates: styleTemplates } = useFreezoneStyleTemplates();
  const selectedStyle = describeStyleSelection(styleTemplateId, styleTemplates);

  const upstreamContents = useUpstreamContents(id);
  // ImageGen upstream consumes only "text + images"; video/audio content is dropped —
  // even if an upload node carries a video URL, it enters neither the OpsPanel nor reference_urls.
  const upstreamImageContents = useMemo(() => {
    const seen = new Set<string>();
    const out: typeof upstreamContents = [];
    for (const content of upstreamContents) {
      const url = typeof content.imageUrl === 'string' ? content.imageUrl : '';
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push(content);
    }
    return out;
  }, [upstreamContents]);
  const upstreamTextContents = useMemo(
    () =>
      upstreamContents.filter(
        (content) => typeof content.text === 'string' && content.text.trim().length > 0,
      ),
    [upstreamContents],
  );
  const upstreamTextJoined = useMemo(
    () => joinUpstreamText(upstreamContents),
    [upstreamContents],
  );
  const freezoneSource = (data.__freezone_source as
    | { role?: string; meta?: Record<string, unknown> }
    | undefined) ?? undefined;
  const sourceRole = typeof freezoneSource?.role === "string"
    ? freezoneSource.role
    : "";
  const shouldInlineUpstreamTextAsPrompt =
    sourceRole === "scene_master" || sourceRole === "scene_reverse_master";
  const upstreamReferenceUrls = useMemo(
    () =>
      Array.from(
        new Set(
          upstreamImageContents
            .map((c) => (typeof c.imageUrl === 'string' ? c.imageUrl : ''))
            .filter((url) => url.length > 0),
        ),
      ),
    [upstreamImageContents],
  );
  // The ordered list of reference images submitted to the backend: the node's own reference images come first, upstream images follow (URL deduped).
  // The @image1 numbering, the mention-remap baseline and submission all share this one list — the backend interprets imageN by position,
  // and once the numbering counted only upstream images while submission prepended the own reference image, so with a node-owned reference image all @imageN
  // were shifted by 1 on the backend (@image1 actually pointed to the own reference image).
  const orderedReferenceUrls = useMemo(
    () => orderedReferenceUrlsWithOwnFirst(referenceImageUrl, upstreamReferenceUrls),
    [referenceImageUrl, upstreamReferenceUrls],
  );
  const generationMode =
    orderedReferenceUrls.length > 0 ? 'image_to_image' : 'text_to_image';

  // Candidates are numbered by orderedReferenceUrls (when the own reference image is present it is image1), ensuring the thumbnail shown by @
  // is the same image as the imageN the backend resolves. The key prefers the upstream nodeId; the own reference image has no
  // upstream node, so fall back to the URL (the key just needs to be stable and unique within the candidates).
  const mentionCandidates = useMemo<MentionCandidate[]>(
    () =>
      orderedReferenceUrls.map((url, index) => ({
        key:
          upstreamImageContents.find((content) => content.imageUrl === url)
            ?.nodeId ?? `self:${url}`,
        name: `image${index + 1}`,
        imageUrl: resolveImageDisplayUrl(url),
        index: index + 1,
      })),
    [orderedReferenceUrls, upstreamImageContents],
  );

  // Keep @image1 in the prompt following the reference image numbering: after deleting / reordering / adding reference edges,
  // or uploading or removing the own reference image, mentionCandidates renumbers, and here the numbers in the prompt are
  // rewritten accordingly with mentions of deleted references removed. Ordered baseline = orderedReferenceUrls (own reference image
  // first, URLs deduped, connection order, consistent with the numbering and submission basis; identity uses the URL rather than nodeId,
  // avoiding "when two upstream nodes share the same URL, deleting one is misjudged as the reference disappearing").
  const applyPromptRemap = useCallback(
    (next: string) => {
      setPromptDraft(next);
      updateNodeData(id, { prompt: next });
    },
    [id, updateNodeData],
  );
  useReferenceMentionSync(
    prompt,
    [{ prefix: "image", ids: orderedReferenceUrls }],
    applyPromptRemap,
  );

  // Detach an upstream asset: directly delete the edge "that upstream node → this node", so the user need not
  // hunt for that line on the canvas. collectInputContents walks only one hop, so content.nodeId is
  // the directly connected upstream node, and the edge to delete can be located precisely.
  const handleDetachUpstream = useCallback(
    (sourceNodeId: string) => {
      useCanvasStore
        .getState()
        .edges.filter((edge) => edge.source === sourceNodeId && edge.target === id)
        .forEach((edge) => deleteEdge(edge.id));
    },
    [id, deleteEdge],
  );

  const handleTranslatePrompt = useCallback(async () => {
    if (isTranslatingPrompt || isGenerating) return;
    const trimmed = prompt.trim();
    if (trimmed.length === 0) return;
    const projectId = readUrl().project;
    if (!projectId) {
      console.error('[image-gen] translate: no project in URL');
      return;
    }
    setIsTranslatingPrompt(true);
    try {
      const translated = await translateNodeText(projectId, {
        text: prompt,
        nodeId: id,
        nodeType: 'image',
      });
      if (translated) {
        setPromptDraft(translated);
        updateNodeData(id, { prompt: translated });
      }
    } catch (error) {
      console.error('[image-gen] translate failed', error);
    } finally {
      setIsTranslatingPrompt(false);
    }
  }, [id, isGenerating, isTranslatingPrompt, prompt, updateNodeData]);

  // "Read upstream live": the user may leave the prompt empty; as long as a node with text is connected upstream
  // (text/script/image-generation prompt etc.) it can submit; on submit the upstream text is concatenated.
  const hasEffectivePrompt =
    prompt.trim().length > 0 ||
    (
      upstreamTextJoined.length > 0 &&
      (!shouldInlineUpstreamTextAsPrompt || !hasUserEditedPromptRef.current)
    );
  // The media catalog may declare a reference image cap for a model; when exceeded, do not let the user click only to wait for a backend 400.
  const selectedModelReferenceError =
    selectedModel?.referenceImageMax != null &&
    orderedReferenceUrls.length > selectedModel.referenceImageMax
      ? `This model supports at most ${selectedModel.referenceImageMax} image assets`
      : null;
  // Gray out item by item in the dropdown: before switching to a model with a smaller cap you can already see "this model supports at most N".
  const getModelOptionDisabledReason = useCallback(
    (model: { referenceImageMax?: number | null }) =>
      model.referenceImageMax != null && orderedReferenceUrls.length > model.referenceImageMax
        ? `This model supports at most ${model.referenceImageMax} image assets`
        : null,
    [orderedReferenceUrls.length],
  );
  const submitDisabled =
    isGenerating ||
    !selectedModel ||
    !hasEffectivePrompt ||
    imageBillingRuleMissing ||
    selectedModelReferenceError !== null;

  /**
   * Called by the host when "the user actively swaps the image on the node for another" (restoring history, setting a cell of the album as
   * the main image…): void the previous batch of in-flight requests, which no longer write to the node after they return.
   */
  const invalidateInFlightGeneration = useCallback(() => {
    generationAttemptRef.current += 1;
  }, []);

  const handleSubmit = useCallback(async (
    options: { completionMode?: 'submitted' | 'completed' } = {},
  ) => {
    const completionMode = options.completionMode ?? 'completed';
    if (submittingRef.current) {
      return await new Promise<Record<string, unknown> | undefined>((resolve) => {
        submitWaitersRef.current.push(resolve);
      });
    }
    if (billingRuleMissingSubmitMessage) {
      updateNodeData(id, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: billingRuleMissingSubmitMessage,
        generationErrorDetails: billingRuleMissingSubmitMessage,
        generationErrorRequestId: null,
      });
      return undefined;
    }
    if (submitDisabled) return undefined;
    submittingRef.current = true;
    let actionOutput: Record<string, unknown> | undefined;
    try {
    const projectId = readUrl().project;
    if (!projectId) {
      console.error('[image-gen] no project in URL');
      return;
    }
    const generationAttempt = generationAttemptRef.current + 1;
    generationAttemptRef.current = generationAttempt;
    const isCurrentGenerationAttempt = () =>
      generationAttemptRef.current === generationAttempt;

    // apiModel comes from the SAME reconciled model the picker displays, so the
    // backend always receives the model the user actually sees.
    const apiModel =
      selectedModel?.apiModel
      ?? SHARED_MODELS.find((m) => m.id === modelId)?.apiModel
      ?? modelId;
    // The node's own reference images (manually uploaded by the user) + all upstream image/video URLs, deduped — sharing the same ordered list
    // (orderedReferenceUrls) with the @image1 numbering, and the backend interprets imageN by position.
    // The backend reference_urls accepts a mixed array of image / video.
    const referenceUrls = orderedReferenceUrls;
    setReferenceErrors([]);
    setReferenceErrorsOpen(false);
    const canvas = useCanvasStore.getState();
    const referenceSnapshot = [
      ...upstreamNodesInEdgeOrder(canvas.nodes, canvas.edges, id),
      ...canvas.nodes.filter((node) => node.id === id),
    ];
    const hasCamera = Boolean(
      cameraSelection
      && (cameraSelection.cameraBodyId
        || cameraSelection.lensId
        || cameraSelection.focalLengthMm
        || cameraSelection.aperture),
    );
    const ownPrompt = prompt.trim();
    const fallbackPrompt = shouldInlineUpstreamTextAsPrompt
      ? (ownPrompt || (hasUserEditedPromptRef.current ? "" : upstreamTextJoined.trim()))
      : [upstreamTextJoined, ownPrompt]
        .filter((s) => s.length > 0)
        .join('\n\n');
    // Workflow recipe nodes use the final prompt compiled by the recipe; non-recipe nodes fall back to the concatenation above.
    const effectivePrompt = await compileWorkflowNodePrompt({
      nodeId: id,
      nodeData: data,
      nodeKind: 'image',
      nodePrompt: ownPrompt,
      upstreamText: upstreamTextJoined,
      upstreamContents,
      fallbackPrompt,
      referenceMedia: referenceUrls.map((_, index) => ({
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
    const genPayload = {
      prompt: effectivePrompt,
      // The backend accepts only a fixed set of ratios; the node's aspectRatio may be a non-standard value reduced from the image's natural size
      // (such as "43:24") or "auto", and before submit it snaps to the nearest legal ratio (auto→1:1).
      aspectRatio: effectiveAspectRatio as typeof aspectRatio,
      imageSize: effectiveImageSize,
      // Quality is sent only when the media catalog declares qualityOptions.
      quality: supportsImageQuality ? effectiveQuality : null,
      referenceUrls,
      provider: selectedModel?.providerId as FreezoneProvider | undefined,
      model: apiModel,
      modelId: selectedModel?.catalogId ?? modelId,
      genMode: generationMode,
      modelParams: data.modelParams,
      camera: hasCamera
        ? {
            cameraBodyId: cameraSelection?.cameraBodyId ?? null,
            lensId: cameraSelection?.lensId ?? null,
            focalLengthMm: cameraSelection?.focalLengthMm ?? null,
            aperture: cameraSelection?.aperture ?? null,
          }
        : null,
      style: styleTemplateId ? { templateId: styleTemplateId } : null,
    };

    // The backend no longer supports producing several images at once; instead it calls the endpoint N times concurrently by "generation count", each producing
    // 1 image. When N > 1 sibling nodes are no longer cloned; all are backfilled into the current node's
    // generationBatch (stacked-card album): the first image to finish is set as the main image (imageUrl), and the rest
    // are appended to the album one by one, rendered as stacked cards when collapsed.
    const total = Math.min(Math.max(effectiveCount, 1), 4);
    const resolvedCompletionMode = resolveImageGenerationCompletionMode(completionMode, total);
    // Clear any prior failure / album on resubmit — the on-node error banner
    // should only reflect the most recent attempt.
    updateNodeData(id, {
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationError: null,
      generationErrorDetails: null,
      generationErrorRequestId: null,
      generationBatch: null,
    });
    // Images that finish first enter the album and display immediately, while unfinished ones render placeholder skeletons in the album.
    setAlbumPendingTotal(id, total > 1 ? total : 0);

    const canvasId = readUrl().canvas ?? 'default';
    // Concurrent tasks finish in no fixed order, so accumulate the completed URLs locally and write back the whole group (avoiding read-modify-write races).
    const completedUrls: string[] = [];
    const submittedRefs: Array<{
      task_key: string;
      task_type: string;
      job_id: string;
    }> = [];
    const runOne = async (runIndex: number) => {
      let taskKey: string | null = null;
      try {
        const ref = await submitFreezoneGen(projectId, {
          ...genPayload,
          canvasId,
          nodeId: id,
        });
        taskKey = ref.task_key;
        // Persist the task handle so a page refresh can resume polling this
        // job. With N concurrent runs on one node only one handle can persist —
        // keep the first (main-image) run's.
        if (runIndex === 0) {
          updateNodeData(id, generationTaskDescriptor(ref));
        }
        submittedRefs.push({
          task_key: ref.task_key,
          task_type: ref.task_type,
          job_id: ref.job_id,
        });
        const completeTask = async () => {
          const completed = await awaitTaskCompletion(ref.task_key, projectId);
          let url = resolveOutputUrl(completed.result as Record<string, unknown> | null);
          if (!url) {
            try {
              const fallback = await fetchFreezoneJobResult(projectId, ref.task_type, ref.job_id);
              url = fallback.url;
            } catch (error) {
              console.warn('[image-gen] fallback fetch failed', error);
            }
          }
          if (url) {
            if (!isCurrentGenerationAttempt()) return;
            completedUrls.push(url);
            const isFirstCompleted = completedUrls.length === 1;
            updateNodeData(id, {
              // The first image to finish is set as the main image and ends loading; later ones only expand the album.
              ...(isFirstCompleted ? buildImageGenerationSuccessPatch(url) : {}),
              ...(total > 1 ? { generationBatch: [...completedUrls] } : {}),
            });
            if (canAutoCommitOnGenerate && isFirstCompleted) {
              canvasEventBus.publish('freezone/commit-node', {
                nodeId: id,
                auto: true,
              });
            }
          } else {
            if (!isCurrentGenerationAttempt()) return;
            console.warn('[image-gen] generation completed without output url', completed);
            // Only run 0 (the owner of the task handle) with no success so far ends loading —
            // a non-first task finishing first "without a URL" must not cut off the overall loading that is still running.
            if (runIndex === 0 && completedUrls.length === 0) {
              updateNodeData(id, { isGenerating: false, generationStartedAt: null });
            }
            throw new Error('Image generation finished but returned no image URL');
          }
        };
        // 'submitted': return the task handle once submitted, and the result backfill continues in the background (a recipe run
        // executing a single node uses this mode, without blocking the whole chain).
        if (resolvedCompletionMode === 'submitted') {
          void completeTask().catch((error) => {
            console.error('[image-gen] background generation failed', error);
            const rawErrorMessage =
              error instanceof Error && error.message
                ? error.message
                : String(error || t('common.error'));
            const displayErrorMessage = backendErrorToastMessage(error, t);
            updateNodeData(id, {
              ...(runIndex === 0
                ? { isGenerating: false, generationStartedAt: null }
                : {}),
              generationError: displayErrorMessage,
              generationErrorDetails: rawErrorMessage,
              generationErrorRequestId: extractRequestId(rawErrorMessage),
            });
          });
          return;
        }
        await completeTask();
      } catch (error) {
        if (!isCurrentGenerationAttempt()) return;
        console.error('[image-gen] generation failed', error);
        // When other images of the same batch have completed (the main image has landed), do not overwrite the success state with an error — a partial failure only
        // affects the album count.
        if (completedUrls.length > 0) return;
        const issues = referenceIssues(error);
        if (issues.length > 0 && runIndex === 0) {
          setReferenceErrors(issues.map((issue) => {
            const matching = referenceSnapshot.filter((node) => {
              const content = extractUpstreamContent(node);
              const values = [
                content.imageUrl,
                'referenceImageUrl' in node.data ? node.data.referenceImageUrl : null,
              ];
              return values.some((url) =>
                typeof url === 'string' && matchesReference(url, issue.reference_key));
            });
            const source = matching.length === 1 ? matching[0] : undefined;
            return {
              ...issue,
              nodeId: source?.id,
              label: referenceIssueName(issue, source?.data.sourceFileName),
            };
          }));
          setReferenceErrorsOpen(true);
          updateNodeData(id, {
            isGenerating: false,
            generationStartedAt: null,
            generationError: t('referenceValidation.title'),
            generationErrorDetails: null,
            generationErrorRequestId: null,
          });
          throw error;
        }
        // Task arbitration (stale / shouldWrite) is meaningful only for run 0: only run 0's task handle is
        // persisted on the node, and the taskKey of other runs inevitably fails to match; applying arbitration would misjudge all of
        // their failures as "stale tasks" and silently swallow them.
        if (runIndex === 0) {
          const latestNodeData = (useCanvasStore
            .getState()
            .nodes
            .find((node) => node.id === id)?.data ?? {}) as Record<string, unknown>;
          if (
            taskKey
            && isStaleGenerationTask({ nodeData: latestNodeData, taskKey })
          ) return;
          if (
            taskKey
            && !shouldWriteGenerationError({ nodeData: latestNodeData, taskKey, error })
          ) {
            updateNodeData(id, { isGenerating: false, generationStartedAt: null });
            return;
          }
        }
        // Persist the failure on the node so it stays visible until the next
        // submit — the request id is the handle support uses to trace it.
        // Only a run 0 failure ends loading: when a non-first run fails, run 0 may still be running,
        // and its success patch would clear the error banner written here.
        const rawErrorMessage =
          error instanceof Error && error.message
            ? error.message
            : String(error || t('common.error'));
        const displayErrorMessage = backendErrorToastMessage(error, t);
        updateNodeData(id, {
          ...(runIndex === 0
            ? { isGenerating: false, generationStartedAt: null }
            : {}),
          generationError: displayErrorMessage,
          generationErrorDetails: rawErrorMessage,
          generationErrorRequestId: extractRequestId(rawErrorMessage),
        });
        // Re-throw so the caller can surface a single error dialog after all
        // concurrent attempts settle (rather than one dialog per failed image).
        throw error;
      }
    };

    const settledRuns = await Promise.allSettled(
      Array.from({ length: total }, (_, runIndex) => runOne(runIndex)),
    );
    // After everything settles, remove the placeholders (failed tasks leave no empty slot; the album closes by the actual completed count).
    setAlbumPendingTotal(id, 0);
    // Backend records each attempt (success or failure); pull the new entries.
    // Failures are surfaced directly on the failing node (request-id banner),
    // set per-target inside runOne's catch — no global modal.
    onGenerationSettled?.();
    if (completedUrls.length > 0) {
      actionOutput = {
        ...(submittedRefs[0] ? {
          task_key: submittedRefs[0].task_key,
          task_type: submittedRefs[0].task_type,
          job_id: submittedRefs[0].job_id,
        } : {}),
        imageUrl: completedUrls[0],
        imageUrls: completedUrls,
      };
      return actionOutput;
    }
    const firstFailure = settledRuns.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (firstFailure) throw firstFailure.reason;
    if (resolvedCompletionMode === 'submitted' && submittedRefs.length > 0) {
      const firstRef = submittedRefs[0]!;
      actionOutput = {
        submitted: true,
        task_key: firstRef.task_key,
        taskKey: firstRef.task_key,
        task_type: firstRef.task_type,
        taskType: firstRef.task_type,
        job_id: firstRef.job_id,
        jobId: firstRef.job_id,
      };
      return actionOutput;
    }
    throw new Error('Image generation did not submit a task and returned no image URL');
    } finally {
      submittingRef.current = false;
      const waiters = submitWaitersRef.current;
      submitWaitersRef.current = [];
      for (const resolve of waiters) {
        resolve(actionOutput);
      }
    }
  }, [
    aspectRatio,
    canAutoCommitOnGenerate,
    selectedModel,
    cameraSelection,
    count,
    data,
    effectiveCount,
    id,
    modelId,
    orderedReferenceUrls,
    prompt,
    effectiveAspectRatio,
    effectiveImageSize,
    effectiveQuality,
    generationMode,
    supportsImageQuality,
    styleTemplateId,
    billingRuleMissingSubmitMessage,
    submitDisabled,
    shouldInlineUpstreamTextAsPrompt,
    updateNodeData,
    upstreamContents,
    upstreamTextJoined,
    onGenerationSettled,
    t,
  ]);

  useEffect(() => {
    if (!shouldInlineUpstreamTextAsPrompt) return;
    if (isComposingRef.current) return;
    if (hasUserEditedPromptRef.current) return;
    if (externalPrompt.trim().length > 0) return;
    const nextPrompt = upstreamTextJoined.trim();
    if (!nextPrompt) return;
    setPromptDraft(nextPrompt);
  }, [
    externalPrompt,
    shouldInlineUpstreamTextAsPrompt,
    upstreamTextJoined,
  ]);

  return {
    formProps: {
      nodeId: id,
      styleTemplateId,
      selectedStyleLabel: selectedStyle?.label ?? null,
      upstreamTextContents,
      upstreamImageContents,
      onDetachUpstream: handleDetachUpstream,
      prompt,
      onPromptChange: (next: string) => {
        hasUserEditedPromptRef.current = hasImageGenPromptOverride(next);
        setPromptDraft(next);
        if (!isComposingRef.current) {
          updateNodeData(id, { prompt: next });
        }
      },
      onCompositionStart: () => {
        isComposingRef.current = true;
      },
      onCompositionEnd: (next: string) => {
        isComposingRef.current = false;
        hasUserEditedPromptRef.current = hasImageGenPromptOverride(next);
        setPromptDraft(next);
        updateNodeData(id, { prompt: next });
      },
      mentionCandidates,
      upstreamTextJoined,
      modelId,
      aspectRatio,
      size: effectiveImageSize,
      sizeOptions: modelSizeOptions,
      aspectOptions: modelAspectOptions,
      quality: effectiveQuality,
      qualityOptions,
      showQuality: supportsImageQuality,
      modelParameters: selectedModel?.request?.parameters,
      modelParams: data.modelParams,
      modelParamsMode: generationMode,
      selectedModelReferenceError:
        selectedModelReferenceError ?? billingRuleMissingSubmitMessage,
      getModelOptionDisabledReason,
      cameraSelection,
      cameraSummary,
      showCountSelect: !canAutoCommitOnGenerate,
      count,
      isTranslatingPrompt,
      isGenerating,
      onTranslate: () => void handleTranslatePrompt(),
      totalCreditCostDisplay,
      creditPromotion,
      submitDisabled,
      onSubmit: () => void handleSubmit(),
    },
    isGenerating,
    submitDisabled,
    submit: handleSubmit,
    canAutoCommitOnGenerate,
    referenceImageUrl,
    referenceErrors,
    referenceErrorsOpen,
    closeReferenceErrors: () => setReferenceErrorsOpen(false),
    openReferenceErrors: () => setReferenceErrorsOpen(true),
    invalidateInFlightGeneration,
  };
}

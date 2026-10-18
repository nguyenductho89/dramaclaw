// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Handle, Position, useReactFlow, type NodeProps } from '@xyflow/react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';
import {
  AlignJustify,
  ArrowUp,
  FileText,
  Image as ImageIcon,
  Languages,
  Loader2,
  Music,
  Music2,
  PlaySquare,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  CANVAS_NODE_TYPES,
  type TextAnnotationNodeData,
  type TextNodeMode,
  type UploadImageNodeData,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { joinUpstreamText } from '@/features/canvas/application/graphContentResolver';
import {
  publishNodeActionAccepted,
  publishNodeActionError,
  publishNodeActionSuccess,
  subscribeNodeAction,
} from '@/features/canvas/application/nodeActionResult';
import { useUpstreamContents } from '@/features/canvas/application/useUpstreamGraph';
import { generateWorkflowText } from '@/features/canvas/application/workflowRecipeRuntime';
import { isSystemManagedNodeData } from '@/features/canvas/domain/mainlineNodeFlags';
import { localizeNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import {
  CANVAS_NODE_INPUT_BODY_FRAME_CLASS,
  CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS,
  CANVAS_NODE_INPUT_FRAME_CLASS,
  CANVAS_NODE_INPUT_PLACEHOLDER_CLASS,
  CANVAS_NODE_INPUT_SURFACE_CLASS,
} from '@/features/canvas/ui/nodeFrameStyles';
import { useCanvasStore, useIsBoxSelecting } from '@/stores/canvasStore';
import {
  ensureBackendImageUrl,
  fetchFreezoneReversePromptResult,
  fetchFreezoneTextGenerateResult,
  fetchFreezoneTextTranslateResult,
  submitFreezoneReversePrompt,
  submitFreezoneTextGenerate,
  submitFreezoneTextTranslate,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { readUrl } from '@/lib/url-params';
import {
  DEFAULT_SHARED_MODEL_ID,
  ProviderModelPicker,
} from '@/features/canvas/ui/ProviderModelPicker';
import {
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
  NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS,
  NODE_INLINE_ICON_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { CreditCostInline } from '@/components/credit-cost-inline';
import type { CreditPromotionDisplay } from '@/components/credits/credit-visual';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { useModelTaskAccess } from '@/lib/model-task-access';
import {
  BillingRuleNotConfiguredError,
  backendErrorToastMessage,
} from '@/lib/api-errors';

type TextAnnotationNodeProps = NodeProps & {
  id: string;
  data: TextAnnotationNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 440;
const DEFAULT_HEIGHT = 220;
const COMPACT_DEFAULT_HEIGHT = 320;
const MIN_WIDTH = 380;
const MIN_HEIGHT = 240;
const COMPACT_MIN_HEIGHT = 240;
const MAX_WIDTH = 900;
const MAX_HEIGHT = 1200;
const IMAGE_REVERSE_PROMPT_FEATURE_KEY = 'freezone.image_reverse_prompt';
const TEXT_GENERATE_FEATURE_KEY = 'freezone.text_generate';
const TEXT_WRITER_MODEL_ID = 'DC-freezone-text-writer-LLM';

const PICKER_INSET = 32;
const COMPACT_OPS_PANEL_HEIGHT = 140;
const COMPACT_OPS_PANEL_GAP = 12;
const COMPACT_OPS_PANEL_MIN_WIDTH = 480;

const COMPACT_MODES = new Set<TextNodeMode>(['textToVideo', 'imageToPrompt']);

// The reverse-prompt instruction prefilled into the text node and sent to the model as is.
const IMAGE_TO_PROMPT_DEFAULT_CONTENT =
  'Generate a structured English prompt from the image, including subject description, environment, lighting, camera language and style keywords.';

function countBillableTextChars(text: string): number {
  return text.replace(/[\s\u3000]+/gu, '').length;
}

// Default music description for "text to music" — prefilled into the text node on click, and the user can edit from there.
// Likewise a prompt sent to the model as is.
const TEXT_TO_MUSIC_DEFAULT_CONTENT =
  'Generate a modern branded electronic track (about 110 BPM) with a clean, powerful low-end bass, crisp electronic drums, and an overall premium, futuristic feel. The intro builds a groove with a rhythmic bass and a simple synth tone. The main section adds a steady drum beat with clear rhythm and restrained tension. The build section adds richer layers, a lifted synth tone and a stronger groove without getting overcrowded. The ending softens the drums, leaving only the low end and ambient sound fading out for a clean, crisp finish.';

const SPAWN_UPLOAD_WIDTH = 320;

/** A reverse prompt usually returns in ten-odd seconds; used to estimate progress advancement for the loading overlay. */
const REVERSE_PROMPT_DURATION_MS = 15000;

/**
 * Resolve the URL of "the image the upstream image node is currently showing". Keeps the same fallback order as the image branch of graphContentResolver:
 * generated result imageUrl → previewImageUrl → referenceImageUrl,
 * so an image-generation node that only has a reference image attached (not generated yet) is also recognized as a referenceable asset.
 */
function resolveUpstreamImageUrl(data: unknown): string | null {
  const d = data as
    | { imageUrl?: unknown; previewImageUrl?: unknown; referenceImageUrl?: unknown }
    | undefined;
  for (const candidate of [d?.imageUrl, d?.previewImageUrl, d?.referenceImageUrl]) {
    if (typeof candidate === 'string' && candidate.length > 0) return candidate;
  }
  return null;
}

const REAL_MODES = new Set<TextNodeMode>([
  'writing',
  'textToVideo',
  'imageToPrompt',
  'textToMusic',
  'textToMusicGen',
]);

const MODES: ReadonlyArray<{
  key: TextNodeMode;
  icon: typeof FileText;
  labelKey: string;
}> = [
  { key: 'writing', icon: FileText, labelKey: 'node.textNode.modes.writing' },
  { key: 'textToVideo', icon: PlaySquare, labelKey: 'node.textNode.modes.textToVideo' },
  { key: 'imageToPrompt', icon: ImageIcon, labelKey: 'node.textNode.modes.imageToPrompt' },
  { key: 'textToMusic', icon: Music, labelKey: 'node.textNode.modes.textToMusic' },
  { key: 'textToMusicGen', icon: Music2, labelKey: 'node.textNode.modes.textToMusicGen' },
];

const EDIT_VIEW_ZOOM = 1.4;

export const TextAnnotationNode = memo(({
  id,
  data,
  selected,
  width,
  height,
}: TextAnnotationNodeProps) => {
  const { t } = useTranslation();
  const modelTaskAccess = useModelTaskAccess();
  const reactFlow = useReactFlow();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const isBoxSelecting = useIsBoxSelecting();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const content = typeof data.content === 'string' ? data.content : '';
  const upstreamContents = useUpstreamContents(id);
  const upstreamTextJoined = joinUpstreamText(upstreamContents);
  const instruction = typeof data.instruction === 'string' ? data.instruction : '';
  const mode: TextNodeMode = data.mode && REAL_MODES.has(data.mode) ? data.mode : 'writing';
  // Already chosen once from the capability picker (e.g. "text to music"): always a plain text editing area, and empty content no longer pops up "Try".
  const pickerDismissed = Boolean(data.pickerDismissed);
  const modelId = typeof data.model === 'string' && data.model.length > 0
    ? data.model
    : DEFAULT_SHARED_MODEL_ID;
  const reversePromptInstruction =
    instruction.trim() || IMAGE_TO_PROMPT_DEFAULT_CONTENT;
  const reversePromptBillableChars = countBillableTextChars(
    reversePromptInstruction,
  );
  const reversePromptCost = useGenerationCreditCost(
    'feature',
    mode === 'imageToPrompt' ? IMAGE_REVERSE_PROMPT_FEATURE_KEY : null,
    {
      surface: 'canvas',
      quantity: reversePromptBillableChars,
      params: {
        operation: 'image_reverse_prompt',
        billable_chars: reversePromptBillableChars,
        pricing_quantity: reversePromptBillableChars,
      },
    },
  );
  const reversePromptBillingRuleMissing =
    reversePromptCost.error instanceof BillingRuleNotConfiguredError;
  const reversePromptCostDisplay =
    reversePromptCost.data?.data.display ??
    (reversePromptBillingRuleMissing
      ? t('common.billingRuleNotConfiguredShort')
      : null);
  const textGeneratePrompt = instruction;
  // Quote is only an estimate for the confirmation UI. The backend reserves and
  // settles from the trusted generated_text length after successful generation.
  const textGenerateEstimatedChars = countBillableTextChars(textGeneratePrompt);
  const textGenerateCost = useGenerationCreditCost(
    'feature',
    (mode === 'writing' || mode === 'textToVideo') && selected
      ? TEXT_GENERATE_FEATURE_KEY
      : null,
    {
      surface: 'canvas',
      quantity: textGenerateEstimatedChars,
      params: {
        operation: 'text_generate',
        billable_chars: textGenerateEstimatedChars,
        pricing_quantity: textGenerateEstimatedChars,
      },
    },
  );
  const textGenerateBillingRuleMissing =
    textGenerateCost.error instanceof BillingRuleNotConfiguredError;
  const textGenerateCostDisplay =
    textGenerateCost.data?.data.display ??
    (textGenerateBillingRuleMissing
      ? t('common.billingRuleNotConfiguredShort')
      : null);
  const { isGenerating } = useNodeGenerationTaskState(data);
  const [isTranslating, setIsTranslating] = useState(false);
  // referenceOnly: the node is used as an upstream reference asset (spawned by a script node).
  // Reuses the compact view (renders only the editing card), and the selected ops panel is not shown either.
  const isReferenceOnly = Boolean(data.referenceOnly);
  const isSystemManaged = isSystemManagedNodeData(data);
  const isCompactView = isReferenceOnly || COMPACT_MODES.has(mode);
  const [isEditingContent, setIsEditingContent] = useState(false);
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  const resolvedTitle = localizeNodeDisplayName(CANVAS_NODE_TYPES.textAnnotation, data, t);
  const minHeightForView = isCompactView ? COMPACT_MIN_HEIGHT : MIN_HEIGHT;
  const defaultHeightForView = isCompactView ? COMPACT_DEFAULT_HEIGHT : DEFAULT_HEIGHT;
  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(minHeightForView, Math.round(height ?? defaultHeightForView));

  // Reactive lookup of the upstream image URL (e.g. uploaded reference image
  // for `imageToPrompt` mode). Re-evaluates whenever edges/nodes change.
  const upstreamImageUrl = useCanvasStore((state) => {
    const edge = state.edges.find((e) => e.target === id);
    if (!edge) return null;
    const node = state.nodes.find((n) => n.id === edge.source);
    return resolveUpstreamImageUrl(node?.data);
  });

  // Remove the link to the upstream reference image: delete the edge pointing to this node (the thumbnail shows only when that edge's source has an image,
  // so deleting the first edge with target===id matches the asset currently shown).
  const handleDetachUpstreamImage = useCallback(() => {
    const state = useCanvasStore.getState();
    const edge = state.edges.find((e) => e.target === id);
    if (edge) {
      deleteEdge(edge.id);
    }
  }, [id, deleteEdge]);

  // libtv-style edit mode: dbl-click the preview card → zoom canvas to 200%
  // centered on this node and focus a fullsize textarea. Escape / blur exits.
  const enterEditMode = useCallback(() => {
    if (isSystemManaged) return;
    const node = reactFlow.getNode(id);
    if (node) {
      const w = (node.measured?.width ?? width ?? DEFAULT_WIDTH);
      const h = (node.measured?.height ?? height ?? DEFAULT_HEIGHT);
      // A group member's node.position is relative to the parent group, while setCenter needs absolute canvas coordinates.
      // Use internalNode's positionAbsolute (equal to position when there is no parent group); otherwise double-clicking a node
      // inside a group would pan the view elsewhere by the group origin's offset.
      const absolute =
        reactFlow.getInternalNode(id)?.internals.positionAbsolute ?? node.position;
      const cx = absolute.x + w / 2;
      const cy = absolute.y + h / 2;
      void reactFlow.setCenter(cx, cy, { zoom: EDIT_VIEW_ZOOM, duration: 280 });
    }
    setIsEditingContent(true);
  }, [height, id, isSystemManaged, reactFlow, width]);

  useEffect(() => {
    if (isSystemManaged && isEditingContent) {
      setIsEditingContent(false);
    }
  }, [isEditingContent, isSystemManaged]);

  useEffect(() => {
    if (!isEditingContent) return;
    // Focus on next tick so the textarea exists after the swap.
    const timer = window.setTimeout(() => {
      editTextareaRef.current?.focus();
      const len = editTextareaRef.current?.value.length ?? 0;
      editTextareaRef.current?.setSelectionRange(len, len);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [isEditingContent]);

  const spawnVideoNode = useCallback(() => {
    const position = findNodePosition(id, 580, 680);
    // The text content is provided live to downstream through edges. Do not copy it to video.prompt here; that field is only for
    // the video node's own supplementary instructions, otherwise stale snapshots remain after the upstream text updates.
    const seedData: Partial<VideoNodeData> = {
      genMode: 'textToVideo',
    };
    const newNodeId = addNode(CANVAS_NODE_TYPES.video, position, seedData);
    addEdge(id, newNodeId);
    useCanvasStore
      .getState()
      .autoGroupSpawn(id, [newNodeId], { label: t('node.textNode.group.textToVideo') });
  }, [addEdge, addNode, findNodePosition, id, t]);

  const spawnUploadNode = useCallback(() => {
    const sourceNode = useCanvasStore
      .getState()
      .nodes.find((node) => node.id === id);
    const sourceX = sourceNode?.position.x ?? 0;
    const sourceY = sourceNode?.position.y ?? 0;
    const position = {
      x: sourceX - SPAWN_UPLOAD_WIDTH - 60,
      y: sourceY,
    };
    // Reverse prompt only accepts images, so restrict the upload node to image types (title becomes "Upload image",
    // file picker accept=image/*, dragging in video/audio is rejected).
    const seedData: Partial<UploadImageNodeData> = { imageOnly: true };
    const newNodeId = addNode(CANVAS_NODE_TYPES.upload, position, seedData);
    addEdge(newNodeId, id);
    useCanvasStore
      .getState()
      .autoGroupSpawn(id, [newNodeId], { label: t('node.textNode.group.imageToPrompt') });
  }, [addEdge, addNode, id, t]);

  // Clone audio / text to music: derive an audio node downstream of the text node and connect the edge (text → audio),
  // isomorphic with the video node derived by "text to video". The audio node's default size is 480×180.
  // audioKind decides whether the downstream audio node does voice cloning (speech) or text-to-music (music).
  const spawnAudioNode = useCallback((audioKind: 'speech' | 'music') => {
    const position = findNodePosition(id, 480, 180);
    const newNodeId = addNode(CANVAS_NODE_TYPES.audio, position, { audioKind });
    addEdge(id, newNodeId);
    const label =
      audioKind === 'music'
        ? t('node.textNode.group.textToMusic')
        : t('node.textNode.group.cloneAudio');
    useCanvasStore.getState().autoGroupSpawn(id, [newNodeId], { label });
  }, [addEdge, addNode, findNodePosition, id, t]);

  const handlePickMode = useCallback((nextMode: TextNodeMode) => {
    if (nextMode === 'writing') {
      // First open the AI creation panel; the node body can still be edited by hand by clicking the placeholder area / double-clicking existing content.
      updateNodeData(id, { mode: nextMode, pickerDismissed: true });
      return;
    }
    // Text to music: after deriving the downstream music audio node, the text node on the left returns to plain-text editing
    // (writing) — the music description is typed here and synced to the downstream audio node, and the capability picker is no longer shown.
    if (nextMode === 'textToMusicGen') {
      spawnAudioNode('music');
      // The text node returns to plain-text editing, the capability picker closes, and the default music description is prefilled (synced to the downstream audio node).
      updateNodeData(id, {
        mode: 'writing',
        pickerDismissed: true,
        content: TEXT_TO_MUSIC_DEFAULT_CONTENT,
      });
      enterEditMode();
      return;
    }
    updateNodeData(id, { mode: nextMode });
    if (nextMode === 'textToVideo') {
      spawnVideoNode();
    } else if (nextMode === 'imageToPrompt') {
      spawnUploadNode();
    } else if (nextMode === 'textToMusic') {
      spawnAudioNode('speech');
    }
  }, [enterEditMode, id, spawnAudioNode, spawnUploadNode, spawnVideoNode, updateNodeData]);

  const runImageToPrompt = useCallback(async () => {
    if (modelTaskAccess.blocked) return;
    const projectId = readUrl().project;
    if (!projectId) {
      console.error('[text-node] no project in URL');
      return;
    }
    const state = useCanvasStore.getState();
    const upstreamEdge = state.edges.find((edge) => edge.target === id);
    const sourceNode = upstreamEdge
      ? state.nodes.find((node) => node.id === upstreamEdge.source)
      : null;
    const rawUrl = resolveUpstreamImageUrl(sourceNode?.data);
    if (!rawUrl) {
      console.warn('[text-node] imageToPrompt: no upstream image url');
      return;
    }
    updateNodeData(id, { isGenerating: true, generationStartedAt: Date.now() });
    try {
      // Backend looks up the file by static path — `data:` URLs get uploaded
      // first via /freezone/upload to obtain a real path; `?v=<ts>` cache
      // busters are stripped either way.
      const sourceUrl = await ensureBackendImageUrl(projectId, rawUrl);
      const ref = await submitFreezoneReversePrompt(projectId, {
        sourceUrl,
        instruction: reversePromptInstruction,
        canvasId: readUrl().canvas ?? 'default',
        nodeId: id,
      });
      // Persist the task handle so a page refresh can resume this job.
      updateNodeData(id, generationTaskDescriptor(ref));
      await awaitTaskCompletion(ref.task_key, projectId, { taskType: ref.task_type });
      // SSE task.result only carries `{ output_format: "json" }`; the prompt
      // text comes from the dedicated job-result endpoint.
      const { prompt } = await fetchFreezoneReversePromptResult(projectId, ref.job_id);
      if (prompt && prompt.trim().length > 0) {
        updateNodeData(id, { content: prompt, isGenerating: false, generationStartedAt: null });
      } else {
        console.warn('[text-node] reverse-prompt returned empty prompt', { jobId: ref.job_id });
        updateNodeData(id, { isGenerating: false, generationStartedAt: null });
      }
    } catch (error) {
      console.error('[text-node] reverse-prompt failed', error);
      updateNodeData(id, { isGenerating: false, generationStartedAt: null });
    }
  }, [id, modelTaskAccess.blocked, reversePromptInstruction, updateNodeData]);

  const runTextGenerate = useCallback(async (promptOverride?: string) => {
    const prompt = (promptOverride ?? instruction).trim();
    if (modelTaskAccess.blocked || !prompt || textGenerateBillingRuleMissing) return;
    const projectId = readUrl().project;
    if (!projectId) {
      console.error('[text-node] text generation: no project in URL');
      return;
    }

    updateNodeData(id, { isGenerating: true, generationStartedAt: Date.now() });
    try {
      const ref = await submitFreezoneTextGenerate(projectId, {
        prompt,
        canvasId: readUrl().canvas ?? 'default',
        nodeId: id,
      });
      updateNodeData(id, generationTaskDescriptor(ref));
      await awaitTaskCompletion(ref.task_key, projectId, { taskType: ref.task_type });
      const result = await fetchFreezoneTextGenerateResult(projectId, ref.job_id);
      if (!result.generated_text.trim()) {
        throw new Error('text generation returned empty output');
      }
      updateNodeData(id, {
        content: result.generated_text,
        model: result.model || TEXT_WRITER_MODEL_ID,
        isGenerating: false,
        generationStartedAt: null,
      });
    } catch (error) {
      console.error('[text-node] text generation failed', error);
      toast.error(backendErrorToastMessage(error, t));
      updateNodeData(id, { isGenerating: false, generationStartedAt: null });
    }
  }, [id, instruction, modelTaskAccess.blocked, t, textGenerateBillingRuleMissing, updateNodeData]);

  const runInstructionTranslate = useCallback(async () => {
    if (modelTaskAccess.blocked || isGenerating || isTranslating) return;
    const trimmed = instruction.trim();
    if (trimmed.length === 0) return;
    const projectId = readUrl().project;
    if (!projectId) {
      console.error('[text-node] translate: no project in URL');
      return;
    }
    setIsTranslating(true);
    try {
      const ref = await submitFreezoneTextTranslate(projectId, {
        text: trimmed,
        nodeType: 'text',
        canvasId: readUrl().canvas ?? 'default',
        nodeId: id,
      });
      await awaitTaskCompletion(ref.task_key, projectId, { taskType: ref.task_type });
      const result = await fetchFreezoneTextTranslateResult(projectId, ref.job_id);
      updateNodeData(id, { instruction: result.translated_text });
    } catch (error) {
      console.error('[text-node] translate failed', error);
    } finally {
      setIsTranslating(false);
    }
  }, [id, instruction, isGenerating, isTranslating, modelTaskAccess.blocked, updateNodeData]);

  const runContentTranslate = useCallback(async () => {
    if (modelTaskAccess.blocked || isGenerating || isTranslating) return;
    const trimmed = content.trim();
    if (trimmed.length === 0) return;
    const projectId = readUrl().project;
    if (!projectId) {
      console.error('[text-node] translate: no project in URL');
      return;
    }
    setIsTranslating(true);
    try {
      const ref = await submitFreezoneTextTranslate(projectId, {
        text: trimmed,
        nodeType: 'text',
        canvasId: readUrl().canvas ?? 'default',
        nodeId: id,
      });
      await awaitTaskCompletion(ref.task_key, projectId, { taskType: ref.task_type });
      const result = await fetchFreezoneTextTranslateResult(projectId, ref.job_id);
      updateNodeData(id, { content: result.translated_text });
    } catch (error) {
      console.error('[text-node] translate failed', error);
    } finally {
      setIsTranslating(false);
    }
  }, [content, id, isGenerating, isTranslating, modelTaskAccess.blocked, updateNodeData]);

  const runRecipeText = useCallback(async (): Promise<{ content: string }> => {
    updateNodeData(id, {
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationError: null,
    });
    try {
      const generated = await generateWorkflowText({
        nodeId: id,
        nodeData: data,
        nodePrompt: content,
        upstreamText: upstreamTextJoined,
        upstreamContents,
      });
      updateNodeData(id, {
        content: generated,
        workflowTextGenerated: true,
        isGenerating: false,
        generationStartedAt: null,
      });
      return { content: generated };
    } catch (error) {
      updateNodeData(id, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: error instanceof Error ? error.message : 'Text generation failed',
      });
      throw error;
    }
  }, [content, data, id, updateNodeData, upstreamContents, upstreamTextJoined]);

  useEffect(() => subscribeNodeAction(({ nodeId, action, requestId }) => {
    if (nodeId !== id || action !== 'generate_text') return;
    publishNodeActionAccepted(requestId, id, action);
    void runRecipeText()
      .then((output) => publishNodeActionSuccess(requestId, id, action, output))
      .catch((error) => publishNodeActionError(requestId, id, action, error));
  }), [id, runRecipeText]);

  const textPlaceholder = t('node.textNode.placeholder');
  const hasUserContent = content.trim().length > 0 && content.trim() !== textPlaceholder.trim();

  const handleSubmit = useCallback(() => {
    if (isGenerating) return;
    if (mode === 'writing') {
      void runTextGenerate();
      return;
    }
    if (reversePromptBillingRuleMissing) return;
    if (mode === 'imageToPrompt') {
      void runImageToPrompt();
      return;
    }
    if (mode === 'textToVideo') {
      void runTextGenerate();
      return;
    }
    if (!hasUserContent) return;
    console.info('[text-node] submit stub', { id, mode, model: modelId, content });
  }, [
    content,
    hasUserContent,
    id,
    isGenerating,
    mode,
    modelId,
    reversePromptBillingRuleMissing,
    runImageToPrompt,
    runTextGenerate,
  ]);

  const submitDisabled = isGenerating
    || modelTaskAccess.blocked
    || (mode === 'writing' && (textGenerateBillingRuleMissing || instruction.trim().length === 0))
    || (
      mode === 'textToVideo'
      && (textGenerateBillingRuleMissing || instruction.trim().length === 0)
    )
    || (mode === 'imageToPrompt' && reversePromptBillingRuleMissing)
    || (
      mode !== 'writing'
      && mode !== 'textToVideo'
      && mode !== 'imageToPrompt'
      && !hasUserContent
    );
  // Inner panels stay neutral regardless of selection — the React Flow node
  // wrapper already shows the active state as an outer outline. Doubling it
  // up on the inner cards (libtv-style reference shows neutral borders only)
  // looks busy.
  const inputBodyToneClass = `${CANVAS_NODE_INPUT_SURFACE_CLASS} ${
    selected ? CANVAS_NODE_INPUT_BODY_SELECTED_FRAME_CLASS : CANVAS_NODE_INPUT_BODY_FRAME_CLASS
  }`;
  const inputPanelToneClass = `${CANVAS_NODE_INPUT_SURFACE_CLASS} ${CANVAS_NODE_INPUT_FRAME_CLASS}`;

  return (
    <div
      className="group relative h-full w-full overflow-visible"
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="target"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<FileText className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable={!isSystemManaged}
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <NodeResizeHandle
        minWidth={MIN_WIDTH}
        minHeight={minHeightForView}
        maxWidth={MAX_WIDTH}
        maxHeight={MAX_HEIGHT}
      />

      {!isCompactView && mode === 'writing' && selected && !isBoxSelecting && !isReferenceOnly && !isSystemManaged && !isEditingContent && (
        <WritingOpsPanel
          nodeId={id}
          instruction={instruction}
          isGenerating={isGenerating}
          isTranslating={isTranslating}
          width={resolvedWidth}
          costDisplay={textGenerateCostDisplay}
          promotion={textGenerateCost.data?.data.promotion}
          submitDisabled={submitDisabled}
          translateDisabled={
            modelTaskAccess.blocked
            || isGenerating
            || isTranslating
            || instruction.trim().length === 0
          }
          onGenerate={handleSubmit}
          onTranslate={runInstructionTranslate}
        />
      )}

      {!isCompactView && mode === 'textToMusic' && selected && !isBoxSelecting && !isReferenceOnly && !isSystemManaged && !isEditingContent && (
        <ContentOpsPanel
          nodeId={id}
          content={content}
          isGenerating={isGenerating}
          isTranslating={isTranslating}
          width={resolvedWidth}
          translateDisabled={
            modelTaskAccess.blocked
            || isGenerating
            || isTranslating
            || content.trim().length === 0
          }
          onTranslate={runContentTranslate}
        />
      )}

      {isCompactView ? (
        <>
          <div
            className={`flex h-full w-full flex-col items-center justify-center rounded-[var(--node-radius)] border transition-colors ${inputBodyToneClass}`}
            onDoubleClick={(event) => {
              if (isEditingContent || isSystemManaged) return;
              event.stopPropagation();
              enterEditMode();
            }}
          >
            {isEditingContent ? (
              <textarea
                ref={editTextareaRef}
                value={content}
                onChange={(event) => updateNodeData(id, { content: event.target.value })}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Escape') {
                    setIsEditingContent(false);
                    editTextareaRef.current?.blur();
                  }
                }}
                onBlur={() => setIsEditingContent(false)}
                placeholder={textPlaceholder}
                className={`ui-scrollbar nodrag nowheel h-full w-full resize-none border-none bg-transparent px-4 py-4 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
              />
            ) : hasUserContent ? (
              <div className="ui-scrollbar nowheel max-h-full w-full overflow-y-auto px-4 py-4 text-sm leading-6 text-text-dark">
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks]}
                  components={{
                    h1: ({ ...props }) => <h1 className="mb-1 mt-2 text-base font-semibold" {...props} />,
                    h2: ({ ...props }) => <h2 className="mb-1 mt-2 text-sm font-semibold" {...props} />,
                    h3: ({ ...props }) => <h3 className="mb-1 mt-1 text-sm font-semibold" {...props} />,
                    p: ({ ...props }) => <p className="my-1" {...props} />,
                    strong: ({ ...props }) => <strong className="font-semibold text-text-dark" {...props} />,
                    em: ({ ...props }) => <em className="italic" {...props} />,
                    ul: ({ ...props }) => <ul className="my-1 ml-5 list-disc" {...props} />,
                    ol: ({ ...props }) => <ol className="my-1 ml-5 list-decimal" {...props} />,
                    li: ({ ...props }) => <li className="my-0.5" {...props} />,
                    code: ({ ...props }) => (
                      <code className="rounded bg-white/10 px-1 py-0.5 text-xs" {...props} />
                    ),
                    hr: () => <hr className="my-2 border-white/10" />,
                  }}
                >
                  {content}
                </ReactMarkdown>
              </div>
            ) : (
              <AlignJustify className="h-12 w-12 stroke-[1.5] text-text-muted/40" />
            )}
            {isGenerating && (
              <NodeGenerationOverlay
                startedAt={data.generationStartedAt}
                durationMs={REVERSE_PROMPT_DURATION_MS}
                hasBackground={hasUserContent}
              />
            )}
          </div>

          {selected && !isBoxSelecting && !isReferenceOnly && !isSystemManaged && !isEditingContent && (
            <div
              className={`nodrag absolute left-1/2 z-[300] flex -translate-x-1/2 flex-col rounded-[var(--node-radius)] border ${inputPanelToneClass}`}
              style={{
                top: `calc(100% + ${COMPACT_OPS_PANEL_GAP}px)`,
                height: COMPACT_OPS_PANEL_HEIGHT,
                width: Math.max(resolvedWidth, COMPACT_OPS_PANEL_MIN_WIDTH),
              }}
              onClick={(event) => event.stopPropagation()}
            >
              {upstreamImageUrl && (
                <div className="flex shrink-0 items-center px-3 pt-3">
                  <div className="group relative h-9 w-9 overflow-hidden rounded-md border border-white/10">
                    <img
                      src={resolveImageDisplayUrl(upstreamImageUrl)}
                      alt=""
                      className="h-full w-full object-cover"
                      draggable={false}
                    />
                    <button
                      type="button"
                      title={t('node.textNode.detachUpstreamImage')}
                      className="nodrag absolute right-0 top-0 z-10 hidden h-4 w-4 items-center justify-center rounded-bl-md bg-black/75 text-white transition-colors hover:bg-red-500 group-hover:flex"
                      onMouseDown={(event) => event.stopPropagation()}
                      onClick={(event) => {
                        event.stopPropagation();
                        handleDetachUpstreamImage();
                      }}
                    >
                      <X className="h-3 w-3" strokeWidth={2.5} />
                    </button>
                  </div>
                </div>
              )}
              <textarea
                value={
                  mode === 'imageToPrompt' || mode === 'textToVideo'
                    ? instruction === IMAGE_TO_PROMPT_DEFAULT_CONTENT ? '' : instruction
                    : content
                }
                onChange={(event) => {
                  const field = mode === 'imageToPrompt' || mode === 'textToVideo'
                    ? 'instruction'
                    : 'content';
                  updateNodeData(id, { [field]: event.target.value });
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onClick={(event) => event.stopPropagation()}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder={
                  mode === 'imageToPrompt'
                    ? IMAGE_TO_PROMPT_DEFAULT_CONTENT
                    : mode === 'textToVideo'
                      ? t('node.textNode.generatePlaceholder')
                      : textPlaceholder
                }
                className={`ui-scrollbar nodrag nowheel min-h-0 w-full flex-1 resize-none border-none bg-transparent px-3 pt-3 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
              />
              <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
                {/* The video model for text-to-video is managed by the downstream video node; the reverse prompt endpoint takes no model.
                    So neither of these two modes shows a model selector on the text node. */}
                {mode === 'textToVideo' || mode === 'imageToPrompt' ? (
                  <span />
                ) : (
                  <ProviderModelPicker
                    selectedModelId={modelId}
                    onChange={(nextModelId) => updateNodeData(id, { model: nextModelId })}
                    popoverPlacement="top"
                  />
                )}
                <div className="flex items-center gap-1.5">
                  {mode === 'imageToPrompt' && (
                    <CreditCostInline
                      display={reversePromptCostDisplay}
                      promotion={reversePromptCost.data?.data.promotion}
                    />
                  )}
                  {mode === 'textToVideo' && (
                    <>
                      <button
                        type="button"
                        title={t('node.textNode.translate')}
                        onClick={(event) => {
                          event.stopPropagation();
                          void runInstructionTranslate();
                        }}
                        disabled={
                          modelTaskAccess.blocked
                          || isGenerating
                          || isTranslating
                          || instruction.trim().length === 0
                        }
                        className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
                          isTranslating ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS : ''
                        }`}
                      >
                        {isTranslating ? (
                          <Loader2 className="h-4 w-4 animate-spin" />
                        ) : (
                          <Languages className="h-4 w-4" />
                        )}
                      </button>
                      <CreditCostInline
                        display={textGenerateCostDisplay}
                        promotion={textGenerateCost.data?.data.promotion}
                      />
                    </>
                  )}
                  <button
                    type="button"
                    disabled={submitDisabled}
                    title={
                      mode === 'textToVideo'
                        ? t('node.textNode.generateText')
                        : t('node.textNode.submit')
                    }
                    onClick={(event) => {
                      event.stopPropagation();
                      handleSubmit();
                    }}
                    className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
                      submitDisabled
                        ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                        : NODE_GENERATE_BUTTON_ENABLED_CLASS
                    }`}
                  >
                    {isGenerating ? (
                      <Loader2 className="h-4 w-4 animate-spin" />
                    ) : (
                      <ArrowUp className="h-4 w-4" />
                    )}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      ) : (
        // Default view (writing / textToMusic): the node body is itself the text editing area — with content
        // markdown renders directly and double-click enters editing; with empty content it falls back to the capability
        // picker (letting the user choose what to do next / switch to another mode). The prompt + send panel at the bottom
        // has been removed — the submit for writing/textToMusic
        // was a stub before, and keeping it would only duplicate editing the same content field as the body.
        <div
          className={`relative flex h-full w-full flex-col rounded-[var(--node-radius)] border transition-colors ${inputBodyToneClass}`}
          onDoubleClick={(event) => {
            if (isEditingContent || isSystemManaged) return;
            event.stopPropagation();
            enterEditMode();
          }}
        >
          {isGenerating && (
            <NodeGenerationOverlay
              startedAt={data.generationStartedAt ?? null}
              durationMs={REVERSE_PROMPT_DURATION_MS}
              hasBackground={hasUserContent}
            />
          )}
          {isEditingContent ? (
            <textarea
              ref={editTextareaRef}
              value={content}
              onChange={(event) => updateNodeData(id, { content: event.target.value })}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === 'Escape') {
                  setIsEditingContent(false);
                  editTextareaRef.current?.blur();
                }
              }}
              onBlur={() => setIsEditingContent(false)}
              placeholder={textPlaceholder}
              className={`ui-scrollbar nodrag nowheel h-full w-full resize-none border-none bg-transparent px-4 py-4 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
            />
          ) : hasUserContent ? (
            <div className="ui-scrollbar nowheel max-h-full w-full flex-1 overflow-y-auto px-4 py-4 text-sm leading-6 text-text-dark">
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={{
                  h1: ({ ...props }) => <h1 className="mb-1 mt-2 text-base font-semibold" {...props} />,
                  h2: ({ ...props }) => <h2 className="mb-1 mt-2 text-sm font-semibold" {...props} />,
                  h3: ({ ...props }) => <h3 className="mb-1 mt-1 text-sm font-semibold" {...props} />,
                  p: ({ ...props }) => <p className="my-1" {...props} />,
                  strong: ({ ...props }) => <strong className="font-semibold text-text-dark" {...props} />,
                  em: ({ ...props }) => <em className="italic" {...props} />,
                  ul: ({ ...props }) => <ul className="my-1 ml-5 list-disc" {...props} />,
                  ol: ({ ...props }) => <ol className="my-1 ml-5 list-decimal" {...props} />,
                  li: ({ ...props }) => <li className="my-0.5" {...props} />,
                  code: ({ ...props }) => (
                    <code className="rounded bg-white/10 px-1 py-0.5 text-xs" {...props} />
                  ),
                  hr: () => <hr className="my-2 border-white/10" />,
                }}
              >
                {content}
              </ReactMarkdown>
            </div>
          ) : isSystemManaged ? (
            <div className="flex min-h-0 flex-1 items-center justify-center py-4">
              <AlignJustify className="h-12 w-12 stroke-[1.5] text-text-muted/40" />
            </div>
          ) : pickerDismissed ? (
            // A plain-text node that has already chosen a mode: with empty content shows the placeholder, click to edit, and the picker is no longer shown.
            <div
              className={`flex min-h-0 flex-1 cursor-text items-start px-4 py-4 text-sm leading-6 ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
              onClick={(event) => {
                event.stopPropagation();
                enterEditMode();
              }}
            >
              {textPlaceholder}
            </div>
          ) : (
            <div
              className="flex min-h-0 flex-1 flex-col justify-center gap-2 py-4"
              style={{ marginInline: PICKER_INSET }}
            >
              <div className="text-xs text-[var(--canvas-node-input-helper)]">{t('node.textNode.tryHint')}</div>
              <div className="flex flex-col gap-0.5">
                {MODES.map((item) => {
                  const Icon = item.icon;
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        handlePickMode(item.key);
                      }}
                      className="-mx-2 inline-flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-text-dark transition-colors hover:bg-white/[0.08]"
                    >
                      <Icon className="h-4 w-4 text-text-muted/90" />
                      <span>{t(item.labelKey)}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
});

TextAnnotationNode.displayName = 'TextAnnotationNode';

interface WritingOpsPanelProps {
  nodeId: string;
  instruction: string;
  isGenerating: boolean;
  isTranslating: boolean;
  width: number;
  costDisplay: string | null;
  promotion?: CreditPromotionDisplay | null;
  submitDisabled: boolean;
  translateDisabled: boolean;
  onGenerate: () => void;
  onTranslate: () => void;
}

function WritingOpsPanel({
  nodeId,
  instruction,
  isGenerating,
  isTranslating,
  width,
  costDisplay,
  promotion,
  submitDisabled,
  translateDisabled,
  onGenerate,
  onTranslate,
}: WritingOpsPanelProps) {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const generatePlaceholder = t('node.textNode.generatePlaceholder');

  return (
    <div
      className={`nodrag absolute left-1/2 z-[300] flex -translate-x-1/2 flex-col rounded-[var(--node-radius)] border ${CANVAS_NODE_INPUT_SURFACE_CLASS} ${CANVAS_NODE_INPUT_FRAME_CLASS}`}
      style={{
        top: `calc(100% + ${COMPACT_OPS_PANEL_GAP}px)`,
        height: COMPACT_OPS_PANEL_HEIGHT,
        width: Math.max(width, COMPACT_OPS_PANEL_MIN_WIDTH),
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <textarea
        value={instruction}
        onChange={(event) => updateNodeData(nodeId, { instruction: event.target.value })}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        placeholder={generatePlaceholder}
        className={`ui-scrollbar nodrag nowheel min-h-0 w-full flex-1 resize-none border-none bg-transparent px-3 pt-3 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
        disabled={isGenerating}
      />
      <div className="flex shrink-0 items-center justify-end gap-2 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            title={t('node.textNode.translate')}
            onClick={(event) => {
              event.stopPropagation();
              onTranslate();
            }}
            disabled={translateDisabled}
            className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
              isTranslating ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS : ''
            }`}
          >
            {isTranslating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Languages className="h-4 w-4" />
            )}
          </button>
          <CreditCostInline display={costDisplay} promotion={promotion} />
          <button
            type="button"
            disabled={submitDisabled}
            title={t('node.textNode.generateText')}
            onClick={(event) => {
              event.stopPropagation();
              onGenerate();
            }}
            className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
              submitDisabled
                ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                : NODE_GENERATE_BUTTON_ENABLED_CLASS
            }`}
          >
            {isGenerating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

interface ContentOpsPanelProps {
  nodeId: string;
  content: string;
  isGenerating: boolean;
  isTranslating: boolean;
  width: number;
  translateDisabled: boolean;
  onTranslate: () => void;
}

function ContentOpsPanel({
  nodeId,
  content,
  isGenerating,
  isTranslating,
  width,
  translateDisabled,
  onTranslate,
}: ContentOpsPanelProps) {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const textPlaceholder = t('node.textNode.placeholder');

  return (
    <div
      className={`nodrag absolute left-1/2 z-[300] flex -translate-x-1/2 flex-col rounded-[var(--node-radius)] border ${CANVAS_NODE_INPUT_SURFACE_CLASS} ${CANVAS_NODE_INPUT_FRAME_CLASS}`}
      style={{
        top: `calc(100% + ${COMPACT_OPS_PANEL_GAP}px)`,
        height: COMPACT_OPS_PANEL_HEIGHT,
        width: Math.max(width, COMPACT_OPS_PANEL_MIN_WIDTH),
      }}
      onClick={(event) => event.stopPropagation()}
    >
      <textarea
        value={content}
        onChange={(event) => updateNodeData(nodeId, { content: event.target.value })}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => event.stopPropagation()}
        placeholder={textPlaceholder}
        className={`ui-scrollbar nodrag nowheel min-h-0 w-full flex-1 resize-none border-none bg-transparent px-3 pt-3 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
        disabled={isGenerating}
      />
      <div className="flex shrink-0 items-center justify-end gap-1 px-3 py-2">
        <button
          type="button"
          title={t('node.textNode.translate')}
          onClick={(event) => {
            event.stopPropagation();
            onTranslate();
          }}
          disabled={translateDisabled}
          className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
            isTranslating ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS : ''
          }`}
        >
          {isTranslating ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Languages className="h-4 w-4" />
          )}
        </button>
      </div>
    </div>
  );
}

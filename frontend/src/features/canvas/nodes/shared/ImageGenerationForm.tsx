// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  ArrowUp,
  Camera,
  ChevronDown,
  Languages,
  Library,
  Loader2,
  Palette,
  X,
} from 'lucide-react';

import type {
  ImageGenCameraSelection,
  ImageGenCount,
  ImageGenNodeData,
  ImageQuality,
  ImageSize,
} from '@/features/canvas/domain/canvasNodes';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import {
  IMAGE_QUALITY_OPTIONS,
  resolveNearestAspectOption,
} from '@/features/canvas/nodes/shared/imageGenerationOptions';
import type { UpstreamContent } from '@/features/canvas/application/ports';
import { useCanvasStore } from '@/stores/canvasStore';
import { ReferenceTextChip } from '@/features/canvas/nodes/shared/ReferenceTextChip';
import {
  PromptMentionEditor,
  type MentionCandidate,
  type PromptMentionEditorHandle,
} from '@/features/canvas/nodes/PromptMentionEditor';
import {
  CAMERA_PICKER_POPOVER_WIDTH,
  CameraPickerPopover,
} from '@/features/canvas/nodes/CameraPickerPopover';
import { StylePickerPopover } from '@/features/canvas/nodes/StylePickerPopover';
import { NodeContextPromptPaletteButton } from '@/features/canvas/nodes/ContextPromptPaletteButton';
import {
  contextPromptPaletteInsertionText,
  type ContextPromptPaletteEntry,
} from '@/features/canvas/nodes/contextPromptPalette';
import {
  ProviderModelPicker,
  type ModelOption,
} from '@/features/canvas/ui/ProviderModelPicker';
import { MediaModelParameterChip } from '@/features/canvas/ui/MediaModelParameterChip';
import type { MediaModelParameterDefinition } from '@/api/ops';
import {
  CreditCostPill,
  type CreditPromotionDisplay,
} from '@/components/credits/credit-visual';
import {
  CANVAS_NODE_INPUT_PLACEHOLDER_CLASS,
} from '@/features/canvas/ui/nodeFrameStyles';
import {
  NODE_COUNT_POPOVER_CLASS,
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_FLOATING_PANEL_SURFACE_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
  NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS,
  NODE_INLINE_ICON_BUTTON_CLASS,
  NODE_REFERENCE_MEDIA_CHIP_CLASS,
  NODE_REFERENCE_MEDIA_DETACH_CLASS,
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';

const COUNT_OPTIONS: ReadonlyArray<ImageGenCount> = [1, 2, 4];

const IMAGE_PARAM_POPOVER_CLASS =
  `nodrag nowheel absolute bottom-full left-0 z-50 mb-2 w-[300px] p-4 ${NODE_FLOATING_PANEL_SURFACE_CLASS}`;
const IMAGE_PARAM_LABEL_CLASS =
  'mb-2 text-[11px] font-medium uppercase tracking-wide text-text-muted/85';
const IMAGE_PARAM_BUTTON_BASE_CLASS =
  'inline-flex h-8 items-center justify-center rounded-md text-xs transition-colors';
const IMAGE_PARAM_ACTIVE_BUTTON_CLASS =
  'bg-white/[0.13] text-text-dark ring-1 ring-white/24';
const IMAGE_PARAM_IDLE_BUTTON_CLASS =
  'bg-white/[0.07] text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark';
const IMAGE_PARAM_ROW_CLASS = 'mb-4 flex gap-2';
const NODE_COUNT_OPTION_BASE_CLASS =
  'flex w-full items-center justify-center rounded-[6px] px-3 py-1.5 text-xs transition-colors';

interface AspectSizeChipProps {
  aspectRatio: string;
  size: string;
  sizeOptions: readonly string[];
  aspectOptions: ReadonlyArray<{ value: string; label: string }>;
  quality: ImageQuality;
  qualityOptions: readonly ImageQuality[];
  /** Show the selector when the media catalog declares image quality options, and carry the quality in the label. */
  showQuality: boolean;
  onChange: (patch: Partial<ImageGenNodeData>) => void;
}

function AspectSizeChip({
  aspectRatio,
  size,
  sizeOptions,
  aspectOptions,
  quality,
  qualityOptions,
  showQuality,
  onChange,
}: AspectSizeChipProps) {
  const { t } = useTranslation();
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

  const nearestAspect = resolveNearestAspectOption(aspectRatio, aspectOptions);
  const aspectLabel = nearestAspect.label;
  const qualityLabel = IMAGE_QUALITY_OPTIONS.find((option) => option.value === quality)?.label
    ?? quality;

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={NODE_TEXT_CONTROL_TRIGGER_CLASS}
      >
        <span>{aspectLabel}</span>
        {showQuality && (
          <>
            <span className="text-text-muted/80">·</span>
            <span>{qualityLabel}</span>
          </>
        )}
        <span className="text-text-muted/80">·</span>
        <span>{size}</span>
        <ChevronDown className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={IMAGE_PARAM_POPOVER_CLASS}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          {showQuality && (
            <>
              <div className={IMAGE_PARAM_LABEL_CLASS}>{t('node.imageGen.param.quality')}</div>
              <div className={IMAGE_PARAM_ROW_CLASS}>
                {qualityOptions.map((value) => {
                  const label =
                    IMAGE_QUALITY_OPTIONS.find((option) => option.value === value)?.label ?? value;
                  const isActive = quality === value;
                  return (
                    <button
                      key={value}
                      type="button"
                      onClick={() => onChange({ quality: value })}
                      className={`${IMAGE_PARAM_BUTTON_BASE_CLASS} flex-1 ${
                        isActive
                          ? IMAGE_PARAM_ACTIVE_BUTTON_CLASS
                          : IMAGE_PARAM_IDLE_BUTTON_CLASS
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </>
          )}
          <div className={IMAGE_PARAM_LABEL_CLASS}>{t('node.imageGen.param.resolution')}</div>
          <div className={IMAGE_PARAM_ROW_CLASS}>
            {sizeOptions.map((option) => {
              const isActive = size === option;
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => onChange({ size: option as ImageSize })}
                  className={`${IMAGE_PARAM_BUTTON_BASE_CLASS} flex-1 ${
                    isActive
                      ? IMAGE_PARAM_ACTIVE_BUTTON_CLASS
                      : IMAGE_PARAM_IDLE_BUTTON_CLASS
                  }`}
                >
                  {option}
                </button>
              );
            })}
          </div>

          <div className={IMAGE_PARAM_LABEL_CLASS}>{t('node.imageGen.param.aspect')}</div>
          <div className="grid grid-cols-4 gap-2">
            {aspectOptions.map((option) => {
              const isActive = nearestAspect.value === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => onChange({ aspectRatio: option.value })}
                  className={`${IMAGE_PARAM_BUTTON_BASE_CLASS} ${
                    isActive
                      ? IMAGE_PARAM_ACTIVE_BUTTON_CLASS
                      : IMAGE_PARAM_IDLE_BUTTON_CLASS
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

interface StyleChipProps {
  selectedId: string | null;
  selectedLabel: string | null;
  onChange: (nextId: string | null) => void;
  onOpenChange?: (open: boolean) => void;
}

function StyleChip({ selectedId, selectedLabel, onChange, onOpenChange }: StyleChipProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    onOpenChange?.(isOpen);
  }, [isOpen, onOpenChange]);

  useEffect(() => {
    return () => onOpenChange?.(false);
  }, [onOpenChange]);

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

  const isActive = Boolean(selectedId);
  const label = isActive ? selectedLabel ?? t('canvasNodes.imageForm.style') : t('canvasNodes.imageForm.style');

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        title={isActive ? selectedLabel ?? undefined : t('canvasNodes.imageForm.style')}
        className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} max-w-[160px]`}
      >
        <Palette className={`${NODE_TEXT_CONTROL_ICON_CLASS} shrink-0`} />
        <span className="truncate">{label}</span>
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className="absolute top-full left-0 z-50 mt-2"
          onClick={(event) => event.stopPropagation()}
        >
          <StylePickerPopover
            selectedId={selectedId}
            onSelect={(nextId) => {
              onChange(nextId);
              setIsOpen(false);
            }}
            onClose={() => setIsOpen(false)}
          />
        </div>
      )}
    </div>
  );
}

interface CameraChipProps {
  selection: ImageGenCameraSelection | null;
  summary: string | null;
  onChange: (next: ImageGenCameraSelection | null) => void;
}

function CameraChip({ selection, summary, onChange }: CameraChipProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [popoverPosition, setPopoverPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);

  const syncPopoverPosition = useCallback(() => {
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const margin = 12;
    setPopoverPosition({
      left: Math.min(
        Math.max(margin, rect.left),
        window.innerWidth - CAMERA_PICKER_POPOVER_WIDTH - margin,
      ),
      top: Math.max(margin, rect.top - 8),
    });
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    syncPopoverPosition();
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    const onViewportChange = () => syncPopoverPosition();
    document.addEventListener('mousedown', onPointerDown, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [isOpen, syncPopoverPosition]);

  const isActive = Boolean(selection) && summary != null;
  const label = isActive && summary ? summary : t('node.imageGen.camera');

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        title={isActive ? summary ?? undefined : t('node.imageGen.camera')}
        className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} max-w-[220px]`}
      >
        <Camera className={`${NODE_TEXT_CONTROL_ICON_CLASS} shrink-0`} />
        <span className="truncate">{label}</span>
      </button>
      {isOpen && popoverPosition && createPortal(
        <div
          ref={popoverRef}
          className="fixed z-[10000]"
          style={{
            left: popoverPosition.left,
            top: popoverPosition.top,
            transform: 'translateY(-100%)',
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <CameraPickerPopover
            selection={selection}
            onConfirm={(next) => {
              onChange(next);
              setIsOpen(false);
            }}
            onClose={() => setIsOpen(false)}
          />
        </div>,
        document.body,
      )}
    </div>
  );
}

interface CountSelectProps {
  value: ImageGenCount;
  onChange: (value: ImageGenCount) => void;
}

function CountSelect({ value, onChange }: CountSelectProps) {
  const { t } = useTranslation();
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
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={NODE_TEXT_CONTROL_TRIGGER_CLASS}
      >
        <span>{t('node.imageGen.countValue', { count: value })}</span>
        <ChevronDown className="h-3 w-3 text-text-muted/90" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className={NODE_COUNT_POPOVER_CLASS}
        >
          {COUNT_OPTIONS.map((option) => {
            const isActive = option === value;
            return (
              <button
                key={option}
                type="button"
                onClick={() => {
                  onChange(option);
                  setIsOpen(false);
                }}
                className={`${NODE_COUNT_OPTION_BASE_CLASS} ${
                  isActive
                    ? IMAGE_PARAM_ACTIVE_BUTTON_CLASS
                    : 'text-text-muted/95 hover:bg-white/[0.11] hover:text-text-dark'
                }`}
              >
                {t('node.imageGen.countValue', { count: option })}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

export interface ImageGenerationFormProps {
  /**
   * Target node id: used only as the positioning identifier of buttons inside this component (NodeContextPromptPaletteButton)
   * and as the nodeId when calling useCanvasStore().updateNodeData; it reads no React Flow context.
   */
  nodeId: string;

  // ── Reference / style chips row ──
  styleTemplateId: string | null;
  selectedStyleLabel: string | null;
  /** Style popover toggle: the host (ImageGenNode) uses it to temporarily hide the history strip below, avoiding stacked layers. */
  onStylePickerOpenChange: (open: boolean) => void;
  onOpenAssetLibrary: () => void;
  upstreamTextContents: readonly UpstreamContent[];
  upstreamImageContents: readonly UpstreamContent[];
  onDetachUpstream: (sourceNodeId: string) => void;

  // ── Prompt editor ──
  // The prompt draft state and IME composition state are held by the host — the retry button of the "generation failed" banner on the node
  // needs to read the same prompt to judge whether it can be submitted, and moving the draft state into this component would make the two places mismatch.
  prompt: string;
  onPromptChange: (next: string) => void;
  onCompositionStart: () => void;
  onCompositionEnd: (next: string) => void;
  mentionCandidates: MentionCandidate[];
  /** Text concatenated from upstream; when non-empty the prompt placeholder copy differs. */
  upstreamTextJoined: string;

  // ── Params row ──
  modelId: string;
  aspectRatio: string;
  /**
   * The resolution/ratio/quality tiers are driven by the media catalog (#210): the host hook has already computed the selectable values and
   * the "snapped current value" per the selected model; this component only renders and no longer judges what a model supports.
   */
  size: string;
  sizeOptions: readonly string[];
  aspectOptions: ReadonlyArray<{ value: string; label: string }>;
  quality: ImageQuality;
  qualityOptions: readonly ImageQuality[];
  /** The "Quality" selector shows only when the media catalog declares qualityOptions. */
  showQuality: boolean;
  /** The custom parameter form declared by the selected model (MediaModelParameterChip). */
  modelParameters: MediaModelParameterDefinition[] | undefined;
  modelParams: Record<string, unknown> | undefined;
  modelParamsMode: string | undefined;
  /** The hint when the model caps the number of reference images and it is exceeded; null means fine. */
  selectedModelReferenceError: string | null;
  /** Per-item disabled reasons in the model dropdown (likewise the reference image cap). */
  getModelOptionDisabledReason: (model: ModelOption) => string | null;
  cameraSelection: ImageGenCameraSelection | null;
  cameraSummary: string | null;
  /** System nodes that auto-submit to the mainline hide "generation count" — the count is fixed at 1. */
  showCountSelect: boolean;
  count: ImageGenCount;
  isTranslatingPrompt: boolean;
  isGenerating: boolean;
  onTranslate: () => void;

  // ── Submit ──
  totalCreditCostDisplay: string | null;
  /** Paired with `totalCreditCostDisplay`: without it the promo label falls back to the generic "On sale". */
  creditPromotion: CreditPromotionDisplay | null;
  submitDisabled: boolean;
  onSubmit: () => void;

  /**
   * A pure layout adaptation slot (changes no field/behavior): by default `pr-10` is left on the right of the chips row for the host's
   * "enlarge" button overlaid at the top right (ImageNode's PanelExpandButton in ImageGenNode). The storyboard detail
   * has no such button; pass true to drop this margin, so the chips row does not lack a chunk out of thin air.
   */
  compact?: boolean;

  /**
   * An inline chip stuffed **inside the prompt input** at the very start of the body (the storyboard's feature chip). It is an
   * atomic node in the contenteditable: it takes no part in prompt serialization, but can be crossed by the caret like a character and
   * deleted by backspace (calling back `onPromptLeadingChipDelete` on deletion). The workflow's
   * ImageGenNode passes neither of these two props, and renders as before.
   */
  promptLeadingChip?: ReactNode;
  onPromptLeadingChipDelete?: () => void;

  /**
   * Override the prompt placeholder copy. The storyboard feature node uses it to write "what this feature will do with the current image" on the
   * same line after the chip (matching liblib), saving a separate explanatory line.
   */
  promptPlaceholder?: string;
}

/**
 * The **pure form content layer** of the image generation node: prompt input + reference/style chips + model selection +
 * params (ratio/quality/size/count) + translate button + compute cost + submit button. It contains no React Flow
 * dependency (no useReactFlow / useNodeId / NodeToolbar / useUpdateNodeInternals),
 * so it can sit in the floating panel below a canvas node (ImageGenNode + OperationPanelShell),
 * and also be stuffed into a standalone layout such as the storyboard detail.
 *
 * The panel's "collapse/enlarge" shell (OperationPanelShell), its absolute positioning on the canvas, and the
 * "generation failed" retry banner (reusing the same onSubmit/submitDisabled) are all the host's responsibility —
 * these are display logic tied to node geometry / selection state and do not belong to the form itself.
 */
export const ImageGenerationForm = memo((props: ImageGenerationFormProps) => {
  const { t } = useTranslation();
  const {
    nodeId,
    styleTemplateId,
    selectedStyleLabel,
    onStylePickerOpenChange,
    onOpenAssetLibrary,
    upstreamTextContents,
    upstreamImageContents,
    onDetachUpstream,
    prompt,
    onPromptChange,
    onCompositionStart,
    onCompositionEnd,
    mentionCandidates,
    upstreamTextJoined,
    modelId,
    aspectRatio,
    size,
    sizeOptions,
    aspectOptions,
    quality,
    qualityOptions,
    showQuality,
    modelParameters,
    modelParams,
    modelParamsMode,
    selectedModelReferenceError,
    getModelOptionDisabledReason,
    cameraSelection,
    cameraSummary,
    showCountSelect,
    count,
    isTranslatingPrompt,
    isGenerating,
    onTranslate,
    totalCreditCostDisplay,
    creditPromotion,
    submitDisabled,
    onSubmit,
    compact = false,
    promptLeadingChip = null,
    onPromptLeadingChipDelete,
    promptPlaceholder,
  } = props;

  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const promptEditorRef = useRef<PromptMentionEditorHandle>(null);

  // The popover and editor are both in the panel and the editor is always mounted, so insertion goes straight through the imperative API and the callback keeps a stable reference
  // (no need to depend on prompt, avoiding rebuilding the callback on every keystroke and re-rendering the palette button with it).
  const insertContextPaletteEntry = useCallback(
    (entry: ContextPromptPaletteEntry) => {
      promptEditorRef.current?.insertTextAtCursor(
        contextPromptPaletteInsertionText(entry),
      );
    },
    [],
  );

  // Hover preview state for the upstream image thumbnails in the reference row.
  // Mirrors the @-mention chip preview UX so users can peek a full-size image
  // without leaving the prompt editor.
  const [refHover, setRefHover] = useState<{ imageUrl: string; rect: DOMRect } | null>(null);
  const refPreviewStyle = useMemo(() => {
    if (!refHover) return null;
    const SIZE = 220;
    const left = Math.min(
      Math.max(8, refHover.rect.left),
      window.innerWidth - SIZE - 8,
    );
    const top = refHover.rect.top - SIZE - 8;
    return { left, top: Math.max(8, top), size: SIZE };
  }, [refHover]);

  return (
    <>
      <div
        className={`flex shrink-0 items-center gap-2 pl-3 pt-3 ${
          compact ? 'pr-3' : 'pr-10'
        }`}
      >
        <StyleChip
          selectedId={styleTemplateId}
          selectedLabel={selectedStyleLabel}
          onChange={(nextId) => updateNodeData(nodeId, { styleTemplateId: nextId })}
          onOpenChange={onStylePickerOpenChange}
        />
        <NodeContextPromptPaletteButton
          nodeId={nodeId}
          onInsert={insertContextPaletteEntry}
        />
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenAssetLibrary();
          }}
          className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/asset px-1.5`}
          title={t('node.imageGen.assetLibraryTitle')}
        >
          <Library className={`${NODE_TEXT_CONTROL_ICON_CLASS} group-hover/asset:text-text-dark`} />
          <span>{t('node.imageGen.assetLibrary')}</span>
        </button>
        {upstreamTextContents.map((content) => (
          <ReferenceTextChip
            key={content.nodeId}
            nodeId={content.nodeId}
            text={content.text ?? ''}
            sourceLabel={content.displayName ?? content.nodeType}
            onDetach={onDetachUpstream}
          />
        ))}
        {upstreamImageContents.length > 0 && (
          <div className="ml-3 flex shrink-0 items-center gap-1.5">
            {upstreamImageContents.map((content) => {
              const url = resolveImageDisplayUrl(content.imageUrl as string);
              return (
                <div
                  key={`upstream-image-${content.nodeId}`}
                  className={NODE_REFERENCE_MEDIA_CHIP_CLASS}
                  title={t('node.imageGen.fromUpstream', { name: content.displayName ?? content.nodeType })}
                  onMouseEnter={(event) => {
                    setRefHover({
                      imageUrl: url,
                      rect: event.currentTarget.getBoundingClientRect(),
                    });
                  }}
                  onMouseLeave={() => setRefHover(null)}
                >
                  <img
                    src={url}
                    alt=""
                    className="h-full w-full object-cover"
                    draggable={false}
                  />
                  {/* Per product requirements the frontend no longer shows numeric badges like "image N" — references are presented uniformly as
                      "Image", and the index exists only in the prompt (@image1) submitted to the backend. */}
                  <button
                    type="button"
                    title={t('node.imageGen.dropReference')}
                    className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
                    onMouseDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation();
                      setRefHover(null);
                      onDetachUpstream(content.nodeId);
                    }}
                  >
                    <X className="h-3 w-3" strokeWidth={2.5} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <PromptMentionEditor
        ref={promptEditorRef}
        value={prompt}
        onChange={onPromptChange}
        onCompositionStart={onCompositionStart}
        onCompositionEnd={onCompositionEnd}
        candidates={mentionCandidates}
        leadingChip={promptLeadingChip}
        onLeadingChipDelete={onPromptLeadingChipDelete}
        placeholder={
          promptPlaceholder
          ?? (upstreamTextJoined.length > 0
            ? t('node.imageGen.promptPlaceholderUpstream')
            : t('node.imageGen.promptPlaceholder'))
        }
        className={`nodrag nowheel min-h-0 w-full flex-1 overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent px-3 py-2 text-sm leading-6 text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS}`}
      />

      <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <ProviderModelPicker
            selectedModelId={modelId}
            // Switching models must clear modelParams: the param table is declared per model, and keys left over from the previous model
            // would be sent to the backend as is — at best ignored, at worst rejected as invalid params.
            onChange={(nextModelId) =>
              updateNodeData(nodeId, { model: nextModelId, modelParams: {} })
            }
            popoverPlacement="top"
            getOptionDisabledReason={getModelOptionDisabledReason}
          />
          <AspectSizeChip
            aspectRatio={aspectRatio}
            size={size}
            sizeOptions={sizeOptions}
            aspectOptions={aspectOptions}
            quality={quality}
            qualityOptions={qualityOptions}
            showQuality={showQuality}
            onChange={(patch) => updateNodeData(nodeId, patch)}
          />
          <MediaModelParameterChip
            parameters={modelParameters}
            values={modelParams}
            mode={modelParamsMode}
            onChange={(next) => updateNodeData(nodeId, { modelParams: next })}
          />
          <CameraChip
            selection={cameraSelection}
            summary={cameraSummary}
            onChange={(next) => updateNodeData(nodeId, { cameraSelection: next })}
          />
          {showCountSelect && (
            <CountSelect
              value={count}
              onChange={(nextCount) => updateNodeData(nodeId, { count: nextCount })}
            />
          )}
          <button
            type="button"
            title={t('node.imageGen.translatePrompt')}
            disabled={isTranslatingPrompt || isGenerating || prompt.trim().length === 0}
            onClick={(event) => {
              event.stopPropagation();
              onTranslate();
            }}
            className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
              isTranslatingPrompt
                ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS
                : ''
            }`}
          >
            {isTranslatingPrompt ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Languages className="h-4 w-4" />
            )}
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <CreditCostPill
            display={totalCreditCostDisplay}
            promotion={creditPromotion}
            disabled={submitDisabled}
            className={NODE_CREDIT_PILL_FLAT_CLASS}
          />
          <button
            type="button"
            disabled={submitDisabled}
            title={selectedModelReferenceError ?? t('node.imageGen.generate')}
            onClick={(event) => {
              event.stopPropagation();
              onSubmit();
            }}
            className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
              submitDisabled
                ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                : NODE_GENERATE_BUTTON_ENABLED_CLASS
            }`}
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </div>

      {refHover && refPreviewStyle
        && createPortal(
          <div
            className="pointer-events-none fixed z-[10001] overflow-hidden rounded-lg border border-white/15 bg-surface-dark/95 shadow-xl"
            style={{
              left: refPreviewStyle.left,
              top: refPreviewStyle.top,
              width: refPreviewStyle.size,
              height: refPreviewStyle.size,
            }}
          >
            <img
              src={refHover.imageUrl}
              alt=""
              className="h-full w-full object-cover"
              draggable={false}
            />
          </div>,
          document.body,
        )}
    </>
  );
});

ImageGenerationForm.displayName = 'ImageGenerationForm';

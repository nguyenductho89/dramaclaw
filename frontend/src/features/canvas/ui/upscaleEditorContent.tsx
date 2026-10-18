// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';
import { ArrowUp, Check, ChevronDown, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { type FreezoneUpscaleScaleFactor } from '@/api/ops';
import {
  DEFAULT_UPSCALE_IMAGE_SIZE,
  DEFAULT_UPSCALE_SCALE_FACTOR,
  submitImageUpscale,
  UPSCALE_IMAGE_SIZES,
  UPSCALE_SCALE_FACTORS,
  type UpscaleImageSize,
} from '@/features/canvas/application/imageUpscale';
import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useFreezoneImageModels } from '@/features/canvas/hooks/useFreezoneImageModels';
import {
  DEFAULT_SHARED_MODEL_ID,
  ProviderModelPicker,
  SHARED_MODELS,
} from '@/features/canvas/ui/ProviderModelPicker';
import { useCanvasStore } from '@/stores/canvasStore';

/**
 * The **shell-agnostic** content layer of the "Upscale" editor: state machine + that configuration card.
 *
 * The reason for extracting it is the same as rotateEditorContent: one interaction has to be mounted on two shells - the workflow stuffs it into
 * the `ReactFlowNodeToolbar` below the node (UpscaleEditorOverlay), while the storyboard mounts it below the detail
 * panel's media area as the generation form (AssetBoardUpscaleForm). Both sides share the hook and card here,
 * so parameter meanings and submission semantics do not each grow their own way.
 *
 * The card **does not show compute cost** (user decision): the live price query here goes through the image_selection basis,
 * which never matches an upscale task, and reporting a mismatched number is worse than reporting none. useGenerationCreditCost is also
 * removed along with it, saving a request nobody looks at.
 *
 * The configuration is **persisted on node data** (upscaleModelId / upscaleImageSize /
 * upscaleScaleFactor), not component-local state - the panel mounts and unmounts repeatedly with selection/detail switching, and if it lived
 * in the component the parameters would be lost after switching away and back.
 */

interface UpscalePersistedFields {
  upscaleSourceUrl?: string;
  upscaleModelId?: string;
  upscaleImageSize?: UpscaleImageSize;
  upscaleScaleFactor?: FreezoneUpscaleScaleFactor;
}

export interface UpscaleEditorController {
  modelId: string;
  imageSize: UpscaleImageSize;
  scaleFactor: FreezoneUpscaleScaleFactor;
  isSubmitting: boolean;
  onModelChange: (modelId: string) => void;
  onImageSizeChange: (size: UpscaleImageSize) => void;
  onScaleFactorChange: (factor: FreezoneUpscaleScaleFactor) => void;
  /** When not provided, the card does not render "Cancel" (the storyboard detail uses the header's back/delete and does not need this one). */
  onCancel?: () => void;
  onSubmit: () => void;
}

export interface UseUpscaleEditorOptions {
  /** The upscale result node (the exportImage placeholder node with resultKind:'upscale'). */
  node: CanvasNode;
  /**
   * How "Cancel" lands is given by the shell: the workflow deletes the node + deselects; the storyboard detail gives no cancel
   * (just do not pass it, and that button on the card disappears accordingly).
   */
  onCancel?: () => void;
}

export function useUpscaleEditor({ node, onCancel }: UseUpscaleEditorOptions): UpscaleEditorController {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);

  const persisted = node.data as UpscalePersistedFields;
  const sourceUrl = persisted.upscaleSourceUrl ?? '';
  const modelId =
    typeof persisted.upscaleModelId === 'string' ? persisted.upscaleModelId : DEFAULT_SHARED_MODEL_ID;
  const imageSize: UpscaleImageSize =
    persisted.upscaleImageSize && (UPSCALE_IMAGE_SIZES as readonly string[]).includes(persisted.upscaleImageSize)
      ? persisted.upscaleImageSize
      : DEFAULT_UPSCALE_IMAGE_SIZE;
  const scaleFactor: FreezoneUpscaleScaleFactor =
    persisted.upscaleScaleFactor === 4 || persisted.upscaleScaleFactor === 6
      ? persisted.upscaleScaleFactor
      : DEFAULT_UPSCALE_SCALE_FACTOR;

  const [isSubmitting, setIsSubmitting] = useState(false);
  const { models: availableModels } = useFreezoneImageModels();
  const selectedModel =
    availableModels.find((m) => m.id === modelId)
    ?? availableModels[0]
    ?? SHARED_MODELS.find((m) => m.id === modelId);

  const onModelChange = useCallback(
    (next: string) => updateNodeData(node.id, { upscaleModelId: next }),
    [node.id, updateNodeData],
  );
  const onImageSizeChange = useCallback(
    (next: UpscaleImageSize) => updateNodeData(node.id, { upscaleImageSize: next }),
    [node.id, updateNodeData],
  );
  const onScaleFactorChange = useCallback(
    (next: FreezoneUpscaleScaleFactor) => updateNodeData(node.id, { upscaleScaleFactor: next }),
    [node.id, updateNodeData],
  );

  const onSubmit = useCallback(() => {
    if (isSubmitting) return;
    const completion = submitImageUpscale(node.id, {
      sourceUrl,
      scaleFactor,
      imageSize,
      model: selectedModel?.apiModel ?? modelId,
    });
    if (!completion) return;
    setIsSubmitting(true);
    void completion.finally(() => setIsSubmitting(false));
  }, [imageSize, isSubmitting, modelId, node.id, scaleFactor, selectedModel, sourceUrl]);

  return {
    modelId,
    imageSize,
    scaleFactor,
    isSubmitting,
    onModelChange,
    onImageSizeChange,
    onScaleFactorChange,
    onCancel,
    onSubmit,
  };
}

/**
 * Upscale configuration card: title (+ optional cancel) · model selection · quality · scale factor · up button submit.
 *
 * @param className the root node class given by the shell (the workflow is a `w-[400px] p-4` floating card, the storyboard is a form container
 *   filling the detail panel), with the content and row structure exactly the same on both sides.
 */
export function UpscaleEditorPanel({
  controller,
  className,
}: {
  controller: UpscaleEditorController;
  className?: string;
}): ReactElement {
  const { t } = useTranslation();

  return (
    <div className={className} onClick={(event) => event.stopPropagation()}>
      <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2.5">
        <div className="text-sm font-semibold text-text-dark">{t('upscaleEditor.title')}</div>
        {controller.onCancel && (
          <button
            type="button"
            className="text-xs text-text-muted transition-colors hover:text-text-dark"
            onClick={controller.onCancel}
            title={t('upscaleEditor.cancel')}
          >
            {t('common.cancel')}
          </button>
        )}
      </div>

      <div className="space-y-3">
        <PanelRow label={t('upscaleEditor.providerLabel')}>
          <ProviderModelPicker
            selectedModelId={controller.modelId}
            onChange={controller.onModelChange}
          />
        </PanelRow>

        <PanelRow label={t('upscaleEditor.qualityLabel')}>
          <QualityPicker value={controller.imageSize} onChange={controller.onImageSizeChange} />
        </PanelRow>

        <PanelRow label={t('upscaleEditor.scaleLabel')}>
          <ScaleFactorPicker
            value={controller.scaleFactor}
            onChange={controller.onScaleFactorChange}
          />
        </PanelRow>
      </div>

      {/* Only the submit key remains - the compute pill was removed at the user's request. */}
      <div className="mt-4 flex items-center justify-end border-t border-white/10 pt-3">
        <button
          type="button"
          onClick={controller.onSubmit}
          disabled={controller.isSubmitting}
          className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-bg-dark transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          title={t('upscaleEditor.submit')}
          aria-label={t('upscaleEditor.submit')}
        >
          <ArrowUp className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}

function PanelRow({ label, children }: { label: string; children: ReactNode }): ReactElement {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-text-muted">{label}</span>
      {children}
    </div>
  );
}

function QualityPicker({
  value,
  onChange,
}: {
  value: UpscaleImageSize;
  onChange: (value: UpscaleImageSize) => void;
}): ReactElement {
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

  const title = t('upscaleEditor.qualityPicker.title');

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-xs text-text-dark transition-colors hover:bg-white/[0.08]"
      >
        <Sparkles className="h-3.5 w-3.5 text-text-muted" />
        <span className="font-medium">{title}</span>
        <span className="text-text-muted">·</span>
        <span className="text-text-muted">{value}</span>
        <ChevronDown className="h-3 w-3 text-text-muted" />
      </button>
      {isOpen && (
        <div
          ref={popoverRef}
          className="absolute bottom-full right-0 z-50 mb-2 w-[240px] rounded-xl border border-white/10 bg-surface-dark/95 p-3 shadow-2xl backdrop-blur-md"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="mb-1 text-[11px] uppercase tracking-wide text-text-muted">{title}</div>
          <div className="flex gap-1.5">
            {UPSCALE_IMAGE_SIZES.map((size) => {
              const isActive = value === size;
              return (
                <button
                  key={size}
                  type="button"
                  onClick={() => {
                    onChange(size);
                    setIsOpen(false);
                  }}
                  className={`inline-flex h-8 flex-1 items-center justify-center gap-1 rounded-full px-3 text-xs font-medium transition-colors ${
                    isActive
                      ? 'bg-[rgb(var(--accent-rgb))] text-white'
                      : 'bg-white/[0.06] text-text-dark hover:bg-white/[0.12]'
                  }`}
                >
                  {isActive && <Check className="h-3 w-3" />}
                  {size}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function ScaleFactorPicker({
  value,
  onChange,
}: {
  value: FreezoneUpscaleScaleFactor;
  onChange: (next: FreezoneUpscaleScaleFactor) => void;
}): ReactElement {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] p-0.5">
      {UPSCALE_SCALE_FACTORS.map((factor) => {
        const isActive = value === factor;
        return (
          <button
            key={factor}
            type="button"
            onClick={() => onChange(factor)}
            className={`flex h-7 w-12 items-center justify-center rounded-md text-xs font-medium transition-colors ${
              isActive
                ? 'bg-white text-bg-dark'
                : 'text-text-muted hover:bg-white/[0.06] hover:text-text-dark'
            }`}
          >
            {factor}
          </button>
        );
      })}
    </div>
  );
}

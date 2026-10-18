// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';
import { ArrowUp, Check, ChevronDown, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  fetchFreezoneJobResult,
  submitFreezoneUpscale,
  type FreezoneUpscaleScaleFactor,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { notifyTaskStillRunning } from '@/features/canvas/application/errorDialog';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { GENERATION_ERROR_CLEARED_PATCH } from '@/features/canvas/application/generationTaskArbitration';
import { readUrl } from '@/lib/url-params';
import {
  DEFAULT_SHARED_MODEL_ID,
  ProviderModelPicker,
} from '@/features/canvas/ui/ProviderModelPicker';
import {
  isAuthoritativeEmptyCatalog,
  useFreezoneImageModels,
} from '@/features/canvas/hooks/useFreezoneImageModels';
import { CreditCostPill } from '@/components/credits/credit-visual';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { BillingRuleNotConfiguredError } from '@/lib/api-errors';
import { FREEZONE_IMAGE_FEATURES } from '@/features/canvas/application/freezoneImageFeatureBilling';
import { buildImageFeatureBillingParams } from '@/features/canvas/domain/imageBilling';
import {
  pickAllowedOption,
  resolveModelQualityOptions,
  resolveModelSizeOptions,
} from '@/features/canvas/domain/mediaModelOptions';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { CANVAS_NODE_TOOLBAR_CARD_CLASS } from './nodeFrameStyles';
import { NODE_CREDIT_PILL_FLAT_CLASS } from './nodeControlStyles';
import { ZoomScaledToolbar } from './ZoomScaledToolbar';

const SCALE_FACTORS: FreezoneUpscaleScaleFactor[] = [2, 4, 6];
const DEFAULT_UPSCALE_SCALE_FACTOR: FreezoneUpscaleScaleFactor = 2;

interface UpscalePersistedFields {
  upscaleSourceUrl?: string;
  upscaleModelId?: string;
  upscaleImageSize?: string;
  upscaleScaleFactor?: FreezoneUpscaleScaleFactor;
}

interface UpscaleEditorOverlayProps {
  /**
   * The upscale-result ExportImage node. The panel is always anchored beneath it
   * while the node is selected — settings are persisted on `node.data` so they
   * survive re-selection.
   */
  node: CanvasNode;
}

export const UpscaleEditorOverlay = memo(({ node }: UpscaleEditorOverlayProps) => {
  const { t } = useTranslation();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);

  const persisted = node.data as UpscalePersistedFields;
  const sourceUrl = persisted.upscaleSourceUrl ?? '';
  const persistedModelId =
    typeof persisted.upscaleModelId === 'string' ? persisted.upscaleModelId : DEFAULT_SHARED_MODEL_ID;
  const imageCatalog = useFreezoneImageModels();
  const availableModels = imageCatalog.models;
  // Submission is forbidden when the backend has really configured not a single image model: the backend `_resolve_catalog_request`
  // returns 409 straight away for an empty catalog, and making the user click once only to receive an error is the worst experience.
  const catalogIsEmpty = isAuthoritativeEmptyCatalog(imageCatalog);
  const persistedScaleFactor: FreezoneUpscaleScaleFactor =
    persisted.upscaleScaleFactor === 4 || persisted.upscaleScaleFactor === 6
      ? persisted.upscaleScaleFactor
      : DEFAULT_UPSCALE_SCALE_FACTOR;

  const [isSubmitting, setIsSubmitting] = useState(false);
  // When the catalog is empty, deliberately leave selectedModel undefined. There used to be a trailing
  // `?? SHARED_MODELS.find(...)` here, which revives the frontend hard-coded model as an available one -
  // exactly the source of "the backend configured no model yet the UI still looks usable".
  const selectedModel =
    availableModels.find((m) => m.id === persistedModelId) ?? availableModels[0];
  // Resolution and quality tiers come from the backend's config for that model; if an old value stored on the node is no longer among the tiers,
  // it is pulled back to the first available tier.
  const sizeOptions = useMemo(
    () => resolveModelSizeOptions(selectedModel),
    [selectedModel],
  );
  const qualityOptions = useMemo(
    () => resolveModelQualityOptions(selectedModel),
    [selectedModel],
  );
  const persistedImageSize = pickAllowedOption(persisted.upscaleImageSize, sizeOptions);
  const creditCost = useGenerationCreditCost(
    'feature',
    selectedModel ? FREEZONE_IMAGE_FEATURES.edit : null,
    {
      surface: 'canvas',
      params: buildImageFeatureBillingParams(selectedModel, {
        size: persistedImageSize,
        ...(qualityOptions.length > 0
          ? { quality: pickAllowedOption('medium', qualityOptions) }
          : {}),
        operation: 'upscale',
      }),
    },
  );
  const billingRuleMissing =
    creditCost.error instanceof BillingRuleNotConfiguredError;
  const submitDisabled = isSubmitting || billingRuleMissing || catalogIsEmpty;
  const costDisplay =
    creditCost.data?.data.display ??
    (billingRuleMissing ? t('common.billingRuleNotConfiguredShort') : null);

  const handleModelChange = useCallback(
    (modelId: string) => {
      updateNodeData(node.id, { upscaleModelId: modelId });
    },
    [node.id, updateNodeData],
  );

  const handleImageSizeChange = useCallback(
    (size: string) => {
      updateNodeData(node.id, { upscaleImageSize: size });
    },
    [node.id, updateNodeData],
  );

  const handleScaleFactorChange = useCallback(
    (factor: FreezoneUpscaleScaleFactor) => {
      updateNodeData(node.id, { upscaleScaleFactor: factor });
    },
    [node.id, updateNodeData],
  );

  const handleCancel = useCallback(() => {
    deleteNode(node.id);
    setSelectedNode(null);
  }, [deleteNode, node.id, setSelectedNode]);

  const handleSubmit = useCallback(async () => {
    // The button is already disabled, so block once more here: with no available model a request must never be sent.
    if (isSubmitting || catalogIsEmpty) return;
    if (!sourceUrl) {
      console.error('[upscale] missing upscaleSourceUrl on node.data — cannot submit');
      return;
    }
    const project = readUrl().project;
    if (!project) {
      console.error('[upscale] no project in URL — cannot submit');
      return;
    }

    const apiModel =
      selectedModel?.apiModel
      ?? persistedModelId;

    setIsSubmitting(true);
    const generationStartedAt = Date.now();
    // Upscale is the only editor that rewrites the source node in place (the other three build result nodes), so here
    // the three fields of the last failure must be cleared together, otherwise the old request ID would still hang on the node when a new round starts.
    updateNodeData(node.id, {
      isGenerating: true,
      generationStartedAt,
      ...GENERATION_ERROR_CLEARED_PATCH,
    });

    try {
      const ref = await submitFreezoneUpscale(project, {
        sourceUrl: sourceUrl.split('?')[0],
        scaleFactor: persistedScaleFactor,
        imageSize: persistedImageSize,
        model: apiModel,
      });
      updateNodeData(node.id, generationTaskDescriptor(ref));
      const completed = await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
      const directUrl = completed.result?.['output_url'] as string | undefined;
      let url = directUrl;
      if (!url) {
        const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
        url = fallback.url;
      }
      updateNodeData(node.id, {
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
      console.error('[upscale] generation failed', err);
      updateNodeData(node.id, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
      });
    } finally {
      setIsSubmitting(false);
    }
  }, [
    catalogIsEmpty,
    isSubmitting,
    node.id,
    persistedImageSize,
    persistedModelId,
    persistedScaleFactor,
    selectedModel,
    sourceUrl,
    t,
    updateNodeData,
  ]);

  return (
    <ReactFlowNodeToolbar
      nodeId={node.id}
      isVisible
      position={Position.Bottom}
      align="center"
      offset={12}
      className={NODE_TOOLBAR_CLASS}
    >
      {/* The operation area scales in sync with the canvas zoom: the panel hangs below the node, anchored at the top edge (hugging the node's bottom edge),
      when the canvas is zoomed out the panel shrinks toward the node, visually shrinking in proportion with the node. */}
      <ZoomScaledToolbar origin="top center">
        <div
          className={`w-[400px] p-4 ${CANVAS_NODE_TOOLBAR_CARD_CLASS}`}
          onClick={(event) => event.stopPropagation()}
        >
        <div className="mb-3 flex items-center justify-between border-b border-white/10 pb-2.5">
          <div className="text-sm font-semibold text-text-dark">
            {t('upscaleEditor.title')}
          </div>
          <button
            type="button"
            className="text-xs text-text-muted transition-colors hover:text-text-dark"
            onClick={handleCancel}
            title={t('upscaleEditor.cancel')}
          >
            {t('common.cancel')}
          </button>
        </div>

        <div className="space-y-3">
          <PanelRow label={t('upscaleEditor.providerLabel')}>
            <ProviderModelPicker
              selectedModelId={persistedModelId}
              onChange={handleModelChange}
            />
          </PanelRow>

          <PanelRow label={t('upscaleEditor.qualityLabel')}>
            <QualityPicker
              value={persistedImageSize}
              options={sizeOptions}
              onChange={handleImageSizeChange}
            />
          </PanelRow>

          <PanelRow label={t('upscaleEditor.scaleLabel')}>
            <ScaleFactorPicker value={persistedScaleFactor} onChange={handleScaleFactorChange} />
          </PanelRow>
        </div>

        <div className="mt-4 flex items-center justify-end gap-3 border-t border-white/10 pt-3">
          <CreditCostPill
            display={costDisplay}
            promotion={creditCost.data?.data.promotion}
            className={NODE_CREDIT_PILL_FLAT_CLASS}
          />
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitDisabled}
            className="flex h-8 w-8 items-center justify-center rounded-full bg-white text-bg-dark transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
            title={
              catalogIsEmpty
                ? t('modelParams.noModelsAvailable')
                : t('upscaleEditor.submit')
            }
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
        </div>
      </ZoomScaledToolbar>
    </ReactFlowNodeToolbar>
  );
});

UpscaleEditorOverlay.displayName = 'UpscaleEditorOverlay';

function PanelRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="text-xs text-text-muted">{label}</span>
      {children}
    </div>
  );
}

interface QualityPickerProps {
  value: string;
  /** The resolution tiers the current model allows, delivered by the backend "media models" config. */
  options: readonly string[];
  onChange: (value: string) => void;
}

function QualityPicker({ value, options, onChange }: QualityPickerProps) {
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
            {options.map((size) => {
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

interface ScaleFactorPickerProps {
  value: FreezoneUpscaleScaleFactor;
  onChange: (next: FreezoneUpscaleScaleFactor) => void;
}

function ScaleFactorPicker({ value, onChange }: ScaleFactorPickerProps) {
  return (
    <div className="inline-flex items-center gap-1 rounded-lg border border-white/10 bg-white/[0.04] p-0.5">
      {SCALE_FACTORS.map((factor) => {
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

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useMemo } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position } from '@xyflow/react';
import { ArrowUp, Image as ImageIcon, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { resolveFixedFeatureModelRequest } from '@/features/canvas/domain/fixedFeatureModelRequest';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  fetchFreezoneJobResult,
  submitFreezoneTemplateEdit,
  type FreezoneTemplateEditMode,
} from '@/api/ops';
import { CreditCostInline } from '@/components/credit-cost-inline';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { notifyTaskStillRunning } from '@/features/canvas/application/errorDialog';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import {
  isAuthoritativeEmptyCatalog,
  useFreezoneImageModels,
} from '@/features/canvas/hooks/useFreezoneImageModels';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { BillingRuleNotConfiguredError } from '@/lib/api-errors';
import { readUrl } from '@/lib/url-params';
import { FREEZONE_IMAGE_FEATURES } from '@/features/canvas/application/freezoneImageFeatureBilling';
import { NODE_TOOLBAR_CLASS } from './nodeToolbarConfig';
import { CANVAS_NODE_TOOLBAR_PILL_CLASS } from './nodeFrameStyles';

export type GridActionKey =
  | 'multiCameraGrid'
  | 'plotFourGrid'
  | 'faceThreeView'
  | 'productThreeView'
  | 'serialStoryboard25'
  | 'cinematicLightCorrection'
  | 'characterThreeView'
  | 'frameProjection3sLater'
  | 'frameProjection5sEarlier';

const GRID_ACTION_MODE_MAP: Record<GridActionKey, FreezoneTemplateEditMode> = {
  multiCameraGrid: 'multi_camera_nine_grid',
  plotFourGrid: 'story_pitch_four_grid',
  faceThreeView: 'character_face_three_view',
  productThreeView: 'product_three_view',
  serialStoryboard25: 'storyboard_25_grid',
  cinematicLightCorrection: 'cinematic_light_correction',
  characterThreeView: 'character_three_view_generation',
  frameProjection3sLater: 'image_projection_after_3s',
  frameProjection5sEarlier: 'image_projection_before_5s',
};

export interface GridActionRequest {
  nodeId: string;
  key: GridActionKey;
  label: string;
  prompt: string;
  cost: number;
}

export interface GridActionSubmitPayload {
  sourceNodeId: string;
  imageSource: string;
  actionKey: GridActionKey;
  label: string;
  prompt: string;
  cost: number;
  generationMode: 'image_reference';
  requestAspectRatio: 'auto';
  submittedAt: string;
}

interface GridActionConfirmOverlayProps {
  node: CanvasNode;
  imageSource: string;
  request: GridActionRequest;
  onClose: () => void;
}

export const GridActionConfirmOverlay = memo(
  ({ node, imageSource, request, onClose }: GridActionConfirmOverlayProps) => {
    const { t } = useTranslation();
    const addNode = useCanvasStore((state) => state.addNode);
    const addEdge = useCanvasStore((state) => state.addEdge);
    const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
    const findNodePosition = useCanvasStore((state) => state.findNodePosition);
    const updateNodeData = useCanvasStore((state) => state.updateNodeData);
    const imageCatalog = useFreezoneImageModels();
    const imageModels = imageCatalog.models;
    const selectedModel = imageModels[0];
    // Submission is forbidden when the backend has really configured not a single image model: this panel has no model selector, and once submitted
    // the backend cannot get a catalog entry and returns 409 outright; making the user click once before reporting an error is the worst experience.
    const catalogIsEmpty = isAuthoritativeEmptyCatalog(imageCatalog);
    const gridMode = GRID_ACTION_MODE_MAP[request.key];
    // Grid actions have no size/quality selector, taking defaults by the tiers the backend configures for that model. The quote and the submission
    // must come from the same resolution, see the note of `resolveFixedFeatureModelRequest`.
    const modelRequest = useMemo(
      () => resolveFixedFeatureModelRequest(selectedModel, { mode: gridMode }),
      [gridMode, selectedModel],
    );
    const gridActionCost = useGenerationCreditCost(
      'feature',
      selectedModel ? FREEZONE_IMAGE_FEATURES.grid : null,
      {
        surface: 'canvas',
        params: modelRequest.billingParams,
      },
    );
    const billingRuleMissing =
      gridActionCost.error instanceof BillingRuleNotConfiguredError;
    const submitDisabled = billingRuleMissing || catalogIsEmpty;
    const costDisplay =
      gridActionCost.data?.data.display ??
      (billingRuleMissing ? t('common.billingRuleNotConfiguredShort') : null);

    const handleSubmit = useCallback(async () => {
      // The button is already disabled, so block once more here: with no model a request must never be sent.
      if (catalogIsEmpty) return;
      const project = readUrl().project;
      if (!project) {
        console.error('[grid-action] no project in URL — cannot submit');
        return;
      }

      const sourceAspectRatio =
        typeof (node.data as { aspectRatio?: unknown }).aspectRatio === 'string'
          ? ((node.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
          : DEFAULT_ASPECT_RATIO;
      const position = findNodePosition(
        node.id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT
      );
      const generationStartedAt = Date.now();
      const nextNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        position,
        {
          displayName: request.label,
          imageUrl: null,
          previewImageUrl: null,
          aspectRatio: sourceAspectRatio,
          resultKind: 'generic',
          isGenerating: true,
          generationStartedAt,
        }
      );
      addEdge(node.id, nextNodeId);
      setSelectedNode(nextNodeId);
      onClose();

      try {
        const ref = await submitFreezoneTemplateEdit(project, {
          sourceUrl: imageSource.split('?')[0],
          mode: gridMode,
          prompt: request.label,
          ...modelRequest.submit,
        });
        updateNodeData(nextNodeId, generationTaskDescriptor(ref));
        const completed = await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
        const directUrl = completed.result?.['output_url'] as string | undefined;
        let url = directUrl;
        if (!url) {
          const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
          url = fallback.url;
        }
        updateNodeData(nextNodeId, {
          imageUrl: url,
          previewImageUrl: url,
          isGenerating: false,
          generationStartedAt: null,
          generationError: null,
        });
      } catch (err) {
        // A poll timeout != generation failure: the backend is still running and the task handle on the node can still be resumed.
        // Writing an error banner would mark a live task as failed and clear the handle.
        if (isTaskPollTimeoutError(err)) {
          notifyTaskStillRunning(t);
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        console.error('[grid-action] generation failed', err);
        updateNodeData(nextNodeId, {
          isGenerating: false,
          generationStartedAt: null,
          generationError: message,
        });
      }
    }, [
      addEdge,
      addNode,
      catalogIsEmpty,
      findNodePosition,
      gridMode,
      imageSource,
      modelRequest,
      node,
      onClose,
      request,
      setSelectedNode,
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
        <div
          className={`flex min-w-[420px] items-center gap-2 ${CANVAS_NODE_TOOLBAR_PILL_CLASS}`}
          onClick={(event) => event.stopPropagation()}
        >
          <button
            type="button"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-dark/70 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark"
            onClick={onClose}
            title={t('nodeToolbar.gridMenu.confirmBar.close')}
          >
            <X className="h-4 w-4" />
          </button>

          <div className="flex min-w-0 flex-1 items-center gap-1.5 px-2 text-xs text-text-dark">
            <ImageIcon className="h-3.5 w-3.5 shrink-0 text-text-muted" />
            <span className="truncate font-medium">{request.label}</span>
          </div>
          <CreditCostInline
            display={costDisplay}
            promotion={gridActionCost.data?.data.promotion}
          />

          <button
            type="button"
            disabled={submitDisabled}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-white text-bg-dark transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:opacity-50"
            onClick={handleSubmit}
            title={
              catalogIsEmpty
                ? t('modelParams.noModelsAvailable')
                : t('nodeToolbar.gridMenu.confirmBar.submit')
            }
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </div>
      </ReactFlowNodeToolbar>
    );
  }
);

GridActionConfirmOverlay.displayName = 'GridActionConfirmOverlay';

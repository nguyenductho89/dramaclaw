// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneMultiView,
  type FreezoneMultiViewPreset,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
} from '@/features/canvas/domain/canvasNodes';
import { inheritMainlineFields } from '@/features/canvas/domain/inheritMainlineFields';
import type {
  MultiAnglePresetKey,
  MultiAngleSubmitPayload,
} from '@/features/canvas/ui/MultiAngleEditorPanel';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';
import { notifyTaskStillRunning } from './errorDialog';

/** Panel preset -> backend preset enum (the private mapping of the former MultiAngleEditorOverlay). */
const PRESET_MAP: Record<MultiAnglePresetKey, FreezoneMultiViewPreset> = {
  custom: 'custom',
  fisheye: 'fisheye',
  tilted: 'oblique',
  frontTopDown: 'front',
  frontBottomUp: 'front_up',
  panoramaTopDown: 'custom',
  backView: 'back',
};

function normalizeYaw(deg: number): number {
  let v = ((deg + 180) % 360) - 180;
  if (v <= -180) v += 360;
  return v;
}

export interface MultiAngleImageResult {
  /** The id of the newly built exportImage result node. */
  nodeId: string;
  /** Resolves when the background chain (submit -> poll -> backfill/write error) settles (never rejects). */
  completion: Promise<void>;
}

/**
 * Multi-dimension (multi-angle) generation orchestration (moved verbatim out of MultiAngleEditorOverlay.handleSubmit,
 * with zero semantic change): synchronously build an isGenerating exportImage result node downstream of the source node and connect an edge
 * (inheriting mainline fields via inheritMainlineFields - a 1->1 spawn, where the new node still represents another candidate of the same
 * canonical slot), then submit /freezone/multi-view -> wait for the task to complete ->
 * backfill the product url; on failure write the error to the result node.
 *
 * @param payload the submission payload of MultiAngleEditorPanel (preset / orbit angle / pitch angle /
 *   shot size / prompt / model / quality).
 * @returns the result node id + the background chain completion; null when project is missing or the source node no longer exists.
 */
export function multiAngleImage(
  sourceNodeId: string,
  imageSource: string,
  payload: MultiAngleSubmitPayload,
): MultiAngleImageResult | null {
  const project = readUrl().project;
  if (!project) {
    console.error('[multi-angle] no project in URL — cannot submit');
    return null;
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) {
    return null;
  }

  const sourceAspectRatio =
    typeof (node.data as { aspectRatio?: unknown }).aspectRatio === 'string'
      ? ((node.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
      : DEFAULT_ASPECT_RATIO;
  const position = store.findNodePosition(
    node.id,
    EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  );
  const generationStartedAt = Date.now();
  // 1→1 spawn from MultiAngleEditor (one camera angle at a time).
  // User-confirmed: even when this overlay spawns N candidates in
  // sequence, all of them inherit the same slot_target — Push lands
  // whichever one the user picks. inheritMainlineFields stamps
  // user_spawned: true and refuses preset_managed.
  const initialData = inheritMainlineFields(
    { data: node.data as Record<string, unknown> },
    {
      displayName: payload.displayName,
      imageUrl: null,
      previewImageUrl: null,
      aspectRatio: sourceAspectRatio,
      resultKind: 'generic',
      isGenerating: true,
      generationStartedAt,
      generationDurationMs: 60000,
    },
  );
  const nextNodeId = store.addNode(
    CANVAS_NODE_TYPES.exportImage,
    position,
    initialData as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(node.id, nextNodeId);

  const completion = (async () => {
    try {
      const ref = await submitFreezoneMultiView(project, {
        sourceUrl: imageSource.split('?')[0],
        preset: PRESET_MAP[payload.preset],
        yawDegrees: normalizeYaw(payload.horizontalDeg),
        pitchDegrees: payload.verticalDeg,
        shotSize: payload.zoom,
        prompt: payload.promptOverride ?? '',
        model: payload.apiModel,
        imageSize: payload.imageSize,
      });
      useCanvasStore.getState().updateNodeData(nextNodeId, generationTaskDescriptor(ref));
      const completed = await awaitTaskCompletion(ref.task_key, project, {
        taskType: ref.task_type,
      });
      const directUrl = completed.result?.['output_url'] as string | undefined;
      let url = directUrl;
      if (!url) {
        const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
        url = fallback.url;
      }
      useCanvasStore.getState().updateNodeData(nextNodeId, {
        imageUrl: url,
        previewImageUrl: url,
        isGenerating: false,
        generationStartedAt: null,
        generationError: null,
      });
    } catch (err) {
      if (isTaskPollTimeoutError(err)) {
        notifyTaskStillRunning();
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      console.error('[multi-angle] generation failed', err);
      useCanvasStore.getState().updateNodeData(nextNodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: message,
      });
    }
  })();

  return { nodeId: nextNodeId, completion };
}

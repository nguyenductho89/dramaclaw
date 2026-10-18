// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneJobResult,
  submitFreezoneOutpaint,
  type FreezoneOutpaintAspectRatio,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
} from '@/features/canvas/domain/canvasNodes';
import { inheritMainlineFields } from '@/features/canvas/domain/inheritMainlineFields';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { generationTaskDescriptor } from './resumeGeneration';

export const OUTPAINT_IMAGE_SIZES = ['1K', '2K', '4K'] as const;
export type OutpaintImageSize = (typeof OUTPAINT_IMAGE_SIZES)[number];

export const OUTPAINT_ASPECT_RATIOS: readonly FreezoneOutpaintAspectRatio[] = [
  'original',
  '1:1',
  '4:3',
  '3:4',
  '16:9',
  '9:16',
];

// Spacing by which multiple result nodes are staggered vertically when count > 1.
const RESULT_STACK_GAP = 24;

export interface OutpaintImageResult {
  /** The ids of the newly built exportImage result nodes (in vertical placement order when the count is N). */
  nodeIds: string[];
  /** Resolves when all single-image chains (submit -> poll -> backfill/write error) settle (never rejects). */
  completion: Promise<void>;
}

/**
 * Outpaint submission orchestration (moved verbatim out of OutpaintEditorOverlay.handleSubmit, with zero semantic change):
 * synchronously build N isGenerating exportImage result nodes downstream of the source node (staggered vertically) and connect edges
 * - the backend outpaint produces only 1 image at a time, so choosing N images launches N single-image requests, with each node polling /
 * backfilling / reporting errors independently. The result nodes inherit mainline fields via inheritMainlineFields (1->1 outpaint
 * semantics: the new node still represents another candidate of the same canonical slot).
 *
 * @returns the list of result node ids + the background chain completion; returns null when project is missing or the source node no longer exists
 *   (landing no state).
 */
export function outpaintImage(
  sourceNodeId: string,
  imageSource: string,
  opts: {
    displayName: string;
    targetAspectRatio: FreezoneOutpaintAspectRatio;
    imageSize: string;
    numImages: number;
    model: string;
  },
): OutpaintImageResult | null {
  const project = readUrl().project;
  if (!project) {
    console.error('[outpaint] no project in URL — cannot submit');
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
  const base = store.findNodePosition(
    node.id,
    EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  );

  const count = Math.max(1, opts.numImages);
  const nodeIds = Array.from({ length: count }, (_unused, i) => {
    const generationStartedAt = Date.now();
    // 1→1 outpaint: inherit source's mainline fields so the new node still
    // resolves to the same canonical slot at Push time. user_spawned: true
    // is stamped by inheritMainlineFields; preset_managed is never set.
    const initialData = inheritMainlineFields(
      { data: node.data as Record<string, unknown> },
      {
        displayName: opts.displayName,
        imageUrl: null,
        previewImageUrl: null,
        aspectRatio:
          opts.targetAspectRatio === 'original' ? sourceAspectRatio : opts.targetAspectRatio,
        resultKind: 'generic',
        isGenerating: true,
        generationStartedAt,
      },
    );
    const nextNodeId = store.addNode(
      CANVAS_NODE_TYPES.exportImage,
      {
        x: base.x,
        y: base.y + i * (EXPORT_RESULT_NODE_LAYOUT_HEIGHT + RESULT_STACK_GAP),
      },
      initialData as unknown as Parameters<typeof store.addNode>[2],
    );
    store.addEdge(node.id, nextNodeId);
    return nextNodeId;
  });

  const completion = Promise.allSettled(
    nodeIds.map((id) =>
      runOutpaintGeneration(project, id, {
        sourceUrl: imageSource,
        targetAspectRatio: opts.targetAspectRatio,
        imageSize: opts.imageSize,
        model: opts.model,
      }),
    ),
  ).then(() => undefined);

  return { nodeIds, completion };
}

/** Submit a single-image outpaint (num_images=1) for the already built node -> poll -> backfill. */
async function runOutpaintGeneration(
  project: string,
  nodeId: string,
  opts: {
    sourceUrl: string;
    targetAspectRatio: FreezoneOutpaintAspectRatio;
    imageSize: string;
    model: string;
  },
): Promise<void> {
  try {
    const ref = await submitFreezoneOutpaint(project, {
      sourceUrl: opts.sourceUrl.split('?')[0],
      targetAspectRatio: opts.targetAspectRatio,
      numImages: 1,
      imageSize: opts.imageSize,
      model: opts.model,
    });
    useCanvasStore.getState().updateNodeData(nodeId, generationTaskDescriptor(ref));
    const completed = await awaitTaskCompletion(ref.task_key, project);
    const directUrl = completed.result?.['output_url'] as string | undefined;
    let url = directUrl;
    if (!url) {
      const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
      url = fallback.url;
    }
    useCanvasStore.getState().updateNodeData(nodeId, {
      imageUrl: url,
      previewImageUrl: url,
      isGenerating: false,
      generationStartedAt: null,
      generationError: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[outpaint] generation failed', err);
    useCanvasStore.getState().updateNodeData(nodeId, {
      isGenerating: false,
      generationStartedAt: null,
      generationError: message,
    });
  }
}

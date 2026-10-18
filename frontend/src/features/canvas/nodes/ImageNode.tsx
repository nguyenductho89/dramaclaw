// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useEffect, useMemo, useState } from 'react';
import {
  Handle,
  Position,
  useStore,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { AlertTriangle, Image as ImageIcon, Sparkles } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_RESIZE_MIN_EDGE,
  type CanvasNodeType,
  type ExportImageNodeData,
  type ImageEditNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  aspectRatioFromImageDimensions,
  resolveMinEdgeFittedSize,
  resolveResizeMinConstraintsByAspect,
  shouldForceNaturalImageSize,
} from '@/features/canvas/application/imageNodeSizing';
import {
  nodeBodyImageMeasurement,
  nodeBodyImageSrc,
  nodeBodyRecordDescribesImage,
  planNaturalSizeRecordWrite,
  readNodeNaturalSize,
  resolveImageDisplayUrl,
  shouldUseOriginalImageByZoom,
  withImageCacheBust,
} from '@/features/canvas/application/imageData';
import {
  localizeNodeDisplayName,
} from '@/features/canvas/domain/nodeDisplay';
import { AddNodeToChatButton } from '@/features/canvas/ui/AddNodeToChatButton';
import { NodeHeader, NODE_HEADER_FLOATING_POSITION_CLASS } from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { DirectorControlBundleBadge } from '@/features/canvas/ui/DirectorControlBundleBadge';
import { CANVAS_NODE_PANEL_SURFACE_CLASS, canvasNodeFrameClass } from '@/features/canvas/ui/nodeFrameStyles';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import {
  CandidateBindingBadges,
  hasMainlineContexts,
} from '@/features/freezone/context/NodeContextBadges';
import { collectCandidateBindingsForNode } from '@/features/freezone/context/mainlineContext';
import { RegenerateButton } from '@/features/canvas/ui/RegenerateButton';
import {
  canRegenerateExportImageNode,
  regenerateExportImageNode,
} from '@/features/canvas/application/regenerateExportNode';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { useNaturalSizeRecordTrust } from '@/features/canvas/hooks/useNaturalSizeRecordTrust';
import { useNodeBodyVariantBudget } from '@/features/canvas/hooks/useNodeBodyVariantBudget';
import { useCanvasStore } from '@/stores/canvasStore';
import { useShallow } from 'zustand/react/shallow';

type ImageNodeProps = NodeProps & {
  id: string;
  data: ImageEditNodeData | ExportImageNodeData;
  selected?: boolean;
};

function resolveNodeDimension(value: number | undefined, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 1) {
    return Math.round(value);
  }
  return fallback;
}

export const ImageNode = memo(({ id, data, selected, type, width, height }: ImageNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeSize = useCanvasStore((state) => state.updateNodeSize);
  // Subscribe only to edges connected to this node (useShallow element-wise comparison), so dragging unrelated nodes does not trigger re-renders.
  const connectedEdges = useCanvasStore(
    useShallow((state) => state.edges.filter((edge) => edge.source === id || edge.target === id)),
  );
  // Subscribe only to the discrete boolean "should use the original image" (flipping at the zoom threshold) rather than the continuous zoom value —
  // during zooming this node re-renders only on the frame that crosses the threshold, not every frame.
  const preferOriginalImage = useStore((state) => shouldUseOriginalImageByZoom(state.transform[2]));
  const [now, setNow] = useState(() => Date.now());
  const isExportResultNode = type === CANVAS_NODE_TYPES.exportImage;
  const { isGenerating } = useNodeGenerationTaskState(data);
  const generationError =
    typeof (data as { generationError?: unknown }).generationError === 'string'
      ? ((data as { generationError?: string }).generationError ?? '').trim()
      : '';
  const hasGenerationError =
    isExportResultNode && !isGenerating && !data.imageUrl && generationError.length > 0;
  const generationErrorRequestId =
    typeof (data as { generationErrorRequestId?: unknown }).generationErrorRequestId === 'string' &&
    (data as { generationErrorRequestId?: string }).generationErrorRequestId
      ? (data as { generationErrorRequestId?: string }).generationErrorRequestId ?? ''
      : '';
  const generationStartedAt =
    typeof data.generationStartedAt === 'number' ? data.generationStartedAt : null;
  const generationDurationMs =
    typeof data.generationDurationMs === 'number' ? data.generationDurationMs : 60000;
  const resolvedAspectRatio = data.aspectRatio || DEFAULT_ASPECT_RATIO;
  const compactSize = resolveMinEdgeFittedSize(resolvedAspectRatio, {
    minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
    minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
  });
  const resizeConstraints = resolveResizeMinConstraintsByAspect(resolvedAspectRatio, {
    minWidth: EXPORT_RESULT_NODE_RESIZE_MIN_EDGE,
    minHeight: EXPORT_RESULT_NODE_RESIZE_MIN_EDGE,
  });
  const resizeMinWidth = resizeConstraints.minWidth;
  const resizeMinHeight = resizeConstraints.minHeight;
  const resolvedWidth = resolveNodeDimension(width, compactSize.width);
  const resolvedHeight = resolveNodeDimension(height, compactSize.height);
  // How many device pixels this cell needs, which decides which tier of copy to pick (an enlarged node goes all the way to the original).
  const bodyVariantBudget = useNodeBodyVariantBudget({
    width: resolvedWidth,
    height: resolvedHeight,
  });
  const resolvedTitle = useMemo(
    () => localizeNodeDisplayName(type as CanvasNodeType, data, t),
    [data, t, type]
  );
  const hasMainlineContext = hasMainlineContexts(
    (data as { mainline_context?: unknown }).mainline_context,
  );
  const candidateBindingRoles = useMemo(
    () => collectCandidateBindingsForNode(connectedEdges, id).map((binding) => binding.role),
    [connectedEdges, id],
  );

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  useEffect(() => {
    if (!isGenerating) {
      return;
    }

    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 120);

    return () => {
      window.clearInterval(timer);
    };
  }, [isGenerating]);

  const waitedMinutes = useMemo(() => {
    if (!isGenerating || generationStartedAt === null) {
      return 0;
    }

    const elapsed = Math.max(0, now - generationStartedAt);
    return Math.floor(elapsed / 60000);
  }, [generationStartedAt, isGenerating, now]);

  const waitingResultText = useMemo(() => {
    if (!isExportResultNode) {
      return t('node.imageNode.selectToEdit');
    }

    if (!isGenerating || waitedMinutes < 2) {
      return t('node.imageNode.waitingResult');
    }

    return t('node.imageNode.waitingResultDelayed', { minutes: waitedMinutes });
  }, [isExportResultNode, isGenerating, t, waitedMinutes]);

  // The recorded original pixel size; it decides whether the main image may be fed a downsampled copy, and is also the initial value of the badge.
  // It follows the reference of data (same cadence as imageSource below), avoiding a new object on every render.
  const recordedNaturalSize = useMemo(() => readNodeNaturalSize(data), [data]);

  // Which image the record belongs to. It only recognizes "image swapped", not zoom: when preferOriginalImage flips, the branch below
  // picks another field, but that is two ways of drawing the same node and must not count as an image swap.
  const recordSubject = useMemo(() => {
    const picked = data.previewImageUrl || data.imageUrl;
    if (!picked) return null;
    const committedAt = (data as { committed_at?: unknown }).committed_at;
    return `${picked}\u0000${typeof committedAt === 'string' ? committedAt : ''}`;
  }, [data]);

  const { distrusted, distrustRecord, trustAgain } = useNaturalSizeRecordTrust(recordSubject);

  const bodyImage = useMemo(() => {
    const picked = preferOriginalImage
      ? data.imageUrl || data.previewImageUrl
      : data.previewImageUrl || data.imageUrl;
    if (!picked) return null;
    const resolved = resolveImageDisplayUrl(
      withImageCacheBust(picked, (data as { committed_at?: unknown }).committed_at as string | undefined),
    );
    // The node body decodes the whole original into a box of a few hundred CSS px; the variant is enabled only when the real size is known
    // and the view is not zoomed in to the close-inspection tier; see the comment of nodeBodyImageSrc for details.
    return nodeBodyImageSrc(resolved, recordedNaturalSize, {
      preferOriginal: preferOriginalImage || distrusted,
      requiredEdge: bodyVariantBudget,
    });
  }, [
    bodyVariantBudget,
    data,
    data.imageUrl,
    data.previewImageUrl,
    distrusted,
    preferOriginalImage,
    recordedNaturalSize,
  ]);
  const imageSource = bodyImage?.src ?? null;

  // Get the original image URL for the viewer
  const originalImageUrl = useMemo(() => {
    if (!data.imageUrl) return null;
    return resolveImageDisplayUrl(data.imageUrl);
  }, [data.imageUrl]);

  // Natural pixel size of the displayed image, mirrored from data when present
  // (persisted by the onLoad handler below) and refreshed on every <img> load so
  // the resolution badge shows even for nodes whose size already matched (those
  // skip the persist branch). Drives a top-right resolution chip like the video node.
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(
    () => readNodeNaturalSize(data),
  );

  return (
    <div
      className={`
        group relative overflow-visible rounded-[var(--node-radius)] border ${CANVAS_NODE_PANEL_SURFACE_CLASS} p-0 transition-colors duration-150
        ${hasGenerationError
          ? (selected
            ? 'border-red-400 shadow-[0_0_0_1px_rgba(248,113,113,0.42)]'
            : 'border-red-500/70 bg-[rgba(127,29,29,0.12)] hover:border-red-400/80 dark:border-red-500/70 dark:hover:border-red-400/80')
          : canvasNodeFrameClass({ selected, mainline: hasMainlineContext })}
      `}
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={isExportResultNode
          ? <ImageIcon className="h-4 w-4" />
          : <Sparkles className="h-4 w-4" />}
        titleText={resolvedTitle}
        titleClassName="inline-block max-w-[220px] truncate whitespace-nowrap align-bottom"
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />
      <AddNodeToChatButton nodeId={id} />
      <CandidateBindingBadges roles={candidateBindingRoles} />

      {data.imageUrl && naturalSize ? (
        <div
          className="absolute -top-7 right-1 z-20 flex items-center gap-1 rounded-md border border-white/10 bg-black/55 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/70 backdrop-blur-sm"
          title={t('node.imageNode.resolution')}
        >
          <ImageIcon className="h-3 w-3 text-white/45" />
          {naturalSize.width}×{naturalSize.height}
        </div>
      ) : null}

      <div
        className={`relative h-full w-full overflow-hidden rounded-[var(--node-radius)] ${hasGenerationError ? 'bg-[rgba(127,29,29,0.2)]' : 'bg-bg-dark'}`}
      >
        <DirectorControlBundleBadge bundle={(data as { director_control_bundle?: unknown }).director_control_bundle} />
        {data.imageUrl ? (
          <CanvasNodeImage
            src={imageSource ?? ''}
            alt={isExportResultNode ? t('node.imageNode.resultAlt') : t('node.imageNode.generatedAlt')}
            viewerSourceUrl={originalImageUrl}
            onLoad={(event) => {
              // The record does not describe this image: the true source size cannot be measured on a downsampled copy. The first time, fall back to
              // re-measuring the original (preferOriginal makes the next round's downscaled false, so there is no flip-flopping);
              // if after one fallback it still does not match, write nothing — neither the record nor the copy is the
              // truth, and keeping the old value beats writing a definitely wrong size.
              if (
                bodyImage?.downscaled &&
                !nodeBodyRecordDescribesImage(
                  event.currentTarget,
                  recordedNaturalSize,
                  bodyImage.maxEdge ?? 0,
                )
              ) {
                distrustRecord();
                return;
              }
              // Whether what is loaded now is the image the record belongs to. The zoomed-in tier picks imageUrl, which may be
              // an entirely different image — rotate, relight and multi-angle all write results into previewImageUrl,
              // and the two need not share dimensions. Using it to correct the record replaces one wrong value with another.
              const measuringRecordSubject = !preferOriginalImage;
              // In the round that fell back only to correct the record, the true size is measured now: lift the distrust, and the next round
              // goes back to the copy. This image has been corrected already, the hook remembers it, and it will not fall back a second time.
              if (measuringRecordSubject) {
                trustAgain();
              }
              // When a downsampled copy is fed, naturalWidth on the element is the variant's size; use the real size in the record instead
              // — so the badge, ratio and auto size below are exactly the same as when the original is fed.
              const measured = bodyImage
                ? nodeBodyImageMeasurement(event.currentTarget, bodyImage, recordedNaturalSize)
                : { width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight };
              if (measured.width > 0 && measured.height > 0) {
                setNaturalSize((prev) =>
                  prev && prev.width === measured.width && prev.height === measured.height
                    ? prev
                    : { width: measured.width, height: measured.height },
                );
              }
              const forceNaturalSize = shouldForceNaturalImageSize(data as Record<string, unknown>);
              // The user dragged the size: the on-screen size is theirs. But the record belongs to the facts — this used to
              // return directly, so after an image swap the real size could never be written back, a remount read
              // the old record, and with a same-ratio swap the copy-validation layer could not recognize it either.
              const sizeLockedByUser = data.isSizeManuallyAdjusted === true && !forceNaturalSize;
              const nextAspectRatio = aspectRatioFromImageDimensions(
                measured.width,
                measured.height,
              );
              if (!nextAspectRatio) {
                return;
              }
              const nextSize = resolveMinEdgeFittedSize(nextAspectRatio, {
                minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
                minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
              });
              const displaySizeMismatch =
                Math.abs(resolvedWidth - nextSize.width) > 1 ||
                Math.abs(resolvedHeight - nextSize.height) > 1;
              // Write back when the record is empty or does not match the truth just measured — the ratio and display-size
              // conditions do not cover these (same-ratio image swaps, nodes that already fit in old projects). Which
              // count as user-undoable changes and which merely backfill facts, see planNaturalSizeRecordWrite.
              const recordWrite = planNaturalSizeRecordWrite({
                aspectRatioChanged: nextAspectRatio !== data.aspectRatio,
                displaySizeMismatch,
                record: recordedNaturalSize,
                measured,
                measuringRecordSubject,
                sizeLockedByUser,
              });
              if (!recordWrite.persist) {
                return;
              }
              // The "just backfill facts" category: touches neither the node size nor the ratio.
              if (!recordWrite.applySize) {
                updateNodeData(
                  id,
                  { imageNaturalWidth: measured.width, imageNaturalHeight: measured.height },
                  { recordHistory: false },
                );
                return;
              }
              updateNodeSize(id, nextSize, {
                lockManualSize: forceNaturalSize ? false : undefined,
                recordHistory: recordWrite.recordHistory,
                data: {
                  aspectRatio: nextAspectRatio,
                  imageNaturalWidth: measured.width,
                  imageNaturalHeight: measured.height,
                  imageAspectRatioUpdatedAt: Date.now(),
                },
              });
            }}
            className="h-full w-full object-contain"
          />
        ) : isGenerating ? (
          <div className="h-full w-full" />
        ) : hasGenerationError ? (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-red-300">
            <AlertTriangle className="h-7 w-7 opacity-90" />
            <span className="text-center text-[12px] font-medium leading-5 text-red-200">
              {t('node.imageNode.generationFailed')}
            </span>
            <span className="max-h-[88px] overflow-y-auto break-words text-center text-[11px] leading-5 text-red-200/90 [overflow-wrap:anywhere]">
              {generationError}
            </span>
            {generationErrorRequestId && (
              <div className="flex w-full max-w-[240px] items-center gap-1 rounded bg-red-500/10 px-2 py-1">
                <span className="shrink-0 text-[10px] text-red-300/70">{t('common.requestId')}</span>
                <code
                  className="min-w-0 flex-1 truncate font-mono text-[10px] text-red-200"
                  title={generationErrorRequestId}
                >
                  {generationErrorRequestId}
                </code>
              </div>
            )}
            {canRegenerateExportImageNode(data as Record<string, unknown>) && (
              <div className="mt-1">
                <RegenerateButton
                  onClick={() => void regenerateExportImageNode(id)}
                  busy={isGenerating}
                />
              </div>
            )}
          </div>
        ) : isGenerating ? (
          // While generating, keep only the NodeGenerationOverlay "mask + progress", and no longer render the placeholder
          // icon / waiting text, so they do not show through and overlap under the percentage into clutter.
          <div className="h-full w-full" />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-text-muted/85">
            {isExportResultNode ? (
              <ImageIcon className="h-7 w-7 opacity-60" />
            ) : (
              <Sparkles className="h-7 w-7 opacity-60" />
            )}
            <span className="px-4 text-center text-[12px] leading-6">
              {waitingResultText}
            </span>
          </div>
        )}

        {isGenerating && (
          <NodeGenerationOverlay
            startedAt={generationStartedAt}
            durationMs={generationDurationMs}
            hasBackground={Boolean(data.imageUrl)}
          />
        )}
      </div>

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
        minWidth={resizeMinWidth}
        minHeight={resizeMinHeight}
        maxWidth={1600}
        maxHeight={1600}
        keepAspectRatio
      />
    </div>
  );
});

ImageNode.displayName = 'ImageNode';

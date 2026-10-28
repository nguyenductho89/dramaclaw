// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import {
  AlertTriangle,
  ChevronDown,
  Copy,
  Download,
  Image as ImageIcon,
  Loader2,
  Upload,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { mediaStorageErrorMessage } from '@/lib/api-errors';

import {
  CANVAS_NODE_TYPES,
  type ImageGenNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  resolveImageDisplayUrl,
  withImageCacheBust,
} from '@/features/canvas/application/imageData';
import {
  aspectRatioFromImageDimensions,
  resolveMinEdgeFittedSize,
  shouldForceNaturalImageSize,
} from '@/features/canvas/application/imageNodeSizing';
import { localizeNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  mainlineNodeVisualState,
  nodeMainlineFlags,
} from '@/features/canvas/domain/mainlineNodeFlags';
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from '@/features/canvas/ui/NodeHeader';
import { AddNodeToChatButton } from '@/features/canvas/ui/AddNodeToChatButton';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { PanelExpandButton } from '@/features/canvas/ui/PanelExpandButton';
import {
  NODE_OPS_PANEL_ENTER_CLASS,
  OperationPanelShell,
} from '@/features/canvas/ui/OperationPanelShell';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import { CanvasNodeImage } from '@/features/canvas/ui/CanvasNodeImage';
import { useAlbumPendingTotal } from '@/features/canvas/nodes/shared/albumPendingTotals';
import { downloadUrlAsFile } from '@/lib/browserDownload';
import { useModelTaskAccess } from '@/lib/model-task-access';
import {
  CANVAS_NODE_INPUT_BODY_FRAME_CLASS,
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  CANVAS_NODE_OPS_PANEL_CLASS,
  CANVAS_NODE_PANEL_SURFACE_CLASS,
  canvasNodeFrameClass,
} from '@/features/canvas/ui/nodeFrameStyles';
import { useCanvasStore, useIsBoxSelecting } from '@/stores/canvasStore';
import { useShallow } from 'zustand/react/shallow';
import { getFreezoneCanvasMetadata } from '@/features/freezone/canvasMetadataContext';
import { uploadFreezoneImage } from '@/api/ops';
import {
  uploadAndAutoCommitSelectedBackgroundCandidate,
} from '@/features/canvas/application/selectedBackgroundSlot';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import {
  publishNodeActionAccepted,
  publishNodeActionError,
  publishNodeActionSuccess,
  subscribeNodeAction,
} from '@/features/canvas/application/nodeActionResult';
import { getBeatDirectorStageManifest } from '@/api/viewerManifests';
import { BackgroundCropperDialog } from '@/features/canvas/ui/BackgroundCropperDialog';
import {
  ThreeDDirectorDialog,
  type ThreeDDirectorCaptureMeta,
} from '@/features/viewer-kit/three-d/ThreeDDirectorDialog';
import type { DirectorStageManifest } from '@/features/viewer-kit/three-d/directorManifest';
import { readUrl } from '@/lib/url-params';
import { useNodeGenerationHistory } from '@/features/canvas/hooks/useNodeGenerationHistory';
import {
  AssetLibraryModal,
  type AssetLibrarySelection,
} from '@/features/canvas/ui/AssetLibraryModal';
import {
  NodeGenerationHistory,
  hasCompletedHistoryRecords,
  historyRecordOutputUrl,
} from '@/features/canvas/ui/NodeGenerationHistory';
import { CandidateBindingBadges } from '@/features/freezone/context/NodeContextBadges';
import {
  collectCandidateBindingsForNode,
} from '@/features/freezone/context/mainlineContext';
import { RegenerateButton } from '@/features/canvas/ui/RegenerateButton';
import {
  NODE_SIDE_ACTION_BUTTON_CLASS,
  NODE_SIDE_ACTION_ICON_CLASS,
  NodeSideActionRail,
} from '@/features/canvas/ui/NodeSideActionRail';
import { GENERATION_ERROR_CLEARED_PATCH } from '@/features/canvas/application/generationTaskArbitration';
import { ImageGenerationForm } from '@/features/canvas/nodes/shared/ImageGenerationForm';
import { spawnAssetLibraryReferences } from '@/features/canvas/nodes/shared/assetLibraryReferenceSpawn';
import { useImageGenerationForm } from '@/features/canvas/nodes/shared/useImageGenerationForm';
import { ReferenceValidationDialog } from '@/features/canvas/nodes/shared/ReferenceValidationDialog';
import { useImageOpFormProps } from '@/features/canvas/nodes/shared/useImageOpFormProps';

type ImageGenNodeProps = NodeProps & {
  id: string;
  data: ImageGenNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 580;
const DEFAULT_HEIGHT = 360;
const MIN_WIDTH = 480;
const MIN_HEIGHT = 260;
const MAX_WIDTH = 1100;
const MAX_HEIGHT = 1000;

// Panel height. Once the reference assets take their own row (48px thumbnail + gap), 232px leaves the prompt just two lines
// and a bit more; writing longer means scrolling in a narrow slot — raised to leave the prompt four or five lines.
const OPERATIONS_PANEL_HEIGHT = 288;
const OPERATIONS_PANEL_GAP = 12;
const OPERATIONS_PANEL_MIN_WIDTH = 720;
// Operations area size after "enlarge": a more comfortable height and width for the prompt editing area.
const OPERATIONS_PANEL_EXPANDED_HEIGHT = 560;
const OPERATIONS_PANEL_EXPANDED_MIN_WIDTH = 960;

const SELECTED_BACKGROUND_CROP_ASPECT_OPTIONS = ['2:3', '16:9'] as const;

export const ImageGenNode = memo(({ id, data, selected, width, height }: ImageGenNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const isBoxSelecting = useIsBoxSelecting();
  // When the top toolbar opens a secondary feature popover (panorama / multi-angle / lighting etc.), the popover expands its own
  // operations area below the node. Hide this node's bottom generate/history panel to give way to it, so the two
  // operations areas do not overlap.
  const hasActiveOverlay = useCanvasStore((state) => state.activeOverlayNodeId === id);
  const setActiveOverlayNodeId = useCanvasStore((state) => state.setActiveOverlayNodeId);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const updateNodeSize = useCanvasStore((state) => state.updateNodeSize);
  const addNodeAction = useCanvasStore((state) => state.addNode);
  const addEdgeAction = useCanvasStore((state) => state.addEdge);

  // Per-node generation history. Only fetch while the node is selected so an
  // unselected canvas full of nodes doesn't fan out a request each. `refresh`
  // is called after a generation settles to pull in the new record.
  const {
    records: historyRecords,
    isLoading: historyLoading,
    refresh: refreshHistory,
  } = useNodeGenerationHistory(id, { enabled: Boolean(selected) });

  // Prompt draft (including IME composition state), upstream text/images, @image1 numbering, model/params/compute cost,
  // translation and submission orchestration all live in this hook — it does not read the React Flow context and fetches data from
  // canvasStore by nodeId only, so the storyboard detail can mount the same form.
  const {
    formProps: imageGenerationFormProps,
    isGenerating,
    submitDisabled: formSubmitDisabled,
    submit: handleSubmit,
    canAutoCommitOnGenerate,
    referenceImageUrl,
    referenceErrors,
    referenceErrorsOpen,
    closeReferenceErrors,
    openReferenceErrors,
    invalidateInFlightGeneration,
  } = useImageGenerationForm(id, { onGenerationSettled: refreshHistory });

  // Feature node (the kind created after picking an item in the toolbar "nine-grid" dropdown): the input gets a switchable, deletable
  // feature chip, the feature description serves as the placeholder, and ↑ goes through the matching template. It shares the same hook with the storyboard detail,
  // so interaction in both views is identical; a plain image generation node gets null and renders as before.
  const opFormProps = useImageOpFormProps(id, { isGenerating });

  const rawGenerationError =
    typeof data.generationError === 'string' && data.generationError.length > 0
      ? data.generationError
      : null;
  const generationErrorDetails =
    typeof data.generationErrorDetails === 'string' && data.generationErrorDetails.length > 0
      ? data.generationErrorDetails
      : null;
  const generationError = rawGenerationError
    ? mediaStorageErrorMessage(generationErrorDetails || rawGenerationError, t)
      ?? rawGenerationError
    : null;
  const generationErrorRequestId =
    typeof data.generationErrorRequestId === 'string' && data.generationErrorRequestId.length > 0
      ? data.generationErrorRequestId
      : null;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [errorDetailsCopied, setErrorDetailsCopied] = useState(false);

  const handleCopyErrorDetails = useCallback(async () => {
    const copyText = generationErrorDetails || rawGenerationError || generationErrorRequestId;
    if (!copyText) return;
    try {
      await navigator.clipboard.writeText(copyText);
      setErrorDetailsCopied(true);
      window.setTimeout(() => setErrorDetailsCopied(false), 1200);
    } catch (error) {
      console.error('[image-gen] copy error details failed', error);
    }
  }, [rawGenerationError, generationErrorDetails, generationErrorRequestId]);

  // While generating, clicking a history record goes through a "non-destructive preview": it does not overwrite imageUrl or interrupt the in-flight
  // task, and only temporarily shows this history image on the body (see the isGenerating render branch). After the new image finishes,
  // the effect below clears it automatically, returning to the latest result. It is also cleared when history is restored in the non-generating state.
  const [historyPreviewUrl, setHistoryPreviewUrl] = useState<string | null>(null);

  const handleRestoreHistory = useCallback(
    (record: Parameters<typeof historyRecordOutputUrl>[0]) => {
      const url = historyRecordOutputUrl(record);
      if (!url) return;
      // While generating: only a non-destructive preview, never touching imageUrl and never interrupting the in-flight task.
      if (isGenerating) {
        setHistoryPreviewUrl(url);
        return;
      }
      setHistoryPreviewUrl(null);
      // The history image the user picked counts, and all requests of the previous batch still settling are voided — otherwise when they return they would
      // cover the image just restored.
      invalidateInFlightGeneration();
      updateNodeData(id, {
        imageUrl: url,
        previewImageUrl: url,
        isGenerating: false,
        generationStartedAt: null,
        // What is restored is a single history result; the old batch album is already detached from the main image (no cell would hit the
        // "main image" marker, and clicking an album cell would silently drop the image just restored) — clear it as well.
        generationBatch: null,
        // The node has switched to that successful image from history, so the previous failure banner must not keep covering it.
        ...GENERATION_ERROR_CLEARED_PATCH,
      });
    },
    [id, invalidateInFlightGeneration, isGenerating, updateNodeData],
  );

  // After generation ends (success/failure), clear the temporary history preview so the body returns to the latest result.
  useEffect(() => {
    if (!isGenerating) setHistoryPreviewUrl(null);
  }, [isGenerating]);

  const freezoneSource = (data.__freezone_source as
    | { role?: string; meta?: Record<string, unknown> }
    | undefined) ?? undefined;
  const sourceRole = typeof freezoneSource?.role === "string"
    ? freezoneSource.role
    : "";
  // collectCandidateBindingsForNode only cares about edges connected to this node. useShallow subscribes only to
  // edges connected to this node (element-wise comparison); when dragging unrelated nodes the edge references stay stable and this node no longer re-renders.
  const connectedEdges = useCanvasStore(
    useShallow((state) => state.edges.filter((edge) => edge.source === id || edge.target === id)),
  );
  const candidateBindingRoles = useMemo(
    () => collectCandidateBindingsForNode(connectedEdges, id).map((binding) => binding.role),
    [connectedEdges, id],
  );
  // Once the node is connected (has incoming edges): hide the "Try" CTA and show only an icon in the middle of the node (aligned with libtv).
  const isConnected = useMemo(
    () => connectedEdges.some((edge) => edge.target === id),
    [connectedEdges, id],
  );

  const [isAssetLibraryOpen, setIsAssetLibraryOpen] = useState(false);

  // Spawn upload reference nodes from selected asset-library images — one per
  // selection, stacked to the left of this node, then wired as upstream refs so
  // they feed the multi-reference generation. Image-only here (the modal is
  // opened with allowedMedia=['image']), but we still guard on media.
  // The orchestration itself is extracted into shared/assetLibraryReferenceSpawn (pure store operations), reused by the same generation form inside the storyboard detail,
  // so the "Asset library" chip behaves the same in both places.
  const handleAssetLibraryConfirm = useCallback(
    (selections: ReadonlyArray<AssetLibrarySelection>) => {
      spawnAssetLibraryReferences(id, selections);
    },
    [id],
  );

  const resolvedTitle = useMemo(
    () => localizeNodeDisplayName(CANVAS_NODE_TYPES.imageGen, data, t),
    [data, t],
  );
  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? DEFAULT_HEIGHT));
  // The collapsed floating panel has a fixed base size; enlarge uses a centered dialog (see OperationPanelShell below).
  const [panelExpanded, setPanelExpanded] = useState(false);
  const [stylePickerOpen, setStylePickerOpen] = useState(false);
  const panelHeight = OPERATIONS_PANEL_HEIGHT;
  const panelWidth = Math.max(resolvedWidth, OPERATIONS_PANEL_MIN_WIDTH);

  const previewUrl = useMemo(() => {
    if (data.previewImageUrl) return resolveImageDisplayUrl(data.previewImageUrl);
    if (data.imageUrl) return resolveImageDisplayUrl(data.imageUrl);
    if (referenceImageUrl) return resolveImageDisplayUrl(referenceImageUrl);
    return null;
  }, [data.imageUrl, data.previewImageUrl, referenceImageUrl]);
  const visiblePreviewUrl = isGenerating ? null : previewUrl;

  const hasGeneratedResult = Boolean(data.imageUrl);
  // Natural pixel size of the displayed image, mirrored from data when present
  // (persisted by the onLoad handler below) and refreshed on every <img> load so
  // the resolution badge shows even for nodes whose size already matched (those
  // skip the persist branch). Lets us render a top-right resolution chip like the
  // video node.
  const [naturalSize, setNaturalSize] = useState<{ width: number; height: number } | null>(() => {
    const w = (data as { imageNaturalWidth?: unknown }).imageNaturalWidth;
    const h = (data as { imageNaturalHeight?: unknown }).imageNaturalHeight;
    return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0
      ? { width: w, height: h }
      : null;
  });
  // ── Stacked-card album (a group of generated results with count > 1) ──
  // When collapsed, N-1 card edges peek out behind the main image; on hover a count badge appears at the top right, and clicking it expands into a
  // grid album (inside the same node, so it naturally cannot be ungrouped). In the expanded state any image can be "set as main image"
  // (backfilling imageUrl and collapsing) or downloaded individually.
  const albumRootRef = useRef<HTMLDivElement | null>(null);
  // pointerdown start point of the album container, used to tell a click from a drag (releasing after dragging the node re-fires a click).
  const albumPointerDownPosRef = useRef<{ x: number; y: number } | null>(null);
  const [albumExpanded, setAlbumExpanded] = useState(false);
  // The "expected count" within this session: N endpoints run concurrently and finish in some order; the ones finished first go into the album immediately,
  // and the unfinished hold a place in the album (skeleton + spinner). Stored in a module-level registry rather than component state —
  // under onlyRenderVisibleElements panning out of the viewport unmounts the component and state is lost; see the module comment.
  const albumPendingTotal = useAlbumPendingTotal(id);
  const albumUrls = useMemo(() => {
    const raw = data.generationBatch;
    if (!Array.isArray(raw)) return [];
    return raw.filter((u): u is string => typeof u === 'string' && u.length > 0);
  }, [data.generationBatch]);
  const albumTotalSlots = Math.max(albumUrls.length, albumPendingTotal);
  const albumPendingCount = Math.max(0, albumPendingTotal - albumUrls.length);
  const hasAlbum = albumTotalSlots > 1;

  // While the album is expanded, register as this node's activeOverlay: dragging the album makes React Flow re-select
  // the node (selectNodesOnDrag), and deselecting at the moment of expansion alone cannot hold — the action
  // toolbar / OpsPanel / history strip / replace-asset handle all defer to activeOverlayNodeId,
  // so once registered they never stack on top regardless of selection.
  useEffect(() => {
    if (!albumExpanded) return;
    setActiveOverlayNodeId(id);
    return () => {
      // Clear only what it registered itself, to avoid wrongly clearing registrations of other popovers (multi-angle / lighting etc.).
      if (useCanvasStore.getState().activeOverlayNodeId === id) {
        setActiveOverlayNodeId(null);
      }
    };
  }, [albumExpanded, id, setActiveOverlayNodeId]);

  useEffect(() => {
    if (!albumExpanded) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (albumRootRef.current?.contains(event.target as Node)) return;
      setAlbumExpanded(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setAlbumExpanded(false);
    };
    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [albumExpanded]);

  const handleSetAlbumMainImage = useCallback(
    (url: string) => {
      updateNodeData(id, {
        imageUrl: url,
        previewImageUrl: url,
        ...GENERATION_ERROR_CLEARED_PATCH,
      });
      setAlbumExpanded(false);
    },
    [id, updateNodeData],
  );

  // Deactivate the node when the album expands: the action toolbar above, the OpsPanel below and the history strip
  // all follow selected, and stacking on the grid is messy — during the album you only look at images.
  // Note select=false must be dispatched through onNodesChange to clear React Flow's own selection
  // flag — clearing only the store's selectedNodeId would be written straight back by the Canvas selection sync effect
  // (RF selectedNodeIds → setSelectedNode).
  // The side effect goes outside the setState updater: the updater must be pure (StrictMode calls it twice,
  // and a side effect inside would dispatch onNodesChange twice).
  const handleToggleAlbumExpanded = useCallback(() => {
    if (!albumExpanded) {
      const store = useCanvasStore.getState();
      const selectionChanges = store.nodes
        .filter((node) => node.selected)
        .map((node) => ({ id: node.id, type: 'select' as const, selected: false }));
      if (selectionChanges.length > 0) {
        store.onNodesChange(selectionChanges);
      }
      setSelectedNode(null);
      // Reset the "apply to canvas" drop cursor on every expansion.
      albumAppliedCountRef.current = 0;
    }
    setAlbumExpanded(!albumExpanded);
  }, [albumExpanded, setSelectedNode]);

  // "Apply to canvas": place this image as an independent image node to the right of the expanded grid (an isomorphic imageGen
  // node that downstream can reference directly / generate from again). The album stays expanded, convenient for applying several in a row —
  // successive drop points are staggered downward so they do not stack exactly on the same coordinates with only the last visible.
  const albumAppliedCountRef = useRef(0);
  const handleApplyAlbumImageToCanvas = useCallback(
    (url: string) => {
      const self = useCanvasStore.getState().nodes.find((n) => n.id === id);
      if (!self) return;
      const applyIndex = albumAppliedCountRef.current;
      albumAppliedCountRef.current += 1;
      const position = {
        x: self.position.x + resolvedWidth * 2 + 12 + 48 + applyIndex * 36,
        y: self.position.y + applyIndex * 36,
      };
      const newNodeId = addNodeAction(CANVAS_NODE_TYPES.imageGen, position, {
        imageUrl: url,
        previewImageUrl: url,
        aspectRatio: data.aspectRatio,
        user_spawned: true,
      } as Partial<ImageGenNodeData>);
      setSelectedNode(newNodeId);
    },
    [addNodeAction, data.aspectRatio, id, resolvedWidth, setSelectedNode],
  );

  const handleDownloadAlbumImage = useCallback(
    async (url: string, index: number) => {
      try {
        await downloadUrlAsFile(resolveImageDisplayUrl(url), `image-gen-${id}-${index + 1}.png`);
      } catch (error) {
        console.error('[image-gen] album download failed', error);
      }
    },
    [id],
  );

  const handlePickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleUploadFile = useCallback(
    async (file: File) => {
      const projectId = readUrl().project;
      if (!projectId) {
        console.error('[image-gen] no project in URL');
        return;
      }
      setIsUploading(true);
      try {
        const result = await uploadFreezoneImage(projectId, file, file.name);
        // The reference image ranks last in display priority (previewImageUrl → imageUrl → referenceImageUrl),
        // so it takes over the body only while the node has no generated result yet — then the old failure banner is covering a new image and must be cleared.
        // When a generated image already exists the body is unchanged and the failure info still matches that image, so it is kept; once the user really resubmits,
        // handleSubmit clears it itself.
        updateNodeData(id, {
          referenceImageUrl: result.url,
          ...(hasGeneratedResult ? {} : GENERATION_ERROR_CLEARED_PATCH),
        });
      } catch (error) {
        console.error('[image-gen] upload failed', error);
      } finally {
        setIsUploading(false);
      }
    },
    [hasGeneratedResult, id, updateNodeData],
  );

  const handleClearReference = useCallback(() => {
    updateNodeData(id, { referenceImageUrl: null });
  }, [id, updateNodeData]);

  const handleSpawnUpstreamImage = useCallback(() => {
    const self = useCanvasStore.getState().nodes.find((n) => n.id === id);
    if (!self) return;
    // The upstream image node is itself an imageGen — the user can write the prompt directly in it /
    // pick a model / generate an image, and downstream then uses its result as a reference image. Compared with upload, the benefit is that it
    // brings its own OpsPanel and the whole chain is isomorphic.
    const UPSTREAM_WIDTH = DEFAULT_WIDTH;
    const position = {
      x: self.position.x - UPSTREAM_WIDTH - 28,
      y: self.position.y,
    };
    const newNodeId = addNodeAction(CANVAS_NODE_TYPES.imageGen, position);
    addEdgeAction(newNodeId, id);
    setSelectedNode(newNodeId);
  }, [addEdgeAction, addNodeAction, id, setSelectedNode]);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  // Do not let submission through when an organization member is not eligible to start model tasks (node actions, failure retry and the panel button
  // all take submitDisabled from here). The other submission-availability checks have moved down into useImageGenerationForm.
  const modelTaskAccess = useModelTaskAccess();
  const submitDisabled = formSubmitDisabled || modelTaskAccess.blocked;

  useEffect(() => {
    return subscribeNodeAction(({ nodeId, action, requestId }) => {
      if (nodeId !== id || action !== 'generate_image') return;
      publishNodeActionAccepted(requestId, id, action);
      void handleSubmit({
        // 虾导外层会在任务受理后立即进入后台态；节点动作本身必须等真实产物
        // 终态再回报成功，否则对话会把“已提交”误显示成“图片已完成”。
        completionMode: 'completed',
      })
        .then((output) => publishNodeActionSuccess(requestId, id, action, output))
        .catch((error) => publishNodeActionError(requestId, id, action, error));
    });
  }, [handleSubmit, id]);

  // ===== Step B: the "Use as background source" action on scene asset nodes =====
  // button on scene_master / scene_reverse_master nodes → open BackgroundCropperDialog
  // → the user picks the screenshot ratio and region → generate the current-background candidate node → auto-commit to the mainline.
  // The user explicitly required "do not use all of master/reverse, take a crop" — so it goes through the cropper path, not
  // a direct PATCH of the anchor (the old implementation has been replaced).
  // Step C: the "Open Director World" button on director_combined nodes uses
  // the same-origin viewer built into supertale-fe, and does not jump to the old external director console.
  const sourceMeta = (freezoneSource?.meta ?? {}) as Record<string, unknown>;
  const sourceEpisode = typeof sourceMeta.episode === "number"
    ? sourceMeta.episode
    : null;
  const sourceBeat = typeof sourceMeta.beat === "number"
    ? sourceMeta.beat
    : null;
  // Flat source: master / reverse go through BackgroundCropperDialog (the user picks the screenshot ratio and region).
  // 360 / 3GS do not take this path — they all enter Director World, where the capture entry lives.
  const cropperSourceRoles = new Set(['scene_master', 'scene_reverse_master']);
  const canUseAsBackground = cropperSourceRoles.has(sourceRole);
  const canOpenDirectorStage = sourceRole === "director_combined"
    && sourceEpisode !== null
    && sourceBeat !== null;
  const [bgCropperOpen, setBgCropperOpen] = useState(false);
  const [directorStageBusy, setDirectorStageBusy] = useState(false);
  const [directorStageOpen, setDirectorStageOpen] = useState(false);
  const [directorStageManifest, setDirectorStageManifest] = useState<DirectorStageManifest | null>(null);
  // Get the current shot's episode/beat locating info from canvas metadata (selectedBackground syncs with beat-scope nodes
  // when emitted in the beat preset, but this node (scene_master etc.) comes from
  // _add_scene_refs without episode/beat meta — fall back to canvas metadata.preset).
  const canvasMetaForBeat = getFreezoneCanvasMetadata();
  const canvasPresetMeta = (canvasMetaForBeat?.preset as
    | { episode?: number; beat?: number }
    | undefined) ?? undefined;
  const effectiveEpisode = sourceEpisode ?? canvasPresetMeta?.episode ?? null;
  const effectiveBeat = sourceBeat ?? canvasPresetMeta?.beat ?? null;

  const handleOpenDirectorStageInline = useCallback(async () => {
    if (!canOpenDirectorStage) return;
    const projectId = readUrl().project;
    if (!projectId || effectiveEpisode === null || effectiveBeat === null) return;
    setDirectorStageBusy(true);
    try {
      const manifest = await getBeatDirectorStageManifest(projectId, effectiveEpisode, effectiveBeat);
      setDirectorStageManifest(manifest);
      setDirectorStageOpen(true);
    } catch (err) {
      console.error('[director-stage] manifest fetch failed', err);
    } finally {
      setDirectorStageBusy(false);
    }
  }, [canOpenDirectorStage, effectiveEpisode, effectiveBeat]);

  const handleDirectorCaptureCombined = useCallback(
    async (blob: Blob, meta: ThreeDDirectorCaptureMeta) => {
      const projectId = readUrl().project;
      if (!projectId || effectiveEpisode === null || effectiveBeat === null) {
        throw new Error(t('node.imageGen.missingContext'));
      }

      let imageUrl = meta.controlFrameUrl
        ?? meta.controlFrameBundle?.urls?.combined
        ?? '';
      if (!imageUrl) {
        const uploaded = await uploadFreezoneImage(
          projectId,
          blob,
          `director_combined_${Date.now()}.png`,
          { timeoutMs: false },
        );
        imageUrl = uploaded.url;
      }

      const nextBundle = meta.controlFrameBundle ?? data.director_control_bundle;

      updateNodeData(id, {
        imageUrl,
        previewImageUrl: withImageCacheBust(imageUrl, Date.now()),
        ...(nextBundle ? { director_control_bundle: nextBundle } : {}),
        committed_at: new Date().toISOString(),
        committed_slot_url: imageUrl,
        slot_target: {
          kind: 'director_render',
          episode: effectiveEpisode,
          beat: effectiveBeat,
        },
        ...GENERATION_ERROR_CLEARED_PATCH,
      });
      canvasEventBus.publish('freezone/assets-updated', undefined);
    },
    [data.director_control_bundle, effectiveEpisode, effectiveBeat, id, updateNodeData],
  );

  // The visual state is derived from 4 derived flags (see mainlineNodeFlags):
  //   preset_locked      — preset_managed === true: amber solid line + lock badge
  //   candidate_pushable — user_spawned + slot_target: amber dashed line + push badge
  //   context_only       — has mainline_context but no slot_target: cyan thin line + context chip
  //   ordinary           — none of them: default white border
  //
  const mainlineFlags = useMemo(
    () => nodeMainlineFlags({ data, id, type: 'imageGenNode', position: { x: 0, y: 0 } } as never),
    [data, id],
  );
  const visualState = mainlineNodeVisualState(mainlineFlags);
  const mainlineCanvasReadonly = mainlineFlags.isPresetManaged && !canAutoCommitOnGenerate;
  const cardToneClass = (() => {
    switch (visualState) {
      case 'preset_locked':
        return canvasNodeFrameClass({ selected, mainline: true });
      case 'candidate_pushable':
        return canvasNodeFrameClass({ selected, mainline: true, dashed: true });
      case 'context_only':
        return canvasNodeFrameClass({ selected, mainline: true });
      case 'ordinary':
      default:
        return canvasNodeFrameClass({ selected });
    }
  })();
  // Hide the OpsPanel too when the album expands — setSelectedNode(null) already ran at the moment of expansion, and this adds
  // another guard so the panel does not stack on the grid when the user clicks the node to re-select it after expansion.
  const showImageOpsPanel =
    selected && !isBoxSelecting && !hasActiveOverlay && !mainlineCanvasReadonly && !albumExpanded;

  return (
    <div
      ref={albumRootRef}
      className="group relative h-full w-full overflow-visible"
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <ReferenceValidationDialog issues={referenceErrors} open={referenceErrorsOpen} onClose={closeReferenceErrors} />
      {referenceErrors.length > 0 && (
        <button type="button" className="tap-button nodrag absolute -top-10 left-0"
          onClick={(event) => { event.stopPropagation(); openReferenceErrors(); }}>
          {t('referenceValidation.title')}
        </button>
      )}
      {/* Card edges of the stacked-card album: peeking out from the lower right of the main image, with the count matching the album (at most 3 shown).
          Rendered first and covered by the main card in front, leaving only the offset edges visible. */}
      {hasAlbum && !albumExpanded && previewUrl && (
        <>
          {Array.from({ length: Math.min(albumTotalSlots - 1, 3) }, (_, index) => {
            const step = index + 1;
            return (
              // Clicking a peeking card edge also expands the album (equivalent to clicking the count badge).
              <div
                key={`album-deck-${index}`}
                role="button"
                tabIndex={-1}
                title={t('node.imageGen.album.expand')}
                onClick={(event) => {
                  event.stopPropagation();
                  handleToggleAlbumExpanded();
                }}
                className="absolute cursor-pointer rounded-[var(--node-radius)] border border-white/[0.18] bg-gradient-to-b from-[#48484d] to-[#2d2d31] shadow-[0_4px_14px_rgba(0,0,0,0.4)]"
                style={{
                  // Modeled on TapNow: the cards behind inset up/down in turn, peek out to the right and rotate slightly —
                  // what shows is a series of "card edges", not a whole color block.
                  top: step * 7,
                  bottom: step * 7,
                  left: step * 6,
                  right: -step * 7,
                  transform: `rotate(${step * 1.1}deg)`,
                  transformOrigin: 'center right',
                  opacity: 1 - step * 0.18,
                }}
              />
            );
          })}
        </>
      )}
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

      {/* Hide the floating title and resolution badge when the album expands — the album container has its own "Album · N images" header,
          and both float at the same spot on the node's upper edge, stacking into a garbled display. */}
      {!albumExpanded && (
        <>
          <NodeHeader
            className={NODE_HEADER_FLOATING_POSITION_CLASS}
            icon={<ImageIcon className="h-4 w-4" />}
            titleText={resolvedTitle}
            editable
            onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
          />
          {visiblePreviewUrl && naturalSize ? (
            <div
              className="absolute -top-7 right-1 z-20 flex items-center gap-1 rounded-md border border-white/10 bg-black/55 px-2 py-0.5 text-[11px] font-medium tabular-nums text-white/70 backdrop-blur-sm"
              title={t('node.imageNode.resolution')}
            >
              <ImageIcon className="h-3 w-3 text-white/45" />
              {naturalSize.width}×{naturalSize.height}
            </div>
          ) : null}
        </>
      )}
      <AddNodeToChatButton nodeId={id} />
      <CandidateBindingBadges roles={candidateBindingRoles} />

      <NodeResizeHandle
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        maxWidth={MAX_WIDTH}
        maxHeight={MAX_HEIGHT}
        keepAspectRatio
      />

      {!hasGeneratedResult && !referenceImageUrl && !isGenerating && !generationError && (
        <NodeSideActionRail nodeId={id} autoHide selected={Boolean(selected)}>
          <button
            type="button"
            disabled={isUploading}
            onClick={(event) => {
              event.stopPropagation();
              handlePickFile();
            }}
            onPointerDown={(event) => event.stopPropagation()}
            title={t('node.imageGen.upload')}
            className={NODE_SIDE_ACTION_BUTTON_CLASS}
          >
            {isUploading ? (
              <Loader2 className={`${NODE_SIDE_ACTION_ICON_CLASS} animate-spin`} />
            ) : (
              <Upload className={NODE_SIDE_ACTION_ICON_CLASS} />
            )}
            <span>{t(isUploading ? 'node.imageGen.uploading' : 'node.imageGen.upload')}</span>
          </button>
        </NodeSideActionRail>
      )}

      <div
        className={`relative flex h-full w-full items-center justify-center ${visiblePreviewUrl ? 'overflow-hidden' : 'overflow-visible'} rounded-[var(--node-radius)] border transition-colors ${visiblePreviewUrl ? CANVAS_NODE_PANEL_SURFACE_CLASS : CANVAS_NODE_INPUT_SURFACE_CLASS} ${cardToneClass} ${visiblePreviewUrl ? '' : CANVAS_NODE_INPUT_BODY_FRAME_CLASS} ${
          // Hide the node body's image card while the album is expanded — the translucent album container does not cover it completely,
          // and the main image underneath would show through over the grid header.
          albumExpanded && hasAlbum ? 'invisible' : ''
        }`}
      >
        {visiblePreviewUrl ? (
          <>
            <CanvasNodeImage
              src={visiblePreviewUrl}
              alt={resolvedTitle}
              viewerSourceUrl={visiblePreviewUrl}
              onLoad={(event) => {
                const naturalW = event.currentTarget.naturalWidth;
                const naturalH = event.currentTarget.naturalHeight;
                if (naturalW > 0 && naturalH > 0) {
                  setNaturalSize((prev) =>
                    prev && prev.width === naturalW && prev.height === naturalH
                      ? prev
                      : { width: naturalW, height: naturalH },
                  );
                }
                const forceNaturalSize = shouldForceNaturalImageSize(data as Record<string, unknown>);
                if (data.isSizeManuallyAdjusted === true && !forceNaturalSize) {
                  return;
                }
                const nextAspectRatio = aspectRatioFromImageDimensions(
                  event.currentTarget.naturalWidth,
                  event.currentTarget.naturalHeight,
                );
                if (!nextAspectRatio) {
                  return;
                }
                const nextSize = resolveMinEdgeFittedSize(nextAspectRatio, {
                  minWidth: MIN_WIDTH,
                  minHeight: MIN_HEIGHT,
                });
                const displaySizeMismatch =
                  Math.abs(resolvedWidth - nextSize.width) > 1 ||
                  Math.abs(resolvedHeight - nextSize.height) > 1;
                if (nextAspectRatio !== data.aspectRatio || displaySizeMismatch) {
                  updateNodeSize(id, nextSize, {
                    lockManualSize: forceNaturalSize ? false : undefined,
                    data: {
                      aspectRatio: nextAspectRatio,
                      imageNaturalWidth: event.currentTarget.naturalWidth,
                      imageNaturalHeight: event.currentTarget.naturalHeight,
                      imageAspectRatioUpdatedAt: Date.now(),
                    },
                  });
                }
              }}
              className="h-full w-full object-contain"
            />
            {!hasGeneratedResult && referenceImageUrl && !isGenerating && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleClearReference();
                }}
                title={t('node.imageGen.removeReference')}
                className="nodrag absolute right-2 top-2 inline-flex h-6 w-6 items-center justify-center rounded-full bg-black/55 text-white transition-colors hover:bg-black/75"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            {/* Album count badge: appears on node hover; the arrow dips down on badge hover; click to expand the album. */}
            {hasAlbum && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  handleToggleAlbumExpanded();
                }}
                onPointerDown={(event) => event.stopPropagation()}
                title={t('node.imageGen.album.expandCount', { count: albumTotalSlots })}
                className="nodrag group/albumpill absolute right-2 top-2 z-10 hidden items-center gap-1 rounded-full bg-black/65 px-2.5 py-1 text-[12px] font-medium tabular-nums text-white shadow-lg backdrop-blur-sm transition-colors hover:bg-black/85 group-hover:inline-flex"
              >
                {albumPendingCount > 0
                  ? `${albumUrls.length}/${albumPendingTotal}`
                  : albumUrls.length}
                <ChevronDown
                  className={`h-3.5 w-3.5 transition-transform duration-200 ${
                    albumExpanded
                      ? 'rotate-180 group-hover/albumpill:-translate-y-[2px]'
                      : 'group-hover/albumpill:translate-y-[2px]'
                  }`}
                />
              </button>
            )}
          </>
        ) : isGenerating && historyPreviewUrl ? (
          // Generating, but the user clicked a history record preview: temporarily show that history image while the new image is still
          // generating in the background. The top pill says "Generating", and "Back" at the top right returns to the loading mask.
          // Use a native <img> (not CanvasNodeImage) to avoid onLoad changing the node size by the preview image.
          <div className="relative h-full w-full">
            <img
              src={resolveImageDisplayUrl(historyPreviewUrl)}
              alt=""
              className="h-full w-full object-contain"
              draggable={false}
              onClick={(event) => event.stopPropagation()}
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 flex items-center justify-between gap-2 p-2">
              <span className="pointer-events-auto inline-flex items-center gap-1.5 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('node.imageGen.history.generatingNew')}
              </span>
              <button
                type="button"
                className="nodrag pointer-events-auto inline-flex items-center gap-1 rounded-full bg-black/60 px-2.5 py-1 text-[11px] text-white/90 backdrop-blur transition-colors hover:bg-black/75"
                onClick={(event) => {
                  event.stopPropagation();
                  setHistoryPreviewUrl(null);
                }}
              >
                <X className="h-3 w-3" />
                {t('node.imageGen.history.back')}
              </button>
            </div>
          </div>
        ) : isGenerating ? (
          <div className="h-full w-full" />
        ) : generationError ? (
          // Failed with no result yet: keep the card empty so only the centered
          // error banner shows — placeholder + upload affordances would clutter it.
          <div className="h-full w-full" />
        ) : (
          <div className="flex h-full w-full items-center px-8 text-text-muted/55">
            {isUploading ? (
              <div className="flex w-full flex-col items-center justify-center gap-2">
                <Loader2 className="h-7 w-7 animate-spin opacity-70" />
                <span className="text-[12px] leading-6">{t('node.imageGen.uploadingEllipsis')}</span>
              </div>
            ) : isConnected ? (
              // Connected: no longer show the text CTA, only put an icon in the middle of the node (aligned with libtv).
              <div className="flex w-full items-center justify-center">
                <ImageIcon className="h-9 w-9 text-text-muted/46" aria-hidden />
              </div>
            ) : (
              <>
                <div className="flex min-h-0 flex-col justify-center gap-2 py-4">
                  <div className="text-xs text-[var(--canvas-node-input-helper)]">
                    {t('node.imageGen.emptyState.tryLabel')}
                  </div>
                  <div className="flex flex-col gap-0.5">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleSpawnUpstreamImage();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    title={t('node.imageGen.emptyState.imageToImageTitle')}
                    className="nodrag -mx-2 inline-flex items-center gap-3 rounded-lg px-2 py-2 text-sm text-text-dark transition-colors hover:bg-white/[0.08]"
                  >
                    <Upload className="h-4 w-4 text-text-muted/90" />
                    <span>{t('node.imageGen.emptyState.imageToImage')}</span>
                  </button>
                  </div>
                </div>
                <ImageIcon className="ml-auto mr-20 h-9 w-9 text-text-muted/46" aria-hidden />
              </>
            )}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) void handleUploadFile(file);
          }}
        />

        {isGenerating && !historyPreviewUrl && (
          <NodeGenerationOverlay
            startedAt={data.generationStartedAt ?? null}
            durationMs={data.generationDurationMs}
            hasBackground={Boolean(visiblePreviewUrl)}
          />
        )}

        {!isGenerating && generationError && (
          <div className="nodrag absolute inset-x-5 top-1/2 z-10 flex -translate-y-1/2 flex-col items-center text-center">
            <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-red-200">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-300/90" />
              <span>{t("node.imageNode.generationFailed")}</span>
            </div>
            <div
              className="mt-1 max-h-12 max-w-full overflow-y-auto break-words text-[11px] leading-4 text-red-100/76 [overflow-wrap:anywhere]"
              title={generationError}
            >
              {generationError}
            </div>
            {generationErrorRequestId && (
              <div className="mt-1 flex max-w-full items-center justify-center gap-1.5 text-[10px] text-text-muted/58">
                <span className="shrink-0">{t("node.imageNode.requestId")}</span>
                <code className="min-w-0 max-w-[160px] truncate font-mono" title={generationErrorRequestId}>
                  {generationErrorRequestId}
                </code>
                <button
                  type="button"
                  title={errorDetailsCopied ? t("nodeToolbar.copied") : t("nodeToolbar.copyErrorReport")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleCopyErrorDetails();
                  }}
                  onPointerDown={(event) => event.stopPropagation()}
                  className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-text-muted/70 transition-colors hover:bg-white/10 hover:text-text-dark"
                >
                  <Copy className="h-3 w-3" />
                </button>
              </div>
            )}
            <div className="mt-2 flex justify-center">
              {/* A feature node's retry must go through its own template, not fall back to regular text-to-image (otherwise the retried
                  result would not be the same thing as the one that failed). */}
              <RegenerateButton
                onClick={() => (opFormProps ? opFormProps.onSubmit() : void handleSubmit())}
                busy={isGenerating}
                disabled={opFormProps ? opFormProps.submitDisabled : submitDisabled}
              />
            </div>
          </div>
        )}
      </div>

      {/* Expanded album grid: covers the node position and spreads to the lower right, each cell the same size as the node.
          An outer "group"-style outline (border + faint background + top-left label) stresses that this set of images is
          one combination. Hovering a single cell shows "Apply to canvas" + download; clicking the image sets it as the main image. */}
      {albumExpanded && hasAlbum && (
        // The container has no nodrag and does not intercept pointerdown — pressing anywhere on the album drags the whole node
        // (the group moves together). The start point is recorded on press, and the cell's onClick uses it to tell "click to pick the main image"
        // from "release after dragging" (the browser still fires a click after React Flow finishes a drag).
        <div
          className="nowheel absolute -left-3 -top-3 z-[80] cursor-grab rounded-2xl border border-white/15 bg-white/[0.045] p-3 shadow-[0_16px_48px_rgba(0,0,0,0.4)] backdrop-blur-[2px] active:cursor-grabbing"
          style={{ width: resolvedWidth * 2 + 12 + 24 }}
          onClick={(event) => event.stopPropagation()}
          onPointerDownCapture={(event) => {
            albumPointerDownPosRef.current = { x: event.clientX, y: event.clientY };
          }}
        >
          <div className="mb-2 flex items-center gap-1.5 px-1 text-[12px] font-medium text-white/60">
            <ImageIcon className="h-3.5 w-3.5 text-white/45" />
            {t('node.imageGen.album.heading', { count: albumTotalSlots })}
          </div>
          <div className="grid grid-cols-2 gap-3">
          {albumUrls.map((url, index) => {
            const isMain = url === data.imageUrl;
            return (
              // Clicking the image directly sets it as the main image and collapses the album (no separate "Set as main image" button needed).
              <div
                key={`album-cell-${index}`}
                role="button"
                tabIndex={-1}
                title={t('node.imageGen.album.setAsMain')}
                onClick={(event) => {
                  event.stopPropagation();
                  // A click re-fired after dragging the album (moving the node) and releasing does not count as picking a main image.
                  const start = albumPointerDownPosRef.current;
                  if (
                    start
                    && Math.hypot(event.clientX - start.x, event.clientY - start.y) > 5
                  ) {
                    return;
                  }
                  handleSetAlbumMainImage(url);
                }}
                className={`group/albumcell relative cursor-pointer overflow-hidden rounded-[var(--node-radius)] border bg-[#1b1b1d] shadow-[0_12px_32px_rgba(0,0,0,0.45)] transition-colors ${
                  isMain
                    ? 'border-accent/80 ring-2 ring-accent/40'
                    : 'border-white/12 hover:border-white/35'
                }`}
                style={{ width: resolvedWidth, height: resolvedHeight }}
              >
                <img
                  src={resolveImageDisplayUrl(url)}
                  alt=""
                  className="h-full w-full object-cover"
                  draggable={false}
                />
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    handleApplyAlbumImageToCanvas(url);
                  }}
                  title={t('node.imageGen.album.applyToCanvas')}
                  className="nodrag absolute left-2 top-2 z-10 hidden h-7 items-center gap-1 rounded-md bg-black/70 px-2.5 text-[12px] font-medium text-white backdrop-blur-sm transition-colors hover:bg-black/90 group-hover/albumcell:inline-flex"
                >
                  <Upload className="h-3.5 w-3.5" />
                  {t('node.imageGen.album.applyToCanvasLabel')}
                </button>
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    void handleDownloadAlbumImage(url, index);
                  }}
                  title={t('node.imageGen.album.download')}
                  className="nodrag absolute right-2 top-2 z-10 hidden h-7 w-7 items-center justify-center rounded-full bg-black/70 text-white backdrop-blur-sm transition-colors hover:bg-black/90 group-hover/albumcell:inline-flex"
                >
                  <Download className="h-3.5 w-3.5" />
                </button>
                {isMain && (
                  <span className="absolute bottom-2 left-2 z-10 rounded-md bg-black/65 px-2 py-0.5 text-[11px] font-medium text-white backdrop-blur-sm">
                    {t('node.imageGen.album.mainImage')}
                  </span>
                )}
              </div>
            );
          })}
          {/* Slot still generating: placeholder skeleton, replaced one by one as each finishes. */}
          {Array.from({ length: albumPendingCount }, (_, index) => (
            <div
              key={`album-pending-${index}`}
              className="relative flex items-center justify-center overflow-hidden rounded-[var(--node-radius)] border border-white/10 bg-[#1b1b1d] shadow-[0_12px_32px_rgba(0,0,0,0.45)]"
              style={{ width: resolvedWidth, height: resolvedHeight }}
            >
              <div className="flex flex-col items-center gap-2 text-text-muted/70">
                <Loader2 className="h-6 w-6 animate-spin" />
                <span className="text-[12px]">{t('node.imageGen.album.generating')}</span>
              </div>
            </div>
          ))}
          </div>
        </div>
      )}

      {/*
        Step B + C: inline action buttons on scene-asset / director-intermediate nodes
        (scene_master / scene_reverse_master get "Use as background source" → open the cropper
         dialog to pick a 16:9 region → generate the current background candidate and auto-commit;
         director_combined gets "Open Director World" → same-origin viewer dialog).
        The button floats at the node's lower right, visible when selected, so it does not occupy the node body space.
      */}
      {selected && (canUseAsBackground || canOpenDirectorStage) && (
        <div className="nodrag absolute bottom-2 right-2 z-[6] flex gap-1">
          {canUseAsBackground && (
            <button
              type="button"
              disabled={effectiveEpisode === null || effectiveBeat === null}
              onClick={(event) => {
                event.stopPropagation();
                setBgCropperOpen(true);
              }}
              className="inline-flex h-6 items-center gap-1 rounded-md border border-amber-300/55 bg-[rgba(120,77,19,0.78)] px-2 text-[10px] font-medium text-amber-100 shadow-[0_0_0_1px_rgba(0,0,0,0.45)] hover:bg-[rgba(140,90,22,0.88)] disabled:cursor-not-allowed disabled:opacity-50"
              title={t('node.imageGen.cropBackgroundTitle', {
                source: sourceRole === 'scene_master' ? 'scene_master' : 'scene_reverse_master',
              })}
            >
              {t('node.imageGen.cropBackground')}
            </button>
          )}
          {canOpenDirectorStage && (
            <button
              type="button"
              disabled={directorStageBusy}
              onClick={(event) => {
                event.stopPropagation();
                void handleOpenDirectorStageInline();
              }}
              className={`inline-flex h-6 items-center gap-1 rounded-md border border-sky-300/55 px-2 text-[10px] font-medium shadow-[0_0_0_1px_rgba(0,0,0,0.45)] ${
                directorStageBusy
                  ? 'cursor-not-allowed bg-sky-400/10 text-sky-100/60'
                  : 'bg-[rgba(15,67,107,0.78)] text-sky-100 hover:bg-[rgba(22,90,140,0.88)]'
              }`}
              title={t("viewer.threeD.openDirectorWorldTitle")}
            >
              {directorStageBusy
                ? t("viewer.threeD.openingDirectorWorld")
                : `🎬 ${t("viewer.threeD.directorWorld")}`}
            </button>
          )}
        </div>
      )}

      {/*
        The full-featured ops panel of ImageGenNode on the free canvas (camera / model picker /
        free reference upload / generation count / style picker / submit ...).
        Preset-managed source nodes hide this panel; user-spawned nodes keep it.
      */}
      {showImageOpsPanel && (
        <OperationPanelShell
          expanded={panelExpanded}
          onCollapse={() => setPanelExpanded(false)}
          inlineClassName={`nodrag absolute left-1/2 z-10 flex -translate-x-1/2 flex-col rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS}`}
          inlineStyle={{
            top: `calc(100% + ${OPERATIONS_PANEL_GAP}px)`,
            height: panelHeight,
            width: panelWidth,
          }}
          modalStyle={{
            width: `min(${OPERATIONS_PANEL_EXPANDED_MIN_WIDTH}px, 92vw)`,
            height: `min(${OPERATIONS_PANEL_EXPANDED_HEIGHT}px, 86vh)`,
          }}
        >
          <PanelExpandButton
            expanded={panelExpanded}
            onToggle={() => setPanelExpanded((v) => !v)}
            className="absolute right-2 top-2 z-20"
          />
          <ImageGenerationForm
            {...imageGenerationFormProps}
            onStylePickerOpenChange={setStylePickerOpen}
            onOpenAssetLibrary={() => setIsAssetLibraryOpen(true)}
            {...(opFormProps ?? {})}
          />
        </OperationPanelShell>
      )}
      {selected && !isBoxSelecting && !hasActiveOverlay && !panelExpanded && !stylePickerOpen && hasCompletedHistoryRecords(historyRecords) && (
        <div
          className={`nodrag absolute left-1/2 z-[300] -translate-x-1/2 rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} ${NODE_OPS_PANEL_ENTER_CLASS} px-3 py-2`}
          style={{
            top: `calc(100% + ${OPERATIONS_PANEL_GAP * 2 + panelHeight}px)`,
            width: panelWidth,
          }}
          onClick={(event) => event.stopPropagation()}
        >
          <NodeGenerationHistory
            records={historyRecords}
            isLoading={historyLoading}
            onRestore={handleRestoreHistory}
            onRefresh={() => void refreshHistory()}
            isActive={(record) => {
              const url = historyRecordOutputUrl(record);
              if (!url) return false;
              // In preview state highlight the history entry being previewed, otherwise highlight the current main image.
              if (isGenerating && historyPreviewUrl) {
                return url === historyPreviewUrl;
              }
              return url === data.imageUrl;
            }}
          />
        </div>
      )}

      {/* Step B: the flat-source (master/reverse) crop-background dialog.
          Pano360 / 3GS do not take this path — they use the capture button on their own viewers. */}
      {canUseAsBackground && effectiveEpisode !== null && effectiveBeat !== null && (
        <BackgroundCropperDialog
          isOpen={bgCropperOpen}
          onClose={() => setBgCropperOpen(false)}
          sourceUrl={typeof data.imageUrl === 'string' ? data.imageUrl : ''}
          sourceLabel={sourceRole === 'scene_master' ? 'master' : 'reverse'}
          aspectOptions={SELECTED_BACKGROUND_CROP_ASPECT_OPTIONS}
          onConfirmBlob={async (blob, filename) => {
            await uploadAndAutoCommitSelectedBackgroundCandidate(
              { episode: effectiveEpisode, beat: effectiveBeat },
              blob,
              filename,
              {
                sourceNodeId: id,
                label: t("viewer.threeD.selectedBackgroundOutputLabel"),
                successMessage: t("viewer.threeD.selectedBackgroundCommitSuccess", {
                  episode: effectiveEpisode,
                  beat: effectiveBeat,
                }),
              },
            );
          }}
          onCandidateSuccess={() => setBgCropperOpen(false)}
          onError={(msg) => console.warn('[bg-cropper]', msg)}
        />
      )}
      {canOpenDirectorStage && (
        <ThreeDDirectorDialog
          open={directorStageOpen}
          onOpenChange={setDirectorStageOpen}
          manifest={directorStageManifest}
          title={t("viewer.threeD.beatDirectorWorld")}
          description={t("viewer.threeD.beatDirectorWorldDescription")}
          viewerPurpose="beat"
          autoCommitDirectorCombined
          onSubmitDirectorCombined={handleDirectorCaptureCombined}
        />
      )}
      <AssetLibraryModal
        mode="pick"
        open={isAssetLibraryOpen}
        project={readUrl().project ?? null}
        allowedMedia={['image']}
        onClose={() => setIsAssetLibraryOpen(false)}
        onConfirm={handleAssetLibraryConfirm}
      />
    </div>
  );
});

ImageGenNode.displayName = 'ImageGenNode';

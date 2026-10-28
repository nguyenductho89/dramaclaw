import i18n from 'i18next';
import { ImageDerivedOverlay } from "./ImageDerivedActions";
// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import {
  NodeToolbar as ReactFlowNodeToolbar,
  Position,
  useReactFlow,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';

import { useCanvasStore } from '@/stores/canvasStore';
import {
  DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO,
  fetchFreezoneJobResult,
  submitFreezoneOutpaint,
  submitFreezoneScene360,
  submitFreezoneTemplateEdit,
  submitFreezoneUpscale,
  type FreezoneOutpaintAspectRatio,
  type FreezoneTemplateEditMode,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import {
  publishNodeActionAccepted,
  publishNodeActionError,
  publishNodeActionSuccess,
  subscribeNodeAction,
} from '@/features/canvas/application/nodeActionResult';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_NODE_WIDTH,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  hasInlineMediaReplaceButton,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isPano360ViewerNode,
  isUploadNode,
  isVideoNode,
  NODE_TOOL_TYPES,
  type NodeToolType,
  resolveNodeSourceImageUrl,
  type CanvasNode,
  type ExportImageNodeResultKind,
} from '@/features/canvas/domain/canvasNodes';
import { createUpscaleResultNode } from '@/features/canvas/application/imageUpscale';
import {
  createRotateResultNode,
  discardRotateResultNode,
} from '@/features/canvas/application/imageRotate';
import { NodeActionToolbar } from './NodeActionToolbar';
import { NodeIdBadge } from './NodeIdBadge';
import { AssetCommitHandle } from './AssetCommitHandle';
import { MultiAngleEditorOverlay } from './MultiAngleEditorOverlay';
import { RedrawOverlay } from './RedrawOverlay';
import { EraseOverlay } from './EraseOverlay';
import { Scene360Overlay } from './Scene360Overlay';
import { UpscaleEditorOverlay } from './UpscaleEditorOverlay';
import { VideoUpscaleEditorOverlay } from './VideoUpscaleEditorOverlay';
import { getFreezoneImageModelsSnapshot } from '@/features/canvas/hooks/useFreezoneImageModels';
import {
  DEFAULT_SHARED_MODEL_ID,
  DEFAULT_UPSCALE_MODEL_ID,
  SHARED_MODELS,
} from '@/features/canvas/ui/ProviderModelPicker';
import { OutpaintEditorOverlay } from './OutpaintEditorOverlay';
import { RotateEditorOverlay } from './RotateEditorOverlay';
import { ImageResizeOverlay } from './ImageResizeOverlay';
import type { GridActionKey } from '@/features/canvas/application/gridTemplateAction';
import type { GridActionRequest } from './NodeActionToolbar';
import { spawnAssetBoardImageOpNode } from '@/features/canvas/application/assetBoardImageOps';
import { readUrl } from '@/lib/url-params';
import { inheritMainlineFields } from '../domain/inheritMainlineFields';

// Cards of these types **may** carry their own "Replace" button (NodeMediaReplaceButton) in the top-right corner,
// which also takes over the drag-to-asset-library gesture, so the outer AssetCommitHandle is no longer attached.
const NODE_TYPES_WITH_INLINE_COMMIT_BUTTON = new Set<string>([
  CANVAS_NODE_TYPES.exportImage,
  CANVAS_NODE_TYPES.video,
  CANVAS_NODE_TYPES.audio,
]);

/**
 * The in-card replace button only appears on frame-by-frame breakdown outputs (allowLocalReplace), so the check has to look at data
 * as well: among video nodes, the one produced by breakdown uses the in-card button, while ordinary generation results have none —
 * if this excluded by type alone, those nodes would lose the outer handle too and replacing media would have no entry point at all.
 */
export function hasInlineCommitButton(node: CanvasNode): boolean {
  if (!NODE_TYPES_WITH_INLINE_COMMIT_BUTTON.has(node.type ?? '')) return false;
  return hasInlineMediaReplaceButton(node.data as { allowLocalReplace?: boolean });
}

// Image/video nodes only need the floating action toolbar once they actually
// have a resource to act on. While the node is empty (no upload, no generated
// output), the toolbar entries (edit / upscale / smart subtitle removal / ...) are all no-ops,
// so we hide the toolbar entirely to keep the empty-state UI uncluttered.
// Other node types (text / group / audio / storyboard) keep the toolbar on
// selection because their actions don't depend on a resource.
function nodeHasResourceForToolbar(node: CanvasNode): boolean {
  // The 360 panorama viewer has its own top screenshot toolbar and does not need this toolbar left with only "Delete"
  // (deleting is still available with Delete / Backspace).
  if (isPano360ViewerNode(node)) {
    return false;
  }
  if (isVideoNode(node)) {
    return Boolean(node.data.videoUrl);
  }
  // imageGen uploads a "reference image", stored in referenceImageUrl rather than imageUrl - but
  // the node picture shows it just the same (previewUrl falls back to referenceImageUrl), so the toolbar
  // should also appear when there is only a reference image, otherwise after uploading the user sees no operation entry.
  if (isImageGenNode(node)) {
    return Boolean(
      node.data.imageUrl || node.data.previewImageUrl || node.data.referenceImageUrl,
    );
  }
  if (
    isUploadNode(node) ||
    isImageEditNode(node) ||
    isExportImageNode(node)
  ) {
    return Boolean(node.data.imageUrl || node.data.previewImageUrl);
  }
  return true;
}

const SCENE_360_FOCUS_ZOOM = 1.2;
const SCENE_360_FOCUS_DURATION = 320;
const SCENE_360_DEFAULT_NODE_HEIGHT = 320;
const PANO_VIEWER_LAYOUT_WIDTH = 720;
const PANO_VIEWER_LAYOUT_HEIGHT = 420;
const NODE_ID_BADGE_OFFSET = 88;
const DEFAULT_OUTPAINT_ASPECT_RATIO: FreezoneOutpaintAspectRatio = 'original';
const DEFAULT_OUTPAINT_IMAGE_SIZE = '2K';

const GRID_RUN_ACTIONS: Record<string, {
  key: GridActionKey;
  i18nKey: string;
  mode: FreezoneTemplateEditMode;
}> = {
  run_grid_multi_camera: {
    key: 'multiCameraGrid',
    i18nKey: 'nodeToolbar.gridMenu.multiCameraGrid',
    mode: 'multi_camera_nine_grid',
  },
  run_grid_plot_four: {
    key: 'plotFourGrid',
    i18nKey: 'nodeToolbar.gridMenu.plotFourGrid',
    mode: 'story_pitch_four_grid',
  },
  run_grid_face_three_view: {
    key: 'faceThreeView',
    i18nKey: 'nodeToolbar.gridMenu.faceThreeView',
    mode: 'character_face_three_view',
  },
  run_grid_product_three_view: {
    key: 'productThreeView',
    i18nKey: 'nodeToolbar.gridMenu.productThreeView',
    mode: 'product_three_view',
  },
  run_grid_serial_storyboard_25: {
    key: 'serialStoryboard25',
    i18nKey: 'nodeToolbar.gridMenu.serialStoryboard25',
    mode: 'storyboard_25_grid',
  },
  run_grid_cinematic_light_correction: {
    key: 'cinematicLightCorrection',
    i18nKey: 'nodeToolbar.gridMenu.cinematicLightCorrection',
    mode: 'cinematic_light_correction',
  },
  run_grid_character_three_view: {
    key: 'characterThreeView',
    i18nKey: 'nodeToolbar.gridMenu.characterThreeView',
    mode: 'character_three_view_generation',
  },
  run_grid_scene_setting_sheet: {
    key: 'sceneSettingSheet',
    i18nKey: 'nodeToolbar.gridMenu.sceneSettingSheet',
    mode: 'scene_setting_sheet',
  },
  run_grid_frame_projection_3s_later: {
    key: 'frameProjection3sLater',
    i18nKey: 'nodeToolbar.gridMenu.frameProjection3sLater',
    mode: 'image_projection_after_3s',
  },
  run_grid_frame_projection_5s_earlier: {
    key: 'frameProjection5sEarlier',
    i18nKey: 'nodeToolbar.gridMenu.frameProjection5sEarlier',
    mode: 'image_projection_before_5s',
  },
};

const NODE_TOOL_DIALOG_ACTIONS: Record<string, NodeToolType> = {
  open_crop_tool: NODE_TOOL_TYPES.crop,
  open_annotate_tool: NODE_TOOL_TYPES.annotate,
  open_split_storyboard_tool: NODE_TOOL_TYPES.splitStoryboard,
};

export const SelectedNodeOverlay = memo(() => {
  const { t } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const setActiveOverlayNodeId = useCanvasStore((state) => state.setActiveOverlayNodeId);
  const onNodesChange = useCanvasStore((state) => state.onNodesChange);
  const addNode = useCanvasStore((state) => state.addNode);
  const addEdge = useCanvasStore((state) => state.addEdge);
  const findNodePosition = useCanvasStore((state) => state.findNodePosition);
  const reactFlow = useReactFlow();

  // When a secondary overlay triggered by the top toolbar (panorama / multi-dimension / lighting / 3x3 grid etc.)
  // is open, the node's React Flow `selected` must really be cleared - otherwise the node's own
  // operation panel (ImageGenNode etc. judge display by the `selected` prop) would show
  // together with the overlay. `setSelectedNode(null)` only clears the store's `selectedNodeId`,
  // and Canvas.tsx's sync effect would immediately write it back from `node.selected === true`,
  // so it must go through onNodesChange to trigger a real select=false.
  const clearFlowSelection = useCallback(() => {
    const ids = nodes.filter((n) => n.selected).map((n) => n.id);
    if (ids.length === 0) return;
    onNodesChange(
      ids.map((id) => ({ id, type: 'select' as const, selected: false })),
    );
  }, [nodes, onNodesChange]);

  const selectAndFocusCanvasNode = useCallback(
    (nodeId: string) => {
      const currentNodes = useCanvasStore.getState().nodes;
      onNodesChange(
        currentNodes.map((node) => ({
          id: node.id,
          type: 'select' as const,
          selected: node.id === nodeId,
        })),
      );
      setSelectedNode(nodeId);
      useCanvasStore.getState().requestFocusNode(nodeId);
    },
    [onNodesChange, setSelectedNode],
  );
  const [multiAngleNodeId, setMultiAngleNodeId] = useState<string | null>(null);
  const activeLightEditorNodeId = useCanvasStore((state) => state.activeLightEditorNodeId);
  const setLightEditorNodeId = useCanvasStore((state) => state.setActiveLightEditorNodeId);
  const [derivedMedia, setDerivedMedia] = useState<{ nodeId: string; kind: "svg" | "gif" } | null>(null);
  const derivedMediaNode = derivedMedia ? nodes.find(node => node.id === derivedMedia.nodeId) : null;
  const [scene360NodeId, setScene360NodeId] = useState<string | null>(null);
  const [redrawNodeId, setRedrawNodeId] = useState<string | null>(null);
  const [eraseNodeId, setEraseNodeId] = useState<string | null>(null);
  const [outpaintNodeId, setOutpaintNodeId] = useState<string | null>(null);
  const [rotateNodeId, setRotateNodeId] = useState<string | null>(null);
  const [resizeNodeId, setResizeNodeId] = useState<string | null>(null);
  const resizeNode = nodes.find((node) => node.id === resizeNodeId) ?? null;
  const resizeImageSource = resolveNodeSourceImageUrl(resizeNode);
  const handleOpenResize = useCallback((nodeId: string) => {
    setResizeNodeId(nodeId);
    clearFlowSelection();
    setSelectedNode(null);
  }, [clearFlowSelection, setSelectedNode]);
  const handleCloseResize = useCallback(() => setResizeNodeId(null), []);
  useEffect(() => {
    if (resizeNodeId && !resizeNode) setResizeNodeId(null);
  }, [resizeNodeId, resizeNode]);


  const selectedNode = useMemo(() => {
    if (!selectedNodeId) {
      return null;
    }

    return nodes.find((node) => node.id === selectedNodeId) ?? null;
  }, [nodes, selectedNodeId]);

  const multiAngleNode = useMemo(() => {
    if (!multiAngleNodeId) {
      return null;
    }
    return nodes.find((node) => node.id === multiAngleNodeId) ?? null;
  }, [nodes, multiAngleNodeId]);

  const multiAngleImageSource = useMemo(
    () => resolveNodeSourceImageUrl(multiAngleNode),
    [multiAngleNode]
  );

  const redrawNode = useMemo(() => {
    if (!redrawNodeId) {
      return null;
    }
    return nodes.find((node) => node.id === redrawNodeId) ?? null;
  }, [nodes, redrawNodeId]);

  const redrawImageSource = useMemo(
    () => resolveNodeSourceImageUrl(redrawNode),
    [redrawNode]
  );

  const scene360Node = useMemo(() => {
    if (!scene360NodeId) {
      return null;
    }
    return nodes.find((node) => node.id === scene360NodeId) ?? null;
  }, [nodes, scene360NodeId]);

  const scene360ImageSource = useMemo(
    () => resolveNodeSourceImageUrl(scene360Node),
    [scene360Node]
  );


  const handleOpenMultiAngleEditor = useCallback(
    (nodeId: string) => {
      setMultiAngleNodeId(nodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, setSelectedNode]
  );

  const handleCloseMultiAngleEditor = useCallback(() => {
    setMultiAngleNodeId(null);
  }, []);

  const handleOpenLightEditor = useCallback(
    (nodeId: string) => {
      setLightEditorNodeId(nodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, setSelectedNode]
  );

  const handleOpenRedraw = useCallback(
    (nodeId: string) => {
      setRedrawNodeId(nodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, setSelectedNode]
  );

  const handleCloseRedraw = useCallback(() => {
    setRedrawNodeId(null);
  }, []);

  const eraseNode = useMemo(() => {
    if (!eraseNodeId) {
      return null;
    }
    return nodes.find((node) => node.id === eraseNodeId) ?? null;
  }, [nodes, eraseNodeId]);

  const eraseImageSource = useMemo(
    () => resolveNodeSourceImageUrl(eraseNode),
    [eraseNode]
  );

  const handleOpenErase = useCallback(
    (nodeId: string) => {
      setEraseNodeId(nodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, setSelectedNode]
  );

  const handleCloseErase = useCallback(() => {
    setEraseNodeId(null);
  }, []);

  const handleOpenScene360 = useCallback(
    (nodeId: string) => {
      const targetNode = nodes.find((node) => node.id === nodeId);
      if (targetNode) {
        const width =
          typeof targetNode.measured?.width === 'number'
            ? targetNode.measured.width
            : typeof targetNode.width === 'number'
              ? targetNode.width
              : DEFAULT_NODE_WIDTH;
        const height =
          typeof targetNode.measured?.height === 'number'
            ? targetNode.measured.height
            : typeof targetNode.height === 'number'
              ? targetNode.height
              : SCENE_360_DEFAULT_NODE_HEIGHT;
        // A group member's position is relative to the parent group; setCenter needs absolute coordinates, otherwise the view jumps off.
        const absolute =
          reactFlow.getInternalNode(nodeId)?.internals.positionAbsolute ??
          targetNode.position;
        const centerX = absolute.x + width / 2;
        const centerY = absolute.y + height / 2;
        reactFlow.setCenter(centerX, centerY, {
          zoom: SCENE_360_FOCUS_ZOOM,
          duration: SCENE_360_FOCUS_DURATION,
        });
      }
      setScene360NodeId(nodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, nodes, reactFlow, setSelectedNode]
  );

  const handleCloseScene360 = useCallback(() => {
    setScene360NodeId(null);
  }, []);

  const outpaintNode = useMemo(() => {
    if (!outpaintNodeId) {
      return null;
    }
    return nodes.find((node) => node.id === outpaintNodeId) ?? null;
  }, [nodes, outpaintNodeId]);

  const outpaintImageSource = useMemo(
    () => resolveNodeSourceImageUrl(outpaintNode),
    [outpaintNode]
  );

  const handleOpenOutpaint = useCallback(
    (nodeId: string) => {
      setOutpaintNodeId(nodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, setSelectedNode]
  );

  const handleCloseOutpaint = useCallback(() => {
    setOutpaintNodeId(null);
  }, []);

  const rotateNode = useMemo(() => {
    if (!rotateNodeId) {
      return null;
    }
    return nodes.find((node) => node.id === rotateNodeId) ?? null;
  }, [nodes, rotateNodeId]);

  const rotateImageSource = useMemo(() => {
    if (!rotateNode) {
      return null;
    }
    if (
      isUploadNode(rotateNode)
      || isImageEditNode(rotateNode)
      || isImageGenNode(rotateNode)
      || isExportImageNode(rotateNode)
    ) {
      return (
        rotateNode.data.imageUrl
        || rotateNode.data.previewImageUrl
        || null
      );
    }
    return null;
  }, [rotateNode]);

  const handleOpenRotate = useCallback(
    (sourceNodeId: string) => {
      const newNodeId = createRotateResultNode(sourceNodeId, {
        displayName: t('rotateEditor.resultTitle'),
      });
      if (!newNodeId) return;
      setRotateNodeId(newNodeId);
      clearFlowSelection();
      setSelectedNode(null);
    },
    [clearFlowSelection, setSelectedNode, t]
  );

  // The rotate result node may be deleted directly by the user with the keyboard (bypassing the editor's close flow). Then
  // `rotateNode` resolves to null and the editor disappears naturally, but `rotateNodeId` still keeps a
  // stale id, making the top toolbar's `!rotateNodeId` check always false - after re-selecting
  // the original image node the menu would no longer show either. Clear the state in sync once the node is gone, avoiding such dangling.
  useEffect(() => {
    if (rotateNodeId && !rotateNode) {
      setRotateNodeId(null);
    }
  }, [rotateNodeId, rotateNode]);

  const handleCloseRotate = useCallback(
    (committed: boolean) => {
      // Entering rotate pre-creates a "rotate result" node. When the user exits / presses Esc / makes no
      // transform and closes (committed=false), delete it, otherwise a node appears from nowhere.
      if (!committed && rotateNodeId) {
        discardRotateResultNode(rotateNodeId);
      }
      setRotateNodeId(null);
    },
    [rotateNodeId]
  );

  const handleOpenUpscale = useCallback(
    (sourceNodeId: string) => {
      const placeholderNodeId = createUpscaleResultNode(sourceNodeId, {
        displayName: t('upscaleEditor.title'),
      });
      if (!placeholderNodeId) return;
      selectAndFocusCanvasNode(placeholderNodeId);
    },
    [selectAndFocusCanvasNode, t],
  );

  const upscalePanelNode = useMemo(() => {
    if (!selectedNode) return null;
    if (!isExportImageNode(selectedNode)) return null;
    if (
      (selectedNode.data as { resultKind?: ExportImageNodeResultKind }).resultKind
      !== 'upscale'
    ) {
      return null;
    }
    return selectedNode;
  }, [selectedNode]);

  const videoUpscalePanelNode = useMemo(() => {
    if (!selectedNode) return null;
    if (!isVideoNode(selectedNode)) return null;
    return selectedNode.data.isUpscaleNode ? selectedNode : null;
  }, [selectedNode]);

  /**
   * Selecting an item in the "3x3 grid" dropdown: **only build a feature node downstream of the source node, do not submit** - node name =
   * feature name, the feature chip lands in its prompt input box, and the user submits only by pressing the up button after editing the prompt/reference images/ratio
   * (the same interaction as the storyboard detail toolbar, the same spawn/run).
   *
   * After building, select and focus it: the feature node's generation form is rendered following React Flow's `selected`,
   * and without selecting it the input box is not visible, so there is nowhere to press the up button.
   */
  const handleSpawnGridActionNode = useCallback(
    (request: GridActionRequest) => {
      const sourceNode = nodes.find((node) => node.id === request.nodeId) ?? null;
      const imageSource = resolveNodeSourceImageUrl(sourceNode);
      if (!sourceNode || !imageSource) {
        return;
      }
      const nextNodeId = spawnAssetBoardImageOpNode(sourceNode.id, imageSource, request.key);
      if (!nextNodeId) {
        return;
      }
      selectAndFocusCanvasNode(nextNodeId);
    },
    [nodes, selectAndFocusCanvasNode]
  );

  useEffect(() => {
    return subscribeNodeAction(({ nodeId, action, requestId }) => {
      const toolType = NODE_TOOL_DIALOG_ACTIONS[action];
      if (toolType) {
        canvasEventBus.publish("tool-dialog/open", {
          nodeId,
          toolType,
        });
        publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
        return;
      }

      switch (action) {
        case 'open_multi_angle_tool':
          handleOpenMultiAngleEditor(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        case 'open_light_tool':
          handleOpenLightEditor(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        case 'open_scene360_tool':
          handleOpenScene360(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        case 'open_redraw_tool':
          handleOpenRedraw(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        case 'open_erase_tool':
          handleOpenErase(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        case 'open_outpaint_tool':
          handleOpenOutpaint(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        case 'open_rotate_tool': {
          const beforeNodeIds = new Set(useCanvasStore.getState().nodes.map((node) => node.id));
          handleOpenRotate(nodeId);
          const created = useCanvasStore
            .getState()
            .nodes.some((node) => !beforeNodeIds.has(node.id));
          if (!created) {
            publishNodeActionError(requestId, nodeId, action, i18n.t('canvas.selectedOverlay.noRotateImage'));
            return;
          }
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        }
        case 'open_upscale_tool':
          handleOpenUpscale(nodeId);
          publishNodeActionSuccess(requestId, nodeId, action, { openedUiAction: true });
          return;
        default:
          return;
      }
    });
  }, [
    handleOpenErase,
    handleOpenLightEditor,
    handleOpenMultiAngleEditor,
    handleOpenOutpaint,
    handleOpenRedraw,
    handleOpenRotate,
    handleOpenScene360,
    handleOpenUpscale,
  ]);

  useEffect(() => {
    return subscribeNodeAction(({ nodeId, action, requestId }) => {
      if (action === 'run_outpaint_tool') {
        const sourceNode = nodes.find((node) => node.id === nodeId) ?? null;
        const imageSource = resolveNodeSourceImageUrl(sourceNode);
        if (!sourceNode || !imageSource) {
          publishNodeActionError(requestId, nodeId, action, i18n.t('canvas.selectedOverlay.noOutpaintImage'));
          return;
        }
        const project = readUrl().project;
        if (!project) {
          publishNodeActionError(requestId, nodeId, action, i18n.t('canvas.selectedOverlay.missingProject'));
          return;
        }

        publishNodeActionAccepted(requestId, nodeId, action);
        const sourceAspectRatio =
          typeof (sourceNode.data as { aspectRatio?: unknown }).aspectRatio === 'string'
            ? ((sourceNode.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
            : DEFAULT_ASPECT_RATIO;
        const position = findNodePosition(
          sourceNode.id,
          EXPORT_RESULT_NODE_DEFAULT_WIDTH,
          EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
        );
        const initialData = inheritMainlineFields(
          { data: sourceNode.data as Record<string, unknown> },
          {
            displayName: t('outpaintEditor.title'),
            imageUrl: null,
            previewImageUrl: null,
            aspectRatio: sourceAspectRatio,
            resultKind: 'generic',
            isGenerating: true,
            generationStartedAt: Date.now(),
          },
        );
        const nextNodeId = addNode(
          CANVAS_NODE_TYPES.exportImage,
          position,
          initialData as unknown as Parameters<typeof addNode>[2],
        );
        addEdge(sourceNode.id, nextNodeId);
        selectAndFocusCanvasNode(nextNodeId);

        void (async () => {
          try {
            const imageModels = getFreezoneImageModelsSnapshot(project).models;
            const selectedModel =
              imageModels.find((model) => model.id === DEFAULT_SHARED_MODEL_ID)
              ?? imageModels[0]
              ?? SHARED_MODELS.find((model) => model.id === DEFAULT_SHARED_MODEL_ID);
            const ref = await submitFreezoneOutpaint(project, {
              sourceUrl: imageSource.split('?')[0],
              targetAspectRatio: DEFAULT_OUTPAINT_ASPECT_RATIO,
              numImages: 1,
              imageSize: DEFAULT_OUTPAINT_IMAGE_SIZE,
              model: selectedModel?.apiModel ?? DEFAULT_SHARED_MODEL_ID,
            });
            useCanvasStore.getState().updateNodeData(nextNodeId, generationTaskDescriptor(ref));
            const completed = await awaitTaskCompletion(ref.task_key, project);
            const directUrl = completed.result?.['output_url'] as string | undefined;
            const url = directUrl
              ?? (await fetchFreezoneJobResult(project, ref.task_type, ref.job_id)).url;
            useCanvasStore.getState().updateNodeData(nextNodeId, {
              imageUrl: url,
              previewImageUrl: url,
              isGenerating: false,
              generationStartedAt: null,
              generationError: null,
            });
            publishNodeActionSuccess(requestId, nodeId, action, {
              nodeId: nextNodeId,
              imageUrl: url,
              previewImageUrl: url,
              task_key: ref.task_key,
              job_id: ref.job_id,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            useCanvasStore.getState().updateNodeData(nextNodeId, {
              isGenerating: false,
              generationStartedAt: null,
              generationError: message,
            });
            publishNodeActionError(requestId, nodeId, action, error);
          }
        })();
        return;
      }

      if (action === 'run_upscale_tool') {
        const sourceNode = nodes.find((node) => node.id === nodeId) ?? null;
        const imageSource = resolveNodeSourceImageUrl(sourceNode);
        if (!sourceNode || !imageSource) {
          publishNodeActionError(requestId, nodeId, action, i18n.t('canvas.selectedOverlay.noUpscaleImage'));
          return;
        }
        const project = readUrl().project;
        if (!project) {
          publishNodeActionError(requestId, nodeId, action, i18n.t('canvas.selectedOverlay.missingProject'));
          return;
        }

        publishNodeActionAccepted(requestId, nodeId, action);
        const sourceAspectRatio =
          typeof (sourceNode.data as { aspectRatio?: unknown }).aspectRatio === 'string'
            ? ((sourceNode.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
            : DEFAULT_ASPECT_RATIO;
        const position = findNodePosition(
          sourceNode.id,
          EXPORT_RESULT_NODE_DEFAULT_WIDTH,
          EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
        );
        const nextNodeId = addNode(
          CANVAS_NODE_TYPES.exportImage,
          position,
          {
            displayName: t('upscaleEditor.title'),
            imageUrl: null,
            previewImageUrl: imageSource,
            aspectRatio: sourceAspectRatio,
            resultKind: 'upscale',
            isGenerating: true,
            generationStartedAt: Date.now(),
            upscaleSourceUrl: imageSource,
            upscaleModelId: DEFAULT_UPSCALE_MODEL_ID,
            upscaleImageSize: '2K',
            upscaleScaleFactor: 2,
          },
        );
        addEdge(sourceNode.id, nextNodeId);
        selectAndFocusCanvasNode(nextNodeId);

        void (async () => {
          try {
            const imageModels = getFreezoneImageModelsSnapshot(project).models;
            const selectedModel =
              imageModels.find((model) => model.id === DEFAULT_UPSCALE_MODEL_ID)
              ?? imageModels[0];
            const ref = await submitFreezoneUpscale(project, {
              sourceUrl: imageSource.split('?')[0],
              scaleFactor: 2,
              imageSize: '2K',
              model: selectedModel?.apiModel ?? DEFAULT_UPSCALE_MODEL_ID,
            });
            useCanvasStore.getState().updateNodeData(nextNodeId, generationTaskDescriptor(ref));
            const completed = await awaitTaskCompletion(ref.task_key, project);
            const directUrl = completed.result?.['output_url'] as string | undefined;
            const url = directUrl
              ?? (await fetchFreezoneJobResult(project, ref.task_type, ref.job_id)).url;
            useCanvasStore.getState().updateNodeData(nextNodeId, {
              imageUrl: url,
              previewImageUrl: url,
              isGenerating: false,
              generationStartedAt: null,
              generationError: null,
            });
            publishNodeActionSuccess(requestId, nodeId, action, {
              nodeId: nextNodeId,
              imageUrl: url,
              previewImageUrl: url,
              task_key: ref.task_key,
              job_id: ref.job_id,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            useCanvasStore.getState().updateNodeData(nextNodeId, {
              isGenerating: false,
              generationStartedAt: null,
              generationError: message,
            });
            publishNodeActionError(requestId, nodeId, action, error);
          }
        })();
        return;
      }

      if (action === 'run_scene360_tool') {
        const sourceNode = nodes.find((node) => node.id === nodeId) ?? null;
        const imageSource = resolveNodeSourceImageUrl(sourceNode);
        if (!sourceNode || !imageSource) {
          publishNodeActionError(requestId, nodeId, action, i18n.t('canvas.selectedOverlay.noGenerateImage'));
          return;
        }
        const project = readUrl().project;
        if (!project) {
          publishNodeActionError(requestId, nodeId, action, i18n.t('canvas.selectedOverlay.missingProject'));
          return;
        }

        publishNodeActionAccepted(requestId, nodeId, action);
        const aspectRatio = DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO;
        const position = findNodePosition(
          sourceNode.id,
          EXPORT_RESULT_NODE_DEFAULT_WIDTH,
          EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
        );
        const nextNodeId = addNode(
          CANVAS_NODE_TYPES.exportImage,
          position,
          {
            displayName: t('scene360.label'),
            imageUrl: null,
            previewImageUrl: null,
            aspectRatio,
            resultKind: 'generic',
            output_role: 'scene_360_candidate',
            media_kind: 'pano360',
            isGenerating: true,
            generationStartedAt: Date.now(),
          },
        );
        addEdge(sourceNode.id, nextNodeId);
        selectAndFocusCanvasNode(nextNodeId);

        void (async () => {
          try {
            const ref = await submitFreezoneScene360(project, {
              referenceUrl: imageSource.split('?')[0],
              aspectRatio,
            });
            useCanvasStore.getState().updateNodeData(nextNodeId, generationTaskDescriptor(ref));
            const completed = await awaitTaskCompletion(ref.task_key, project);
            const directUrl = completed.result?.['output_url'] as string | undefined;
            const url = directUrl
              ?? (await fetchFreezoneJobResult(project, ref.task_type, ref.job_id)).url;
            useCanvasStore.getState().updateNodeData(nextNodeId, {
              imageUrl: url,
              previewImageUrl: url,
              aspectRatio,
              output_role: 'scene_360_candidate',
              media_kind: 'pano360',
              isGenerating: false,
              generationStartedAt: null,
              generationError: null,
            });

            const viewerPosition = findNodePosition(
              nextNodeId,
              PANO_VIEWER_LAYOUT_WIDTH,
              PANO_VIEWER_LAYOUT_HEIGHT,
            );
            const viewerNodeId = addNode(CANVAS_NODE_TYPES.pano360Viewer, viewerPosition);
            addEdge(nextNodeId, viewerNodeId);
            selectAndFocusCanvasNode(viewerNodeId);
            publishNodeActionSuccess(requestId, nodeId, action, {
              nodeId: nextNodeId,
              viewerNodeId,
              imageUrl: url,
              previewImageUrl: url,
              task_key: ref.task_key,
              job_id: ref.job_id,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            useCanvasStore.getState().updateNodeData(nextNodeId, {
              isGenerating: false,
              generationStartedAt: null,
              generationError: message,
            });
            publishNodeActionError(requestId, nodeId, action, error);
          }
        })();
        return;
      }

      const runAction = GRID_RUN_ACTIONS[action];
      if (!runAction) return;

      const sourceNode = nodes.find((node) => node.id === nodeId) ?? null;
      const imageSource = resolveNodeSourceImageUrl(sourceNode);
      if (!sourceNode || !imageSource) {
        publishNodeActionError(requestId, nodeId, action, i18n.t('canvas.selectedOverlay.noGenerateImage'));
        return;
      }
      const project = readUrl().project;
      if (!project) {
        publishNodeActionError(requestId, nodeId, action, i18n.t('canvas.selectedOverlay.missingProject'));
        return;
      }

      publishNodeActionAccepted(requestId, nodeId, action);
      const label = t(runAction.i18nKey);
      const sourceAspectRatio =
        typeof (sourceNode.data as { aspectRatio?: unknown }).aspectRatio === 'string'
          ? ((sourceNode.data as { aspectRatio?: string }).aspectRatio ?? DEFAULT_ASPECT_RATIO)
          : DEFAULT_ASPECT_RATIO;
      const position = findNodePosition(
        sourceNode.id,
        EXPORT_RESULT_NODE_DEFAULT_WIDTH,
        EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
      );
      const nextNodeId = addNode(
        CANVAS_NODE_TYPES.exportImage,
        position,
        {
          displayName: label,
          imageUrl: null,
          previewImageUrl: null,
          aspectRatio: sourceAspectRatio,
          resultKind: 'generic',
          isGenerating: true,
          generationStartedAt: Date.now(),
        },
      );
      addEdge(sourceNode.id, nextNodeId);
      selectAndFocusCanvasNode(nextNodeId);

      void (async () => {
        try {
          const ref = await submitFreezoneTemplateEdit(project, {
            sourceUrl: imageSource.split('?')[0],
            mode: runAction.mode,
            prompt: label,
          });
          useCanvasStore.getState().updateNodeData(nextNodeId, generationTaskDescriptor(ref));
          const completed = await awaitTaskCompletion(ref.task_key, project);
          const directUrl = completed.result?.['output_url'] as string | undefined;
          const url = directUrl
            ?? (await fetchFreezoneJobResult(project, ref.task_type, ref.job_id)).url;
          useCanvasStore.getState().updateNodeData(nextNodeId, {
            imageUrl: url,
            previewImageUrl: url,
            isGenerating: false,
            generationStartedAt: null,
            generationError: null,
          });
          publishNodeActionSuccess(requestId, nodeId, action, {
            nodeId: nextNodeId,
            imageUrl: url,
            previewImageUrl: url,
            task_key: ref.task_key,
            job_id: ref.job_id,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          useCanvasStore.getState().updateNodeData(nextNodeId, {
            isGenerating: false,
            generationStartedAt: null,
            generationError: message,
          });
          publishNodeActionError(requestId, nodeId, action, error);
        }
      })();
    });
  }, [addEdge, addNode, findNodePosition, nodes, selectAndFocusCanvasNode, t]);

  // When any secondary feature overlay (panorama / multi-angle / lighting / redraw / outpaint / rotate / 3x3 grid) is open,
  // record its target node id. The node's own `selected` operation panel yields accordingly, avoiding overlap with the overlay
  // below the node - feature overlays have higher priority. (Enlarge/upscale expands the panel in place on a newly created node
  // and does not take part in this mutual exclusion.)
  const activeOverlayNodeId =
    multiAngleNodeId
    ?? activeLightEditorNodeId
    ?? derivedMedia?.nodeId
    ?? scene360NodeId
    ?? redrawNodeId
    ?? eraseNodeId
    ?? outpaintNodeId
    ?? rotateNodeId
    ?? resizeNodeId
    ?? null;

  useEffect(() => {
    // Only write when it has an overlay itself, and on cleanup only clear the value it registered - node components (stacked-card album)
    // also register into the same store slot, and unconditionally writing null would wipe their registration (the toolbar /
    // replace-material handle / + spawn button would pile back on top of an album that is still open).
    if (!activeOverlayNodeId) return;
    setActiveOverlayNodeId(activeOverlayNodeId);
    return () => {
      if (useCanvasStore.getState().activeOverlayNodeId === activeOverlayNodeId) {
        setActiveOverlayNodeId(null);
      }
    };
  }, [activeOverlayNodeId, setActiveOverlayNodeId]);

  // Nodes can also register overlays into the store themselves (e.g. an image node expanding a stacked-card album) - the local
  // derived value here cannot see them, and the toolbar/replace-material handle must also respect the store registration,
  // otherwise when the album is dragged React Flow re-selects the node and the toolbar would pile up again.
  const externalOverlayNodeId = useCanvasStore((state) => state.activeOverlayNodeId);
  const effectiveOverlayNodeId = activeOverlayNodeId ?? externalOverlayNodeId;

  return (
    <>
      {selectedNode
        && !rotateNodeId
        && !effectiveOverlayNodeId && (
        <ReactFlowNodeToolbar
          nodeId={selectedNode.id}
          isVisible
          position={Position.Top}
          align={
            nodeHasResourceForToolbar(selectedNode) ? "center" : "start"
          }
          offset={NODE_ID_BADGE_OFFSET}
        >
          <NodeIdBadge nodeId={selectedNode.id} />
        </ReactFlowNodeToolbar>
      )}
      {selectedNode
        && !rotateNodeId
        && !effectiveOverlayNodeId
        && nodeHasResourceForToolbar(selectedNode) && (
        <NodeActionToolbar
          // Remount by node id, ensuring the entrance animation of the top menu replays each time "a node is activated"
          // - otherwise when switching directly between two nodes the component instance is reused and the CSS animation only runs on first mount.
          key={selectedNode.id}
          node={selectedNode}
          onOpenMultiAngleEditor={handleOpenMultiAngleEditor}
          onOpenLightEditor={handleOpenLightEditor}
          onOpenDerivedMedia={(nodeId, kind) => { setDerivedMedia({ nodeId, kind }); clearFlowSelection(); setSelectedNode(null); }}
          onOpenScene360={handleOpenScene360}
          onOpenUpscale={handleOpenUpscale}
          onOpenOutpaint={handleOpenOutpaint}
          onSpawnGridActionNode={handleSpawnGridActionNode}
          onOpenRedraw={handleOpenRedraw}
          onOpenErase={handleOpenErase}
          onOpenRotate={handleOpenRotate}
          onOpenResize={handleOpenResize}
        />
      )}
      {/* Image/video/audio cards produced by frame-by-frame breakdown draw this button in the card's top-right corner
          (NodeMediaReplaceButton), which also takes over the gesture — attaching another external handle here would
          stack two identical upload icons on the same corner. Other nodes (ordinary generation results, imageGen /
          upload / 3D / panorama …) have no in-card position and still use this handle floating outside the node. */}
      {selectedNode &&
        !rotateNodeId &&
        !effectiveOverlayNodeId &&
        !hasInlineCommitButton(selectedNode) && (
          <AssetCommitHandle node={selectedNode} />
        )}
      {multiAngleNode && multiAngleImageSource && (
        <MultiAngleEditorOverlay
          node={multiAngleNode}
          imageSource={multiAngleImageSource}
          onClose={handleCloseMultiAngleEditor}
        />
      )}
      {redrawNode && redrawImageSource && (
        <RedrawOverlay
          node={redrawNode}
          imageSource={redrawImageSource}
          onClose={handleCloseRedraw}
        />
      )}
      {eraseNode && eraseImageSource && (
        <EraseOverlay
          node={eraseNode}
          imageSource={eraseImageSource}
          onClose={handleCloseErase}
        />
      )}
      {derivedMedia && derivedMediaNode && <ImageDerivedOverlay node={derivedMediaNode} kind={derivedMedia.kind} onClose={() => setDerivedMedia(null)} />}
      {scene360Node && scene360ImageSource && (
        <Scene360Overlay
          node={scene360Node}
          imageSource={scene360ImageSource}
          onClose={handleCloseScene360}
        />
      )}
      {upscalePanelNode && (
        <UpscaleEditorOverlay node={upscalePanelNode} />
      )}
      {videoUpscalePanelNode && (
        <VideoUpscaleEditorOverlay node={videoUpscalePanelNode} />
      )}
      {outpaintNode && outpaintImageSource && (
        <OutpaintEditorOverlay
          node={outpaintNode}
          imageSource={outpaintImageSource}
          onClose={handleCloseOutpaint}
        />
      )}
      {resizeNode && resizeImageSource && (
        <ImageResizeOverlay node={resizeNode} imageSource={resizeImageSource}
          onClose={handleCloseResize} onCreated={selectAndFocusCanvasNode} />
      )}
      {rotateNode && rotateImageSource && (
        <RotateEditorOverlay
          node={rotateNode}
          imageSource={rotateImageSource}
          onClose={handleCloseRotate}
        />
      )}
    </>
  );
});

SelectedNodeOverlay.displayName = 'SelectedNodeOverlay';

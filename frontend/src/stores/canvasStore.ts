// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// This uses the default i18next instance (the one `@/i18n` initializes). `@/i18n` itself is not imported,
// because that module also pulls in react-i18next / HttpBackend, and putting it on this widely imported low-level chain
// would make every test that mocks react-i18next blow up at import time.
import i18n from 'i18next';
import { create } from 'zustand';
import {
  type Viewport,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  type Connection,
  type EdgeChange,
  type NodeChange,
} from '@xyflow/react';

import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  DEFAULT_NODE_WIDTH,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  EXPORT_RESULT_NODE_MIN_HEIGHT,
  EXPORT_RESULT_NODE_MIN_WIDTH,
  type ActiveToolDialog,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
  type ExportImageNodeResultKind,
  type NodeToolType,
  type StoryboardExportOptions,
  type StoryboardFrameItem,
  type GroupNodeData,
  isGroupNode,
  isProtectedProjectionGroupNode,
  isStoryboardGroupNode,
  isStoryboardSplitNode,
  isStyleNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  DEFAULT_STORYBOARD_ASPECT,
  computeStoryboardBoardLayout,
  computeStoryboardCell,
  computeStoryboardGridLayout,
  resolveStoryboardCols,
} from '@/features/canvas/domain/storyboardGroup';
import {
  nodeHasSourceHandle,
  nodeHasTargetHandle,
  isUpstreamConnectionAllowed,
} from '@/features/canvas/domain/nodeRegistry';
import {
  EXPORT_RESULT_DISPLAY_NAME,
  isNodeUsingDefaultDisplayName,
  withAutoTitleIndex,
} from '@/features/canvas/domain/nodeDisplay';

/**
 * Copy numbering: if the source node still uses the default name (including numbered ones such as "Text 1") -> drop the title and number it again, to avoid
 * the copy having the same name as the source; if the user has customized the title it is kept as is (a copy with the same name is expected).
 */
function withAutoTitleIndexForClone(
  type: CanvasNodeType,
  data: Partial<CanvasNodeData>,
  existingNodes: ReadonlyArray<{ type?: string | null; data?: unknown }>,
): Partial<CanvasNodeData> {
  if (!isNodeUsingDefaultDisplayName(type, data)) return data;
  const { displayName: _replacedByAutoTitle, ...rest } = data;
  return withAutoTitleIndex(type, rest, existingNodes);
}
import {
  overflowingVideoReferenceEdgeIds,
  videoReferenceConnectionRejection,
} from '@/features/canvas/domain/videoReferenceLimits';
import { videoReferenceEnvelopeForNode } from '@/features/canvas/application/videoReferenceEnvelope';
import {
  planVideoBreakdownGroups,
  type PlanVideoBreakdownGroupsOptions,
  type VideoBreakdownResultLike,
} from '@/features/canvas/application/videoBreakdownGroups';
import {
  type ViewportBookmark,
  type ViewportBookmarks,
  BOOKMARK_SLOT_COUNT,
  createEmptyBookmarks,
  normalizeBookmarks,
} from '@/features/canvas/domain/viewportBookmarks';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import { canvasNodeFactory } from '@/features/canvas/application/canvasServices';
import { resetStyleNodeSyncStates } from '@/features/canvas/application/styleNodeSync';
import { cancelVideoCrop } from '@/features/canvas/application/videoCrop/videoCropInFlight';
import {
  aspectRatioFromImageDimensions,
  ensureAtLeastOneMinEdge,
  resolveMinEdgeFittedSize,
  resolveSizeInsideTargetBox,
} from '@/features/canvas/application/imageNodeSizing';
import {
  validateCandidateBindingRoleCandidate,
  validatePropagatingEdgeCandidate,
} from '@/features/freezone/context/mainlineContext';
import {
  isPresetManagedEdge,
  isPresetManagedNode,
} from '@/features/canvas/domain/mainlineNodeFlags';
import { scopeProjectionGraphIds } from '@/features/freezone/projectionGraphIds';
import {
  planVideoBreakdownGroups,
  type PlanVideoBreakdownGroupsOptions,
  type VideoBreakdownResultLike,
} from '@/features/canvas/application/videoBreakdownGroups';

export type {
  ActiveToolDialog,
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  NodeToolType,
  StoryboardFrameItem,
};

export interface CanvasHistorySnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface CanvasHistoryState {
  past: CanvasHistorySnapshot[];
  future: CanvasHistorySnapshot[];
}

const MAX_HISTORY_STEPS = 50;
const SKILL_NODE_DEFAULT_MEASURED = { width: 380, height: 520 };
const BEAT_CONTEXT_NODE_DEFAULT_MEASURED = { width: 420, height: 560 };
const IMAGE_NODE_VISUAL_MIN_EDGE = 300;
const STORYBOARD_SPLIT_NODE_MIN_WIDTH = 440;
const STORYBOARD_SPLIT_NODE_MAX_WIDTH = 860;
const STORYBOARD_SPLIT_FRAME_TARGET_WIDTH = 150;
const STORYBOARD_SPLIT_FRAME_NOTE_HEIGHT = 40;
const STORYBOARD_SPLIT_NODE_CHROME_HEIGHT = 70;
const STORYBOARD_SPLIT_GRID_GAP = 1;

/**
 * Why the canvas content was last mutated.
 *
 * - `user_edit`     — any normal user-driven mutation (add / move / update node, etc.).
 * - `delete_to_empty` — a user-driven removal that left zero nodes. `useCanvasSync`
 *   treats this as an implicit "manual clear" so autosave can flush the empty
 *   canvas instead of being rejected by the dangerous-empty guard.
 * - `manual_clear`  — `clearCanvas()` was invoked (explicit "clear canvas" UI).
 * - `null`          — fresh hydrate / canvas switch with no edits yet.
 *
 * Persisted only on the client; the backend never sees this enum directly. It
 * is the input to `decideSaveAction` (canvasSyncCore.ts), which converts it
 * into the `save_source` / `allow_empty_overwrite` fields sent over the wire.
 */
export type CanvasMutationSource =
  | "user_edit"
  | "delete_to_empty"
  | "manual_clear";

interface CanvasState {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /**
   * Counts user-driven mutations since the last hydrate (or canvas switch). A
   * value of 0 means "the user has not touched this canvas yet", which lets
   * `useCanvasSync` distinguish a real empty canvas from an accidental
   * HMR/store-reset that produced an empty `nodes` array.
   */
  userEditsSinceHydrate: number;
  /** See `CanvasMutationSource`. Reset to null on hydrate / canvas switch. */
  lastMutationSource: CanvasMutationSource | null;
  /**
   * Set by `clearCanvas()` to signal "the next autosave with empty nodes is
   * intentional". `useCanvasSync` acknowledges it after a successful
   * `manual_clear` save by calling `acknowledgePendingClear()`.
   */
  pendingClearIntent: boolean;
  selectedNodeId: string | null;
  /**
   * The target node id for which the top toolbar opened a secondary feature overlay (panorama / multi-angle / lighting / redraw / outpaint /
   * rotate / 3x3 grid). While an overlay is open, the operation panel a node shows by itself via `selected`
   * (such as the generation panel at the bottom of ImageGenNode) must yield to the overlay - otherwise the two operation areas
   * would overlap below the node. The feature overlay has higher priority.
   */
  activeOverlayNodeId: string | null;
  /** Target node id of the currently open lighting editor. Independent of node selection; clicking the chat panel should not close it. */
  activeLightEditorNodeId: string | null;
  /**
   * The node id currently hovered by the mouse (maintained by Canvas's onNodeMouseEnter/Leave, with a short delay on leave so
   * the buttons do not vanish early when the mouse moves to the floating button bar above the node). Read by "hover to show" overlays such as
   * NodeSpawnPlusOverlay's "+" and NodeSideActionRail's upload/replace button bar.
   */
  hoveredNodeId: string | null;
  /** A one-shot viewport focus request: Canvas calls setCenter after seeing it and then clears it. */
  pendingFocusNodeId: string | null;
  activeToolDialog: ActiveToolDialog | null;
  history: CanvasHistoryState;
  dragHistorySnapshot: CanvasHistorySnapshot | null;
  currentViewport: Viewport;
  canvasViewportSize: { width: number; height: number };
  /** 10 fixed viewport bookmark slots (index 0..9 -> digit 1..9,0). Navigation
   * preference, NOT part of undo history; persisted via canvas metadata. */
  viewportBookmarks: ViewportBookmarks;
  imageViewer: {
    isOpen: boolean;
    currentImageUrl: string | null;
    imageList: string[];
    currentIndex: number;
  };

  onNodesChange: (changes: NodeChange<CanvasNode>[]) => void;
  onEdgesChange: (changes: EdgeChange<CanvasEdge>[]) => void;
  onConnect: (connection: Connection) => void;
  replaceEdges: (edges: CanvasEdge[]) => void;

  setCanvasData: (nodes: CanvasNode[], edges: CanvasEdge[], history?: CanvasHistoryState) => void;
  applyCanvasDataEdit: (nodes: CanvasNode[], edges: CanvasEdge[]) => void;
  hydrateCanvasDraft: (draft: {
    nodes: CanvasNode[];
    edges: CanvasEdge[];
    history?: CanvasHistoryState | null;
    mutation: {
      userEditsSinceHydrate: number;
      lastMutationSource: CanvasMutationSource | null;
      pendingClearIntent: boolean;
    };
  }) => void;
  addNode: (
    type: CanvasNodeType,
    position: { x: number; y: number },
    data?: Partial<CanvasNodeData>
  ) => string;
  addEdge: (source: string, target: string) => string | null;
  addEdgeWithData: (
    source: string,
    target: string,
    data: Record<string, unknown>,
    options?: { id?: string; sourceHandle?: string; targetHandle?: string },
  ) => string | null;
  findNodePosition: (sourceNodeId: string, newNodeWidth: number, newNodeHeight: number) => { x: number; y: number };
  addDerivedUploadNode: (
    sourceNodeId: string,
    imageUrl: string,
    aspectRatio: string,
    previewImageUrl?: string
  ) => string | null;
  addDerivedExportNode: (
    sourceNodeId: string,
    imageUrl: string,
    aspectRatio: string,
    previewImageUrl?: string,
    options?: {
      defaultTitle?: string;
      resultKind?: ExportImageNodeResultKind;
      aspectRatioStrategy?: 'provided' | 'derivedFromSource';
      sizeStrategy?: 'generated' | 'autoMinEdge' | 'matchSource';
      matchSourceNodeSize?: boolean;
    }
  ) => string | null;
  addStoryboardSplitNode: (
    sourceNodeId: string,
    rows: number,
    cols: number,
    frames: StoryboardFrameItem[],
    frameAspectRatio?: string
  ) => string | null;
  /**
   * Clone a node as a result sibling: same type, same params (data merged with
   * `dataOverrides`), and the same upstream connections as the source. Stacked
   * `index` slots below the source. Used by image/video generation to fan out N results
   * when the user picks generation count > 1 (each generation is its own API call).
   */
  duplicateNodeAsSibling: (
    sourceNodeId: string,
    index: number,
    dataOverrides?: Partial<CanvasNodeData>
  ) => string | null;
  /**
   * Batch-duplicate several nodes at once (used by the multi-selection toolbar's
   * "Create copy"). Each clone is stacked one slot below its source, keeps the
   * source's upstream connections, and gets a "- Copy" suffix on its display
   * name. The whole batch is a single undo step, and the new clones become the
   * active selection. Returns the created node ids.
   */
  duplicateNodesAsSiblings: (nodeIds: string[]) => string[];

  /**
   * Turn a batch of panorama screenshots into image nodes laid out in a grid to
   * the right of the source node, wrapped in a single display group. Used by the
   * 360 viewer's 2×2 / 4×3 capture: each frame becomes its own exportImage node
   * (no stitched canvas), and the group is purely a front-end container — no new
   * node type. The whole batch is one undo step; returns the group node id.
   */
  addPanoCaptureGroup: (
    sourceNodeId: string,
    captures: {
      dataUrl: string;
      width: number;
      height: number;
      label: string;
      /** Backend URL once uploaded; falls back to dataUrl for imageUrl when absent. */
      uploadedUrl?: string;
      /** Optional viewer snapshot / render metadata kept on the generated image node. */
      metadata?: Record<string, unknown>;
    }[],
    options?: { cols?: number; groupName?: string }
  ) => string | null;

  /**
   * Land the output of a frame-by-frame breakdown run onto the canvas: storyboard groups / a motion reference group /
   * a music reference group, each wrapped in its own display group with provenance edges back to the breakdown node.
   * A dimension with no output occupies no space. The whole batch is one undo step; returns the created group node
   * ids (empty array when the result carried nothing landable, null when the source node is gone).
   */
  addVideoBreakdownGroups: (
    sourceNodeId: string,
    result: VideoBreakdownResultLike,
    options?: Omit<PlanVideoBreakdownGroupsOptions, 'origin'>
  ) => string[] | null;

  updateNodeData: (
    nodeId: string,
    data: Partial<CanvasNodeData>,
    /** See the parameter of the same name in updateNodeSize. */
    options?: { recordHistory?: boolean },
  ) => void;
  updateNodeSize: (
    nodeId: string,
    size: { width: number; height: number },
    options?: {
      lockManualSize?: boolean;
      data?: Partial<CanvasNodeData>;
      /**
       * Default true: this is a user-undoable change.
       *
       * Pass false for writes that "record a fact the canvas just measured" (the node's main image
       * imageNaturalWidth/Height, see planNaturalSizeRecordWrite): not a single pixel changes on screen, so undoing it
       * is meaningless, and opening an old project triggers dozens at once - if they entered the undo stack,
       * Ctrl+Z would give the user "forget an image's size" and the redo stack would be cleared.
       * It still counts as an edit (trackEdit), because the data has to be saved to the server.
       */
      recordHistory?: boolean;
    },
  ) => void;
  /**
   * Swap a node's `type` in place while keeping its `id` and position. Used
   * when an UploadNode's user picks a video file and the node needs to morph
   * into a VideoNode so the header / toolbar / connectivity match the new
   * resource type. Attached edges survive the swap **unless** the new type
   * makes them illegal (same rules the load-time normalizer applies), in which
   * case they are dropped along with it — one undo restores both.
   */
  convertNodeType: (
    nodeId: string,
    newType: CanvasNodeType,
    dataOverrides?: Partial<CanvasNodeData>
  ) => boolean;
  updateNodePosition: (nodeId: string, position: { x: number; y: number }) => void;
  setNodePositions: (positions: Record<string, { x: number; y: number }>) => void;
  updateStoryboardFrame: (
    nodeId: string,
    frameId: string,
    data: Partial<StoryboardFrameItem>
  ) => void;
  reorderStoryboardFrame: (
    nodeId: string,
    draggedFrameId: string,
    targetFrameId: string
  ) => void;

  deleteNode: (nodeId: string) => void;
  deleteNodes: (nodeIds: string[]) => void;
  groupNodes: (
    nodeIds: string[],
    opts?: {
      label?: string;
      extraPadding?: number;
      padding?: { side: number; top: number; bottom: number };
    }
  ) => string | null;
  /**
   * Auto-grouping after a quick spawn: the source node is not in a group -> create a new group together with the new node; already in
   * a plain group -> merge the new node into that group and grow its bounds; in a storyboard group/projection-protected group -> no grouping.
   * opts.label is the name of the newly created group (e.g. "Image reverse-prompt group"). Returns the group id.
   */
  autoGroupSpawn: (
    sourceNodeId: string,
    spawnedNodeIds: string[],
    opts?: { label?: string }
  ) => string | null;
  /**
   * Merge storyboard group: group nodes into a "storyboard group" whose members are packed into a
   * uniform grid (reading order). Returns the new group id, or null.
   */
  mergeStoryboardGroup: (nodeIds: string[]) => string | null;
  /** Re-configure a storyboard group's grid (aspect / columns / index badge). */
  setStoryboardGroupConfig: (
    groupNodeId: string,
    config: { aspectKey?: string; cols?: number; showIndex?: boolean }
  ) => void;
  /** Move a storyboard member from one grid slot to another (drag-reorder). */
  reorderStoryboardMember: (groupNodeId: string, fromIndex: number, toIndex: number) => void;
  /** Add image members (from upload / history) to a storyboard group's grid. */
  addStoryboardMembers: (
    groupNodeId: string,
    images: { imageUrl: string; previewImageUrl?: string; displayName?: string }[]
  ) => void;
  /** Drop the storyboard behaviour, leaving a plain group with the same members. */
  convertStoryboardGroupToPlain: (groupNodeId: string) => void;
  /**
   * Grow a group's box (and nudge members inward) so it always encloses its
   * children — covers nodes that auto-resize after their image loads, floating
   * headers, etc. Grow-only, so it never fights a manual resize. No-op when the
   * box already fits. Pure layout: no history / autosave churn.
   */
  fitGroupToChildren: (groupNodeId: string) => void;
  /** Rearrange the child nodes in a group in the specified way (horizontal / vertical / grid) and tighten the group frame. */
  arrangeGroupChildren: (
    groupNodeId: string,
    mode: 'horizontal' | 'vertical' | 'grid',
  ) => void;
  ungroupNode: (groupNodeId: string) => boolean;
  deleteEdge: (edgeId: string) => void;
  setSelectedNode: (nodeId: string | null) => void;
  setActiveOverlayNodeId: (nodeId: string | null) => void;
  setActiveLightEditorNodeId: (nodeId: string | null) => void;
  setHoveredNodeId: (nodeId: string | null) => void;
  /** Request that the viewport focus on the target node; Canvas resets it through clearPendingFocus when done. */
  requestFocusNode: (nodeId: string) => void;
  clearPendingFocus: () => void;

  openToolDialog: (dialog: ActiveToolDialog) => void;
  closeToolDialog: () => void;
  setViewportState: (viewport: Viewport) => void;
  setViewportBookmark: (index: number, bookmark: ViewportBookmark | null) => void;
  clearViewportBookmarks: () => void;
  hydrateViewportBookmarks: (list: unknown) => void;
  setCanvasViewportSize: (size: { width: number; height: number }) => void;
  openImageViewer: (imageUrl: string, imageList?: string[]) => void;
  closeImageViewer: () => void;
  navigateImageViewer: (direction: 'prev' | 'next') => void;

  undo: () => boolean;
  redo: () => boolean;
  /**
   * Replace the in-memory undo/redo stacks — used to restore the history that
   * was mirrored to localStorage so undo survives a page refresh. Touches only
   * `history`, never nodes/edges, so it cannot trigger a content save.
   */
  restoreHistory: (history: CanvasHistoryState) => void;

  clearCanvas: () => void;
  /**
   * Clear `pendingClearIntent` after `useCanvasSync` has successfully flushed
   * a `manual_clear` save. The "intent" is one-shot — once consumed it must
   * not influence later autosaves.
   */
  acknowledgePendingClear: () => void;
}

/**
 * Build the patch that records a user-driven edit. Spread into every
 * `set((state) => ({ ... }))` that mutates `nodes` / `edges` so that
 * `useCanvasSync` can tell intentional edits apart from HMR / store-reset
 * accidents. The default source is `"user_edit"`; deletions that empty the
 * canvas pass `"delete_to_empty"`, and `clearCanvas` passes `"manual_clear"`.
 */
function trackEdit(
  state: Pick<CanvasState, "userEditsSinceHydrate">,
  source: CanvasMutationSource = "user_edit",
): Pick<CanvasState, "userEditsSinceHydrate" | "lastMutationSource"> {
  return {
    userEditsSinceHydrate: state.userEditsSinceHydrate + 1,
    lastMutationSource: source,
  };
}

/** True when `nextNodeCount === 0 && prevNodeCount > 0` — used to flag a removal that empties the canvas. */
function isDeleteToEmpty(prevNodeCount: number, nextNodeCount: number): boolean {
  return prevNodeCount > 0 && nextNodeCount === 0;
}

function normalizeHandleId(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed === 'null' || trimmed === 'undefined') {
    return undefined;
  }
  return trimmed;
}

function defaultSkillSourceHandle(node: CanvasNode, edge: CanvasEdge): string | undefined {
  if (node.type !== CANVAS_NODE_TYPES.skill) {
    return undefined;
  }
  const skillId = (node.data as { skill_id?: unknown }).skill_id;
  const role = (edge.data as { role?: unknown } | undefined)?.role;
  if (skillId === 'freezone.scene_360' && role === 'scene_360_canonical') {
    return 'scene_360_candidate';
  }
  return undefined;
}

function isNoReferenceEdge(edge: CanvasEdge): boolean {
  const targetHandle =
    typeof edge.targetHandle === 'string' && edge.targetHandle.trim()
      ? edge.targetHandle.trim()
      : '';
  if (targetHandle === 'identity:__NO_CHARACTER__' || targetHandle === 'prop:__NO_PROP__') {
    return true;
  }
  const data = edge.data;
  const referenceTarget =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).reference_target
      : undefined;
  if (!referenceTarget || typeof referenceTarget !== 'object' || Array.isArray(referenceTarget)) {
    return false;
  }
  const target = referenceTarget as Record<string, unknown>;
  return target.identity_id === '__NO_CHARACTER__' || target.prop_id === '__NO_PROP__';
}

function isNoReferenceNode(node: CanvasNode): boolean {
  const data = node.data as {
    label?: unknown;
    displayName?: unknown;
    content?: unknown;
    prompt?: unknown;
    reference_target?: unknown;
    __freezone_source?: unknown;
  };
  if (
    data.label === '__NO_CHARACTER__' ||
    data.label === '__NO_PROP__' ||
    data.displayName === '__NO_CHARACTER__' ||
    data.displayName === '__NO_PROP__' ||
    data.content === '__NO_CHARACTER__' ||
    data.content === '__NO_PROP__' ||
    data.prompt === '__NO_CHARACTER__' ||
    data.prompt === '__NO_PROP__'
  ) {
    return true;
  }
  const referenceTarget =
    data.reference_target && typeof data.reference_target === 'object' && !Array.isArray(data.reference_target)
      ? (data.reference_target as Record<string, unknown>)
      : null;
  if (referenceTarget?.identity_id === '__NO_CHARACTER__' || referenceTarget?.prop_id === '__NO_PROP__') {
    return true;
  }
  const freezoneSource =
    data.__freezone_source && typeof data.__freezone_source === 'object' && !Array.isArray(data.__freezone_source)
      ? (data.__freezone_source as Record<string, unknown>)
      : null;
  const meta =
    freezoneSource?.meta && typeof freezoneSource.meta === 'object' && !Array.isArray(freezoneSource.meta)
      ? (freezoneSource.meta as Record<string, unknown>)
      : null;
  return meta?.identity_id === '__NO_CHARACTER__' || meta?.prop_id === '__NO_PROP__';
}

function edgeDataRecord(edge: CanvasEdge): Record<string, unknown> {
  return edge.data && typeof edge.data === 'object' && !Array.isArray(edge.data)
    ? (edge.data as Record<string, unknown>)
    : {};
}

function sourceRolePriority(node: CanvasNode | undefined): number {
  const data = node?.data as { __freezone_source?: unknown } | undefined;
  const source =
    data?.__freezone_source &&
    typeof data.__freezone_source === 'object' &&
    !Array.isArray(data.__freezone_source)
      ? (data.__freezone_source as Record<string, unknown>)
      : null;
  const role = typeof source?.role === 'string' ? source.role.trim() : '';
  if (role === 'character_identity' || role === 'prop_reference') {
    return 0;
  }
  if (role === 'character_portrait') {
    return 1;
  }
  return 2;
}

function referenceEdgeKey(edge: CanvasEdge): string | null {
  const data = edgeDataRecord(edge);
  const role = String(data.role || '').trim();
  if (role !== 'identity' && role !== 'prop') {
    return null;
  }
  const targetHandle = typeof edge.targetHandle === 'string' ? edge.targetHandle.trim() : '';
  if (!targetHandle.startsWith(`${role}:`)) {
    return null;
  }
  const referenceId = targetHandle.slice(role.length + 1).trim();
  if (!referenceId) {
    return null;
  }
  return `${edge.target}:${role}:${referenceId}`;
}

function dedupeReferenceInputEdges(edges: CanvasEdge[], nodeMap: ReadonlyMap<string, CanvasNode>): CanvasEdge[] {
  const selectedIndexByKey = new Map<string, number>();
  const droppedIndexes = new Set<number>();
  for (const [index, edge] of edges.entries()) {
    const key = referenceEdgeKey(edge);
    if (!key) {
      continue;
    }
    const existingIndex = selectedIndexByKey.get(key);
    if (existingIndex === undefined) {
      selectedIndexByKey.set(key, index);
      continue;
    }
    const currentPriority = sourceRolePriority(nodeMap.get(edge.source));
    const existingPriority = sourceRolePriority(nodeMap.get(edges[existingIndex].source));
    if (currentPriority < existingPriority) {
      droppedIndexes.add(existingIndex);
      selectedIndexByKey.set(key, index);
    } else {
      droppedIndexes.add(index);
    }
  }
  return edges.filter((_edge, index) => !droppedIndexes.has(index));
}

function normalizeEdgesWithNodes(rawEdges: CanvasEdge[], nodes: CanvasNode[]): CanvasEdge[] {
  const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));

  const normalizedEdges = rawEdges
    .filter((edge) => {
      if (isNoReferenceEdge(edge)) {
        return false;
      }
      const sourceNode = nodeMap.get(edge.source);
      const targetNode = nodeMap.get(edge.target);
      if (!sourceNode || !targetNode) {
        return false;
      }
      if (!nodeHasSourceHandle(sourceNode.type) || !nodeHasTargetHandle(targetNode.type)) {
        return false;
      }
      // Drop legacy edges that violate the upstream type rules (e.g. audio <- non-text).
      return isUpstreamConnectionAllowed(sourceNode.type, targetNode.type);
    })
    .map((edge) => ({
      ...edge,
      type: edge.type ?? 'disconnectableEdge',
      sourceHandle:
        normalizeHandleId((edge as CanvasEdge & { sourceHandle?: unknown }).sourceHandle) ??
        defaultSkillSourceHandle(nodeMap.get(edge.source) as CanvasNode, edge) ??
        'source',
      targetHandle:
        normalizeHandleId((edge as CanvasEdge & { targetHandle?: unknown }).targetHandle) ?? 'target',
    }));

  const referenceDedupedEdges = dedupeReferenceInputEdges(normalizedEdges, nodeMap);
  const edgeIndexById = new Map<string, number>();
  const dedupedEdges: CanvasEdge[] = [];
  for (const edge of referenceDedupedEdges) {
    const existingIndex = edgeIndexById.get(edge.id);
    if (existingIndex === undefined) {
      edgeIndexById.set(edge.id, dedupedEdges.length);
      dedupedEdges.push(edge);
      continue;
    }
    dedupedEdges[existingIndex] = edge;
  }
  return dedupedEdges;
}

function normalizeNodes(rawNodes: CanvasNode[]): CanvasNode[] {
  const normalizedNodes = rawNodes
    .map((node) => {
      if (!Object.values(CANVAS_NODE_TYPES).includes(node.type as CanvasNodeType)) {
        return null;
      }

      const definition = nodeCatalog.getDefinition(node.type as CanvasNodeType);
      const mergedData = {
        ...definition.createDefaultData(),
        ...(node.data as Partial<CanvasNodeData>),
      } as CanvasNodeData;

      if (node.type === CANVAS_NODE_TYPES.storyboardSplit) {
        const frames = (mergedData as { frames?: StoryboardFrameItem[] }).frames ?? [];
        const firstFrameAspectRatio = frames.find((frame) => typeof frame.aspectRatio === 'string')
          ?.aspectRatio;
        const normalizedFrameAspectRatio =
          (typeof (mergedData as { frameAspectRatio?: unknown }).frameAspectRatio === 'string'
            ? (mergedData as { frameAspectRatio?: string }).frameAspectRatio
            : null) ??
          firstFrameAspectRatio ??
          DEFAULT_ASPECT_RATIO;

        (mergedData as { frameAspectRatio: string }).frameAspectRatio = normalizedFrameAspectRatio;
        (mergedData as { frames: StoryboardFrameItem[] }).frames = frames.map((frame, index) => ({
          id: frame.id,
          imageUrl: frame.imageUrl ?? null,
          previewImageUrl: frame.previewImageUrl ?? null,
          aspectRatio:
            typeof frame.aspectRatio === 'string'
              ? frame.aspectRatio
              : normalizedFrameAspectRatio,
          note: frame.note ?? '',
          order: Number.isFinite(frame.order) ? frame.order : index,
        }));

        const rawExportOptions = (mergedData as { exportOptions?: Partial<StoryboardExportOptions> })
          .exportOptions;
        const rawFontSize = Number.isFinite(rawExportOptions?.fontSize)
          ? Number(rawExportOptions?.fontSize)
          : createDefaultStoryboardExportOptions().fontSize;
        const normalizedFontSize = rawFontSize > 20
          ? Math.round(rawFontSize / 6)
          : rawFontSize;
        (mergedData as { exportOptions: StoryboardExportOptions }).exportOptions = {
          ...createDefaultStoryboardExportOptions(),
          ...(rawExportOptions ?? {}),
          fontSize: Math.max(1, Math.min(20, Math.round(normalizedFontSize))),
        };
      }

      if ('aspectRatio' in mergedData && !mergedData.aspectRatio) {
        mergedData.aspectRatio = DEFAULT_ASPECT_RATIO;
      }

      // Keep generation state only when there is a recoverable handle: either a
      // canvasAiGateway job id (Canvas.tsx export poll) or a freezone task key
      // (resumeNodeGeneration). Otherwise an interrupted run would spin forever.
      if ('isGenerating' in mergedData && mergedData.isGenerating) {
        const generationJobId =
          typeof (mergedData as { generationJobId?: unknown }).generationJobId === 'string'
            ? (mergedData as { generationJobId?: string }).generationJobId?.trim() ?? ''
            : '';
        const generationTaskKey =
          typeof (mergedData as { generationTaskKey?: unknown }).generationTaskKey === 'string'
            ? (mergedData as { generationTaskKey?: string }).generationTaskKey?.trim() ?? ''
            : '';
        const skillRunId =
          typeof (mergedData as { skillRunId?: unknown }).skillRunId === 'string'
            ? (mergedData as { skillRunId?: string }).skillRunId?.trim() ?? ''
            : '';
        if (!generationJobId && !generationTaskKey && !skillRunId) {
          mergedData.isGenerating = false;
          if ('generationStartedAt' in mergedData) {
            mergedData.generationStartedAt = null;
          }
        }
      }

      // Breakdown has no resume mechanism (no task_key is persisted at submit time), so the in-progress flag is
      // always reset - the "start breakdown" button is disabled by isBreakingDown, and nothing would ever flip a
      // persisted true back to false, leaving the node only recoverable by deleting and recreating it.
      if ('isBreakingDown' in mergedData && mergedData.isBreakingDown) {
        mergedData.isBreakingDown = false;
        if ('breakdownStartedAt' in mergedData) {
          mergedData.breakdownStartedAt = null;
        }
      }

      // Frame crop likewise has no resume mechanism: the box / ratio live only in component-local state (see the
      // VideoNode comment), so a persisted isCropMode: true would reopen with no box and no in-flight request to
      // reattach to. Always reset it to closed; isClipMode / subtitleEraseMode / isExtendPickMode are unaffected.
      if ('isCropMode' in mergedData && mergedData.isCropMode) {
        mergedData.isCropMode = false;
      }

      const normalizedNode = {
        ...node,
        type: node.type as CanvasNodeType,
        data: mergedData,
      } as CanvasNode;

      if (node.type === CANVAS_NODE_TYPES.skill && !node.measured) {
        normalizedNode.measured = SKILL_NODE_DEFAULT_MEASURED;
      } else if (node.type === CANVAS_NODE_TYPES.beatContext && !node.measured) {
        normalizedNode.measured = BEAT_CONTEXT_NODE_DEFAULT_MEASURED;
      }

      return isNoReferenceNode(normalizedNode) ? null : normalizedNode;
    })
    .filter((node): node is CanvasNode => Boolean(node));
  return sortParentNodesBeforeChildren(detachMissingParents(dedupeNodesById(normalizedNodes)));
}

function nodeHydratePriority(node: CanvasNode): number {
  const data = node.data && typeof node.data === 'object' && !Array.isArray(node.data)
    ? (node.data as Record<string, unknown>)
    : {};
  if (
    data.preset_managed === true ||
    data.projection_archived === true ||
    (typeof data.projection_key === 'string' && data.projection_key.trim())
  ) {
    return 2;
  }
  return 1;
}

function dedupeNodesById(nodes: CanvasNode[]): CanvasNode[] {
  const order: string[] = [];
  const indexById = new Map<string, number>();
  const deduped: CanvasNode[] = [];
  for (const node of nodes) {
    const existingIndex = indexById.get(node.id);
    if (existingIndex === undefined) {
      indexById.set(node.id, deduped.length);
      order.push(node.id);
      deduped.push(node);
      continue;
    }
    const existing = deduped[existingIndex];
    if (nodeHydratePriority(node) >= nodeHydratePriority(existing)) {
      deduped[existingIndex] = node;
    }
  }
  return order.map((id) => deduped[indexById.get(id)!]);
}

function detachMissingParents(nodes: CanvasNode[]): CanvasNode[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  return nodes.map((node) => {
    if (!node.parentId || nodeIds.has(node.parentId)) {
      return node;
    }
    return {
      ...node,
      parentId: undefined,
      extent: undefined,
    };
  });
}

function sortParentNodesBeforeChildren(nodes: CanvasNode[]): CanvasNode[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const originalIndex = new Map(nodes.map((node, index) => [node.id, index] as const));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const sorted: CanvasNode[] = [];

  const visit = (node: CanvasNode) => {
    if (visited.has(node.id)) return;
    if (visiting.has(node.id)) {
      sorted.push(node);
      visited.add(node.id);
      return;
    }
    visiting.add(node.id);
    if (node.parentId) {
      const parent = nodeById.get(node.parentId);
      if (parent) {
        visit(parent);
      }
    }
    visiting.delete(node.id);
    if (!visited.has(node.id)) {
      sorted.push(node);
      visited.add(node.id);
    }
  };

  for (const node of [...nodes].sort((left, right) =>
    (originalIndex.get(left.id) ?? 0) - (originalIndex.get(right.id) ?? 0)
  )) {
    visit(node);
  }
  return sorted;
}

function normalizeCanvasData(
  rawNodes: CanvasNode[],
  rawEdges: CanvasEdge[],
): CanvasHistorySnapshot {
  const scoped = scopeProjectionGraphIds(rawNodes, rawEdges);
  const normalizedNodes = normalizeNodes(scoped.nodes);
  return {
    nodes: normalizedNodes,
    edges: normalizeEdgesWithNodes(scoped.edges, normalizedNodes),
  };
}

function normalizeHistory(history?: CanvasHistoryState): CanvasHistoryState {
  if (!history) {
    return { past: [], future: [] };
  }

  const normalizeSnapshot = (snapshot: CanvasHistorySnapshot): CanvasHistorySnapshot => {
    return normalizeCanvasData(snapshot.nodes, snapshot.edges);
  };

  return {
    past: history.past.slice(-MAX_HISTORY_STEPS).map(normalizeSnapshot),
    future: history.future.slice(-MAX_HISTORY_STEPS).map(normalizeSnapshot),
  };
}

function createSnapshot(nodes: CanvasNode[], edges: CanvasEdge[]): CanvasHistorySnapshot {
  return { nodes, edges };
}

function collectNodeIdsWithDescendants(nodes: CanvasNode[], seedIds: string[]): Set<string> {
  const deleteSet = new Set(seedIds);
  let changed = true;

  while (changed) {
    changed = false;
    for (const node of nodes) {
      if (!node.parentId || deleteSet.has(node.id)) {
        continue;
      }
      if (deleteSet.has(node.parentId)) {
        deleteSet.add(node.id);
        changed = true;
      }
    }
  }

  return deleteSet;
}

// Nodes that are unmeasured and have no explicit size (just spawned, not yet rendered) are estimated with the per-type design size, aligned with
// DEFAULT_WIDTH/HEIGHT inside each node component. Otherwise groupNodes / fitGroupToChildren
// would underestimate large nodes (e.g. the 580x380 video node) as 320x200, and the computed group bounds could not wrap the members.
const FALLBACK_NODE_SIZES: Partial<Record<string, { width: number; height: number }>> = {
  [CANVAS_NODE_TYPES.video]: { width: 580, height: 380 },
  [CANVAS_NODE_TYPES.textAnnotation]: { width: 440, height: 320 },
  [CANVAS_NODE_TYPES.audio]: { width: 480, height: 210 },
  [CANVAS_NODE_TYPES.upload]: { width: 320, height: 350 },
};

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const fallback = (node.type && FALLBACK_NODE_SIZES[node.type]) || undefined;
  return {
    width:
      typeof node.measured?.width === 'number'
        ? node.measured.width
        : typeof node.width === 'number'
          ? node.width
          : (fallback?.width ?? DEFAULT_NODE_WIDTH),
    height:
      typeof node.measured?.height === 'number'
        ? node.measured.height
        : typeof node.height === 'number'
          ? node.height
          : (fallback?.height ?? 200),
  };
}

function isImageAutoResizableType(type: CanvasNodeType): boolean {
  return type === CANVAS_NODE_TYPES.upload
    || type === CANVAS_NODE_TYPES.imageEdit
    || type === CANVAS_NODE_TYPES.exportImage
    || type === CANVAS_NODE_TYPES.imageGen
    || type === CANVAS_NODE_TYPES.video;
}

function withManualSizeLock(node: CanvasNode): CanvasNode {
  const nodeData = node.data as CanvasNodeData & {
    isSizeManuallyAdjusted?: boolean;
    aspectRatio?: string;
  };

  // When resizing ends, snap the node frame back to the image's true ratio: images are shown with object-contain, and once the node's
  // aspect ratio deviates from the image ratio (free resize, or old nodes historically stretched and saved) the container
  // background shows as black bars. Snapping to "the largest size keeping the image ratio within the resized frame" removes them.
  const aspectRatio = typeof nodeData.aspectRatio === 'string' ? nodeData.aspectRatio : '';
  const currentWidth =
    (typeof node.width === 'number' ? node.width : null)
    ?? (typeof node.measured?.width === 'number' ? node.measured.width : null)
    ?? (typeof node.style?.width === 'number' ? node.style.width : null);
  const currentHeight =
    (typeof node.height === 'number' ? node.height : null)
    ?? (typeof node.measured?.height === 'number' ? node.measured.height : null)
    ?? (typeof node.style?.height === 'number' ? node.style.height : null);

  let snapped: { width: number; height: number } | null = null;
  if (aspectRatio && typeof currentWidth === 'number' && typeof currentHeight === 'number') {
    const fitted = resolveSizeInsideTargetBox(aspectRatio, {
      width: currentWidth,
      height: currentHeight,
    });
    if (Math.abs(fitted.width - currentWidth) > 1 || Math.abs(fitted.height - currentHeight) > 1) {
      snapped = fitted;
    }
  }

  if (nodeData.isSizeManuallyAdjusted && !snapped) {
    return node;
  }

  return {
    ...node,
    ...(snapped
      ? {
          width: snapped.width,
          height: snapped.height,
          style: { ...(node.style ?? {}), width: snapped.width, height: snapped.height },
        }
      : {}),
    data: {
      ...node.data,
      isSizeManuallyAdjusted: true,
    } as CanvasNodeData,
  };
}

function resolveAutoImageNodeDimensions(
  aspectRatio: string,
  options?: {
    minWidth?: number;
    minHeight?: number;
  }
): { width: number; height: number } {
  const minWidth = options?.minWidth ?? EXPORT_RESULT_NODE_MIN_WIDTH;
  const minHeight = options?.minHeight ?? EXPORT_RESULT_NODE_MIN_HEIGHT;
  return resolveMinEdgeFittedSize(aspectRatio, { minWidth, minHeight });
}

function resolveGeneratedImageNodeDimensions(
  aspectRatio: string,
  options?: {
    minWidth?: number;
    minHeight?: number;
  }
): { width: number; height: number } {
  const size = resolveSizeInsideTargetBox(aspectRatio, {
    width: EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    height: EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  });
  const minWidth = options?.minWidth ?? IMAGE_NODE_VISUAL_MIN_EDGE;
  const minHeight = options?.minHeight ?? IMAGE_NODE_VISUAL_MIN_EDGE;

  return ensureAtLeastOneMinEdge(size, { minWidth, minHeight });
}

function parseAspectRatioValue(aspectRatio: string | undefined): number {
  const [rawWidth = "1", rawHeight = "1"] = (aspectRatio || DEFAULT_ASPECT_RATIO).split(":");
  const width = Number(rawWidth);
  const height = Number(rawHeight);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1;
  }

  return width / height;
}

function resolveStoryboardSplitNodeDimensions(
  rows: number,
  cols: number,
  frameAspectRatio: string | undefined
): { width: number; height: number } {
  const safeRows = Math.max(1, Math.floor(rows));
  const safeCols = Math.max(1, Math.floor(cols));
  const width = Math.round(Math.max(
    STORYBOARD_SPLIT_NODE_MIN_WIDTH,
    Math.min(
      STORYBOARD_SPLIT_NODE_MAX_WIDTH,
      safeCols * STORYBOARD_SPLIT_FRAME_TARGET_WIDTH + (safeCols - 1) * STORYBOARD_SPLIT_GRID_GAP + 16
    )
  ));
  const contentWidth = Math.max(1, width - 16);
  const frameWidth = Math.max(
    1,
    (contentWidth - (safeCols - 1) * STORYBOARD_SPLIT_GRID_GAP) / safeCols
  );
  const frameImageHeight = frameWidth / parseAspectRatioValue(frameAspectRatio);
  const frameHeight = frameImageHeight + STORYBOARD_SPLIT_FRAME_NOTE_HEIGHT;
  const gridHeight = safeRows * frameHeight + (safeRows - 1) * STORYBOARD_SPLIT_GRID_GAP;
  const height = Math.round(Math.max(
    320,
    Math.min(1600, gridHeight + STORYBOARD_SPLIT_NODE_CHROME_HEIGHT)
  ));

  return { width, height };
}

function resolveDerivedAspectRatio(
  sourceNode: CanvasNode | undefined,
  fallbackAspectRatio: string
): string {
  if (!sourceNode) {
    return fallbackAspectRatio;
  }

  if (sourceNode.type === CANVAS_NODE_TYPES.storyboardGen) {
    const data = sourceNode.data as { requestAspectRatio?: string; aspectRatio?: string };
    const preferred = data.requestAspectRatio && data.requestAspectRatio !== 'auto'
      ? data.requestAspectRatio
      : data.aspectRatio;
    return preferred || fallbackAspectRatio;
  }

  if (sourceNode.type === CANVAS_NODE_TYPES.storyboardSplit) {
    const data = sourceNode.data as { frameAspectRatio?: string; aspectRatio?: string };
    return data.frameAspectRatio || data.aspectRatio || fallbackAspectRatio;
  }

  if (sourceNode.type === CANVAS_NODE_TYPES.imageEdit) {
    const data = sourceNode.data as { requestAspectRatio?: string; aspectRatio?: string };
    const preferred = data.requestAspectRatio && data.requestAspectRatio !== 'auto'
      ? data.requestAspectRatio
      : data.aspectRatio;
    return preferred || fallbackAspectRatio;
  }

  const imageLikeAspect = (sourceNode.data as { aspectRatio?: string }).aspectRatio;
  return imageLikeAspect || fallbackAspectRatio;
}

function maybeApplyImageAutoResize(node: CanvasNode, patch: Partial<CanvasNodeData>): CanvasNode {
  if (!isImageAutoResizableType(node.type)) {
    return node;
  }

  const isVideo = node.type === CANVAS_NODE_TYPES.video;
  const nodeData = node.data as CanvasNodeData & {
    imageUrl?: string | null;
    videoUrl?: string | null;
    aspectRatio?: string;
    widthPx?: number;
    heightPx?: number;
    isSizeManuallyAdjusted?: boolean;
  };
  const patchData = patch as Partial<CanvasNodeData> & {
    imageUrl?: string | null;
    videoUrl?: string | null;
    aspectRatio?: string;
    widthPx?: number;
    heightPx?: number;
    isSizeManuallyAdjusted?: boolean;
  };

  // Video uses widthPx/heightPx/aspectRatio as triggers - these only update after the <video> element
  // gets its metadata, avoiding a wrong resize with the default aspectRatio
  // when videoUrl exists but the metadata is not ready.
  const hasImageRelatedChange = isVideo
    ? ('aspectRatio' in patchData || 'widthPx' in patchData || 'heightPx' in patchData)
    : ('imageUrl' in patchData || 'previewImageUrl' in patchData || 'aspectRatio' in patchData);
  if (!hasImageRelatedChange) {
    return node;
  }

  const isSizeManuallyAdjusted = patchData.isSizeManuallyAdjusted ?? nodeData.isSizeManuallyAdjusted ?? false;
  if (isSizeManuallyAdjusted) {
    return node;
  }

  // Do not change the size without real media content - videoUrl for video and imageUrl for image serve as the "loaded" signal.
  const nextAssetUrl = isVideo
    ? (patchData.videoUrl ?? nodeData.videoUrl)
    : (patchData.imageUrl ?? nodeData.imageUrl);
  if (typeof nextAssetUrl !== 'string' || nextAssetUrl.trim().length === 0) {
    return node;
  }

  // The display ratio of a video node should follow the video's real pixels (widthPx/heightPx), not the generation preset
  // aspectRatio (which is only the ratio wanted for "the next generation" and may differ from the pixel ratio of the existing video
  // - e.g. a 9:16 source video with a 16:9 preset, otherwise the node would be stretched to 16:9 and give the video
  // black bars). Fall back to the preset aspectRatio when pixels are unavailable.
  const presetAspectRatio = patchData.aspectRatio ?? nodeData.aspectRatio ?? DEFAULT_ASPECT_RATIO;
  const videoPixelAspectRatio = isVideo
    ? (() => {
        const w = patchData.widthPx ?? nodeData.widthPx;
        const h = patchData.heightPx ?? nodeData.heightPx;
        return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0
          ? aspectRatioFromImageDimensions(w, h)
          : null;
      })()
    : null;
  const nextAspectRatio = videoPixelAspectRatio ?? presetAspectRatio;
  // Each node type's internal MIN_WIDTH / MIN_HEIGHT decides whether the width /
  // height React Flow gives it will be clamped - align directly with the node's own lower bound here, otherwise the size the store computes
  // would be clamped again by the node component and the ratio stretched into a square.
  const resizeMins = (() => {
    if (node.type === CANVAS_NODE_TYPES.exportImage) {
      return { minWidth: EXPORT_RESULT_NODE_MIN_WIDTH, minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT };
    }
    if (node.type === CANVAS_NODE_TYPES.video) {
      return { minWidth: 480, minHeight: 280 };
    }
    if (node.type === CANVAS_NODE_TYPES.imageGen) {
      return { minWidth: 480, minHeight: 260 };
    }
    return undefined;
  })();
  const nextSize = resizeMins
    ? resolveAutoImageNodeDimensions(nextAspectRatio, resizeMins)
    : resolveAutoImageNodeDimensions(nextAspectRatio);

  return {
    ...node,
    width: nextSize.width,
    height: nextSize.height,
    style: {
      ...(node.style ?? {}),
      width: nextSize.width,
      height: nextSize.height,
    },
  };
}


function pruneEmptyGroupNodes(nodes: CanvasNode[], protectedIds: Set<string>): CanvasNode[] {
  let nextNodes = nodes;
  let changed = true;

  while (changed) {
    changed = false;
    const parentIds = new Set(
      nextNodes
        .map((node) => node.parentId)
        .filter((parentId): parentId is string => Boolean(parentId))
    );
    const emptyGroupIds = new Set(
      nextNodes
        .filter(
          (node) =>
            node.type === CANVAS_NODE_TYPES.group &&
            !protectedIds.has(node.id) &&
            !isPresetManagedNode(node) &&
            !parentIds.has(node.id)
        )
        .map((node) => node.id)
    );

    if (emptyGroupIds.size > 0) {
      changed = true;
      nextNodes = nextNodes.filter((node) => !emptyGroupIds.has(node.id));
    }
  }

  return nextNodes;
}

export function resolveAbsolutePosition(
  node: CanvasNode,
  nodeMap: Map<string, CanvasNode>
): { x: number; y: number } {
  let x = node.position.x;
  let y = node.position.y;
  let currentParentId = node.parentId;
  const visited = new Set<string>();

  while (currentParentId && !visited.has(currentParentId)) {
    visited.add(currentParentId);
    const parent = nodeMap.get(currentParentId);
    if (!parent) {
      break;
    }
    x += parent.position.x;
    y += parent.position.y;
    currentParentId = parent.parentId;
  }

  return { x, y };
}

/**
 * Undo the edge changes mergeStoryboardGroup made: re-anchor edges that were
 * re-pointed onto the group back to their original member, and reveal the hidden
 * internal (member ↔ member) edges. Used by ungroup / convert-to-plain.
 */
function restoreStoryboardEdges(
  edges: CanvasEdge[],
  groupNodeId: string,
  childIds: Set<string>
): CanvasEdge[] {
  return edges.map((edge) => {
    let next = edge;
    const data = next.data as Record<string, unknown> | undefined;
    if (next.source === groupNodeId && typeof data?.__sbOrigSource === 'string') {
      const { __sbOrigSource, ...restData } = data;
      next = { ...next, source: __sbOrigSource, data: restData };
    }
    const data2 = next.data as Record<string, unknown> | undefined;
    if (next.target === groupNodeId && typeof data2?.__sbOrigTarget === 'string') {
      const { __sbOrigTarget, ...restData } = data2;
      next = { ...next, target: __sbOrigTarget, data: restData };
    }
    if ((childIds.has(next.source) || childIds.has(next.target)) && next.hidden) {
      next = { ...next, hidden: false };
    }
    return next;
  });
}

function pushSnapshot(
  snapshots: CanvasHistorySnapshot[],
  snapshot: CanvasHistorySnapshot
): CanvasHistorySnapshot[] {
  const last = snapshots[snapshots.length - 1];
  if (last && last.nodes === snapshot.nodes && last.edges === snapshot.edges) {
    return snapshots;
  }

  const next = [...snapshots, snapshot];
  if (next.length > MAX_HISTORY_STEPS) {
    next.shift();
  }
  return next;
}

function getDerivedNodePosition(nodes: CanvasNode[], sourceNodeId: string): { x: number; y: number } {
  const sourceNode = nodes.find((node) => node.id === sourceNodeId);
  if (!sourceNode) {
    return { x: 100, y: 100 };
  }

  return {
    x: sourceNode.position.x + DEFAULT_NODE_WIDTH + 100,
    y: sourceNode.position.y,
  };
}

function resolveSelectedNodeId(selectedNodeId: string | null, nodes: CanvasNode[]): string | null {
  if (!selectedNodeId) {
    return null;
  }
  return nodes.some((node) => node.id === selectedNodeId) ? selectedNodeId : null;
}

function resolveActiveToolDialog(
  activeToolDialog: ActiveToolDialog | null,
  nodes: CanvasNode[]
): ActiveToolDialog | null {
  if (!activeToolDialog) {
    return null;
  }
  return nodes.some((node) => node.id === activeToolDialog.nodeId) ? activeToolDialog : null;
}

function createDefaultStoryboardExportOptions(): StoryboardExportOptions {
  return {
    showFrameIndex: false,
    showFrameNote: false,
    notePlacement: 'overlay',
    imageFit: 'cover',
    frameIndexPrefix: 'S',
    cellGap: 8,
    outerPadding: 0,
    fontSize: 4,
    backgroundColor: '#0f1115',
    textColor: '#f8fafc',
  };
}

export const useCanvasStore = create<CanvasState>((set, get) => ({
  nodes: [],
  edges: [],
  userEditsSinceHydrate: 0,
  lastMutationSource: null,
  pendingClearIntent: false,
  selectedNodeId: null,
  activeOverlayNodeId: null,
  activeLightEditorNodeId: null,
  hoveredNodeId: null,
  pendingFocusNodeId: null,
  activeToolDialog: null,
  history: { past: [], future: [] },
  dragHistorySnapshot: null,
  currentViewport: { x: 0, y: 0, zoom: 1 },
  canvasViewportSize: { width: 0, height: 0 },
  viewportBookmarks: createEmptyBookmarks(),
  imageViewer: {
    isOpen: false,
    currentImageUrl: null,
    imageList: [],
    currentIndex: 0,
  },

  onNodesChange: (changes) => {
    set((state) => {
      const resizedNodeIds = new Set(
        changes
          .filter(
            (change): change is NodeChange<CanvasNode> & { id: string } =>
              change.type === 'dimensions'
              && 'resizing' in change
              && change.resizing === false
              && typeof change.id === 'string'
          )
          .map((change) => change.id)
      );

      let nextNodes = applyNodeChanges<CanvasNode>(changes, state.nodes);
      if (resizedNodeIds.size > 0) {
        nextNodes = nextNodes.map((node) => {
          if (!resizedNodeIds.has(node.id) || !isImageAutoResizableType(node.type)) {
            return node;
          }
          return withManualSizeLock(node);
        });
      }
      // 'dimensions' changes are either ReactFlow auto-measurement (pure
      // view-state) or a NodeResizer resize — the latter is already captured by
      // the `resizing` branches below. Excluding them here stops auto-measuring
      // a freshly-created node from pushing a spurious extra undo step (which
      // made the first undo after creating a node appear to do nothing).
      const hasMeaningfulChange = changes.some(
        (change) => change.type !== 'select' && change.type !== 'dimensions',
      );
      const hasDragMove = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          Boolean(change.dragging)
      );
      const hasDragEnd = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          change.dragging === false
      );
      const hasResizeMove = changes.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          Boolean(change.resizing)
      );
      const hasResizeEnd = changes.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          change.resizing === false
      );
      const hasInteractionMove = hasDragMove || hasResizeMove;
      const hasInteractionEnd = hasDragEnd || hasResizeEnd;

      let nextHistory = state.history;
      let nextDragHistorySnapshot = state.dragHistorySnapshot;
      // Only history-push moments count as user edits for the dangerous-empty
      // guard. Pure selection / view-state changes leave the counter alone.
      let editPushed = false;

      if (hasInteractionMove && !nextDragHistorySnapshot) {
        nextDragHistorySnapshot = createSnapshot(state.nodes, state.edges);
      }

      if (hasInteractionEnd) {
        const snapshot = nextDragHistorySnapshot ?? createSnapshot(state.nodes, state.edges);
        nextHistory = {
          past: pushSnapshot(state.history.past, snapshot),
          future: [],
        };
        nextDragHistorySnapshot = null;
        editPushed = true;
      } else if (hasMeaningfulChange && !hasInteractionMove) {
        nextHistory = {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        };
        nextDragHistorySnapshot = null;
        editPushed = true;
      }

      const editSource: CanvasMutationSource = isDeleteToEmpty(
        state.nodes.length,
        nextNodes.length,
      )
        ? "delete_to_empty"
        : "user_edit";

      return {
        nodes: nextNodes,
        selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, nextNodes),
        activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, nextNodes),
        history: nextHistory,
        dragHistorySnapshot: nextDragHistorySnapshot,
        ...(editPushed ? trackEdit(state, editSource) : {}),
      };
    });
  },

  onEdgesChange: (changes) => {
    set((state) => {
      const nextEdges = applyEdgeChanges<CanvasEdge>(changes, state.edges);
      const hasMeaningfulChange = changes.some((change) => change.type !== 'select');

      if (!hasMeaningfulChange) {
        return { edges: nextEdges };
      }

      return {
        edges: nextEdges,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state),
      };
    });
  },

  onConnect: (connection) => {
    const sourceHandle = normalizeHandleId(connection.sourceHandle) ?? 'source';
    const targetHandle = normalizeHandleId(connection.targetHandle) ?? 'target';
    set((state) => {
      // A 3D world node is generated from a single upstream image, so it has exactly one incoming edge: reject new connections when another upstream exists.
      // This is the common gate for all connection paths (manual drag / drag to blank space to generate a node).
      const targetNode = state.nodes.find((node) => node.id === connection.target);
      if (
        targetNode?.type === CANVAS_NODE_TYPES.threeDWorld &&
        state.edges.some(
          (edge) =>
            edge.target === connection.target && edge.source !== connection.source,
        )
      ) {
        return {};
      }
      // Upstream type rule gate: block any connection that bypasses UI validation (e.g. audio <- non-text).
      const sourceNode = state.nodes.find((node) => node.id === connection.source);
      if (
        sourceNode &&
        targetNode &&
        !isUpstreamConnectionAllowed(sourceNode.type, targetNode.type)
      ) {
        return {};
      }
      // Video node material limit gate: reject new connections once materials reach the capability envelope (9 images / 3 videos / 3 audios /
      // 12 total). Manual drags are already greyed out in isValidConnection; this catches
      // other edge creation paths such as dragging to blank space to generate a node.
      if (
        videoReferenceConnectionRejection(
          state.nodes,
          state.edges,
          connection,
          videoReferenceEnvelopeForNode,
        ) != null
      ) {
        return {};
      }
      return {
        edges: addEdge<CanvasEdge>(
          { ...connection, sourceHandle, targetHandle, type: 'disconnectableEdge' },
          state.edges
        ),
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state),
      };
    });
  },

  replaceEdges: (edges) => {
    set((state) => {
      if (state.edges === edges) {
        return {};
      }
      const normalizedEdges = normalizeEdgesWithNodes(edges, state.nodes);
      return {
        edges: normalizedEdges,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state),
      };
    });
  },

  setCanvasData: (nodes, edges, history) => {
    // After switching canvases/clearing, the style reconciliation bookkeeping left by the previous canvas must be invalidated, otherwise re-hydrated
    // image nodes would be treated as "the same node continuing", and ones that should be re-created would be judged as nodes the user deleted.
    resetStyleNodeSyncStates();
    const normalizedCanvas = normalizeCanvasData(nodes, edges);

    set({
      nodes: normalizedCanvas.nodes,
      edges: normalizedCanvas.edges,
      selectedNodeId: null,
      activeToolDialog: null,
      history: normalizeHistory(history),
      dragHistorySnapshot: null,
      // Hydrate / canvas switch — treat the store as freshly loaded so the
      // dangerous-empty guard does not misfire on the first signature pass.
      userEditsSinceHydrate: 0,
      lastMutationSource: null,
      pendingClearIntent: false,
    });
  },

  applyCanvasDataEdit: (nodes, edges) => {
    const normalizedCanvas = normalizeCanvasData(nodes, edges);

    set((state) => {
      const editSource: CanvasMutationSource = isDeleteToEmpty(
        state.nodes.length,
        normalizedCanvas.nodes.length,
      )
        ? "delete_to_empty"
        : "user_edit";
      return {
        nodes: normalizedCanvas.nodes,
        edges: normalizedCanvas.edges,
        selectedNodeId: null,
        activeToolDialog: null,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state, editSource),
      };
    });
  },

  hydrateCanvasDraft: (draft) => {
    // After switching canvases/clearing, the style reconciliation bookkeeping left by the previous canvas must be invalidated, otherwise re-hydrated
    // image nodes would be treated as "the same node continuing", and ones that should be re-created would be judged as nodes the user deleted.
    resetStyleNodeSyncStates();
    const normalizedCanvas = normalizeCanvasData(draft.nodes, draft.edges);

    set({
      nodes: normalizedCanvas.nodes,
      edges: normalizedCanvas.edges,
      selectedNodeId: null,
      activeToolDialog: null,
      history: normalizeHistory(draft.history ?? undefined),
      dragHistorySnapshot: null,
      userEditsSinceHydrate: draft.mutation.userEditsSinceHydrate,
      lastMutationSource: draft.mutation.lastMutationSource,
      pendingClearIntent: draft.mutation.pendingClearIntent,
    });
  },

  setViewportState: (viewport) => {
    set({ currentViewport: viewport });
  },

  setViewportBookmark: (index, bookmark) => {
    if (!Number.isInteger(index) || index < 0 || index >= BOOKMARK_SLOT_COUNT) {
      return;
    }
    set((state) => {
      const next = state.viewportBookmarks.slice();
      next[index] =
        bookmark === null
          ? null
          : { x: bookmark.x, y: bookmark.y, zoom: bookmark.zoom };
      return { viewportBookmarks: next };
    });
  },

  clearViewportBookmarks: () => {
    set({ viewportBookmarks: createEmptyBookmarks() });
  },

  hydrateViewportBookmarks: (list) => {
    set({ viewportBookmarks: normalizeBookmarks(list) });
  },

  setCanvasViewportSize: (size) => {
    set({ canvasViewportSize: size });
  },

  openImageViewer: (imageUrl, imageList = []) => {
    const list = imageList.length > 0 ? imageList : [imageUrl];
    const index = list.indexOf(imageUrl);
    set({
      imageViewer: {
        isOpen: true,
        currentImageUrl: imageUrl,
        imageList: list,
        currentIndex: index >= 0 ? index : 0,
      },
    });
  },

  closeImageViewer: () => {
    set({
      imageViewer: {
        isOpen: false,
        currentImageUrl: null,
        imageList: [],
        currentIndex: 0,
      },
    });
  },

  navigateImageViewer: (direction) => {
    const state = get();
    const { currentIndex, imageList } = state.imageViewer;
    if (direction === 'prev' && currentIndex > 0) {
      const newIndex = currentIndex - 1;
      set({
        imageViewer: {
          ...state.imageViewer,
          currentIndex: newIndex,
          currentImageUrl: imageList[newIndex],
        },
      });
    } else if (direction === 'next' && currentIndex < imageList.length - 1) {
      const newIndex = currentIndex + 1;
      set({
        imageViewer: {
          ...state.imageViewer,
          currentIndex: newIndex,
          currentImageUrl: imageList[newIndex],
        },
      });
    }
  },

  addNode: (type, position, data = {}) => {
    const state = get();
    // Give a new node without a title an auto sequence number, writing the title like "Text 1" or "Image node 2", to avoid same-type
    // nodes with the same name being indistinguishable (nodes with a displayName - such as the various result nodes - are left alone).
    //
    // Note that displayName must be written together: each node definition's createDefaultData() already prefills the default name
    // into displayName, so stuffing only autoTitleIndex would not change the rendering. Writing the index as well is
    // so getDefaultNodeDisplayName also computes the numbered default name - isNodeUsingDefaultDisplayName
    // still judges it as "using the default name" accordingly (UploadNode's auto rename depends on this).
    const dataWithAutoTitle = withAutoTitleIndex(type, data, state.nodes);
    const createdNode = maybeApplyImageAutoResize(
      canvasNodeFactory.createNode(type, position, dataWithAutoTitle),
      dataWithAutoTitle,
    );
    const newNode =
      createdNode.type === CANVAS_NODE_TYPES.skill && !createdNode.measured
        ? ({ ...createdNode, measured: SKILL_NODE_DEFAULT_MEASURED } as CanvasNode)
        : createdNode.type === CANVAS_NODE_TYPES.beatContext && !createdNode.measured
          ? ({ ...createdNode, measured: BEAT_CONTEXT_NODE_DEFAULT_MEASURED } as CanvasNode)
          : createdNode;
    set({
      nodes: [...state.nodes, newNode],
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });
    return newNode.id;
  },

  duplicateNodeAsSibling: (sourceNodeId, index, dataOverrides = {}) => {
    const state = get();
    const source = state.nodes.find((n) => n.id === sourceNodeId);
    if (!source) return null;

    const sourceHeight =
      source.measured?.height ??
      (typeof source.height === 'number' ? source.height : 360);
    const position = {
      x: source.position.x,
      y: source.position.y + (sourceHeight + 24) * index,
    };
    // A copy cannot reuse the source node's title/number (it would duplicate numbers): when the source uses the default name, number the copy again.
    const clonedData = withAutoTitleIndexForClone(
      source.type,
      { ...(source.data as Partial<CanvasNodeData>), ...dataOverrides },
      state.nodes,
    );
    const newNode = canvasNodeFactory.createNode(source.type, position, clonedData);

    // Mirror the source's upstream connections so the clone resolves the same
    // references (upstream images/text) as the original generation. Style nodes are excluded —
    // see the same note in duplicateNodesAsSiblings below.
    const styleNodeIds = new Set(
      state.nodes.filter((node) => isStyleNode(node)).map((node) => node.id),
    );
    const clonedEdges: CanvasEdge[] = state.edges
      .filter((edge) => edge.target === sourceNodeId && !styleNodeIds.has(edge.source))
      .map((edge) => ({
        id: `e-${edge.source}-${newNode.id}`,
        source: edge.source,
        target: newNode.id,
        sourceHandle: edge.sourceHandle ?? 'source',
        targetHandle: edge.targetHandle ?? 'target',
        type: 'disconnectableEdge',
      }))
      .filter((edge) => !state.edges.some((e) => e.id === edge.id));

    set({
      nodes: [...state.nodes, newNode],
      edges: [...state.edges, ...clonedEdges],
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });
    return newNode.id;
  },

  duplicateNodesAsSiblings: (nodeIds) => {
    const state = get();
    const sourceSet = new Set(nodeIds);
    const newNodes: CanvasNode[] = [];
    const createdIds: string[] = [];
    // Maps each duplicated node's original id → its clone id, so edges between
    // two nodes that are *both* being duplicated rewire to the clones instead
    // of pointing back at the originals.
    const idMap = new Map<string, string>();

    for (const sourceNodeId of nodeIds) {
      const source = state.nodes.find((n) => n.id === sourceNodeId);
      if (!source) continue;

      // When copying a whole group, its members are also in nodeIds. Member coordinates are relative to the parent group and follow the parent group's clone;
      // only "roots" (whose parent is not in this copy) need to be moved down one slot.
      const parentIsCloned = Boolean(source.parentId && sourceSet.has(source.parentId));
      const sourceHeight =
        source.measured?.height ??
        (typeof source.height === 'number' ? source.height : 360);
      const position = parentIsCloned
        ? { x: source.position.x, y: source.position.y }
        : {
            x: source.position.x,
            y: source.position.y + sourceHeight + 24,
          };

      // Append a "- Copy" suffix to whichever name fields the node carries so
      // the clone is visually distinguishable (matches the reference design).
      // Group members get no suffix - only the object copied directly needs to be distinguished.
      const sourceData = source.data as Record<string, unknown>;
      const nameOverrides: Record<string, unknown> = {};
      if (!parentIsCloned) {
        if (typeof sourceData.displayName === 'string' && sourceData.displayName) {
          nameOverrides.displayName = i18n.t('canvas.naming.copySuffix', { name: sourceData.displayName });
        }
        if (typeof sourceData.label === 'string' && sourceData.label) {
          nameOverrides.label = i18n.t('canvas.naming.copySuffix', { name: sourceData.label });
        }
      }

      // This path has already changed the title above to "... - Copy", which naturally cannot duplicate the source node's name, so no renumbering is needed.
      const newNode = canvasNodeFactory.createNode(source.type, position, {
        ...(source.data as Partial<CanvasNodeData>),
        ...(nameOverrides as Partial<CanvasNodeData>),
      });
      // The group frame size is a node-level field that createNode does not carry over, so it has to be moved by hand.
      if (isGroupNode(source)) {
        newNode.width = source.width;
        newNode.height = source.height;
        newNode.style = source.style ? { ...source.style } : undefined;
      }
      // Keep the clone inside the same group (if any) so its position stays
      // anchored to the original's coordinate space. When the parent group is itself in the copy, point to
      // the parent group's clone, otherwise members would be put back into the original group.
      if (source.parentId) {
        newNode.parentId = idMap.get(source.parentId) ?? source.parentId;
        newNode.extent = source.extent;
      }

      idMap.set(sourceNodeId, newNode.id);
      createdIds.push(newNode.id);
      newNodes.push(newNode);
    }

    if (newNodes.length === 0) {
      return [];
    }

    // Second pass (clones now all exist): clone each duplicated node's incoming
    // edges. When the edge's source is also part of the selection, rewire it to
    // that source's clone so the duplicated subgraph stays internally wired
    // rather than re-attaching to the originals.
    const newEdges: CanvasEdge[] = [];
    const styleNodeIds = new Set(
      state.nodes.filter((node) => isStyleNode(node)).map((node) => node.id),
    );
    for (const edge of state.edges) {
      const newTarget = idMap.get(edge.target);
      if (!newTarget) {
        continue;
      }
      // If the style node is not copied along, this edge would be cloned into "the same style node -> two image nodes".
      // That breaks the premise of all styleNodeSync rules: two downstream nodes each modify the same node by their own choice,
      // triggering each other's effects with neither converging, until React throws the canvas at 50 levels deep.
      // The copy's own reconciliation takes the re-create branch and assigns it a new one, so dropping it here is exactly right.
      if (styleNodeIds.has(edge.source) && !idMap.has(edge.source)) {
        continue;
      }
      const newSource = idMap.get(edge.source) ?? edge.source;
      newEdges.push({
        id: `e-${newSource}-${newTarget}`,
        source: newSource,
        target: newTarget,
        sourceHandle: edge.sourceHandle ?? 'source',
        targetHandle: edge.targetHandle ?? 'target',
        type: 'disconnectableEdge',
      });
    }

    set({
      nodes: [
        ...state.nodes.map((node) =>
          node.selected || sourceSet.has(node.id)
            ? { ...node, selected: false }
            : node
        ),
        ...newNodes.map((node) => ({ ...node, selected: true })),
      ],
      edges: [...state.edges, ...newEdges],
      selectedNodeId: createdIds.length === 1 ? createdIds[0] : null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });

    return createdIds;
  },

  addPanoCaptureGroup: (sourceNodeId, captures, options) => {
    const state = get();
    if (captures.length === 0) {
      return null;
    }
    const source = state.nodes.find((node) => node.id === sourceNodeId);
    if (!source) {
      return null;
    }

    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const sourceAbs = resolveAbsolutePosition(source, nodeMap);
    const sourceSize = getNodeSize(source);

    const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
    const ratioOf = (w: number, h: number) => {
      const divisor = gcd(w, h) || 1;
      return `${Math.round(w / divisor)}:${Math.round(h / divisor)}`;
    };

    // Single capture (capture current): no group — just one connected image node to the
    // right of the source.
    if (captures.length === 1) {
      const only = captures[0];
      const NODE_WIDTH = 320;
      const nodeHeight = Math.max(
        80,
        Math.round((NODE_WIDTH * only.height) / Math.max(1, only.width))
      );
      // Prefer the backend URL after upload (including previewImageUrl) - a base64 dataUrl is stripped by
      // sanitizePreviewImageUrls on persist with a warning, and downstream generation also needs a real URL.
      // Fall back to the local dataUrl for display only when the upload is missing (uploadedUrl empty/blank).
      const onlyDisplayUrl =
        typeof only.uploadedUrl === 'string' && only.uploadedUrl.length > 0
          ? only.uploadedUrl
          : only.dataUrl;
      const singleNode = canvasNodeFactory.createNode(
        CANVAS_NODE_TYPES.exportImage,
        {
          x: Math.round(sourceAbs.x + sourceSize.width + 80),
          y: Math.round(sourceAbs.y),
        },
        {
          imageUrl: onlyDisplayUrl,
          previewImageUrl: onlyDisplayUrl,
          aspectRatio: ratioOf(only.width, only.height),
          displayName: only.label,
          captureMetadata: only.metadata ?? null,
        }
      );
      singleNode.width = NODE_WIDTH;
      singleNode.height = nodeHeight;
      singleNode.style = {
        ...(singleNode.style ?? {}),
        width: NODE_WIDTH,
        height: nodeHeight,
      };
      singleNode.selected = true;

      set({
        nodes: [
          ...state.nodes.map((node) =>
            node.selected ? { ...node, selected: false } : node
          ),
          singleNode,
        ],
        edges: [
          ...state.edges,
          {
            id: `e-${sourceNodeId}-${singleNode.id}`,
            source: sourceNodeId,
            target: singleNode.id,
            sourceHandle: 'source',
            targetHandle: 'target',
            type: 'disconnectableEdge',
          },
        ],
        selectedNodeId: singleNode.id,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state),
      });

      return singleNode.id;
    }

    const cols = Math.max(1, options?.cols ?? Math.ceil(Math.sqrt(captures.length)));
    const rows = Math.ceil(captures.length / cols);

    const first = captures[0];
    const aspectRatio = ratioOf(first.width, first.height);
    // Export image nodes auto-fit to the same min-edge constraints after the
    // image loads. Lay the group out with that final size up front so children
    // do not grow beyond the parent and overlap each other.
    const cellSize = resolveAutoImageNodeDimensions(aspectRatio, {
      minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
      minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
    });
    const CELL_WIDTH = cellSize.width;
    const cellHeight = cellSize.height;
    const CELL_GAP = 24;
    const SIDE_PADDING = 20;
    const TOP_PADDING = 34;
    const BOTTOM_PADDING = 20;

    const groupWidth = SIDE_PADDING * 2 + cols * CELL_WIDTH + (cols - 1) * CELL_GAP;
    const groupHeight =
      TOP_PADDING + BOTTOM_PADDING + rows * cellHeight + (rows - 1) * CELL_GAP;
    const groupX = Math.round(sourceAbs.x + sourceSize.width + 80);
    const groupY = Math.round(sourceAbs.y);

    const groupDisplayName =
      options?.groupName ?? i18n.t('canvas.naming.panoCaptureGroup', { total: captures.length });
    const groupNode = canvasNodeFactory.createNode(
      CANVAS_NODE_TYPES.group,
      { x: groupX, y: groupY },
      { label: groupDisplayName, displayName: groupDisplayName }
    );
    groupNode.width = groupWidth;
    groupNode.height = groupHeight;
    groupNode.style = { width: groupWidth, height: groupHeight };
    groupNode.selected = false;

    const childNodes: CanvasNode[] = captures.map((capture, index) => {
      const col = index % cols;
      const row = Math.floor(index / cols);
      const position = {
        x: SIDE_PADDING + col * (CELL_WIDTH + CELL_GAP),
        y: TOP_PADDING + row * (cellHeight + CELL_GAP),
      };
      // Same as the single-image branch: previewImageUrl also prefers the backend URL after upload, avoiding persisted base64
      // triggering the sanitize warning; fall back to the local dataUrl only when the upload is missing.
      const childDisplayUrl =
        typeof capture.uploadedUrl === 'string' && capture.uploadedUrl.length > 0
          ? capture.uploadedUrl
          : capture.dataUrl;
      const childNode = canvasNodeFactory.createNode(
        CANVAS_NODE_TYPES.exportImage,
        position,
        {
          imageUrl: childDisplayUrl,
          previewImageUrl: childDisplayUrl,
          aspectRatio,
          displayName: capture.label,
          captureMetadata: capture.metadata ?? null,
        }
      );
      childNode.parentId = groupNode.id;
      childNode.extent = 'parent';
      childNode.width = CELL_WIDTH;
      childNode.height = cellHeight;
      childNode.style = {
        ...(childNode.style ?? {}),
        width: CELL_WIDTH,
        height: cellHeight,
      };
      childNode.selected = false;
      return childNode;
    });

    // Wire each capture back to its source 360 viewer node so the provenance is
    // visible on the canvas (matches the reference design).
    const newEdges: CanvasEdge[] = childNodes.map((childNode) => ({
      id: `e-${sourceNodeId}-${childNode.id}`,
      source: sourceNodeId,
      target: childNode.id,
      sourceHandle: 'source',
      targetHandle: 'target',
      type: 'disconnectableEdge',
    }));

    set({
      // Parent group must precede its children in the array for React Flow.
      nodes: [
        ...state.nodes.map((node) =>
          node.selected ? { ...node, selected: false } : node
        ),
        groupNode,
        ...childNodes,
      ],
      edges: [...state.edges, ...newEdges],
      selectedNodeId: groupNode.id,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });

    return groupNode.id;
  },

  addVideoBreakdownGroups: (sourceNodeId, result, options) => {
    const state = get();
    const source = state.nodes.find((node) => node.id === sourceNodeId);
    if (!source) {
      return null;
    }

    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const sourceAbs = resolveAbsolutePosition(source, nodeMap);
    const sourceSize = getNodeSize(source);

    const plans = planVideoBreakdownGroups(result, {
      ...options,
      origin: { x: sourceAbs.x + sourceSize.width + 120, y: sourceAbs.y },
    });
    if (plans.length === 0) {
      return null;
    }

    // Parent group must precede its own children in the array for React Flow -
    // pushing group by group (group, the group's members, the next group...) naturally satisfies this.
    const orderedNodes: CanvasNode[] = [];
    const newEdges: CanvasEdge[] = [];
    const groupIds: string[] = [];

    for (const plan of plans) {
      const groupNode = canvasNodeFactory.createNode(
        CANVAS_NODE_TYPES.group,
        plan.position,
        { label: plan.label, displayName: plan.label }
      );
      groupNode.width = plan.width;
      groupNode.height = plan.height;
      groupNode.style = { width: plan.width, height: plan.height };
      groupNode.selected = false;
      orderedNodes.push(groupNode);
      groupIds.push(groupNode.id);

      for (const child of plan.children) {
        const childNode = canvasNodeFactory.createNode(
          child.type,
          child.position,
          child.data as Partial<CanvasNodeData>
        );
        childNode.parentId = groupNode.id;
        childNode.width = child.width;
        childNode.height = child.height;
        childNode.style = {
          ...(childNode.style ?? {}),
          width: child.width,
          height: child.height,
        };
        childNode.selected = false;
        orderedNodes.push(childNode);
        newEdges.push({
          id: `e-${sourceNodeId}-${childNode.id}`,
          source: sourceNodeId,
          target: childNode.id,
          sourceHandle: 'source',
          targetHandle: 'target',
          type: 'disconnectableEdge',
        });
      }
    }

    set({
      nodes: [
        ...state.nodes.map((node) =>
          node.selected ? { ...node, selected: false } : node
        ),
        ...orderedNodes,
      ],
      edges: [...state.edges, ...newEdges],
      selectedNodeId: groupIds[0] ?? null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });

    return groupIds;
  },

  addEdge: (source, target) => {
    const state = get();
    // Check if both nodes exist
    const sourceNode = state.nodes.find((n) => n.id === source);
    const targetNode = state.nodes.find((n) => n.id === target);
    if (!sourceNode || !targetNode) {
      return null;
    }
    if (!nodeHasSourceHandle(sourceNode.type) || !nodeHasTargetHandle(targetNode.type)) {
      return null;
    }
    // Upstream type rule gate (e.g. audio <- non-text).
    if (!isUpstreamConnectionAllowed(sourceNode.type, targetNode.type)) {
      return null;
    }
    // The material limit must also be gated here: picking references from the asset library and importing external files
    // (spawnExternalAssetNodes) both attach materials to an **existing** video node, and exactly go through
    // addEdge. Intercepting only in onConnect would mean this limit holds only for manual drags.
    if (
      videoReferenceConnectionRejection(
        state.nodes,
        state.edges,
        { source, target },
        videoReferenceEnvelopeForNode,
      ) != null
    ) {
      return null;
    }

    const edgeId = `e-${source}-${target}`;
    // Check if edge already exists
    if (state.edges.some((e) => e.id === edgeId)) {
      return edgeId;
    }

    const newEdge: CanvasEdge = {
      id: edgeId,
      source,
      target,
      sourceHandle: 'source',
      targetHandle: 'target',
      type: 'disconnectableEdge',
    };

    set({
      edges: [...state.edges, newEdge],
      ...trackEdit(state),
    });

    return edgeId;
  },

  addEdgeWithData: (source, target, data, options) => {
    const state = get();
    const sourceNode = state.nodes.find((n) => n.id === source);
    const targetNode = state.nodes.find((n) => n.id === target);
    if (!sourceNode || !targetNode) {
      return null;
    }
    if (!nodeHasSourceHandle(sourceNode.type) || !nodeHasTargetHandle(targetNode.type)) {
      return null;
    }
    // Upstream type rule gate (e.g. audio <- non-text).
    if (!isUpstreamConnectionAllowed(sourceNode.type, targetNode.type)) {
      return null;
    }
    // The same ruler as addEdge: currently the targets on this path are all newly created nodes (skill outputs,
    // background candidates), which cannot reach the limit; it is placed here so that "all public edge creation entries are consistent",
    // and nobody connecting an edge with data to an existing video node in the future will slip through.
    if (
      videoReferenceConnectionRejection(
        state.nodes,
        state.edges,
        { source, target },
        videoReferenceEnvelopeForNode,
      ) != null
    ) {
      return null;
    }

    const edgeId = options?.id || `e-${source}-${target}-${String(data.edgeKind || 'data')}`;
    const existing = state.edges.find((edge) => edge.id === edgeId);
    if (existing) {
      return edgeId;
    }

    const newEdge: CanvasEdge = {
      id: edgeId,
      source,
      target,
      sourceHandle: normalizeHandleId(options?.sourceHandle) ?? 'source',
      targetHandle: normalizeHandleId(options?.targetHandle) ?? 'target',
      type: 'disconnectableEdge',
      data,
    };
    const validation = validatePropagatingEdgeCandidate(state.nodes, state.edges, newEdge);
    if (!validation.ok) {
      console.warn('[freezone] rejected propagating edge', validation.reason, newEdge);
      return null;
    }
    const roleValidation = validateCandidateBindingRoleCandidate(state.edges, newEdge);
    if (!roleValidation.ok) {
      console.warn('[freezone] rejected role binding edge', roleValidation.reason, newEdge);
      return null;
    }

    set({
      edges: [...state.edges, newEdge],
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });

    return edgeId;
  },

  findNodePosition: (sourceNodeId, newNodeWidth, newNodeHeight) => {
    const state = get();
    const sourceNode = state.nodes.find((n) => n.id === sourceNodeId);
    if (!sourceNode) {
      return { x: 100, y: 100 };
    }

    // Helper to check if a position collides with existing nodes.
    const collides = (x: number, y: number, width: number, height: number) => {
      return state.nodes.some((node) => {
        const nodeWidth = node.measured?.width ?? DEFAULT_NODE_WIDTH;
        const nodeHeight = node.measured?.height ?? 200;
        const margin = 8;
        return (
          x < node.position.x + nodeWidth + margin &&
          x + width + margin > node.position.x &&
          y < node.position.y + nodeHeight + margin &&
          y + height + margin > node.position.y
        );
      });
    };

    const sourceWidth = sourceNode.measured?.width ?? DEFAULT_NODE_WIDTH;
    const sourceHeight = sourceNode.measured?.height ?? 200;
    const anchorX = sourceNode.position.x + sourceWidth + 28;
    const anchorY = sourceNode.position.y;

    const zoom = Math.max(0.01, state.currentViewport.zoom || 1);
    const viewportWidth = state.canvasViewportSize.width;
    const viewportHeight = state.canvasViewportSize.height;
    const hasViewportBounds = viewportWidth > 0 && viewportHeight > 0;
    const visibleBounds = hasViewportBounds
      ? {
          minX: -state.currentViewport.x / zoom,
          minY: -state.currentViewport.y / zoom,
          maxX: -state.currentViewport.x / zoom + viewportWidth / zoom,
          maxY: -state.currentViewport.y / zoom + viewportHeight / zoom,
        }
      : null;

    const overflowAmount = (x: number, y: number): number => {
      if (!visibleBounds) {
        return 0;
      }
      const overLeft = Math.max(0, visibleBounds.minX - x);
      const overTop = Math.max(0, visibleBounds.minY - y);
      const overRight = Math.max(0, x + newNodeWidth - visibleBounds.maxX);
      const overBottom = Math.max(0, y + newNodeHeight - visibleBounds.maxY);
      return overLeft + overTop + overRight + overBottom;
    };

    const stepX = Math.max(newNodeWidth + 12, 110);
    const stepY = Math.max(Math.round(newNodeHeight * 0.35), 54);
    const baseCandidates = [
      { x: anchorX, y: anchorY },
      { x: sourceNode.position.x, y: sourceNode.position.y + sourceHeight + 20 },
      { x: sourceNode.position.x - newNodeWidth - 20, y: sourceNode.position.y },
      { x: sourceNode.position.x, y: sourceNode.position.y - newNodeHeight - 20 },
    ];

    let bestInView: { x: number; y: number; score: number } | null = null;
    let bestOutOfView: { x: number; y: number; score: number } | null = null;

    const evaluateCandidate = (x: number, y: number) => {
      if (collides(x, y, newNodeWidth, newNodeHeight)) {
        return;
      }

      const dx = x - anchorX;
      const dy = y - anchorY;
      const distanceScore = Math.hypot(dx, dy);
      const upwardPenalty = dy < 0 ? Math.abs(dy) * 0.25 : 0;
      const overflow = overflowAmount(x, y);
      const score = distanceScore + upwardPenalty + overflow * 1000;
      const candidate = { x, y, score };

      if (overflow === 0) {
        if (!bestInView || score < bestInView.score) {
          bestInView = candidate;
        }
      } else if (!bestOutOfView || score < bestOutOfView.score) {
        bestOutOfView = candidate;
      }
    };

    for (const base of baseCandidates) {
      evaluateCandidate(base.x, base.y);
    }

    for (let ring = 1; ring <= 8; ring += 1) {
      const offsets = [
        { x: ring, y: 0 },
        { x: ring, y: 1 },
        { x: ring, y: -1 },
        { x: 0, y: ring },
        { x: 0, y: -ring },
        { x: -ring, y: 0 },
        { x: ring, y: 2 },
        { x: ring, y: -2 },
        { x: -ring, y: 1 },
        { x: -ring, y: -1 },
      ];
      for (const offset of offsets) {
        evaluateCandidate(anchorX + offset.x * stepX, anchorY + offset.y * stepY);
      }
    }

    // If ring sampling misses an available slot in current viewport,
    // run a denser viewport sweep before falling back outside view.
    if (!bestInView && visibleBounds) {
      const padding = 8;
      const minX = visibleBounds.minX + padding;
      const maxX = visibleBounds.maxX - newNodeWidth - padding;
      const minY = visibleBounds.minY + padding;
      const maxY = visibleBounds.maxY - newNodeHeight - padding;

      if (maxX >= minX && maxY >= minY) {
        const scanStepX = Math.max(42, Math.round(newNodeWidth * 0.32));
        const scanStepY = Math.max(42, Math.round(newNodeHeight * 0.32));

        for (let y = minY; y <= maxY; y += scanStepY) {
          for (let x = minX; x <= maxX; x += scanStepX) {
            evaluateCandidate(x, y);
          }
        }

        // Ensure boundary positions are also considered.
        evaluateCandidate(minX, minY);
        evaluateCandidate(maxX, minY);
        evaluateCandidate(minX, maxY);
        evaluateCandidate(maxX, maxY);
      }
    }

    const resolvedCandidate = (bestInView || bestOutOfView) as
      | { x: number; y: number; score: number }
      | null;
    if (resolvedCandidate) {
      return { x: resolvedCandidate.x, y: resolvedCandidate.y };
    }

    return { x: anchorX + 2 * stepX, y: anchorY };
  },

  addDerivedUploadNode: (sourceNodeId, imageUrl, aspectRatio, previewImageUrl) => {
    const state = get();
    const position = getDerivedNodePosition(state.nodes, sourceNodeId);
    const sourceNode = state.nodes.find((node) => node.id === sourceNodeId);
    const resolvedAspectRatio = resolveDerivedAspectRatio(sourceNode, aspectRatio);
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.upload, position, {
      imageUrl,
      previewImageUrl: previewImageUrl ?? null,
      aspectRatio: resolvedAspectRatio,
    });
    const derivedSize = resolveGeneratedImageNodeDimensions(resolvedAspectRatio);
    node.width = derivedSize.width;
    node.height = derivedSize.height;
    node.style = {
      ...(node.style ?? {}),
      width: derivedSize.width,
      height: derivedSize.height,
    };

    set({
      nodes: [...state.nodes, node],
      selectedNodeId: node.id,
      activeToolDialog: null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });

    return node.id;
  },

  addDerivedExportNode: (sourceNodeId, imageUrl, aspectRatio, previewImageUrl, options) => {
    const state = get();
    const sourceNode = state.nodes.find((node) => node.id === sourceNodeId);
    const aspectRatioStrategy = options?.aspectRatioStrategy ?? 'provided';
    const resolvedAspectRatio = aspectRatioStrategy === 'derivedFromSource'
      ? resolveDerivedAspectRatio(sourceNode, aspectRatio)
      : (aspectRatio || resolveDerivedAspectRatio(sourceNode, DEFAULT_ASPECT_RATIO));
    const autoSize = resolveAutoImageNodeDimensions(resolvedAspectRatio, {
      minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
      minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
    });
    const generatedSize = resolveGeneratedImageNodeDimensions(resolvedAspectRatio, {
      minWidth: EXPORT_RESULT_NODE_MIN_WIDTH,
      minHeight: EXPORT_RESULT_NODE_MIN_HEIGHT,
    });
    const sourceSize = sourceNode ? getNodeSize(sourceNode) : null;
    const sizeStrategy = options?.sizeStrategy
      ?? (options?.matchSourceNodeSize ? 'matchSource' : 'generated');
    let derivedSize = generatedSize;
    if (sizeStrategy === 'autoMinEdge') {
      derivedSize = autoSize;
    } else if (sizeStrategy === 'matchSource' && sourceSize) {
      derivedSize = {
        width: Math.max(1, Math.round(sourceSize.width)),
        height: Math.max(1, Math.round(sourceSize.height)),
      };
    }
    const position = state.findNodePosition(
      sourceNodeId,
      derivedSize.width,
      derivedSize.height
    );
    const exportNodeData: Partial<CanvasNodeData> = {
      imageUrl,
      previewImageUrl: previewImageUrl ?? null,
      aspectRatio: resolvedAspectRatio,
    };
    if (options?.defaultTitle) {
      (exportNodeData as { displayName?: string }).displayName = options.defaultTitle;
    }
    if (options?.resultKind) {
      (exportNodeData as { resultKind?: ExportImageNodeResultKind }).resultKind = options.resultKind;
      if (!options.defaultTitle) {
        (exportNodeData as { displayName?: string }).displayName =
          EXPORT_RESULT_DISPLAY_NAME[options.resultKind];
      }
    }
    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.exportImage, position, {
      ...exportNodeData,
    });
    node.width = derivedSize.width;
    node.height = derivedSize.height;
    node.style = {
      ...(node.style ?? {}),
      width: derivedSize.width,
      height: derivedSize.height,
    };

    set({
      nodes: [...state.nodes, node],
      selectedNodeId: node.id,
      activeToolDialog: null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });

    return node.id;
  },

  addStoryboardSplitNode: (sourceNodeId, rows, cols, frames, frameAspectRatio) => {
    const state = get();
    const position = getDerivedNodePosition(state.nodes, sourceNodeId);
    const resolvedFrameAspectRatio =
      frameAspectRatio ??
      frames.find((frame) => typeof frame.aspectRatio === 'string')?.aspectRatio ??
      DEFAULT_ASPECT_RATIO;

    const node = canvasNodeFactory.createNode(CANVAS_NODE_TYPES.storyboardSplit, position, {
      gridRows: rows,
      gridCols: cols,
      frames,
      aspectRatio: resolvedFrameAspectRatio,
      frameAspectRatio: resolvedFrameAspectRatio,
      exportOptions: createDefaultStoryboardExportOptions(),
    });
    const derivedSize = resolveStoryboardSplitNodeDimensions(rows, cols, resolvedFrameAspectRatio);
    node.width = derivedSize.width;
    node.height = derivedSize.height;
    node.style = {
      ...(node.style ?? {}),
      width: derivedSize.width,
      height: derivedSize.height,
    };

    set({
      nodes: [...state.nodes, node],
      selectedNodeId: node.id,
      activeToolDialog: null,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });

    return node.id;
  },

  convertNodeType: (nodeId, newType, dataOverrides = {}) => {
    const state = get();
    const target = state.nodes.find((n) => n.id === nodeId);
    if (!target || target.type === newType) {
      return false;
    }
    const definition = nodeCatalog.getDefinition(newType);
    const mergedData = {
      ...definition.createDefaultData(),
      ...dataOverrides,
      ...(newType === CANVAS_NODE_TYPES.audio ? { voicePolicyConfirmed: true } : {}),
    } as CanvasNodeData;
    const nextNodes = state.nodes.map((node) =>
      node.id === nodeId
        ? ({
            ...node,
            type: newType,
            data: mergedData,
            // Reset measured size — the new node type can pick its own default
            // and ReactFlow will re-measure after the swap.
            measured: undefined,
            width: undefined,
            height: undefined,
          } as CanvasNode)
        : node
    );
    // After a type change, a previously legal associated edge may no longer be legal: an empty Upload first connects to an image node, then
    // uploading audio converts it to Audio - audio -> image is no longer allowed. If not cleared here, that edge would stay
    // on the canvas (and could still submit generation) until the next load normalizes it away silently. The rule stays consistent with that load normalization
    // filter: handle presence + edge type rules.
    const nextNodeTypeById = new Map(nextNodes.map((node) => [node.id, node.type]));
    const nextEdges = state.edges.filter((edge) => {
      if (edge.source !== nodeId && edge.target !== nodeId) {
        return true;
      }
      const sourceType = nextNodeTypeById.get(edge.source);
      const targetType = nextNodeTypeById.get(edge.target);
      if (!sourceType || !targetType) {
        return true;
      }
      if (!nodeHasSourceHandle(sourceType) || !nodeHasTargetHandle(targetType)) {
        return false;
      }
      return isUpstreamConnectionAllowed(sourceType, targetType);
    });

    // When the type changes, the material classification changes too: an empty Upload counts as an image when creating the edge, and after converting to video/audio
    // it may push a downstream video node past the video/audio limits (external file import is exactly "connect first, convert by MIME
    // later"). The validation at edge creation cannot cover this moment, so it can only be recomputed once the type is determined.
    const affectedVideoTargets = new Set(
      nextEdges.filter((edge) => edge.source === nodeId).map((edge) => edge.target),
    );
    const overflowEdgeIds = new Set<string>();
    for (const videoTargetId of affectedVideoTargets) {
      for (const edgeId of overflowingVideoReferenceEdgeIds(
        nextNodes,
        nextEdges,
        videoTargetId,
        videoReferenceEnvelopeForNode,
      )) {
        overflowEdgeIds.add(edgeId);
      }
    }
    const finalEdges = overflowEdgeIds.size
      ? nextEdges.filter((edge) => !overflowEdgeIds.has(edge.id))
      : nextEdges;

    set({
      nodes: nextNodes,
      edges: finalEdges,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });
    return true;
  },

  updateNodeData: (nodeId, data, options) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        const hasDataChange = Object.entries(data).some(([key, nextValue]) => {
          const previousValue = (node.data as Record<string, unknown>)[key];
          return !Object.is(previousValue, nextValue);
        });
        if (!hasDataChange) {
          return node;
        }

        const mergedData = {
          ...node.data,
          ...data,
        } as CanvasNodeData;
        const resizedNode = maybeApplyImageAutoResize(
          {
            ...node,
            data: mergedData,
          },
          data
        );

        changed = true;
        return resizedNode;
      });

      if (!changed) {
        return {};
      }

      if (options?.recordHistory === false) {
        return { nodes: nextNodes, ...trackEdit(state) };
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state),
      };
    });
  },

  updateNodeSize: (nodeId, size, options) => {
    const nextWidth = Math.max(1, Math.round(size.width));
    const nextHeight = Math.max(1, Math.round(size.height));
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }
        const currentWidth =
          (typeof node.width === 'number' ? node.width : null)
          ?? (typeof node.style?.width === 'number' ? node.style.width : null);
        const currentHeight =
          (typeof node.height === 'number' ? node.height : null)
          ?? (typeof node.style?.height === 'number' ? node.style.height : null);
        const manualSizePatch =
          options?.lockManualSize === false
            ? { isSizeManuallyAdjusted: false }
            : options?.lockManualSize === true
              ? { isSizeManuallyAdjusted: true }
              : {};
        const dataPatch = {
          ...(options?.data ?? {}),
          ...manualSizePatch,
        };
        const hasDataPatch = Object.keys(dataPatch).some((key) => {
          return !Object.is(
            (node.data as Record<string, unknown>)[key],
            (dataPatch as Record<string, unknown>)[key],
          );
        });
        if (currentWidth === nextWidth && currentHeight === nextHeight && !hasDataPatch) {
          return node;
        }
        changed = true;
        return {
          ...node,
          width: nextWidth,
          height: nextHeight,
          style: {
            ...(node.style ?? {}),
            width: nextWidth,
            height: nextHeight,
          },
          data: {
            ...node.data,
            ...dataPatch,
          } as CanvasNodeData,
        };
      });

      if (!changed) {
        return {};
      }

      if (options?.recordHistory === false) {
        // Neither history nor dragHistorySnapshot is touched: this write is not a user change, so it should neither be
        // undoable nor push out the snapshot of a drag in progress.
        return { nodes: nextNodes, ...trackEdit(state) };
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state),
      };
    });
  },

  updateNodePosition: (nodeId, position) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId) {
          return node;
        }

        if (node.position.x === position.x && node.position.y === position.y) {
          return node;
        }

        changed = true;
        return {
          ...node,
          position,
        };
      });

      if (!changed) {
        return {};
      }

      return { nodes: nextNodes };
    });
  },

  setNodePositions: (positions) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        const next = positions[node.id];
        if (!next) {
          return node;
        }
        const nextX = Math.round(next.x);
        const nextY = Math.round(next.y);
        if (node.position.x === nextX && node.position.y === nextY) {
          return node;
        }
        changed = true;
        return { ...node, position: { x: nextX, y: nextY } };
      });

      if (!changed) {
        return {};
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state),
      };
    });
  },

  updateStoryboardFrame: (nodeId, frameId, data) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId || !isStoryboardSplitNode(node)) {
          return node;
        }

        const nextFrames = node.data.frames.map((frame) => {
          if (frame.id !== frameId) {
            return frame;
          }

          const patchEntries = Object.entries(data) as Array<
            [keyof StoryboardFrameItem, StoryboardFrameItem[keyof StoryboardFrameItem]]
          >;
          const hasFrameChange = patchEntries.some(([key, nextValue]) =>
            !Object.is(frame[key], nextValue)
          );
          if (!hasFrameChange) {
            return frame;
          }

          changed = true;
          return {
            ...frame,
            ...data,
          };
        });

        return {
          ...node,
          data: {
            ...node.data,
            frames: nextFrames,
          },
        };
      });

      if (!changed) {
        return {};
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state),
      };
    });
  },

  reorderStoryboardFrame: (nodeId, draggedFrameId, targetFrameId) => {
    set((state) => {
      let changed = false;
      const nextNodes = state.nodes.map((node) => {
        if (node.id !== nodeId || !isStoryboardSplitNode(node)) {
          return node;
        }

        const frames = [...node.data.frames].sort((a, b) => a.order - b.order);
        const fromIndex = frames.findIndex((frame) => frame.id === draggedFrameId);
        const toIndex = frames.findIndex((frame) => frame.id === targetFrameId);

        if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) {
          return node;
        }

        changed = true;
        const [movedFrame] = frames.splice(fromIndex, 1);
        frames.splice(toIndex, 0, movedFrame);

        return {
          ...node,
          data: {
            ...node.data,
            frames: frames.map((frame, index) => ({
              ...frame,
              order: index,
            })),
          },
        };
      });

      if (!changed) {
        return {};
      }

      return {
        nodes: nextNodes,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state),
      };
    });
  },

  deleteNode: (nodeId) => {
    get().deleteNodes([nodeId]);
  },

  deleteNodes: (nodeIds) => {
    const uniqueIds = Array.from(new Set(nodeIds.filter((nodeId) => nodeId.trim().length > 0)));
    if (uniqueIds.length === 0) {
      return;
    }

    set((state) => {
      const existingIds = uniqueIds.filter((nodeId) => {
        const node = state.nodes.find((candidate) => candidate.id === nodeId);
        return Boolean(node && !isPresetManagedNode(node));
      });
      if (existingIds.length === 0) {
        return {};
      }

      const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
      const deleteSet = collectNodeIdsWithDescendants(state.nodes, existingIds);
      for (const node of state.nodes) {
        if (deleteSet.has(node.id) && isPresetManagedNode(node)) {
          deleteSet.delete(node.id);
        }
      }
      // When the source node is deleted, the frame crop attached to it must be cut off too; otherwise that crop (one of the
      // download / crop / upload steps) keeps running and only discovers the node is gone once it finishes. cancelVideoCrop
      // is a no-op for nodes that are not being cropped, so calling it for every node in a bulk delete costs nothing extra.
      for (const nodeId of deleteSet) {
        cancelVideoCrop(nodeId);
      }
      const nodesAfterDelete = state.nodes
        .filter((node) => !deleteSet.has(node.id))
        .map((node) => {
          if (!node.parentId || !deleteSet.has(node.parentId)) {
            return node;
          }
          const absolute = resolveAbsolutePosition(node, nodeMap);
          return {
            ...node,
            parentId: undefined,
            extent: undefined,
            position: {
              x: Math.round(absolute.x),
              y: Math.round(absolute.y),
            },
          };
        });
      const protectedGroupIds = new Set(
        existingIds.filter((nodeId) => state.nodes.some((node) => node.id === nodeId))
      );
      const nextNodes = pruneEmptyGroupNodes(nodesAfterDelete, protectedGroupIds);
      const nextNodeIds = new Set(nextNodes.map((node) => node.id));
      const nextEdges = state.edges.filter(
        (edge) =>
          !deleteSet.has(edge.source) &&
          !deleteSet.has(edge.target) &&
          nextNodeIds.has(edge.source) &&
          nextNodeIds.has(edge.target)
      );

      const editSource: CanvasMutationSource = isDeleteToEmpty(
        state.nodes.length,
        nextNodes.length,
      )
        ? "delete_to_empty"
        : "user_edit";

      return {
        nodes: nextNodes,
        edges: nextEdges,
        selectedNodeId:
          state.selectedNodeId && deleteSet.has(state.selectedNodeId) ? null : state.selectedNodeId,
        activeToolDialog:
          state.activeToolDialog && deleteSet.has(state.activeToolDialog.nodeId)
            ? null
            : state.activeToolDialog,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state, editSource),
      };
    });
  },

  groupNodes: (nodeIds, opts) => {
    const uniqueIds = Array.from(new Set(nodeIds.filter((nodeId) => nodeId.trim().length > 0)));
    if (uniqueIds.length < 2) {
      return null;
    }

    const state = get();
    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const existingIds = uniqueIds.filter((nodeId) => nodeMap.has(nodeId));
    if (existingIds.length < 2) {
      return null;
    }

    const selectedSet = new Set(existingIds);
    const memberIds = existingIds.filter((nodeId) => {
      let currentParentId = nodeMap.get(nodeId)?.parentId;
      const visited = new Set<string>();
      while (currentParentId && !visited.has(currentParentId)) {
        if (selectedSet.has(currentParentId)) {
          return false;
        }
        visited.add(currentParentId);
        currentParentId = nodeMap.get(currentParentId)?.parentId;
      }
      return true;
    });
    if (memberIds.length < 2) {
      return null;
    }

    const memberSet = new Set(memberIds);
    const members = memberIds
      .map((id) => nodeMap.get(id))
      .filter((node): node is CanvasNode => Boolean(node));

    const absoluteBounds = members.reduce(
      (acc, node) => {
        const absolute = resolveAbsolutePosition(node, nodeMap);
        const size = getNodeSize(node);
        return {
          minX: Math.min(acc.minX, absolute.x),
          minY: Math.min(acc.minY, absolute.y),
          maxX: Math.max(acc.maxX, absolute.x + size.width),
          maxY: Math.max(acc.maxY, absolute.y + size.height),
        };
      },
      {
        minX: Number.POSITIVE_INFINITY,
        minY: Number.POSITIVE_INFINITY,
        maxX: Number.NEGATIVE_INFINITY,
        maxY: Number.NEGATIVE_INFINITY,
      }
    );

    if (!Number.isFinite(absoluteBounds.minX) || !Number.isFinite(absoluteBounds.minY)) {
      return null;
    }

    const extraPadding = Math.max(0, opts?.extraPadding ?? 0);
    const SIDE_PADDING = opts?.padding?.side ?? 20 + extraPadding;
    const TOP_PADDING = opts?.padding?.top ?? 34 + extraPadding;
    const BOTTOM_PADDING = opts?.padding?.bottom ?? 20 + extraPadding;
    const groupX = Math.round(absoluteBounds.minX - SIDE_PADDING);
    const groupY = Math.round(absoluteBounds.minY - TOP_PADDING);
    const groupWidth = Math.round(
      Math.max(220, absoluteBounds.maxX - absoluteBounds.minX + SIDE_PADDING * 2)
    );
    const groupHeight = Math.round(
      Math.max(140, absoluteBounds.maxY - absoluteBounds.minY + TOP_PADDING + BOTTOM_PADDING)
    );

    const existingGroupCount = state.nodes.filter((node) => node.type === CANVAS_NODE_TYPES.group).length;
    const groupDisplayName =
      opts?.label?.trim() || i18n.t('canvas.naming.group', { index: existingGroupCount + 1 });
    const groupNode = canvasNodeFactory.createNode(
      CANVAS_NODE_TYPES.group,
      { x: groupX, y: groupY },
      {
        label: groupDisplayName,
        displayName: groupDisplayName,
      }
    );
    groupNode.width = groupWidth;
    groupNode.height = groupHeight;
    groupNode.style = { width: groupWidth, height: groupHeight };
    groupNode.selected = true;

    const updatedMemberMap = new Map<string, CanvasNode>();
    for (const node of members) {
      const absolute = resolveAbsolutePosition(node, nodeMap);
      updatedMemberMap.set(node.id, {
        ...node,
        parentId: groupNode.id,
        // No extent:'parent': plain group members are not clamped inside the frame and can drag freely; during the drag
        // onNodeDrag grows the group frame live (libtv style), and after release fitGroupToChildren finishes by wrapping them.
        // (Projection groups / storyboard groups have their own constraints and do not go through here.)
        extent: undefined,
        position: {
          x: Math.round(absolute.x - groupX),
          y: Math.round(absolute.y - groupY),
        },
        selected: false,
      });
    }

    const firstMemberIndex = state.nodes.reduce((acc, node, index) => {
      if (!memberSet.has(node.id)) {
        return acc;
      }
      return acc === -1 ? index : Math.min(acc, index);
    }, -1);

    const nextNodes: CanvasNode[] = [];
    let insertedGroup = false;
    for (let index = 0; index < state.nodes.length; index += 1) {
      const node = state.nodes[index];
      if (!insertedGroup && index === firstMemberIndex) {
        nextNodes.push(groupNode);
        insertedGroup = true;
      }

      const updatedMember = updatedMemberMap.get(node.id);
      if (updatedMember) {
        nextNodes.push(updatedMember);
      } else {
        nextNodes.push({
          ...node,
          selected: false,
        });
      }
    }

    if (!insertedGroup) {
      nextNodes.push(groupNode);
    }

    set({
      nodes: nextNodes,
      selectedNodeId: groupNode.id,
      activeToolDialog:
        state.activeToolDialog && memberSet.has(state.activeToolDialog.nodeId)
          ? null
          : state.activeToolDialog,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });

    return groupNode.id;
  },

  autoGroupSpawn: (sourceNodeId, spawnedNodeIds, opts) => {
    const state = get();
    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const source = nodeMap.get(sourceNodeId);
    if (!source) return null;
    // Only adopt "free" new nodes; ones that already belong somewhere are not taken.
    const spawned = spawnedNodeIds
      .map((nodeId) => nodeMap.get(nodeId))
      .filter((node): node is CanvasNode => Boolean(node && !node.parentId));
    if (spawned.length === 0) return null;

    // The nearest ancestor group of the source node.
    let enclosing: CanvasNode | null = null;
    let parentId = source.parentId;
    const visited = new Set<string>();
    while (parentId && !visited.has(parentId)) {
      visited.add(parentId);
      const parent = nodeMap.get(parentId);
      if (!parent) break;
      if (isGroupNode(parent)) {
        enclosing = parent;
        break;
      }
      parentId = parent.parentId;
    }

    if (!enclosing) {
      // Auto groups have looser bounds than manual Ctrl+G, leaving an extra 20px of breathing room around members.
      return get().groupNodes([sourceNodeId, ...spawned.map((node) => node.id)], {
        label: opts?.label,
        extraPadding: 20,
      });
    }
    // Take the id before predicate checks (isStoryboardGroupNode etc. share isGroupNode's type predicate;
    // after the check, enclosing would be narrowed by TS to never, same as the comment in fitGroupToChildren).
    const groupId = enclosing.id;
    // Storyboard groups self-layout as a grid and projection groups are protected - neither takes members, and the protected source node cannot be
    // moved out to be grouped together. But we also cannot just give up here: derived nodes are placed in the "source node's coordinate system"
    // (the caller computes placement from source.position); when the source is in a group that system is group-relative coordinates, while these
    // new nodes stay at root level (no parentId) and would be taken as absolute coordinates - without correction they would land near the canvas origin /
    // out of view (spawnExternalAssets / spawnCharacterLibraryReferences both rely on this function
    // to adopt). Finish in two steps: (1) first translate them back to true absolute coordinates so the assets appear next to the source node;
    // (2) then group these already correctly positioned assets into a root-level asset group on their own (the source node does not join the group and stays in its
    // projection / storyboard group), consistent with the "auto-grouped into an asset group" promise of other call paths.
    if (isStoryboardGroupNode(enclosing) || isProtectedProjectionGroupNode(enclosing)) {
      // offset = the source's absolute coordinates - the source's original position, i.e. the cumulative displacement of all the source's ancestors, valid for any nesting
      // depth. When the group is exactly at the canvas origin the offset is 0, the derived coordinates are already absolute, and the translation is skipped.
      const sourceAbsolute = resolveAbsolutePosition(source, nodeMap);
      const offsetX = sourceAbsolute.x - source.position.x;
      const offsetY = sourceAbsolute.y - source.position.y;
      if (offsetX !== 0 || offsetY !== 0) {
        const orphanSet = new Set(spawned.map((node) => node.id));
        const shiftedNodes = state.nodes.map((node) =>
          orphanSet.has(node.id)
            ? {
                ...node,
                position: {
                  x: node.position.x + offsetX,
                  y: node.position.y + offsetY,
                },
              }
            : node,
        );
        set({
          nodes: shiftedNodes,
          history: {
            past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
            future: [],
          },
          dragHistorySnapshot: null,
          ...trackEdit(state),
        });
      }
      // groupNodes reads the latest store (already translated absolute coordinates), groups the assets into a root-level group and returns the group id.
      // It requires >= 2 members: a single asset cannot form a group and stays a standalone root node (already at correct coordinates),
      // in which case it returns null - consistent with the existing convention that callers "ignore the return value, the asset is already connected".
      return get().groupNodes(
        spawned.map((node) => node.id),
        { label: opts?.label, extraPadding: 20 },
      );
    }

    // Derived positions are all computed from the source node's "original position" (findNodePosition and each node's
    // hand-written layout do not resolve parentId). When the source is in a group that base is group-relative coordinates, so the new node's
    // position can be used directly as group-relative coordinates, with no absolute <-> relative conversion.
    const spawnedSet = new Set(spawned.map((node) => node.id));
    const nextNodes = state.nodes.map((node) =>
      // No extent:'parent': plain group members can drag freely and the group frame grows live while dragging (same as groupNodes).
      spawnedSet.has(node.id)
        ? { ...node, parentId: groupId, extent: undefined }
        : node,
    );

    set({
      nodes: nextNodes,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });
    // New members usually land outside the group bounds (spawn tends to place on the left/right of the source node), so grow the group to contain them.
    get().fitGroupToChildren(groupId);
    return groupId;
  },

  mergeStoryboardGroup: (nodeIds) => {
    const uniqueIds = Array.from(new Set(nodeIds.filter((nodeId) => nodeId.trim().length > 0)));
    if (uniqueIds.length < 2) {
      return null;
    }

    const state = get();
    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const existingIds = uniqueIds.filter((nodeId) => nodeMap.has(nodeId));
    if (existingIds.length < 2) {
      return null;
    }

    // Exclude members whose ancestor is also selected — same rule as groupNodes.
    const selectedSet = new Set(existingIds);
    const memberIds = existingIds.filter((nodeId) => {
      let currentParentId = nodeMap.get(nodeId)?.parentId;
      const visited = new Set<string>();
      while (currentParentId && !visited.has(currentParentId)) {
        if (selectedSet.has(currentParentId)) {
          return false;
        }
        visited.add(currentParentId);
        currentParentId = nodeMap.get(currentParentId)?.parentId;
      }
      return true;
    });
    if (memberIds.length < 2) {
      return null;
    }

    const members = memberIds
      .map((id) => nodeMap.get(id))
      .filter((node): node is CanvasNode => Boolean(node));

    // Reading order by current absolute position (top→bottom, then left→right) so
    // the grid sequence matches how the user laid the shots out.
    const ordered = [...members].sort((a, b) => {
      const pa = resolveAbsolutePosition(a, nodeMap);
      const pb = resolveAbsolutePosition(b, nodeMap);
      return pa.y - pb.y || pa.x - pb.x;
    });

    // Members keep their natural sizes but are HIDDEN — the group renders them as
    // compact thumbnails (libtv style). Their hidden positions form a full-size
    // grid so they spread out cleanly on ungroup / convert.
    const baseWidth = Math.max(...ordered.map((node) => getNodeSize(node).width));
    const baseHeight = Math.max(...ordered.map((node) => getNodeSize(node).height));
    const aspectKey = DEFAULT_STORYBOARD_ASPECT;
    const cols = resolveStoryboardCols(ordered.length);
    // Hidden-member layout: full-size cells (for a clean ungroup spread).
    const { cellWidth: fullCellWidth, cellHeight: fullCellHeight } = computeStoryboardCell(
      baseWidth,
      baseHeight,
      aspectKey
    );
    const memberLayout = computeStoryboardGridLayout({
      count: ordered.length,
      cols,
      cellWidth: fullCellWidth,
      cellHeight: fullCellHeight,
    });
    // Rendered board: compact thumbnail grid — this drives the group box size.
    const board = computeStoryboardBoardLayout({ count: ordered.length, cols, aspectKey });

    // Anchor at the selection's top-left so the board lands roughly in place.
    const anchor = ordered.reduce(
      (acc, node) => {
        const absolute = resolveAbsolutePosition(node, nodeMap);
        return { x: Math.min(acc.x, absolute.x), y: Math.min(acc.y, absolute.y) };
      },
      { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY }
    );
    const groupX = Math.round(Number.isFinite(anchor.x) ? anchor.x : 0);
    const groupY = Math.round(Number.isFinite(anchor.y) ? anchor.y : 0);

    const existingStoryboardCount = state.nodes.filter((node) =>
      isStoryboardGroupNode(node)
    ).length;
    const groupDisplayName = i18n.t('canvas.naming.storyboardGroup', {
      index: existingStoryboardCount + 1,
    });
    const groupNode = canvasNodeFactory.createNode(
      CANVAS_NODE_TYPES.group,
      { x: groupX, y: groupY },
      {
        label: groupDisplayName,
        displayName: groupDisplayName,
        storyboardGroup: true,
        storyboardAspect: aspectKey,
        storyboardCols: board.cols,
        storyboardShowIndex: false,
        storyboardBaseWidth: baseWidth,
        storyboardBaseHeight: baseHeight,
      }
    );
    groupNode.style = { width: board.groupWidth, height: board.groupHeight };
    // Only the header drags the whole board; thumbnails handle their own reorder.
    groupNode.dragHandle = '.storyboard-group-drag-handle';
    groupNode.selected = true;

    const memberSet = new Set(memberIds);
    const updatedMemberMap = new Map<string, CanvasNode>();
    ordered.forEach((node, index) => {
      const cell = memberLayout.cells[index];
      updatedMemberMap.set(node.id, {
        ...node,
        parentId: groupNode.id,
        // No `extent` so the (large) hidden members aren't clamped to the compact
        // board box; `hidden` keeps them out of the canvas while grouped.
        hidden: true,
        position: { x: cell.x, y: cell.y },
        selected: false,
      });
    });

    const firstMemberIndex = state.nodes.reduce((acc, node, index) => {
      if (!memberSet.has(node.id)) {
        return acc;
      }
      return acc === -1 ? index : Math.min(acc, index);
    }, -1);

    const nextNodes: CanvasNode[] = [];
    let insertedGroup = false;
    for (let index = 0; index < state.nodes.length; index += 1) {
      const node = state.nodes[index];
      if (!insertedGroup && index === firstMemberIndex) {
        nextNodes.push(groupNode);
        insertedGroup = true;
      }
      const updatedMember = updatedMemberMap.get(node.id);
      if (updatedMember) {
        nextNodes.push(updatedMember);
      } else {
        nextNodes.push(node.selected ? { ...node, selected: false } : node);
      }
    }
    if (!insertedGroup) {
      nextNodes.push(groupNode);
    }

    // Edge handling once members become hidden thumbnails:
    // - member ↔ member  → internal, hide it (both endpoints invisible).
    // - member ↔ external → re-anchor the member endpoint onto the GROUP so the
    //   connection stays visible (pointing at the board); remember the original
    //   member id so ungroup / convert can restore it.
    const nextEdges = state.edges.map((edge) => {
      const sourceMember = memberSet.has(edge.source);
      const targetMember = memberSet.has(edge.target);
      if (sourceMember && targetMember) {
        return { ...edge, hidden: true };
      }
      if (sourceMember) {
        return {
          ...edge,
          source: groupNode.id,
          data: { ...(edge.data ?? {}), __sbOrigSource: edge.source },
        };
      }
      if (targetMember) {
        return {
          ...edge,
          target: groupNode.id,
          data: { ...(edge.data ?? {}), __sbOrigTarget: edge.target },
        };
      }
      return edge;
    });

    set({
      nodes: nextNodes,
      edges: nextEdges,
      selectedNodeId: groupNode.id,
      activeToolDialog:
        state.activeToolDialog && memberSet.has(state.activeToolDialog.nodeId)
          ? null
          : state.activeToolDialog,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });

    return groupNode.id;
  },

  setStoryboardGroupConfig: (groupNodeId, config) => {
    const state = get();
    const groupNode = state.nodes.find((node) => node.id === groupNodeId);
    if (!isStoryboardGroupNode(groupNode)) {
      return;
    }

    const nextAspect = config.aspectKey ?? groupNode.data.storyboardAspect ?? DEFAULT_STORYBOARD_ASPECT;
    const nextShowIndex =
      typeof config.showIndex === 'boolean'
        ? config.showIndex
        : groupNode.data.storyboardShowIndex === true;

    const childCount = state.nodes.reduce(
      (acc, node) => (node.parentId === groupNodeId ? acc + 1 : acc),
      0
    );
    const requestedCols = config.cols ?? groupNode.data.storyboardCols;
    const cols = resolveStoryboardCols(childCount, requestedCols);

    // Members are hidden thumbnails — only the compact board box / config change.
    const board = computeStoryboardBoardLayout({ count: childCount, cols, aspectKey: nextAspect });

    const nextNodes = state.nodes.map((node) => {
      if (node.id !== groupNodeId) {
        return node;
      }
      return {
        ...node,
        // Update width/height in sync with style: when React Flow renders, explicit width takes priority over
        // style.width (getNodeInlineStyleDimensions); changing only style has no visual effect.
        width: board.groupWidth,
        height: board.groupHeight,
        style: { ...(node.style ?? {}), width: board.groupWidth, height: board.groupHeight },
        data: {
          ...(node.data as GroupNodeData),
          storyboardAspect: nextAspect,
          storyboardCols: board.cols,
          storyboardShowIndex: nextShowIndex,
        },
      };
    });

    set({
      nodes: nextNodes,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });
  },

  reorderStoryboardMember: (groupNodeId, fromIndex, toIndex) => {
    const state = get();
    const group = state.nodes.find((node) => node.id === groupNodeId);
    if (!isStoryboardGroupNode(group)) {
      return;
    }
    // Reading order = members sorted by their (hidden) full-grid position.
    const members = state.nodes
      .filter((node) => node.parentId === groupNodeId)
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);
    if (
      fromIndex < 0 ||
      fromIndex >= members.length ||
      toIndex < 0 ||
      toIndex >= members.length ||
      fromIndex === toIndex
    ) {
      return;
    }

    const reordered = [...members];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);

    // Reassign the full-grid positions in the new order so the sort (and thus the
    // rendered board) reflects it, and ungroup still spreads them cleanly.
    const baseWidth =
      group.data.storyboardBaseWidth ??
      Math.max(...members.map((node) => getNodeSize(node).width));
    const baseHeight =
      group.data.storyboardBaseHeight ??
      Math.max(...members.map((node) => getNodeSize(node).height));
    const cols = resolveStoryboardCols(reordered.length, group.data.storyboardCols);
    const { cellWidth, cellHeight } = computeStoryboardCell(
      baseWidth,
      baseHeight,
      group.data.storyboardAspect ?? DEFAULT_STORYBOARD_ASPECT
    );
    const layout = computeStoryboardGridLayout({
      count: reordered.length,
      cols,
      cellWidth,
      cellHeight,
    });
    const posById = new Map<string, { x: number; y: number }>();
    reordered.forEach((node, index) => {
      const cell = layout.cells[index];
      if (cell) {
        posById.set(node.id, { x: cell.x, y: cell.y });
      }
    });

    const nextNodes = state.nodes.map((node) => {
      const position = posById.get(node.id);
      return position ? { ...node, position } : node;
    });

    set({
      nodes: nextNodes,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });
  },

  addStoryboardMembers: (groupNodeId, images) => {
    const valid = images.filter((image) => image.imageUrl.trim().length > 0);
    if (valid.length === 0) {
      return;
    }
    const state = get();
    const group = state.nodes.find((node) => node.id === groupNodeId);
    if (!isStoryboardGroupNode(group)) {
      return;
    }

    const existing = state.nodes
      .filter((node) => node.parentId === groupNodeId)
      .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);

    const baseWidth =
      group.data.storyboardBaseWidth ??
      (existing.length > 0
        ? Math.max(...existing.map((node) => getNodeSize(node).width))
        : DEFAULT_NODE_WIDTH);
    const baseHeight =
      group.data.storyboardBaseHeight ??
      (existing.length > 0 ? Math.max(...existing.map((node) => getNodeSize(node).height)) : 200);
    const aspectKey = group.data.storyboardAspect ?? DEFAULT_STORYBOARD_ASPECT;

    // New image members are plain result-image nodes (hidden thumbnails like the
    // rest), sized to the group's content floor.
    const newNodes: CanvasNode[] = valid.map((image) => {
      const node = canvasNodeFactory.createNode(
        CANVAS_NODE_TYPES.exportImage,
        { x: 0, y: 0 },
        {
          imageUrl: image.imageUrl,
          previewImageUrl: image.previewImageUrl ?? image.imageUrl,
          displayName: image.displayName ?? i18n.t('canvas.naming.storyboardFrame'),
        }
      );
      node.parentId = groupNodeId;
      node.hidden = true;
      node.selected = false;
      node.width = Math.round(baseWidth);
      node.height = Math.round(baseHeight);
      node.style = { width: Math.round(baseWidth), height: Math.round(baseHeight) };
      return node;
    });

    const allMembers = [...existing, ...newNodes];
    const cols = resolveStoryboardCols(allMembers.length, group.data.storyboardCols);
    const { cellWidth, cellHeight } = computeStoryboardCell(baseWidth, baseHeight, aspectKey);
    const memberLayout = computeStoryboardGridLayout({
      count: allMembers.length,
      cols,
      cellWidth,
      cellHeight,
    });
    const board = computeStoryboardBoardLayout({ count: allMembers.length, cols, aspectKey });

    const posById = new Map<string, { x: number; y: number }>();
    allMembers.forEach((node, index) => {
      const cell = memberLayout.cells[index];
      if (cell) {
        posById.set(node.id, { x: cell.x, y: cell.y });
      }
    });

    const updatedExisting = state.nodes.map((node) => {
      if (node.id === groupNodeId) {
        return {
          ...node,
          // Sync explicit width/height (React Flow's render priority is higher than style, see the arrange comment).
          width: board.groupWidth,
          height: board.groupHeight,
          style: { ...(node.style ?? {}), width: board.groupWidth, height: board.groupHeight },
          data: { ...(node.data as GroupNodeData), storyboardCols: board.cols },
        };
      }
      const position = posById.get(node.id);
      return position ? { ...node, position } : node;
    });
    const positionedNew = newNodes.map((node) => ({
      ...node,
      position: posById.get(node.id) ?? node.position,
    }));

    set({
      // New children appended after the group (which already precedes its members).
      nodes: [...updatedExisting, ...positionedNew],
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });
  },

  convertStoryboardGroupToPlain: (groupNodeId) => {
    const state = get();
    const groupNode = state.nodes.find((node) => node.id === groupNodeId);
    if (!isStoryboardGroupNode(groupNode)) {
      return;
    }

    // Reveal the members (they were hidden thumbnails) and size the group to wrap
    // them at full size, so it becomes an ordinary group showing real nodes.
    const children = state.nodes.filter((node) => node.parentId === groupNodeId);
    const SIDE_PAD = 20;
    let maxX = 0;
    let maxY = 0;
    for (const child of children) {
      const size = getNodeSize(child);
      maxX = Math.max(maxX, child.position.x + size.width);
      maxY = Math.max(maxY, child.position.y + size.height);
    }
    const groupWidth = Math.max(220, Math.round(maxX + SIDE_PAD));
    const groupHeight = Math.max(140, Math.round(maxY + SIDE_PAD));

    const nextNodes = state.nodes.map((node) => {
      if (node.id === groupNodeId) {
        const {
          storyboardGroup: _storyboardGroup,
          storyboardAspect: _storyboardAspect,
          storyboardCols: _storyboardCols,
          storyboardShowIndex: _storyboardShowIndex,
          storyboardBaseWidth: _storyboardBaseWidth,
          storyboardBaseHeight: _storyboardBaseHeight,
          ...restData
        } = node.data as GroupNodeData;
        return {
          ...node,
          // Plain group again → draggable anywhere, no header-only handle.
          dragHandle: undefined,
          // Sync explicit width/height (React Flow's render priority is higher than style).
          width: groupWidth,
          height: groupHeight,
          style: { ...(node.style ?? {}), width: groupWidth, height: groupHeight },
          data: restData as GroupNodeData,
        };
      }
      if (node.parentId === groupNodeId && node.hidden) {
        return { ...node, hidden: false };
      }
      return node;
    });

    // Members are visible again → re-anchor their re-pointed edges back and reveal
    // the hidden internal ones.
    const childIds = new Set(children.map((child) => child.id));
    const nextEdges = restoreStoryboardEdges(state.edges, groupNodeId, childIds);

    set({
      nodes: nextNodes,
      edges: nextEdges,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });
  },

  fitGroupToChildren: (groupNodeId) => {
    const state = get();
    const group = state.nodes.find((node) => node.id === groupNodeId);
    // Storyboard groups size themselves from the compact thumbnail board and
    // their members are hidden — never auto-fit them to (hidden) child bounds.
    if (!isGroupNode(group)) {
      return;
    }
    // Capture geometry while `group` is still narrowed to a group node. The
    // storyboard predicate below shares isGroupNode's type predicate, so
    // chaining it would collapse `group` to `never` for the rest of the
    // function (TS subtracts the identical predicate type).
    const groupStyle = group.style;
    const groupWidth = group.width;
    const groupHeight = group.height;
    // Mainline projection groups must fit too: the group frame is computed by the backend from estimated sizes, while the members' actual rendered sizes (after images
    // load, after text wraps) are only known to the frontend. Without fitting, members with extent:"parent" would be clamped by React
    // Flow into the small frame and pile up. Only "geometric fitting" is opened up here - topology protection (cannot ungroup) is still blocked by
    // ungroupNode.
    if (isStoryboardGroupNode(group)) {
      return;
    }
    const children = state.nodes.filter((node) => node.parentId === groupNodeId);
    if (children.length === 0) {
      return;
    }

    // Match the paddings groupNodes / mergeStoryboardGroup create with, so a
    // correctly-sized group is a no-op. TOP_PAD leaves room for the floating
    // header (`-top-7`).
    const SIDE_PAD = 20;
    const TOP_PAD = 34;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const child of children) {
      const size = getNodeSize(child);
      minX = Math.min(minX, child.position.x);
      minY = Math.min(minY, child.position.y);
      maxX = Math.max(maxX, child.position.x + size.width);
      maxY = Math.max(maxY, child.position.y + size.height);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
      return;
    }

    // Push members inward only when they spill past the top/left edge.
    const shiftX = Math.max(0, Math.round(SIDE_PAD - minX));
    const shiftY = Math.max(0, Math.round(TOP_PAD - minY));
    // Manual resizing goes through React Flow's dimensions change, writing only explicit width/height and not
    // style; projection groups pushed by the backend carry only style conversely. Read both, otherwise grow-only would treat the other
    // side as 0 and shrink the group the user just enlarged back to the content size.
    const curWidth = Math.max(
      typeof groupStyle?.width === 'number' ? groupStyle.width : 0,
      typeof groupWidth === 'number' ? groupWidth : 0
    );
    const curHeight = Math.max(
      typeof groupStyle?.height === 'number' ? groupStyle.height : 0,
      typeof groupHeight === 'number' ? groupHeight : 0
    );
    const neededWidth = Math.round(maxX + shiftX + SIDE_PAD);
    const neededHeight = Math.round(maxY + shiftY + SIDE_PAD);
    // Grow-only so a manual enlarge is never clawed back.
    const nextWidth = Math.max(curWidth, neededWidth);
    const nextHeight = Math.max(curHeight, neededHeight);

    if (shiftX === 0 && shiftY === 0 && nextWidth === curWidth && nextHeight === curHeight) {
      return;
    }

    const childSet = new Set(children.map((child) => child.id));
    const nextNodes = state.nodes.map((node) => {
      if (node.id === groupNodeId) {
        return {
          ...node,
          position: { x: node.position.x - shiftX, y: node.position.y - shiftY },
          // width/height must be in sync with style: when React Flow renders, explicit width takes priority over
          // style.width (getNodeInlineStyleDimensions); changing only style has no visual effect.
          width: nextWidth,
          height: nextHeight,
          style: { ...(node.style ?? {}), width: nextWidth, height: nextHeight },
        };
      }
      if ((shiftX !== 0 || shiftY !== 0) && childSet.has(node.id)) {
        return {
          ...node,
          position: { x: node.position.x + shiftX, y: node.position.y + shiftY },
        };
      }
      return node;
    });

    // Pure layout correction — no history push / trackEdit so it doesn't spam
    // undo or autosave; it re-derives on next mount anyway.
    set({ nodes: nextNodes });
  },

  arrangeGroupChildren: (groupNodeId, mode) => {
    const state = get();
    const group = state.nodes.find((node) => node.id === groupNodeId);
    // Mainline projection groups can also be arranged: "Mainline projection · locked" locks the topology (ungroup / delete members),
    // while arranging only moves member positions and does not change membership, and the user needs a remedy when the backend-computed layout is unsatisfactory.
    // The position of the storyboard board is computed by the thumbnail board itself, and its members are still hidden, so it still does not take part.
    if (!isGroupNode(group) || isStoryboardGroupNode(group)) {
      return;
    }
    const children = state.nodes.filter((node) => node.parentId === groupNodeId);
    if (children.length < 2) return;

    // The same padding as groupNodes / fitGroupToChildren (TOP_PAD leaves room for the floating title).
    const SIDE_PAD = 20;
    const TOP_PAD = 34;
    const GAP = 32;
    // Determine the arrangement order by current position (row-major), preserving the user's intuition of relative order.
    const ordered = children
      .map((node) => ({ node, size: getNodeSize(node) }))
      .sort(
        (a, b) =>
          a.node.position.y - b.node.position.y ||
          a.node.position.x - b.node.position.x,
      );

    const targets = new Map<string, { x: number; y: number }>();
    if (mode === 'horizontal') {
      let cursorX = SIDE_PAD;
      for (const item of ordered) {
        targets.set(item.node.id, { x: cursorX, y: TOP_PAD });
        cursorX += item.size.width + GAP;
      }
    } else if (mode === 'vertical') {
      let cursorY = TOP_PAD;
      for (const item of ordered) {
        targets.set(item.node.id, { x: SIDE_PAD, y: cursorY });
        cursorY += item.size.height + GAP;
      }
    } else {
      // Consistent with Hermes's grid semantics: take a near-square column count by node count, then place into equal-width,
      // equal-height cells row-major. Edges only describe workflow relations and should not degrade the "grid" to a single row.
      const columns = Math.max(1, Math.ceil(Math.sqrt(ordered.length)));
      const cellWidth = Math.max(...ordered.map((item) => item.size.width)) + GAP;
      const cellHeight = Math.max(...ordered.map((item) => item.size.height)) + GAP;
      ordered.forEach((item, index) => {
        targets.set(item.node.id, {
          x: SIDE_PAD + (index % columns) * cellWidth,
          y: TOP_PAD + Math.floor(index / columns) * cellHeight,
        });
      });
    }

    // Tighten the group frame to just wrap the arranged children.
    let maxX = 0;
    let maxY = 0;
    for (const item of ordered) {
      const pos = targets.get(item.node.id);
      if (!pos) continue;
      maxX = Math.max(maxX, pos.x + item.size.width);
      maxY = Math.max(maxY, pos.y + item.size.height);
    }
    const nextWidth = Math.round(maxX + SIDE_PAD);
    const nextHeight = Math.round(maxY + SIDE_PAD);

    const nextNodes = state.nodes.map((node) => {
      if (node.id === groupNodeId) {
        return {
          ...node,
          // Sync explicit width/height (React Flow's render priority is higher than style, see the fit comment).
          width: nextWidth,
          height: nextHeight,
          style: { ...(node.style ?? {}), width: nextWidth, height: nextHeight },
        };
      }
      const pos = targets.get(node.id);
      if (pos) {
        return { ...node, position: pos };
      }
      return node;
    });

    set({
      nodes: nextNodes,
      // A re-arrangement actively triggered by the user from the toolbar permanently moves child nodes (unlike fitGroupToChildren, it cannot be
      // re-derived), so it must enter the undo history, otherwise Cmd+Z cannot restore after a messy arrangement.
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });
  },

  ungroupNode: (groupNodeId) => {
    const state = get();
    const groupNode = state.nodes.find(
      (node) => node.id === groupNodeId && node.type === CANVAS_NODE_TYPES.group
    );
    if (!groupNode) {
      return false;
    }
    if (isProtectedProjectionGroupNode(groupNode)) {
      return false;
    }

    const nodeMap = new Map(state.nodes.map((node) => [node.id, node] as const));
    const children = state.nodes.filter((node) => node.parentId === groupNodeId);
    if (children.length === 0) {
      return false;
    }

    const nextNodes = state.nodes
      .filter((node) => node.id !== groupNodeId)
      .map((node) => {
        if (node.parentId !== groupNodeId) {
          return node;
        }

        const absolute = resolveAbsolutePosition(node, nodeMap);
        return {
          ...node,
          parentId: undefined,
          extent: undefined,
          // Reveal members that were hidden thumbnails inside a storyboard group.
          hidden: false,
          position: {
            x: Math.round(absolute.x),
            y: Math.round(absolute.y),
          },
          selected: false,
        };
      });

    const childIds = new Set(children.map((child) => child.id));
    // Restore storyboard edge rewiring (re-anchor onto members, unhide internal)
    // BEFORE dropping edges still attached to the group, so re-anchored ones survive.
    const nextEdges = restoreStoryboardEdges(state.edges, groupNodeId, childIds).filter(
      (edge) => edge.source !== groupNodeId && edge.target !== groupNodeId
    );

    set({
      nodes: nextNodes,
      edges: nextEdges,
      selectedNodeId: state.selectedNodeId === groupNodeId ? null : state.selectedNodeId,
      activeToolDialog:
        state.activeToolDialog?.nodeId === groupNodeId ? null : state.activeToolDialog,
      history: {
        past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
        future: [],
      },
      dragHistorySnapshot: null,
      ...trackEdit(state),
    });

    return true;
  },

  deleteEdge: (edgeId) => {
    set((state) => {
      const edge = state.edges.find((candidate) => candidate.id === edgeId);
      if (!edge || isPresetManagedEdge(edge)) {
        return {};
      }

      return {
        edges: state.edges.filter((edge) => edge.id !== edgeId),
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state),
      };
    });
  },

  setSelectedNode: (nodeId) => {
    set({ selectedNodeId: nodeId });
  },

  setActiveOverlayNodeId: (nodeId) => {
    set((state) =>
      state.activeOverlayNodeId === nodeId ? state : { activeOverlayNodeId: nodeId }
    );
  },

  setActiveLightEditorNodeId: (nodeId) => {
    set((state) =>
      state.activeLightEditorNodeId === nodeId
        ? state
        : { activeLightEditorNodeId: nodeId }
    );
  },

  setHoveredNodeId: (nodeId) => {
    set((state) =>
      state.hoveredNodeId === nodeId ? state : { hoveredNodeId: nodeId }
    );
  },

  requestFocusNode: (nodeId) => {
    // Use a "re-point" strategy rather than dedup: even for the same id, repeated clicks trigger a new focus.
    set({ pendingFocusNodeId: nodeId });
  },

  clearPendingFocus: () => {
    set({ pendingFocusNodeId: null });
  },

  openToolDialog: (dialog) => {
    set({ activeToolDialog: dialog });
  },

  closeToolDialog: () => {
    set({ activeToolDialog: null });
  },

  undo: () => {
    const state = get();
    const target = state.history.past[state.history.past.length - 1];
    if (!target) {
      return false;
    }

    const currentSnapshot = createSnapshot(state.nodes, state.edges);
    const nextPast = state.history.past.slice(0, -1);

    const undoSource: CanvasMutationSource = isDeleteToEmpty(
      state.nodes.length,
      target.nodes.length,
    )
      ? "delete_to_empty"
      : "user_edit";

    set({
      nodes: target.nodes,
      edges: target.edges,
      selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, target.nodes),
      activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, target.nodes),
      history: {
        past: nextPast,
        future: pushSnapshot(state.history.future, currentSnapshot),
      },
      dragHistorySnapshot: null,
      ...trackEdit(state, undoSource),
    });
    return true;
  },

  redo: () => {
    const state = get();
    const target = state.history.future[state.history.future.length - 1];
    if (!target) {
      return false;
    }

    const currentSnapshot = createSnapshot(state.nodes, state.edges);
    const nextFuture = state.history.future.slice(0, -1);

    const redoSource: CanvasMutationSource = isDeleteToEmpty(
      state.nodes.length,
      target.nodes.length,
    )
      ? "delete_to_empty"
      : "user_edit";

    set({
      nodes: target.nodes,
      edges: target.edges,
      selectedNodeId: resolveSelectedNodeId(state.selectedNodeId, target.nodes),
      activeToolDialog: resolveActiveToolDialog(state.activeToolDialog, target.nodes),
      history: {
        past: pushSnapshot(state.history.past, currentSnapshot),
        future: nextFuture,
      },
      dragHistorySnapshot: null,
      ...trackEdit(state, redoSource),
    });
    return true;
  },

  restoreHistory: (history) => {
    set({ history: normalizeHistory(history) });
  },

  clearCanvas: () => {
    // After switching canvases/clearing, the style reconciliation bookkeeping left by the previous canvas must be invalidated, otherwise re-hydrated
    // image nodes would be treated as "the same node continuing", and ones that should be re-created would be judged as nodes the user deleted.
    resetStyleNodeSyncStates();
    set((state) => {
      if (state.nodes.length === 0 && state.edges.length === 0) {
        return {};
      }

      return {
        nodes: [],
        edges: [],
        selectedNodeId: null,
        activeToolDialog: null,
        history: {
          past: pushSnapshot(state.history.past, createSnapshot(state.nodes, state.edges)),
          future: [],
        },
        dragHistorySnapshot: null,
        ...trackEdit(state, "manual_clear"),
        pendingClearIntent: true,
      };
    });
  },

  acknowledgePendingClear: () => {
    set((state) => (state.pendingClearIntent ? { pendingClearIntent: false } : {}));
  },
}));

/**
 * True while a box-selection spans 2+ nodes. Node components use this to hide
 * their per-node bottom ops panel during a multi-select (the panels only make
 * sense for a single, intentionally-clicked node and otherwise clutter the
 * canvas). The selector returns a boolean so subscribers only re-render when
 * the multi-select state actually flips.
 */
export function useIsBoxSelecting(): boolean {
  return useCanvasStore((state) => {
    let count = 0;
    for (const node of state.nodes) {
      if (node.selected) {
        count += 1;
        if (count > 1) {
          return true;
        }
      }
    }
    return false;
  });
}

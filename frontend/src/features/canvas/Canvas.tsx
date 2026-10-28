// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  BackgroundVariant,
  ConnectionMode,
  SelectionMode,
  useNodesInitialized,
  useReactFlow,
  useStoreApi,
  type Connection,
  type Edge,
  type EdgeChange,
  type FinalConnectionState,
  type HandleType,
  type NodeChange,
  type OnConnectStartParams,
  type Viewport,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { MousePointerClick } from 'lucide-react';
import '@xyflow/react/dist/style.css';

import { useShallow } from 'zustand/react/shallow';

import { CreditDisplayHiddenProvider } from '@/components/credits/credit-visual';
import { isCeRuntime } from '@/lib/runtime-config';
import { resolveAbsolutePosition, useCanvasStore } from '@/stores/canvasStore';
import { useAppStore } from '@/stores/app-store';
import { getSkillRegistry } from '@/api/skills';
import { SKILL_SCHEMA_VERSION, type SkillDefinition } from '@/features/freezone/context/skillRoles';
import { translateSkillName } from '@/features/freezone/context/skillI18n';
import { canvasAiGateway, canvasEventBus } from '@/features/canvas/application/canvasServices';
import { stashExternalFile } from '@/features/canvas/application/pendingExternalFiles';
import {
  WORKFLOW_RUN_UPDATED_EVENT,
  type WorkflowRunUpdatedDetail,
} from '@/features/canvas/application/workflowExecutionActivity';
import {
  CANVAS_NODE_TYPES,
  type BeatContextNodeData,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeData,
  type CanvasNodeType,
  DEFAULT_NODE_WIDTH,
  isStoryboardGroupNode,
} from '@/features/canvas/domain/canvasNodes';
import {
  CANVAS_ASSET_DRAG_MIME,
  readAssetDragPayload,
  spawnAssetNode,
  type CanvasAssetDragPayload,
} from '@/features/canvas/domain/assetDrag';
import { hydrateAssetDragPayload } from '@/features/canvas/domain/assetDragHydrate';
import type { CanvasAsset } from '@/features/canvas/domain/canvasAssets';
import { isImmersiveViewerActive } from '@/features/viewer-kit/useViewerImmersiveBody';
import { CanvasMinimapBookmarksOverlay } from '@/features/canvas/ui/CanvasMinimapBookmarksOverlay';
import { captureCurrentViewport, jumpToBookmark } from '@/features/canvas/application/bookmarkActions';
import { digitToBookmarkIndex } from '@/features/canvas/domain/viewportBookmarks';
import {
  isPresetManagedEdge,
  isPresetManagedNode,
} from '@/features/canvas/domain/mainlineNodeFlags';
import { prepareNodeImage } from '@/features/canvas/application/imageData';
import {
  CANVAS_LOW_DETAIL_CLASS,
  CANVAS_PANNING_CLASS,
  PANNING_CLASS_RELEASE_DELAY_MS,
  isLowDetailZoom,
  onCanvasHydrateViewport,
  setCanvasGestureActive,
  setCanvasLowDetail,
} from '@/features/canvas/application/canvasLod';
import { isSupportedMediaFile } from '@/features/canvas/application/videoFileTypes';
import { uploadLocalImageToBackend } from '@/features/canvas/application/uploadToolOutput';
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
  extractRequestId,
} from '@/features/canvas/application/generationErrorReport';
import { notifyTaskStillRunning, showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  DETACHED_GENERATION_PATCH,
  nodeNeedsGenerationResume,
  nodeOwnsLiveGenerationJob,
  resumeNodeGeneration,
  staleGenerationJobPatch,
} from '@/features/canvas/application/resumeGeneration';
import { readUrl } from '@/lib/url-params';
import { useQueryClient } from '@tanstack/react-query';
import { prefetchEpisodeBeats, prefetchEpisodeDetail } from '@/lib/queries/episodes';
import {
  getDownstreamSpawnTypes,
  getUpstreamSpawnTypes,
  getAllowedDownstreamTargetTypes,
  getAllowedUpstreamSourceTypes,
  isManualConnectionAllowed,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { nodeCatalog } from '@/features/canvas/application/nodeCatalog';
import { applySkillRoleBindingConnection } from '@/features/canvas/domain/skillConnectionEdges';
import { videoReferenceConnectionRejection } from '@/features/canvas/domain/videoReferenceLimits';
import { videoReferenceEnvelopeForNode } from '@/features/canvas/application/videoReferenceEnvelope';
import { embedStoryboardImageMetadata } from '@/commands/image';
import { nodeTypes as canvasNodeTypes } from './nodes';
import { edgeTypes as canvasEdgeTypes } from './edges';
import { NodeSelectionMenu } from './NodeSelectionMenu';
import { CanvasPickBanner } from './ui/CanvasPickBanner';
import { SelectedNodeOverlay } from './ui/SelectedNodeOverlay';
import { LightEditorCanvasOverlay } from './ui/LightEditorCanvasOverlay';
import { MultiSelectionToolbar } from './ui/MultiSelectionToolbar';
import {
  MultiSelectionConnectButton,
  type BatchConnectParams,
} from './ui/MultiSelectionConnectButton';
import { NodeSpawnPlusOverlay } from './ui/NodeSpawnPlusOverlay';
import { ReferencePickBanner } from './ui/ReferencePickBanner';
import { CanvasPickBanner } from './ui/CanvasPickBanner';
import { ViewportReturnHint } from './ui/ViewportReturnHint';
import { CanvasContextMenu } from './ui/CanvasContextMenu';
import { CanvasFileDropOverlay } from './ui/CanvasFileDropOverlay';
import { NodeToolDialog } from './ui/NodeToolDialog';
import { ImageViewerModal } from './ui/ImageViewerModal';
import { VideoViewerModal } from './ui/VideoViewerModal';
import { CanvasZoomControl } from './ui/CanvasZoomControl';
import { useEdgeVisibilityStore } from './ui/edgeVisibilityStore';
import { CanvasQuickActionBar } from './ui/CanvasQuickActionBar';
import { BackToNodesHint } from './ui/BackToNodesHint';
import { CanvasMinimapButton } from './ui/CanvasMinimapButton';
import { CanvasFpsMeter } from './ui/CanvasFpsMeter';
import { CanvasSnapAlignButton } from './snap-align/CanvasSnapAlignButton';
import { useTrackpadPanStore } from './trackpad-pan/trackpadPanStore';
import { useSmoothMinimapPan } from './hooks/useSmoothMinimapPan';
import { useCanvasToolStore } from './ui/canvasToolStore';
import { SnapAlignGuides } from './snap-align/SnapAlignGuides';
import { useSnapAlignStore } from './snap-align/snapAlignStore';
import {
  createSnapAlignDragSession,
  isSnapAlignPositionChange,
  resolveSnapAlignDragMove,
  type SnapAlignDragSession,
} from './snap-align/resolveSnapAlignDrag';
import { computeAutoLayout } from './application/autoLayout';
import { holdCanvasAutosave } from '@/features/freezone/canvasAutosaveHold';
import {
  migratePastedNodeAssets,
  withholdForeignAssetUrls,
  type PastedNodeForMigration,
} from './application/crossProjectAssets';

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };
const DEFAULT_EDGE_OPTIONS = { type: 'disconnectableEdge' };
const REACT_FLOW_PRO_OPTIONS = { hideAttribution: true };
const CANVAS_NODE_DRAG_FOCUS_CLASS = 'canvas-node-drag-focus';
// Connection snap radius (px, measured from the cursor to the target handle). A node's target handle is a small dot on
// its left edge while the node itself is 300~400px wide; with a small radius (default 20 / old 50) dragging a line to the
// middle of the node falls outside the handle's snap range, so there is no auto-snap and no "will connect" visual feedback.
// A larger radius covers the node body, so dropping anywhere on the node snaps the connection (React Flow highlights the
// valid handle natively). Drops further away on the node body still have the DOM hit-test fallback in handleConnectEnd.
const CONNECTION_SNAP_RADIUS = 160;
// For the manual "+" connection: how close (screen px) the cursor must be to the target node's edge to enter its drop zone.
// The cursor need not be inside the node to trigger drop highlight / edge creation; a neighborhood around the node suffices.
const MANUAL_DROP_PROXIMITY_PX = 56;
const MULTI_SELECTION_KEY_CODES = ['Control', 'Meta'];
const PAN_ACTIVATION_KEY_CODE = 'Space';
// Pan the canvas only by holding the middle mouse button (scroll-wheel) and dragging
// (button 1). Left drag (0) runs the custom marquee box-select on the empty pane;
// right click (2) opens the canvas context menu.
const PAN_ON_DRAG_BUTTONS = [1];
// The left mouse button also pans under the hand tool (H). ReactFlow adds .draggable to the pane when the array contains 0;
// the hand cursor comes from its own styles.
const PAN_ON_DRAG_BUTTONS_HAND = [0, 1];
const NODE_SPAWN_PLUS_HIDE_DELAY_MS = 400;
/** Delay before collapsing the minimap after hover ends; see the comment at setMinimapHover. */
const MINIMAP_HIDE_DELAY_MS = 180;

function resolveCenteredViewport(
  container: HTMLElement | null,
  nodes: CanvasNode[],
  zoom = 1
): Viewport {
  if (!container) {
    return DEFAULT_VIEWPORT;
  }
  const rect = container.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) {
    return DEFAULT_VIEWPORT;
  }

  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const topLevelNodes = nodes.filter((node) => !node.parentId);
  if (topLevelNodes.length === 0) {
    return {
      x: rect.width / 2,
      y: rect.height / 2,
      zoom: safeZoom,
    };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of topLevelNodes) {
    const width = node.measured?.width
      ?? (typeof node.width === 'number' ? node.width : DEFAULT_NODE_WIDTH);
    const height = node.measured?.height
      ?? (typeof node.height === 'number' ? node.height : 200);
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + width);
    maxY = Math.max(maxY, node.position.y + height);
  }

  if (!Number.isFinite(minX) || !Number.isFinite(minY)) {
    return {
      x: rect.width / 2,
      y: rect.height / 2,
      zoom: safeZoom,
    };
  }

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  return {
    x: rect.width / 2 - centerX * safeZoom,
    y: rect.height / 2 - centerY * safeZoom,
    zoom: safeZoom,
  };
}

interface PendingConnectStart {
  nodeId: string;
  handleType: HandleType;
  handleId?: string | null;
  start?: {
    x: number;
    y: number;
  };
}

interface PreviewConnectionVisual {
  d: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: 'butt' | 'round' | 'square';
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /**
   * Project id at copy time. When pasting into a different project this triggers cross-project asset migration
   * (re-uploading media to the target project). null = not under a project route at copy time.
   */
  sourceProject: string | null;
}

interface DuplicateOptions {
  explicitOffset?: { x: number; y: number };
  disableOffsetIteration?: boolean;
  suppressSelect?: boolean;
  suppressPersist?: boolean;
  /**
   * Paste from a serialized clipboard snapshot instead of looking the source
   * nodes up by id in the live canvas — lets paste work after the originals are
   * deleted and across canvases.
   */
  sourceSnapshot?: ClipboardSnapshot;
  /** Place the pasted group's top-left at this flow position (cursor paste). */
  targetFlowPosition?: { x: number; y: number };
  /** Select every pasted node (not just the first) — used by paste. */
  selectAll?: boolean;
}

/**
 * Module-level node clipboard so copy/paste survives canvas switches within a
 * session (cross-canvas paste). Holds a deep-cloned, self-contained snapshot —
 * independent of the live nodes, so deleting the originals doesn't break paste.
 */
let sharedNodeClipboard: ClipboardSnapshot | null = null;

interface DuplicateResult {
  firstNodeId: string | null;
  idMap: Map<string, string>;
}

interface MarqueeSelectionState {
  start: { x: number; y: number };
  current: { x: number; y: number };
}

const ALT_DRAG_COPY_Z_INDEX = 2000;
const GENERATION_JOB_POLL_INTERVAL_MS = 1400;
const MARQUEE_SELECTION_MIN_DISTANCE = 6;
// Where the batch-connect "+" spawns its new downstream node relative to the
// selection's bounding box: this far to the right, and lifted by ~half a node so
// the fan-in lands roughly centered on the selection.
const BATCH_CONNECT_SPAWN_GAP = 140;
const BATCH_CONNECT_SPAWN_VERTICAL_OFFSET = 160;
const NODE_PLACEMENT_PREVIEW_WIDTH = 320;
const NODE_PLACEMENT_PREVIEW_HEIGHT = 200;

interface GenerationStoryboardMetadata {
  gridRows: number;
  gridCols: number;
  frameNotes: string[];
}

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : null;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : null;
  return {
    width: node.measured?.width ?? styleWidth ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? styleHeight ?? 200,
  };
}

// The "director world" source node and its "director world output" group move together: dragging either one moves the other
// by the same delta. They are independent nodes in the data, linked only by edges (the source is not a child of the group),
// so React Flow does not move them together. The pairing is derived from the graph (works for legacy canvases, no migration):
// capture children in the group (with captureMetadata) are produced by the source node via edges, so
// "source node <-> child.parentId (group)" is the pair. Returns the id of the other side to move along.
//
// Only applies when both are top-level nodes. If the dragged node itself is inside a group (has parentId), never link:
// otherwise when the source and its capture child share a group, its own parent group would be treated as the partner, and
// dragging would move the parent group each frame, which moves all children (including itself) again; the double
// displacement fights itself and causes jank/overlap. Group integrity is already guaranteed by React Flow's parent/child.
function findLinkedCapturePartnerIds(
  draggedId: string,
  nodes: CanvasNode[],
  edges: CanvasEdge[],
): string[] {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const dragged = nodeById.get(draggedId);
  if (!dragged || dragged.parentId) {
    return [];
  }

  const isCaptureChild = (node: CanvasNode | undefined): boolean =>
    Boolean(
      node?.parentId &&
        (node.data as { captureMetadata?: unknown } | undefined)?.captureMetadata,
    );

  const partners = new Set<string>();

  // Dragging a group: find its capture children, then trace back to the source nodes connected to them.
  if (dragged.type === CANVAS_NODE_TYPES.group) {
    const childIds = new Set(
      nodes.filter((node) => node.parentId === draggedId && isCaptureChild(node)).map((node) => node.id),
    );
    if (childIds.size === 0) {
      return [];
    }
    for (const edge of edges) {
      if (!childIds.has(edge.target)) {
        continue;
      }
      const source = nodeById.get(edge.source);
      if (source && !source.parentId && source.id !== draggedId) {
        partners.add(source.id);
      }
    }
    return [...partners];
  }

  // Dragging a source node: follow edges to the capture children it produced and take their (top-level) group.
  for (const edge of edges) {
    if (edge.source !== draggedId) {
      continue;
    }
    const target = nodeById.get(edge.target);
    if (!isCaptureChild(target) || !target?.parentId) {
      continue;
    }
    const group = nodeById.get(target.parentId);
    if (group?.type === CANVAS_NODE_TYPES.group && !group.parentId) {
      partners.add(group.id);
    }
  }
  return [...partners];
}

function hasRectCollision(
  candidateRect: { x: number; y: number; width: number; height: number },
  nodes: CanvasNode[],
  ignoreNodeIds: Set<string>
): boolean {
  const margin = 18;
  return nodes.some((node) => {
    if (ignoreNodeIds.has(node.id)) {
      return false;
    }
    const size = getNodeSize(node);
    return (
      candidateRect.x < node.position.x + size.width + margin &&
      candidateRect.x + candidateRect.width + margin > node.position.x &&
      candidateRect.y < node.position.y + size.height + margin &&
      candidateRect.y + candidateRect.height + margin > node.position.y
    );
  });
}

function rectsIntersect(
  a: { x: number; y: number; width: number; height: number },
  b: { x: number; y: number; width: number; height: number }
): boolean {
  return (
    a.x < b.x + b.width &&
    a.x + a.width > b.x &&
    a.y < b.y + b.height &&
    a.y + a.height > b.y
  );
}

function isCanvasPaneTarget(target: EventTarget | null, wrapperElement: HTMLElement): boolean {
  const element = target as HTMLElement | null;
  if (!element || !wrapperElement.contains(element)) {
    return false;
  }
  if (!element.closest('.react-flow__pane')) {
    return false;
  }
  return !element.closest(
    '.react-flow__node, .react-flow__edge, .react-flow__controls, .react-flow__minimap, .nodrag, .nopan, button, input, textarea, select, [role="button"]'
  );
}

function cloneNodeData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  const tagName = element.tagName.toLowerCase();
  return (
    tagName === 'input' ||
    tagName === 'textarea' ||
    tagName === 'select' ||
    element.isContentEditable ||
    Boolean(element.closest('[role="textbox"]'))
  );
}

function isSpacePanKey(event: KeyboardEvent): boolean {
  return event.code === PAN_ACTIVATION_KEY_CODE || event.key === ' ' || event.key === 'Spacebar';
}

function resolveClipboardImageFile(event: ClipboardEvent): File | null {
  const clipboardItems = event.clipboardData?.items;
  if (!clipboardItems) {
    return null;
  }

  for (const item of Array.from(clipboardItems)) {
    if (!item.type.startsWith('image/')) {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const existingName = typeof file.name === 'string' ? file.name.trim() : '';
    if (existingName) {
      return file;
    }

    const subtype = item.type.split('/')[1]?.split('+')[0] || 'png';
    return new File([file], `pasted-image.${subtype}`, {
      type: file.type || item.type,
      lastModified: Date.now(),
    });
  }

  return null;
}

// Pick image / video / audio files out of an OS file drop, using the isSupportedMediaFile rule
// (consistent with UploadNode's media routing). Non-media files are ignored.
function collectDroppedMediaFiles(dataTransfer: DataTransfer): File[] {
  const files = dataTransfer.files;
  if (!files || files.length === 0) {
    return [];
  }
  return Array.from(files).filter(isSupportedMediaFile);
}

function resolveAllowedNodeTypes(
  handleType: HandleType,
  originNodeType?: CanvasNodeType,
): CanvasNodeType[] {
  // The "create new node" menu shown when a dragged line is dropped on empty canvas shares the same product whitelist as
  // NodeSpawnPlusOverlay's + menu; both live in nodeRegistry (together with the edge rules, so tests can check whether
  // "menu candidates vs edge rules" conflict).
  return handleType === 'source'
    ? getDownstreamSpawnTypes(originNodeType)
    : getUpstreamSpawnTypes(originNodeType);
}

// Manual drag sources allowed into a 3D world node: any node that can carry an image or text result.
const THREE_D_WORLD_MANUAL_SOURCE_TYPES = new Set<CanvasNodeType>([
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.exportImage,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.storyboardGen,
  CANVAS_NODE_TYPES.textAnnotation,
]);

// Manual downstream connections from the 360 panorama viewer are only allowed to image-type nodes.
const PANO_360_DOWNSTREAM_IMAGE_TYPES = new Set<CanvasNodeType>([
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.exportImage,
]);

function canNodeTypeBeManualConnectionSource(
  type: CanvasNodeType,
  targetType?: CanvasNodeType,
): boolean {
  if (targetType === CANVAS_NODE_TYPES.threeDWorld) {
    return THREE_D_WORLD_MANUAL_SOURCE_TYPES.has(type);
  }
  if (type === CANVAS_NODE_TYPES.pano360Viewer) {
    return targetType ? PANO_360_DOWNSTREAM_IMAGE_TYPES.has(targetType) : true;
  }
  // Connections constrained by the type whitelist (audio <- text, audio -> video / video compose) use the domain-layer rules.
  // This checks the "manual" edge rule: the video -> audio provenance edge is created by the vocal/background separation
  // procedure and is allowed by the edge-creation gate, but users must not be able to drag it out themselves.
  if (
    targetType &&
    (getAllowedUpstreamSourceTypes(targetType) || getAllowedDownstreamTargetTypes(type))
  ) {
    return isManualConnectionAllowed(type, targetType);
  }
  // As long as getDownstreamSpawnTypes leaves at least one legal downstream for this type, dragging a line from the right
  // source handle is allowed. This keeps the + menu and the drag menu aligned; adding a node type only needs
  // an update in getDownstreamSpawnTypes.
  return getDownstreamSpawnTypes(type).length > 0;
}

function canNodeBeManualConnectionSource(
  nodeId: string | null | undefined,
  nodes: CanvasNode[],
  targetNodeId?: string | null | undefined,
): boolean {
  if (!nodeId) {
    return false;
  }
  const node = nodes.find((item) => item.id === nodeId);
  if (!node) return false;
  const targetType = targetNodeId
    ? nodes.find((item) => item.id === targetNodeId)?.type
    : undefined;
  return canNodeTypeBeManualConnectionSource(node.type, targetType);
}

function getClientPosition(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in event && 'clientY' in event) {
    return { x: event.clientX, y: event.clientY };
  }

  const touch = 'changedTouches' in event
    ? event.changedTouches[0] ?? event.touches[0]
    : null;
  if (!touch) {
    return null;
  }

  return { x: touch.clientX, y: touch.clientY };
}

function createPreviewPath(line: PreviewConnectionLine): string {
  const { start, end, handleType } = line;
  const deltaX = end.x - start.x;
  const curveStrength = Math.max(36, Math.min(120, Math.abs(deltaX) * 0.4));
  const handleDirection = handleType === 'source' ? 1 : -1;
  const isReverseDrag = deltaX * handleDirection < 0;
  const effectiveDirection = isReverseDrag ? -handleDirection : handleDirection;
  const startControlX = start.x + effectiveDirection * curveStrength;
  const endControlX = end.x - effectiveDirection * curveStrength;

  return `M ${start.x} ${start.y} C ${startControlX} ${start.y}, ${endControlX} ${end.y}, ${end.x} ${end.y}`;
}

function cssEscape(value: string): string {
  return typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');
}

function handleIdFromElement(
  element: Element | null | undefined,
  nodeId: string,
  handleType: HandleType,
): string | null {
  const handleElement = element?.closest?.('.react-flow__handle') as HTMLElement | null;
  if (!handleElement) return null;
  if (handleElement.dataset.nodeid !== nodeId) return null;
  if (!handleElement.classList.contains(handleType)) return null;
  const handleId = handleElement.dataset.handleid;
  return typeof handleId === 'string' && handleId.trim() ? handleId.trim() : null;
}

function isVisibleConnectionHandle(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (
    element.classList.contains('!pointer-events-none')
    || element.classList.contains('opacity-0')
    || element.classList.contains('!opacity-0')
  ) {
    return false;
  }
  const style = window.getComputedStyle(element);
  return style.pointerEvents !== 'none' && style.opacity !== '0' && style.display !== 'none';
}

function nearestHandleIdAtPoint({
  nodeElement,
  nodeId,
  handleType,
  clientPosition,
  maxDistance = 28,
}: {
  nodeElement: HTMLElement | null | undefined;
  nodeId: string;
  handleType: HandleType;
  clientPosition: { x: number; y: number };
  maxDistance?: number;
}): string | null {
  if (!nodeElement) return null;
  let best: { id: string; distance: number } | null = null;
  const handles = Array.from(
    nodeElement.querySelectorAll<HTMLElement>('.react-flow__handle'),
  );
  for (const handle of handles) {
    if (handle.dataset.nodeid !== nodeId || !handle.classList.contains(handleType)) {
      continue;
    }
    if (!isVisibleConnectionHandle(handle)) {
      continue;
    }
    const handleId = handle.dataset.handleid;
    if (!handleId) {
      continue;
    }
    const rect = handle.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const distance = Math.hypot(centerX - clientPosition.x, centerY - clientPosition.y);
    if (distance <= maxDistance && (!best || distance < best.distance)) {
      best = { id: handleId, distance };
    }
  }
  return best?.id ?? null;
}

function resolveConnectEndHandleId({
  eventTarget,
  nodeElement,
  nodeId,
  handleType,
  clientPosition,
}: {
  eventTarget: Element | null;
  nodeElement: HTMLElement | null | undefined;
  nodeId: string;
  handleType: HandleType;
  clientPosition: { x: number; y: number };
}): string | null {
  return (
    handleIdFromElement(eventTarget, nodeId, handleType) ??
    handleIdFromElement(document.elementFromPoint(clientPosition.x, clientPosition.y), nodeId, handleType) ??
    nearestHandleIdAtPoint({
      nodeElement,
      nodeId,
      handleType,
      clientPosition,
    })
  );
}

interface PreviewConnectionLine {
  start: { x: number; y: number };
  end: { x: number; y: number };
  handleType: HandleType;
}

interface PlusConnectDragParams {
  nodeId: string;
  handleType: HandleType;
  clientPosition: { x: number; y: number };
}

interface PendingNodePlacement {
  type: CanvasNodeType;
  initialData?: Partial<Record<string, unknown>>;
  skill?: SkillDefinition;
}

interface CanvasProps {
  projectId?: string;
  canvasId?: string;
  onBlankPaneClick?: () => void;
  controlsPlacement?: 'bottom-right' | 'top-right';
  /**
   * Set to true when a full-screen view such as the storyboard overlay (AssetBoardView) covers the kept-alive canvas:
   * suppresses every window/document-level keyboard and paste listener the canvas registers, and hides floating controls
   * that would sit above the overlay (CanvasQuickActionBar). Otherwise Delete/Tab/Cmd+Z/paste would leak through to the
   * hidden canvas (deleting nodes, opening NodeSelectionMenu, creating and persisting upload nodes). The body-class approach
   * of useViewerImmersiveBody cannot be reused because it would hide the storyboard itself (see the viewer-immersive rule
   * in src/index.css).
   */
  suspended?: boolean;
}

export function Canvas({
  projectId,
  canvasId,
  onBlankPaneClick,
  controlsPlacement = 'bottom-right',
  suspended = false,
}: CanvasProps = {}) {
  const { t } = useTranslation();
  const reactFlowInstance = useReactFlow();
  const reactFlowStore = useStoreApi();
  const nodeTypes = useMemo(() => canvasNodeTypes, []);
  const edgeTypes = useMemo(() => canvasEdgeTypes, []);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Mirror suspended in a ref: global keyboard/paste listeners read the ref rather than a closed-over value,
  // so a prop change does not rebind listeners and switching views takes effect instantly at zero cost.
  const suspendedRef = useRef(suspended);
  suspendedRef.current = suspended;
  const suppressNextPaneClickRef = useRef(false);
  // After a marquee box-select we must swallow the trailing pane `click` at the capture
  // phase: React Flow's Pane onClick calls resetSelectedElements() unconditionally (right
  // after onPaneClick), which would instantly wipe the selection we just applied. Gating
  // our own onPaneClick is not enough — that reset runs regardless. See the capture-phase
  // click listener in the marquee effect.
  const swallowMarqueeClickRef = useRef(false);
  const suppressNextEdgeClickRef = useRef(false);
  const hoveredNodeClearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const plusConnectStartRef = useRef<PendingConnectStart | null>(null);
  // The node DOM currently highlighted as a valid drop target during a manual "+" drag. Manual connections use a self-drawn
  // preview line (not React Flow's native connection), so RF does not put connectingto/valid on the target handle.
  // The drop animation therefore adds/removes a class on the hit node's wrapper directly in dragMove, avoiding putting
  // drop state into node.data, which would re-render all nodes.
  const dropTargetElRef = useRef<HTMLElement | null>(null);
  // Source node ids waiting to be fanned into the next spawned node (batch "+").
  const batchConnectDragRef = useRef<{
    sourceIds: string[];
    start: { x: number; y: number };
  } | null>(null);

  const [minimapPinned, setMinimapPinned] = useState(false);
  const [minimapHovered, setMinimapHovered] = useState(false);
  const [workflowExecutionActive, setWorkflowExecutionActive] = useState(false);
  // Keep the minimap mounted while it is being dragged; otherwise leaving the area would interrupt panning.
  const [minimapPanning, setMinimapPanning] = useState(false);
  const minimapVisible = minimapPinned || minimapHovered || minimapPanning;
  useEffect(() => {
    const handleWorkflowRunUpdated = (event: Event) => {
      const detail = (event as CustomEvent<WorkflowRunUpdatedDetail>).detail;
      const status = detail?.status ?? detail?.run?.status;
      if (status === 'running') {
        setWorkflowExecutionActive(true);
      } else if (
        status === 'completed'
        || status === 'failed'
        || status === 'cancelled'
        || status === 'interrupted'
      ) {
        setWorkflowExecutionActive(false);
      }
    };
    window.addEventListener(WORKFLOW_RUN_UPDATED_EVENT, handleWorkflowRunUpdated);
    return () => window.removeEventListener(WORKFLOW_RUN_UPDATED_EVENT, handleWorkflowRunUpdated);
  }, []);
  // The minimap popover (including the bookmark number row above it) is shown on hover. The number row is a separate DOM
  // subtree above the minimap with a gap: moving the mouse from the minimap to a number button first leaves the minimap, and
  // setting minimapHovered to false immediately would unmount the overlay before the button is clicked ("unclickable").
  // Hiding therefore gets a short delay: leaving delays false, and hovering any region (minimap / trigger button / number row)
  // again cancels it, so the gap can be crossed reliably.
  const minimapHideTimerRef = useRef<number | null>(null);
  const setMinimapHover = useCallback((hovered: boolean) => {
    if (minimapHideTimerRef.current !== null) {
      window.clearTimeout(minimapHideTimerRef.current);
      minimapHideTimerRef.current = null;
    }
    if (hovered) {
      setMinimapHovered(true);
    } else {
      minimapHideTimerRef.current = window.setTimeout(() => {
        setMinimapHovered(false);
        minimapHideTimerRef.current = null;
      }, MINIMAP_HIDE_DELAY_MS);
    }
  }, []);
  // While the minimap eases, the per-frame viewport commit in onMoveEnd must be skipped; see the comment in handleMoveEnd.
  // Use a ref instead of reading minimapPanning: handleMoveEnd runs every frame and should not change identity with state.
  const minimapPanCommitSuppressedRef = useRef(false);
  const handleMinimapPanStart = useCallback(() => {
    minimapPanCommitSuppressedRef.current = true;
    setMinimapPanning(true);
  }, []);
  // "End" here is guaranteed by the hook as "released and easing converged", not the pointerup instant,
  // so the mount guard can be released directly with no fixed delay (convergence time varies with remaining distance;
  // 180ms would not cover it and would cut the easing off midway).
  const handleMinimapPanEnd = useCallback(
    (pointerInsideMinimap: boolean) => {
      minimapPanCommitSuppressedRef.current = false;
      setMinimapPanning(false);
      // Released inside the minimap => keep showing; outside => collapse with the same timing as hover.
      setMinimapHover(pointerInsideMinimap);
    },
    [setMinimapHover],
  );
  useEffect(
    () => () => {
      if (minimapHideTimerRef.current !== null) {
        window.clearTimeout(minimapHideTimerRef.current);
      }
    },
    [],
  );
  // The hovered node id lives in the store: besides feeding NodeSpawnPlusOverlay's "+", the upload/replace button rail of
  // NodeSideActionRail also needs it to "show only on hover".
  const hoveredNodeId = useCanvasStore((state) => state.hoveredNodeId);
  const setHoveredNodeId = useCanvasStore((state) => state.setHoveredNodeId);

  const [showNodeMenu, setShowNodeMenu] = useState(false);
  const [isNodeDragFocusActive, setIsNodeDragFocusActive] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [flowPosition, setFlowPosition] = useState({ x: 0, y: 0 });
  const [pendingNodePlacement, setPendingNodePlacement] =
    useState<PendingNodePlacement | null>(null);
  const [nodePlacementClientPosition, setNodePlacementClientPosition] =
    useState<{ x: number; y: number } | null>(null);
  const [placementConfirmNodeId, setPlacementConfirmNodeId] = useState<string | null>(null);
  const [isPlusConnectDragging, setIsPlusConnectDragging] = useState(false);
  const [menuAllowedTypes, setMenuAllowedTypes] = useState<CanvasNodeType[] | undefined>(
    undefined
  );
  const [pendingConnectStart, setPendingConnectStart] = useState<PendingConnectStart | null>(
    null
  );
  // When set, the next spawned node (from the batch "+") is fanned into by all
  // these source nodes instead of the single `pendingConnectStart`.
  const [pendingBatchConnectIds, setPendingBatchConnectIds] = useState<string[] | null>(null);
  // Right-click (no-drag) context menu on the canvas pane. `x/y` are relative to
  // the canvas wrapper; `clientX/Y` drive spawn/menu positioning; the `can*`
  // flags are captured at open time so the menu reflects state at that moment.
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    clientX: number;
    clientY: number;
    canUndo: boolean;
    canRedo: boolean;
    canPaste: boolean;
  } | null>(null);
  const [previewConnectionVisual, setPreviewConnectionVisual] =
    useState<PreviewConnectionVisual | null>(null);
  const [skillRegistry, setSkillRegistry] = useState<SkillDefinition[]>([]);
  const [marqueeSelection, setMarqueeSelection] = useState<MarqueeSelectionState | null>(
    null
  );

  const isRestoringCanvasRef = useRef(true);
  const initialViewportCorrectionPendingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const placementConfirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nodesInitialized = useNodesInitialized();
  const copiedSnapshotRef = useRef<ClipboardSnapshot | null>(sharedNodeClipboard);
  const pasteIterationRef = useRef(0);
  const pasteImageHandledRef = useRef(false);
  const lastCanvasPointerClientPositionRef = useRef<{ x: number; y: number } | null>(null);

  const clearHoveredNodeTimer = useCallback(() => {
    if (hoveredNodeClearTimerRef.current !== null) {
      clearTimeout(hoveredNodeClearTimerRef.current);
      hoveredNodeClearTimerRef.current = null;
    }
  }, []);

  const triggerPlacementConfirm = useCallback((nodeId: string) => {
    if (placementConfirmTimerRef.current !== null) {
      clearTimeout(placementConfirmTimerRef.current);
    }
    setPlacementConfirmNodeId(nodeId);
    placementConfirmTimerRef.current = setTimeout(() => {
      setPlacementConfirmNodeId(null);
      placementConfirmTimerRef.current = null;
    }, 900);
  }, []);

  const scheduleHoveredNodeClear = useCallback(() => {
    clearHoveredNodeTimer();
    hoveredNodeClearTimerRef.current = setTimeout(() => {
      setHoveredNodeId(null);
      hoveredNodeClearTimerRef.current = null;
    }, NODE_SPAWN_PLUS_HIDE_DELAY_MS);
  }, [clearHoveredNodeTimer]);

  const enterNodeDragFocus = useCallback(() => {
    document.body.classList.add(CANVAS_NODE_DRAG_FOCUS_CLASS);
    setIsNodeDragFocusActive(true);
    clearHoveredNodeTimer();
    setHoveredNodeId(null);
    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setContextMenu(null);
  }, [clearHoveredNodeTimer, setHoveredNodeId]);

  const exitNodeDragFocus = useCallback(() => {
    document.body.classList.remove(CANVAS_NODE_DRAG_FOCUS_CLASS);
    setIsNodeDragFocusActive(false);
  }, []);

  const handleNodeMouseEnter = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      clearHoveredNodeTimer();
      setHoveredNodeId(node.id);
    },
    [clearHoveredNodeTimer],
  );

  const handleNodeMouseLeave = useCallback(() => {
    scheduleHoveredNodeClear();
  }, [scheduleHoveredNodeClear]);

  const handleCanvasPointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    if (pendingNodePlacement) {
      const rect = wrapperElement.getBoundingClientRect();
      if (
        event.clientX >= rect.left &&
        event.clientX <= rect.right &&
        event.clientY >= rect.top &&
        event.clientY <= rect.bottom
      ) {
        const clientPosition = { x: event.clientX, y: event.clientY };
        lastCanvasPointerClientPositionRef.current = clientPosition;
        setNodePlacementClientPosition(clientPosition);
      }
      return;
    }

    if (!isCanvasPaneTarget(event.target, wrapperElement)) {
      return;
    }
    lastCanvasPointerClientPositionRef.current = {
      x: event.clientX,
      y: event.clientY,
    };
  }, [pendingNodePlacement]);

  useEffect(() => {
    return () => {
      clearHoveredNodeTimer();
      document.body.classList.remove(CANVAS_NODE_DRAG_FOCUS_CLASS);
      if (placementConfirmTimerRef.current !== null) {
        clearTimeout(placementConfirmTimerRef.current);
      }
    };
  }, [clearHoveredNodeTimer]);
  const activeGenerationPollNodeIdsRef = useRef(new Set<string>());
  const activeTaskResumeNodeIdsRef = useRef(new Set<string>());
  const pasteFromClipboardRef = useRef<
    | ((
        snapshot: ClipboardSnapshot | null,
        targetFlow?: { x: number; y: number },
      ) => string | null)
    | null
  >(null);
  const altDragCopyRef = useRef<{
    sourceNodeIds: string[];
    startPositions: Map<string, { x: number; y: number }>;
    copiedNodeIds: string[];
    sourceToCopyIdMap: Map<string, string>;
  } | null>(null);
  // Ids of the groups owning the group members currently being dragged (libtv style: boxes stay put during the drag; on release
  // each group is re-wrapped with fitGroupToChildren according to the members' final positions). A multi-select drag can carry
  // members of several groups, so this is an array rather than a single id. null = no group members are being dragged.
  const groupFitDragRef = useRef<{ groupIds: string[] } | null>(null);
  // Linked drag of the "director world" source node <-> "director world output" group: at drag start, remember the other side
  // (partner) and its starting position, and move the partner by the same delta during the drag. null = the drag involves no link.
  const linkedDragRef = useRef<{
    partnerStarts: Map<string, { x: number; y: number }>;
    draggedStart: { x: number; y: number };
  } | null>(null);
  // While a single node is dragged other nodes stay put: cache the absolute-position index, parent offsets and the hysteresis
  // lock to avoid rescanning nodes every frame and to convert group-relative positions to the common Flow coordinate system.
  const snapAlignSessionRef = useRef<SnapAlignDragSession | null>(null);
  const marqueeSelectionRef = useRef<{
    active: boolean;
    pointerId: number;
    startClient: { x: number; y: number };
    startLocal: { x: number; y: number };
  } | null>(null);
  const edgePanGestureRef = useRef<{
    active: boolean;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startViewportX: number;
    startViewportY: number;
    zoom: number;
    moved: boolean;
  } | null>(null);
  // True while the space bar is held. React Flow's panActivationKeyCode defaults
  // to 'Space', so space + left-drag pans the canvas — but our custom marquee
  // box-select also runs on left-drag over the pane and would draw a dashed
  // selection box on top of the pan. The marquee pointerdown bails when this is
  // set so space-pan stays a clean grab.
  const spacePanActiveRef = useRef(false);

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  // Edge visibility: when hidden, only the edges handed to ReactFlow get `hidden`; the real edges are untouched (see
  // edgeVisibilityStore). Persistence / auto layout / export all keep using the real edges in the store.
  const edgesHidden = useEdgeVisibilityStore((state) => state.hidden);

  // Prefetch the episode beats/episode-detail referenced by beat-context nodes to warm the cache. Together with the
  // "query only when selected" gate in BeatContextNode, this avoids a 499 loop where nodes request on mount and are cancelled
  // on unmount under viewport virtualization.
  // Reduced to a stable string so the effect below only runs when the set of referenced episodes changes (not on every drag rebuild of nodes).
  const queryClient = useQueryClient();
  // The project id comes from the URL and is constant during the canvas lifetime; memoize once instead of re-parsing in a store selector on every change.
  const canvasProject = useMemo(() => readUrl().project, []);
  const beatContextEpisodesKey = useCanvasStore(
    useShallow((state) => {
      const pairs = new Set<string>();
      for (const node of state.nodes) {
        if (node.type !== CANVAS_NODE_TYPES.beatContext) continue;
        const data = node.data as BeatContextNodeData;
        const project =
          typeof data.projectId === 'string' ? data.projectId : canvasProject;
        const episode = typeof data.episode === 'number' ? data.episode : undefined;
        if (project && episode && episode > 0) pairs.add(`${project}:${episode}`);
      }
      return Array.from(pairs).sort().join(',');
    }),
  );
  useEffect(() => {
    if (!beatContextEpisodesKey) return;
    for (const pair of beatContextEpisodesKey.split(',')) {
      const sep = pair.lastIndexOf(':');
      const project = pair.slice(0, sep);
      const episode = Number(pair.slice(sep + 1));
      prefetchEpisodeBeats(queryClient, project, episode);
      prefetchEpisodeDetail(queryClient, project, episode);
    }
  }, [beatContextEpisodesKey, queryClient]);
  // Trackpad pan switch: when on, ReactFlow's panOnScroll is used (two-finger swipe pans, pinch zooms);
  // when off, it reverts to default wheel zoom.
  const trackpadPanEnabled = useTrackpadPanStore((state) => state.enabled);
  // Pointer tool: under the hand tool (H), left-button drag = pan the canvas.
  const handToolActive = useCanvasToolStore((state) => state.tool === 'hand');
  // When the bottom task-center panel is expanded, yield the bottom space: hide the canvas quick-action bar to avoid overlap.
  const taskPanelOpen = useAppStore((state) => state.taskPanelOpen);
  // Stable signatures of the nodes that need polling / resume, so those effects
  // only re-run when the *set* of pending generations changes — not on every
  // drag frame (which rebuilds the whole `nodes` array). See the two effects below.
  const pendingJobNodeKey = useCanvasStore(
    useShallow((state) =>
      state.nodes
        .filter(
          (node) =>
            node.type === CANVAS_NODE_TYPES.exportImage && nodeOwnsLiveGenerationJob(node),
        )
        .map((node) => node.id),
    ),
  );
  // generationJobId left over from the previous session (the task was not detached before refresh). These nodes must not enter
  // the polling loop: the gateway's in-memory Map is long empty, so they would only get not_found and be written as failed,
  // cutting off the recovery path ahead of the descriptor resume. See staleGenerationJobPatch.
  const staleJobNodeKey = useCanvasStore(
    useShallow((state) =>
      state.nodes
        .filter(
          (node) =>
            node.type === CANVAS_NODE_TYPES.exportImage && staleGenerationJobPatch(node) !== null,
        )
        .map((node) => node.id),
    ),
  );
  const pendingResumeNodeKey = useCanvasStore(
    useShallow((state) => state.nodes.filter(nodeNeedsGenerationResume).map((node) => node.id)),
  );
  const history = useCanvasStore((state) => state.history);
  const dragHistorySnapshot = useCanvasStore((state) => state.dragHistorySnapshot);
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const applyEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const connectNodes = useCanvasStore((state) => state.onConnect);
  const replaceEdges = useCanvasStore((state) => state.replaceEdges);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const pendingFocusNodeId = useCanvasStore((state) => state.pendingFocusNodeId);
  const clearPendingFocus = useCanvasStore((state) => state.clearPendingFocus);
  const requestFocusNode = useCanvasStore((state) => state.requestFocusNode);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const deleteNodes = useCanvasStore((state) => state.deleteNodes);
  const groupNodes = useCanvasStore((state) => state.groupNodes);
  const setNodePositions = useCanvasStore((state) => state.setNodePositions);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const openToolDialog = useCanvasStore((state) => state.openToolDialog);
  const closeToolDialog = useCanvasStore((state) => state.closeToolDialog);
  const setViewportState = useCanvasStore((state) => state.setViewportState);
  const setCanvasViewportSize = useCanvasStore((state) => state.setCanvasViewportSize);
  // ReactFlow only mounts after useCanvasSync has hydrated the store (freezone
  // web mode renders <Canvas> behind a loading gate), so the restored camera is
  // already in `currentViewport` by our first render. Capture it here and feed
  // it as `defaultViewport` so ReactFlow initializes straight to the saved
  // position instead of {0,0,1} (which dumped all nodes to the bottom-right).
  const initialViewportRef = useRef(useCanvasStore.getState().currentViewport);
  const imageViewer = useCanvasStore((state) => state.imageViewer);
  const closeImageViewer = useCanvasStore((state) => state.closeImageViewer);
  const navigateImageViewer = useCanvasStore((state) => state.navigateImageViewer);
  const [videoViewer, setVideoViewer] = useState<{
    isOpen: boolean;
    videoUrl: string;
    title?: string;
  }>({ isOpen: false, videoUrl: '', title: undefined });
  const closeVideoViewer = useCallback(() => {
    setVideoViewer((prev) => ({ ...prev, isOpen: false }));
  }, []);
  const skillById = useMemo(
    () => new Map(skillRegistry.map((skill) => [skill.id, skill] as const)),
    [skillRegistry],
  );
  const renderedNodes = useMemo(() => {
    if (!placementConfirmNodeId) {
      return nodes;
    }
    return nodes.map((node) => {
      if (node.id !== placementConfirmNodeId) {
        return node;
      }
      return {
        ...node,
        className: [node.className, 'canvas-node-placement-confirm']
          .filter(Boolean)
          .join(' '),
      };
    });
  }, [nodes, placementConfirmNodeId]);

  // When edges are hidden, add `hidden: true` to each edge: ReactFlow skips rendering but the edge stays in the graph, so
  // connecting, reconnecting and persistence are unaffected. When shown, pass the real edges through with zero extra allocation.
  const renderedEdges = useMemo(() => {
    if (!edgesHidden) return edges;
    return edges.map((edge) => (edge.hidden ? edge : { ...edge, hidden: true }));
  }, [edges, edgesHidden]);

  const clearMarqueeSelection = useCallback(() => {
    marqueeSelectionRef.current = null;
    setMarqueeSelection(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    getSkillRegistry()
      .then((items) => {
        if (!cancelled) {
          setSkillRegistry(items);
        }
      })
      .catch((error) => {
        console.warn('[SkillNode] failed to load skill registry for canvas connections', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (suspendedRef.current) {
        return;
      }
      if (!isSpacePanKey(event) || isTypingTarget(event.target) || isImmersiveViewerActive()) {
        return;
      }
      spacePanActiveRef.current = true;
      clearMarqueeSelection();
    };

    // No suspendedRef guard on keyup: it only resets spacePanActiveRef to false (inert state). With a guard,
    // "hold space -> switch to storyboard -> release" would leave the ref stuck at true.
    const handleKeyUp = (event: KeyboardEvent) => {
      if (!isSpacePanKey(event)) {
        return;
      }
      spacePanActiveRef.current = false;
    };

    const handleBlur = () => {
      spacePanActiveRef.current = false;
      clearMarqueeSelection();
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('keyup', handleKeyUp, true);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('keyup', handleKeyUp, true);
      window.removeEventListener('blur', handleBlur);
    };
  }, [clearMarqueeSelection]);

  const persistCanvasSnapshot = useCallback(() => {
    // supertale-fe web mode persists through useCanvasSync's Zustand
    // subscription. This callback is kept so canvas-local event handlers can
    // still schedule a save boundary without coupling to persistence details.
  }, []);

  const scheduleCanvasPersist = useCallback(
    (delayMs = 140) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        persistCanvasSnapshot();
      }, delayMs);
    },
    [persistCanvasSnapshot]
  );

  useEffect(() => {
    const unsubscribeOpen = canvasEventBus.subscribe('tool-dialog/open', (payload) => {
      openToolDialog(payload);
    });
    const unsubscribeClose = canvasEventBus.subscribe('tool-dialog/close', () => {
      closeToolDialog();
    });
    const unsubscribeVideoOpen = canvasEventBus.subscribe('video-viewer/open', ({ videoUrl, title }) => {
      setVideoViewer({ isOpen: true, videoUrl, title });
    });

    return () => {
      unsubscribeOpen();
      unsubscribeClose();
      unsubscribeVideoOpen();
    };
  }, [openToolDialog, closeToolDialog]);

  // Single writer: writes the canvas zoom into the --st-canvas-zoom CSS variable on the root element. Floating toolbars
  // (ZoomScaledToolbar / NodeSideActionRail) follow zoom with CSS `scale(var(...))` instead of each subscribing to zoom
  // via useStore, collapsing "one zoom subscription per node, all re-rendering on zoom" into one imperative
  // subscription that triggers no React re-render.
  useEffect(() => {
    const root = document.documentElement;
    let last = NaN;
    const write = () => {
      const zoom = reactFlowStore.getState().transform[2];
      if (zoom !== last) {
        last = zoom;
        root.style.setProperty('--st-canvas-zoom', String(zoom));
      }
    };
    write();
    return reactFlowStore.subscribe(write);
  }, [reactFlowStore]);

  useEffect(() => {
    isRestoringCanvasRef.current = true;
    if (useCanvasStore.getState().nodes.length === 0) {
      // useCanvasSync owns the camera and has already restored it into the
      // store. Only center the view for a genuinely empty/new canvas;
      // otherwise we'd clobber the restored
      // viewport (and the localStorage copy that mirrors it) with the empty
      // center, snapping the user back to {w/2, h/2} on every refresh.
      setViewportState(resolveCenteredViewport(wrapperRef.current, []));
    }
    const restoreTimer = setTimeout(() => {
      isRestoringCanvasRef.current = false;
    }, 0);

    return () => {
      clearTimeout(restoreTimer);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      closeImageViewer();
      persistCanvasSnapshot();
    };
  }, [
    closeImageViewer,
    persistCanvasSnapshot,
    setViewportState,
  ]);

  useEffect(() => {
    if (isRestoringCanvasRef.current || dragHistorySnapshot) {
      return;
    }

    scheduleCanvasPersist();
  }, [nodes, edges, history, dragHistorySnapshot, scheduleCanvasPersist]);

  // When the project has just loaded, first restore the user's saved viewport.
  // After nodes are measured, check: if the node bbox does not intersect the visible area at all (the view flew to blank space),
  // automatically fitView back to the node cluster so users do not lose their content.
  useEffect(() => {
    if (!initialViewportCorrectionPendingRef.current) return;
    if (!nodesInitialized) return;

    const container = wrapperRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;

    initialViewportCorrectionPendingRef.current = false;

    const topLevelNodes = nodes.filter((node) => !node.parentId);
    if (topLevelNodes.length === 0) return;

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const node of topLevelNodes) {
      const width = node.measured?.width
        ?? (typeof node.width === 'number' ? node.width : DEFAULT_NODE_WIDTH);
      const height = node.measured?.height
        ?? (typeof node.height === 'number' ? node.height : 200);
      minX = Math.min(minX, node.position.x);
      minY = Math.min(minY, node.position.y);
      maxX = Math.max(maxX, node.position.x + width);
      maxY = Math.max(maxY, node.position.y + height);
    }
    if (!Number.isFinite(minX)) return;

    const vp = reactFlowInstance.getViewport();
    const viewMinX = -vp.x / vp.zoom;
    const viewMaxX = (rect.width - vp.x) / vp.zoom;
    const viewMinY = -vp.y / vp.zoom;
    const viewMaxY = (rect.height - vp.y) / vp.zoom;

    const overlapsView =
      maxX > viewMinX && minX < viewMaxX && maxY > viewMinY && minY < viewMaxY;

    if (!overlapsView) {
      reactFlowInstance.fitView({ padding: 0.2, duration: 0, maxZoom: 1 });
    }
  }, [nodesInitialized, nodes, reactFlowInstance]);

  // Handle external (e.g. left resource panel) "focus node" requests:
  // setCenter on the node center while keeping the current zoom (so users can see the newly added resource).
  // Right after a node is added, measured is not available yet; fall back to an estimate from DEFAULT_NODE_WIDTH / 240.
  useEffect(() => {
    if (!pendingFocusNodeId) return;
    const target = nodes.find((node) => node.id === pendingFocusNodeId);
    if (!target) {
      clearPendingFocus();
      return;
    }
    const width =
      target.measured?.width ??
      (typeof target.width === 'number' ? target.width : DEFAULT_NODE_WIDTH);
    const height =
      target.measured?.height ??
      (typeof target.height === 'number' ? target.height : 240);
    // A group member's position is relative to its parent group; setCenter needs absolute coordinates or focus would be off.
    const absolute =
      reactFlowInstance.getInternalNode(pendingFocusNodeId)?.internals
        .positionAbsolute ?? target.position;
    const centerX = absolute.x + width / 2;
    const centerY = absolute.y + height / 2;
    const currentZoom = reactFlowInstance.getZoom();
    reactFlowInstance.setCenter(centerX, centerY, {
      zoom: Math.max(currentZoom, 0.6),
      duration: 320,
    });
    clearPendingFocus();
  }, [pendingFocusNodeId, nodes, reactFlowInstance, clearPendingFocus]);

  // At low zoom (around 10%) a new node is only tens of pixels on screen and a dark panel on a dark background is
  // nearly invisible, so users think "it was not created". Every entry that creates a node from nothing reuses the focus
  // mechanism above: the viewport animates in to the new node (zoom raised to >=0.6) so creation is visible and the node is
  // directly editable. At common working zoom there is no focusing, to avoid disturbing the user's composition.
  const focusNewNodeIfLowZoom = useCallback(
    (nodeId: string) => {
      if (isLowDetailZoom(reactFlowInstance.getZoom())) {
        requestFocusNode(nodeId);
      }
    },
    [reactFlowInstance, requestFocusNode],
  );

  useEffect(() => {
    const sleep = (delayMs: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs);
      });

    // First clean up job ids left from the previous session, then pick the ones to poll this session. Order matters: the cleanup
    // removes nodes with a descriptor from the candidate set below (their generationJobId is cleared),
    // leaving recovery to resumeNodeGeneration as the only path.
    for (const node of useCanvasStore.getState().nodes) {
      if (node.type !== CANVAS_NODE_TYPES.exportImage) {
        continue;
      }
      const patch = staleGenerationJobPatch(node);
      if (patch) {
        updateNodeData(node.id, patch);
      }
    }

    const pendingExportNodes = useCanvasStore
      .getState()
      .nodes.filter(
        (node) => node.type === CANVAS_NODE_TYPES.exportImage && nodeOwnsLiveGenerationJob(node),
      );

    for (const pendingNode of pendingExportNodes) {
      if (activeGenerationPollNodeIdsRef.current.has(pendingNode.id)) {
        continue;
      }
      activeGenerationPollNodeIdsRef.current.add(pendingNode.id);

      void (async () => {
        try {
          while (true) {
            const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
            if (!currentNode) {
              break;
            }

            const currentData = currentNode.data as Record<string, unknown>;
            const jobId = typeof currentData.generationJobId === 'string' ? currentData.generationJobId : '';
            const isGenerating = currentData.isGenerating === true;
            if (!jobId || !isGenerating) {
              break;
            }

            const status = await canvasAiGateway.getGenerateImageJob(jobId).catch((error) => {
              console.warn('[GenerationJob] poll failed', { nodeId: pendingNode.id, jobId, error });
              return null;
            });
            if (!status) {
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            if (status.status === 'queued' || status.status === 'running') {
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            if (status.status === 'succeeded' && typeof status.result === 'string' && status.result.trim()) {
              const resultUrl = status.result.trim();
              const prepared = await prepareNodeImage(resultUrl);
              const storyboardMetadataRaw = currentData.generationStoryboardMetadata as GenerationStoryboardMetadata | undefined;
              const hasStoryboardMetadata = Boolean(
                storyboardMetadataRaw
                && Number.isFinite(storyboardMetadataRaw.gridRows)
                && Number.isFinite(storyboardMetadataRaw.gridCols)
                && Array.isArray(storyboardMetadataRaw.frameNotes)
              );
              // Prefer the backend result URL as the canonical imageUrl so
              // downstream requests carry a real http URL, not the re-localized
              // base64. Only the storyboard case needs local processing (to embed
              // grid metadata into the pixels) — re-upload that so imageUrl stays
              // a backend URL too. previewImageUrl mirrors the final imageUrl so
              // the persisted node never carries the local base64 from
              // prepareNodeImage (which would bloat PUT /default).
              let imageUrl = resultUrl;
              if (hasStoryboardMetadata && storyboardMetadataRaw) {
                const imageWithMetadata = await embedStoryboardImageMetadata(prepared.imageUrl, {
                  gridRows: Math.max(1, Math.round(storyboardMetadataRaw.gridRows)),
                  gridCols: Math.max(1, Math.round(storyboardMetadataRaw.gridCols)),
                  frameNotes: storyboardMetadataRaw.frameNotes,
                }).catch((error) => {
                  console.warn('[GenerationJob] embed storyboard metadata failed', {
                    nodeId: pendingNode.id,
                    error,
                  });
                  return prepared.imageUrl;
                });
                imageUrl = await uploadLocalImageToBackend(
                  imageWithMetadata,
                  `storyboard-gen-${pendingNode.id}-${Date.now()}.png`
                );
              }
              const previewImageUrl = imageUrl;

              updateNodeData(pendingNode.id, {
                imageUrl,
                previewImageUrl,
                aspectRatio: prepared.aspectRatio,
                isGenerating: false,
                generationStartedAt: null,
                generationJobId: null,
                generationProviderId: null,
                generationClientSessionId: null,
                generationStoryboardMetadata: undefined,
                generationError: null,
                generationErrorDetails: null,
                generationErrorRequestId: null,
                generationDebugContext: undefined,
              });
              break;
            }

            if (status.status === 'detached') {
              // The frontend stops following this task (the backend cannot find it for a long time), but it is not a failure: do not write
              // generationError, and keep generationRequestPayload so "Regenerate" still works; only give a neutral hint,
              // to avoid marking a task that may still be running as failed.
              // See DETACHED_GENERATION_PATCH for the patch content: only release the in-process jobId;
              // isGenerating and the handle stay so the resume scan after refresh can reattach. Same convention as the
              // erase/redraw path (regenerateFreezoneRedrawNode).
              const detachedSessionId = typeof currentData.generationClientSessionId === 'string'
                ? currentData.generationClientSessionId
                : '';
              if (detachedSessionId === CURRENT_RUNTIME_SESSION_ID) {
                notifyTaskStillRunning(t);
              }
              updateNodeData(pendingNode.id, DETACHED_GENERATION_PATCH);
              break;
            }

            const errorMessage = status.error ?? (status.status === 'not_found' ? 'generation job not found' : 'generation failed');
            const generationClientSessionId = typeof currentData.generationClientSessionId === 'string'
              ? currentData.generationClientSessionId
              : '';
            const shouldShowDialog = generationClientSessionId === CURRENT_RUNTIME_SESSION_ID;
            if (shouldShowDialog) {
              const reportText = buildGenerationErrorReport({
                errorMessage,
                errorDetails: status.error ?? undefined,
                context: currentData.generationDebugContext,
              });
              void showErrorDialog(errorMessage, t('common.error'), status.error ?? undefined, reportText);
            }
            updateNodeData(pendingNode.id, {
              isGenerating: false,
              generationStartedAt: null,
              generationJobId: null,
              generationProviderId: null,
              generationClientSessionId: null,
              // Keep generationStoryboardMetadata + generationRequestPayload intact so
              // "Regenerate" can re-submit (and re-embed grid metadata) after an async failure.
              generationError: errorMessage,
              generationErrorDetails: status.error ?? null,
              // Surface the upstream request_id so the failure card can show it
              // (async failures previously dropped it — see ImageGenNode banner).
              generationErrorRequestId:
                extractRequestId(errorMessage) ?? extractRequestId(status.error),
            });
            break;
          }
        } finally {
          activeGenerationPollNodeIdsRef.current.delete(pendingNode.id);
        }
      })();
    }
  }, [pendingJobNodeKey, staleJobNodeKey, t, updateNodeData]);

  // Resume task_key-based generations (image / video / audio / 3D / script / reverse-prompt)
  // after a page refresh. The submit flows persist a GenerationTaskDescriptor on the
  // node; here we re-attach to the task API so the result lands and the "generating" overlay
  // (driven by generationStartedAt) clears correctly.
  useEffect(() => {
    const projectId = readUrl().project;
    if (!projectId) return;

    const pendingTaskNodes = useCanvasStore.getState().nodes.filter(
      (node) =>
        nodeNeedsGenerationResume(node) &&
        !activeTaskResumeNodeIdsRef.current.has(node.id),
    );

    for (const pendingNode of pendingTaskNodes) {
      activeTaskResumeNodeIdsRef.current.add(pendingNode.id);
      void resumeNodeGeneration({
        node: pendingNode,
        projectId,
        canvasId,
        updateNodeData,
        getNodeData: (nodeId) =>
          (useCanvasStore
            .getState()
            .nodes
            .find((node) => node.id === nodeId)?.data ?? null) as Record<string, unknown> | null,
      }).finally(() => {
        activeTaskResumeNodeIdsRef.current.delete(pendingNode.id);
      });
    }
  }, [canvasId, pendingResumeNodeKey, updateNodeData]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setCanvasViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [setCanvasViewportSize]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      // During a drag, applyNodeChanges rebuilds the nodes array every frame. Here the current snapshot is only "read once" in the event callback
      // and nodes is not listed as a dependency, so the callback is not rebuilt every frame and downstream memo is not defeated.
      const nodes = useCanvasStore.getState().nodes;
      const lockedNodeIds = new Set(nodes.filter(isPresetManagedNode).map((node) => node.id));
      const unlockedChanges = changes.filter((change) => {
        if (!('id' in change)) {
          return true;
        }
        if (!lockedNodeIds.has(change.id)) {
          return true;
        }
        return change.type !== 'remove';
      });
      if (unlockedChanges.length === 0) {
        return;
      }
      // Snap alignment: only intervenes when the user enabled it and exactly one node is being dragged; the end frame also reuses the
      // active session, otherwise React Flow's raw pointer coordinates would overwrite the already snapped final position.
      // Multi-select drag does not snap for now: computing snap deltas per node would misalign them relative to each other.
      // Alt-copy drag is also skipped: handleNodeDrag resets the source / makes the copy follow by delta,
      // and snapping here would fight it.
      let effectiveChanges = unlockedChanges;
      const snapEnabled = useSnapAlignStore.getState().enabled;
      if (snapEnabled && !altDragCopyRef.current) {
        const snapPositionChanges = unlockedChanges.filter((change) =>
          isSnapAlignPositionChange(change, snapAlignSessionRef.current?.nodeId),
        );
        if (snapPositionChanges.length === 1) {
          const change = snapPositionChanges[0];
          const draggedNode = nodes.find((n) => n.id === change.id);
          if (draggedNode) {
            // Rebuild the index only for a new drag (target node changed); later frames of the same drag reuse it.
            if (snapAlignSessionRef.current?.nodeId !== change.id) {
              const linkedPartnerIds = [
                ...(linkedDragRef.current?.partnerStarts.keys() ?? []),
              ];
              snapAlignSessionRef.current = createSnapAlignDragSession({
                nodes,
                draggedNode,
                linkedPartnerIds,
                getAbsolutePosition: (node) =>
                  reactFlowInstance.getInternalNode(node.id)?.internals.positionAbsolute ??
                  node.position,
              });
            }
            const snapSession = snapAlignSessionRef.current;
            const snap = resolveSnapAlignDragMove({
              draggedNode,
              proposedPosition: change.position,
              session: snapSession,
              zoom: reactFlowInstance.getZoom(),
            });
            snapAlignSessionRef.current = snap.session;
            useSnapAlignStore.getState().setGuides(snap.guides);
            effectiveChanges = unlockedChanges.map((c) =>
              c === change
                ? {
                    ...change,
                    position: snap.position,
                  }
                : c
            );
          }
        } else if (snapPositionChanges.length > 1) {
          // Hide guide lines during a multi-select drag to avoid misleading.
          useSnapAlignStore.getState().clearGuides();
        }
      }
      applyNodesChange(effectiveChanges);

      const hasDragMove = unlockedChanges.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          Boolean(change.dragging)
      );
      const hasDragEnd = unlockedChanges.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          change.dragging === false
      );
      const hasResizeMove = unlockedChanges.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          Boolean(change.resizing)
      );
      const hasResizeEnd = unlockedChanges.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          change.resizing === false
      );
      const hasInteractionMove = hasDragMove || hasResizeMove;
      const hasInteractionEnd = hasDragEnd || hasResizeEnd;

      if (hasInteractionMove) {
        return;
      }

      if (hasInteractionEnd) {
        scheduleCanvasPersist(0);
        return;
      }

      scheduleCanvasPersist();
    },
    [applyNodesChange, reactFlowInstance, scheduleCanvasPersist]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      const edges = useCanvasStore.getState().edges;
      const lockedEdgeIds = new Set(edges.filter(isPresetManagedEdge).map((edge) => edge.id));
      const unlockedChanges = changes.filter((change) => {
        if (!('id' in change)) {
          return true;
        }
        if (!lockedEdgeIds.has(change.id)) {
          return true;
        }
        return change.type === 'select';
      });
      if (unlockedChanges.length === 0) {
        return;
      }
      applyEdgesChange(unlockedChanges);
      scheduleCanvasPersist();
    },
    [applyEdgesChange, scheduleCanvasPersist]
  );

  const handleEdgeDoubleClick = useCallback(
    (event: ReactMouseEvent, edge: CanvasEdge) => {
      event.preventDefault();
      event.stopPropagation();
      if (isPresetManagedEdge(edge)) {
        return;
      }
      deleteEdge(edge.id);
      scheduleCanvasPersist(0);
    },
    [deleteEdge, scheduleCanvasPersist]
  );

  const handleEdgeClick = useCallback((event: ReactMouseEvent) => {
    if (!suppressNextEdgeClickRef.current) {
      return;
    }
    suppressNextEdgeClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const connectSkillRoleBinding = useCallback(
    (connection: Connection, explicitSkill?: SkillDefinition | null): boolean => {
      const currentState = useCanvasStore.getState();
      const targetNode = currentState.nodes.find((node) => node.id === connection.target);
      const sourceNode = currentState.nodes.find((node) => node.id === connection.source);
      const skillNode =
        targetNode?.type === CANVAS_NODE_TYPES.skill
          ? targetNode
          : sourceNode?.type === CANVAS_NODE_TYPES.skill
            ? sourceNode
            : null;
      if (!skillNode) {
        return false;
      }
      const skillId =
        typeof (skillNode.data as { skill_id?: unknown }).skill_id === 'string'
          ? (skillNode.data as { skill_id: string }).skill_id
          : '';
      const skillSpec = explicitSkill ?? skillById.get(skillId);
      if (!skillSpec) {
        console.warn('[SkillNode] rejected role binding before skill registry loaded', {
          skillId,
          target: skillNode.id,
        });
        return true;
      }
      if (sourceNode?.type === CANVAS_NODE_TYPES.skill && targetNode?.type !== CANVAS_NODE_TYPES.skill) {
        const sourceRole =
          typeof connection.sourceHandle === 'string'
            ? connection.sourceHandle.trim().split(':', 1)[0]
            : '';
        if (!sourceRole || !skillSpec.inputs.some((input) => input.role === sourceRole)) {
          return false;
        }
      }

      const nextEdges = applySkillRoleBindingConnection({
        nodes: currentState.nodes,
        edges: currentState.edges,
        connection,
        skillSpec,
      });
      if (nextEdges === currentState.edges) {
        return true;
      }
      replaceEdges(nextEdges);
      return true;
    },
    [replaceEdges, skillById],
  );

  const connectGraphNodes = useCallback(
    (connection: Connection, explicitSkill?: SkillDefinition | null): void => {
      if (connectSkillRoleBinding(connection, explicitSkill)) {
        return;
      }
      connectNodes(connection);
    },
    [connectNodes, connectSkillRoleBinding],
  );

  const bindSingleBeatContextInput = useCallback(
    (skillNodeId: string, skill: SkillDefinition) => {
      if (!skill.inputs.some((input) => input.role === 'beat_context')) {
        return;
      }
      const currentState = useCanvasStore.getState();
      const beatContextNodes = currentState.nodes.filter(
        (node) => node.type === CANVAS_NODE_TYPES.beatContext,
      );
      if (beatContextNodes.length !== 1) {
        return;
      }
      connectSkillRoleBinding(
        {
          source: beatContextNodes[0].id,
          target: skillNodeId,
          sourceHandle: 'source',
          targetHandle: 'beat_context',
        },
        skill,
      );
    },
    [connectSkillRoleBinding],
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      if (!canNodeBeManualConnectionSource(connection.source, nodes, connection.target)) {
        return;
      }
      connectGraphNodes(connection);
      scheduleCanvasPersist(0);
    },
    [connectGraphNodes, nodes, scheduleCanvasPersist]
  );

  // A 3D world node is generated from a single upstream image, so it has exactly one incoming edge. If it already has an upstream,
  // further connections are rejected live (drop target greyed out, no edge) to guide the user to disconnect first. The final
  // onConnect has the same hard constraint as a fallback for other paths such as dragging to blank space to create a node.
  const isValidConnection = useCallback(
    (connection: Connection | Edge) => {
      const targetId = connection.target;
      if (!targetId) return true;
      const targetNode = nodes.find((node) => node.id === targetId);
      if (!targetNode) return true;
      // Type rule: during the drag, invalid sources (e.g. audio to image) are greyed out and drops are blocked. Deliberately reuses
      // the same ruler handleConnect uses on release; checking only the domain-layer manual edge rules is not enough, since the extra
      // restrictions of 3D world / 360 panorama would leak out and show as "highlighted as valid while dragging, but nothing happens
      // on release" (the video -> audio provenance edge: allowed by the edge rules but not opened for manual creation).
      const sourceNode = connection.source
        ? nodes.find((node) => node.id === connection.source)
        : undefined;
      if (sourceNode && !canNodeTypeBeManualConnectionSource(sourceNode.type, targetNode.type)) {
        return false;
      }
      // When a video node's materials already reach the capability envelope (9 images / 3 videos / 3 audios / 12 total),
      // the drop target is greyed out and no edge is created. Same ruler as the store's onConnect gate.
      if (
        videoReferenceConnectionRejection(
          nodes,
          edges,
          connection,
          videoReferenceEnvelopeForNode,
        ) != null
      ) {
        return false;
      }
      if (targetNode.type !== CANVAS_NODE_TYPES.threeDWorld) return true;
      return !edges.some(
        (edge) => edge.target === targetId && edge.source !== connection.source,
      );
    },
    [nodes, edges]
  );

  // onMove fires every frame during pan/zoom. Writing currentViewport into the store would make all subscribers rerun their
  // selectors every frame (e.g. BackToNodesHint's O(n) visibility check). Throttled here to ~8fps, with the final value always
  // committed in onMoveEnd, which removes the per-frame store storm while persistence/visibility checks converge promptly.
  const lastViewportCommitRef = useRef(0);

  // LOD effect classes are all applied directly to the DOM via classList, not React state: a setState every frame during pan
  // would hand the rasterization time saved straight back to render, a net loss.
  //
  // lowDetailActive is the only exception: it drives the onlyRenderVisibleElements switch (at low zoom all nodes are lightweight
  // shells, so viewport culling only adds mount/unmount churn and is simply turned off), so it must be
  // React state. setState has a value guard: it is called every frame while panning but the value is unchanged, so no re-render;
  // only the one time zoom crosses the threshold re-renders Canvas.
  const panningReleaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lowDetailActive, setLowDetailActive] = useState(() =>
    isLowDetailZoom(initialViewportRef.current.zoom)
  );
  const applyLowDetailClass = useCallback((zoom: number) => {
    const lowDetail = isLowDetailZoom(zoom);
    wrapperRef.current?.classList.toggle(CANVAS_LOW_DETAIL_CLASS, lowDetail);
    setCanvasLowDetail(lowDetail);
    // Upgrading (leaving low zoom) must land in the same commit as withLodShell's shell -> full swap:
    // if culling were still at the "mount everything at low zoom" level, 302 shells would all be swapped for full components at once
    // (measured ~960ms freeze), and then moveEnd restoring culling would unmount ~290 just-mounted nodes in one batch
    // (another ~1s freeze). With the same commit, culling first narrows the visible set to a dozen or so, and only those mount full
    // components (measured ~90ms). React batches store notifications and setState in the same event,
    // so the set here and the swap are necessarily in the same frame. Downgrading is the opposite - see the comment in handleMoveEnd.
    if (!lowDetail) {
      setLowDetailActive(false);
    }
  }, []);

  const handleMoveStart = useCallback(() => {
    if (panningReleaseTimerRef.current) {
      clearTimeout(panningReleaseTimerRef.current);
      panningReleaseTimerRef.current = null;
    }
    wrapperRef.current?.classList.add(CANVAS_PANNING_CLASS);
    setCanvasGestureActive(true);
  }, []);

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      applyLowDetailClass(viewport.zoom);
      // When downgrading (entering low zoom), turning culling off is only committed when the gesture ends: mounting ~240 shells at once
      // in the middle of a zoom gesture causes a noticeable stutter; deferring until release keeps the gesture smooth. Visible nodes that
      // crossed the threshold mid-gesture are swapped to shells earlier by withLodShell's selector, unaffected by this. The upgrade
      // direction cannot wait until here - see the comment in applyLowDetailClass.
      setLowDetailActive(isLowDetailZoom(viewport.zoom));
      if (panningReleaseTimerRef.current) {
        clearTimeout(panningReleaseTimerRef.current);
      }
      panningReleaseTimerRef.current = setTimeout(() => {
        panningReleaseTimerRef.current = null;
        wrapperRef.current?.classList.remove(CANVAS_PANNING_CLASS);
        setCanvasGestureActive(false);
      }, PANNING_CLASS_RELEASE_DELAY_MS);
      // Minimap easing is a programmatic pan: instance.setViewport once per frame, and ReactFlow runs
      // onMoveStart -> onMove -> onMoveEnd for every setViewport; the end event is only coalesced (150ms) when
      // panOnScroll is on (hard-coded in createPanZoomEndHandler as `panOnScroll ? 150 : 0`). After the user turns off
      // "trackpad pan", panOnScroll=false, the coalescing disappears and this would become ~60 store commits per second - exactly what
      // this change eliminates. When skipping, lastViewportCommitRef is not taken either, so handleMove's 8fps throttle still
      // feeds visibility checks; the final value is committed once when onViewportSettled converges.
      if (minimapPanCommitSuppressedRef.current) {
        return;
      }
      lastViewportCommitRef.current = Date.now();
      setViewportState(viewport);
    },
    [applyLowDetailClass, setViewportState]
  );

  const handleMove = useCallback(
    (_event: unknown, viewport: Viewport) => {
      // Zoom threshold crossings must take effect immediately (users see node content switch), so they are not subject to the throttle below.
      applyLowDetailClass(viewport.zoom);
      const now = Date.now();
      if (now - lastViewportCommitRef.current < 120) {
        return;
      }
      lastViewportCommitRef.current = now;
      setViewportState(viewport);
    },
    [applyLowDetailClass, setViewportState]
  );

  const handleMinimapViewportSettled = useCallback(
    (viewport: Viewport) => {
      lastViewportCommitRef.current = Date.now();
      setViewportState(viewport);
    },
    [setViewportState]
  );

  // Minimap dragging uses its own implementation rather than MiniMap's pannable: the built-in gain compounds as the viewport is
  // dragged away from the content area. See the file header comment of useSmoothMinimapPan.
  // The wiring comes after handleMoveEnd/handleMinimapViewportSettled, which depend on the store's
  // setViewportState; the declaration order cannot be reversed.
  useSmoothMinimapPan({
    enabled: minimapVisible,
    wrapperRef,
    instance: reactFlowInstance,
    onPanStart: handleMinimapPanStart,
    onPanEnd: handleMinimapPanEnd,
    onViewportSettled: handleMinimapViewportSettled,
  });

  // Switching canvases also does not fire onMove/onMoveEnd (events from a programmatic setViewport lag one beat); hydrate
  // feeds it directly in the same event so the culling switch and node mounting land in the same commit.
  useEffect(
    () =>
      onCanvasHydrateViewport((zoom) => {
        applyLowDetailClass(zoom);
        setLowDetailActive(isLowDetailZoom(zoom));
      }),
    [applyLowDetailClass]
  );

  // A viewport restored on first paint does not fire onMove/onMoveEnd; the low-zoom tier must be applied once here.
  useEffect(() => {
    applyLowDetailClass(initialViewportRef.current.zoom);
    setLowDetailActive(isLowDetailZoom(initialViewportRef.current.zoom));
    return () => {
      if (panningReleaseTimerRef.current) {
        clearTimeout(panningReleaseTimerRef.current);
        panningReleaseTimerRef.current = null;
      }
      // The module-level signal must reset along with the canvas, otherwise if a gesture is in progress at unmount, the next mount
      // would think it is "still panning" and never measure.
      setCanvasGestureActive(false);
      setCanvasLowDetail(false);
    };
  }, [applyLowDetailClass]);

  useEffect(() => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    const edgePathSelector = '.react-flow__edge-path, .react-flow__edge-interaction';
    const dragThreshold = 4;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (target.closest('.react-flow__edgeupdater')) {
        return;
      }

      const edgePathElement = target.closest(edgePathSelector);
      if (!edgePathElement) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      edgePanGestureRef.current = {
        active: true,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewportX: viewport.x,
        startViewportY: viewport.y,
        zoom: viewport.zoom,
        moved: false,
      };
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || !gesture.active || event.pointerId !== gesture.pointerId) {
        return;
      }

      const deltaX = event.clientX - gesture.startClientX;
      const deltaY = event.clientY - gesture.startClientY;

      if (!gesture.moved && Math.hypot(deltaX, deltaY) >= dragThreshold) {
        gesture.moved = true;
      }
      if (!gesture.moved) {
        return;
      }

      suppressNextEdgeClickRef.current = true;
      reactFlowInstance.setViewport(
        {
          x: gesture.startViewportX + deltaX,
          y: gesture.startViewportY + deltaY,
          zoom: gesture.zoom,
        },
        { duration: 0 }
      );
    };

    const completeEdgePanGesture = () => {
      const gesture = edgePanGestureRef.current;
      if (!gesture) {
        return;
      }

      edgePanGestureRef.current = null;
      if (!gesture.moved) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      setViewportState(viewport);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    wrapperElement.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);

    return () => {
      wrapperElement.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
    };
  }, [
    reactFlowInstance,
    setViewportState,
  ]);

  const openNodeMenuAtClientPosition = useCallback((clientPosition: { x: number; y: number }) => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    const flowPos = reactFlowInstance.screenToFlowPosition(clientPosition);
    setFlowPosition(flowPos);
    setMenuPosition({
      x: clientPosition.x - (containerRect?.left ?? 0),
      y: clientPosition.y - (containerRect?.top ?? 0),
    });
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
    setPendingNodePlacement(null);
    setNodePlacementClientPosition(null);
    setSelectedNode(null);
    setShowNodeMenu(true);
  }, [reactFlowInstance, setSelectedNode]);

  const closeNodeMenu = useCallback(() => {
    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPendingBatchConnectIds(null);
    setPreviewConnectionVisual(null);
  }, []);

  const cancelNodePlacement = useCallback(() => {
    setPendingNodePlacement(null);
    setNodePlacementClientPosition(null);
  }, []);

  const commitNodePlacementAtClientPosition = useCallback(
    (clientPosition: { x: number; y: number }) => {
      if (!pendingNodePlacement) {
        return false;
      }

      const newNodeId = addNode(
        pendingNodePlacement.type,
        reactFlowInstance.screenToFlowPosition({
          x: clientPosition.x - NODE_PLACEMENT_PREVIEW_WIDTH / 2,
          y: clientPosition.y - NODE_PLACEMENT_PREVIEW_HEIGHT / 2,
        }),
        pendingNodePlacement.initialData,
      );
      setSelectedNode(newNodeId);
      focusNewNodeIfLowZoom(newNodeId);
      if (pendingNodePlacement.skill) {
        bindSingleBeatContextInput(newNodeId, pendingNodePlacement.skill);
      }
      triggerPlacementConfirm(newNodeId);
      scheduleCanvasPersist(0);
      setPendingNodePlacement(null);
      setNodePlacementClientPosition(null);
      suppressNextPaneClickRef.current = true;
      return true;
    },
    [
      addNode,
      bindSingleBeatContextInput,
      focusNewNodeIfLowZoom,
      pendingNodePlacement,
      reactFlowInstance,
      scheduleCanvasPersist,
      setSelectedNode,
      triggerPlacementConfirm,
    ],
  );

  // Clicking a storyboard board focuses it; during node placement, any node click
  // is treated as confirming the preview location instead of selecting that node.
  const handleNodeClick = useCallback(
    (event: ReactMouseEvent, node: CanvasNode) => {
      if (pendingNodePlacement) {
        event.preventDefault();
        event.stopPropagation();
        commitNodePlacementAtClientPosition({ x: event.clientX, y: event.clientY });
        return;
      }
      if (!isStoryboardGroupNode(node)) {
        return;
      }
      const width =
        node.measured?.width ??
        (typeof node.width === 'number' ? node.width : DEFAULT_NODE_WIDTH);
      const height =
        node.measured?.height ??
        (typeof node.height === 'number' ? node.height : 240);
      reactFlowInstance.setCenter(
        node.position.x + width / 2,
        node.position.y + height / 2,
        { zoom: 1, duration: 320 },
      );
    },
    [commitNodePlacementAtClientPosition, pendingNodePlacement, reactFlowInstance],
  );

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (suspendedRef.current) {
        return;
      }
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        event.key !== 'Tab' ||
        isTypingTarget(event.target) ||
        isImmersiveViewerActive()
      ) {
        return;
      }

      const wrapperElement = wrapperRef.current;
      const fallbackRect = wrapperElement
        ?.querySelector<HTMLElement>('.react-flow__pane')
        ?.getBoundingClientRect()
        ?? wrapperElement?.getBoundingClientRect();
      const clientPosition = lastCanvasPointerClientPositionRef.current
        ?? (fallbackRect
          ? {
              x: fallbackRect.left + fallbackRect.width / 2,
              y: fallbackRect.top + fallbackRect.height / 2,
            }
          : null);
      if (!clientPosition) {
        return;
      }

      event.preventDefault();
      openNodeMenuAtClientPosition(clientPosition);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [openNodeMenuAtClientPosition]);

  // Viewport bookmarks: ⌘/Ctrl+digit captures the current viewport into a slot,
  // a bare digit jumps to it, and ⌘/Ctrl+Shift+E clears them all.
  useEffect(() => {
    const handleBookmarkKeys = (event: KeyboardEvent) => {
      if (suspendedRef.current) {
        return;
      }
      if (isTypingTarget(event.target) || isImmersiveViewerActive()) {
        return;
      }
      const commandPressed = event.ctrlKey || event.metaKey;

      // ⌘/Ctrl + Shift + E — clear all bookmarks
      if (commandPressed && event.shiftKey && event.key.toLowerCase() === 'e') {
        event.preventDefault();
        useCanvasStore.getState().clearViewportBookmarks();
        return;
      }

      // Digit keys (no Shift/Alt). ⌘/Ctrl + digit sets; bare digit jumps.
      if (event.shiftKey || event.altKey) {
        return;
      }
      const index = digitToBookmarkIndex(event.key);
      if (index == null) {
        return;
      }
      if (commandPressed) {
        event.preventDefault();
        useCanvasStore
          .getState()
          .setViewportBookmark(index, captureCurrentViewport(reactFlowInstance));
        return;
      }
      event.preventDefault();
      const bookmark = useCanvasStore.getState().viewportBookmarks[index];
      if (bookmark) {
        jumpToBookmark(reactFlowInstance, bookmark);
      }
    };

    window.addEventListener('keydown', handleBookmarkKeys);
    return () => window.removeEventListener('keydown', handleBookmarkKeys);
  }, [reactFlowInstance]);

  // M — toggle the canvas minimap (pin / unpin). Bare key only, so it never
  // collides with ⌘M (minimize) or text input.
  useEffect(() => {
    const handleMinimapKey = (event: KeyboardEvent) => {
      if (suspendedRef.current) {
        return;
      }
      if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
        return;
      }
      if (event.key.toLowerCase() !== 'm') {
        return;
      }
      if (isTypingTarget(event.target) || isImmersiveViewerActive()) {
        return;
      }
      event.preventDefault();
      setMinimapPinned((value) => !value);
    };

    window.addEventListener('keydown', handleMinimapKey);
    return () => window.removeEventListener('keydown', handleMinimapKey);
  }, []);

  // Track the space bar so the marquee box-select can yield to space-pan.
  // Ignored while typing (space is a normal character there). Reset on blur so a
  // keyup that fires off-window (e.g. after an alt-tab) can't leave it stuck on.
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (suspendedRef.current) {
        return;
      }
      if (event.code !== 'Space' || isTypingTarget(event.target)) {
        return;
      }
      spacePanActiveRef.current = true;
    };
    // No guard on keyup, same reason as the space-pan capture listener above: it only resets to inert state.
    const handleKeyUp = (event: KeyboardEvent) => {
      if (event.code !== 'Space') {
        return;
      }
      spacePanActiveRef.current = false;
    };
    const handleBlur = () => {
      spacePanActiveRef.current = false;
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('keyup', handleKeyUp);
    window.addEventListener('blur', handleBlur);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('keyup', handleKeyUp);
      window.removeEventListener('blur', handleBlur);
    };
  }, []);

  useEffect(() => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      // Any fresh pointer interaction clears a stale "swallow the marquee click" flag so a
      // marquee that produced no trailing click can't eat a later, unrelated click.
      swallowMarqueeClickRef.current = false;
      if (pendingNodePlacement) {
        return;
      }
      if (event.button !== 0) {
        return;
      }
      // Space + left-drag is a pan gesture (React Flow's panActivationKeyCode).
      // Don't start a marquee on top of it, or a dashed box shows while panning.
      // The hand tool is the same thing, except the long press is on the tool instead of the space bar: read from the store on demand,
      // so this effect does not re-attach pointer listeners for a toggle.
      if (spacePanActiveRef.current || useCanvasToolStore.getState().tool === 'hand') {
        clearMarqueeSelection();
        return;
      }
      if (!isCanvasPaneTarget(event.target, wrapperElement)) {
        return;
      }

      const containerRect = wrapperElement.getBoundingClientRect();
      const startLocal = {
        x: event.clientX - containerRect.left,
        y: event.clientY - containerRect.top,
      };
      // Only record a candidate gesture here. We deliberately do NOT
      // preventDefault/stopPropagation on pointer down so a plain left click (no drag)
      // still reaches React Flow's onPaneClick — keeping deselect-on-click and
      // double-click-opens-node-menu working. Suppression starts once the marquee activates.
      marqueeSelectionRef.current = {
        active: false,
        pointerId: event.pointerId,
        startClient: { x: event.clientX, y: event.clientY },
        startLocal,
      };
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = marqueeSelectionRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      // Space or H pressed mid-drag to switch to the hand tool: abandon the box selection in place so the dashed box does not pan along.
      if (spacePanActiveRef.current || useCanvasToolStore.getState().tool === 'hand') {
        clearMarqueeSelection();
        return;
      }

      const distance = Math.hypot(
        event.clientX - gesture.startClient.x,
        event.clientY - gesture.startClient.y
      );
      if (!gesture.active && distance < MARQUEE_SELECTION_MIN_DISTANCE) {
        // Below the drag threshold: leave the event alone so a click can still form.
        return;
      }
      if (!gesture.active) {
        gesture.active = true;
        setShowNodeMenu(false);
        setMenuAllowedTypes(undefined);
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        setSelectedNode(null);
        // Drop any prior selection frame so it doesn't linger behind the new marquee.
        reactFlowStore.setState({ nodesSelectionActive: false });
      }

      const containerRect = wrapperElement.getBoundingClientRect();
      setMarqueeSelection({
        start: gesture.startLocal,
        current: {
          x: event.clientX - containerRect.left,
          y: event.clientY - containerRect.top,
        },
      });
      event.preventDefault();
      event.stopPropagation();
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = marqueeSelectionRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      // Space or H pressed mid-drag to switch to the hand tool: abandon the box selection in place so the dashed box does not pan along.
      if (spacePanActiveRef.current || useCanvasToolStore.getState().tool === 'hand') {
        clearMarqueeSelection();
        return;
      }

      const distance = Math.hypot(
        event.clientX - gesture.startClient.x,
        event.clientY - gesture.startClient.y
      );
      // Decide purely on the start→end travel distance, NOT on gesture.active.
      // A fast flick can go pointerdown → pointerup with zero pointermove events in
      // between, so `active` (only flipped inside pointermove) stays false even though
      // the pointer travelled a real box's worth of distance. Gating on `active` here
      // dropped those quick marquees. The start point was captured on pointerdown, so we
      // can resolve the selection rect from start/end alone regardless of `active`.
      if (distance < MARQUEE_SELECTION_MIN_DISTANCE) {
        // No real drag → treat as a plain pane click and let React Flow's onPaneClick
        // run (deselect on single click, open the node menu on double click).
        clearMarqueeSelection();
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      const startFlow = reactFlowInstance.screenToFlowPosition(gesture.startClient);
      const endFlow = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });
      const selectionRect = {
        x: Math.min(startFlow.x, endFlow.x),
        y: Math.min(startFlow.y, endFlow.y),
        width: Math.abs(endFlow.x - startFlow.x),
        height: Math.abs(endFlow.y - startFlow.y),
      };
      // Hit-test in ABSOLUTE flow coords. `node.position` is parent-relative for
      // grouped nodes (e.g. preset-projection children), so testing it raw against the
      // absolute selectionRect made the marquee silently miss every grouped node even
      // when the box visibly covered them. resolveAbsolutePosition walks the parent
      // chain; for top-level nodes it returns node.position unchanged.
      const nodeMap = new Map(nodes.map((node) => [node.id, node] as const));
      const hitIds = new Set(
        nodes
          .filter((node) => {
            const size = getNodeSize(node);
            const absolute = resolveAbsolutePosition(node, nodeMap);
            return rectsIntersect(selectionRect, {
              x: absolute.x,
              y: absolute.y,
              width: size.width,
              height: size.height,
            });
          })
          .map((node) => node.id)
      );
      // When the box also touches a group that ENCLOSES some of the touched nodes, drop
      // that container group and keep the inner nodes: "the box touched it, so select it"
      // means the asset nodes the user sees, not the protected projection container that
      // happens to wrap them — and selecting a parent together with its child makes React
      // Flow apply the drag delta to both, double-moving the child. Any hit node that is an
      // ancestor of another hit node is treated as such a container and removed.
      const ancestorsOfHits = new Set<string>();
      for (const id of hitIds) {
        const visited = new Set<string>();
        let parentId = nodeMap.get(id)?.parentId;
        while (parentId && !visited.has(parentId)) {
          visited.add(parentId);
          if (hitIds.has(parentId)) {
            ancestorsOfHits.add(parentId);
          }
          parentId = nodeMap.get(parentId)?.parentId;
        }
      }
      const selectedIds = new Set(
        [...hitIds].filter((id) => !ancestorsOfHits.has(id))
      );

      const changes = nodes
        .filter((node) => Boolean(node.selected) !== selectedIds.has(node.id))
        .map((node) => ({
          id: node.id,
          type: 'select' as const,
          selected: selectedIds.has(node.id),
        }));
      if (changes.length > 0) {
        applyNodesChange(changes);
      }
      // Surface React Flow's native selection frame (.react-flow__nodesselection-rect,
      // styled as the white dashed box in index.css) around the right-drag result,
      // matching Ctrl/⌘ box-select. Programmatic selection alone never sets this flag,
      // so we set it explicitly; the nodes-prop reconcile keeps it true while ≥1 node
      // stays selected, and the native pane-click path clears it like any other selection.
      reactFlowStore.setState({ nodesSelectionActive: selectedIds.size > 0 });
      setSelectedNode(selectedIds.size === 1 ? Array.from(selectedIds)[0] : null);
      // The browser fires a `click` on the pane right after this drag (mousedown + mouseup
      // share the pane as target). React Flow's Pane onClick runs resetSelectedElements()
      // unconditionally, which would wipe the selection we just applied. Swallow that one
      // click at the capture phase (handleClickCapture) before React Flow ever sees it.
      swallowMarqueeClickRef.current = true;
      clearMarqueeSelection();
    };

    const handleClickCapture = (event: MouseEvent) => {
      if (!swallowMarqueeClickRef.current) {
        return;
      }
      swallowMarqueeClickRef.current = false;
      // Stop the event during capture so it never reaches React Flow's Pane onClick (and
      // thus never triggers resetSelectedElements / nodesSelectionActive=false).
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const gesture = marqueeSelectionRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      clearMarqueeSelection();
    };

    const handleContextMenu = (event: MouseEvent) => {
      if (!isCanvasPaneTarget(event.target, wrapperElement)) {
        return;
      }
      if (pendingNodePlacement) {
        event.preventDefault();
        return;
      }
      // Right-click on the empty canvas opens the canvas context menu (undo/redo/paste).
      event.preventDefault();
      const containerRect = wrapperElement.getBoundingClientRect();
      const snapshot = copiedSnapshotRef.current;
      setContextMenu({
        x: event.clientX - containerRect.left,
        y: event.clientY - containerRect.top,
        clientX: event.clientX,
        clientY: event.clientY,
        canUndo: useCanvasStore.getState().history.past.length > 0,
        canRedo: useCanvasStore.getState().history.future.length > 0,
        canPaste: (snapshot?.nodes.length ?? 0) > 0,
      });
    };

    wrapperElement.addEventListener('pointerdown', handlePointerDown, true);
    wrapperElement.addEventListener('contextmenu', handleContextMenu, true);
    wrapperElement.addEventListener('click', handleClickCapture, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);

    return () => {
      wrapperElement.removeEventListener('pointerdown', handlePointerDown, true);
      wrapperElement.removeEventListener('contextmenu', handleContextMenu, true);
      wrapperElement.removeEventListener('click', handleClickCapture, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
    };
  }, [
    applyNodesChange,
    clearMarqueeSelection,
    nodes,
    openNodeMenuAtClientPosition,
    pendingNodePlacement,
    reactFlowInstance,
    reactFlowStore,
    setContextMenu,
    setSelectedNode,
  ]);

  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => Boolean(node.selected)).map((node) => node.id),
    [nodes]
  );
  const selectedUploadNodeId = useMemo(() => {
    if (selectedNodeIds.length !== 1) {
      return null;
    }
    const selectedNode = nodes.find((node) => node.id === selectedNodeIds[0]);
    if (!selectedNode || selectedNode.type !== CANVAS_NODE_TYPES.upload) {
      return null;
    }
    return selectedNode.id;
  }, [nodes, selectedNodeIds]);

  useEffect(() => {
    if (selectedNodeIds.length === 1) {
      if (selectedNodeId !== selectedNodeIds[0]) {
        setSelectedNode(selectedNodeIds[0]);
      }
      return;
    }

    if (selectedNodeId !== null) {
      setSelectedNode(null);
    }
  }, [selectedNodeId, selectedNodeIds, setSelectedNode]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      if (suspendedRef.current) {
        return;
      }
      pasteImageHandledRef.current = false;
      if (isTypingTarget(event.target) || isImmersiveViewerActive()) {
        return;
      }

      // An upload node is selected: an image in the clipboard is pasted straight into that node (existing behavior).
      if (selectedUploadNodeId) {
        const imageFile = resolveClipboardImageFile(event);
        if (imageFile) {
          event.preventDefault();
          pasteImageHandledRef.current = true;
          canvasEventBus.publish('upload-node/paste-image', {
            nodeId: selectedUploadNodeId,
            file: imageFile,
          });
          return;
        }
      }

      // Image / video / audio in the system clipboard -> create an upload node at the cursor.
      // Priority against "paste node snapshot" is decided by clearing the system clipboard when nodes are copied with Cmd+C:
      // after copying nodes there are no media files in the clipboard, so this naturally falls through and yields to snapshot paste.
      // clipboardData is a DataTransfer, so the file drop collection and spawning pipeline is reused directly.
      const mediaFiles = event.clipboardData
        ? collectDroppedMediaFiles(event.clipboardData)
        : [];
      if (mediaFiles.length === 0) {
        return;
      }

      event.preventDefault();
      pasteImageHandledRef.current = true;

      const wrapperElement = wrapperRef.current;
      const fallbackRect = wrapperElement
        ?.querySelector<HTMLElement>('.react-flow__pane')
        ?.getBoundingClientRect()
        ?? wrapperElement?.getBoundingClientRect();
      const clientPosition = lastCanvasPointerClientPositionRef.current
        ?? (fallbackRect
          ? {
              x: fallbackRect.left + fallbackRect.width / 2,
              y: fallbackRect.top + fallbackRect.height / 2,
            }
          : null);
      if (!clientPosition) {
        return;
      }
      const basePosition = reactFlowInstance.screenToFlowPosition(clientPosition);

      let lastNodeId: string | null = null;
      mediaFiles.forEach((file, index) => {
        const position = {
          x: basePosition.x + index * 36,
          y: basePosition.y + index * 36,
        };
        // Mark user_spawned the same way as file drop; see the note in handleCanvasDrop.
        const newNodeId = addNode(
          CANVAS_NODE_TYPES.upload,
          position,
          { user_spawned: true } as Partial<CanvasNodeData>,
        );
        lastNodeId = newNodeId;
        // Stage first, then emit the event, same as file drop; see the note in handleCanvasDrop.
        stashExternalFile('upload-node/external-file', newNodeId, file);
        requestAnimationFrame(() => {
          canvasEventBus.publish('upload-node/external-file', { nodeId: newNodeId });
        });
      });

      if (lastNodeId) {
        setSelectedNode(lastNodeId);
        focusNewNodeIfLowZoom(lastNodeId);
      }
      scheduleCanvasPersist(0);
    };

    document.addEventListener('paste', handlePaste);
    return () => {
      document.removeEventListener('paste', handlePaste);
    };
  }, [
    addNode,
    focusNewNodeIfLowZoom,
    reactFlowInstance,
    scheduleCanvasPersist,
    selectedUploadNodeId,
    setSelectedNode,
  ]);

  const handleOrganizeCanvas = useCallback(() => {
    const { positions, changedCount } = computeAutoLayout(nodes, edges);
    if (Object.keys(positions).length === 0) {
      return;
    }
    if (changedCount > 0) {
      setNodePositions(positions);
      scheduleCanvasPersist(0);
    }
    window.requestAnimationFrame(() => {
      reactFlowInstance.fitView({ duration: 240, padding: 0.2 });
    });
  }, [edges, nodes, reactFlowInstance, scheduleCanvasPersist, setNodePositions]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (suspendedRef.current) {
        return;
      }
      if (isTypingTarget(event.target)) {
        return;
      }
      // While the immersive viewer (3GS director stage full screen) is open it owns the keyboard exclusively (place/delete markers etc.);
      // the canvas's global shortcuts (Delete node / copy-paste etc.) yield, avoiding "deleting the dummy deleted the 3D node".
      if (isImmersiveViewerActive()) {
        return;
      }

      const commandPressed = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const isUndo = commandPressed && key === 'z' && !event.shiftKey;
      const isRedo = commandPressed && (key === 'y' || (key === 'z' && event.shiftKey));
      const isGroup = commandPressed && key === 'g';
      const isCopy = commandPressed && key === 'c' && !event.shiftKey;
      const isPaste = commandPressed && key === 'v' && !event.shiftKey;
      const isOrganize = event.altKey && event.shiftKey && key === 'f' && !commandPressed;

      if (event.key === 'Escape') {
        if (pendingNodePlacement) {
          event.preventDefault();
          cancelNodePlacement();
          return;
        }
        if (showNodeMenu) {
          event.preventDefault();
          closeNodeMenu();
        }
        return;
      }

      if (isOrganize) {
        event.preventDefault();
        handleOrganizeCanvas();
        return;
      }

      // V = move tool, H = hand (same as Figma / liblib). Must be bare keys: V with Cmd/Ctrl is paste,
      // and letters with Alt are mostly the system IME composing.
      if (!commandPressed && !event.altKey && !event.shiftKey && (key === 'v' || key === 'h')) {
        event.preventDefault();
        useCanvasToolStore.getState().setTool(key === 'v' ? 'move' : 'hand');
        return;
      }

      if (isCopy) {
        if (selectedNodeIds.length === 0) {
          return;
        }
        event.preventDefault();
        const selectedIdSet = new Set(selectedNodeIds);
        // Deep-clone into a self-contained snapshot so paste no longer depends
        // on the originals still existing, and mirror it to the module-level
        // clipboard for cross-canvas paste.
        const snapshot: ClipboardSnapshot = {
          nodes: nodes
            .filter((node) => selectedIdSet.has(node.id))
            .map((node) => ({
              ...node,
              data: cloneNodeData(node.data),
              selected: false,
              dragging: false,
            })),
          edges: edges
            .filter(
              (edge) => selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target)
            )
            .map((edge) => ({ ...edge })),
          sourceProject: readUrl().project ?? null,
        };
        copiedSnapshotRef.current = snapshot;
        sharedNodeClipboard = snapshot;
        pasteIterationRef.current = 0;
        // Clear the system clipboard (writing an empty string replaces the whole clipboard content, wiping old images/files),
        // keeping the standard "last copy wins" semantics; otherwise an earlier copied system image would always beat node paste
        // on Cmd+V. An empty string rather than a marker text: a marker would leak as a literal into any
        // text paste target (in-app inputs / external apps). A failed write (permission/focus) is harmless; it just
        // degrades to "if the clipboard has media files, paste the files first".
        void navigator.clipboard?.writeText('').catch(() => undefined);
        return;
      }

      if (isPaste) {
        // Cannot preventDefault / paste the snapshot immediately here: the paste event must fire first and
        // decide on the media files in the system clipboard (paste into a selected upload node, or create a new
        // upload node). If handled, pasteImageHandledRef is set and the node snapshot is not pasted here.
        pasteImageHandledRef.current = false;
        window.setTimeout(() => {
          if (pasteImageHandledRef.current) {
            pasteImageHandledRef.current = false;
            return;
          }
          if (!copiedSnapshotRef.current || copiedSnapshotRef.current.nodes.length === 0) {
            return;
          }
          pasteFromClipboardRef.current?.(copiedSnapshotRef.current);
        }, 0);
        return;
      }

      if (isUndo || isRedo) {
        event.preventDefault();
        const changed = isUndo ? undo() : redo();
        if (changed) {
          scheduleCanvasPersist(0);
        }
        return;
      }

      if (isGroup) {
        if (selectedNodeIds.length < 2) {
          return;
        }
        event.preventDefault();
        const createdGroupId = groupNodes(selectedNodeIds);
        if (createdGroupId) {
          scheduleCanvasPersist(0);
        }
        return;
      }

      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return;
      }

      // Selected edges also support keyboard deletion: skip edges locked by preset-managed,
      // using the same lock rule as double-click disconnect (handleEdgeDoubleClick). Read getState()
      // for the latest edges to avoid a stale selection in the keydown closure.
      const allEdges = useCanvasStore.getState().edges;
      const deletableEdgeIds = allEdges
        .filter((edge) => edge.selected && !isPresetManagedEdge(edge))
        .map((edge) => edge.id);
      const hasSelectedEdge = allEdges.some((edge) => edge.selected);

      const idsToDelete = selectedNodeIds.length > 0
        ? selectedNodeIds
        : selectedNodeId
          ? [selectedNodeId]
          : [];

      const lockedNodeIds = new Set(nodes.filter(isPresetManagedNode).map((node) => node.id));
      const deletableNodeIds = idsToDelete.filter((nodeId) => !lockedNodeIds.has(nodeId));

      if (deletableNodeIds.length === 0 && deletableEdgeIds.length === 0) {
        // While there is a selected target (even if all locked), still swallow the default behavior so Backspace does not trigger browser back.
        if (idsToDelete.length > 0 || hasSelectedEdge) {
          event.preventDefault();
        }
        return;
      }

      event.preventDefault();
      deletableEdgeIds.forEach((edgeId) => deleteEdge(edgeId));
      if (deletableNodeIds.length === 1) {
        deleteNode(deletableNodeIds[0]);
      } else if (deletableNodeIds.length > 1) {
        deleteNodes(deletableNodeIds);
      }
      scheduleCanvasPersist(0);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    selectedNodeId,
    selectedNodeIds,
    deleteNode,
    deleteNodes,
    deleteEdge,
    groupNodes,
    undo,
    redo,
    scheduleCanvasPersist,
    handleOrganizeCanvas,
    showNodeMenu,
    closeNodeMenu,
    pendingNodePlacement,
    cancelNodePlacement,
  ]);

  const handlePaneClick = useCallback((event: ReactMouseEvent) => {
    if (pendingNodePlacement) {
      commitNodePlacementAtClientPosition({ x: event.clientX, y: event.clientY });
      return;
    }

    if (suppressNextPaneClickRef.current) {
      suppressNextPaneClickRef.current = false;
      return;
    }

    if (event.detail >= 2) {
      openNodeMenuAtClientPosition({ x: event.clientX, y: event.clientY });
      suppressNextPaneClickRef.current = true;
      return;
    }

    setSelectedNode(null);
    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
    onBlankPaneClick?.();
  }, [
    commitNodePlacementAtClientPosition,
    onBlankPaneClick,
    openNodeMenuAtClientPosition,
    pendingNodePlacement,
    setSelectedNode,
  ]);

  // Dragging image / video / audio files from the system into the canvas -> create an upload node at the drop point and feed the file to it.
  // UploadNode handles file types itself: images upload in place, videos / audios morph into the matching node.
  // Reuses the existing upload pipeline, so no upload / transcode logic is duplicated at the canvas layer.
  const fileDragDepthRef = useRef(0);
  const [isFileDropActive, setIsFileDropActive] = useState(false);

  const hasDraggedFiles = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) =>
      Array.from(event.dataTransfer.types ?? []).includes('Files'),
    []
  );

  // Custom MIME carried when a sidebar asset card is dragged into the canvas (see assetDrag.ts).
  const hasDraggedAsset = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) =>
      Array.from(event.dataTransfer.types ?? []).includes(CANVAS_ASSET_DRAG_MIME),
    []
  );

  const hasDraggedAnyPayload = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) =>
      hasDraggedFiles(event) || hasDraggedAsset(event),
    [hasDraggedFiles, hasDraggedAsset]
  );

  const handleCanvasDragEnter = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedAnyPayload(event)) {
        return;
      }
      event.preventDefault();
      fileDragDepthRef.current += 1;
      setIsFileDropActive(true);
    },
    [hasDraggedAnyPayload, hasDraggedFiles]
  );

  const handleCanvasDragOver = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedAnyPayload(event)) {
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
    },
    [hasDraggedAnyPayload]
  );

  const handleCanvasDragLeave = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedAnyPayload(event)) {
        return;
      }
      fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
      if (fileDragDepthRef.current === 0) {
        setIsFileDropActive(false);
      }
    },
    [hasDraggedAnyPayload]
  );

  const handleCanvasDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      if (!hasDraggedAnyPayload(event)) {
        return;
      }
      event.preventDefault();
      fileDragDepthRef.current = 0;
      setIsFileDropActive(false);

      const basePosition = reactFlowInstance.screenToFlowPosition({
        x: event.clientX,
        y: event.clientY,
      });

      // ── Sidebar asset drop path ──
      // A sidebar asset card (image / video / audio / 3GS) dragged in -> directly create the matching node at the drop point.
      // Shares spawnAssetNode with the "Add" button to keep node construction consistent.
      const assetPayload = readAssetDragPayload(event.dataTransfer);
      if (assetPayload) {
        void (async () => {
          let hydratedPayload = assetPayload;
          try {
            hydratedPayload = await hydrateAssetDragPayload(assetPayload);
          } catch (error) {
            console.warn('[canvas] scene director world manifest unavailable during import', error);
          }
          const newNodeId = spawnAssetNode(
            useCanvasStore.getState(),
            hydratedPayload,
            basePosition,
          );
          setSelectedNode(newNodeId);
          scheduleCanvasPersist(0);
        })();
        return;
      }

      // ── File drop path ──
      // Files become uploadNode spawns. Pre-existing behavior; preserved on
      // every canvas now that the mainline preset reject is lifted.
      const mediaFiles = collectDroppedMediaFiles(event.dataTransfer);
      if (mediaFiles.length === 0) {
        return;
      }

      let lastNodeId: string | null = null;
      mediaFiles.forEach((file, index) => {
        const position = {
          x: basePosition.x + index * 36,
          y: basePosition.y + index * 36,
        };
        // File drops are user actions by definition — stamp user_spawned: true
        // so the new node is correctly classified by `nodeMainlineFlags` and
        // survives `_merge_restored_preset_canvas` refresh (the backend's
        // `_is_replaceable_projection_node` refuses to overwrite it).
        //
        // NB: this is NOT about unlocking. The canvas-level fallback that used
        // to lock unmarked nodes on preset canvases is gone — NodeActionToolbar
        // now locks on `isPresetManaged` alone, and an unmarked node classifies
        // as "ordinary" (see system-managed-node-data.test.ts).
        const newNodeId = addNode(
          CANVAS_NODE_TYPES.upload,
          position,
          { user_spawned: true } as Partial<CanvasNodeData>,
        );
        lastNodeId = newNodeId;
        // The File itself goes through staging; the event just pokes an already-mounted node: at low zoom a new node first mounts as a LOD
        // shell and the full component waits for the upgrade queue, so it necessarily subscribes later than the frame below;
        // emitting only the event would be dropped by the bus's no-replay semantics (see [[pendingExternalFiles]]).
        stashExternalFile('upload-node/external-file', newNodeId, file);
        requestAnimationFrame(() => {
          canvasEventBus.publish('upload-node/external-file', { nodeId: newNodeId });
        });
      });

      if (lastNodeId) {
        setSelectedNode(lastNodeId);
        // Consistent with the other "create node from nothing" entries: at low zoom, pull the viewport to the new node (zoom raised to
        // >=0.6), otherwise at 10% the user only sees a grey block of a few dozen pixels.
        focusNewNodeIfLowZoom(lastNodeId);
      }
      scheduleCanvasPersist(0);
    },
    [
      addNode,
      focusNewNodeIfLowZoom,
      hasDraggedAnyPayload,
      reactFlowInstance,
      scheduleCanvasPersist,
      setSelectedNode,
    ]
  );

  // When a file is dropped on a "node" (not blank canvas), the node's own onDrop handles it and calls
  // stopPropagation, so the canvas-level handleCanvasDrop never receives it and the "release to add to canvas"
  // overlay is not reset until refresh. A fallback reset in the window capture phase: capture runs before any
  // node's stopPropagation, reliably clearing the overlay state wherever the drop lands on the page.
  useEffect(() => {
    const resetFileDrop = () => {
      fileDragDepthRef.current = 0;
      setIsFileDropActive(false);
    };
    window.addEventListener('drop', resetFileDrop, true);
    window.addEventListener('dragend', resetFileDrop, true);
    return () => {
      window.removeEventListener('drop', resetFileDrop, true);
      window.removeEventListener('dragend', resetFileDrop, true);
    };
  }, []);

  const finalizeNodeSpawn = useCallback(
    (newNodeId: string, explicitSkill?: SkillDefinition | null) => {
      if (pendingBatchConnectIds && pendingBatchConnectIds.length > 0) {
        // Batch "+": fan every selected source node into the freshly spawned node.
        for (const sourceId of pendingBatchConnectIds) {
          connectGraphNodes(
            {
              source: sourceId,
              target: newNodeId,
              sourceHandle: 'source',
              targetHandle: 'target',
            },
            explicitSkill,
          );
        }
      } else if (pendingConnectStart) {
        if (pendingConnectStart.handleType === 'source') {
          connectGraphNodes(
            {
              source: pendingConnectStart.nodeId,
              target: newNodeId,
              sourceHandle: 'source',
              targetHandle: 'target',
            },
            explicitSkill,
          );
        } else {
          connectGraphNodes(
            {
              source: newNodeId,
              target: pendingConnectStart.nodeId,
              sourceHandle: 'source',
              targetHandle: 'target',
            },
            explicitSkill,
          );
        }
      }

      focusNewNodeIfLowZoom(newNodeId);
      scheduleCanvasPersist(0);
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPendingBatchConnectIds(null);
      setPreviewConnectionVisual(null);
    },
    [
      connectGraphNodes,
      focusNewNodeIfLowZoom,
      pendingBatchConnectIds,
      pendingConnectStart,
      scheduleCanvasPersist,
      setPreviewConnectionVisual,
    ],
  );

  const handleNodeSelect = useCallback(
    (type: CanvasNodeType, selectionClientPosition?: { x: number; y: number }) => {
      // "Upload resource" now creates an empty upload node directly on the canvas; choosing the actual file
      // (image / video) is handled by the node's own UI, which morphs into a
      // video node by file type. This keeps all canvas menu entries consistent: click to create a node.
      let initialData: Partial<Record<string, unknown>> | undefined;
      if (pendingConnectStart && type === CANVAS_NODE_TYPES.imageEdit) {
        initialData = { generationMode: 'image_reference', requestAspectRatio: 'auto' };
      } else if (
        pendingConnectStart
        && pendingConnectStart.handleType === 'target'
        && type === CANVAS_NODE_TYPES.upload
      ) {
        // Dragged out of imageGen's target handle -> choosing "Image" lands on an upload node,
        // initialized with "upload image" semantics (in sync with ImageGen's spawn-upstream-image
        // button: reject video).
        const originNode = nodes.find((node) => node.id === pendingConnectStart.nodeId);
        if (originNode?.type === CANVAS_NODE_TYPES.imageGen) {
          initialData = { imageOnly: true };
        }
      }

      const isPlainAddNodeMenu =
        !pendingConnectStart && !pendingBatchConnectIds && !menuAllowedTypes;
      if (isPlainAddNodeMenu) {
        const containerRect = wrapperRef.current?.getBoundingClientRect();
        const fallbackClientPosition = containerRect
          ? {
              x: containerRect.left + menuPosition.x,
              y: containerRect.top + menuPosition.y,
            }
          : null;
        const clientPosition =
          selectionClientPosition ??
          lastCanvasPointerClientPositionRef.current ??
          fallbackClientPosition;
        setShowNodeMenu(false);
        setMenuAllowedTypes(undefined);
        setPendingNodePlacement({ type, initialData });
        setNodePlacementClientPosition(clientPosition);
        setSelectedNode(null);
        suppressNextPaneClickRef.current = false;
        return;
      }

      const newNodeId = addNode(type, flowPosition, initialData);
      finalizeNodeSpawn(newNodeId);
    },
    [
      addNode,
      finalizeNodeSpawn,
      flowPosition,
      menuAllowedTypes,
      menuPosition.x,
      menuPosition.y,
      nodes,
      pendingBatchConnectIds,
      pendingConnectStart,
      setSelectedNode,
    ]
  );

  const handleSkillSelect = useCallback(
    (skill: SkillDefinition) => {
      const initialData = {
        skill_id: skill.id,
        skill_schema_version: skill.schema_version ?? SKILL_SCHEMA_VERSION,
        displayName: skill.display_name,
      } as Partial<CanvasNodeData>;
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const fallbackClientPosition = containerRect
        ? {
            x: containerRect.left + menuPosition.x,
            y: containerRect.top + menuPosition.y,
          }
        : null;
      const clientPosition =
        lastCanvasPointerClientPositionRef.current ??
        fallbackClientPosition;
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingNodePlacement({
        type: CANVAS_NODE_TYPES.skill,
        initialData,
        skill,
      });
      setNodePlacementClientPosition(clientPosition);
      setSelectedNode(null);
      suppressNextPaneClickRef.current = false;
    },
    [
      menuPosition.x,
      menuPosition.y,
      setSelectedNode,
    ],
  );

  // Bottom quick-action bar spawns at the current viewport center (no click /
  // pending-connect context), unlike the right-click / double-click menu which
  // drops the node at the cursor.
  const spawnAtViewportCenter = useCallback((): { x: number; y: number } => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const center = rect
      ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }
      : { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    return reactFlowInstance.screenToFlowPosition(center);
  }, [reactFlowInstance]);

  const handleQuickAddNode = useCallback(
    (type: CanvasNodeType) => {
      const newNodeId = addNode(type, spawnAtViewportCenter());
      setSelectedNode(newNodeId);
      focusNewNodeIfLowZoom(newNodeId);
      scheduleCanvasPersist(0);
    },
    [addNode, focusNewNodeIfLowZoom, scheduleCanvasPersist, setSelectedNode, spawnAtViewportCenter],
  );

  const handleQuickAddSkill = useCallback(
    (skill: SkillDefinition) => {
      const newNodeId = addNode(CANVAS_NODE_TYPES.skill, spawnAtViewportCenter(), {
        skill_id: skill.id,
        skill_schema_version: skill.schema_version ?? SKILL_SCHEMA_VERSION,
        displayName: skill.display_name,
      } as Partial<CanvasNodeData>);
      setSelectedNode(newNodeId);
      focusNewNodeIfLowZoom(newNodeId);
      bindSingleBeatContextInput(newNodeId, skill);
      scheduleCanvasPersist(0);
    },
    [
      addNode,
      bindSingleBeatContextInput,
      focusNewNodeIfLowZoom,
      scheduleCanvasPersist,
      setSelectedNode,
      spawnAtViewportCenter,
    ],
  );

  // History asset dialog "Use": spawn the asset as a new node at the viewport center (reusing spawnAssetNode of material drops).
  // For bulk use, pass placement so the new nodes are laid out as a grid near the viewport center instead of stacking on one point.
  const handleUseHistoryAsset = useCallback(
    (asset: CanvasAsset, placement?: { index: number; total: number }) => {
      const payload: CanvasAssetDragPayload = {
        kind: asset.kind,
        label: asset.label ?? '',
        // The original prompt stored in history, backfilled into the new video node's prompt box (see spawnAssetNode).
        prompt: asset.prompt ?? undefined,
        url: asset.url,
        // World-model nodes use coverUrl as the cover (previewImageUrl); other types have no cover.
        coverUrl: asset.kind === 'model' ? asset.previewUrl : null,
        // History "Use" restores a generated product: an image should be restored as a finished "image node" (imageGen) -
        // bringing back the prompt, expanding the operation area and adapting the ratio to the image, not a read-only upload reference node (see spawnAssetNode).
        restoreAsGeneratedImage: true,
        // Registry model id / generation mode of the original generation, passed through to the restored node to reproduce the original config
        // (video writes back data.model + data.genMode; image writes back data.model). Old records are undefined.
        model: asset.model ?? undefined,
        genMode: asset.genMode ?? undefined,
        source: {},
      };
      const origin = spawnAtViewportCenter();
      // Grid layout: at most 4 per row, 320 spacing, roughly centered on the viewport center.
      const position =
        placement && placement.total > 1
          ? (() => {
              const perRow = Math.min(4, placement.total);
              const gap = 320;
              const col = placement.index % perRow;
              const row = Math.floor(placement.index / perRow);
              const rows = Math.ceil(placement.total / perRow);
              return {
                x: origin.x + (col - (perRow - 1) / 2) * gap,
                y: origin.y + (row - (rows - 1) / 2) * gap,
              };
            })()
          : origin;
      const newNodeId = spawnAssetNode(useCanvasStore.getState(), payload, position);
      setSelectedNode(newNodeId);
      scheduleCanvasPersist(0);
    },
    [scheduleCanvasPersist, setSelectedNode, spawnAtViewportCenter],
  );

  // History asset dialog "Delete": remove the source node corresponding to the asset from the canvas.
  const handleDeleteHistoryNode = useCallback(
    (nodeId: string) => {
      deleteNode(nodeId);
      scheduleCanvasPersist(0);
    },
    [deleteNode, scheduleCanvasPersist],
  );

  const duplicateNodes = useCallback(
    (sourceNodeIds: string[], options: DuplicateOptions = {}) => {
      // Source is either a serialized clipboard snapshot (paste) or live nodes
      // looked up by id (duplicate / create copy).
      const snapshot = options.sourceSnapshot;
      const sourceNodes = snapshot
        ? snapshot.nodes
        : nodes.filter((node) => sourceNodeIds.includes(node.id));
      if (sourceNodes.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceIdSet = new Set(sourceNodes.map((node) => node.id));
      const internalEdges = snapshot
        ? snapshot.edges
        : edges.filter(
            (edge) => sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target)
          );

      // Cursor paste: lay the group out with its top-left at the target flow
      // position instead of the offset-from-original layout used by duplicate.
      const targetPos = options.targetFlowPosition;
      const groupMinX = targetPos
        ? Math.min(...sourceNodes.map((node) => node.position.x))
        : 0;
      const groupMinY = targetPos
        ? Math.min(...sourceNodes.map((node) => node.position.y))
        : 0;

      const baseOffsets = [
        { x: 44, y: 30 },
        { x: 72, y: 8 },
        { x: 18, y: 68 },
        { x: 96, y: 42 },
      ];
      const existingNodes = useCanvasStore.getState().nodes;
      const ignoreNodeIds = new Set<string>();
      const offsetStep = options.disableOffsetIteration ? 0 : pasteIterationRef.current;
      let chosenOffset = options.explicitOffset ?? baseOffsets[0];

      const isOffsetAvailable = (offset: { x: number; y: number }) => sourceNodes.every((node) => {
        const size = getNodeSize(node);
        return !hasRectCollision(
          {
            x: node.position.x + offset.x + offsetStep * 8,
            y: node.position.y + offset.y + offsetStep * 6,
            width: size.width,
            height: size.height,
          },
          existingNodes,
          ignoreNodeIds
        );
      });

      if (!targetPos && !options.explicitOffset) {
        const matchedBaseOffset = baseOffsets.find((offset) => isOffsetAvailable(offset));
        if (matchedBaseOffset) {
          chosenOffset = matchedBaseOffset;
        } else {
          const maxStep = 16;
          for (let step = 1; step <= maxStep; step += 1) {
            const candidate = { x: 24 + step * 26, y: 16 + step * 18 };
            if (isOffsetAvailable(candidate)) {
              chosenOffset = candidate;
              break;
            }
          }
        }
      }

      const idMap = new Map<string, string>();
      const sizeMap = new Map<string, { width: number; height: number }>();
      const pastedForMigration: PastedNodeForMigration[] = [];
      // Cross-project paste (from a serialized clipboard where the source project != the current project): media URLs pointing to the source project are withheld
      // (withholdForeignAssetUrls) **before** entering the store; nodes first enter the canvas as "copying asset" placeholders,
      // and the target project address is filled in only after the backend finishes copying - the source project URL is never in the store or persisted data.
      // Also hold the current project's autosave so the placeholder state is not needlessly persisted once; release after migration ends (success or failure),
      // and useCanvasSync re-saves the full nodes. If the hold times out, saving resumes and would only save placeholder nodes.
      const sourceProject = snapshot?.sourceProject ?? null;
      const currentProject = readUrl().project ?? null;
      const migrationTarget =
        sourceProject && currentProject && sourceProject !== currentProject
          ? currentProject
          : null;
      const releaseAutosaveHold = migrationTarget ? holdCanvasAutosave(migrationTarget) : null;
      for (const sourceNode of sourceNodes) {
        const data = cloneNodeData(sourceNode.data);
        if ('isGenerating' in (data as Record<string, unknown>)) {
          (data as { isGenerating?: boolean }).isGenerating = false;
        }
        if ('generationStartedAt' in (data as Record<string, unknown>)) {
          (data as { generationStartedAt?: number | null }).generationStartedAt = null;
        }
        if ('generationJobId' in (data as Record<string, unknown>)) {
          (data as { generationJobId?: string | null }).generationJobId = null;
        }
        if ('generationProviderId' in (data as Record<string, unknown>)) {
          (data as { generationProviderId?: string | null }).generationProviderId = null;
        }
        if ('generationClientSessionId' in (data as Record<string, unknown>)) {
          (data as { generationClientSessionId?: string | null }).generationClientSessionId = null;
        }
        if ('generationStoryboardMetadata' in (data as Record<string, unknown>)) {
          (data as { generationStoryboardMetadata?: unknown }).generationStoryboardMetadata = undefined;
        }
        if ('generationError' in (data as Record<string, unknown>)) {
          (data as { generationError?: string | null }).generationError = null;
        }
        if ('generationErrorDetails' in (data as Record<string, unknown>)) {
          (data as { generationErrorDetails?: string | null }).generationErrorDetails = null;
        }
        if ('generationDebugContext' in (data as Record<string, unknown>)) {
          (data as { generationDebugContext?: unknown }).generationDebugContext = undefined;
        }

        const position = targetPos
          ? {
              x: targetPos.x + (sourceNode.position.x - groupMinX),
              y: targetPos.y + (sourceNode.position.y - groupMinY),
            }
          : {
              x: sourceNode.position.x + chosenOffset.x + offsetStep * 8,
              y: sourceNode.position.y + chosenOffset.y + offsetStep * 6,
            };
        const { data: storeData, withheld } = migrationTarget
          ? withholdForeignAssetUrls(data, migrationTarget)
          : { data, withheld: [] };
        const nextNodeId = addNode(
          sourceNode.type as CanvasNodeType,
          position,
          { ...storeData }
        );
        idMap.set(sourceNode.id, nextNodeId);
        sizeMap.set(nextNodeId, getNodeSize(sourceNode));
        if (withheld.length > 0) {
          pastedForMigration.push({ id: nextNodeId, withheld });
        }
      }

      const sizeSyncChanges = Array.from(sizeMap.entries()).map(([nodeId, size]) => ({
        id: nodeId,
        type: 'dimensions' as const,
        dimensions: { width: size.width, height: size.height },
        resizing: false,
        setAttributes: true,
      }));
      if (sizeSyncChanges.length > 0) {
        applyNodesChange(sizeSyncChanges);
      }

      for (const edge of internalEdges) {
        const nextSource = idMap.get(edge.source);
        const nextTarget = idMap.get(edge.target);
        if (!nextSource || !nextTarget) {
          continue;
        }
        connectNodes({
          source: nextSource,
          target: nextTarget,
          sourceHandle: edge.sourceHandle ?? 'source',
          targetHandle: edge.targetHandle ?? 'target',
        });
      }

      if (!options.disableOffsetIteration && !targetPos) {
        pasteIterationRef.current += 1;
      }
      const firstNodeId = idMap.get(sourceNodes[0].id) ?? null;
      if (!options.suppressSelect) {
        if (options.selectAll && idMap.size > 0) {
          // Select the whole pasted group (and deselect the originals) so it can
          // be dragged immediately — same selection model as a box-select.
          const pastedIds = new Set(idMap.values());
          applyNodesChange(
            useCanvasStore
              .getState()
              .nodes.filter(
                (node) => Boolean(node.selected) !== pastedIds.has(node.id),
              )
              .map((node) => ({
                id: node.id,
                type: 'select' as const,
                selected: pastedIds.has(node.id),
              })),
          );
          setSelectedNode(pastedIds.size === 1 ? firstNodeId : null);
        } else if (firstNodeId) {
          setSelectedNode(firstNodeId);
        }
      }
      if (!options.suppressPersist) {
        scheduleCanvasPersist(0);
      }

      // Cross-project paste: have the backend copy the withheld source-project media into the current project; on completion, fill in the target address and remove
      // the placeholder marker. Runs in the background without blocking paste; failed nodes keep empty fields and are marked failed (the placeholder overlay
      // tells the user to delete and paste again). The autosave hold above must be released whether it succeeds or fails.
      if (migrationTarget && pastedForMigration.length > 0) {
        void migratePastedNodeAssets({
          nodes: pastedForMigration,
          targetProject: migrationTarget,
          getLiveNodeData: (nodeId) =>
            useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data ?? null,
          updateNodeData,
        })
          .then(({ migrated, failed, failedNodeIds }) => {
            if (failedNodeIds.length > 0 || failed > 0) {
              toast.error(
                t('canvas.crossProjectAssets.partialFailure', { count: Math.max(failed, 1) })
              );
            } else if (migrated > 0) {
              toast.success(t('canvas.crossProjectAssets.success', { count: migrated }));
            }
            if (migrated > 0 || failedNodeIds.length > 0) {
              scheduleCanvasPersist(0);
            }
          })
          .catch((error) => {
            console.warn('[canvas] cross-project asset migration failed', error);
          })
          .finally(() => {
            releaseAutosaveHold?.();
          });
      } else {
        releaseAutosaveHold?.();
      }

      return { firstNodeId, idMap };
    },
    [
      addNode,
      applyNodesChange,
      connectNodes,
      edges,
      nodes,
      scheduleCanvasPersist,
      setSelectedNode,
      t,
      updateNodeData,
    ]
  );

  // Paste the clipboard snapshot as fresh, self-contained nodes. `targetFlow`
  // (cursor flow position) lays the group out under the cursor; without it the
  // group is offset from its copied position (keyboard paste).
  const pasteFromClipboard = useCallback(
    (
      snapshot: ClipboardSnapshot | null,
      targetFlow?: { x: number; y: number },
    ): string | null => {
      if (!snapshot || snapshot.nodes.length === 0) {
        return null;
      }
      return (
        duplicateNodes([], {
          sourceSnapshot: snapshot,
          targetFlowPosition: targetFlow,
          selectAll: true,
        })?.firstNodeId ?? null
      );
    },
    [duplicateNodes],
  );

  // Keep a ref so the keyboard handler can paste without re-binding on every
  // node change (mirrors `duplicateNodesRef`).
  useEffect(() => {
    pasteFromClipboardRef.current = pasteFromClipboard;
  }, [pasteFromClipboard]);

  const handleConnectStart = useCallback(
    (event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPreviewConnectionVisual(null);

      if (!params.nodeId || !params.handleType) {
        setPendingConnectStart(null);
        return;
      }

      // When the drag starts from a source handle, dragging is allowed as long as "at least one legal downstream node type" exists;
      // actual connection legality is checked again in onConnect against the target type.
      if (
        params.handleType === 'source'
        && !canNodeBeManualConnectionSource(params.nodeId, nodes)
        && !canNodeBeManualConnectionSource(
          params.nodeId,
          nodes,
          CANVAS_NODE_TYPES.threeDWorld,
        )
      ) {
        setPendingConnectStart(null);
        return;
      }

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const eventTarget = event.target as Element | null;
      const handleElement = eventTarget?.closest?.('.react-flow__handle') as HTMLElement | null;
      const clientPosition = getClientPosition(event);
      let start: { x: number; y: number } | undefined;
      if (containerRect && handleElement) {
        const handleRect = handleElement.getBoundingClientRect();
        start = {
          x: handleRect.left - containerRect.left + handleRect.width / 2,
          y: handleRect.top - containerRect.top + handleRect.height / 2,
        };
      } else if (containerRect && clientPosition) {
        start = {
          x: clientPosition.x - containerRect.left,
          y: clientPosition.y - containerRect.top,
        };
      }

      setPendingConnectStart({
        nodeId: params.nodeId,
        handleType: params.handleType,
        handleId: params.handleId,
        start,
      });
    },
    [nodes]
  );

  const handleNodeDragStart = useCallback(
    (event: ReactMouseEvent, node: CanvasNode, draggedNodes: CanvasNode[]) => {
      enterNodeDragFocus();
      // Group member drag: record the group ids of "all dragged members" (the third argument carries the full set for multi-select), and on release
      // re-wrap each group with fitGroupToChildren by the members' final positions (libtv style, boxes stay put during the drag).
      // Looking only at the grabbed node would miss members of other groups in a multi-select - they have no extent:'parent' clamp,
      // and without a refit after the drag they would hang outside the group box forever. Alt-copy drag does not participate (the original node bounces back).
      // parentId is read from the store - the node argument React Flow passes to drag callbacks is a slimmed drag item
      // that may lack parentId, so using node.parentId directly could fail.
      groupFitDragRef.current = null;
      linkedDragRef.current = null;
      if (!event.altKey) {
        const stateNodes = useCanvasStore.getState().nodes;
        const dragged = draggedNodes?.length ? draggedNodes : [node];
        const groupIds = new Set<string>();
        for (const item of dragged) {
          const parentId = stateNodes.find((n) => n.id === item.id)?.parentId;
          if (parentId) groupIds.add(parentId);
        }
        if (groupIds.size > 0) {
          groupFitDragRef.current = { groupIds: [...groupIds] };
        }

        // During a single-node drag, if the dragged one is the "director world" source node or its "director world output" group, record the other side
        // and prepare to move it by the same delta (multi-select / box-select drags do not link; users arrange them by hand).
        if (!draggedNodes || draggedNodes.length <= 1) {
          const stateEdges = useCanvasStore.getState().edges;
          const partnerIds = findLinkedCapturePartnerIds(node.id, stateNodes, stateEdges);
          if (partnerIds.length > 0) {
            const nodeById = new Map(stateNodes.map((n) => [n.id, n] as const));
            const draggedNode = nodeById.get(node.id);
            const partnerStarts = new Map<string, { x: number; y: number }>();
            for (const partnerId of partnerIds) {
              const partner = nodeById.get(partnerId);
              if (partner && !partner.parentId) {
                partnerStarts.set(partnerId, { x: partner.position.x, y: partner.position.y });
              }
            }
            if (draggedNode && partnerStarts.size > 0) {
              linkedDragRef.current = {
                partnerStarts,
                draggedStart: { x: draggedNode.position.x, y: draggedNode.position.y },
              };
            }
          }
        }
      }

      if (!event.altKey) {
        altDragCopyRef.current = null;
        return;
      }

      const sourceNodeIds = selectedNodeIds.includes(node.id)
        ? selectedNodeIds
        : [node.id];
      if (sourceNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }
      const startPositions = new Map<string, { x: number; y: number }>();
      for (const sourceNodeId of sourceNodeIds) {
        const sourceNode = nodes.find((item) => item.id === sourceNodeId);
        if (!sourceNode) {
          continue;
        }
        startPositions.set(sourceNodeId, {
          x: sourceNode.position.x,
          y: sourceNode.position.y,
        });
      }
      if (startPositions.size === 0) {
        altDragCopyRef.current = null;
        return;
      }

      const duplicateResult = duplicateNodes(sourceNodeIds, {
        explicitOffset: { x: 0, y: 0 },
        disableOffsetIteration: true,
        suppressPersist: true,
        suppressSelect: true,
      });
      if (!duplicateResult) {
        altDragCopyRef.current = null;
        return;
      }

      const copiedNodeIds = sourceNodeIds
        .map((sourceId) => duplicateResult.idMap.get(sourceId))
        .filter((id): id is string => Boolean(id));
      if (copiedNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }

      // Keep the duplicated nodes visually above the original dragged node.
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((currentNode) => {
          if (!copiedNodeIds.includes(currentNode.id)) {
            return currentNode;
          }
          return {
            ...currentNode,
            zIndex: ALT_DRAG_COPY_Z_INDEX,
            style: {
              ...(currentNode.style ?? {}),
              zIndex: ALT_DRAG_COPY_Z_INDEX,
            },
          };
        }),
      }));

      altDragCopyRef.current = {
        sourceNodeIds,
        startPositions,
        copiedNodeIds,
        sourceToCopyIdMap: duplicateResult.idMap,
      };
    },
    [duplicateNodes, enterNodeDragFocus, nodes, selectedNodeIds]
  );

  const handleNodeDrag = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      // Linked drag: move the partner (source node or output group) in sync by the dragged node's delta. When a group moves,
      // its children (relative coordinates) follow automatically, no extra handling needed.
      const linked = linkedDragRef.current;
      if (linked) {
        const linkDeltaX = node.position.x - linked.draggedStart.x;
        const linkDeltaY = node.position.y - linked.draggedStart.y;
        const linkChanges = [...linked.partnerStarts].map(([partnerId, start]) => ({
          id: partnerId,
          type: 'position' as const,
          position: { x: start.x + linkDeltaX, y: start.y + linkDeltaY },
          dragging: true as const,
        }));
        if (linkChanges.length > 0) {
          applyNodesChange(linkChanges);
        }
      }

      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const deltaX = node.position.x - startPosition.x;
      const deltaY = node.position.y - startPosition.y;

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));

      const moveCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + deltaX, y: sourceStart.y + deltaY },
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));

      const allChanges = [...restoreSourceChanges, ...moveCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
    },
    [applyNodesChange]
  );

  const handleNodeDragStop = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      exitNodeDragFocus();
      useSnapAlignStore.getState().clearGuides();
      snapAlignSessionRef.current = null;
      // Linked drag wrap-up: the partner's final position was already written during the drag (dragging:true); on release,
      // the dragging:false change React Flow emits for the dragged node is pushed into the same undo record,
      // so only the reference is cleared here, with no extra commit, to avoid a duplicate undo step.
      linkedDragRef.current = null;
      // Group member drag wrap-up (libtv style): by each member's final position, re-expand every involved group box to wrap them
      // (fitGroupToChildren includes translating as a whole in the left/up directions). Ordinary group members have no extent and can land freely.
      const groupFit = groupFitDragRef.current;
      groupFitDragRef.current = null;
      if (groupFit) {
        const { fitGroupToChildren } = useCanvasStore.getState();
        for (const groupId of groupFit.groupIds) {
          fitGroupToChildren(groupId);
        }
      }
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }
      altDragCopyRef.current = null;

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const offset = {
        x: node.position.x - startPosition.x,
        y: node.position.y - startPosition.y,
      };

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));

      const finalizeCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + offset.x, y: sourceStart.y + offset.y },
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));

      const allChanges = [...restoreSourceChanges, ...finalizeCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
      if (altCopyState.copiedNodeIds.length > 0) {
        setSelectedNode(altCopyState.copiedNodeIds[0]);
      }
      scheduleCanvasPersist(0);
    },
    [applyNodesChange, exitNodeDragFocus, scheduleCanvasPersist, setSelectedNode]
  );

  // When the "selection box" is dragged to move multi-selected nodes as a whole, React Flow uses onSelectionDrag* rather than onNodeDrag*;
  // the group member refit must also wrap up on this path, otherwise members dragged out of the box are wrapped by no one.
  const handleSelectionDragStart = useCallback(
    (_event: ReactMouseEvent, draggedNodes: CanvasNode[]) => {
      enterNodeDragFocus();
      const stateNodes = useCanvasStore.getState().nodes;
      const groupIds = new Set<string>();
      for (const item of draggedNodes) {
        const parentId = stateNodes.find((n) => n.id === item.id)?.parentId;
        if (parentId) groupIds.add(parentId);
      }
      groupFitDragRef.current =
        groupIds.size > 0 ? { groupIds: [...groupIds] } : null;
    },
    [enterNodeDragFocus]
  );

  const handleSelectionDragStop = useCallback(() => {
    exitNodeDragFocus();
    const groupFit = groupFitDragRef.current;
    groupFitDragRef.current = null;
    if (groupFit) {
      const { fitGroupToChildren } = useCanvasStore.getState();
      for (const groupId of groupFit.groupIds) {
        fitGroupToChildren(groupId);
      }
    }
  }, [exitNodeDragFocus]);

  // When a manual edge lands on a node, would this edge push the video node's materials past the capability envelope? Non-empty means reject.
  // The three manual paths (React Flow drag release, "+" drag drop highlight, "+" release edge creation) share the same
  // ruler - missing one place would give "highlighted as valid while dragging, but nothing happens on release".
  const manualDropReferenceRejection = useCallback(
    (pending: PendingConnectStart, dropNodeId: string | null): string | null => {
      if (!dropNodeId || dropNodeId === pending.nodeId) return null;
      const sourceId = pending.handleType === 'source' ? pending.nodeId : dropNodeId;
      const targetId = pending.handleType === 'source' ? dropNodeId : pending.nodeId;
      return videoReferenceConnectionRejection(
        nodes,
        edges,
        { source: sourceId, target: targetId },
        videoReferenceEnvelopeForNode,
      );
    },
    [edges, nodes],
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid || !pendingConnectStart) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const clientPosition = getClientPosition(event);
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!clientPosition || !containerRect) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const eventTarget = event.target as Element | null;
      const nodeElementFromTarget = eventTarget?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const nodeElementFromPoint = document.elementFromPoint(clientPosition.x, clientPosition.y)
        ?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const dropNodeElement = nodeElementFromTarget ?? nodeElementFromPoint;
      const dropNodeId = dropNodeElement?.dataset?.id ?? null;

      if (dropNodeId && dropNodeId !== pendingConnectStart.nodeId) {
        // Materials exceed the capability envelope: this branch is a fallback path reached when connectionState.isValid is false and
        // **does not look at** isValidConnection, so it must block by itself. Otherwise it would fall through to
        // "dragged to blank space -> open the new node menu", and users who released on a node would get a menu.
        // Also toast the reason - a greyed-out drop target alone does not explain "why".
        const referenceRejection = manualDropReferenceRejection(
          pendingConnectStart,
          dropNodeId,
        );
        if (referenceRejection) {
          toast.warning(referenceRejection);
          setPendingConnectStart(null);
          setPreviewConnectionVisual(null);
          return;
        }

        const sourceNode =
          pendingConnectStart.handleType === 'source'
            ? nodes.find((node) => node.id === pendingConnectStart.nodeId)
            : nodes.find((node) => node.id === dropNodeId);
        const targetNode =
          pendingConnectStart.handleType === 'source'
            ? nodes.find((node) => node.id === dropNodeId)
            : nodes.find((node) => node.id === pendingConnectStart.nodeId);

        if (
          sourceNode &&
          targetNode &&
          canNodeTypeBeManualConnectionSource(sourceNode.type, targetNode.type) &&
          nodeHasSourceHandle(sourceNode.type) &&
          nodeHasTargetHandle(targetNode.type)
        ) {
          const sourceHandle =
            pendingConnectStart.handleType === 'source'
              ? pendingConnectStart.handleId ?? 'source'
              : resolveConnectEndHandleId({
                  eventTarget,
                  nodeElement: dropNodeElement,
                  nodeId: sourceNode.id,
                  handleType: 'source',
                  clientPosition,
                }) ?? 'source';
          const targetHandle =
            pendingConnectStart.handleType === 'source'
              ? resolveConnectEndHandleId({
                  eventTarget,
                  nodeElement: dropNodeElement,
                  nodeId: targetNode.id,
                  handleType: 'target',
                  clientPosition,
                }) ?? 'target'
              : pendingConnectStart.handleId ?? 'target';
          connectGraphNodes({
            source: sourceNode.id,
            target: targetNode.id,
            sourceHandle,
            targetHandle,
          });
          scheduleCanvasPersist(0);
          setPendingConnectStart(null);
          setPreviewConnectionVisual(null);
          return;
        }
      }

      const originNode = nodes.find((node) => node.id === pendingConnectStart.nodeId);
      const allowedTypes = resolveAllowedNodeTypes(
        pendingConnectStart.handleType,
        originNode?.type,
      );
      if (allowedTypes.length === 0) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const endX = clientPosition.x - containerRect.left;
      const endY = clientPosition.y - containerRect.top;
      let startX: number | null = pendingConnectStart.start?.x ?? null;
      let startY: number | null = pendingConnectStart.start?.y ?? null;

      if (startX === null || startY === null) {
        const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${pendingConnectStart.nodeId}"]`
        );
        const handleElement = nodeElement?.querySelector<HTMLElement>(
          `.react-flow__handle-${pendingConnectStart.handleType}`
        );
        if (handleElement) {
          const handleRect = handleElement.getBoundingClientRect();
          startX = handleRect.left - containerRect.left + handleRect.width / 2;
          startY = handleRect.top - containerRect.top + handleRect.height / 2;
        } else if (nodeElement) {
          const nodeRect = nodeElement.getBoundingClientRect();
          startX =
            pendingConnectStart.handleType === 'source'
              ? nodeRect.right - containerRect.left
              : nodeRect.left - containerRect.left;
          startY = nodeRect.top - containerRect.top + nodeRect.height / 2;
        } else if (connectionState.from) {
          startX = connectionState.from.x;
          startY = connectionState.from.y;
        }
      }

      if (startX === null || startY === null) {
        setPreviewConnectionVisual(null);
      } else {
        setPreviewConnectionVisual({
          d: createPreviewPath({
            start: { x: startX, y: startY },
            end: { x: endX, y: endY },
            handleType: pendingConnectStart.handleType,
          }),
          stroke: 'rgba(255,255,255,0.9)',
          strokeWidth: 1,
          strokeLinecap: 'round',
          left: 0,
          top: 0,
          width: containerRect.width,
          height: containerRect.height,
        });
      }

      const flowPos = reactFlowInstance.screenToFlowPosition(clientPosition);
      setFlowPosition(flowPos);
      setMenuPosition({
        x: clientPosition.x - containerRect.left,
        y: clientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [
      connectGraphNodes,
      manualDropReferenceRejection,
      nodes,
      pendingConnectStart,
      reactFlowInstance,
      scheduleCanvasPersist,
    ]
  );

  const handlePlusOpenMenu = useCallback(
    (params: PlusConnectDragParams) => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) return;

      const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
        `.react-flow__node[data-id="${cssEscape(params.nodeId)}"]`,
      );
      const handleElement = nodeElement?.querySelector<HTMLElement>(
        `.react-flow__handle-${params.handleType}`,
      );
      const handleRect = handleElement?.getBoundingClientRect();
      const nodeRect = nodeElement?.getBoundingClientRect();
      const start = handleRect
        ? {
            x: handleRect.left - containerRect.left + handleRect.width / 2,
            y: handleRect.top - containerRect.top + handleRect.height / 2,
          }
        : nodeRect
          ? {
              x: (params.handleType === 'source' ? nodeRect.right : nodeRect.left) - containerRect.left,
              y: nodeRect.top - containerRect.top + nodeRect.height / 2,
            }
          : {
              x: params.clientPosition.x - containerRect.left,
              y: params.clientPosition.y - containerRect.top,
            };

      const originNode = nodes.find((node) => node.id === params.nodeId);
      const allowedTypes = resolveAllowedNodeTypes(params.handleType, originNode?.type);
      if (allowedTypes.length === 0) return;

      setPendingConnectStart({
        nodeId: params.nodeId,
        handleType: params.handleType,
        start,
      });
      setPreviewConnectionVisual(null);
      setFlowPosition(reactFlowInstance.screenToFlowPosition(params.clientPosition));
      setMenuPosition({
        x: params.clientPosition.x - containerRect.left,
        y: params.clientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [nodes, reactFlowInstance],
  );

  // Remove the current drop highlight (called when the drag ends / leaves a valid node).
  const clearDropTargetHighlight = useCallback(() => {
    if (dropTargetElRef.current) {
      dropTargetElRef.current.classList.remove('canvas-node-drop-target');
      dropTargetElRef.current = null;
    }
  }, []);

  // Given the cursor position + start info, return the node DOM that is a "valid drop target" (otherwise null).
  // Validation rules match edge creation in dragEnd/handleConnectEnd: not itself, types connectable, both handles present.
  // Hit rule: (1) a node directly under the cursor wins; (2) otherwise, within the MANUAL_DROP_PROXIMITY_PX neighborhood of node edges,
  // pick the valid node with the nearest "point-to-rect" distance - the cursor need not be inside the node.
  const resolveManualDropTargetEl = useCallback(
    (clientPosition: { x: number; y: number }, pending: PendingConnectStart) => {
      const validate = (el: HTMLElement | null): HTMLElement | null => {
        const dropNodeId = el?.dataset?.id ?? null;
        if (!el || !dropNodeId || dropNodeId === pending.nodeId) return null;
        // A video node whose materials are full is not highlighted as a drop target (same rule as greying out the target while dragging a line); at release
        // handlePlusConnectDragEnd toasts the reason.
        if (manualDropReferenceRejection(pending, dropNodeId)) return null;
        const sourceNode =
          pending.handleType === 'source'
            ? nodes.find((node) => node.id === pending.nodeId)
            : nodes.find((node) => node.id === dropNodeId);
        const targetNode =
          pending.handleType === 'source'
            ? nodes.find((node) => node.id === dropNodeId)
            : nodes.find((node) => node.id === pending.nodeId);
        if (
          sourceNode &&
          targetNode &&
          canNodeTypeBeManualConnectionSource(sourceNode.type, targetNode.type) &&
          nodeHasSourceHandle(sourceNode.type) &&
          nodeHasTargetHandle(targetNode.type)
        ) {
          return el;
        }
        return null;
      };

      // (1) The cursor is directly on a node.
      const direct = validate(
        document
          .elementFromPoint(clientPosition.x, clientPosition.y)
          ?.closest?.('.react-flow__node[data-id]') as HTMLElement | null,
      );
      if (direct) return direct;

      // (2) Find the valid node nearest by "point-to-node-rect" within the neighborhood.
      const wrapper = wrapperRef.current;
      if (!wrapper) return null;
      let best: HTMLElement | null = null;
      let bestDist = Infinity;
      wrapper
        .querySelectorAll<HTMLElement>('.react-flow__node[data-id]')
        .forEach((el) => {
          const rect = el.getBoundingClientRect();
          const dx =
            clientPosition.x < rect.left
              ? rect.left - clientPosition.x
              : clientPosition.x > rect.right
                ? clientPosition.x - rect.right
                : 0;
          const dy =
            clientPosition.y < rect.top
              ? rect.top - clientPosition.y
              : clientPosition.y > rect.bottom
                ? clientPosition.y - rect.bottom
                : 0;
          const dist = Math.hypot(dx, dy);
          if (dist > MANUAL_DROP_PROXIMITY_PX || dist >= bestDist) return;
          if (validate(el)) {
            best = el;
            bestDist = dist;
          }
        });
      return best;
    },
    [manualDropReferenceRejection, nodes],
  );

  const handlePlusConnectDragStart = useCallback((params: PlusConnectDragParams) => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!containerRect) return;
    clearHoveredNodeTimer();
    clearDropTargetHighlight();
    setHoveredNodeId(null);
    setIsPlusConnectDragging(true);

    const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${cssEscape(params.nodeId)}"]`,
    );
    const handleElement = nodeElement?.querySelector<HTMLElement>(
      `.react-flow__handle-${params.handleType}`,
    );
    const handleRect = handleElement?.getBoundingClientRect();
    const nodeRect = nodeElement?.getBoundingClientRect();
    const start = handleRect
      ? {
          x: handleRect.left - containerRect.left + handleRect.width / 2,
          y: handleRect.top - containerRect.top + handleRect.height / 2,
        }
      : nodeRect
        ? {
            x: (params.handleType === 'source' ? nodeRect.right : nodeRect.left) - containerRect.left,
            y: nodeRect.top - containerRect.top + nodeRect.height / 2,
          }
        : {
            x: params.clientPosition.x - containerRect.left,
            y: params.clientPosition.y - containerRect.top,
          };

    const pending: PendingConnectStart = {
      nodeId: params.nodeId,
      handleType: params.handleType,
      start,
    };

    plusConnectStartRef.current = pending;
    setPendingConnectStart(pending);
    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setPreviewConnectionVisual(null);
  }, [clearHoveredNodeTimer, clearDropTargetHighlight]);

  const handlePlusConnectDragMove = useCallback((params: PlusConnectDragParams) => {
    const pending = plusConnectStartRef.current;
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!pending || !containerRect || !pending.start) return;

    setPreviewConnectionVisual({
      d: createPreviewPath({
        start: pending.start,
        end: {
          x: params.clientPosition.x - containerRect.left,
          y: params.clientPosition.y - containerRect.top,
        },
        handleType: pending.handleType,
      }),
      stroke: 'rgba(255,255,255,0.9)',
      strokeWidth: 1,
      strokeLinecap: 'round',
      left: 0,
      top: 0,
      width: containerRect.width,
      height: containerRect.height,
    });

    // Drop feedback: when the cursor enters a valid target node, highlight it (breathing + glow); remove it when leaving.
    const dropEl = resolveManualDropTargetEl(params.clientPosition, pending);
    if (dropEl !== dropTargetElRef.current) {
      clearDropTargetHighlight();
      if (dropEl) {
        dropEl.classList.add('canvas-node-drop-target');
        dropTargetElRef.current = dropEl;
      }
    }
  }, [clearDropTargetHighlight, resolveManualDropTargetEl]);

  const handlePlusConnectDragEnd = useCallback(
    (params: PlusConnectDragParams) => {
      const pending = plusConnectStartRef.current;
      plusConnectStartRef.current = null;
      setIsPlusConnectDragging(false);
      clearDropTargetHighlight();

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!pending || !containerRect) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      // On a video node whose materials are full, resolveManualDropTargetEl does not recognize a drop target (no highlight),
      // and release would fall into "dragged to blank space -> open the new node menu". So first check separately
      // what is right under the cursor: if it really is blocked by the material limit, toast the reason and finish, without opening that menu.
      const hoveredNodeId =
        (
          document
            .elementFromPoint(params.clientPosition.x, params.clientPosition.y)
            ?.closest?.('.react-flow__node[data-id]') as HTMLElement | null
        )?.dataset?.id ?? null;
      const hoveredRejection = manualDropReferenceRejection(pending, hoveredNodeId);
      if (hoveredRejection) {
        toast.warning(hoveredRejection);
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      // Same neighborhood rule as drag highlight: releasing within the neighborhood around a node creates an edge, no need to be inside the node.
      const dropNodeElement = resolveManualDropTargetEl(params.clientPosition, pending);
      const dropNodeId = dropNodeElement?.dataset?.id ?? null;

      if (dropNodeId && dropNodeId !== pending.nodeId) {
        const sourceNode =
          pending.handleType === 'source'
            ? nodes.find((node) => node.id === pending.nodeId)
            : nodes.find((node) => node.id === dropNodeId);
        const targetNode =
          pending.handleType === 'source'
            ? nodes.find((node) => node.id === dropNodeId)
            : nodes.find((node) => node.id === pending.nodeId);

        if (
          sourceNode &&
          targetNode &&
          canNodeTypeBeManualConnectionSource(sourceNode.type, targetNode.type) &&
          nodeHasSourceHandle(sourceNode.type) &&
          nodeHasTargetHandle(targetNode.type)
        ) {
          const sourceHandle =
            pending.handleType === 'source'
              ? pending.handleId ?? 'source'
              : resolveConnectEndHandleId({
                  eventTarget: dropNodeElement,
                  nodeElement: dropNodeElement,
                  nodeId: sourceNode.id,
                  handleType: 'source',
                  clientPosition: params.clientPosition,
                }) ?? 'source';
          const targetHandle =
            pending.handleType === 'source'
              ? resolveConnectEndHandleId({
                  eventTarget: dropNodeElement,
                  nodeElement: dropNodeElement,
                  nodeId: targetNode.id,
                  handleType: 'target',
                  clientPosition: params.clientPosition,
                }) ?? 'target'
              : pending.handleId ?? 'target';
          connectGraphNodes({
            source: sourceNode.id,
            target: targetNode.id,
            sourceHandle,
            targetHandle,
          });
          scheduleCanvasPersist(0);
          setPendingConnectStart(null);
          setPreviewConnectionVisual(null);
          return;
        }
      }

      const originNode = nodes.find((node) => node.id === pending.nodeId);
      const allowedTypes = resolveAllowedNodeTypes(pending.handleType, originNode?.type);
      if (allowedTypes.length === 0) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const end = {
        x: params.clientPosition.x - containerRect.left,
        y: params.clientPosition.y - containerRect.top,
      };
      const start = pending.start ?? end;
      setPendingConnectStart(pending);
      setPreviewConnectionVisual({
        d: createPreviewPath({
          start,
          end,
          handleType: pending.handleType,
        }),
        stroke: 'rgba(255,255,255,0.9)',
        strokeWidth: 1,
        strokeLinecap: 'round',
        left: 0,
        top: 0,
        width: containerRect.width,
        height: containerRect.height,
      });

      const flowPos = reactFlowInstance.screenToFlowPosition(params.clientPosition);
      setFlowPosition(flowPos);
      setMenuPosition(end);
      setMenuAllowedTypes(allowedTypes);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [
      connectGraphNodes,
      manualDropReferenceRejection,
      nodes,
      reactFlowInstance,
      scheduleCanvasPersist,
      clearDropTargetHighlight,
      resolveManualDropTargetEl,
    ],
  );

  // ---- Batch connect from the multi-selection "+" -------------------------
  // Selected source-capable nodes + the downstream types valid for ALL of them
  // + the right-center of their bounding box (where a spawned node is anchored).
  const getBatchConnectContext = useCallback(() => {
    const sources = nodes.filter(
      (node) => Boolean(node.selected) && nodeHasSourceHandle(node.type),
    );
    if (sources.length < 2) {
      return null;
    }
    let allowed: CanvasNodeType[] | null = null;
    let minY = Infinity;
    let maxY = -Infinity;
    let maxX = -Infinity;
    for (const node of sources) {
      const downstream = getDownstreamSpawnTypes(node.type);
      allowed =
        allowed === null ? downstream : allowed.filter((type) => downstream.includes(type));
      const size = getNodeSize(node);
      minY = Math.min(minY, node.position.y);
      maxY = Math.max(maxY, node.position.y + size.height);
      maxX = Math.max(maxX, node.position.x + size.width);
    }
    if (!allowed || allowed.length === 0) {
      return null;
    }
    return {
      sourceIds: sources.map((node) => node.id),
      allowedTypes: allowed,
      bboxRightCenter: { x: maxX, y: (minY + maxY) / 2 },
    };
  }, [nodes]);

  // Open the spawn menu pre-armed to fan all selected sources into the new node.
  const openBatchSpawnMenu = useCallback(
    (
      sourceIds: string[],
      allowedTypes: CanvasNodeType[],
      spawnFlowPosition: { x: number; y: number },
      menuClientPosition: { x: number; y: number },
    ) => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) {
        return;
      }
      setPendingConnectStart(null);
      setPendingBatchConnectIds(sourceIds);
      setFlowPosition(spawnFlowPosition);
      setMenuPosition({
        x: menuClientPosition.x - containerRect.left,
        y: menuClientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [],
  );

  const handleBatchConnectOpenMenu = useCallback(
    ({ clientPosition }: BatchConnectParams) => {
      const ctx = getBatchConnectContext();
      if (!ctx) {
        return;
      }
      setPreviewConnectionVisual(null);
      openBatchSpawnMenu(
        ctx.sourceIds,
        ctx.allowedTypes,
        {
          x: ctx.bboxRightCenter.x + BATCH_CONNECT_SPAWN_GAP,
          y: ctx.bboxRightCenter.y - BATCH_CONNECT_SPAWN_VERTICAL_OFFSET,
        },
        clientPosition,
      );
    },
    [getBatchConnectContext, openBatchSpawnMenu, setPreviewConnectionVisual],
  );

  const handleBatchConnectDragStart = useCallback(
    ({ clientPosition }: BatchConnectParams) => {
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const ctx = getBatchConnectContext();
      if (!containerRect || !ctx) {
        return;
      }
      batchConnectDragRef.current = {
        sourceIds: ctx.sourceIds,
        start: {
          x: clientPosition.x - containerRect.left,
          y: clientPosition.y - containerRect.top,
        },
      };
      setIsPlusConnectDragging(true);
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPreviewConnectionVisual(null);
    },
    [getBatchConnectContext, setPreviewConnectionVisual],
  );

  const handleBatchConnectDragMove = useCallback(
    ({ clientPosition }: BatchConnectParams) => {
      const drag = batchConnectDragRef.current;
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!drag || !containerRect) {
        return;
      }
      setPreviewConnectionVisual({
        d: createPreviewPath({
          start: drag.start,
          end: {
            x: clientPosition.x - containerRect.left,
            y: clientPosition.y - containerRect.top,
          },
          handleType: 'source',
        }),
        stroke: 'rgba(255,255,255,0.9)',
        strokeWidth: 1,
        strokeLinecap: 'round',
        left: 0,
        top: 0,
        width: containerRect.width,
        height: containerRect.height,
      });
    },
    [setPreviewConnectionVisual],
  );

  const handleBatchConnectDragEnd = useCallback(
    ({ clientPosition }: BatchConnectParams) => {
      const drag = batchConnectDragRef.current;
      batchConnectDragRef.current = null;
      setIsPlusConnectDragging(false);

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!drag || !containerRect) {
        setPreviewConnectionVisual(null);
        return;
      }

      const dropNodeElement = document
        .elementFromPoint(clientPosition.x, clientPosition.y)
        ?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const dropNodeId = dropNodeElement?.dataset?.id ?? null;
      const sourceIdSet = new Set(drag.sourceIds);

      // Dropped on an existing node → fan every valid source straight into it.
      if (dropNodeId && !sourceIdSet.has(dropNodeId)) {
        const targetNode = nodes.find((node) => node.id === dropNodeId);
        if (targetNode && nodeHasTargetHandle(targetNode.type)) {
          let connected = 0;
          for (const sourceId of drag.sourceIds) {
            const sourceNode = nodes.find((node) => node.id === sourceId);
            if (
              sourceNode &&
              nodeHasSourceHandle(sourceNode.type) &&
              canNodeTypeBeManualConnectionSource(sourceNode.type, targetNode.type)
            ) {
              connectGraphNodes({
                source: sourceId,
                target: dropNodeId,
                sourceHandle: 'source',
                targetHandle: 'target',
              });
              connected += 1;
            }
          }
          if (connected > 0) {
            scheduleCanvasPersist(0);
          }
          setPreviewConnectionVisual(null);
          return;
        }
      }

      // Dropped on empty canvas (or an invalid target) → spawn menu at the drop.
      const ctx = getBatchConnectContext();
      if (!ctx) {
        setPreviewConnectionVisual(null);
        return;
      }
      openBatchSpawnMenu(
        ctx.sourceIds,
        ctx.allowedTypes,
        reactFlowInstance.screenToFlowPosition(clientPosition),
        clientPosition,
      );
    },
    [
      connectGraphNodes,
      getBatchConnectContext,
      nodes,
      openBatchSpawnMenu,
      reactFlowInstance,
      scheduleCanvasPersist,
      setPreviewConnectionVisual,
    ],
  );

  const emptyHint = useMemo(() => {
    return (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="inline-flex items-center gap-2 rounded-full border border-white/[0.1] bg-white/[0.06] backdrop-blur-xl px-4 py-2">
          <MousePointerClick className="h-3.5 w-3.5 shrink-0 text-white/60" aria-hidden="true" />
          <span className="text-sm text-white/70">
            {t('canvas.emptyHintBeforeTab')}
            <span className="text-primary">Tab</span>
            {t('canvas.emptyHintAfterTab')}
          </span>
        </div>
      </div>
    );
  }, [t]);
  const marqueeSelectionRect = useMemo(() => {
    if (!marqueeSelection) {
      return null;
    }
    return {
      left: Math.min(marqueeSelection.start.x, marqueeSelection.current.x),
      top: Math.min(marqueeSelection.start.y, marqueeSelection.current.y),
      width: Math.abs(marqueeSelection.current.x - marqueeSelection.start.x),
      height: Math.abs(marqueeSelection.current.y - marqueeSelection.start.y),
    };
  }, [marqueeSelection]);
  const nodePlacementPreview = useMemo(() => {
    if (!pendingNodePlacement || !nodePlacementClientPosition) {
      return null;
    }
    const wrapperRect = wrapperRef.current?.getBoundingClientRect();
    if (!wrapperRect) {
      return null;
    }
    const definition = nodeCatalog.getDefinition(pendingNodePlacement.type);
    const label = pendingNodePlacement.skill
      ? translateSkillName(pendingNodePlacement.skill, t)
      : definition ? t(definition.menuLabelKey) : pendingNodePlacement.type;
    return {
      left:
        nodePlacementClientPosition.x -
        wrapperRect.left -
        NODE_PLACEMENT_PREVIEW_WIDTH / 2,
      top:
        nodePlacementClientPosition.y -
        wrapperRect.top -
        NODE_PLACEMENT_PREVIEW_HEIGHT / 2,
      label,
    };
  }, [nodePlacementClientPosition, pendingNodePlacement, t]);

  return (
    <CreditDisplayHiddenProvider value={isCeRuntime()}>
    <div
      ref={wrapperRef}
      data-canvas-tool={handToolActive ? 'hand' : 'move'}
      data-node-drag-focus={isNodeDragFocusActive ? 'true' : undefined}
      className="dc-canvas relative h-full w-full bg-background"
      onDragEnter={handleCanvasDragEnter}
      onDragOver={handleCanvasDragOver}
      onDragLeave={handleCanvasDragLeave}
      onDrop={handleCanvasDrop}
      onPointerMove={handleCanvasPointerMove}
    >
      <ReactFlow
        nodes={renderedNodes}
        edges={renderedEdges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onEdgeClick={handleEdgeClick}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        onNodeMouseEnter={handleNodeMouseEnter}
        onNodeMouseLeave={handleNodeMouseLeave}
        onNodeClick={handleNodeClick}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onSelectionDragStart={handleSelectionDragStart}
        onSelectionDragStop={handleSelectionDragStop}
        onPaneClick={handlePaneClick}
        onMove={handleMove}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
        connectionMode={ConnectionMode.Loose}
        defaultViewport={initialViewportRef.current}
        connectionRadius={CONNECTION_SNAP_RADIUS}
        minZoom={0.1}
        maxZoom={8}
        // Under the hand tool nodes are neither draggable nor selectable: not draggable, so a left-click on a node is handed to the pane to pan;
        // not selectable, otherwise releasing after a "pan while dragging a node" would select it as a side effect.
        nodesDraggable={!handToolActive}
        elementsSelectable={!handToolActive}
        nodesConnectable
        edgesReconnectable
        panOnDrag={handToolActive ? PAN_ON_DRAG_BUTTONS_HAND : PAN_ON_DRAG_BUTTONS}
        panOnScroll={trackpadPanEnabled}
        zoomOnScroll={!trackpadPanEnabled}
        panActivationKeyCode={PAN_ACTIVATION_KEY_CODE}
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={MULTI_SELECTION_KEY_CODES}
        selectionKeyCode={null}
        deleteKeyCode={null}
        // Turn off viewport culling at low zoom: all nodes are lightweight shells at this tier (see withLodShell),
        // the fully mounted render tree is small; while culling mounts/unmounts boundary nodes every frame during fast pan (measured: 800+ churns
        // in a 4-second drag, p99 frame time 470ms) - the benefit has inverted. High zoom keeps culling.
        // Nodes must also stay mounted while a workflow runs, so background nodes are not interrupted by culling.
        onlyRenderVisibleElements={!workflowExecutionActive && !lowDetailActive}
        zoomOnDoubleClick={false}
        proOptions={REACT_FLOW_PRO_OPTIONS}
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={2} color="#4a4a4a" />
        {minimapVisible && (
          <MiniMap
            position={controlsPlacement === 'top-right' ? 'top-right' : 'bottom-right'}
            className="canvas-minimap canvas-minimap--popover nopan nowheel !border-border-dark !bg-surface-dark"
            style={{ pointerEvents: 'all', zIndex: 10000 }}
            nodeColor="rgba(120, 120, 120, 0.92)"
            maskColor="rgba(0, 0, 0, 0.62)"
            // Dragging is taken over by useSmoothMinimapPan: the built-in pannable's gain includes the current viewport box,
            // and compounds once the viewport is dragged out of the content area, getting faster the more you drag.
            pannable={false}
            zoomable
            onMouseEnter={() => setMinimapHover(true)}
            onMouseLeave={() => setMinimapHover(false)}
          />
        )}
        {minimapVisible && <CanvasMinimapBookmarksOverlay onHoverChange={setMinimapHover} />}

        <SelectedNodeOverlay />
        <LightEditorCanvasOverlay />
        <MultiSelectionToolbar projectId={projectId} canvasId={canvasId} />
        <MultiSelectionConnectButton
          onBatchOpenMenu={handleBatchConnectOpenMenu}
          onBatchDragStart={handleBatchConnectDragStart}
          onBatchDragMove={handleBatchConnectDragMove}
          onBatchDragEnd={handleBatchConnectDragEnd}
        />
        <NodeSpawnPlusOverlay
          hoveredNodeId={hoveredNodeId}
          hidden={isPlusConnectDragging}
          onOverlayHoverStart={clearHoveredNodeTimer}
          onOverlayHoverEnd={scheduleHoveredNodeClear}
          onPlusOpenMenu={handlePlusOpenMenu}
          onPlusDragStart={handlePlusConnectDragStart}
          onPlusDragMove={handlePlusConnectDragMove}
          onPlusDragEnd={handlePlusConnectDragEnd}
        />
        <SnapAlignGuides />
      </ReactFlow>

      <ReferencePickBanner />
      <ViewportReturnHint />

      {marqueeSelectionRect && (
        <div
          className="pointer-events-none absolute z-[130] rounded-md border border-dashed border-white/55 bg-white/[0.04]"
          style={{
            left: marqueeSelectionRect.left,
            top: marqueeSelectionRect.top,
            width: marqueeSelectionRect.width,
            height: marqueeSelectionRect.height,
          }}
        />
      )}

      {nodePlacementPreview && (
        <div
          className="pointer-events-none absolute z-[135] select-none rounded-2xl border border-cyan-200/55 bg-[#101217]/58 shadow-[0_18px_50px_rgba(0,0,0,0.38),0_0_0_1px_rgba(255,255,255,0.06)_inset] backdrop-blur-md"
          style={{
            left: nodePlacementPreview.left,
            top: nodePlacementPreview.top,
            width: NODE_PLACEMENT_PREVIEW_WIDTH,
            height: NODE_PLACEMENT_PREVIEW_HEIGHT,
          }}
        >
          <div className="absolute inset-0 rounded-2xl bg-cyan-200/[0.035]" />
          <div className="relative flex h-full flex-col justify-between p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="truncate text-[15px] font-medium leading-5 text-white/86">
                  {nodePlacementPreview.label}
                </div>
                <div className="mt-1 text-[12px] leading-4 text-white/45">
                  {t('canvas.nodePlacement.previewHint')}
                </div>
              </div>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-cyan-300/[0.14] text-cyan-100">
                <MousePointerClick className="h-4 w-4" aria-hidden="true" />
              </div>
            </div>
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4 text-white/38">
              <span>{t('canvas.nodePlacement.confirmHint')}</span>
              <span>{t('canvas.nodePlacement.cancelHint')}</span>
            </div>
          </div>
        </div>
      )}

      {contextMenu && (
        <CanvasContextMenu
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          sections={[
            [
              {
                key: 'upload',
                label: t('canvas.contextMenu.upload'),
                onSelect: () => {
                  const flowPos = reactFlowInstance.screenToFlowPosition({
                    x: contextMenu.clientX,
                    y: contextMenu.clientY,
                  });
                  addNode(CANVAS_NODE_TYPES.upload, flowPos);
                  scheduleCanvasPersist(0);
                },
              },
              {
                key: 'add-node',
                label: t('canvas.contextMenu.addNode'),
                onSelect: () =>
                  openNodeMenuAtClientPosition({
                    x: contextMenu.clientX,
                    y: contextMenu.clientY,
                  }),
              },
            ],
            [
              {
                key: 'undo',
                label: t('canvas.contextMenu.undo'),
                shortcut: '⌘Z',
                disabled: !contextMenu.canUndo,
                onSelect: () => {
                  if (undo()) {
                    scheduleCanvasPersist(0);
                  }
                },
              },
              {
                key: 'redo',
                label: t('canvas.contextMenu.redo'),
                shortcut: '⇧⌘Z',
                disabled: !contextMenu.canRedo,
                onSelect: () => {
                  if (redo()) {
                    scheduleCanvasPersist(0);
                  }
                },
              },
            ],
            [
              {
                key: 'paste',
                label: t('canvas.contextMenu.paste'),
                shortcut: '⌘V',
                disabled: !contextMenu.canPaste,
                onSelect: () => {
                  // Paste the group with its top-left at the right-click point.
                  pasteFromClipboard(
                    copiedSnapshotRef.current,
                    reactFlowInstance.screenToFlowPosition({
                      x: contextMenu.clientX,
                      y: contextMenu.clientY,
                    }),
                  );
                },
              },
            ],
          ]}
        />
      )}

      {nodes.length === 0 && emptyHint}

      <CanvasFileDropOverlay isVisible={isFileDropActive} />

      <CanvasMinimapButton
        pinned={minimapPinned}
        onTogglePin={() => setMinimapPinned((value) => !value)}
        onHoverChange={setMinimapHover}
        placement={controlsPlacement}
      />

      <CanvasSnapAlignButton placement={controlsPlacement} />

      <CanvasFpsMeter />

      {/* The z-[130] "back to nodes" hint floats above the storyboard (z-30), so hide it too when suspended. */}
      {!suspended && <BackToNodesHint />}

      <CanvasZoomControl
        onOrganize={handleOrganizeCanvas}
        placement={controlsPlacement}
      />

      {/* The quick action bar z-[41] is above the storyboard overlay (z-30), so it must be hidden when suspended;
      the right-side z-30 zoom/minimap/FPS controls are at the same level as the storyboard and covered by DOM order, no handling needed. */}
      {!taskPanelOpen && !suspended && (
        <CanvasQuickActionBar
          placement={controlsPlacement}
          skillItems={skillRegistry}
          onAddNode={handleQuickAddNode}
          onAddSkill={handleQuickAddSkill}
          onUseAsset={handleUseHistoryAsset}
          onDeleteNode={handleDeleteHistoryNode}
        />
      )}

      {previewConnectionVisual && (
        <svg
          className="pointer-events-none absolute z-40 overflow-visible"
          style={{
            left: previewConnectionVisual.left,
            top: previewConnectionVisual.top,
            width: previewConnectionVisual.width,
            height: previewConnectionVisual.height,
          }}
          width={previewConnectionVisual.width}
          height={previewConnectionVisual.height}
        >
          <path
            className="pointer-events-none"
            d={previewConnectionVisual.d}
            fill="none"
            stroke={previewConnectionVisual.stroke}
            strokeWidth={previewConnectionVisual.strokeWidth}
            strokeLinecap={previewConnectionVisual.strokeLinecap}
          />
        </svg>
      )}

      <CanvasPickBanner />

      {showNodeMenu && (
        <NodeSelectionMenu
          position={menuPosition}
          allowedTypes={menuAllowedTypes}
          onSelect={handleNodeSelect}
          skillItems={menuAllowedTypes ? undefined : skillRegistry}
          onSelectSkill={menuAllowedTypes ? undefined : handleSkillSelect}
          onClose={closeNodeMenu}
        />
      )}

      <NodeToolDialog />

      <ImageViewerModal
        open={imageViewer.isOpen}
        imageUrl={imageViewer.currentImageUrl || ''}
        imageList={imageViewer.imageList}
        currentIndex={imageViewer.currentIndex}
        onClose={closeImageViewer}
        onNavigate={navigateImageViewer}
      />

      <VideoViewerModal
        open={videoViewer.isOpen}
        videoUrl={videoViewer.videoUrl}
        title={videoViewer.title}
        onClose={closeVideoViewer}
      />
    </div>
    </CreditDisplayHiddenProvider>
  );
}

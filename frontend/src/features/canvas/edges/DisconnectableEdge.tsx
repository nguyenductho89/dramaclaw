// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  Position,
  type EdgeProps,
} from '@xyflow/react';
import { Scissors } from 'lucide-react';

import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { isPresetManagedEdge } from '@/features/canvas/domain/mainlineNodeFlags';
import { useCanvasStore } from '@/stores/canvasStore';
import { useShallow } from 'zustand/react/shallow';
import { useSettingsStore } from '@/stores/settingsStore';
import { buildOrthogonalRoute } from './edgeRouting';

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// A stable empty array reference - outside smartOrthogonal mode the edge need not subscribe to nodes; returning it keeps the
// selector always "equal", so dragging any node never triggers an edge re-render.
const NO_ROUTING_NODES: CanvasNode[] = [];

const EDGE_ACTIVE_TRANSITION_MS = 300;
// The radius of the connection endpoint dot, and its offset along the port direction toward outside the node (>= radius -> the whole dot lands outside the node, hugging the edge).
const PORT_DOT_RADIUS = 4;
const PORT_DOT_OFFSET = 4;

// The outward offset vector of the endpoint dot: offset toward outside the node by the edge the handle is on, avoiding half of it being blocked by an upper-layer node.
function portDotOffset(position: Position | undefined): { dx: number; dy: number } {
  switch (position) {
    case Position.Left:
      return { dx: -PORT_DOT_OFFSET, dy: 0 };
    case Position.Right:
      return { dx: PORT_DOT_OFFSET, dy: 0 };
    case Position.Top:
      return { dx: 0, dy: -PORT_DOT_OFFSET };
    case Position.Bottom:
      return { dx: 0, dy: PORT_DOT_OFFSET };
    default:
      return { dx: 0, dy: 0 };
  }
}
const EDGE_DISCONNECT_HOVER_DELAY_MS = 500;
const EDGE_DISCONNECT_LEAVE_GRACE_MS = 160;
const EDGE_DISCONNECT_ACTION_SIZE = 40;

export const DisconnectableEdge = memo(function DisconnectableEdge(props: EdgeProps) {
  const {
    id,
    source,
    target,
    selected,
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    markerEnd,
    style,
    data,
  } = props;
  const { t } = useTranslation();
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const canvasEdgeRoutingMode = useSettingsStore((state) => state.canvasEdgeRoutingMode);
  // Only smartOrthogonal obstacle avoidance needs the full nodes (to compute obstacle rectangles). In spline/plain orthogonal mode the edge's path
  // is fully decided by the source/target endpoint coordinates provided by xyflow, and need not subscribe to nodes - when dragging unrelated nodes
  // this edge no longer re-renders. useShallow compares element by element so that in smart mode it recomputes only when nodes really move.
  const routingNodes = useCanvasStore(
    useShallow((state) =>
      canvasEdgeRoutingMode === 'smartOrthogonal' ? state.nodes : NO_ROUTING_NODES
    )
  );
  const [isHovered, setIsHovered] = useState(false);
  const [showDisconnectAction, setShowDisconnectAction] = useState(false);
  const disconnectHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disconnectLeaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const edgeIsPresetManaged = isPresetManagedEdge({ id, source, target, data } as CanvasEdge);

  const clearDisconnectHoverTimer = () => {
    if (disconnectHoverTimerRef.current === null) return;
    clearTimeout(disconnectHoverTimerRef.current);
    disconnectHoverTimerRef.current = null;
  };

  const clearDisconnectLeaveTimer = () => {
    if (disconnectLeaveTimerRef.current === null) return;
    clearTimeout(disconnectLeaveTimerRef.current);
    disconnectLeaveTimerRef.current = null;
  };

  const handleInteractiveEnter = () => {
    clearDisconnectLeaveTimer();
    setIsHovered(true);
    if (edgeIsPresetManaged || showDisconnectAction || disconnectHoverTimerRef.current !== null) {
      return;
    }
    disconnectHoverTimerRef.current = setTimeout(() => {
      setShowDisconnectAction(true);
      disconnectHoverTimerRef.current = null;
    }, EDGE_DISCONNECT_HOVER_DELAY_MS);
  };

  const handleInteractiveLeave = () => {
    clearDisconnectHoverTimer();
    clearDisconnectLeaveTimer();
    disconnectLeaveTimerRef.current = setTimeout(() => {
      setIsHovered(false);
      setShowDisconnectAction(false);
      disconnectLeaveTimerRef.current = null;
    }, EDGE_DISCONNECT_LEAVE_GRACE_MS);
  };

  useEffect(() => {
    return () => {
      clearDisconnectHoverTimer();
      clearDisconnectLeaveTimer();
    };
  }, []);

  // Selected state highlight: when no node is selected all edges stay gray; after selecting a node, the edges
  // connected to it light up (accent) and the rest are dimmed, highlighting the relationship with the current node.
  const hasSelection = selectedNodeId != null;
  const isConnectedToSelected =
    hasSelection && (source === selectedNodeId || target === selectedNodeId);

  const { edgePath, labelX, labelY } = useMemo(() => {
    if (canvasEdgeRoutingMode === 'spline') {
      const [path, nextLabelX, nextLabelY] = getBezierPath({
        sourceX,
        sourceY,
        sourcePosition,
        targetX,
        targetY,
        targetPosition,
      });
      return {
        edgePath: path,
        labelX: nextLabelX,
        labelY: nextLabelY,
      };
    }

    const route = buildOrthogonalRoute({
      sourceId: source,
      targetId: target,
      sourceX,
      sourceY,
      sourcePosition: sourcePosition ?? Position.Right,
      targetX,
      targetY,
      targetPosition: targetPosition ?? Position.Left,
      nodes: routingNodes,
      smartAvoidance: canvasEdgeRoutingMode === 'smartOrthogonal',
    });
    return {
      edgePath: route.path,
      labelX: route.labelX,
      labelY: route.labelY,
    };
  }, [
    canvasEdgeRoutingMode,
    routingNodes,
    source,
    sourcePosition,
    sourceX,
    sourceY,
    target,
    targetPosition,
    targetX,
    targetY,
  ]);

  // Compute a boolean directly in the selector: return a primitive value, and Object.is comparison makes this edge re-render only when "whether it is processing"
  // flips, rather than recomputing on every change of any node.
  const isProcessingEdge = useCanvasStore((state) => {
    const sourceNode = state.nodes.find((node) => node.id === source);
    const targetNode = state.nodes.find((node) => node.id === target);

    if (!sourceNode || !targetNode || targetNode.type !== CANVAS_NODE_TYPES.exportImage) {
      return false;
    }

    const isSupportedSource =
      sourceNode.type === CANVAS_NODE_TYPES.storyboardGen ||
      sourceNode.type === CANVAS_NODE_TYPES.imageEdit;
    if (!isSupportedSource) {
      return false;
    }

    return (targetNode.data as { isGenerating?: boolean } | undefined)?.isGenerating === true;
  });

  const dataRecord = recordValue(data);
  const bindingRole =
    ['candidate_binding', 'role_binding'].includes(String(dataRecord.edgeKind || '')) &&
    typeof dataRecord.role === 'string'
      ? dataRecord.role
      : null;

  const processingStroke = 'rgb(var(--accent-rgb) / 0.94)';
  const processingDashStroke = 'rgb(var(--accent-rgb) / 1)';
  const baseStrokeWidth = isProcessingEdge ? (selected ? 2.7 : 2.2) : 2;

  // An edge being processed always keeps its own accent highlight style, and does not take part in selection dimming.
  // Edges connected to hover/selection light up slightly; normally gray semi-transparent; after selection unrelated edges are dimmed one more notch.
  const highlightStroke = 'rgba(205, 209, 216, 0.64)';
  const bindingStroke = 'rgba(34,211,238,0.66)';
  const bindingHighlightStroke = 'rgba(172, 226, 236, 0.72)';
  const baseStroke = 'rgba(176, 176, 183, 0.45)';
  const dimStroke = 'rgba(176, 176, 183, 0.22)';
  const resolvedStroke = isProcessingEdge
    ? processingStroke
    : isConnectedToSelected || selected || isHovered
      ? (bindingRole ? bindingHighlightStroke : highlightStroke)
      : hasSelection
        ? dimStroke
        : (bindingRole ? bindingStroke : baseStroke);
  const resolvedStrokeWidth = baseStrokeWidth;
  const shouldShowDataFlow =
    !isProcessingEdge && (isHovered || selected || isConnectedToSelected);
  const flowPathId = `canvas-data-flow-path-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const flowGradientId = `canvas-data-flow-gradient-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const flowGlowId = `canvas-data-flow-glow-${id.replace(/[^a-zA-Z0-9_-]/g, '_')}`;

  const sourceDotOffset = portDotOffset(sourcePosition ?? Position.Right);
  const targetDotOffset = portDotOffset(targetPosition ?? Position.Left);

  return (
    <>
      {isProcessingEdge && (
        <path
          d={edgePath}
          fill="none"
          stroke={processingDashStroke}
          strokeWidth={selected ? 2.5 : 2.1}
          strokeLinecap="round"
          strokeDasharray="8 10"
          className="canvas-processing-edge__flow"
          style={{ pointerEvents: 'none' }}
        />
      )}
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        style={{
          ...style,
          stroke: resolvedStroke,
          strokeWidth: resolvedStrokeWidth,
          transition: `stroke ${EDGE_ACTIVE_TRANSITION_MS}ms ease, stroke-width ${EDGE_ACTIVE_TRANSITION_MS}ms ease`,
        }}
      />
      {/* Connection endpoint dots (matches libtv): after an edge is established, draw a connection point at the connection port of each end node,
      making the "connected" state visible on the nodes - in the past a node's handle was hidden by a global opacity:0, and after connecting
      the node looked the same as unconnected. Drawing on the edge (rather than on each node's Handle) naturally covers all node types
      (image/video/...), and changes color along with the node moving and the edge highlight. A dark stroke ensures it can be seen clearly even over a bright image.
      The endpoint sits exactly on the node border, and the edge layer is below the nodes, so drawing directly would be half blocked by the node - offset outward along each port
      direction by PORT_DOT_OFFSET, so the whole dot lands outside the node, hugging the edge and exactly on top of the line. */}
      <g style={{ pointerEvents: 'none' }}>
        <circle
          cx={sourceX + sourceDotOffset.dx}
          cy={sourceY + sourceDotOffset.dy}
          r={PORT_DOT_RADIUS}
          fill={resolvedStroke}
          stroke="rgba(9, 9, 9, 0.55)"
          strokeWidth={1}
          style={{ transition: `fill ${EDGE_ACTIVE_TRANSITION_MS}ms ease` }}
        />
        <circle
          cx={targetX + targetDotOffset.dx}
          cy={targetY + targetDotOffset.dy}
          r={PORT_DOT_RADIUS}
          fill={resolvedStroke}
          stroke="rgba(9, 9, 9, 0.55)"
          strokeWidth={1}
          style={{ transition: `fill ${EDGE_ACTIVE_TRANSITION_MS}ms ease` }}
        />
      </g>
      {!isProcessingEdge && (
        <path
          className="nodrag nopan"
          d={edgePath}
          fill="none"
          stroke="transparent"
          strokeWidth={24}
          strokeLinecap="round"
          style={{ pointerEvents: 'stroke', cursor: 'default' }}
          onPointerEnter={handleInteractiveEnter}
          onPointerLeave={handleInteractiveLeave}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      )}
      {shouldShowDataFlow && (
        <>
          <defs>
            <path id={flowPathId} d={edgePath} />
            <linearGradient
              id={flowGradientId}
              gradientUnits="userSpaceOnUse"
              x1="-48"
              y1="0"
              x2="48"
              y2="0"
            >
              <stop offset="0%" stopColor="white" stopOpacity="0" />
              <stop offset="42%" stopColor="white" stopOpacity="0.28" />
              <stop offset="100%" stopColor="white" stopOpacity="0.72" />
            </linearGradient>
            <filter id={flowGlowId} x="-80%" y="-240%" width="260%" height="580%">
              <feGaussianBlur stdDeviation="14" />
            </filter>
          </defs>
          {[0, -2.33, -4.67].map((begin) => (
            <g
              key={begin}
              className="canvas-data-edge__packet"
              style={{ pointerEvents: 'none', opacity: 0.72 }}
            >
              <g transform="scale(0.45, 1)">
                <line
                  x1="-46"
                  y1="0"
                  x2="46"
                  y2="0"
                  fill="none"
                  stroke={`url(#${flowGradientId})`}
                  strokeLinecap="round"
                  strokeWidth={12}
                  opacity={0.34}
                  filter={`url(#${flowGlowId})`}
                />
                <line
                  x1="-42"
                  y1="0"
                  x2="42"
                  y2="0"
                  fill="none"
                  stroke={`url(#${flowGradientId})`}
                  strokeLinecap="round"
                  strokeWidth={4}
                />
              </g>
              <animateMotion
                className="canvas-data-edge__packet-motion"
                dur="7s"
                begin={`${begin}s`}
                repeatCount="indefinite"
                rotate="auto"
              >
                <mpath href={`#${flowPathId}`} />
              </animateMotion>
            </g>
          ))}
        </>
      )}
      {showDisconnectAction && !edgeIsPresetManaged && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute"
            style={{
              height: EDGE_DISCONNECT_ACTION_SIZE,
              width: EDGE_DISCONNECT_ACTION_SIZE + 16,
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
              pointerEvents: 'all',
            }}
            onPointerEnter={handleInteractiveEnter}
            onPointerLeave={handleInteractiveLeave}
            onPointerDown={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <button
              type="button"
              className="absolute left-1/2 top-0 flex h-10 w-10 -translate-x-1/2 items-center justify-center rounded-full border border-white/15 bg-[#17191d]/95 text-white/85 shadow-[0_0_0_1px_rgba(255,255,255,0.04),0_12px_28px_rgba(0,0,0,0.45)] backdrop-blur transition-[border-color,color,box-shadow] duration-150 hover:border-white/30 hover:text-white hover:shadow-[0_0_0_1px_rgba(255,255,255,0.12),0_0_22px_rgba(120,180,255,0.22),0_12px_30px_rgba(0,0,0,0.5)]"
              onClick={(event) => {
                event.stopPropagation();
                deleteEdge(id);
              }}
              aria-label={t('canvas.edge.disconnect')}
            >
              <Scissors className="h-6 w-6 stroke-[2.35]" />
            </button>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
});

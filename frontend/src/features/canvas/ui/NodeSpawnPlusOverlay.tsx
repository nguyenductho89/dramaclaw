// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NodeToolbar as ReactFlowNodeToolbar, Position, useStore } from '@xyflow/react';
import { Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useCanvasStore } from '@/stores/canvasStore';
import {
  CANVAS_NODE_TYPES,
  isScriptNode,
  isVideoNode,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import {
  getDownstreamSpawnTypes,
  getNodeDefinition,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';

type SpawnDirection = 'right' | 'left';

interface PlusButtonProps {
  nodeId: string;
  direction: SpawnDirection;
  allowedTypes: CanvasNodeType[];
  exiting?: boolean;
  onOpenMenu?: (params: PlusDragEventParams) => void;
  onDragStart?: (params: PlusDragEventParams) => void;
  onDragMove?: (params: PlusDragEventParams) => void;
  onDragEnd?: (params: PlusDragEventParams) => void;
  onHoverStart?: () => void;
  onHoverEnd?: () => void;
}

const PLUS_DRAG_THRESHOLD_PX = 5;
// Magnet follow radius: only when the mouse enters this radius does the "+" start following the cursor, and beyond it, it resets to the anchor.
// It must be >= the corner distance of the invisible hit area below (`-inset-2`) (~34px), otherwise the hit area's corners would reset early.
// Deliberately narrowed: the large sensing area of the old value (160/`-inset-20`) would cover the node body when the canvas is zoomed out, stealing
// the node's pointerdown -> the node could not be dragged / showed no grab handle. Now the sensing area hugs only the button itself,
// and the appearance of the "+" is still driven by node hover (onNodeMouseEnter), unaffected.
const PLUS_MAGNET_RADIUS_PX = 48;
// How far the "+" can chase the cursor from the anchor at most (larger chases farther).
const PLUS_MAGNET_MAX_OFFSET_PX = 18;
// The ratio per frame of interpolating the current offset toward the target offset (0~1): smaller feels floatier and silkier, larger follows the hand more tightly.
const PLUS_MAGNET_LERP = 0.18;
// The base gap from the "+" to the node edge (NodeToolbar offset).
const PLUS_TOOLBAR_OFFSET = 20;
// When the magnet pulls toward the node, the button's edge on the side nearest the node must stay at least this far from the node edge - to avoid covering
// the node edge's connection ball (Handle, about 4px exposed).
const PLUS_MIN_GAP_FROM_NODE_PX = 10;
// Explicit contract anchor: pano360 viewer remains a supported freezone spawn type.
const FREEZONE_VIEWER_CONTRACT_TYPES = [CANVAS_NODE_TYPES.pano360Viewer] as const;

type PlusHandleType = 'source' | 'target';

interface PlusDragEventParams {
  nodeId: string;
  handleType: PlusHandleType;
  clientPosition: { x: number; y: number };
}

interface PlusDragStart {
  x: number;
  y: number;
  pointerId: number;
}

function PlusButton({
  nodeId,
  direction,
  allowedTypes,
  exiting = false,
  onOpenMenu,
  onDragStart,
  onDragMove,
  onDragEnd,
  onHoverStart,
  onHoverEnd,
}: PlusButtonProps) {
  const { t } = useTranslation();
  const dragStartRef = useRef<PlusDragStart | null>(null);
  const dragStartedRef = useRef(false);
  const suppressClickRef = useRef(false);
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // The magnet displacement is interpolated via rAF and written directly to the DOM transform, not into React state - avoiding a re-render on every
  // pointermove, so following is silkier (current lerps toward target every frame).
  const targetOffsetRef = useRef({ x: 0, y: 0 });
  const currentOffsetRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const handleType: PlusHandleType = direction === 'right' ? 'source' : 'target';

  // Follow the canvas zoom: use zoom directly as the button scale (no clamping, strictly by the canvas ratio - consistent with the floating
  // toolbar/upload button bar), so it shrinks when zoomed out and grows when zoomed in, no longer jarring.
  // The grow direction is away from the node (the right "+" grows rightward from its left edge, the left "+" grows leftward from its right edge),
  // avoiding covering the node body again when enlarged.
  const zoom = useStore((state) => state.transform[2]);
  const plusScale = zoom;
  const plusScaleRef = useRef(plusScale);
  plusScaleRef.current = plusScale;

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0 || allowedTypes.length === 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragStartRef.current = {
        x: event.clientX,
        y: event.clientY,
        pointerId: event.pointerId,
      };
      dragStartedRef.current = false;

      const handlePointerMove = (moveEvent: PointerEvent) => {
        const start = dragStartRef.current;
        if (!start || start.pointerId !== moveEvent.pointerId) {
          return;
        }
        const clientPosition = { x: moveEvent.clientX, y: moveEvent.clientY };
        if (!dragStartedRef.current) {
          const delta = Math.hypot(moveEvent.clientX - start.x, moveEvent.clientY - start.y);
          if (delta < PLUS_DRAG_THRESHOLD_PX) return;
          dragStartedRef.current = true;
          suppressClickRef.current = true;
          onDragStart?.({
            nodeId,
            handleType,
            clientPosition: { x: start.x, y: start.y },
          });
        }
        onDragMove?.({ nodeId, handleType, clientPosition });
      };

      const handlePointerUp = (upEvent: PointerEvent) => {
        const wasDragging = dragStartedRef.current;
        if (dragStartRef.current?.pointerId === upEvent.pointerId) {
          dragStartRef.current = null;
        }
        window.removeEventListener('pointermove', handlePointerMove, true);
        window.removeEventListener('pointerup', handlePointerUp, true);
        window.removeEventListener('pointercancel', handlePointerUp, true);
        if (wasDragging) {
          onDragEnd?.({
            nodeId,
            handleType,
            clientPosition: { x: upEvent.clientX, y: upEvent.clientY },
          });
        }
      };

      window.addEventListener('pointermove', handlePointerMove, true);
      window.addEventListener('pointerup', handlePointerUp, true);
      window.addEventListener('pointercancel', handlePointerUp, true);
    },
    [allowedTypes.length, handleType, nodeId, onDragEnd, onDragMove, onDragStart],
  );

  // rAF loop: every frame interpolate currentOffset toward targetOffset and write it directly to the button's transform.
  // Stop the loop once it is close to the current target (whether the target is the origin or some resting offset) - when the cursor is still the
  // target no longer changes and there is nothing to animate; the next pointermove restarts it via ensureMagnetLoop.
  // This way it does not spin idle when the pointer rests off-center.
  const runMagnetLoop = useCallback(() => {
    const cur = currentOffsetRef.current;
    const tgt = targetOffsetRef.current;
    const nx = cur.x + (tgt.x - cur.x) * PLUS_MAGNET_LERP;
    const ny = cur.y + (tgt.y - cur.y) * PLUS_MAGNET_LERP;
    const settled = Math.abs(nx - tgt.x) < 0.1 && Math.abs(ny - tgt.y) < 0.1;
    const x = settled ? tgt.x : nx;
    const y = settled ? tgt.y : ny;
    currentOffsetRef.current = { x, y };
    if (buttonRef.current) {
      // translate (magnet displacement, in screen px, unchanged by scale) + scale (follows the zoom).
      buttonRef.current.style.transform = `translate(${x}px, ${y}px) scale(${plusScaleRef.current})`;
    }
    if (settled) {
      rafRef.current = null;
      return;
    }
    rafRef.current = requestAnimationFrame(runMagnetLoop);
  }, []);

  const ensureMagnetLoop = useCallback(() => {
    if (rafRef.current == null) {
      rafRef.current = requestAnimationFrame(runMagnetLoop);
    }
  }, [runMagnetLoop]);

  const resetMagnetOffset = useCallback(() => {
    targetOffsetRef.current = { x: 0, y: 0 };
    ensureMagnetLoop();
  }, [ensureMagnetLoop]);

  const updateMagnetOffset = useCallback((event: React.PointerEvent) => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;

    const centerX = rect.left + rect.width / 2;
    const centerY = rect.top + rect.height / 2;
    const dx = event.clientX - centerX;
    const dy = event.clientY - centerY;
    const distance = Math.hypot(dx, dy);

    if (distance > PLUS_MAGNET_RADIUS_PX) {
      resetMagnetOffset();
      return;
    }

    const strength = Math.min(1, distance / PLUS_MAGNET_RADIUS_PX);
    const maxOffset = PLUS_MAGNET_MAX_OFFSET_PX * strength;
    const scale = distance > maxOffset && distance > 0 ? maxOffset / distance : 1;
    // Limit displacement toward the node: the button's side nearest the node must not cross PLUS_MIN_GAP_FROM_NODE_PX,
    // otherwise the magnet would pull the "+" to the node edge and cover the connection ball (Handle). No limit away from the node / vertically.
    const towardNodeLimit = PLUS_TOOLBAR_OFFSET - PLUS_MIN_GAP_FROM_NODE_PX;
    let offsetX = dx * scale;
    if (direction === 'right') {
      offsetX = Math.max(offsetX, -towardNodeLimit);
    } else {
      offsetX = Math.min(offsetX, towardNodeLimit);
    }
    targetOffsetRef.current = { x: offsetX, y: dy * scale };
    ensureMagnetLoop();
  }, [direction, ensureMagnetLoop, resetMagnetOffset]);

  // Stop rAF on unmount to avoid leaks.
  useEffect(() => {
    return () => {
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, []);

  // Rewrite the transform immediately when zoom changes - the magnet rAF stops after settling and does not automatically catch up with the new
  // scale; add one pass when zoom changes, so the idle "+" also grows and shrinks instantly with zoom.
  useEffect(() => {
    if (buttonRef.current) {
      const { x, y } = currentOffsetRef.current;
      buttonRef.current.style.transform = `translate(${x}px, ${y}px) scale(${plusScale})`;
    }
  }, [plusScale]);

  return (
    <div
      ref={anchorRef}
      className={`relative transition-[opacity,transform] duration-200 ease-out ${
        exiting ? 'pointer-events-none scale-95 opacity-0' : 'scale-100 opacity-100'
      }`}
      onPointerEnter={(event) => {
        onHoverStart?.();
        updateMagnetOffset(event);
      }}
      onPointerMove={updateMagnetOffset}
      onPointerLeave={() => {
        resetMagnetOffset();
        onHoverEnd?.();
      }}
    >
      {/* A small hit area hugging the button (only for click tolerance + magnet sensing). Deliberately no longer extends outward toward the node,
      and no node->button hover bridge anymore - those large pointer-events-auto layers would cover the node when the canvas is
      zoomed out and steal dragging. The process of moving to the "+" is covered by the node hover's 400ms hide
      delay (see Canvas: NODE_SPAWN_PLUS_HIDE_DELAY_MS). */}
      <span
        aria-hidden="true"
        className="pointer-events-auto absolute -inset-2 z-0 rounded-full"
        onPointerEnter={(event) => {
          onHoverStart?.();
          updateMagnetOffset(event);
        }}
        onPointerMove={updateMagnetOffset}
        onPointerLeave={() => {
          resetMagnetOffset();
          onHoverEnd?.();
        }}
      />
      <button
        ref={buttonRef}
        type="button"
        aria-label={
          direction === 'right'
            ? t('canvas.spawnPlus.referenceThisNode')
            : t('canvas.spawnPlus.connectIntoThisNode')
        }
        // The scale origin is on the side nearest the node, so when enlarged it grows away from the node and does not cover the node body.
        style={{ transformOrigin: direction === 'right' ? 'left center' : 'right center' }}
        className="canvas-spawn-plus-magnetic-button nodrag relative z-10 flex h-8 w-8 items-center justify-center rounded-full border border-white/40 bg-surface-dark/95 text-white/85 shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_6px_18px_rgba(0,0,0,0.32)] transition-[border-color,color,box-shadow] duration-150 will-change-transform hover:border-white/85 hover:text-white hover:shadow-[0_0_0_1px_rgba(255,255,255,0.42),0_0_18px_rgba(255,255,255,0.22)]"
        onPointerEnter={(event) => {
          onHoverStart?.();
          updateMagnetOffset(event);
        }}
        onPointerMove={updateMagnetOffset}
        onPointerLeave={() => {
          resetMagnetOffset();
          onHoverEnd?.();
        }}
        onPointerDown={handlePointerDown}
        onClick={(event) => {
          event.stopPropagation();
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          onOpenMenu?.({
            nodeId,
            handleType,
            clientPosition: { x: event.clientX, y: event.clientY },
          });
        }}
      >
        <Plus className="h-4 w-4" />
      </button>
    </div>
  );
}

interface NodeSpawnPlusOverlayProps {
  hoveredNodeId?: string | null;
  hidden?: boolean;
  onOverlayHoverStart?: () => void;
  onOverlayHoverEnd?: () => void;
  onPlusOpenMenu?: (params: PlusDragEventParams) => void;
  onPlusDragStart?: (params: PlusDragEventParams) => void;
  onPlusDragMove?: (params: PlusDragEventParams) => void;
  onPlusDragEnd?: (params: PlusDragEventParams) => void;
}

export const NodeSpawnPlusOverlay = memo(({
  hoveredNodeId = null,
  hidden = false,
  onOverlayHoverStart,
  onOverlayHoverEnd,
  onPlusOpenMenu,
  onPlusDragStart,
  onPlusDragMove,
  onPlusDragEnd,
}: NodeSpawnPlusOverlayProps) => {
  const { t: _t } = useTranslation();
  void FREEZONE_VIEWER_CONTRACT_TYPES;
  const nodes = useCanvasStore((state) => state.nodes);
  const activeOverlayNodeId = useCanvasStore((state) => state.activeOverlayNodeId);
  // The gap between the "+" and the node scales with the canvas: NodeToolbar's offset is fixed screen pixels, and when the canvas zooms out
  // the node becomes smaller while this fixed gap looks relatively far. Changed to offset = base gap x zoom, so the gap is constant in
  // flow space - hugging the node when zoomed out and spreading proportionally when zoomed in. A 4px screen minimum is kept to avoid touching
  // the connection ball.
  const zoom = useStore((state) => state.transform[2]);
  const toolbarOffset = Math.max(4, PLUS_TOOLBAR_OFFSET * zoom);
  const [renderNodeId, setRenderNodeId] = useState<string | null>(hidden ? null : hoveredNodeId);
  const [isExiting, setIsExiting] = useState(false);

  const activeNodeId = hidden ? null : hoveredNodeId;

  useEffect(() => {
    if (activeNodeId) {
      setRenderNodeId(activeNodeId);
      setIsExiting(false);
      return;
    }

    setIsExiting(true);
    const timeout = window.setTimeout(() => {
      setRenderNodeId(null);
      setIsExiting(false);
    }, 200);

    return () => window.clearTimeout(timeout);
  }, [activeNodeId]);

  const selectedNode = useMemo(
    () => (renderNodeId ? nodes.find((node) => node.id === renderNodeId) ?? null : null),
    [nodes, renderNodeId],
  );

  // The downstream whitelist of the "generate by referencing this node" + menu, sharing the same
  // `getDownstreamSpawnTypes` with Canvas's drag-to-empty menu - a single source of truth avoids drift between the two sides.
  const rightAllowedTypes = useMemo<CanvasNodeType[]>(() => {
    return getDownstreamSpawnTypes(selectedNode?.type);
  }, [selectedNode]);

  // Left side (video only): upstream inputs allowed for video gen.
  // Scope per product spec: text / image / audio - multi-version / video are not
  // upstream entries of a video node (avoiding generation chain self-loops / semantic confusion).
  const leftAllowedTypes = useMemo<CanvasNodeType[]>(() => {
    return [
        CANVAS_NODE_TYPES.textAnnotation,
        CANVAS_NODE_TYPES.imageGen,
        CANVAS_NODE_TYPES.audio,
      ].filter((type) => {
        const def = getNodeDefinition(type);
        return def?.connectivity.sourceHandle;
      });
  }, []);

  if (!selectedNode) {
    return null;
  }

  // When the node is taken over by a secondary overlay (multi-angle/lighting/stacked-card album expansion etc.) the "+" is not shown -
  // the overlay sits above the node, and the + would punch through the overlay and float in the wrong position.
  if (selectedNode.id === activeOverlayNodeId) {
    return null;
  }

  // A script node does not expose an active "+" entry: a script can only create upstream nodes through the three quick actions inside the node body
  // (screenplay / video reference / character -> generate storyboard script), and downstream derivation is not allowed.
  if (isScriptNode(selectedNode)) {
    return null;
  }

  const showRight = nodeHasSourceHandle(selectedNode.type) && rightAllowedTypes.length > 0;
  // Left + is scoped to the video node per product spec: a video node can pull
  // resources from upstream image/audio/text inputs. Other node types only show
  // the right + (existing "generate by referencing this node" affordance).
  // Only a BLANK video node exposes the upstream "+" - once it already holds a
  // video, the left "+" disappears (consistent with audio nodes: after having a resource only the right "+" remains).
  const videoHasResource =
    isVideoNode(selectedNode) &&
    typeof selectedNode.data.videoUrl === 'string' &&
    selectedNode.data.videoUrl.length > 0;
  const showLeft =
    isVideoNode(selectedNode) &&
    !videoHasResource &&
    nodeHasTargetHandle(selectedNode.type) &&
    leftAllowedTypes.length > 0;

  if (!showRight && !showLeft) {
    return null;
  }

  return (
    <>
      {showRight && (
        <ReactFlowNodeToolbar
          nodeId={selectedNode.id}
          isVisible
          position={Position.Right}
          align="center"
          offset={toolbarOffset}
          className="pointer-events-auto"
          onPointerEnter={onOverlayHoverStart}
          onPointerLeave={onOverlayHoverEnd}
        >
          <PlusButton
            nodeId={selectedNode.id}
            direction="right"
            allowedTypes={rightAllowedTypes}
            exiting={isExiting}
            onOpenMenu={onPlusOpenMenu}
            onDragStart={onPlusDragStart}
            onDragMove={onPlusDragMove}
            onDragEnd={onPlusDragEnd}
            onHoverStart={onOverlayHoverStart}
            onHoverEnd={onOverlayHoverEnd}
          />
        </ReactFlowNodeToolbar>
      )}
      {showLeft && (
        <ReactFlowNodeToolbar
          nodeId={selectedNode.id}
          isVisible
          position={Position.Left}
          align="center"
          offset={toolbarOffset}
          className="pointer-events-auto"
          onPointerEnter={onOverlayHoverStart}
          onPointerLeave={onOverlayHoverEnd}
        >
          <PlusButton
            nodeId={selectedNode.id}
            direction="left"
            allowedTypes={leftAllowedTypes}
            exiting={isExiting}
            onOpenMenu={onPlusOpenMenu}
            onDragStart={onPlusDragStart}
            onDragMove={onPlusDragMove}
            onDragEnd={onPlusDragEnd}
            onHoverStart={onOverlayHoverStart}
            onHoverEnd={onOverlayHoverEnd}
          />
        </ReactFlowNodeToolbar>
      )}
    </>
  );
});

NodeSpawnPlusOverlay.displayName = 'NodeSpawnPlusOverlay';

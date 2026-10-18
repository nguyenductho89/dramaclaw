// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';

/** In the container pixel coordinate system, "the rectangle the video picture actually occupies" (after object-contain removes the letterboxing). */
export interface DisplayedRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Normalized (0..1, relative to the source picture) selection region. */
export interface SubtitleEraseBoxValue {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Transient two points while dragging (normalized coordinates). */
export interface SubtitleEraseDrag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * Compute the displayed video frame rect inside its container (object-contain).
 * Returns container-pixel coords. We use this to (a) size the box overlay so
 * it sits on top of the actual video pixels (not the letterbox bars) and (b)
 * convert pointer coords ↔ normalized 0..1 source coords.
 *
 * Moved out verbatim from VideoNode's private getDisplayedVideoRect (the workflow node player and the storyboard
 * detail player share the same conversion). Falls back to the whole container when the video's intrinsic size is unknown.
 */
export function computeDisplayedVideoRect(
  containerW: number,
  containerH: number,
  videoW: number | null | undefined,
  videoH: number | null | undefined,
): DisplayedRect {
  const vw = videoW ?? 0;
  const vh = videoH ?? 0;
  if (!vw || !vh || containerW <= 0 || containerH <= 0) {
    return { left: 0, top: 0, width: containerW, height: containerH };
  }
  const containerRatio = containerW / containerH;
  const videoRatio = vw / vh;
  if (videoRatio > containerRatio) {
    const w = containerW;
    const h = containerW / videoRatio;
    return { left: 0, top: (containerH - h) / 2, width: w, height: h };
  }
  const h = containerH;
  const w = containerH * videoRatio;
  return { left: (containerW - w) / 2, top: 0, width: w, height: h };
}

export interface SubtitleEraseBoxOverlayProps {
  box: SubtitleEraseBoxValue | null;
  drag: SubtitleEraseDrag | null;
  disabled: boolean;
  getDisplayedRect: (containerW: number, containerH: number) => DisplayedRect;
  onDragStart: (start: SubtitleEraseDrag) => void;
  onDragMove: (next: { x1: number; y1: number }) => void;
  onDragEnd: (final: SubtitleEraseBoxValue | null) => void;
}

/**
 * Drag layer for box-selecting subtitle removal: absolutely positioned to fill the player container, converting pointer coordinates to normalized
 * 0..1 source-picture coordinates (after subtracting the object-contain letterbox offset), and drawing the current box.
 *
 * Moved out verbatim from VideoNode's private component, for reuse by both the workflow node and the storyboard detail.
 */
export function SubtitleEraseBoxOverlay({
  box,
  drag,
  disabled,
  getDisplayedRect,
  onDragStart,
  onDragMove,
  onDragEnd,
}: SubtitleEraseBoxOverlayProps): ReactElement {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({
    w: 0,
    h: 0,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerSize({
        w: entry.contentRect.width,
        h: entry.contentRect.height,
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const displayed = getDisplayedRect(containerSize.w, containerSize.h);

  const toNormalized = useCallback(
    (clientX: number, clientY: number) => {
      const el = containerRef.current;
      if (!el) return { nx: 0, ny: 0 };
      const rect = el.getBoundingClientRect();
      const localX = clientX - rect.left - displayed.left;
      const localY = clientY - rect.top - displayed.top;
      const nx = displayed.width > 0 ? localX / displayed.width : 0;
      const ny = displayed.height > 0 ? localY / displayed.height : 0;
      return {
        nx: Math.max(0, Math.min(1, nx)),
        ny: Math.max(0, Math.min(1, ny)),
      };
    },
    [displayed.height, displayed.left, displayed.top, displayed.width],
  );

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled) return;
      event.preventDefault();
      event.stopPropagation();
      event.currentTarget.setPointerCapture(event.pointerId);
      const { nx, ny } = toNormalized(event.clientX, event.clientY);
      onDragStart({ x0: nx, y0: ny, x1: nx, y1: ny });
    },
    [disabled, onDragStart, toNormalized],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || !drag) return;
      const { nx, ny } = toNormalized(event.clientX, event.clientY);
      onDragMove({ x1: nx, y1: ny });
    },
    [disabled, drag, onDragMove, toNormalized],
  );

  const handlePointerUp = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (disabled || !drag) return;
      try {
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {
        // pointer may not have been captured
      }
      const x = Math.min(drag.x0, drag.x1);
      const y = Math.min(drag.y0, drag.y1);
      const width = Math.abs(drag.x1 - drag.x0);
      const height = Math.abs(drag.y1 - drag.y0);
      if (width < 0.01 || height < 0.01) {
        onDragEnd(null);
        return;
      }
      onDragEnd({ x, y, width, height });
    },
    [disabled, drag, onDragEnd],
  );

  const effective = drag
    ? {
        x: Math.min(drag.x0, drag.x1),
        y: Math.min(drag.y0, drag.y1),
        width: Math.abs(drag.x1 - drag.x0),
        height: Math.abs(drag.y1 - drag.y0),
      }
    : box;

  return (
    <div
      ref={containerRef}
      className="nodrag absolute inset-0 z-30"
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onClick={(event) => event.stopPropagation()}
      style={{ cursor: disabled ? 'not-allowed' : 'crosshair' }}
    >
      {effective && effective.width > 0 && effective.height > 0 && (
        <div
          className="pointer-events-none absolute border-2 border-[rgb(var(--accent-rgb))] bg-[rgb(var(--accent-rgb)/0.15)]"
          style={{
            left: displayed.left + effective.x * displayed.width,
            top: displayed.top + effective.y * displayed.height,
            width: effective.width * displayed.width,
            height: effective.height * displayed.height,
          }}
        />
      )}
    </div>
  );
}

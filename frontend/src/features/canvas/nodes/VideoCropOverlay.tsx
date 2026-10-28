// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Crop box for video cropping: overlaid on the real video frame (letterbox bars from object-contain don't count), dimmed outside the box and a
// rule-of-thirds grid inside, 8 handles (four corners + four edge midpoints); only the four corners when the ratio is locked. Controlled component: box state lives in
// VideoNode; this only converts pointer displacement into source pixels and hands it to cropMath.
import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";

import {
  CROP_ALL_HANDLES,
  CROP_CORNER_HANDLES,
  containRect,
  dragCropHandle,
  moveCropBox,
  toEvenSourceRect,
  type CropBox,
  type CropHandle,
} from "@/features/canvas/application/videoCrop/cropMath";
import { consumeVideoCropFocus } from "@/features/canvas/application/videoCrop/videoCropInFlight";

interface VideoCropOverlayProps {
  /** Used to claim one-shot focus; see consumeVideoCropFocus. */
  nodeId: string;
  box: CropBox;
  /** Width / height; null = free ratio. */
  ratio: number | null;
  sourceWidth: number;
  sourceHeight: number;
  disabled: boolean;
  onChange: (box: CropBox) => void;
  /** Esc exits crop mode; if omitted, Esc is ignored (backward compatible). */
  onEscape?: () => void;
}

/** Arrow keys move 1 source pixel per step; Shift speeds up to 10. */
const KEY_STEP = 1;
const KEY_STEP_FAST = 10;

const HANDLE_LAYOUT: Record<CropHandle, { left: string; top: string; cursor: string }> = {
  nw: { left: "0%", top: "0%", cursor: "nwse-resize" },
  n: { left: "50%", top: "0%", cursor: "ns-resize" },
  ne: { left: "100%", top: "0%", cursor: "nesw-resize" },
  e: { left: "100%", top: "50%", cursor: "ew-resize" },
  se: { left: "100%", top: "100%", cursor: "nwse-resize" },
  s: { left: "50%", top: "100%", cursor: "ns-resize" },
  sw: { left: "0%", top: "100%", cursor: "nesw-resize" },
  w: { left: "0%", top: "50%", cursor: "ew-resize" },
};

interface DragState {
  kind: "move" | CropHandle;
  pointerId: number;
  startBox: CropBox;
  clientX: number;
  clientY: number;
  /** Screen pixels per source pixel. Frozen on press so canvas zoom mid-drag doesn't affect this drag. */
  clientPxPerSourcePx: number;
}

export function VideoCropOverlay({
  nodeId,
  box,
  ratio,
  sourceWidth,
  sourceHeight,
  disabled,
  onChange,
  onEscape,
}: VideoCropOverlayProps) {
  const { t } = useTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const [containerSize, setContainerSize] = useState({ w: 0, h: 0 });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      setContainerSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    // Only the single click on the toolbar's "enter crop mode" action registers a claim (see requestVideoCropFocus in
    // videoCropInFlight.ts) and grabs focus once, rather than grabbing it on every mount:
    // 1. When a Radix dropdown closes it returns focus to its trigger button, so a single grab here would lose; this relies on
    //    NodeActionToolbar's onCloseAutoFocus yielding, plus actually grabbing focus here.
    // 2. When a node is unmounted and remounted by onlyRenderVisibleElements this overlay remounts; if every
    //    mount grabbed focus, the cursor would be silently stolen while the user types in another input.
    // consumeVideoCropFocus is one-shot: even if this effect reruns several times because containerSize
    // changes, only the call holding the claim ever gets true.
    if (disabled || !boxRef.current) return;
    if (!consumeVideoCropFocus(nodeId)) return;
    const el = boxRef.current;
    // The box only renders after the first ResizeObserver callback (once the container has a size); rAF lets the browser
    // settle this frame's layout first, avoiding focusing an element not yet actually on the page.
    const raf = requestAnimationFrame(() => {
      el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [disabled, nodeId, containerSize.w, containerSize.h]);

  useEffect(() => {
    // Source size changed (e.g. switched to another video): the parent supplies a new box, so the old drag origin is void.
    dragRef.current = null;
  }, [sourceWidth, sourceHeight]);

  const displayed = containRect(containerSize.w, containerSize.h, sourceWidth, sourceHeight);
  const pixel = toEvenSourceRect(box, sourceWidth, sourceHeight);
  const boxLeft = (box.x / sourceWidth) * displayed.width;
  const boxTop = (box.y / sourceHeight) * displayed.height;
  const boxWidth = (box.width / sourceWidth) * displayed.width;
  const boxHeight = (box.height / sourceHeight) * displayed.height;

  const beginDrag = (event: ReactPointerEvent<HTMLElement>, kind: DragState["kind"]) => {
    event.preventDefault();
    event.stopPropagation();
    // Still swallow the event so react-flow doesn't handle it, but only the primary button (left click/touch/pen) actually starts a drag.
    if (event.button !== 0) return;
    if (disabled) return;
    // preventDefault also swallowed the default click focus; restore it manually, otherwise the keyboard can't move the box after a drag.
    boxRef.current?.focus({ preventScroll: true });
    const container = containerRef.current;
    if (!container || displayed.width <= 0) return;
    // When the canvas is zoomed the node has a CSS transform: clientX is in screen pixels, contentRect in layout pixels.
    const zoom = containerSize.w > 0 ? container.getBoundingClientRect().width / containerSize.w : 1;
    dragRef.current = {
      kind,
      pointerId: event.pointerId,
      startBox: box,
      clientX: event.clientX,
      clientY: event.clientY,
      clientPxPerSourcePx: (displayed.width / sourceWidth) * zoom,
    };
    try {
      container.setPointerCapture(event.pointerId);
    } catch {
      // jsdom / released pointers don't support capture; dragging still works via bubbling
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (disabled) {
      // Crop was turned off externally mid-drag: clear the drag state and stop applying displacement to the box.
      dragRef.current = null;
      return;
    }
    event.stopPropagation();
    const dx = (event.clientX - drag.clientX) / drag.clientPxPerSourcePx;
    const dy = (event.clientY - drag.clientY) / drag.clientPxPerSourcePx;
    onChange(
      drag.kind === "move"
        ? moveCropBox(drag.startBox, dx, dy, sourceWidth, sourceHeight)
        : dragCropHandle(drag.startBox, drag.kind, dx, dy, ratio, sourceWidth, sourceHeight),
    );
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current || dragRef.current.pointerId !== event.pointerId) return;
    dragRef.current = null;
    try {
      containerRef.current?.releasePointerCapture(event.pointerId);
    } catch {
      // the pointer may not have been captured
    }
  };

  // Arrow keys move the box, Alt+arrow resizes from the bottom-right corner, Esc exits. Matched keys must stopPropagation,
  // otherwise they would also trigger the react-flow node's built-in arrow-key movement of the whole node, and the arrow-key / Esc handling
  // registered separately on document in Canvas.tsx. Only these two classes of keys are blocked here; shortcuts on other keys such as delete and
  // undo are unaffected.
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const directions: Record<string, { dx: number; dy: number }> = {
      ArrowLeft: { dx: -1, dy: 0 },
      ArrowRight: { dx: 1, dy: 0 },
      ArrowUp: { dx: 0, dy: -1 },
      ArrowDown: { dx: 0, dy: 1 },
    };
    const isEscape = event.key === "Escape";
    const direction = directions[event.key];
    if (!isEscape && !direction) return;

    // Swallow these two classes of keys when disabled too: otherwise the react-flow / Canvas.tsx layers would still
    // receive them; the crop box just no longer performs its own move/exit actions.
    event.preventDefault();
    event.stopPropagation();
    if (disabled) return;

    if (isEscape) {
      onEscape?.();
      return;
    }

    const step = event.shiftKey ? KEY_STEP_FAST : KEY_STEP;
    const dx = direction.dx * step;
    const dy = direction.dy * step;
    onChange(
      event.altKey
        ? dragCropHandle(box, "se", dx, dy, ratio, sourceWidth, sourceHeight)
        : moveCropBox(box, dx, dy, sourceWidth, sourceHeight),
    );
  };

  const handles = ratio === null ? CROP_ALL_HANDLES : CROP_CORNER_HANDLES;

  return (
    <div
      ref={containerRef}
      className="nodrag nopan absolute inset-0 z-30"
      onPointerDown={(event) => event.stopPropagation()}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onLostPointerCapture={endDrag}
      onClick={(event) => event.stopPropagation()}
    >
      {displayed.width > 0 && (
        <>
          {/* Dim layer: an oversized box-shadow paints outside the box, wrapped in a crop container that exposes only the picture area. */}
          <div className="pointer-events-none absolute overflow-hidden" style={displayed}>
            <div
              className="absolute shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]"
              style={{ left: boxLeft, top: boxTop, width: boxWidth, height: boxHeight }}
            />
          </div>

          <div
            ref={boxRef}
            data-testid="video-crop-box"
            data-crop-box=""
            role="group"
            aria-label={t("node.videoNode.crop.boxLabel")}
            tabIndex={0}
            className="absolute border border-white/90 focus:outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-white"
            style={{
              left: displayed.left + boxLeft,
              top: displayed.top + boxTop,
              width: boxWidth,
              height: boxHeight,
              cursor: disabled ? "not-allowed" : "move",
            }}
            onPointerDown={(event) => beginDrag(event, "move")}
            onKeyDown={handleKeyDown}
          >
            <div className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/45" />
            <div className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/45" />
            <div className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/45" />
            <div className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/45" />
            {boxWidth >= 72 && boxHeight >= 24 && (
              <span className="pointer-events-none absolute left-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-white">
                {pixel.width} × {pixel.height}
              </span>
            )}
            {handles.map((name) => (
              <div
                key={name}
                data-crop-handle={name}
                // The before pseudo-element quietly enlarges the clickable area; the handle itself stays a small visual dot.
                className="absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full border border-black/30 bg-white shadow before:absolute before:-inset-2 before:content-['']"
                style={{
                  left: HANDLE_LAYOUT[name].left,
                  top: HANDLE_LAYOUT[name].top,
                  cursor: disabled ? "not-allowed" : HANDLE_LAYOUT[name].cursor,
                }}
                onPointerDown={(event) => beginDrag(event, name)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

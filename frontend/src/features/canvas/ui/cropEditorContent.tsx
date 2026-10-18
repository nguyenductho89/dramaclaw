// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
} from 'react';
import { Check, ChevronDown, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  cropImageInPlace,
  CROP_ASPECT_OPTIONS,
  isFullFrameCrop,
  maxCenteredCropRect,
  resolveCropAspectRatio,
  type CropAspectOption,
  type CropRect,
} from '@/features/canvas/application/imageCrop';

import { CANVAS_NODE_TOOLBAR_PILL_CLASS } from './nodeFrameStyles';

/**
 * The **shell-agnostic** content layer of the "Crop" editor: state machine + crop frame + that control bar.
 *
 * The reason for extracting it is the same as rotateEditorContent: the same interaction has to be mountable on two shells (the workflow's
 * NodeToolbar / the storyboard detail's full-screen dialog portaled to body). Currently only the storyboard uses it, but the crop
 * frame's coordinate conversion and ratio-lock logic should not live inside the dialog shell.
 *
 * Coordinate system: the crop frame {@link CropRect} is always stored in **source image natural pixels**, and placed by percentage onto the display box when rendering.
 * Because the image is object-contain, the display box is strictly proportional to the natural size, so percentages work on both sides - hence
 * layout size changes (window resize) need no recomputation of the rect, and only pointer displacement is converted back to natural pixels by the scale.
 */

export type CropHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

/** Minimum edge length of the crop frame (natural pixels), preventing it from being dragged into a line or even 0 width. */
const MIN_CROP_PX = 24;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Compute the new crop frame from a handle drag (locking `ratio`, coordinates all in natural pixels).
 *
 * Rules: the opposite edge of the dragged one stays fixed (dragging the right edge locks the left), and pure top/bottom or left/right handles keep the other axis centered;
 * corner handles take displacement in both directions at once, using the mean of the widths derived from the two, so diagonal dragging follows the hand.
 */
export function resizeCropRect(
  start: CropRect,
  natural: { width: number; height: number },
  handle: CropHandle,
  dx: number,
  dy: number,
  ratio: number,
): CropRect {
  const west = handle.includes('w');
  const east = handle.includes('e');
  const north = handle.startsWith('n');
  const south = handle.startsWith('s');

  let width = start.width + (east ? dx : west ? -dx : 0);
  let height = start.height + (south ? dy : north ? -dy : 0);

  if (east || west) {
    // Corner handle: the width is the mean of "the width dragged horizontally" and "the width converted from the height dragged vertically".
    width = north || south ? (width + height * ratio) / 2 : width;
    height = width / ratio;
  } else {
    width = height * ratio;
  }

  // The available margin in each direction: the distance from the anchored edge to the image edge; with no anchored edge (pure top/bottom or left/right handles) expansion is symmetric
  // about the center, and the margin is twice the distance to the nearest image edge.
  const centerX = start.x + start.width / 2;
  const centerY = start.y + start.height / 2;
  const maxWidth = east
    ? natural.width - start.x
    : west
      ? start.x + start.width
      : 2 * Math.min(centerX, natural.width - centerX);
  const maxHeight = south
    ? natural.height - start.y
    : north
      ? start.y + start.height
      : 2 * Math.min(centerY, natural.height - centerY);

  // First close by height and then by width (both only shrink, and never push the other back).
  if (height > maxHeight) {
    height = maxHeight;
    width = height * ratio;
  }
  if (width > maxWidth) {
    width = maxWidth;
    height = width / ratio;
  }

  const minWidth = Math.max(MIN_CROP_PX, MIN_CROP_PX * ratio);
  if (width < minWidth) {
    width = Math.min(minWidth, maxWidth);
    height = width / ratio;
  }

  const x = west ? start.x + start.width - width : east ? start.x : centerX - width / 2;
  const y = north ? start.y + start.height - height : south ? start.y : centerY - height / 2;

  return {
    x: clamp(x, 0, Math.max(0, natural.width - width)),
    y: clamp(y, 0, Math.max(0, natural.height - height)),
    width,
    height,
  };
}

export interface CropEditorController {
  aspect: CropAspectOption;
  /** The crop frame (natural pixels); null while the image has not loaded yet. */
  rect: CropRect | null;
  /** The natural size of the source image; null when not loaded. */
  natural: { width: number; height: number } | null;
  isSaving: boolean;
  onAspectChange: (next: CropAspectOption) => void;
  /** On image onLoad, hand in the natural size and fill the crop frame to the whole image along the way. */
  onImageLoad: (image: HTMLImageElement) => void;
  setRect: (next: CropRect) => void;
  onExit: () => void;
  onSave: () => void;
}

export interface UseCropEditorOptions {
  /** The target node the crop is written back to (the "crop result" node pre-built by the caller before entering the editor). */
  nodeId: string;
  imageSource: string;
  /**
   * Close the editor. `committed` indicates whether a crop was really committed (write-back to the node has started):
   *   - `false`: exit / Esc / the crop frame is still the whole image - the caller should delete the pre-built "crop result"
   *     node, avoiding a node appearing from nowhere.
   *   - `true`: the crop result has started being written back to that node, and the caller keeps it.
   */
  onClose: (committed: boolean) => void;
  /** After the submit takes off, hand the completion to the host to attach the busy state and failure feedback (same as useRotateEditor). */
  onCommitted?: (completion: Promise<void>) => void;
}

export function useCropEditor({
  nodeId,
  imageSource,
  onClose,
  onCommitted,
}: UseCropEditorOptions): CropEditorController {
  const [aspect, setAspect] = useState<CropAspectOption>('original');
  const [natural, setNatural] = useState<{ width: number; height: number } | null>(null);
  const [rect, setRect] = useState<CropRect | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const onImageLoad = useCallback(
    (image: HTMLImageElement) => {
      const size = { width: image.naturalWidth, height: image.naturalHeight };
      if (!(size.width > 0 && size.height > 0)) return;
      setNatural(size);
      const ratio = resolveCropAspectRatio(aspect, size);
      setRect(ratio ? maxCenteredCropRect(size, ratio) : null);
    },
    [aspect],
  );

  // Changing the ratio = reset the crop frame to the largest centered rectangle at that ratio (same as liblib: the previous frame is not kept).
  const onAspectChange = useCallback(
    (next: CropAspectOption) => {
      setAspect(next);
      if (!natural) return;
      const ratio = resolveCropAspectRatio(next, natural);
      if (ratio) setRect(maxCenteredCropRect(natural, ratio));
    },
    [natural],
  );

  const onExit = useCallback(() => onClose(false), [onClose]);

  const onSave = useCallback(() => {
    if (isSaving) return;
    // No selection (the image has not loaded) or the crop frame is the whole image -> nothing to crop, close as "not committed",
    // so the caller reclaims the pre-built node (equivalent to exit).
    if (!rect || !natural || isFullFrameCrop(rect, natural)) {
      onClose(false);
      return;
    }

    const completion = cropImageInPlace(nodeId, imageSource, rect);
    // Return null when project is missing: do not change the editing state, keeping the crop frame the user framed.
    if (!completion) return;

    setIsSaving(true);
    onCommitted?.(completion);
    onClose(true);
    void completion.finally(() => setIsSaving(false));
  }, [imageSource, isSaving, natural, nodeId, onClose, onCommitted, rect]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving) {
        onClose(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSaving, onClose]);

  return {
    aspect,
    rect,
    natural,
    isSaving,
    onAspectChange,
    onImageLoad,
    setRect,
    onExit,
    onSave,
  };
}

interface DragState {
  mode: 'move' | CropHandle;
  startX: number;
  startY: number;
  /** Scale from display pixels to natural pixels. */
  scale: number;
  startRect: CropRect;
  ratio: number;
}

const HANDLE_STYLE: Record<CropHandle, { position: string; shape: string; cursor: string }> = {
  nw: { position: '-left-px -top-px', shape: 'h-4 w-4 rounded-tl-[3px] border-l-2 border-t-2', cursor: 'nwse-resize' },
  ne: { position: '-right-px -top-px', shape: 'h-4 w-4 rounded-tr-[3px] border-r-2 border-t-2', cursor: 'nesw-resize' },
  sw: { position: '-bottom-px -left-px', shape: 'h-4 w-4 rounded-bl-[3px] border-b-2 border-l-2', cursor: 'nesw-resize' },
  se: { position: '-bottom-px -right-px', shape: 'h-4 w-4 rounded-br-[3px] border-b-2 border-r-2', cursor: 'nwse-resize' },
  n: { position: '-top-px left-1/2 -translate-x-1/2', shape: 'h-[3px] w-6 rounded-full bg-white', cursor: 'ns-resize' },
  s: { position: '-bottom-px left-1/2 -translate-x-1/2', shape: 'h-[3px] w-6 rounded-full bg-white', cursor: 'ns-resize' },
  w: { position: '-left-px top-1/2 -translate-y-1/2', shape: 'h-6 w-[3px] rounded-full bg-white', cursor: 'ew-resize' },
  e: { position: '-right-px top-1/2 -translate-y-1/2', shape: 'h-6 w-[3px] rounded-full bg-white', cursor: 'ew-resize' },
};

const CROP_HANDLES = Object.keys(HANDLE_STYLE) as CropHandle[];

/**
 * The framing UI: original image + dimming outside the frame + rule-of-thirds lines + eight handles, the whole block draggable.
 *
 * The root node being `inline-block` is deliberate - it must **shrink to the image's actually rendered size** so the crop frame can be placed
 * directly by percentage; swapping in a full-width block box, the blank left by object-contain would throw the percentages off.
 *
 * @param className size constraints added on the image (the shell decides how large the image is, e.g. `max-h-[78vh]`).
 */
export function CropEditorSurface({
  controller,
  imageSource,
  className,
}: {
  controller: CropEditorController;
  imageSource: string;
  className?: string;
}): ReactElement {
  const hostRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const { natural, rect, setRect } = controller;

  const beginDrag = useCallback(
    (event: ReactPointerEvent, mode: 'move' | CropHandle) => {
      if (!rect || !natural || controller.isSaving) return;
      const box = hostRef.current?.getBoundingClientRect();
      if (!box || box.width <= 0) return;
      event.preventDefault();
      event.stopPropagation();
      dragRef.current = {
        mode,
        startX: event.clientX,
        startY: event.clientY,
        scale: natural.width / box.width,
        startRect: rect,
        ratio: rect.width / rect.height,
      };
      // jsdom has no pointer capture; its absence does not affect the logic, only dragging outside the element would break - hence an optional call.
      (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    },
    [controller.isSaving, natural, rect],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !natural) return;
      const dx = (event.clientX - drag.startX) * drag.scale;
      const dy = (event.clientY - drag.startY) * drag.scale;

      if (drag.mode === 'move') {
        setRect({
          ...drag.startRect,
          x: clamp(drag.startRect.x + dx, 0, natural.width - drag.startRect.width),
          y: clamp(drag.startRect.y + dy, 0, natural.height - drag.startRect.height),
        });
        return;
      }
      setRect(resizeCropRect(drag.startRect, natural, drag.mode, dx, dy, drag.ratio));
    },
    [natural, setRect],
  );

  const endDrag = useCallback(() => {
    dragRef.current = null;
  }, []);

  const frameStyle: CSSProperties | null =
    rect && natural
      ? {
          left: `${(rect.x / natural.width) * 100}%`,
          top: `${(rect.y / natural.height) * 100}%`,
          width: `${(rect.width / natural.width) * 100}%`,
          height: `${(rect.height / natural.height) * 100}%`,
        }
      : null;

  return (
    <div
      ref={hostRef}
      className="relative inline-block select-none"
      onClick={(event) => event.stopPropagation()}
    >
      <img
        src={imageSource}
        alt=""
        draggable={false}
        onLoad={(event) => controller.onImageLoad(event.currentTarget)}
        className={`block object-contain ${className ?? ''}`}
      />

      {frameStyle && (
        <>
          {/* Dimming outside the frame: one oversized-spread box-shadow fills it all, and the outer overflow-hidden
          crops it back to the image bounds - outside the image is the dialog's own mask, and no extra layer should be stacked. */}
          <div className="pointer-events-none absolute inset-0 overflow-hidden">
            <div
              className="absolute"
              style={{ ...frameStyle, boxShadow: '0 0 0 9999px rgba(0,0,0,0.55)' }}
            />
          </div>

          {/* The interaction layer is separate from the dimming layer: the dimming layer must be clipped into the image, while the handles hugging the image edge must not be clipped. */}
          <div className="absolute inset-0" onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
            <div
              className="absolute cursor-move touch-none border border-white/90"
              style={frameStyle}
              onPointerDown={(event) => beginDrag(event, 'move')}
            >
              {/* Rule-of-thirds lines (composition reference, not part of hit-testing). */}
              <span className="pointer-events-none absolute inset-y-0 left-1/3 w-px bg-white/25" aria-hidden />
              <span className="pointer-events-none absolute inset-y-0 left-2/3 w-px bg-white/25" aria-hidden />
              <span className="pointer-events-none absolute inset-x-0 top-1/3 h-px bg-white/25" aria-hidden />
              <span className="pointer-events-none absolute inset-x-0 top-2/3 h-px bg-white/25" aria-hidden />

              {CROP_HANDLES.map((handle) => {
                const meta = HANDLE_STYLE[handle];
                return (
                  <span
                    key={handle}
                    data-crop-handle={handle}
                    className={`absolute touch-none border-white ${meta.position} ${meta.shape}`}
                    style={{ cursor: meta.cursor }}
                    onPointerDown={(event) => beginDrag(event, handle)}
                  />
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** Ratio mini-icon: draws an outlined rectangle by ratio so the dropdown shows landscape or portrait at a glance. */
function AspectIcon({ ratio }: { ratio: number | null }): ReactElement {
  const safe = ratio && Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  const width = safe >= 1 ? 13 : 13 * safe;
  const height = safe >= 1 ? 13 / safe : 13;
  return (
    <span className="flex h-4 w-4 shrink-0 items-center justify-center" aria-hidden>
      <span className="rounded-[2px] border border-current" style={{ width, height }} />
    </span>
  );
}

/** Ratio dropdown: original ratio / 1:1 / 4:3 / 3:4 / 16:9 / 9:16 (order aligned with liblib). */
function AspectPicker({ controller }: { controller: CropEditorController }): ReactElement {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [isOpen]);

  const natural = controller.natural ?? { width: 1, height: 1 };
  const label = (option: CropAspectOption): string =>
    option === 'original' ? t('cropEditor.aspectOriginal') : option;

  return (
    <div className="relative shrink-0">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        disabled={controller.isSaving}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={t('cropEditor.aspectLabel')}
        className="inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 text-xs text-text-dark transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
      >
        <AspectIcon ratio={resolveCropAspectRatio(controller.aspect, natural)} />
        {label(controller.aspect)}
        <ChevronDown className="h-3 w-3 text-text-muted" />
      </button>

      {isOpen && (
        <div
          ref={popoverRef}
          role="listbox"
          aria-label={t('cropEditor.aspectLabel')}
          className="absolute left-0 top-full z-50 mt-2 w-[150px] rounded-xl border border-white/10 bg-surface-dark/95 p-1 shadow-2xl backdrop-blur-md"
        >
          {CROP_ASPECT_OPTIONS.map((option) => {
            const isActive = controller.aspect === option;
            return (
              <button
                key={option}
                type="button"
                role="option"
                aria-selected={isActive}
                onClick={() => {
                  controller.onAspectChange(option);
                  setIsOpen(false);
                }}
                className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors ${
                  isActive ? 'bg-white/[0.12] text-white' : 'text-text-dark hover:bg-white/[0.06]'
                }`}
              >
                <AspectIcon ratio={resolveCropAspectRatio(option, natural)} />
                <span className="flex-1 text-left">{label(option)}</span>
                {isActive && <Check className="h-3 w-3" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Control bar: exit · ratio selection · confirm (matches the capsule floating above the crop frame in liblib).
 *
 * @param showTitle whether to show the "Crop" title to the right of the exit button, same semantics as RotateEditorToolbar.
 */
export function CropEditorToolbar({
  controller,
  showTitle = false,
}: {
  controller: CropEditorController;
  showTitle?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { isSaving } = controller;

  return (
    <div
      className={`flex w-max items-center gap-1 whitespace-nowrap ${CANVAS_NODE_TOOLBAR_PILL_CLASS}`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-dark/70 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-50"
        onClick={controller.onExit}
        title={t('cropEditor.exit')}
        aria-label={t('cropEditor.exit')}
        disabled={isSaving}
      >
        <X className="h-4 w-4" />
      </button>

      {showTitle && (
        <>
          <span className="shrink-0 px-1.5 text-xs font-medium text-text-dark">
            {t('cropEditor.title')}
          </span>
          <span className="mx-0.5 h-5 w-px shrink-0 bg-white/10" aria-hidden />
        </>
      )}

      <AspectPicker controller={controller} />

      <button
        type="button"
        onClick={controller.onSave}
        disabled={isSaving}
        className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-3 text-xs font-medium text-bg-dark transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        title={t('cropEditor.confirm')}
      >
        {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
        {isSaving ? t('cropEditor.saving') : t('cropEditor.confirm')}
      </button>
    </div>
  );
}

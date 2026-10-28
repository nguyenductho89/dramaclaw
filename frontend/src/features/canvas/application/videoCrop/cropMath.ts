// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Geometry for video cropping. The box always uses floating-point coordinates in "source video display pixels"; only when handing it to the encoder or
// the display-size label do we take even whole pixels (H.264 requires even width and height).

export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Same shape as mediabunny's CropRectangle, so it can be passed straight to Conversion. */
export interface CropPixelRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface DisplayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const CROP_RATIO_PRESETS = ["free", "original", "1:1", "9:16", "16:9", "4:3", "3:4"] as const;
export type CropRatioId = (typeof CROP_RATIO_PRESETS)[number];

export type CropHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export const CROP_ALL_HANDLES: readonly CropHandle[] = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];
export const CROP_CORNER_HANDLES: readonly CropHandle[] = ["nw", "ne", "se", "sw"];

export const CROP_MIN_SIZE = 64;
/** Floating-point error guard: 576 computed as 575.9999999 must not be floored to 574. */
const EVEN_EPSILON = 1e-6;

/** When max < min (e.g. the source edge is smaller than the minimum drag size) fall back to returning min, never producing negative coordinates. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/** Width / height; "free" returns null, meaning the ratio is not locked. */
export function resolveCropRatio(id: CropRatioId, sourceWidth: number, sourceHeight: number): number | null {
  if (id === "free") return null;
  if (id === "original") return sourceHeight > 0 ? sourceWidth / sourceHeight : null;
  const [width, height] = id.split(":").map(Number);
  return width / height;
}

/** The actual rectangle of the picture inside the container under object-contain (container pixels). */
export function containRect(
  containerWidth: number,
  containerHeight: number,
  sourceWidth: number,
  sourceHeight: number,
): DisplayRect {
  if (containerWidth <= 0 || containerHeight <= 0 || sourceWidth <= 0 || sourceHeight <= 0) {
    return { left: 0, top: 0, width: 0, height: 0 };
  }
  const scale = Math.min(containerWidth / sourceWidth, containerHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  return { left: (containerWidth - width) / 2, top: (containerHeight - height) / 2, width, height };
}

/**
 * Original ratio, 80% of width and height, centered. Uses ×4/5 rather than ×0.8 so integer source sizes compute exactly.
 * When the source edge is smaller than the minimum drag size (CROP_MIN_SIZE), 80% would be smaller than min(CROP_MIN_SIZE, source),
 * making the initial box smaller than the free-drag lower bound and going out of bounds on the first handle drag; max is used as a guard to lift it to the drag lower bound.
 */
export function initialCropBox(sourceWidth: number, sourceHeight: number): CropBox {
  const width = Math.max((sourceWidth * 4) / 5, Math.min(CROP_MIN_SIZE, sourceWidth));
  const height = Math.max((sourceHeight * 4) / 5, Math.min(CROP_MIN_SIZE, sourceHeight));
  return { x: (sourceWidth - width) / 2, y: (sourceHeight - height) / 2, width, height };
}

/** Centered on the current box, take the largest ratio box that fits in the picture, then push the whole box back inside the picture. */
export function fitRatioBox(box: CropBox, ratio: number, sourceWidth: number, sourceHeight: number): CropBox {
  const width = Math.min(sourceWidth, sourceHeight * ratio);
  const height = width / ratio;
  const centerX = box.x + box.width / 2;
  const centerY = box.y + box.height / 2;
  return {
    x: clamp(centerX - width / 2, 0, sourceWidth - width),
    y: clamp(centerY - height / 2, 0, sourceHeight - height),
    width,
    height,
  };
}

export function moveCropBox(
  box: CropBox,
  dx: number,
  dy: number,
  sourceWidth: number,
  sourceHeight: number,
): CropBox {
  return {
    ...box,
    x: clamp(box.x + dx, 0, Math.max(0, sourceWidth - box.width)),
    y: clamp(box.y + dy, 0, Math.max(0, sourceHeight - box.height)),
  };
}

/**
 * Drag a handle. `start` is the box at the moment of press, `dx/dy` is the cumulative displacement (source pixels) from press to now,
 * so multiple pointermove events don't accumulate error.
 */
export function dragCropHandle(
  start: CropBox,
  handle: CropHandle,
  dx: number,
  dy: number,
  ratio: number | null,
  sourceWidth: number,
  sourceHeight: number,
): CropBox {
  const minWidth = Math.min(CROP_MIN_SIZE, sourceWidth);
  const minHeight = Math.min(CROP_MIN_SIZE, sourceHeight);
  const movesWest = handle.includes("w");
  const movesEast = handle.includes("e");
  const movesNorth = handle.includes("n");
  const movesSouth = handle.includes("s");

  if (ratio === null) {
    let left = start.x;
    let right = start.x + start.width;
    let top = start.y;
    let bottom = start.y + start.height;
    if (movesWest) left = clamp(left + dx, 0, right - minWidth);
    if (movesEast) right = clamp(right + dx, left + minWidth, sourceWidth);
    if (movesNorth) top = clamp(top + dy, 0, bottom - minHeight);
    if (movesSouth) bottom = clamp(bottom + dy, top + minHeight, sourceHeight);
    return { x: left, y: top, width: right - left, height: bottom - top };
  }

  // Locked ratio only exposes the four corners; edge-midpoint handles aren't rendered in the UI, and if one is passed in anyway, return the box unchanged.
  if (!(movesWest || movesEast) || !(movesNorth || movesSouth)) return start;

  const anchorX = movesEast ? start.x : start.x + start.width;
  const anchorY = movesSouth ? start.y : start.y + start.height;
  const widthByX = start.width + (movesEast ? dx : -dx);
  const widthByY = (start.height + (movesSouth ? dy : -dy)) * ratio;
  // Follow whichever axis changed more in relative terms, so diagonal drags don't jitter.
  const followX = Math.abs(dx) / start.width >= Math.abs(dy) / start.height;
  const maxWidth = Math.min(
    movesEast ? sourceWidth - anchorX : anchorX,
    (movesSouth ? sourceHeight - anchorY : anchorY) * ratio,
  );
  const minLockedWidth = Math.min(Math.max(minWidth, minHeight * ratio), maxWidth);
  const width = clamp(followX ? widthByX : widthByY, minLockedWidth, maxWidth);
  const height = width / ratio;
  return {
    x: movesEast ? anchorX : anchorX - width,
    y: movesSouth ? anchorY : anchorY - height,
    width,
    height,
  };
}

/** For the encoder and size label: round width and height down to even, round the origin, and clamp inside the picture. */
export function toEvenSourceRect(box: CropBox, sourceWidth: number, sourceHeight: number): CropPixelRect {
  const width = Math.max(2, Math.floor(Math.min(box.width, sourceWidth) / 2 + EVEN_EPSILON) * 2);
  const height = Math.max(2, Math.floor(Math.min(box.height, sourceHeight) / 2 + EVEN_EPSILON) * 2);
  return {
    left: clamp(Math.round(box.x), 0, Math.max(0, sourceWidth - width)),
    top: clamp(Math.round(box.y), 0, Math.max(0, sourceHeight - height)),
    width,
    height,
  };
}

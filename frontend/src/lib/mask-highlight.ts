// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Mask export (for vision models): source image + semi-transparent red highlight on painted areas.
// The backend uses it as the edit reference for Image 2 - red only marks the region, and the model does not draw red into the result.
// The old approach was "white background + transparent holes": the edit region lived only in the alpha channel, and in the model's RGB it was all plain white -> localization failed.
//
// EraseOverlay / RedrawOverlay / MaskEditor, the three mask producers, share this so the export format is consistent,
// and the backend only maintains a single contract (red highlight).

/** The fixed color painted areas are normalized to: uniform semi-transparent red rgba(255,0,0,0.6). 0.6 x 255 ~ 153. */
export const MASK_HIGHLIGHT_RGBA = { r: 255, g: 0, b: 0, a: 153 } as const;

/**
 * Pixels below this alpha count as "unpainted". Kept consistent with the hasMask check (> 8 = painted).
 * The brush itself draws at alpha ~140 (0.55) and the anti-aliased edge ramps up from 0; here the whole stroke footprint counts as painted.
 */
export const MASK_ALPHA_THRESHOLD = 8;

/**
 * Binarizes a straight-alpha RGBA buffer in place: painted areas -> uniform semi-transparent red, everything else -> fully transparent.
 *
 * Why binarization is required: the brush draws at alpha 0.55, and at segment joints/overlaps alpha climbs to ~0.80,
 * so the mask channel itself is uneven. If `source-in` were applied directly with rgba(255,0,0,0.6), Porter-Duff
 * "in" would make the output alpha = 0.6 x mask_alpha (0.33 single stroke / 0.48 overlap), preserving the unevenness.
 * Flatten the mask alpha to 0/1 first, then write the fixed red, to get a truly uniform highlight.
 *
 * Pure function (does not touch canvas), easy to unit test.
 */
export function binarizeMaskToRed(
  data: Uint8ClampedArray,
  alphaThreshold: number = MASK_ALPHA_THRESHOLD,
): void {
  const { r, g, b, a } = MASK_HIGHLIGHT_RGBA;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] > alphaThreshold) {
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = a;
    } else {
      data[i + 3] = 0;
    }
  }
}

/**
 * Composites a red-highlight mask PNG from the source image + mask canvas.
 *
 * @param baseImage The loaded source image (HTMLImageElement or a canvas with the source image already drawn)
 * @param maskCanvas The mask canvas painted by the user (painted areas are semi-transparent red; its size is the output size)
 */
export async function buildRedHighlightMaskBlob(
  baseImage: CanvasImageSource,
  maskCanvas: HTMLCanvasElement,
): Promise<Blob> {
  const w = maskCanvas.width;
  const h = maskCanvas.height;
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const ctx = out.getContext('2d');
  if (!ctx) throw new Error('ctx');
  // 1) Source image as the base - gives the vision model real RGB content.
  ctx.drawImage(baseImage, 0, 0, w, h);
  // 2) Binarize the painted areas into uniform semi-transparent red and overlay them on the source image.
  //    getImageData is only called on the mask canvas (locally drawn, never tainted); the source image still goes through drawImage/toBlob,
  //    so CORS behavior is the same as the old code.
  const overlay = document.createElement('canvas');
  overlay.width = w;
  overlay.height = h;
  const octx = overlay.getContext('2d');
  if (!octx) throw new Error('ctx');
  octx.drawImage(maskCanvas, 0, 0);
  const img = octx.getImageData(0, 0, w, h);
  binarizeMaskToRed(img.data);
  octx.putImageData(img, 0, 0);
  ctx.drawImage(overlay, 0, 0);
  return await new Promise<Blob>((resolve, reject) => {
    out.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('toBlob returned null'))),
      'image/png',
    );
  });
}

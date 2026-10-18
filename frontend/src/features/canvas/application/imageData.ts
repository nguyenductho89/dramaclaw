// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// This uses the default i18next instance (the one `@/i18n` initializes). `@/i18n` itself is not imported,
// because that module also pulls in react-i18next / HttpBackend, and putting it on this widely imported low-level chain
// would make every test that mocks react-i18next blow up at import time.
import i18n from 'i18next';
import {
  MEDIA_VARIANT_MAX_EDGE,
  pickMediaVariant,
  withMediaVariant,
} from '@/lib/media-url';

export function parseAspectRatio(value: string): number {
  const [width, height] = value.split(':').map((item) => Number(item));
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 1;
  }

  return width / height;
}

// From a set of candidate ratios ("w:h" strings), pick the numerically closest to targetRatio. Uses the log
// distance of the ratio, so landscape/portrait are symmetric (2.33 and its reciprocal 0.43 are equally far from 1). Falls back to '1:1' when there are no candidates.
export function pickClosestAspectRatio(
  targetRatio: number,
  supportedAspectRatios: string[],
): string {
  const supported = supportedAspectRatios.length > 0 ? supportedAspectRatios : ['1:1'];
  let bestValue = supported[0];
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const aspectRatio of supported) {
    const ratio = parseAspectRatio(aspectRatio);
    const distance = Math.abs(Math.log(ratio / targetRatio));
    if (distance < bestDistance) {
      bestDistance = distance;
      bestValue = aspectRatio;
    }
  }

  return bestValue;
}

// Aspect ratios the backend accepts for generation. The canvas may carry raw
// pixel-derived ratios (e.g. "43:24" from `reduceAspectRatio`) or "auto"; every
// generation request must snap to one of these before sending. Image and video
// pipelines accept different sets.
export const IMAGE_GENERATION_ASPECT_RATIOS = [
  '1:1',
  '9:16',
  '16:9',
  '3:4',
  '4:3',
  '3:2',
  '2:3',
  '4:5',
  '5:4',
  // The backend FREEZONE_PRESET_IMAGE_ASPECT_RATIOS supports 21:9, and the node dropdown offers it too;
  // if missing here, snap at submit time would wrongly snap the user's chosen 21:9 to the nearest 16:9 (issue #52).
  '21:9',
] as const;

export const VIDEO_GENERATION_ASPECT_RATIOS = [
  '16:9',
  '4:3',
  '1:1',
  '3:4',
  '9:16',
  '21:9',
] as const;

// Snap any ratio string (incl. raw pixel ratios) to the numerically closest
// allowed value. Non-ratio inputs ("auto" / "" / garbage) resolve to `fallback`.
export function snapToAllowedAspectRatio(
  value: string,
  allowed: readonly string[],
  fallback: string,
): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed.includes(':')) return fallback;
  const candidates = allowed.length > 0 ? [...allowed] : [fallback];
  return pickClosestAspectRatio(parseAspectRatio(trimmed), candidates);
}

export function reduceAspectRatio(width: number, height: number): string {
  if (width <= 0 || height <= 0) {
    return '1:1';
  }

  const gcd = greatestCommonDivisor(Math.round(width), Math.round(height));
  return `${Math.round(width / gcd)}:${Math.round(height / gcd)}`;
}

function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(a);
  let y = Math.abs(b);

  while (y !== 0) {
    const temp = y;
    y = x % y;
    x = temp;
  }

  return x || 1;
}

const DEFAULT_PREVIEW_MAX_DIMENSION = 512;
const LOCAL_PATH_PREFIX_PATTERN = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

export interface PreparedNodeImage {
  imageUrl: string;
  previewImageUrl: string;
  aspectRatio: string;
}

interface ErrorWithDetails extends Error {
  details?: string;
}

function stringifyUnknown(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value instanceof Error) {
    return value.message;
  }
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function createImagePipelineError(message: string, details?: string, cause?: unknown): ErrorWithDetails {
  const error: ErrorWithDetails = new Error(message);
  const detailParts: string[] = [];
  if (details) {
    detailParts.push(details);
  }
  if (cause !== undefined) {
    detailParts.push(`cause: ${stringifyUnknown(cause)}`);
  }
  if (detailParts.length > 0) {
    error.details = detailParts.join('\n');
  }
  return error;
}

const ORIGINAL_IMAGE_ZOOM_THRESHOLD = 1.45;

export function shouldUseOriginalImageByZoom(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom >= ORIGINAL_IMAGE_ZOOM_THRESHOLD;
}

export function isLikelyLocalImagePath(imageUrl: string): boolean {
  if (!imageUrl) {
    return false;
  }

  const lower = imageUrl.toLowerCase();
  if (
    lower.startsWith('data:') ||
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('blob:') ||
    lower.startsWith('asset:') ||
    lower.startsWith('file://')
  ) {
    return false;
  }

  return LOCAL_PATH_PREFIX_PATTERN.test(imageUrl);
}

export function resolveImageDisplayUrl(imageUrl: string): string {
  return imageUrl;
}

// Determine whether a string is a real image source that can be rendered as <img src> (a protocol URL or a local image path).
// The script table's "character image/reference" is a backend placeholder string field, and models often fill in non-URL text such as `none`,
// which would 404 into a broken image if put straight into <img>; filter with this before rendering.
export function isRenderableImageSrc(value: string): boolean {
  if (!value) {
    return false;
  }
  const lower = value.toLowerCase();
  if (
    lower.startsWith('data:') ||
    lower.startsWith('http://') ||
    lower.startsWith('https://') ||
    lower.startsWith('blob:') ||
    lower.startsWith('asset:') ||
    lower.startsWith('file://')
  ) {
    return true;
  }
  return isLikelyLocalImagePath(value);
}

// Media drawn to a <canvas> that gets exported (toBlob / toDataURL) must be
// fetched with CORS, otherwise the canvas taints and export throws. This
// includes relative `/projects/.../media/*` paths: in production the backend
// 302-redirects them to a presigned OSS URL (see _serve_or_redirect_to_oss),
// so a no-cors load ends up cross-origin and taints anyway — that only
// surfaced online, never against the dev vite proxy which streams the bytes
// same-origin. CORS mode is harmless for true same-origin responses (no
// Access-Control-Allow-Origin required) and the OSS bucket allows the site
// origin. Only data:/blob: skip it — they can never taint a canvas.
// Shared by the <img> loader and the offscreen <video> frame-capture paths.
export function mediaNeedsCrossOrigin(url: string): boolean {
  const lower = url.toLowerCase();
  return !lower.startsWith('data:') && !lower.startsWith('blob:');
}

// Cache-busting convention:
// - `v` is a backend-authored content version and must be treated as authoritative.
// - `st_v` is a frontend fallback for newly-written same-path assets with no `v`.
// Do not stack both; changing `st_v` defeats the cache stability promised by `v`.
export function withImageCacheBust(imageUrl: string, token: string | number | null | undefined): string {
  if (!imageUrl || token === null || token === undefined) return imageUrl;
  const trimmed = imageUrl.trim();
  if (
    !trimmed ||
    trimmed.startsWith('data:') ||
    trimmed.startsWith('blob:') ||
    trimmed.startsWith('asset:')
  ) {
    return imageUrl;
  }
  const [base, hash = ''] = trimmed.split('#', 2);
  const [path, query = ''] = base.split('?', 2);
  const params = new URLSearchParams(query);
  params.delete('st_v');
  if (params.has('v')) {
    const versioned = params.toString();
    const stable = versioned ? `${path}?${versioned}` : path;
    return hash ? `${stable}#${hash}` : stable;
  }
  params.set('st_v', String(token));
  const busted = `${path}?${params.toString()}`;
  return hash ? `${busted}#${hash}` : busted;
}

// -- Node body image: feed a downsampled copy -------------------------------------------
//
// The cost of decode + raster depends only on the source image's pixel count, not on the size of the box it is drawn into: a 5504x3072
// PNG drawn into a 580px node still pays 16.9MP. At zoom 0.35 (just above the LOD
// shell threshold) a screen can hold dozens of such nodes - the same problem as the 9 images in the history strip,
// just an order of magnitude larger.
//
// The trouble is that the node body's onLoad is also the canvas's "measurement" of this image: it feeds the resolution badge and writes
// imageNaturalWidth/Height + aspectRatio into node data. Reading these from a downsampled copy
// would write wrong sizes into the node. So the variant is used only when the real size is already recorded in node data - by then
// the element has nothing new to teach us, and the caller reads from the record instead (see nodeBodyImageMeasurement).
// Nodes of unknown size load the original, measure and persist as before, and the next mount naturally uses the variant.
//
// The frontend only requests the 320px thumb that production warms. Compute the device pixels this slot needs from displayEdge x zoom x devicePixelRatio;
// if the thumb cannot cover it, return the original image, avoiding blur from upscaling.
//
// zoom is used but jitter is not a worry: pickMediaVariant's output is only thumb and null, and the node subscribes to this
// quantized result rather than zoom itself, switching src only when crossing the 320px threshold.
//
// The fullscreen viewer / download / export / all kinds of editors still always get the original; see the viewerSourceUrl at each
// call site.
export const NODE_BODY_VARIANT_MAX_EDGE = MEDIA_VARIANT_MAX_EDGE.thumb;

/**
 * How many device pixels (long edge) this slot of the node body image needs.
 *
 * CSS pixels are not the answer: a 320px copy filling a 315 CSS px box is sharp on a 1x screen, but on a 2x screen has
 * only half the needed resolution. Likewise zoom - the same node scaled to 0.4 takes only 40% of the screen width.
 */
export function nodeBodyRequiredEdge(
  display: { width: number; height: number },
  zoom: number,
  devicePixelRatio: number,
): number {
  const edge = Math.max(display.width, display.height);
  const scale = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const dpr =
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  return Math.ceil(edge * scale * dpr);
}

export type ImagePixelSize = { width: number; height: number };

export type NodeBodyImage = {
  /** The address fed to <img src>. */
  src: string;
  /** The original image address without a variant attached; compare against it when judging "this image no longer trusts the record". */
  original: string;
  /** true means src is a downsampled copy, and naturalWidth/Height on the element cannot be trusted. */
  downscaled: boolean;
  /** The long-edge budget of the copy; null when the original is fed. Use it when checking the element's size. */
  maxEdge: number | null;
};

/** Read the recorded original pixel size from node data; returns null when absent or invalid. */
export function readNodeNaturalSize(data: unknown): ImagePixelSize | null {
  if (!data || typeof data !== 'object') return null;
  const { imageNaturalWidth: w, imageNaturalHeight: h } = data as {
    imageNaturalWidth?: unknown;
    imageNaturalHeight?: unknown;
  };
  return typeof w === 'number' && typeof h === 'number' && w > 0 && h > 0
    ? { width: w, height: h }
    : null;
}

export function nodeBodyImageSrc(
  url: string,
  natural: ImagePixelSize | null,
  options?: { preferOriginal?: boolean; requiredEdge?: number },
): NodeBodyImage {
  const asOriginal: NodeBodyImage = { src: url, original: url, downscaled: false, maxEdge: null };
  // Zoomed in to the detailed-view tier: hand back the original.
  if (options?.preferOriginal) return asOriginal;
  // Size unknown: this load still carries the measurement duty, so it must be the original.
  if (!natural) return asOriginal;
  // The pixels needed for this slot exceed the top of the ladder: giving a copy would be blurry when enlarged, so hand back the original.
  const variant = pickMediaVariant(options?.requiredEdge ?? NODE_BODY_VARIANT_MAX_EDGE);
  if (variant === null) return asOriginal;
  const maxEdge = MEDIA_VARIANT_MAX_EDGE[variant];
  // It is no larger than the variant anyway: swapping to the variant would just re-encode once, an extra file for nothing.
  if (Math.max(natural.width, natural.height) <= maxEdge) return asOriginal;
  // Variants only apply to protected project static images; when not applicable it is returned as is (blob:/data: upload previews,
  // legacy paths and non-image suffixes all land here), and downscaled is false accordingly.
  const src = withMediaVariant(url, variant);
  return src === url ? asOriginal : { src, original: url, downscaled: true, maxEdge };
}

/**
 * Whether the size in the record describes the image that is loaded right now.
 *
 * The record is not bound to any URL, while a node's image can be swapped: album main image selection, restore from history,
 * generation completion backfill - these paths all change only imageUrl/previewImageUrl and leave
 * imageNaturalWidth/Height untouched. For nodes whose real size was manually adjusted there is not even a chance to correct it
 * (the isSizeManuallyAdjusted branch in onLoad returns early). So "has a record" does not
 * mean "the record describes this image", and it must be checked on the spot.
 *
 * The way to check is to compute the record by the variant's rule and see whether the element reports that result: the backend thumbnail pins
 * the long edge exactly to the budget, and the short edge is rounded proportionally (Pillow's rounding, +-1px). A mismatch means
 * the record describes another image.
 *
 * The converse does not hold, and this must be made clear: a match only shows the ratio matches. The copy's long edge is pinned to the
 * budget, and the information about how large the original was is lost in downsampling, so thumb copies of 5504x3072 and 2752x1536
 * are both 320x179, and an old record compared against them passes just the same. So the line for image swaps cannot rely on
 * this alone - each node distrusts the record the moment the main image address changes (see distrustRecord),
 * and this is only a fallback:
 * it covers old data that was already skewed at mount time, in which case there is no "previous image" to compare.
 */
export function nodeBodyRecordDescribesImage(
  image: { naturalWidth: number; naturalHeight: number },
  natural: ImagePixelSize | null,
  maxEdge: number,
): boolean {
  if (!natural) return false;
  const { naturalWidth: w, naturalHeight: h } = image;
  if (!(w > 0) || !(h > 0)) return false;
  // Both width and height differ, no need to compute further.
  if (w >= h !== natural.width >= natural.height) return false;
  const long = Math.max(w, h);
  const short = Math.min(w, h);
  const recLong = Math.max(natural.width, natural.height);
  const recShort = Math.min(natural.width, natural.height);
  // The backend refused this downsampling (render failed, or the source was already within the budget) and gave the original directly.
  if (long === recLong && short === recShort) return true;
  if (long !== maxEdge) return false;
  return Math.abs(short - Math.round((long * recShort) / recLong)) <= 1;
}

/**
 * Which set of sizes this onLoad should measure by.
 *
 * When a downsampled copy is fed the element is lying, so use the real size from the record - then the later ratio computation,
 * auto sizing and badge are all byte-for-byte identical to feeding the original, rather than "skipping measurement".
 *
 * But only do so when the record really describes this image; on a mismatch the element, while also not the original, at least came from this
 * image, which is more credible than a record belonging to another image. Callers should first judge with
 * nodeBodyRecordDescribesImage, and on a mismatch fall back to the original and re-measure (see each node's
 * onLoad), where the truth can be obtained.
 */
export function nodeBodyImageMeasurement(
  image: { naturalWidth: number; naturalHeight: number },
  body: NodeBodyImage,
  natural: ImagePixelSize | null,
): ImagePixelSize {
  if (
    body.downscaled
    && natural
    && nodeBodyRecordDescribesImage(image, natural, body.maxEdge ?? 0)
  ) {
    return natural;
  }
  return { width: image.naturalWidth, height: image.naturalHeight };
}

export type NaturalSizeRecordWrite = {
  /** Whether to write the size measured this round back to node data. */
  persist: boolean;
  /** Whether this write-back should enter the undo stack. */
  recordHistory: boolean;
  /** Whether to also change the node size to fit this image. */
  applySize: boolean;
};

/**
 * After onLoad finishes measuring, whether this time to persist and whether it counts as a user-undoable change.
 *
 * The three cases that need a write are entirely different in nature:
 * 1. The ratio changed / the display size does not match - the node would visibly deform on screen, a change the user can see,
 *    and entering the undo stack is natural.
 * 2. The record was empty to begin with - in old projects the node's ratio was long computed correctly and its size already fitted, so the two conditions above
 *    are forever false, and imageNaturalWidth/Height can never be written; and
 *    without a record nodeBodyImageSrc can only feed the original, so this node never enjoys downsampled copies.
 *    Adding this write changes not a single pixel on screen.
 * 3. The record does not match the truth - swapping to another image of the same ratio (5504x3072 -> 2752x1536) leaves the ratio and
 *    display size unchanged, so relying on case 1 alone the correction can never land. It likewise changes nothing on screen.
 *
 * The latter two only record facts the canvas already knew, and are not edits. If put in the undo stack, merely opening
 * an old project would pile dozens of "forget image size" entries and clear the redo stack - so
 * recordHistory is true only in case 1.
 *
 * Cases 2 and 3 both converge by themselves: once written the record matches the truth, and next time the same judgment is false directly.
 *
 * sizeLockedByUser means "the user manually dragged the size". It only turns off applySize, not record correction:
 * preserving the display size the user dragged and recording the real pixel size correctly are two unrelated things.
 *
 * measuringRecordSubject is for nodes like ImageNode that "feed a different URL at the zoom-in tier":
 * in that round the size on the element belongs to another image (rotate/relight/multi-angle results are all written in previewImageUrl,
 * which need not have the same size as imageUrl), and using it to correct the record swaps one wrong for another.
 */
export function planNaturalSizeRecordWrite(input: {
  aspectRatioChanged: boolean;
  displaySizeMismatch: boolean;
  record: ImagePixelSize | null;
  measured: ImagePixelSize;
  measuringRecordSubject: boolean;
  sizeLockedByUser: boolean;
}): NaturalSizeRecordWrite {
  const recordIsWrong =
    input.measuringRecordSubject
    && (input.record === null
      || input.record.width !== input.measured.width
      || input.record.height !== input.measured.height);
  // The user dragged the size: the on-screen size belongs to them, the record belongs to the facts. These two were originally tied together, so
  // "do not auto-change the size" skipped "correcting the record" too - after an image swap the badge was still right that time via component-local
  // state, but a remount read the old record and the variant was also picked by the old size.
  if (input.sizeLockedByUser) {
    return { persist: recordIsWrong, recordHistory: false, applySize: false };
  }
  if (input.aspectRatioChanged || input.displaySizeMismatch) {
    return { persist: true, recordHistory: true, applySize: true };
  }
  return { persist: recordIsWrong, recordHistory: false, applySize: false };
}

export async function persistImageLocally(source: string): Promise<string> {
  return source;
}

export async function loadImageElement(source: string): Promise<HTMLImageElement> {
  const image = new Image();
  const displaySource = resolveImageDisplayUrl(source);
  if (mediaNeedsCrossOrigin(displaySource)) {
    image.crossOrigin = 'anonymous';
  }

  return await new Promise((resolve, reject) => {
    image.onload = () => resolve(image);
    image.onerror = () =>
      reject(
        createImagePipelineError(i18n.t('canvas.imagePipeline.loadFailed'), `source=${source}\ndisplaySource=${displaySource}`)
      );
    image.src = displaySource;
  });
}

export async function imageUrlToDataUrl(imageUrl: string): Promise<string> {
  if (imageUrl.startsWith('data:')) {
    return imageUrl;
  }

  if (isLikelyLocalImagePath(imageUrl)) {
    const localResponse = await fetch(resolveImageDisplayUrl(imageUrl));
    if (!localResponse.ok) {
      throw createImagePipelineError(
        i18n.t('canvas.imagePipeline.localReadFailed'),
        `source=${imageUrl}\nstatus=${localResponse.status}`
      );
    }
    const localBlob = await localResponse.blob();
    return await blobToDataUrl(localBlob);
  }

  const response = await fetch(imageUrl);
  if (!response.ok) {
    throw createImagePipelineError(i18n.t('canvas.imagePipeline.downloadFailed'), `url=${imageUrl}\nstatus=${response.status}`);
  }

  const blob = await response.blob();
  return await blobToDataUrl(blob);
}

export async function blobToDataUrl(blob: Blob): Promise<string> {
  const reader = new FileReader();

  return await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(i18n.t('canvas.imagePipeline.convertFailed')));
    reader.readAsDataURL(blob);
  });
}

export function extractBase64Payload(dataUrl: string): string {
  const [, payload = ''] = dataUrl.split(',');
  return payload;
}

export function dataUrlToBlob(dataUrl: string): Blob {
  const [header = '', payload = ''] = dataUrl.split(',');
  const mimeMatch = header.match(/data:([^;]+)/);
  const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
  const isBase64 = /;base64/i.test(header);
  if (!isBase64) {
    return new Blob([decodeURIComponent(payload)], { type: mime });
  }
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: mime });
}

export async function readFileAsDataUrl(file: File): Promise<string> {
  const reader = new FileReader();

  return await new Promise((resolve, reject) => {
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error(i18n.t('canvas.imagePipeline.fileReadFailed')));
    reader.readAsDataURL(file);
  });
}

export async function prepareNodeImageFromFile(
  file: File,
  maxPreviewDimension = DEFAULT_PREVIEW_MAX_DIMENSION
): Promise<PreparedNodeImage> {
  const started = performance.now();
  const dataUrlStarted = performance.now();
  const source = await readFileAsDataUrl(file);
  const dataUrlElapsed = Math.round(performance.now() - dataUrlStarted);
  const prepared = await prepareNodeImage(source, maxPreviewDimension);
  console.info(
    `[upload-perf][imageData] prepareNodeImageFromFile dataurl-fallback name="${file.name}" size=${file.size}B readDataUrl=${dataUrlElapsed}ms total=${Math.round(performance.now() - started)}ms`
  );
  return prepared;
}

export async function detectAspectRatio(imageUrl: string): Promise<string> {
  const image = await loadImageElement(imageUrl);
  return reduceAspectRatio(image.naturalWidth, image.naturalHeight);
}

export function canvasToDataUrl(canvas: HTMLCanvasElement): string {
  return canvas.toDataURL('image/png');
}

function resolvePreviewMimeType(imageUrl: string): string {
  if (imageUrl.startsWith('data:image/png')) {
    return 'image/png';
  }
  if (imageUrl.startsWith('data:image/webp')) {
    return 'image/webp';
  }
  return 'image/jpeg';
}

function renderPreviewDataUrl(
  image: HTMLImageElement,
  sourceDataUrl: string,
  maxDimension: number
): string {
  const longestSide = Math.max(image.naturalWidth, image.naturalHeight);
  if (longestSide <= maxDimension) {
    return sourceDataUrl;
  }

  const scale = maxDimension / longestSide;
  const targetWidth = Math.max(1, Math.round(image.naturalWidth * scale));
  const targetHeight = Math.max(1, Math.round(image.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    return sourceDataUrl;
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, targetWidth, targetHeight);

  const mimeType = resolvePreviewMimeType(sourceDataUrl);
  if (mimeType === 'image/jpeg') {
    return canvas.toDataURL(mimeType, 0.86);
  }
  return canvas.toDataURL(mimeType);
}

export async function createPreviewDataUrl(
  imageUrl: string,
  maxDimension = DEFAULT_PREVIEW_MAX_DIMENSION
): Promise<string> {
  const normalizedDataUrl = await imageUrlToDataUrl(imageUrl);
  const image = await loadImageElement(normalizedDataUrl);
  const safeMaxDimension = Math.max(64, Math.floor(maxDimension));
  return renderPreviewDataUrl(image, normalizedDataUrl, safeMaxDimension);
}

export async function prepareNodeImage(
  imageUrl: string,
  maxPreviewDimension = DEFAULT_PREVIEW_MAX_DIMENSION
): Promise<PreparedNodeImage> {
  const trimmedImageUrl = imageUrl.trim();
  if (!trimmedImageUrl) {
    throw createImagePipelineError(i18n.t('canvas.imagePipeline.emptyResult'), 'imageUrl is empty');
  }

  const started = performance.now();

  try {
    const persistedImagePath = await persistImageLocally(trimmedImageUrl);
    const normalizedDataUrl = await imageUrlToDataUrl(persistedImagePath);
    const image = await loadImageElement(normalizedDataUrl);
    const safeMaxDimension = Math.max(64, Math.floor(maxPreviewDimension));
    const previewDataUrl = renderPreviewDataUrl(image, normalizedDataUrl, safeMaxDimension);
    const previewImagePath =
      previewDataUrl === normalizedDataUrl
        ? persistedImagePath
        : await persistImageLocally(previewDataUrl);

    console.info(
      `[upload-perf][imageData] prepareNodeImage browser-fallback total=${Math.round(performance.now() - started)}ms`
    );
    return {
      imageUrl: persistedImagePath,
      previewImageUrl: previewImagePath,
      aspectRatio: reduceAspectRatio(image.naturalWidth, image.naturalHeight),
    };
  } catch (error) {
    throw createImagePipelineError(
      i18n.t('canvas.imagePipeline.unparsableResult'),
      `source=${trimmedImageUrl}`,
      error
    );
  }
}

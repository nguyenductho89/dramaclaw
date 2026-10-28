// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from 'i18next';

import {
  CANVAS_NODE_TYPES,
  type CanvasNodeData,
  type CanvasNodeType,
  type ExportImageNodeResultKind,
} from './canvasNodes';

/**
 * A node's default name has two identities: first, the initial value of `data.displayName` in the canvas JSON (written to disk when the node is
 * created, see nodeRegistry.createDefaultData); second, the title shown in the UI. The former is data
 * and must not change with the language, otherwise the same canvas would save different contents under Chinese vs. English; the latter is what should be translated.
 *
 * So the table below stays unchanged as the "canonical defaults", with a separate key table alongside; at render time use
 * localizeNodeDisplayName: the default name of the current type (including the auto number) is shown in the current language,
 * while a user-defined name is kept as is, even if it happens to equal another node type's default name.
 */
// i18n-exempt-start: canonical defaults, written into the canvas JSON; for display use NODE_DISPLAY_NAME_KEYS
export const DEFAULT_NODE_DISPLAY_NAME: Record<CanvasNodeType, string> = {
  vectorSvgNode: 'Vector · SVG',
  animatedGifNode: 'Animated · GIF',
  [CANVAS_NODE_TYPES.htmlArtifact]: 'Web page',
  [CANVAS_NODE_TYPES.upload]: 'Upload',
  [CANVAS_NODE_TYPES.imageEdit]: 'AI Image',
  [CANVAS_NODE_TYPES.imageGen]: 'Image node',
  [CANVAS_NODE_TYPES.exportImage]: 'Result image',
  [CANVAS_NODE_TYPES.beatContext]: 'Shot context',
  [CANVAS_NODE_TYPES.textAnnotation]: 'Text',
  [CANVAS_NODE_TYPES.group]: 'Group',
  [CANVAS_NODE_TYPES.storyboardSplit]: 'Cell extraction result',
  [CANVAS_NODE_TYPES.storyboardGen]: 'Multi-version grid',
  [CANVAS_NODE_TYPES.video]: 'Video',
  [CANVAS_NODE_TYPES.audio]: 'Audio',
  [CANVAS_NODE_TYPES.videoStory]: 'Video story',
  [CANVAS_NODE_TYPES.videoBreakdown]: 'Frame-by-frame breakdown',
  [CANVAS_NODE_TYPES.videoCompose]: 'Video compose',
  [CANVAS_NODE_TYPES.script]: 'Script generator',
  [CANVAS_NODE_TYPES.pano360Viewer]: '360° Panorama viewer',
  [CANVAS_NODE_TYPES.threeDWorld]: '3D World',
  [CANVAS_NODE_TYPES.skill]: 'Skill',
  [CANVAS_NODE_TYPES.style]: 'Style',
};

// i18n-exempt: same as above, written into the canvas JSON; for display use EXPORT_RESULT_DISPLAY_NAME_KEYS
export const EXPORT_RESULT_DISPLAY_NAME: Record<ExportImageNodeResultKind, string> = {
  generic: 'Result image',
  storyboardGenOutput: 'Grid output',
  storyboardSplitExport: 'Cell export',
  storyboardFrameEdit: 'Single-cell result',
  matte: 'Matte result',
  upscale: 'Upscale',
};
// i18n-exempt-end

const NODE_DISPLAY_NAME_KEYS: Record<CanvasNodeType, string> = Object.fromEntries(
  Object.values(CANVAS_NODE_TYPES).map((type) => [type, `node.displayName.${type}`]),
) as Record<CanvasNodeType, string>;

const EXPORT_RESULT_DISPLAY_NAME_KEYS: Record<ExportImageNodeResultKind, string> =
  Object.fromEntries(
    Object.keys(EXPORT_RESULT_DISPLAY_NAME).map((kind) => [kind, `node.exportResult.${kind}`]),
  ) as Record<ExportImageNodeResultKind, string>;

function resolveExportResultKind(data: Partial<CanvasNodeData>): ExportImageNodeResultKind {
  return (data as { resultKind?: ExportImageNodeResultKind }).resultKind ?? 'generic';
}

function resolveExportResultDefault(data: Partial<CanvasNodeData>): string {
  return EXPORT_RESULT_DISPLAY_NAME[resolveExportResultKind(data)];
}

/**
 * Auto sequence number for unnamed nodes: written into data.autoTitleIndex at creation and appended to the default name
 * ("Text 1", "Text 2", "Image node 1" ...), avoiding same-type nodes with the same name being indistinguishable.
 *
 * Deliberately not writing the number into displayName - displayName means "the title the user chose",
 * and isNodeUsingDefaultDisplayName / UploadNode's auto rename both depend on that.
 */
export function getDefaultNodeDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): string {
  const base =
    type === CANVAS_NODE_TYPES.exportImage
      ? resolveExportResultDefault(data)
      : DEFAULT_NODE_DISPLAY_NAME[type];
  const index = (data as { autoTitleIndex?: unknown }).autoTitleIndex;
  return typeof index === 'number' && Number.isFinite(index) && index > 0
    ? `${base}${index}`
    : base;
}

/**
 * The next available auto sequence number (within nodes of the same type).
 *
 * Takes the larger of "max used number" and "count of same-type nodes" plus 1:
 * - max used + 1 guarantees no duplicate with existing nodes (deleting a middle node will not collide);
 * - the same-type count is a fallback for old canvases - historical nodes have no autoTitleIndex, and starting straight from 1 would mix with the
 *   unnumbered default names they display; raising the starting point by the count avoids that.
 */
export function nextAutoTitleIndex(
  type: CanvasNodeType,
  nodes: ReadonlyArray<{ type?: string | null; data?: unknown }>,
): number {
  let maxIndex = 0;
  let sameTypeCount = 0;
  for (const node of nodes) {
    if (node.type !== type) continue;
    sameTypeCount += 1;
    const raw = (node.data as { autoTitleIndex?: unknown } | undefined)?.autoTitleIndex;
    if (typeof raw === 'number' && Number.isFinite(raw) && raw > maxIndex) {
      maxIndex = raw;
    }
  }
  return Math.max(maxIndex, sameTypeCount) + 1;
}

/** The display version of the default name, following the UI language. */
export function localizeDefaultNodeDisplayName(
  type: CanvasNodeType,
  data: Partial<CanvasNodeData>,
  t: TFunction,
): string {
  if (type === CANVAS_NODE_TYPES.exportImage) {
    return t(EXPORT_RESULT_DISPLAY_NAME_KEYS[resolveExportResultKind(data)]);
  }
  return t(NODE_DISPLAY_NAME_KEYS[type]);
}

export function resolveNodeDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): string {
  const customTitle = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (customTitle) {
    return customTitle;
  }

  if (type === CANVAS_NODE_TYPES.group) {
    const legacyLabel = typeof (data as { label?: string }).label === 'string'
      ? (data as { label?: string }).label?.trim()
      : '';
    if (legacyLabel) {
      return legacyLabel;
    }
  }

  return getDefaultNodeDisplayName(type, data);
}

/**
 * Add an auto sequence number to a new node "without a custom title", and write the title as the numbered default name.
 *
 * Both fields must be written:
 * - `displayName`: each node definition's createDefaultData() already prefills the default name into displayName,
 *   and writing only autoTitleIndex would not change the rendering, so the title must be overwritten with the numbered default name too;
 * - `autoTitleIndex`: makes getDefaultNodeDisplayName also compute the same numbered default name,
 *   so isNodeUsingDefaultDisplayName still judges it as "using the default name" (UploadNode's
 *   auto rename depends on this), and once the user edits the title the number naturally stops showing.
 *
 * If the caller already supplied displayName (the various result nodes such as "Matte", "Upscale") -> return as is, no number issued.
 */
export function withAutoTitleIndex<T extends Partial<CanvasNodeData>>(
  type: CanvasNodeType,
  data: T,
  existingNodes: ReadonlyArray<{ type?: string | null; data?: unknown }>,
): T {
  const explicitTitle = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (explicitTitle) return data;
  const autoTitleIndex = nextAutoTitleIndex(type, existingNodes);
  const withIndex = { ...data, autoTitleIndex };
  return { ...withIndex, displayName: getDefaultNodeDisplayName(type, withIndex) };
}

/** For rendering: if the user never renamed it, show it in the current language; if renamed, show as is. */
export function localizeNodeDisplayName(
  type: CanvasNodeType,
  data: Partial<CanvasNodeData>,
  t: TFunction,
): string {
  const name = resolveNodeDisplayName(type, data);
  if (name === getDefaultNodeDisplayName(type, data)) {
    const index = data.autoTitleIndex;
    const suffix = typeof index === 'number' && Number.isFinite(index) && index > 0
      ? String(index)
      : '';
    return `${localizeDefaultNodeDisplayName(type, data, t)}${suffix}`;
  }
  const defaultBase = type === CANVAS_NODE_TYPES.exportImage
    ? resolveExportResultDefault(data)
    : DEFAULT_NODE_DISPLAY_NAME[type];
  return name === defaultBase
    ? localizeDefaultNodeDisplayName(type, data, t)
    : name;
}

export function isNodeUsingDefaultDisplayName(type: CanvasNodeType, data: Partial<CanvasNodeData>): boolean {
  const customTitle = typeof data.displayName === 'string' ? data.displayName.trim() : '';
  if (!customTitle) {
    return true;
  }
  return customTitle === getDefaultNodeDisplayName(type, data);
}

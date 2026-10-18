// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type {CanvasNode} from '@/features/canvas/domain/canvasNodes';
import {extractUpstreamContent} from '@/features/canvas/application/graphContentResolver';

export const HTML_REFERENCE_PREFIXES = ['text', 'image', 'video', 'audio'] as const; // i18n-exempt -- canonical @mention protocol tokens
export interface HtmlReference {
  nodeId: string;
  name: string;
  prefix: typeof HTML_REFERENCE_PREFIXES[number];
  mention: string;
  index: number;
  text?: string;
  url?: string;
  width?: number;
  height?: number;
  aspectRatio?: string;
  durationMs?: number;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.round(left);
  let b = Math.round(right);
  while (b > 0) [a, b] = [b, a % b];
  return a || 1;
}

function mediaAspectRatio(
  width: number | undefined,
  height: number | undefined,
  stored: unknown,
): string | undefined {
  if (width && height) {
    const divisor = greatestCommonDivisor(width, height);
    return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
  }
  return typeof stored === 'string' && stored.trim() ? stored.trim() : undefined;
}

/** Shared by the editor and generation request; URLs here are canonical, not display URLs. */
export function buildHtmlReferences(nodes: CanvasNode[]): HtmlReference[] {
  const counts = new Map<string, number>();
  const seen = new Set<string>();
  return nodes.flatMap(node => {
    if (seen.has(node.id)) return [];
    seen.add(node.id);
    const content = extractUpstreamContent(node);
    const data = node.data as Record<string, unknown>;
    const videoUrl = node.type === 'videoComposeNode' ? data.videoUrl as string | undefined : content.videoUrl;
    const prefix = node.type === 'textAnnotationNode' || node.type === 'scriptNode' ? 'text' // i18n-exempt -- canonical @mention protocol token
      : node.type === 'audioNode' ? 'audio' // i18n-exempt -- canonical @mention protocol token
      : videoUrl || node.type === 'videoNode' || node.type === 'videoComposeNode' ? 'video' // i18n-exempt -- canonical @mention protocol token
      : content.imageUrl || ['imageGenNode','imageNode','uploadNode','exportImageNode','storyboardGenNode'].includes(node.type) ? 'image' : null; // i18n-exempt -- canonical @mention protocol token
    if (!prefix) return [];
    const index = (counts.get(prefix) ?? 0) + 1;
    counts.set(prefix, index);
    const imageUrl = node.type === 'imageGenNode' ? data.imageUrl as string | undefined : content.imageUrl;
    const width = positiveNumber(prefix === 'video' ? data.widthPx : data.imageNaturalWidth); // i18n-exempt -- canonical @mention protocol token
    const height = positiveNumber(prefix === 'video' ? data.heightPx : data.imageNaturalHeight); // i18n-exempt -- canonical @mention protocol token
    return [{nodeId: node.id, name: content.displayName || `${prefix}${index}`, prefix, index,
      mention: `${prefix}${index}`, text: content.text,
      url: prefix === 'video' ? videoUrl : prefix === 'audio' ? content.audioUrl : prefix === 'image' ? imageUrl : undefined, // i18n-exempt -- canonical @mention protocol tokens
      width,
      height,
      aspectRatio: prefix === 'image' || prefix === 'video' // i18n-exempt -- canonical @mention protocol tokens
        ? mediaAspectRatio(width, height, data.aspectRatio)
        : undefined,
      durationMs: prefix === 'video' ? positiveNumber(data.durationMs) : undefined, // i18n-exempt -- canonical @mention protocol token
    }];
  });
}

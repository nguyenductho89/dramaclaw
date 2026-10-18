// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useStore } from '@xyflow/react';

import { nodeBodyRequiredEdge } from '@/features/canvas/application/imageData';
import { MEDIA_VARIANT_MAX_EDGE, pickMediaVariant, type MediaVariant } from '@/lib/media-url';
import { useDevicePixelRatio } from '@/lib/useDevicePixelRatio';

/**
 * How large a long-edge budget this node's body image should use to pick a copy.
 *
 * What is returned is not the raw value of "how many pixels are needed", but the 320px thumb or Infinity; when the thumb
 * cannot cover it, nodeBodyImageSrc hands back the original image.
 *
 * The reason to quantize before returning: the raw value changes every frame with zoom, while nodes subscribe to the result of this selector.
 * After quantizing there are only two values, so re-rendering and switching src happen only when zoom crosses the 320px threshold. This
 * line is the very one where nodes subscribe only to a boolean to avoid "re-rendering every frame while panning", and the same
 * technique is followed.
 */
export function useNodeBodyVariant(display: {
  width: number;
  height: number;
}): MediaVariant | null {
  const devicePixelRatio = useDevicePixelRatio();
  return useStore((state) =>
    pickMediaVariant(nodeBodyRequiredEdge(display, state.transform[2], devicePixelRatio)),
  );
}

export function useNodeBodyVariantBudget(display: {
  width: number;
  height: number;
}): number {
  const variant = useNodeBodyVariant(display);
  return variant === null ? Number.POSITIVE_INFINITY : MEDIA_VARIANT_MAX_EDGE[variant];
}

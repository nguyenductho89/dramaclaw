// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useState } from 'react';
import { ImageOff } from 'lucide-react';

import { resolveStyleAssetUrl } from '@/features/canvas/nodes/styleAssetUrl';

export interface StyleAssetImageProps {
  /** The relative path in the manifest; resolveStyleAssetUrl decides whether it lands locally or on OSS. */
  rel: string;
  assetBase: string;
  alt: string;
  className?: string;
  loading?: 'lazy' | 'eager';
  draggable?: boolean;
}

/**
 * Style cover/example image.
 *
 * The prompt manifest and the images can be replaced in generations separately (the manifest goes through STYLE_GALLERY_MANIFEST, the images through
 * STYLE_GALLERY_ASSET_BASE), and when the two do not match the image will 404 - here a placeholder block is the fallback,
 * so the image wall is not littered with the browser's default broken-image icons.
 */
export function StyleAssetImage({
  rel,
  assetBase,
  alt,
  className = '',
  loading,
  draggable,
}: StyleAssetImageProps) {
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = resolveStyleAssetUrl(rel, assetBase);

  // Compare the address rather than store a boolean: switching the manifest/prefix automatically retries once.
  if (!src || failedSrc === src) {
    return (
      <div
        role="img"
        aria-label={alt}
        className={`flex min-h-10 items-center justify-center bg-white/[0.06] text-text-muted ${className}`}
      >
        <ImageOff className="size-4" />
      </div>
    );
  }

  return (
    <img
      src={src}
      alt={alt}
      loading={loading}
      draggable={draggable}
      onError={() => setFailedSrc(src)}
      className={className}
    />
  );
}

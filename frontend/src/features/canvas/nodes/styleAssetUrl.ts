// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * The single resolution point for style image URLs.
 *
 * Images are not shipped with the repo: once the backend configures STYLE_GALLERY_ASSET_BASE (OSS/CDN domain), the API
 * hands out the prefix and it is concatenated here. When assetBase is empty it falls back to same-origin /style-gallery/ — that
 * directory is empty by default, so StyleAssetImage shows a placeholder block.
 */
export function resolveStyleAssetUrl(rel: string, assetBase: string): string {
  if (!rel) return '';
  if (!assetBase) return `/style-gallery/${rel}`;
  return `${assetBase.replace(/\/+$/, '')}/${rel}`;
}

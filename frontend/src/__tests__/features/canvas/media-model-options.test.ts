// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

import { describe, expect, it } from 'vitest';

import {
  formatResolutionLabel,
  resolveModelAspectOptions,
  resolveModelSizeOptions,
} from '@/features/canvas/domain/mediaModelOptions';

describe('media model common option normalization', () => {
  it('converges the legacy adaptive ratio into the single auto option', () => {
    expect(
      resolveModelAspectOptions({ ratioOptions: ['adaptive', 'Auto', '16:9'] }),
    ).toEqual(['auto', '16:9']);
  });

  it('keeps the resolution tier order configured in the backend', () => {
    expect(resolveModelSizeOptions({ resolutionOptions: ['720p', '1080p'] })).toEqual([
      '720p',
      '1080p',
    ]);
  });

  it('resolution is lower-cased only at the display layer', () => {
    expect(formatResolutionLabel('4K')).toBe('4k');
    expect(formatResolutionLabel('1080P')).toBe('1080p');
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it } from 'vitest';

import {
  FREEZONE_VIEW_MODE_KEY,
  readStoredViewMode,
  writeStoredViewMode,
} from '@/features/freezone/useFreezoneViewMode';

describe('freezone view mode persistence', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('returns workflow by default', () => {
    expect(readStoredViewMode()).toBe('workflow');
  });

  it('reads back after writing board; the same for workflow', () => {
    writeStoredViewMode('board');
    expect(window.localStorage.getItem(FREEZONE_VIEW_MODE_KEY)).toBe('board');
    expect(readStoredViewMode()).toBe('board');
    writeStoredViewMode('workflow');
    expect(readStoredViewMode()).toBe('workflow');
  });

  it('falls back to workflow when localStorage holds a dirty value', () => {
    window.localStorage.setItem(FREEZONE_VIEW_MODE_KEY, 'banana');
    expect(readStoredViewMode()).toBe('workflow');
  });
});

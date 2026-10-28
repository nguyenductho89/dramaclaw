// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { H3TemplatePickerChip } from '@/features/canvas/nodes/H3TemplatePickerChip';

function renderChip(overrides: { prompt?: string; connectedImageCount?: number } = {}) {
  const onApply = vi.fn();
  render(
    <H3TemplatePickerChip
      prompt={overrides.prompt ?? ''}
      connectedImageCount={overrides.connectedImageCount ?? 0}
      onApply={onApply}
    />,
  );
  return onApply;
}

async function openPicker() {
  await userEvent.click(screen.getByRole('button', { name: /H3 templates/i }));
}

describe('H3TemplatePickerChip', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies the selected template with run=false for "Create nodes"', async () => {
    const onApply = renderChip();
    await openPicker();
    await userEvent.click(screen.getByRole('button', { name: 'Create nodes' }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toMatchObject({ source: 'fal' });
    expect(onApply.mock.calls[0][1]).toEqual({ run: false });
  });

  it('applies with run=true for "Create & run"', async () => {
    const onApply = renderChip();
    await openPicker();
    await userEvent.click(screen.getByRole('button', { name: 'Create & run' }));
    expect(onApply.mock.calls[0][1]).toEqual({ run: true });
  });

  it('switches source to pixo, and disables run for audio templates', async () => {
    const onApply = renderChip();
    await openPicker();
    await userEvent.click(screen.getByRole('button', { name: 'pixo.video' }));
    await userEvent.click(screen.getByRole('button', { name: 'Audio-driven' }));
    // The first template of the category (the voice-cloned narration) is selected by default.
    expect(screen.getByRole('button', { name: 'Create & run' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create nodes' })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Create nodes' }));
    expect(onApply.mock.calls[0][0]).toMatchObject({ id: 'voice_cloned_narration' });
  });

  it('asks before adding inputs next to already connected images and respects "cancel"', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const onApply = renderChip({ connectedImageCount: 2 });
    await openPicker();
    await userEvent.click(screen.getByRole('button', { name: 'Create & run' }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });
});

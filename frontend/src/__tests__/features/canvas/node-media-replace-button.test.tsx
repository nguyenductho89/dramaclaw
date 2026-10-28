// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { NodeMediaReplaceButton } from '@/features/canvas/ui/NodeMediaReplaceButton';

/** A single click in a real browser = pointerdown → pointerup → click; the test must replay it as is. */
function realClick(button: HTMLElement, opts: { moveBy?: number } = {}) {
  fireEvent.pointerDown(button, { button: 0, clientX: 100, clientY: 100 });
  if (opts.moveBy) {
    fireEvent.pointerMove(window, {
      clientX: 100 + opts.moveBy,
      clientY: 100,
    });
  }
  fireEvent.pointerUp(window, { clientX: 100, clientY: 100 });
  fireEvent.click(button);
}

describe('NodeMediaReplaceButton', () => {
  it('clicking opens the file picker', () => {
    render(<NodeMediaReplaceButton title="Replace" onPick={vi.fn()} onCommitDragStart={vi.fn()} />);
    const button = screen.getByRole('button', { name: 'Replace' });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    realClick(button);

    expect(clickSpy).toHaveBeenCalledTimes(1);
  });

  it('a drag past the threshold is no longer treated as a click', () => {
    const onCommitDragStart = vi.fn();
    render(
      <NodeMediaReplaceButton title="Replace" onPick={vi.fn()} onCommitDragStart={onCommitDragStart} />,
    );
    const button = screen.getByRole('button', { name: 'Replace' });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');

    realClick(button, { moveBy: 40 });

    expect(onCommitDragStart).toHaveBeenCalledTimes(1);
    expect(clickSpy).not.toHaveBeenCalled();
  });
});

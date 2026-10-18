// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { ReferenceMaterialOption } from '@/features/canvas/application/referencePick';
import {
  PromptMentionEditor,
  type MentionCandidate,
} from '@/features/canvas/nodes/PromptMentionEditor';

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

const referenced: MentionCandidate[] = [
  { key: 'A', name: 'image1', imageUrl: 'https://example.com/a.png', index: 1 },
];

const materials: ReferenceMaterialOption[] = [
  { nodeId: 'N1', label: 'Scene sheet', kind: 'image', imageUrl: 'https://example.com/n1.png' },
  { nodeId: 'N2', label: 'Character sheet', kind: 'image', imageUrl: 'https://example.com/n2.png' },
  { nodeId: 'N3', label: 'Empty shot', kind: 'video', videoUrl: 'https://example.com/n3.mp4' },
];

function openReplaceMenu(container: HTMLElement) {
  const swap = container.querySelector('[data-mention-swap]');
  expect(swap).not.toBeNull();
  fireEvent.click(swap as Element);
}

describe('PromptMentionEditor — replace reference menu', () => {
  it('the replace icon on a chip opens the menu, split into "Referenced" and kind-grouped "Canvas assets"', () => {
    const { container } = render(
      <PromptMentionEditor
        value="@image1 "
        onChange={() => {}}
        candidates={referenced}
        getMaterials={() => materials}
        onAttachMaterial={() => true}
      />,
    );

    expect(screen.queryByText('Referenced')).toBeNull();
    openReplaceMenu(container);

    expect(screen.getByText('Referenced')).toBeTruthy();
    expect(screen.getByText('Canvas assets')).toBeTruthy();
    // Group rows aggregate by kind; canvas assets are not spread out directly.
    expect(screen.getByLabelText('Image assets')).toBeTruthy();
    expect(screen.getByLabelText('Video assets')).toBeTruthy();
    expect(screen.queryByText('Scene sheet')).toBeNull();
  });

  it('hovering a kind group expands the list on the right', () => {
    const { container } = render(
      <PromptMentionEditor
        value="@image1 "
        onChange={() => {}}
        candidates={referenced}
        getMaterials={() => materials}
        onAttachMaterial={() => true}
      />,
    );
    openReplaceMenu(container);

    fireEvent.mouseEnter(screen.getByLabelText('Image assets'));
    expect(screen.getByText('Scene sheet')).toBeTruthy();
    expect(screen.getByText('Character sheet')).toBeTruthy();
    // What expands is the "image" group; video assets must not be mixed in.
    expect(screen.queryByText('Empty shot')).toBeNull();
  });

  it('searching flattens into one list, filtering across referenced and canvas assets together', () => {
    const { container } = render(
      <PromptMentionEditor
        value="@image1 "
        onChange={() => {}}
        candidates={referenced}
        getMaterials={() => materials}
        onAttachMaterial={() => true}
      />,
    );
    openReplaceMenu(container);

    fireEvent.change(screen.getByPlaceholderText('Search'), { target: { value: 'Character' } });

    expect(screen.getByText('Character sheet')).toBeTruthy();
    expect(screen.queryByText('Scene sheet')).toBeNull();
    // The referenced "image" does not match "Character", so the whole section disappears.
    expect(screen.queryByText('Referenced')).toBeNull();
  });

  it('selecting a canvas asset: first ask the host to create the reference, and replace the @ only after it enters the candidates with a number', () => {
    const onAttachMaterial = vi.fn(() => true);
    const onChange = vi.fn();
    const { container, rerender } = render(
      <PromptMentionEditor
        value="@image1 "
        onChange={onChange}
        candidates={referenced}
        getMaterials={() => materials}
        onAttachMaterial={onAttachMaterial}
      />,
    );
    openReplaceMenu(container);
    fireEvent.mouseEnter(screen.getByLabelText('Image assets'));
    fireEvent.mouseDown(screen.getByText('Scene sheet').closest('button') as Element);

    expect(onAttachMaterial).toHaveBeenCalledWith('N1');
    // The edge creation has not flowed back yet, so the new reference's number is not known at this moment, and the chip stays put.
    expect(onChange).not.toHaveBeenCalled();
    expect(
      (container.querySelector('.mention-chip') as HTMLElement).dataset.mention,
    ).toBe('A');

    // The host has connected the edge, and the new reference enters the candidates as "image2".
    rerender(
      <PromptMentionEditor
        value="@image1 "
        onChange={onChange}
        candidates={[
          ...referenced,
          { key: 'N1', name: 'image2', imageUrl: 'https://example.com/n1.png', index: 2 },
        ]}
        getMaterials={() => materials.filter((item) => item.nodeId !== 'N1')}
        onAttachMaterial={onAttachMaterial}
      />,
    );

    expect(onChange).toHaveBeenCalledWith('@image2 ');
    const chips = container.querySelectorAll('.mention-chip');
    expect(chips.length).toBe(1);
    expect((chips[0] as HTMLElement).dataset.mention).toBe('N1');
  });

  it('a host without onAttachMaterial shows only "Referenced"', () => {
    const { container } = render(
      <PromptMentionEditor value="@image1 " onChange={() => {}} candidates={referenced} />,
    );
    openReplaceMenu(container);

    expect(screen.getByText('Referenced')).toBeTruthy();
    expect(screen.queryByText('Canvas assets')).toBeNull();
  });

  it('when the host rejects creating the reference no dangling replacement is left: a same-name candidate appearing later does not move the chip', () => {
    const onChange = vi.fn();
    const reject = vi.fn(() => false);
    const { container, rerender } = render(
      <PromptMentionEditor
        value="@image1 "
        onChange={onChange}
        candidates={referenced}
        getMaterials={() => materials}
        onAttachMaterial={reject}
      />,
    );
    openReplaceMenu(container);
    fireEvent.mouseEnter(screen.getByLabelText('Image assets'));
    fireEvent.mouseDown(screen.getByText('Scene sheet').closest('button') as Element);

    expect(reject).toHaveBeenCalledWith('N1');
    // The user later connects the same node via another entry — that candidate change must not come back and alter this chip.
    rerender(
      <PromptMentionEditor
        value="@image1 "
        onChange={onChange}
        candidates={[
          ...referenced,
          { key: 'N1', name: 'image2', imageUrl: 'https://example.com/n1.png', index: 2 },
        ]}
        getMaterials={() => materials}
        onAttachMaterial={reject}
      />,
    );

    expect(onChange).not.toHaveBeenCalled();
    expect(
      (container.querySelector('.mention-chip') as HTMLElement).dataset.mention,
    ).toBe('A');
  });

  it('Escape closes the replace menu (focus is on the menu\'s own search box)', () => {
    const { container } = render(
      <PromptMentionEditor
        value="@image1 "
        onChange={() => {}}
        candidates={referenced}
        getMaterials={() => materials}
        onAttachMaterial={() => true}
      />,
    );
    openReplaceMenu(container);
    expect(screen.getByText('Referenced')).toBeTruthy();

    fireEvent.keyDown(screen.getByPlaceholderText('Search'), { key: 'Escape' });

    expect(screen.queryByText('Referenced')).toBeNull();
  });
});

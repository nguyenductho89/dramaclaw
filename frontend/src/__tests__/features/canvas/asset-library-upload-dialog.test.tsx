// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AssetLibraryUploadDialog } from '@/features/canvas/ui/AssetLibraryUploadDialog';

const FOLDERS = [
  {
    key: 'other' as const,
    label: 'Uncategorized',
    items: [],
    system: true,
    uploadable: true,
  },
];

const CATEGORIES = [
  {
    key: 'other' as const,
    labelKey: 'canvas.assetLibrary.category.other',
    media: ['image' as const, 'video' as const],
  },
];

function renderDialog(onSubmit = vi.fn()) {
  render(
    <AssetLibraryUploadDialog
      open
      folders={FOLDERS}
      categories={CATEGORIES}
      onCreateFolder={vi.fn()}
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />,
  );
  return onSubmit;
}

describe('AssetLibraryUploadDialog', () => {
  beforeEach(() => {
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:preview'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: vi.fn(),
    });
  });

  it('clearly shows the drop entry and the supported formats', () => {
    renderDialog();

    expect(screen.getByText('Drop files here, or click to choose')).toBeInTheDocument();
    expect(screen.getByText(/jpg\/jpeg\/png\/webp/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload' })).toBeDisabled();
  });

  it('unsupported files do not silently disappear', () => {
    renderDialog();
    const file = new File(['notes'], 'notes.txt', { type: 'text/plain' });

    fireEvent.change(screen.getByLabelText('Choose local files'), {
      target: { files: [file] },
    });

    expect(screen.getByRole('alert')).toHaveTextContent(
      '1 file(s) in unsupported formats were ignored',
    );
  });

  it('shows the selection count and submits with explicit text after a destination is chosen', () => {
    const onSubmit = renderDialog();
    const file = new File(['image'], 'cover.png', { type: 'image/png' });

    fireEvent.change(screen.getByLabelText('Choose local files'), {
      target: { files: [file] },
    });
    expect(screen.getByTitle('cover.png')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Upload 1' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Choose a destination' }));
    fireEvent.click(screen.getByRole('button', { name: 'Uncategorized' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload 1' }));

    expect(onSubmit).toHaveBeenCalledWith(
      [{ file, media: 'image' }],
      'other',
      null,
    );
  });
});

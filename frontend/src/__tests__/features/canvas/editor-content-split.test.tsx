// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { LightEditorContent } from '@/features/canvas/ui/LightEditorContent';
import { MultiAngleEditorContent } from '@/features/canvas/ui/MultiAngleEditorContent';
import { AssetBoardMultiAngleDialog } from '@/features/canvas/ui/asset-board/AssetBoardMultiAngleDialog';
import { AssetBoardRelightDialog } from '@/features/canvas/ui/asset-board/AssetBoardRelightDialog';
import { useCanvasStore } from '@/stores/canvasStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => ({
      'assetBoard.multiAngleEditor': '多维度编辑器',
      'assetBoard.relightEditor': '打光效果编辑器',
    } as Record<string, string>)[key] ?? fallback ?? key,
  }),
}));
vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));
vi.mock('@/features/canvas/hooks/useFreezoneImageModels', () => ({
  useFreezoneImageModels: () => ({
    models: [{ id: 'huimeng/gpt-image-2', apiModel: 'gpt-image-2', label: 'GPT Image 2' }],
  }),
}));

const multiAngleImage = vi.hoisted(() => vi.fn());
const relightImage = vi.hoisted(() => vi.fn());
vi.mock('@/features/canvas/application/imageMultiAngle', () => ({ multiAngleImage }));
vi.mock('@/features/canvas/application/imageRelight', () => ({ relightImage }));

// The Radix Slider inside the panel depends on ResizeObserver, which jsdom lacks (same as
// the approach in canvas-skill-manual-connect.test.tsx, stubbed per test file).
class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

const NODE = {
  id: 'src-1',
  type: CANVAS_NODE_TYPES.upload,
  position: { x: 0, y: 0 },
  data: { imageUrl: '/static/src.png', aspectRatio: '1:1' },
} as CanvasNode;

/** The panel's round submit button has only an arrow icon, so locate it by aria-label. */
function submitButton() {
  return screen.getByRole('button', { name: 'multiAngleEditor.submit' });
}

beforeEach(() => {
  vi.clearAllMocks();
  useCanvasStore.getState().setCanvasData([NODE], []);
});

describe('editor content layer (no React Flow, shared by the workflow shell and the storyboard dialog)', () => {
  it('MultiAngleEditorContent: renders the full panel on its own without ReactFlowProvider', () => {
    // Key regression point -- if the content layer still depended on NodeToolbar/useReactFlow, this would throw
    // "Seems like you have not used zustand provider as an ancestor".
    render(
      <MultiAngleEditorContent node={NODE} imageSource="/static/src.png" onClose={vi.fn()} />,
    );
    expect(screen.getByText('multiAngleEditor.title')).toBeInTheDocument();
  });

  it('MultiAngleEditorContent: successful submit -> onSubmitted(new node id) comes before onClose', () => {
    multiAngleImage.mockReturnValue({ nodeId: 'mv-1', completion: Promise.resolve() });
    const calls: string[] = [];
    render(
      <MultiAngleEditorContent
        node={NODE}
        imageSource="/static/src.png"
        onClose={() => calls.push('close')}
        onSubmitted={(id) => calls.push(`submitted:${id}`)}
      />,
    );

    fireEvent.click(submitButton());

    expect(multiAngleImage).toHaveBeenCalledWith('src-1', '/static/src.png', expect.any(Object));
    // The order matches handleSubmit before the split: setSelectedNode first, then onClose.
    expect(calls).toEqual(['submitted:mv-1', 'close']);
  });

  it('MultiAngleEditorContent: failed submit (orchestration returns null) -> no callback and no close', () => {
    multiAngleImage.mockReturnValue(null);
    const onClose = vi.fn();
    const onSubmitted = vi.fn();
    render(
      <MultiAngleEditorContent
        node={NODE}
        imageSource="/static/src.png"
        onClose={onClose}
        onSubmitted={onSubmitted}
      />,
    );

    fireEvent.click(submitButton());

    expect(onSubmitted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('LightEditorContent: renders the full panel on its own without ReactFlowProvider', () => {
    render(<LightEditorContent node={NODE} imageSource="/static/src.png" onClose={vi.fn()} />);
    expect(screen.getByText('lightEditor.title')).toBeInTheDocument();
  });
});

describe('storyboard editor dialog shell', () => {
  it('multi-angle dialog: a centered dialog portaled to body, containing the full multi-dimension editor', () => {
    const { baseElement } = render(
      <AssetBoardMultiAngleDialog
        node={NODE}
        imageSource="/static/src.png"
        onClose={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Multi-dimension editor' });
    // portal: the dialog hangs on body rather than inside the component's own container.
    expect(dialog.parentElement).toBe(baseElement);
    expect(screen.getByText('multiAngleEditor.title')).toBeInTheDocument();
  });

  it('multi-angle dialog: clicking inside the panel does not close it; clicking the backdrop closes it and fires only once', () => {
    const onClose = vi.fn();
    render(
      <AssetBoardMultiAngleDialog
        node={NODE}
        imageSource="/static/src.png"
        onClose={onClose}
      />,
    );
    const dialog = screen.getByRole('dialog', { name: 'Multi-dimension editor' });

    fireEvent.click(screen.getByText('multiAngleEditor.title'));
    expect(onClose).not.toHaveBeenCalled();

    // The panel itself also has a capture listener for "clicking outside the panel calls onClose", which would hit together with the shell's backdrop onClick;
    // the shell dedupes per mount, so the host should receive the close only once.
    fireEvent.click(dialog);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('multi-angle dialog: Esc closes it (neither panel closes on Esc itself, so the shell supplies it)', () => {
    const onClose = vi.fn();
    render(
      <AssetBoardMultiAngleDialog
        node={NODE}
        imageSource="/static/src.png"
        onClose={onClose}
      />,
    );

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('multi-angle dialog: successful submit -> requests viewport pre-positioning (rather than selecting)', () => {
    multiAngleImage.mockReturnValue({ nodeId: 'mv-9', completion: Promise.resolve() });
    render(
      <AssetBoardMultiAngleDialog
        node={NODE}
        imageSource="/static/src.png"
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(submitButton());

    expect(useCanvasStore.getState().pendingFocusNodeId).toBe('mv-9');
  });

  it('relight dialog: a portaled centered dialog containing the full lighting editor', () => {
    render(
      <AssetBoardRelightDialog node={NODE} imageSource="/static/src.png" onClose={vi.fn()} />,
    );
    expect(screen.getByRole('dialog', { name: 'Lighting effect editor' })).toBeInTheDocument();
    expect(screen.getByText('lightEditor.title')).toBeInTheDocument();
  });
});

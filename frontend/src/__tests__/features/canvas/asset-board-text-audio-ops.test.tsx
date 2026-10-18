// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

// The waveform player in the audio detail calls the canvas 2D context; jsdom does not implement it, so return null directly
// (the player has an early-exit fallback for null), avoiding "Not implemented" noise in tests.
HTMLCanvasElement.prototype.getContext = vi.fn(
  () => null,
) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// The waveform decode fetch(src) hangs without settling: otherwise the decode only rejects after the test ends + console.warn,
// which reports onUserConsoleLog pending during environment teardown (the scrubber does not depend on the decode result and renders as usual).
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

vi.mock('@/lib/model-task-access', () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));

vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));
vi.mock('@/features/canvas/hooks/useFreezoneImageModels', () => ({
  useFreezoneImageModels: () => ({ models: [] }),
}));
vi.mock('@/features/canvas/hooks/useFreezoneVideoModels', () => ({
  useFreezoneVideoModels: () => ({ models: [{ id: 'video-model-1' }] }),
}));

// Text-side orchestration: verify "click the button -> the right input is passed down", using a never-settling promise to keep the busy state.
const applyTextNodeMode = vi.hoisted(() => vi.fn());
const runTextImageToPrompt = vi.hoisted(() => vi.fn());
const submitTextToVideo = vi.hoisted(() => vi.fn());
const reanalyzeVideoStory = vi.hoisted(() => vi.fn());

vi.mock('@/features/canvas/application/textNodeModes', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  applyTextNodeMode,
}));
vi.mock('@/features/canvas/application/textImageToPrompt', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  runTextImageToPrompt,
}));
vi.mock('@/features/canvas/application/textToVideoSubmit', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  submitTextToVideo,
}));
vi.mock('@/features/canvas/application/videoAnalyzeStory', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  reanalyzeVideoStory,
}));

function seedBoard(extra: CanvasNode[] = []) {
  const nodes: CanvasNode[] = [
    {
      id: 'txt-empty',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 0, y: 0 },
      data: { displayName: 'Empty text', content: '' },
    } as CanvasNode,
    {
      id: 'txt-written',
      type: CANVAS_NODE_TYPES.textAnnotation,
      position: { x: 0, y: 100 },
      data: { displayName: 'Written text', content: 'Old train station on a rainy night' },
    } as CanvasNode,
    {
      id: 'story-1',
      type: CANVAS_NODE_TYPES.videoStory,
      position: { x: 0, y: 200 },
      data: {
        displayName: 'Storyboard table',
        sourceVideoUrl: '/static/src.mp4',
        rows: [{ shotNumber: 1, duration: '2s', visualDescription: 'Old visual' }],
      },
    } as CanvasNode,
    ...extra,
  ];
  useCanvasStore.getState().setCanvasData(nodes, []);
}

function detailPanel() {
  return screen.getByRole('region', { name: 'Asset details' });
}

function openDetail(name: string) {
  render(<AssetBoardView visible onLocateNode={vi.fn()} />);
  fireEvent.click(screen.getAllByRole('button', { name })[0]);
}

describe('AssetBoard detail text operations (batch 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    seedBoard();
  });

  // The text detail's feature buttons (capability derivation / reverse prompt / generate video / re-parse) were removed entirely
  // -- the storyboard text detail is a read-only reading page, and these generation entries remain on the workflow-side nodes (user request).
  // Only row-table cell editing is kept, see the two cases below.

  it('storyboard row table cell: click to edit, blur writes back to the store', () => {
    openDetail('Storyboard table');

    fireEvent.click(within(detailPanel()).getByText('Old visual'));
    const input = within(detailPanel()).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'New visual' } });
    fireEvent.blur(input);

    const rows = useCanvasStore.getState().nodes.find((n) => n.id === 'story-1')?.data
      .rows as Array<Record<string, unknown>>;
    expect(rows[0].visualDescription).toBe('New visual');
    // Other columns of the same row are unaffected.
    expect(rows[0].duration).toBe('2s');
  });

  it('script row table cell: write-back lands in scriptResult.rows, and sibling fields such as title are kept', () => {
    seedBoard([
      {
        id: 'script-1',
        type: CANVAS_NODE_TYPES.script,
        position: { x: 0, y: 400 },
        data: {
          displayName: 'Storyboard script',
          scriptTitle: 'Act One',
          scriptResult: {
            title: 'Act One',
            rows: [{ shot_no: '1', duration: '3s', visual_description: 'Old description', dialogue: 'Hey' }],
          },
        },
      } as CanvasNode,
    ]);
    openDetail('Storyboard script');

    fireEvent.click(within(detailPanel()).getByText('Old description'));
    const input = within(detailPanel()).getByRole('textbox');
    fireEvent.change(input, { target: { value: 'New description' } });
    fireEvent.blur(input);

    const result = useCanvasStore.getState().nodes.find((n) => n.id === 'script-1')?.data
      .scriptResult as { title: string; rows: Array<Record<string, unknown>> };
    expect(result.title).toBe('Act One');
    expect(result.rows[0]).toMatchObject({
      shot_no: '1',
      duration: '3s',
      visual_description: 'New description',
      dialogue: 'Hey',
    });
  });
});

describe('AssetBoard audio chip / detail form', () => {
  function seedAudio(data: Record<string, unknown>) {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: 'audio-1',
          type: CANVAS_NODE_TYPES.audio,
          position: { x: 0, y: 0 },
          data: { displayName: 'Narrator', ...data },
        } as CanvasNode,
      ],
      [],
    );
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generation failed -> a red failure badge appears on the chip (carrying the full error text)', () => {
    seedAudio({ audioUrl: null, generationError: 'Voice unavailable' });
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    const badge = screen.getByLabelText('Generation failed');
    expect(badge.getAttribute('title')).toBe('Voice unavailable');
  });

  it('while generating, the failure badge is not shown (the previous red mark must not linger during a retry)', () => {
    // generationTaskKey is required: setCanvasData zeroes isGenerating when there is "no recoverable handle"
    // (to stop interrupted tasks spinning forever); without it this case would never reach the generating branch.
    seedAudio({
      audioUrl: null,
      generationError: 'Voice unavailable',
      isGenerating: true,
      generationTaskKey: 'tk-1',
    });
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    expect(screen.queryByLabelText('Generation failed')).toBeNull();
  });

  it('clicking an audio chip -> opens the detail with the TTS-tier generation form (text + tone words + voice settings)', () => {
    seedAudio({ audioUrl: null, text: 'Hello', voiceLabel: 'Narrator A' });
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Narrator' }));

    const detail = detailPanel();
    expect(within(detail).getByPlaceholderText('Enter the text to synthesize')).toBeTruthy();
    expect(within(detail).getByPlaceholderText(/tense, hushed/)).toBeTruthy();
    // The voice entry moved into an icon button in the bottom control row (mirrors liblib footer); the accessible name comes from title.
    expect(within(detail).getByRole('button', { name: /Voice settings/ })).toBeTruthy();
    // Not generated yet -> the submit button means "Generate" rather than "Regenerate" (aria-label).
    expect(within(detail).getByRole('button', { name: /^Generate$/ })).toBeTruthy();
  });

  it('empty music-tier node detail: shows advanced settings (duration / instrumental / section duration), and changes land directly in the store', () => {
    // An audio detail that already has an audioUrl shows only the player and mounts no form; testing the generation form needs an empty audio node.
    seedAudio({ audioUrl: null, audioKind: 'music', text: 'Electronic music' });
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Narrator' }));

    const detail = detailPanel();
    // Empty node -> the form is present, and the music-tier button means "Generate".
    expect(within(detail).getByRole('button', { name: /^Generate$/ })).toBeTruthy();
    // TTS-only fields do not appear in the music tier.
    expect(within(detail).queryByPlaceholderText(/tense, hushed/)).toBeNull();

    fireEvent.click(within(detail).getByRole('button', { name: 'Advanced settings' }));
    fireEvent.click(within(detail).getByRole('switch', { name: 'Force instrumental' }));

    const data = useCanvasStore.getState().nodes.find((n) => n.id === 'audio-1')?.data;
    expect(data?.forceInstrumental).toBe(false);
  });
});

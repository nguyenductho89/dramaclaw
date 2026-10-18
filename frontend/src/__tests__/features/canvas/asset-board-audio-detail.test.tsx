// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  compileFreezoneRecipePrompt,
  submitFreezoneAudioMusic,
  submitFreezoneAudioSpeech,
} from '@/api/ops';
import { CANVAS_NODE_TYPES, type CanvasNode } from '@/features/canvas/domain/canvasNodes';
import {
  __resetAssetBoardAudioOpsStateForTest,
  inFlightAudioOps,
} from '@/features/canvas/ui/asset-board/AssetBoardAudioGenForm';
import { AssetBoardView } from '@/features/canvas/ui/asset-board/AssetBoardView';
import { useCanvasStore } from '@/stores/canvasStore';

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverMock);

// The waveform player needs a canvas 2D context; jsdom does not implement it -> returns null (the player has an early-exit fallback for null).
HTMLCanvasElement.prototype.getContext = vi.fn(
  () => null,
) as unknown as typeof HTMLCanvasElement.prototype.getContext;

// After mounting, the waveform player fetches (src) to decode the waveform; in jsdom make it hang without settling -- otherwise
// the decode only rejects after the test ends and console.warn, which reports onUserConsoleLog
// pending during environment teardown. The scrubber (role=slider) does not depend on the decode result and renders as usual.
vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})));

vi.mock('@/lib/model-task-access', () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));

vi.mock('@/lib/queries/generation-credit-cost', () => ({
  useGenerationCreditCost: () => ({ data: undefined }),
}));

// Submission requires a project in the URL (otherwise useAudioGeneration.generate returns early).
vi.mock('@/lib/url-params', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/url-params')>()),
  readUrl: () => ({ project: 'demo-project', canvas: 'default' }),
}));

// A never-settling promise: keeps the generating/in-flight state after submission so the orchestration input and registry can be asserted.
const NEVER = new Promise<never>(() => {});
vi.mock('@/api/ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/api/ops')>()),
  compileFreezoneRecipePrompt: vi.fn(),
  submitFreezoneAudioSpeech: vi.fn(() => NEVER),
  submitFreezoneAudioMusic: vi.fn(() => NEVER),
}));

function seed(nodes: CanvasNode[]) {
  useCanvasStore.getState().setCanvasData(nodes, []);
}

function audioNode(data: Record<string, unknown>): CanvasNode {
  return {
    id: 'audio-1',
    type: CANVAS_NODE_TYPES.audio,
    position: { x: 0, y: 0 },
    data: { displayName: 'Background music', ...data },
  } as CanvasNode;
}

function textNode(): CanvasNode {
  return {
    id: 'txt-1',
    type: CANVAS_NODE_TYPES.textAnnotation,
    position: { x: 0, y: 100 },
    data: { displayName: 'Anchor list', content: 'Brand: Light & Shadow' },
  } as CanvasNode;
}

function detailPanel() {
  return screen.getByRole('region', { name: 'Asset details' });
}

describe('AssetBoard audio in master-detail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetAssetBoardAudioOpsStateForTest();
  });

  it('clicking an audio chip (with media) -> waveform player in the middle + editable generation form at the bottom; text column on the left, switcher in the top bar', () => {
    seed([audioNode({ audioUrl: '/static/a.mp3', text: 'Melodious tune' }), textNode()]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    // Three-column overview: the text column is present.
    expect(screen.getByText('Text')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Background music' }));

    const detail = detailPanel();
    // Middle: the large waveform player (scrubber).
    expect(within(detail).getByRole('slider', { name: 'Audio waveform scrubber' })).toBeInTheDocument();
    // Bottom: the editable generation form (the background-music node is shown with music semantics).
    expect(within(detail).getByPlaceholderText('Describe the music you want: style, instruments, rhythm, mood...')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: /Regenerate/ })).toBeInTheDocument();
    // The locate entry was removed from the detail panel entirely.
    expect(within(detail).queryByRole('button', { name: /Locate on canvas/ })).not.toBeInTheDocument();
    // Audio detail left side = text column (switcher); the audio switcher is the audio tab in the top bar, not on the left. The image/video columns disappear.
    expect(screen.getByText('Audio')).toBeInTheDocument(); // top-bar audio tab
    expect(screen.getByText('Text')).toBeInTheDocument(); // left text column switcher
    expect(screen.getByText('Anchor list')).toBeInTheDocument();
    expect(screen.queryByText('Images')).not.toBeInTheDocument();
    expect(screen.queryByText('Videos')).not.toBeInTheDocument();
  });

  it('empty audio node (no audioUrl) -> the detail shows a placeholder in the middle, with the form still mounted below (can generate from scratch)', () => {
    seed([audioNode({ audioUrl: null, text: 'Melodious tune' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'Background music' }));

    const detail = detailPanel();
    // No waveform (no src), so the empty placeholder text is used.
    expect(within(detail).queryByRole('slider', { name: 'Audio waveform scrubber' })).not.toBeInTheDocument();
    expect(within(detail).getByText('Generates after confirmation')).toBeInTheDocument();
    // The form is still there, and the button means "Generate" (never generated).
    expect(within(detail).getByPlaceholderText('Describe the music you want: style, instruments, rhythm, mood...')).toBeInTheDocument();
    expect(within(detail).getByRole('button', { name: /^Generate$/ })).toBeInTheDocument();
  });

  it('background music with text filled -> clicking "Generate" submits music generation, and the in-flight registry records generate', async () => {
    seed([audioNode({ audioUrl: null, text: 'Hello' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Background music' }));

    fireEvent.click(within(detailPanel()).getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(submitFreezoneAudioMusic).toHaveBeenCalled());
    const [project, payload] = vi.mocked(submitFreezoneAudioMusic).mock.calls[0];
    expect(project).toBe('demo-project');
    expect(payload.prompt).toBe('Hello');
    // Remounting the detail by key=nodeId does not resubmit: the in-flight state lives in a module-level registry.
    await waitFor(() => expect(inFlightAudioOps.get('audio-1')).toBe('generate'));
  });

  it('speech generation submits only the speakable body, not the duration or sound-effect notes', async () => {
    seed([audioNode({
      displayName: 'Narrator',
      audioUrl: null,
      text: '[Duration]79s\n[Narration](low-pitched) Real narration.\n[SFX]thunder',
      speechMode: 'clone',
      voiceAvailable: true,
      voiceRef: { scope: 'user_custom', voiceId: 'voice-1' },
    })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Narrator' }));

    fireEvent.click(within(detailPanel()).getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(submitFreezoneAudioSpeech).toHaveBeenCalled());
    const [, payload] = vi.mocked(submitFreezoneAudioSpeech).mock.calls[0];
    expect(payload.text).toBe('Real narration.');
  });

  it('generic speech Recipe compile timeout submits only the safe narration, not the compiler\'s production instructions', async () => {
    vi.mocked(compileFreezoneRecipePrompt).mockImplementation(async (payload) => {
      const prompt = 'You are a short-drama voice director. Based on the script, generate narration voiceover.\n\nReal narration.';
      payload.onCompileMetadata?.({
        mode: 'timeout_fallback',
        prompt,
        recipeIds: ['general-audio'],
      });
      return prompt;
    });
    seed([audioNode({
      displayName: 'Narrator',
      audioKind: 'speech',
      audioUrl: null,
      text: 'Female narration, gentle mood, 3 seconds. Reading text: Real narration.',
      speechMode: 'clone',
      voiceAvailable: true,
      voiceRef: { scope: 'user_custom', voiceId: 'voice-1' },
      workflowCatalog: { recipeId: 'general-audio' },
    })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Narrator' }));

    fireEvent.click(within(detailPanel()).getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(submitFreezoneAudioSpeech).toHaveBeenCalled());
    expect(compileFreezoneRecipePrompt).toHaveBeenCalledTimes(1);
    const [, payload] = vi.mocked(submitFreezoneAudioSpeech).mock.calls[0];
    expect(payload.text).toBe('Real narration.');
    expect(useCanvasStore.getState().nodes[0]?.data.text).toBe('Real narration.');
  });

  it('general-audio submits only the marked speakable body after a normal compile', async () => {
    vi.mocked(compileFreezoneRecipePrompt).mockImplementation(async (payload) => {
      const prompt = [
        'Reading text: <speech_text>',
        'Welcome.',
        'He said: run!',
        '</speech_text>',
        'Emotion: gentle',
      ].join('\n');
      payload.onCompileMetadata?.({
        mode: 'model',
        prompt,
        recipeIds: ['general-audio'],
      });
      return prompt;
    });
    seed([audioNode({
      displayName: 'Narrator',
      audioKind: 'speech',
      audioUrl: null,
      text: 'Welcome.',
      speechMode: 'clone',
      voiceAvailable: true,
      voiceRef: { scope: 'user_custom', voiceId: 'voice-1' },
      workflowCatalog: { recipeId: 'general-audio' },
    })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Narrator' }));

    fireEvent.click(within(detailPanel()).getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(submitFreezoneAudioSpeech).toHaveBeenCalled());
    expect(compileFreezoneRecipePrompt).toHaveBeenCalledTimes(1);
    const [, payload] = vi.mocked(submitFreezoneAudioSpeech).mock.calls[0];
    expect(payload.text).toBe('Welcome.\n\nHe said: run!');
    expect(useCanvasStore.getState().nodes[0]?.data.text).toBe('Welcome.\n\nHe said: run!');
  });

  it('legacy preset-voice nodes keep their original speech mode and voice', async () => {
    seed([audioNode({
      displayName: 'Narrator', audioKind: 'speech', audioUrl: null,
      text: 'Welcome back.', speechMode: 'preset',
      presetVoice: 'Serena', presetModel: 'edge-tts', voiceAvailable: false,
    })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Narrator' }));
    fireEvent.click(within(detailPanel()).getByRole('button', { name: /^Generate$/ }));
    await waitFor(() => expect(submitFreezoneAudioSpeech).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitFreezoneAudioSpeech).mock.calls[0][1]).toMatchObject({
      speechMode: 'preset', presetVoice: 'Serena', presetModel: 'edge-tts', text: 'Welcome back.',
    });
  });

  it('legacy nodes missing voice fields keep the project narrator fallback', async () => {
    seed([audioNode({
      displayName: 'Narrator', audioKind: 'speech', audioUrl: null, text: 'Welcome back.',
    })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Narrator' }));
    fireEvent.click(within(detailPanel()).getByRole('button', { name: /^Generate$/ }));
    await waitFor(() => expect(submitFreezoneAudioSpeech).toHaveBeenCalledTimes(1));
    expect(vi.mocked(submitFreezoneAudioSpeech).mock.calls[0][1]).toMatchObject({
      speechMode: 'clone', voiceRef: { scope: 'project_narrator' }, text: 'Welcome back.',
    });
  });

  it('a new speech node still requires picking a voice first, and does not fall back to a legacy node after save and reload', async () => {
    seed([]);
    const id = useCanvasStore.getState().addNode(CANVAS_NODE_TYPES.audio, { x: 0, y: 0 }, {
      displayName: 'New voice', audioKind: 'speech', text: 'Welcome back.',
    });
    const saved = JSON.parse(JSON.stringify(useCanvasStore.getState().nodes)) as CanvasNode[];
    seed(saved);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'New voice' }));
    fireEvent.click(within(detailPanel()).getByRole('button', { name: /^Generate$/ }));
    await waitFor(() => expect(
      useCanvasStore.getState().nodes.find(node => node.id === id)?.data.generationError,
    ).toBe('No custom voice selected; generation was skipped'));
    expect(submitFreezoneAudioSpeech).not.toHaveBeenCalled();
  });

  it('drama-shot-voice submits custom-voice TTS once verbatim, without compiling a Recipe', async () => {
    seed([audioNode({
      displayName: 'Narrator',
      audioKind: 'speech',
      audioUrl: null,
      text: 'He said: run!',
      speechMode: 'clone',
      voiceAvailable: true,
      voiceRef: { scope: 'user_custom', voiceId: 'voice-1' },
      workflowCatalog: { recipeId: 'drama-shot-voice' },
    })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Narrator' }));

    fireEvent.click(within(detailPanel()).getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(submitFreezoneAudioSpeech).toHaveBeenCalled());
    expect(compileFreezoneRecipePrompt).not.toHaveBeenCalled();
    expect(submitFreezoneAudioSpeech).toHaveBeenCalledTimes(1);
    const [, payload] = vi.mocked(submitFreezoneAudioSpeech).mock.calls[0];
    expect(payload.text).toBe('He said: run!');
    expect(payload.speechMode).toBe('clone');
    expect(payload.voiceRef).toEqual({ scope: 'user_custom', voiceId: 'voice-1' });
  });

  it('a non-exact drama-shot-voice binding must not borrow the verbatim passthrough', async () => {
    vi.mocked(compileFreezoneRecipePrompt).mockResolvedValue('[Narration] He said: run!');
    seed([audioNode({
      displayName: 'Narrator',
      audioKind: 'speech',
      audioUrl: null,
      text: 'He said: run!',
      voiceAvailable: true,
      voiceRef: { scope: 'user_custom', voiceId: 'voice-1' },
      workflowCatalog: { recipeId: 'drama-shot-voice-extra' },
    })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Narrator' }));

    fireEvent.click(within(detailPanel()).getByRole('button', { name: /^Generate$/ }));

    await waitFor(() => expect(submitFreezoneAudioSpeech).toHaveBeenCalled());
    expect(compileFreezoneRecipePrompt).toHaveBeenCalledTimes(1);
    expect(submitFreezoneAudioSpeech).toHaveBeenCalledTimes(1);
  });

  it('storyboard hidden (visible=false) -> commands the waveform player to pause its inner <audio>', () => {
    const pauseSpy = vi
      .spyOn(window.HTMLMediaElement.prototype, 'pause')
      .mockImplementation(() => {});
    seed([audioNode({ audioUrl: '/static/a.mp3', text: 'Melodious tune' })]);
    const { rerender } = render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Background music' }));
    expect(within(detailPanel()).getByRole('slider', { name: 'Audio waveform scrubber' })).toBeInTheDocument();

    // Keep-alive hiding: after the view switches away the player stays mounted, but paused=!visible commands the inner <audio> to stop.
    pauseSpy.mockClear();
    rerender(<AssetBoardView visible={false} onLocateNode={vi.fn()} />);
    expect(pauseSpy).toHaveBeenCalled();

    pauseSpy.mockRestore();
  });

  it('switching audio detail A->B -> the waveform player swaps instance by key (prevents isPlaying state leaking)', () => {
    seed([
      { id: 'audio-1', type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 0 }, data: { displayName: 'Background music', audioUrl: '/static/a.mp3' } } as CanvasNode,
      { id: 'audio-2', type: CANVAS_NODE_TYPES.audio, position: { x: 0, y: 100 }, data: { displayName: 'Narrator', audioUrl: '/static/b.mp3' } } as CanvasNode,
    ]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);

    // Open A's detail and grab the current <audio> DOM node.
    fireEvent.click(screen.getByRole('button', { name: 'Background music' }));
    const audioA = detailPanel().querySelector('audio');
    expect(audioA?.getAttribute('src')).toBe('/static/a.mp3');

    // Click B in the left audio strip -> switch the detail. key={node.id} forces a new instance: <audio> should be a brand-new DOM
    // node (without the key, React would only change the src of the same <audio>, and isPlaying state would leak to B).
    fireEvent.click(screen.getByRole('button', { name: 'Narrator' }));
    const audioB = detailPanel().querySelector('audio');
    expect(audioB?.getAttribute('src')).toBe('/static/b.mp3');
    expect(audioB).not.toBe(audioA);
  });

  it('x close details -> back to the three-column layout', () => {
    seed([audioNode({ audioUrl: '/static/a.mp3', text: 'Melodious tune' }), textNode()]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Background music' }));
    expect(screen.queryByRole('region', { name: 'Asset details' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Close details' }));

    expect(screen.queryByRole('region', { name: 'Asset details' })).not.toBeInTheDocument();
    expect(screen.getByText('Text')).toBeInTheDocument();
  });

  it('the audio switcher is the audio tab in the top bar: after entering the detail the chip can still be clicked to switch (no inline operations toggle)', () => {
    seed([audioNode({ audioUrl: '/static/a.mp3', text: 'Melodious tune' })]);
    render(<AssetBoardView visible onLocateNode={vi.fn()} />);
    // The top-bar audio tab has only big square chips, without the old "Audio actions" toggle.
    expect(screen.queryByRole('button', { name: /Audio actions/ })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Background music' }));
    // After entering the detail the audio switcher stays in the top-bar audio tab: still a single "Audio" heading (top-bar tab), with the text column on the left.
    expect(screen.getAllByText('Audio')).toHaveLength(1);
    // Still no inline operations toggle (the form moved into the detail).
    expect(screen.queryByRole('button', { name: /Audio actions/ })).not.toBeInTheDocument();
    // The audio switcher is still clickable (the chip stays in the top bar).
    expect(screen.getByRole('button', { name: 'Background music' })).toBeInTheDocument();
  });
});

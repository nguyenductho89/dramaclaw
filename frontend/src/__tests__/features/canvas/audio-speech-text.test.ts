// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from 'vitest';

import {
  extractExplicitSpeakableAudioText,
  extractSpeakableAudioText,
  isSpeechGenerationInstruction,
  resolveAudioKind,
  resolveMusicLengthMs,
  resolveSafeSpeechSubmissionText,
} from '@/features/canvas/application/audioSpeechText';

describe('extractSpeakableAudioText', () => {
  it('keeps narration and dialogue while dropping production instructions', () => {
    expect(extractSpeakableAudioText(`
      [Duration]79s
      [Narration] (low, slow) The convenience store at night, with only him inside.
      [Clerk] (terrified whisper) It is watching me.
      [Ambience] Low-frequency hum of the freezer compressor
      [SFX] Heartbeat growing louder
      [Soundtrack] Low uneasy ambient music
    `)).toBe('The convenience store at night, with only him inside.\n\nIt is watching me.');
  });

  it('drops plain control lines and timeline prefixes', () => {
    expect(extractSpeakableAudioText(`
      Duration: 79s
      Mood: tense
      0-5s: Welcome to today's show.
      79s
    `)).toBe('Welcome to today\'s show.');
  });

  it('preserves ordinary unstructured speech text', () => {
    expect(extractSpeakableAudioText('Hello, welcome back.')).toBe('Hello, welcome back.');
  });

  it('recovers a workflow BGM node that was incorrectly stored as speech', () => {
    expect(resolveAudioKind({
      audioKind: 'speech',
      title: 'Background music',
      text: 'Compose background music for a 15 second ad',
      workflowCatalog: {
        promptBuilder: {
          planItem: { id: 'bgm', title: 'Background music' },
        },
      },
    })).toBe('music');
  });

  it('does not reinterpret narration as music from its body text', () => {
    expect(resolveAudioKind({
      audioKind: 'speech',
      title: 'Ad narration',
      text: 'Welcome to this ad on the background music theme.',
    })).toBe('speech');
  });

  it('rejects a narration-generation instruction as speakable text', () => {
    const instruction =
      'Based on the narration copy in the ad script, generate a female narration voiceover with an elegant, gentle tone, paced to a 15 second ad';
    expect(isSpeechGenerationInstruction(instruction)).toBe(true);
    expect(extractSpeakableAudioText(instruction)).toBe('');
  });

  it('rejects workflow narration placeholders instead of speaking them literally', () => {
    expect(extractSpeakableAudioText('This is the short drama\'s first narration')).toBe('');
    expect(extractSpeakableAudioText('This is the second narration')).toBe('');
  });

  it('uses only the pre-filtered narration when Recipe compilation times out', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'timeout_fallback',
      compiledPrompt: 'You are a short-drama voice director. Based on the script, generate narration voiceover.\n\nReal narration.',
      safeFallbackPrompt: 'Real narration.',
    })).toBe('Real narration.');
  });

  it('stops timeout fallback submission when no safe narration exists', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'timeout_fallback',
      compiledPrompt: 'You are a short-drama voice director. Based on the script, generate narration voiceover.',
      safeFallbackPrompt: '',
    })).toBe('');
  });

  it('uses a successful Recipe compilation result for speech', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: '[Narration] Compiled safe narration.',
      safeFallbackPrompt: 'Original narration.',
    })).toBe('Compiled safe narration.');
  });

  it('extracts only explicitly labelled speech from a general-audio production brief', () => {
    const compiled = 'Female narration, gentle mood, 3 seconds. Reading text: Welcome.';
    expect(extractExplicitSpeakableAudioText(compiled)).toBe('Welcome.');
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: compiled,
      recipeIds: ['general-audio'],
      safeFallbackPrompt: 'Original text.',
    })).toBe('Welcome.');
  });

  it('stops explicit speech collection when another production field starts', () => {
    const compiled = [
      'Reading text:',
      '<speech_text>',
      'Welcome.',
      'He said: run!',
      '</speech_text>',
      'Emotion: gentle',
      'Voice timbre: gentle female voice',
    ].join('\n');
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: compiled,
      recipeIds: ['general-audio'],
      safeFallbackPrompt: 'Original text.',
    })).toBe('Welcome.\n\nHe said: run!');
  });

  it('falls back safely when structured speech markers are missing', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: 'Reading text:\nHe said: run!\nEmotion: gentle',
      recipeIds: ['general-audio'],
      safeFallbackPrompt: 'Original narration.',
    })).toBe('Original narration.');
  });

  it('accepts a speech start marker on the same line as its label', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: 'Reading text: <speech_text>\nWelcome.\n</speech_text>\nEmotion: gentle',
      recipeIds: ['general-audio'],
      safeFallbackPrompt: 'Original narration.',
    })).toBe('Welcome.');
  });

  it('rejects incomplete speech markers before legacy fallback', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: 'Reading text: <speech_text>\nWelcome.',
      recipeIds: ['general-audio'],
      safeFallbackPrompt: 'Original narration.',
    })).toBe('Original narration.');
  });

  it('accepts an unlabelled model result from the direct-speech Recipe', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: 'He said: run!',
      recipeIds: ['drama-shot-voice'],
      safeFallbackPrompt: 'Original narration.',
    })).toBe('He said: run!');
  });

  it('rejects labelled production output from the direct-speech Recipe', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: '[Timbre] gentle female voice',
      recipeIds: ['drama-shot-voice'],
      safeFallbackPrompt: 'Original narration.',
    })).toBe('Original narration.');
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: 'Production requirements: end sentences with a natural fade.',
      recipeIds: ['drama-shot-voice'],
      safeFallbackPrompt: 'Original narration.',
    })).toBe('Original narration.');
  });

  it('does not accept unlabelled production output from a general audio Recipe', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: 'Gentle female voice, relaxed pace.',
      recipeIds: ['general-audio'],
      safeFallbackPrompt: 'Original narration.',
    })).toBe('Original narration.');
  });

  it('falls back to source speech when a model result has no explicit speech field', () => {
    expect(resolveSafeSpeechSubmissionText({
      compileMode: 'model',
      compiledPrompt: 'Female narration, gentle mood, 3 seconds.',
      safeFallbackPrompt: 'Welcome.',
    })).toBe('Welcome.');
  });

  it('sets BGM one second longer than the requested video duration', () => {
    expect(resolveMusicLengthMs({
      audioKind: 'music',
      text: 'Generate elegant background music',
      workflowCatalog: {
        promptBuilder: {
          userGoal: 'Produce a 15 second vertical ad',
        },
      },
    })).toBe(16_000);
  });
});

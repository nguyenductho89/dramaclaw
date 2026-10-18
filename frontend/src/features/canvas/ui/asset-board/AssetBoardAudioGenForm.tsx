// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { useCallback, useMemo, useState, type ReactElement } from 'react';
import { ArrowUp, Loader2, Music2, Settings2, SlidersHorizontal } from 'lucide-react';

import { CreditCostPill } from '@/components/credits/credit-visual';
import { UiSelect } from '@/components/ui';
import type {
  AudioNodeData,
  AudioVoiceRef,
  CanvasNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  DEFAULT_MUSIC_LENGTH_MS,
  MUSIC_LENGTH_PRESETS,
  musicBillingSecondsFromMs,
} from '@/features/canvas/nodes/AudioOperationsPanel';
import { deriveAudioText, useAudioGeneration } from '@/features/canvas/nodes/useAudioGeneration';
import { requiresCustomVoiceSelection } from '@/features/canvas/nodes/audioVoicePolicy';
import { VoiceSelectionModal } from '@/features/canvas/nodes/VoiceSelectionModal';
import {
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
  NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS,
  NODE_INLINE_ICON_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';
import { CANVAS_NODE_OPS_PANEL_CLASS } from '@/features/canvas/ui/nodeFrameStyles';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { useCanvasStore } from '@/stores/canvasStore';

import { createAssetBoardOpsRegistry } from './assetBoardOpsState';

/** Audio operations in progress (currently only generation - the busy state of download/transcode is held by the chip itself). */
type AudioBusyOp = 'generate';

/**
 * The audio side's "in progress + failure feedback" registry (the same factory as the image/video/text sides, see
 * assetBoardOpsState). The generation's own loading and errors are actually already written on node.data
 * (handled by useAudioGeneration); what is registered here is the **duplicate-submit guard on the detail panel side**:
 * the form remounts by key={nodeId}, and switching away and back must not let the same node be submitted again.
 */
const audioOpsRegistry = createAssetBoardOpsRegistry<AudioBusyOp>();

/** Exported for tests to assert (nodeId -> name of the audio operation in progress). */
export const inFlightAudioOps: ReadonlyMap<string, AudioBusyOp> = audioOpsRegistry.inFlight;

/** For tests only: clear the in-progress / failure registries, avoiding cross-talk between cases via fixed node ids. */
export function __resetAssetBoardAudioOpsStateForTest(): void {
  audioOpsRegistry.resetForTest();
}

const FIELD_LABEL_CLASS = 'text-[12px] text-white/40';
// Corner radius 6px: this project's --radius=1rem, and rounded-lg works out to 16px, too round for an input (same as
// the reason AssetBoardToolbarButton settled on rounded-[6px]).
const FIELD_CLASS =
  'w-full rounded-[6px] border border-white/10 bg-white/[0.04] px-3 py-2 text-[13px] leading-6 text-white/85 outline-none placeholder:text-white/25 focus:border-white/25';
const MUSIC_LENGTH_SELECT_CLASS =
  '!h-8 !w-[120px] !rounded-[8px] !border-white/10 !bg-white/[0.06] !px-3 !text-[12px] !text-white/85 hover:!border-white/25';
const MUSIC_LENGTH_SELECT_MENU_CLASS =
  '!z-[260] !min-w-[140px] !border-white/10 !bg-[#2e2e2e] !text-white/85 shadow-xl';

/** Boolean setting switch (isomorphic with the toggle in the workflow audio panel, colors fitted to the storyboard's dark panel). */
function SettingToggle({
  checked,
  onChange,
  ariaLabel,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  ariaLabel: string;
}): ReactElement {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      onClick={() => onChange(!checked)}
      className="inline-flex shrink-0 items-center"
    >
      <span
        className={`relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors ${
          checked ? 'bg-[rgb(var(--accent-rgb))]' : 'bg-white/15'
        }`}
      >
        <span
          className={`inline-block h-3 w-3 transform rounded-full bg-white transition-transform ${
            checked ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </span>
    </button>
  );
}

interface AssetBoardAudioGenFormProps {
  nodeId: string;
  data: AudioNodeData;
}

/**
 * The "audio generation form" mounted below the waveform player in the storyboard audio detail: synthesis text / music description, tone words,
 * voice selection, advanced music settings, generate/regenerate. The same family position as the image/video detail's `AssetBoardImageGenForm`
 * / `AssetBoardVideoGenForm` (a generation bar below the media area).
 *
 * Vertical layout, width fitted to the detail panel (the earlier top inline expansion was a full horizontal row, and was retired along with audio entering
 * the detail stack - see the audio bar comment in AssetBoardView). Generation goes through useAudioGeneration -
 * the same implementation as the workflow node panel and the node body's failure retry. An empty audio node (no audioUrl) also mounts
 * this form and can generate from scratch, matching the image/video empty node experience.
 */
export function AssetBoardAudioGenForm({
  nodeId,
  data,
}: AssetBoardAudioGenFormProps): ReactElement {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const { generate, isGenerating, effectivePrompt, isMusic } = useAudioGeneration(nodeId, data);
  const busyOp = audioOpsRegistry.useInFlightOp(nodeId);
  const [voiceModalOpen, setVoiceModalOpen] = useState(false);
  const [showMusicSettings, setShowMusicSettings] = useState(false);

  const text = useMemo(() => deriveAudioText(data), [data]);
  const emotionPrompt = data.emotionPrompt ?? '';
  const musicLengthMs =
    typeof data.musicLengthMs === 'number' ? data.musicLengthMs : DEFAULT_MUSIC_LENGTH_MS;
  const currentVoiceRef: AudioVoiceRef = data.voiceRef ?? { scope: 'project_narrator' };
  const voiceMissing = requiresCustomVoiceSelection(data);
  // With an existing product the submit key means "Regenerate" (consistent with the image/video detail).
  const hasAudio = typeof data.audioUrl === 'string' && data.audioUrl.length > 0;

  // Compute cost inquiry: the same basis as the workflow AudioOperationsPanel (music by billed seconds, speech per call).
  const audioCost = useGenerationCreditCost(
    isMusic ? 'freezone_audio_music' : 'beat_tts',
    null,
    isMusic
      ? { surface: 'canvas', quantity: musicBillingSecondsFromMs(musicLengthMs) }
      : {},
  );

  const patch = useCallback(
    (next: Partial<AudioNodeData>) => {
      updateNodeData(nodeId, next as Partial<CanvasNodeData>);
    },
    [nodeId, updateNodeData],
  );

  const handleGenerate = useCallback(async () => {
    if (audioOpsRegistry.inFlight.get(nodeId)) return;
    audioOpsRegistry.markOpStart(nodeId, 'generate');
    try {
      await generate();
    } finally {
      audioOpsRegistry.markOpSettled(nodeId);
    }
  }, [generate, nodeId]);

  const submitDisabled = isGenerating || busyOp !== null || effectivePrompt.length === 0;

  return (
    // The outer frame is the same as the image/video generation bar (CANVAS_NODE_OPS_PANEL_CLASS + node corner radius): the three kinds of
    // generation bars sit in the same detail panel, and borders/background should not each be written separately (user asked to match video).
    <div
      className={`flex w-full flex-col gap-3 rounded-[var(--node-radius)] p-3 ${CANVAS_NODE_OPS_PANEL_CLASS}`}
    >
      {/* The failure reason is not inlined here: below the detail header there is already a shared red failure bar (AssetBoardDetail),
      showing node.data.generationError uniformly for all columns including audio, consistent with the image/video GenForm
      (they do not inline errors either). This inline block was carried over from the old top inline panel. */}

      <div className="flex flex-col gap-1.5">
        <span className={FIELD_LABEL_CLASS}>{isMusic ? i18n.t('canvas.assetBoard.audioForm.musicDescription') : i18n.t('canvas.assetBoard.audioForm.textToSynthesize')}</span>
        {/* Bound directly to the store (no local draft + IME guard): the workflow panel's guard is there to avoid high-frequency
        re-renders on the canvas interrupting IME candidates; while the storyboard is hidden the data source is frozen as a whole, so there is no
        such problem here, and an extra draft layer would instead fight with the remount of "switch away and back". */}
        <textarea
          value={text}
          onChange={(event) => patch({ text: event.target.value })}
          disabled={isGenerating}
          placeholder={
            isMusic ? i18n.t('canvas.assetBoard.audioForm.musicPlaceholder') : i18n.t('canvas.assetBoard.audioForm.textPlaceholder')
          }
          className={`${FIELD_CLASS} min-h-[84px] resize-y`}
        />
      </div>

      {!isMusic && (
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL_CLASS}>{i18n.t('canvas.assetBoard.audioForm.toneOptional')}</span>
          <input
            type="text"
            value={emotionPrompt}
            onChange={(event) => patch({ emotionPrompt: event.target.value })}
            disabled={isGenerating}
            placeholder={i18n.t('canvas.assetBoard.audioForm.tonePlaceholder')}
            className={FIELD_CLASS}
          />
        </div>
      )}

      {!isMusic && (
        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setVoiceModalOpen(true)}
            className="h-7 rounded-[5px] bg-white/10 text-[12px] text-white/90 transition-colors hover:bg-white/15"
          >
            {voiceMissing ? i18n.t('canvas.assetBoard.audioForm.chooseCustomVoice') : i18n.t('canvas.assetBoard.audioForm.changeCustomVoice')}
          </button>
          <div className="flex items-center gap-2 text-[12px] text-white/60">
            <span className={FIELD_LABEL_CLASS}>{i18n.t('canvas.assetBoard.audioForm.voice')}</span>
            <span className="truncate text-white/85">
              {voiceMissing ? i18n.t('canvas.assetBoard.audioForm.voiceNotSelected') : data.voiceLabel ?? i18n.t('canvas.assetBoard.audioForm.customVoice')}
            </span>
            {data.voiceLanguage && (
              <span className="rounded bg-white/[0.08] px-1.5 py-0.5 text-[11px] text-white/70">
                {data.voiceLanguage}
              </span>
            )}
          </div>
        </div>
      )}

      {isMusic && showMusicSettings && (
        <div className="flex flex-col gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-white/80">{i18n.t('canvas.assetBoard.audioForm.musicDuration')}</span>
            <UiSelect
              aria-label={i18n.t('canvas.assetBoard.audioForm.musicDuration')}
              value={String(musicLengthMs)}
              onChange={(event) => patch({ musicLengthMs: Number(event.target.value) })}
              className={MUSIC_LENGTH_SELECT_CLASS}
              menuClassName={MUSIC_LENGTH_SELECT_MENU_CLASS}
            >
              {MUSIC_LENGTH_PRESETS.map((preset) => (
                <option key={preset.ms} value={String(preset.ms)}>
                  {preset.label}
                </option>
              ))}
            </UiSelect>
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-white/80">{i18n.t('canvas.assetBoard.audioForm.forceInstrumental')}</span>
            <SettingToggle
              ariaLabel={i18n.t('canvas.assetBoard.audioForm.forceInstrumental')}
              checked={data.forceInstrumental ?? true}
              onChange={(next) => patch({ forceInstrumental: next })}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <span className="text-[13px] text-white/80">{i18n.t('canvas.assetBoard.audioForm.respectSections')}</span>
            <SettingToggle
              ariaLabel={i18n.t('canvas.assetBoard.audioForm.respectSections')}
              checked={data.respectSectionsDurations ?? true}
              onChange={(next) => patch({ respectSectionsDurations: next })}
            />
          </div>
        </div>
      )}

      {/* Bottom control row (matches liblib's compact footer, minus model selection - we do not let users pick a model):
      left = mode (custom-voice narration or text-to-music);
      right = character count · voice/advanced settings · compute cost ✦ · submit arrow. The same components as the control row of the workflow AudioOperationsPanel
      (IconButton / CreditCostPill / ArrowUp submit key). */}
      <div className="flex items-center gap-2 pt-0.5">
        <Music2 className="h-3.5 w-3.5 shrink-0 text-white/40" />
        <span className="min-w-0 truncate text-[12px] text-white/60">
          {isMusic
            ? i18n.t('canvas.assetBoard.audioForm.modeMusic')
            : i18n.t('canvas.assetBoard.audioForm.modeNarration')}
        </span>
        <span className="flex-1" />
        <span className="shrink-0 text-[11px] tabular-nums text-white/35">{text.length}</span>
        {!isMusic && (
          <button
            type="button"
            title={i18n.t('canvas.assetBoard.audioForm.voiceSettingsTitle', { voice: voiceMissing ? i18n.t('canvas.assetBoard.audioForm.voiceNotSelectedShort') : data.voiceLabel ?? i18n.t('canvas.assetBoard.audioForm.customVoice') })}
            onClick={() => setVoiceModalOpen(true)}
            className={NODE_INLINE_ICON_BUTTON_CLASS}
          >
            <SlidersHorizontal className="h-4 w-4" />
          </button>
        )}
        {isMusic && (
          <button
            type="button"
            title={i18n.t('canvas.assetBoard.audioForm.advancedSettings')}
            onClick={() => setShowMusicSettings((open) => !open)}
            className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
              showMusicSettings ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS : ''
            }`}
          >
            <Settings2 className="h-4 w-4" />
          </button>
        )}
        <CreditCostPill
          display={audioCost.data?.data.display}
          promotion={audioCost.data?.data.promotion}
          disabled={submitDisabled}
          className={NODE_CREDIT_PILL_FLAT_CLASS}
        />
        <button
          type="button"
          disabled={submitDisabled}
          // With an existing product the semantics is "Regenerate" (consistent with the image/video detail).
          title={
            effectivePrompt.length === 0
              ? isMusic
                ? i18n.t('canvas.assetBoard.audioForm.fillMusicFirst')
                : i18n.t('canvas.assetBoard.audioForm.fillTextFirst')
              : hasAudio
                ? i18n.t('canvas.assetBoard.audioForm.regenerate')
                : i18n.t('canvas.assetBoard.audioForm.generate')
          }
          aria-label={hasAudio ? i18n.t('canvas.assetBoard.audioForm.regenerate') : i18n.t('canvas.assetBoard.audioForm.generate')}
          onClick={() => void handleGenerate()}
          className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
            submitDisabled
              ? NODE_GENERATE_BUTTON_DISABLED_CLASS
              : NODE_GENERATE_BUTTON_ENABLED_CLASS
          }`}
        >
          {isGenerating || busyOp === 'generate' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ArrowUp className="h-3 w-3" />
          )}
        </button>
      </div>

      <VoiceSelectionModal
        open={voiceModalOpen}
        onClose={() => setVoiceModalOpen(false)}
        currentRef={currentVoiceRef}
        onPick={({ ref, label, language }) => {
          patch({
            speechMode: 'clone',
            voiceRef: ref,
            voiceLabel: label,
            voiceLanguage: language ?? '',
          });
          setVoiceModalOpen(false);
        }}
      />
    </div>
  );
}

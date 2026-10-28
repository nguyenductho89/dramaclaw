// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import { AlertTriangle, Music2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';

import {
  CANVAS_NODE_TYPES,
  hasInlineMediaReplaceButton,
  type AudioNodeData,
  type AudioVoiceRef,
} from '@/features/canvas/domain/canvasNodes';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { useExternalFileHandoff } from '@/features/canvas/hooks/useExternalFileHandoff';
import { localizeNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from '@/features/canvas/ui/NodeHeader';
import { AddNodeToChatButton } from '@/features/canvas/ui/AddNodeToChatButton';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import { AudioWaveformPlayer } from '@/features/canvas/ui/AudioWaveformPlayer';
import { NodeMediaReplaceButton } from '@/features/canvas/ui/NodeMediaReplaceButton';
import {
  useAssetCommitDragById,
} from '@/features/canvas/ui/useAssetCommitDrag';
import { setNodeMediaActive } from '@/features/canvas/application/canvasLod';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { CANVAS_NODE_PANEL_SURFACE_CLASS, canvasNodeFrameClass } from '@/features/canvas/ui/nodeFrameStyles';
import { useCanvasStore, useIsBoxSelecting } from '@/stores/canvasStore';
import { AudioOperationsPanel } from '@/features/canvas/nodes/AudioOperationsPanel';
import { deriveAudioText, useAudioGeneration } from '@/features/canvas/nodes/useAudioGeneration';
import { createInFlightRequestCache } from '@/features/canvas/nodes/inFlightRequestCache';
import { translateNodeText } from '@/features/canvas/application/translateText';
import {
  publishNodeActionAccepted,
  publishNodeActionError,
  publishNodeActionSuccess,
  subscribeNodeAction,
} from '@/features/canvas/application/nodeActionResult';
import { RegenerateButton } from '@/features/canvas/ui/RegenerateButton';
import {
  hasMainlineContexts,
  NodeContextBadges,
} from '@/features/freezone/context/NodeContextBadges';
import { fetchFreezoneAudioReferences, uploadFreezoneImage } from '@/api/ops';
import { readUrl } from '@/lib/url-params';
import { VoiceSelectionModal } from './VoiceSelectionModal';

type AudioNodeProps = NodeProps & {
  id: string;
  data: AudioNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 210;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 190;
const MAX_WIDTH = 900;
const MAX_HEIGHT = 360;

// Only audio files are allowed. `accept="audio/*"` is just a picker hint; choosing "All files" or dragging
// can still slip in non-audio such as mp4; so we hard-validate by mime + extension (mp4 and other video is rejected, m4a and the like
// still pass — audio with an empty/odd mime falls back to the extension).
const AUDIO_UPLOAD_EXTENSIONS = new Set([
  'mp3', 'wav', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'weba', 'wma',
  'aiff', 'aif', 'caf', 'amr',
]);

function isAudioFile(file: File): boolean {
  if (file.type.startsWith('audio/')) return true;
  const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
  return AUDIO_UPLOAD_EXTENSIONS.has(ext);
}

function isVoicePrerequisiteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:voice (?:is )?not configured|missing .*voice|configure or select a voice|upload or record .*audio|voice_narrator_missing)/i.test(message);
}

// Only merges concurrent requests; invalidated right after settling so an empty result is not reused after a voice is uploaded.
const getCachedAudioReferences = createInFlightRequestCache(
  fetchFreezoneAudioReferences,
);

export const AudioNode = memo(({ id, data, selected, width, height }: AudioNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const isBoxSelecting = useIsBoxSelecting();
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const { isGenerating, task } = useNodeGenerationTaskState(data);
  const [voicePickerOpen, setVoicePickerOpen] = useState(false);
  const [voicePickerInitialTab, setVoicePickerInitialTab] = useState<'library' | 'mine'>('library');
  // Retry uses the same generation logic (hook) as the panel submit.
  const { generate } = useAudioGeneration(id, data);
  useEffect(() => {
    return subscribeNodeAction(({ nodeId, action, parameters, requestId }) => {
      if (nodeId !== id) return;
      if (action === 'generate_audio') {
        publishNodeActionAccepted(requestId, id, action);
        void generate()
          .then((output) => {
            if (output.skipped) {
              publishNodeActionSuccess(requestId, id, action, output);
              return;
            }
            const latest = useCanvasStore.getState().nodes.find((node) => node.id === id);
            const latestAudioUrl = latest?.type === CANVAS_NODE_TYPES.audio
              && typeof latest.data.audioUrl === 'string'
              ? latest.data.audioUrl
              : undefined;
            publishNodeActionSuccess(requestId, id, action, {
              ...(output.audioUrl ? { audioUrl: output.audioUrl } : {}),
              ...(latestAudioUrl ? { audioUrl: latestAudioUrl } : {}),
            });
          })
          .catch((error) => {
            if (isVoicePrerequisiteError(error)) {
              updateNodeData(id, {
                isGenerating: false,
                generationStartedAt: null,
                voiceAvailable: false,
                generationError: 'No usable custom voice selected; generation skipped',
              });
              publishNodeActionSuccess(requestId, id, action, {
                skipped: true,
                reason: 'missing_custom_voice',
                agent_instruction: 'No custom voice selected; this audio node was skipped. Continue with the other workflow nodes.',
              });
              return;
            }
            publishNodeActionError(requestId, id, action, error);
          });
        return;
      }
      if (action === 'translate_text') {
        publishNodeActionAccepted(requestId, id, action);
        void (async () => {
          const project = readUrl().project;
          if (!project) throw new Error('Missing project ID; cannot translate the audio text');
          const latest = useCanvasStore.getState().nodes.find((node) => node.id === id);
          if (latest?.type !== CANVAS_NODE_TYPES.audio) {
            throw new Error('Audio node does not exist');
          }
          const text = deriveAudioText(latest.data as AudioNodeData).trim();
          if (!text) throw new Error('Audio node has no text to translate');
          const translated = await translateNodeText(project, {
            text,
            nodeId: id,
            nodeType: 'audio',
          });
          updateNodeData(id, { text: translated });
          publishNodeActionSuccess(requestId, id, action, { text: translated });
        })().catch((error) => publishNodeActionError(requestId, id, action, error));
        return;
      }
      if (action === 'open_voice_picker') {
        publishNodeActionAccepted(requestId, id, action);
        setVoicePickerInitialTab(parameters?.initialTab === 'mine' ? 'mine' : 'library');
        setVoicePickerOpen(true);
        publishNodeActionSuccess(requestId, id, action, { openedUiAction: true });
      }
    });
  }, [generate, id, updateNodeData]);


  // When the task stream (SSE) reports a failure, persist the error into the node data + clear isGenerating — covering cases where
  // the catch never ran after a refresh, with the node unselected, or after the handleSubmit promise died with the old page.
  useEffect(() => {
    if (task && task.status === 'failed' && task.error) {
      if (data.generationError !== task.error || data.isGenerating) {
        updateNodeData(id, {
          generationError: task.error,
          isGenerating: false,
        });
      }
    }
  }, [task, data.generationError, data.isGenerating, id, updateNodeData]);

  const generationError =
    typeof data.generationError === 'string' ? data.generationError.trim() : '';
  // Shown as the failed state only when "not generated + no audio + has an error", so a successful result is never covered.
  const hasGenerationError =
    !isGenerating && !data.audioUrl && generationError.length > 0;

  const resolvedTitle = useMemo(
    () => localizeNodeDisplayName(CANVAS_NODE_TYPES.audio, data, t),
    [data, t],
  );
  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? DEFAULT_WIDTH));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? DEFAULT_HEIGHT));

  const audioSource = useMemo(() => {
    if (!data.audioUrl) return null;
    return resolveImageDisplayUrl(data.audioUrl);
  }, [data.audioUrl]);
  const hasMainlineContext = hasMainlineContexts(
    (data as { mainline_context?: unknown }).mainline_context,
  );
  const currentVoiceRef: AudioVoiceRef = data.voiceRef ?? { scope: 'project_narrator' };
  const speechMode = data.speechMode ?? 'clone';

  // The replace button inside the card doubles as "press and drag to the left asset library" (the gesture of the former AssetCommitHandle).
  const { canCommit: canCommitAsset, startDrag: startAssetCommitDrag } =
    useAssetCommitDragById(id);

  // Upload a local audio file to the backend freezone — reuses the generic upload endpoint (the backend does not distinguish mime).
  // After a successful upload, audioUrl/sourceFileName land in the store, and AudioOperationsPanel
  // automatically picks this audio up for follow-up processing.
  const processFile = useCallback(
    async (file: File) => {
      if (!isAudioFile(file)) {
        toast.error(t('node.audio.uploadTypeError'));
        return;
      }
      const projectId = readUrl().project;
      if (!projectId) {
        console.error('[audio-node] no project in URL — cannot upload');
        return;
      }
      updateNodeData(id, { isUploading: true });
      try {
        const uploaded = await uploadFreezoneImage(projectId, file, file.name);
        updateNodeData(id, {
          audioUrl: uploaded.url,
          sourceFileName: file.name,
          // Reset duration — so <audio onLoadedMetadata> writes it again when the new file loads.
          durationMs: null,
          isUploading: false,
        });
      } catch (error) {
        console.error('[audio-node] upload failed', error);
        updateNodeData(id, { isUploading: false });
      }
    },
    [id, t, updateNodeData],
  );

  // When audio is uploaded via the "Upload resource" menu, UploadNode first converts itself into an audio node and then hands the File
  // over. The File itself is staged in pendingExternalFiles and delivered on mount — at low zoom this node first
  // mounts as an LOD shell, and subscribing to events alone would miss the handoff (see useExternalFileHandoff).
  const consumeExternalFile = useCallback(
    (file: File) => {
      // Type validation is delegated to processFile (including non-audio rejection + toast).
      void processFile(file);
    },
    [processFile],
  );
  useExternalFileHandoff('audio-node/external-file', id, consumeExternalFile);

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  // After the node mounts, if there is no explicit voice, fetch the voice library references once and settle on the first one.
  // This lives in AudioNode rather than AudioOperationsPanel because the panel only mounts when
  // `selected && !audioUrl` — if a new node is not selected right away, the panel never renders and
  // the initialization effect never runs. AudioNode mounts as soon as it enters the canvas, so it triggers reliably.
  //
  // "No explicit voice" = voiceRef is missing *or* is still the legacy factory fallback (a bare
  // `{ scope: 'project_narrator' }` with no characterName/identityId/slot/voiceId),
  // compatible with old nodes persisted before 2026-05-19.
  //
  // Do not guard "run only once" with an outer useRef — under StrictMode the first effect pass starts the fetch,
  // cleanup flips cancelled to true, the second pass sees the ref already set and bails, and when the first pass's
  // closure returns it is blocked by cancelled, so nobody writes to the store. Request-level dedupe is left to
  // the promise cache of `getCachedAudioReferences`.
  useEffect(() => {
    if (data.audioKind === 'music' || speechMode !== 'clone') return;
    const v = data.voiceRef;
    const isFactoryFallback =
      v != null &&
      v.scope === 'project_narrator' &&
      !v.characterName &&
      !v.identityId &&
      !v.slot &&
      !v.voiceId;
    if (v != null && !isFactoryFallback) return;
    const project = readUrl().project;
    if (!project) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await getCachedAudioReferences(project);
        if (cancelled) return;
        const first = (res.available ?? [])[0];
        if (!first) {
          updateNodeData(id, {
            voiceAvailable: false,
            voiceLabel: t('node.audioNode.noVoiceConfigured'),
          });
          return;
        }
        const fresh = useCanvasStore.getState().nodes.find((n) => n.id === id);
        if (!fresh) return;
        const freshData = fresh.data as AudioNodeData;
        const cur = freshData.voiceRef;
        const curIsFactory =
          cur != null &&
          cur.scope === 'project_narrator' &&
          !cur.characterName &&
          !cur.identityId &&
          !cur.slot &&
          !cur.voiceId;
        if (cur != null && !curIsFactory) return;
        const ref: AudioVoiceRef = {
          scope: first.scope,
          characterName: first.character_name ?? undefined,
          identityId: first.identity_id ?? undefined,
          slot: first.slot ?? undefined,
          voiceId: first.voice_id ?? undefined,
        };
        const nextLabel = first.label ?? '';
        const nextLanguage = first.language ?? '';
        // Skip if the computed default voice already equals the current one: when the first reference is itself a bare
        // project_narrator (same shape as the "factory fallback"), writing re-triggers this effect, and both
        // guards treat that shape as "still needs initialization", so every render writes a new object →
        // infinite re-rendering freezes the browser. This equality check is what breaks the loop.
        if (
          cur != null &&
          cur.scope === ref.scope &&
          cur.characterName === ref.characterName &&
          cur.identityId === ref.identityId &&
          cur.slot === ref.slot &&
          cur.voiceId === ref.voiceId &&
          freshData.voiceLabel === nextLabel &&
          freshData.voiceLanguage === nextLanguage
        ) {
          return;
        }
        updateNodeData(id, {
          voiceRef: ref,
          voiceAvailable: true,
          voiceLabel: nextLabel,
          voiceLanguage: nextLanguage,
        });
      } catch (err) {
        console.warn('[audio-node] init default voice failed', err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.audioKind, data.voiceRef, id, speechMode, updateNodeData]);
  const cardToneClass = canvasNodeFrameClass({
    selected,
    mainline: hasMainlineContext,
  });

  return (
    <div
      className="group relative h-full w-full overflow-visible"
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="target"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Music2 className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />
      <AddNodeToChatButton nodeId={id} />
      <NodeContextBadges
        contexts={(data as { mainline_context?: unknown }).mainline_context}
      />

      <NodeResizeHandle
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        maxWidth={MAX_WIDTH}
        maxHeight={MAX_HEIGHT}
      />

      {/* The audio node is no longer an upload entry (empty state / replace both removed): upload audio via the "Upload node"
          or drag the audio file into the canvas; external handoff still goes through canvasEventBus 'audio-node/external-file'.
          The one exception is allowLocalReplace (the BGM reference produced by frame-by-frame breakdown) - that is a reference
          asset, and swapping in your own track is normal usage, see the replace button at the top-right below. */}

      <div
        className={`relative flex h-full w-full items-center justify-center ${audioSource ? 'overflow-hidden' : 'overflow-visible'} rounded-[var(--node-radius)] border ${CANVAS_NODE_PANEL_SURFACE_CLASS} transition-colors ${cardToneClass}`}
      >
        {isGenerating ? (
          <NodeGenerationOverlay
            startedAt={data.generationStartedAt ?? null}
            hasBackground={false}
          />
        ) : audioSource ? (
          <AudioWaveformPlayer
            src={audioSource}
            durationMs={data.durationMs}
            onLoadedDuration={(ms) => {
              if (data.durationMs !== ms) {
                updateNodeData(id, { durationMs: ms });
              }
            }}
            onPlayingChange={(playing) => setNodeMediaActive(id, playing)}
          />
        ) : hasGenerationError ? (
          // Failed state: consistent with ImageGenNode/VideoNode (headline + scrollable error text + shared retry button).
          <div className="nodrag flex flex-col items-center px-5 text-center">
            <div className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-red-200">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-red-300/90" />
              <span>{t('node.audioNode.generateFailed')}</span>
            </div>
            <div
              className="mt-1 max-h-12 max-w-full overflow-y-auto break-words text-[11px] leading-4 text-red-100/76 [overflow-wrap:anywhere]"
              title={generationError}
            >
              {generationError}
            </div>
            <div className="mt-2 flex justify-center">
              <RegenerateButton
                onClick={() => void generate()}
                busy={isGenerating}
                label={t('common.retry')}
              />
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 text-text-muted/70">
            <Music2 className="h-7 w-7 opacity-60" />
            <span className="text-[12px]">{t('node.audioNode.empty')}</span>
          </div>
        )}

        {/* The "replace" entry at the top-right inside the card: click to swap in a local file, press and drag to drop into the left asset library.
            Only for cards with allowLocalReplace (the BGM reference produced by frame-by-frame breakdown) - other audio nodes
            are not upload entries to begin with (see above); their replace gesture goes through the AssetCommitHandle floating outside the node,
            see SelectedNodeOverlay. */}
        {canCommitAsset &&
          !isGenerating &&
          hasInlineMediaReplaceButton(data) && (
            <NodeMediaReplaceButton
              accept="audio/*"
              busy={Boolean(data.isUploading)}
              title={t('node.audio.replaceAudioTitle')}
              onPick={processFile}
              onCommitDragStart={startAssetCommitDrag}
            />
          )}
      </div>

      {/* Once the node has audio content (manual upload or TTS synthesis), the bottom operations area is no longer shown —
          this rule covers both manual upload and completed TTS synthesis.
          To re-synthesize you must first clear the audio (for now, by deleting and recreating the node). */}
      {selected && !isBoxSelecting && !data.audioUrl && (
        <AudioOperationsPanel nodeId={id} data={data} />
      )}
      {data.audioKind !== 'music' && (
        <VoiceSelectionModal
          open={voicePickerOpen}
          onClose={() => setVoicePickerOpen(false)}
          currentRef={currentVoiceRef}
          initialTab={voicePickerInitialTab}
          onPick={({ ref, label, language }) => {
            updateNodeData(id, {
              speechMode: 'clone',
              voiceRef: ref,
              voiceAvailable: true,
              voiceLabel: label,
              voiceLanguage: language ?? '',
              generationError: null,
            });
            setVoicePickerOpen(false);
          }}
        />
      )}
    </div>
  );
});

AudioNode.displayName = 'AudioNode';

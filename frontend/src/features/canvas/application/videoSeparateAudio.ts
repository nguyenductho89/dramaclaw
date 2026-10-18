// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  fetchFreezoneAudioSeparateResult,
  submitFreezoneAudioSeparate,
} from '@/api/ops';
import { awaitTaskCompletion, isTaskPollTimeoutError } from '@/api/tasks';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { notifyTaskStillRunning } from './errorDialog';

/** Landing size of the audio / muted-video result nodes (consistent with the original NodeActionToolbar implementation). */
const AUDIO_LAYOUT_WIDTH = 480;
const AUDIO_LAYOUT_HEIGHT = 180;
const SILENT_LAYOUT_WIDTH = 480;
const SILENT_LAYOUT_HEIGHT = 270;

const AUDIO_EXT_RE = /\.(mp3|m4a|aac|wav|flac|ogg|opus)(\?|$)/i;
const VIDEO_EXT_RE = /\.(mp4|mov|webm|mkv|avi|m4v)(\?|$)/i;

/**
 * Walk an arbitrary JSON tree and pull every string that looks like a
 * URL/path. Backend hasn't typed the result schema, so we can't rely on key
 * names alone.
 */
function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === 'string') {
    if (value.length > 0) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out);
    return;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectStrings(item, out);
    }
  }
}

/**
 * Fallback only: some legacy results carry a backend filesystem path (e.g.
 * `/data/output/<user>/<project>/...`) instead of a servable URL. Rewriting
 * `<...>/output/` into `/static/<user>/<project>/...` yields the LEGACY scheme,
 * which production now rejects with 410 — so this is used strictly as a last
 * resort when no `*_url` field exists.
 */
function toStaticUrl(raw: string): string {
  if (!raw) return raw;
  if (
    raw.startsWith('/static/') ||
    raw.startsWith('http://') ||
    raw.startsWith('https://') ||
    raw.startsWith('blob:') ||
    raw.startsWith('data:')
  ) {
    return raw;
  }
  const outputIdx = raw.lastIndexOf('/output/');
  if (outputIdx >= 0) {
    return `/static/${raw.slice(outputIdx + '/output/'.length)}`;
  }
  return raw;
}

function pickUrlField(
  source: Record<string, unknown>,
  keys: string[],
): string | null {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return null;
}

/**
 * Pick the addresses of the audio track and the muted video from the "separate audio/video" task result (moved verbatim out of NodeActionToolbar's
 * inline `classify` closure, with zero semantic change).
 *
 * Prefer the canonical fields given by the backend: the result carries both the filesystem `*_path`
 * (`/data/output/<user>/<project>/...`) and the directly accessible `*_url`
 * (`/static/projects/<project_id>/...`), and only `*_url` is reachable online
 * (OpenResty returns 410 for the historical `/static/<user>/<project>/...`),
 * so the URL is never derived back from `*_path`.
 *
 * Only when there is no explicit URL field does it go through the fallback heuristic: walk the whole tree and pick by extension/keyword,
 * and put strings already directly accessible (`/static`, http(s)) before bare filesystem paths.
 */
export function classifyAudioSeparateResult(
  source: Record<string, unknown> | null | undefined,
): { audio: string | null; video: string | null } {
  if (!source) return { audio: null, video: null };

  let audio = pickUrlField(source, ['audio_url', 'audioUrl']);
  let video = pickUrlField(source, ['mute_video_url', 'muteVideoUrl']);

  if (!audio || !video) {
    const strings: string[] = [];
    collectStrings(source, strings);
    const isServable = (s: string) =>
      s.startsWith('/static/') || s.startsWith('http://') || s.startsWith('https://');
    strings.sort((a, b) => Number(isServable(b)) - Number(isServable(a)));
    for (const s of strings) {
      if (!audio && (AUDIO_EXT_RE.test(s) || /audio|sound/i.test(s))) {
        audio = s;
      } else if (
        !video &&
        (VIDEO_EXT_RE.test(s) || /silent|mute|no[_-]?audio|video/i.test(s))
      ) {
        video = s;
      }
      if (audio && video) break;
    }
  }

  return {
    audio: audio ? toStaticUrl(audio) : null,
    video: video ? toStaticUrl(video) : null,
  };
}

/**
 * The title prefix of result nodes: prefer the source file name, then the display name, and `video` if neither; strip the extension
 * (consistent with the original NodeActionToolbar implementation).
 */
export function resolveSeparateBaseName(data: Record<string, unknown>): string {
  const rawName =
    typeof data.sourceFileName === 'string' && data.sourceFileName.trim().length > 0
      ? data.sourceFileName
      : typeof data.displayName === 'string' && data.displayName.trim().length > 0
        ? data.displayName
        : 'video';
  return rawName.replace(/\.[^/.]+$/, '');
}

export interface VideoSeparateAudioResult {
  /** The id of the newly created audio node; null if unsuccessful. */
  audioNodeId: string | null;
  /** The id of the newly created muted video node; null if unsuccessful. */
  videoNodeId: string | null;
  /** Failure reason; null on success or when "no address could be found in the result" (the latter only logs a warn, same as the original implementation). */
  error: string | null;
}

/**
 * Separate audio/video orchestration (moved verbatim out of NodeActionToolbar's handleAudioSeparate inline closure,
 * with zero semantic change; the edge strategy was adjusted later, see below): the source node sets isSeparatingAv -> submit
 * /freezone/video/audio-separate -> wait for the task to complete -> pick the audio/muted-video
 * addresses from the SSE result (if incomplete, hit the job result endpoint once more as a fallback) -> build an audio node and a
 * muted video node downstream of the source node; muted video video->video is legal, so connect an edge; the audio node hits the whitelist, gets no edge,
 * and only lands near the source via findNodePosition (see the comment below). Whether it succeeds or fails, isSeparatingAv
 * is cleared at the end.
 */
export async function separateVideoAudio(
  sourceNodeId: string,
  opts: { sourceUrl: string },
): Promise<VideoSeparateAudioResult> {
  const empty: VideoSeparateAudioResult = {
    audioNodeId: null,
    videoNodeId: null,
    error: null,
  };
  if (!opts.sourceUrl) return empty;
  const projectId = readUrl().project;
  if (!projectId) {
    console.error('[audio-separate] no project in URL');
    return empty;
  }
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) return empty;
  const baseName = resolveSeparateBaseName(node.data as Record<string, unknown>);

  store.updateNodeData(sourceNodeId, { isSeparatingAv: true });
  try {
    const ref = await submitFreezoneAudioSeparate(projectId, {
      sourceUrl: opts.sourceUrl,
    });
    const completed = await awaitTaskCompletion(ref.task_key, projectId, {
      taskType: ref.task_type,
    });
    console.info('[audio-separate] task completed', completed.result);

    let { audio: audioOutputUrl, video: silentVideoOutputUrl } =
      classifyAudioSeparateResult(
        (completed.result ?? null) as Record<string, unknown> | null,
      );

    // Fallback: hit the dedicated job-result endpoint when SSE result didn't
    // carry the URLs (some freezone task types surface artifacts only via
    // /jobs/.../result).
    if (!audioOutputUrl || !silentVideoOutputUrl) {
      try {
        const jobResult = await fetchFreezoneAudioSeparateResult(projectId, ref.job_id);
        console.info('[audio-separate] job result', jobResult);
        const classified = classifyAudioSeparateResult(jobResult);
        audioOutputUrl = audioOutputUrl ?? classified.audio;
        silentVideoOutputUrl = silentVideoOutputUrl ?? classified.video;
      } catch (jobErr) {
        console.warn('[audio-separate] job result fetch failed', jobErr);
      }
    }

    if (!audioOutputUrl || !silentVideoOutputUrl) {
      console.warn('[audio-separate] could not resolve audio/video urls', {
        sseResult: completed.result,
      });
      return empty;
    }
    console.info('[audio-separate] resolved urls', {
      audioOutputUrl,
      silentVideoOutputUrl,
    });

    const audioTitle = `${baseName}_background_audio`;
    const silentTitle = `${baseName}_silent`;

    const done = useCanvasStore.getState();
    const audioPos = done.findNodePosition(
      sourceNodeId,
      AUDIO_LAYOUT_WIDTH,
      AUDIO_LAYOUT_HEIGHT,
    );
    const audioNodeId = done.addNode(CANVAS_NODE_TYPES.audio, audioPos, {
      audioUrl: audioOutputUrl,
      sourceFileName: audioTitle,
      displayName: audioTitle,
    } as unknown as Parameters<typeof done.addNode>[2]);
    // The audio node is deliberately not connected back to the source video: in the store's upstream whitelist audio accepts only
    // textAnnotation as a source (UPSTREAM_SOURCE_WHITELIST), and a video->audio edge
    // would be rejected and silently ineffective even if built - the user decided not to change the whitelist semantics for this, so the audio node only relies on
    // findNodePosition to land near the source node, and no edge is built.

    const silentPos = done.findNodePosition(
      sourceNodeId,
      SILENT_LAYOUT_WIDTH,
      SILENT_LAYOUT_HEIGHT,
    );
    const videoNodeId = done.addNode(CANVAS_NODE_TYPES.video, silentPos, {
      videoUrl: silentVideoOutputUrl,
      sourceFileName: `${silentTitle}.mp4`,
      displayName: silentTitle,
    } as unknown as Parameters<typeof done.addNode>[2]);
    done.addEdge(sourceNodeId, videoNodeId);

    return { audioNodeId, videoNodeId, error: null };
  } catch (error) {
    if (isTaskPollTimeoutError(error)) {
      console.warn('[audio-separate] detached from a still-running job', {
        taskKey: error.taskKey,
        idleMs: error.idleMs,
      });
      notifyTaskStillRunning();
      return empty;
    }
    console.error('[audio-separate] failed', error);
    return {
      audioNodeId: null,
      videoNodeId: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    useCanvasStore.getState().updateNodeData(sourceNodeId, { isSeparatingAv: false });
  }
}

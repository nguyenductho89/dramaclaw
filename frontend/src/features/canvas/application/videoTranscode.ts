/**
 * Video encoding normalization before upload (pure frontend, using no server resources).
 *
 * Background: sources such as Feishu screen recordings / iPhone footage default to HEVC (H.265). Windows Edge without the
 * "HEVC Video Extensions" installed cannot decode it - on the canvas this shows as a black node with only duration and sound
 * (Chrome 107+ ships hardware HEVC decoding so the problem is not visible there). The only safe combination on the web is
 * H.264 (avc) + AAC, so any video track that is not avc is first converted in the browser before upload.
 *
 * Two paths:
 * 1. Fast path (mediabunny + WebCodecs): when the browser can decode the source codec, hardware decode + hardware encode H.264,
 *    usually several times faster than real time, downloading no wasm.
 * 2. Fallback (ffmpeg.wasm single-threaded, dynamically imported as a separate chunk): when the browser cannot decode the source codec
 *    (typically Edge meeting HEVC - WebCodecs uses the browser's built-in decoder, which equally cannot decode it)
 *    pure software transcoding. Slow (about 0.2~0.5x real time), relying on the progress loading on the node to cushion the experience.
 *    Note that the page sets only COOP and not COEP (see matteWorker.ts), so there is no SharedArrayBuffer,
 *    and only the single-threaded core can be used.
 *
 * If any step fails the original file is returned - transcoding is a best-effort compatibility optimization and must not block upload.
 */

import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  canEncodeVideo,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from "mediabunny";

export interface EnsureWebSafeVideoResult {
  file: File;
  /** true = transcoding happened and file is the newly generated H.264 mp4. */
  transcoded: boolean;
}

/** Above this size pure-frontend transcoding is not done (wasm/memory cannot cope), and the file is uploaded as is. */
const MAX_TRANSCODE_BYTES = 800 * 1024 * 1024;

/** Audio codecs that every browser is comfortable with in mp4; others (pcm/ac3...) are re-encoded to AAC together with the video. */
const WEB_SAFE_AUDIO = new Set(["aac", "mp3", "opus"]);

function toMp4Name(name: string): string {
  const base = name.replace(/\.[^.]+$/, "");
  return `${base || "video"}.mp4`;
}

async function transcodeWithWebCodecs(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<File> {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const audioTrack = await input.getPrimaryAudioTrack();
    const audioCodec = audioTrack ? await audioTrack.getCodec() : null;
    const output = new Output({
      // faststart: put moov first, so direct OSS links can stream without waiting for the whole file.
      format: new Mp4OutputFormat({ fastStart: "in-memory" }),
      target: new BufferTarget(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      video: { codec: "avc", bitrate: QUALITY_HIGH },
      // AAC/MP3 pass through without re-encoding; others (pcm, ac3...) are re-encoded to AAC. Opus in mp4 is not recognized by Safari,
      // so it is also normalized to AAC.
      audio:
        audioCodec && !["aac", "mp3"].includes(audioCodec)
          ? { codec: "aac", bitrate: 128_000 }
          : undefined,
      showWarnings: false,
    });
    if (!conversion.isValid) {
      const reasons = conversion.discardedTracks
        .map((entry) => `${entry.track.type}:${entry.reason}`)
        .join(", ");
      throw new Error(`conversion invalid (${reasons})`);
    }
    conversion.onProgress = (progress) => onProgress?.(progress);
    await conversion.execute();
    const buffer = (output.target as BufferTarget).buffer;
    if (!buffer || buffer.byteLength === 0) {
      throw new Error("conversion produced empty output");
    }
    return new File([buffer], toMp4Name(file.name), { type: "video/mp4" });
  } finally {
    input.dispose();
  }
}

/**
 * ffmpeg.wasm fallback transcoding (best effort): dynamically imported as a separate chunk, converting to an H.264 mp4.
 * Used in two scenarios - (1) the WebCodecs fast path fails; (2) mediabunny cannot even parse the container
 * (professional or old containers such as mxf/avi/ts, which browsers equally cannot play, and only ffmpeg's universal demuxing can handle them).
 * Only if even ffmpeg fails is the file uploaded as is.
 */
async function transcodeViaFfmpegBestEffort(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<EnsureWebSafeVideoResult> {
  try {
    const { transcodeWithFfmpeg } = await import("./videoTranscodeFfmpeg");
    const converted = await transcodeWithFfmpeg(file, onProgress);
    return {
      file: new File([converted], toMp4Name(file.name), { type: "video/mp4" }),
      transcoded: true,
    };
  } catch (error) {
    console.error("[video-transcode] ffmpeg.wasm fallback failed, uploading as-is", error);
    return { file, transcoded: false };
  }
}

/**
 * Detect the codec and, when needed, convert in the browser to an mp4 with H.264+AAC.
 *
 * onProgress receives 0..1; both paths call back. The returned transcoded lets the caller decide
 * whether to replace the local preview blob (on Edge a blob preview of an HEVC source is black too).
 */
export async function ensureWebSafeVideo(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<EnsureWebSafeVideoResult> {
  if (file.size > MAX_TRANSCODE_BYTES) {
    return { file, transcoded: false };
  }

  let videoCodec: string | null = null;
  let audioCodec: string | null = null;
  let canDecodeSource = false;
  let width = 0;
  let height = 0;
  let probeFailed = false;
  const probe = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  try {
    const track = await probe.getPrimaryVideoTrack();
    if (!track) return { file, transcoded: false };
    videoCodec = await track.getCodec();
    canDecodeSource = await track.canDecode();
    width = await track.getDisplayWidth();
    height = await track.getDisplayHeight();
    const audioTrack = await probe.getPrimaryAudioTrack();
    audioCodec = audioTrack ? await audioTrack.getCodec() : null;
  } catch (error) {
    // A container mediabunny cannot parse (professional or old containers such as mxf/avi/ts): the browser most likely cannot play it either,
    // so it must not be waved through as is - hand it to ffmpeg.wasm's universal demuxing to convert into an H.264 mp4.
    console.warn("[video-transcode] probe failed, trying ffmpeg fallback", error);
    probeFailed = true;
  } finally {
    probe.dispose();
  }
  if (probeFailed) {
    return transcodeViaFfmpegBestEffort(file, onProgress);
  }

  const videoNeedsTranscode = videoCodec !== "avc";
  const audioNeedsTranscode = audioCodec !== null && !WEB_SAFE_AUDIO.has(audioCodec);
  if (!videoNeedsTranscode && !audioNeedsTranscode) {
    return { file, transcoded: false };
  }

  console.info(
    `[video-transcode] source codec video=${videoCodec} audio=${audioCodec} → h264/aac (decodable=${canDecodeSource})`,
  );

  // Fast path: the source can be decoded by WebCodecs and H.264 encoding is available (almost all Chromium/Safari).
  if (canDecodeSource && (await canEncodeVideo("avc", { width, height }))) {
    try {
      const converted = await transcodeWithWebCodecs(file, onProgress);
      return { file: converted, transcoded: true };
    } catch (error) {
      console.warn("[video-transcode] WebCodecs path failed, trying ffmpeg.wasm", error);
    }
  }

  // Fallback: ffmpeg.wasm single-threaded software decode and encode (scenarios such as Edge without an HEVC decoder).
  return transcodeViaFfmpegBestEffort(file, onProgress);
}

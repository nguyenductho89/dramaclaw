/**
 * ffmpeg.wasm single-threaded transcoding fallback - dynamically imported by videoTranscode.ts only when the browser cannot decode the source codec (typically Edge
 * without the HEVC extension meeting HEVC). It is its own module so that
 * @ffmpeg/* and the ~31MB wasm core stay in a lazy-loaded chunk and out of the main bundle.
 *
 * The page does not enable COEP (no SharedArrayBuffer), so only the single-threaded core @ffmpeg/core can be used;
 * the speed is about 0.2~0.5x real time, and callers need a progress UI to cushion the waiting experience.
 */

import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile } from "@ffmpeg/util";
import coreJsUrl from "@ffmpeg/core?url";
import coreWasmUrl from "@ffmpeg/core/wasm?url";

let ffmpegSingleton: Promise<FFmpeg> | null = null;

function loadFfmpeg(): Promise<FFmpeg> {
  if (!ffmpegSingleton) {
    ffmpegSingleton = (async () => {
      const ffmpeg = new FFmpeg();
      await ffmpeg.load({ coreURL: coreJsUrl, wasmURL: coreWasmUrl });
      return ffmpeg;
    })();
    // On load failure (network interruption etc.) the failed state is not cached, and it is retried next time.
    ffmpegSingleton.catch(() => {
      ffmpegSingleton = null;
    });
  }
  return ffmpegSingleton;
}

export async function transcodeWithFfmpeg(
  file: File,
  onProgress?: (progress: number) => void,
): Promise<Blob> {
  const ffmpeg = await loadFfmpeg();
  const ext = /\.[^.]+$/.exec(file.name)?.[0] ?? ".mp4";
  const inputName = `input${ext}`;
  const outputName = "output.mp4";

  const progressHandler = ({ progress }: { progress: number }) => {
    // ffmpeg occasionally reports a transient value > 1; clamp it.
    onProgress?.(Math.min(1, Math.max(0, progress)));
  };
  ffmpeg.on("progress", progressHandler);
  try {
    await ffmpeg.writeFile(inputName, await fetchFile(file));
    const code = await ffmpeg.exec([
      "-i", inputName,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-crf", "23",
      "-pix_fmt", "yuv420p",
      // H.264 4:2:0 requires even width and height; a source with an odd size is rounded down to even.
      "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      outputName,
    ]);
    if (code !== 0) {
      throw new Error(`ffmpeg exited with code ${code}`);
    }
    const data = await ffmpeg.readFile(outputName);
    if (typeof data === "string" || data.byteLength === 0) {
      throw new Error("ffmpeg produced empty output");
    }
    return new Blob([data.slice()], { type: "video/mp4" });
  } finally {
    ffmpeg.off("progress", progressHandler);
    // Clear the intermediate files in MEMFS, so memory does not pile up higher and higher when transcoding long videos.
    await ffmpeg.deleteFile(inputName).catch(() => {});
    await ffmpeg.deleteFile(outputName).catch(() => {});
  }
}

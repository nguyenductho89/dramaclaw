// The single source for the canvas's file recognition basis (video containers + acceptable material types).
//
// For professional/old containers such as .mxf the browser gives an empty-string file.type, and a plain `startsWith("video/")`
// would keep them out of the upload gate. Here it is unified as "MIME is video/* or the extension is in the whitelist",
// making the canvas drag-drop (Canvas), UploadNode morph and VideoNode entries consistent; after a hit it is
// handed to the ffmpeg fallback of videoTranscode.ts to convert these containers to H.264 mp4.

// Container extensions with no (or unreliable) MIME that ffmpeg.wasm can nevertheless demux.
export const EXTRA_VIDEO_EXTENSIONS = /\.(mxf|mkv|avi|ts|mts|m2ts|flv|wmv|m4v|mpg|mpeg)$/i;

// For <input accept>: video/* covers those with a MIME, and after the comma the extensions without MIME are listed one by one.
export const VIDEO_FILE_ACCEPT =
  "video/*,.mxf,.mkv,.avi,.ts,.mts,.m2ts,.flv,.wmv,.m4v,.mpg,.mpeg";

export function isVideoFile(file: { type: string; name: string }): boolean {
  return file.type.startsWith("video/") || EXTRA_VIDEO_EXTENSIONS.test(file.name);
}

// The unified basis of "can this file be taken in as material" at each canvas entry, consistent with UploadNode's media dispatch
// (image / video / audio). Non-media files are silently ignored by UploadNode, so they must be blocked before building
// the node, otherwise an upload node connected by an edge but forever empty would be left.
export function isSupportedMediaFile(file: { type: string; name: string }): boolean {
  return (
    file.type.startsWith("image/") ||
    // isVideoFile catches professional containers such as .mxf whose file.type is an empty string.
    isVideoFile(file) ||
    file.type.startsWith("audio/")
  );
}

import { describe, expect, it } from "vitest";

import { isSupportedMediaFile, isVideoFile, VIDEO_FILE_ACCEPT } from "./videoFileTypes";

describe("isVideoFile", () => {
  it("accepts standard video MIME types", () => {
    expect(isVideoFile({ type: "video/mp4", name: "clip.mp4" })).toBe(true);
    expect(isVideoFile({ type: "video/quicktime", name: "clip.mov" })).toBe(true);
  });

  it("accepts .mxf and other no-MIME containers by extension", () => {
    // The browser gives .mxf an empty file.type -- exactly the scenario the extension has to cover.
    expect(isVideoFile({ type: "", name: "shot001.mxf" })).toBe(true);
    expect(isVideoFile({ type: "", name: "SHOT001.MXF" })).toBe(true);
    expect(isVideoFile({ type: "", name: "raw.avi" })).toBe(true);
    expect(isVideoFile({ type: "", name: "stream.ts" })).toBe(true);
  });

  it("rejects non-video files", () => {
    expect(isVideoFile({ type: "image/png", name: "poster.png" })).toBe(false);
    expect(isVideoFile({ type: "audio/mpeg", name: "voice.mp3" })).toBe(false);
    expect(isVideoFile({ type: "", name: "notes.txt" })).toBe(false);
    // The extension appears in the middle but the ending is not a video container: no misjudgment.
    expect(isVideoFile({ type: "", name: "my.mxf.txt" })).toBe(false);
  });

  it("lists the extra extensions in the <input accept> string", () => {
    expect(VIDEO_FILE_ACCEPT).toContain("video/*");
    expect(VIDEO_FILE_ACCEPT).toContain(".mxf");
  });
});

describe("isSupportedMediaFile", () => {
  it("accepts images", () => {
    expect(isSupportedMediaFile({ type: "image/png", name: "poster.png" })).toBe(true);
  });

  it("accepts audio", () => {
    expect(isSupportedMediaFile({ type: "audio/mpeg", name: "voice.mp3" })).toBe(true);
  });

  it("rejects files with empty MIME and a non-media extension", () => {
    expect(isSupportedMediaFile({ type: "", name: "notes.txt" })).toBe(false);
  });

  it("rejects non-media MIME types", () => {
    expect(isSupportedMediaFile({ type: "application/pdf", name: "doc.pdf" })).toBe(false);
  });
});

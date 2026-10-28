// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/ops", () => ({ uploadFreezoneVideo: vi.fn() }));
vi.mock("@/features/canvas/application/imageData", () => ({
  resolveImageDisplayUrl: (url: string) => `resolved:${url}`,
}));
vi.mock("@/features/canvas/application/videoCrop/cropVideo", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cropVideoBlob: vi.fn(),
}));

import { uploadFreezoneVideo } from "@/api/ops";
import { cropVideoBlob } from "@/features/canvas/application/videoCrop/cropVideo";
import { cropAndUploadVideo } from "@/features/canvas/application/videoCrop/runVideoCrop";

const BOX = { x: 72, y: 128, width: 576, height: 1024 };
const options = {
  projectId: "p1",
  videoUrl: "https://oss/src.mp4",
  box: BOX,
  sourceWidth: 720,
  sourceHeight: 1280,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(["src"]) }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(cropVideoBlob).mockReset();
  vi.mocked(uploadFreezoneVideo).mockReset();
});

describe("cropAndUploadVideo", () => {
  it("fetches the source, crops it and uploads the result", async () => {
    const cropped = new Blob(["cropped"], { type: "video/mp4" });
    vi.mocked(cropVideoBlob).mockResolvedValue({ blob: cropped, width: 576, height: 1024, durationMs: 5000 });
    vi.mocked(uploadFreezoneVideo).mockResolvedValue({ url: "https://oss/crop.mp4", filename: "c.mp4", size: 7 });

    const result = await cropAndUploadVideo(options);

    expect(fetchMock).toHaveBeenCalledWith("resolved:https://oss/src.mp4", { signal: undefined });
    expect(cropVideoBlob).toHaveBeenCalledWith(
      expect.objectContaining({ box: BOX, sourceWidth: 720, sourceHeight: 1280, blob: expect.any(Blob) }),
    );
    expect(uploadFreezoneVideo).toHaveBeenCalledWith(
      "p1",
      cropped,
      expect.stringMatching(/^video-crop-\d+\.mp4$/),
      { signal: undefined },
    );
    expect(result).toEqual({ url: "https://oss/crop.mp4", width: 576, height: 1024, durationMs: 5000 });
  });

  it("stops with fetchFailed when the source cannot be downloaded", async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 403, blob: async () => new Blob() });

    await expect(cropAndUploadVideo(options)).rejects.toMatchObject({ code: "fetchFailed", message: "403" });
    expect(cropVideoBlob).not.toHaveBeenCalled();
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();
  });

  it("propagates a cropVideoBlob rejection without uploading", async () => {
    const error = new Error("crop failed");
    vi.mocked(cropVideoBlob).mockRejectedValue(error);

    await expect(cropAndUploadVideo(options)).rejects.toBe(error);
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();
  });

  it("propagates an uploadFreezoneVideo rejection", async () => {
    const cropped = new Blob(["cropped"], { type: "video/mp4" });
    vi.mocked(cropVideoBlob).mockResolvedValue({ blob: cropped, width: 576, height: 1024, durationMs: 5000 });
    const error = new Error("upload 500");
    vi.mocked(uploadFreezoneVideo).mockRejectedValue(error);

    await expect(cropAndUploadVideo(options)).rejects.toBe(error);
  });

  it("forwards the abort signal to fetch and cropVideoBlob", async () => {
    const cropped = new Blob(["cropped"], { type: "video/mp4" });
    vi.mocked(cropVideoBlob).mockResolvedValue({ blob: cropped, width: 576, height: 1024, durationMs: 5000 });
    vi.mocked(uploadFreezoneVideo).mockResolvedValue({ url: "https://oss/crop.mp4", filename: "c.mp4", size: 7 });
    const controller = new AbortController();

    await cropAndUploadVideo({ ...options, signal: controller.signal });

    expect(fetchMock).toHaveBeenCalledWith("resolved:https://oss/src.mp4", { signal: controller.signal });
    expect(cropVideoBlob).toHaveBeenCalledWith(expect.objectContaining({ signal: controller.signal }));
    expect(uploadFreezoneVideo).toHaveBeenCalledWith(
      "p1",
      cropped,
      expect.stringMatching(/^video-crop-\d+\.mp4$/),
      { signal: controller.signal },
    );
  });

  it("turns a fetch AbortError into a canceled VideoCropError", async () => {
    fetchMock.mockRejectedValueOnce(new DOMException("The user aborted a request.", "AbortError"));
    const controller = new AbortController();

    await expect(cropAndUploadVideo({ ...options, signal: controller.signal })).rejects.toMatchObject({
      name: "VideoCropError",
      code: "canceled",
    });
    expect(cropVideoBlob).not.toHaveBeenCalled();
  });

  it("turns a response.blob() AbortError into a canceled VideoCropError", async () => {
    // Cancellation happens before the download has finished reading the body: fetch() itself has already resolved, and
    // the AbortError is thrown by the response.blob() step, which must share the same
    // abort-mapping try with fetch(), otherwise it would be treated as an unknown error and report "crop failed" rather than "crop cancelled".
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      blob: async () => {
        throw new DOMException("The user aborted a request.", "AbortError");
      },
    });
    const controller = new AbortController();

    await expect(cropAndUploadVideo({ ...options, signal: controller.signal })).rejects.toMatchObject({
      name: "VideoCropError",
      code: "canceled",
    });
    expect(cropVideoBlob).not.toHaveBeenCalled();
  });

  it("turns an uploadFreezoneVideo AbortError into a canceled VideoCropError", async () => {
    const cropped = new Blob(["cropped"], { type: "video/mp4" });
    vi.mocked(cropVideoBlob).mockResolvedValue({ blob: cropped, width: 576, height: 1024, durationMs: 5000 });
    vi.mocked(uploadFreezoneVideo).mockRejectedValue(
      new DOMException("The user aborted a request.", "AbortError"),
    );
    const controller = new AbortController();

    await expect(cropAndUploadVideo({ ...options, signal: controller.signal })).rejects.toMatchObject({
      name: "VideoCropError",
      code: "canceled",
    });
  });

  it("skips the upload and reports canceled when the signal aborts right after the crop resolves", async () => {
    const cropped = new Blob(["cropped"], { type: "video/mp4" });
    const controller = new AbortController();
    vi.mocked(cropVideoBlob).mockImplementation(async () => {
      // The user clicked cancel at the very moment the crop finished — a useless file must not be uploaded to OSS.
      controller.abort();
      return { blob: cropped, width: 576, height: 1024, durationMs: 5000 };
    });

    await expect(cropAndUploadVideo({ ...options, signal: controller.signal })).rejects.toMatchObject({
      name: "VideoCropError",
      code: "canceled",
    });
    expect(uploadFreezoneVideo).not.toHaveBeenCalled();
  });

  it("still lets an in-flight upload finish, then reports canceled once it resolves", async () => {
    // Once the upload is sent it cannot be recalled; cancelling midway still has to wait for it to land, otherwise the node is never created while the file is
    // already on OSS — leaving no chance to clean it up. Leaving an orphan behind is a known trade-off.
    const cropped = new Blob(["cropped"], { type: "video/mp4" });
    vi.mocked(cropVideoBlob).mockResolvedValue({ blob: cropped, width: 576, height: 1024, durationMs: 5000 });
    const controller = new AbortController();
    vi.mocked(uploadFreezoneVideo).mockImplementation(async () => {
      controller.abort();
      return { url: "https://oss/crop.mp4", filename: "c.mp4", size: 7 };
    });

    await expect(cropAndUploadVideo({ ...options, signal: controller.signal })).rejects.toMatchObject({
      code: "canceled",
    });
    expect(uploadFreezoneVideo).toHaveBeenCalledTimes(1);
  });
});

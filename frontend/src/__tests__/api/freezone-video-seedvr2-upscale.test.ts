import { describe, expect, it, vi } from "vitest";

import { apiCall } from "@/api/client";
import { submitFreezoneVideoSeedvr2Upscale } from "@/api/ops";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  apiClient: {},
}));

describe("submitFreezoneVideoSeedvr2Upscale", () => {
  it("defaults to the measured settings (2x, 7B) and forwards node context", async () => {
    const ref = { task_key: "tk", task_type: "freezone_video_upscale_seedvr2", job_id: "j1" };
    vi.mocked(apiCall).mockResolvedValueOnce(ref);

    await expect(
      submitFreezoneVideoSeedvr2Upscale("project-1", {
        sourceUrl: "/static/source.mp4",
        canvasId: "c1",
        nodeId: "n1",
      }),
    ).resolves.toEqual(ref);
    expect(apiCall).toHaveBeenCalledWith(
      "projects/project-1/freezone/video/upscale-seedvr2",
      {
        method: "POST",
        json: expect.objectContaining({
          source_url: "/static/source.mp4",
          scale: 2,
          model: "7b",
          canvas_id: "c1",
          node_id: "n1",
        }),
      },
    );
  });

  it("passes an explicit scale and model through", async () => {
    vi.mocked(apiCall).mockResolvedValueOnce({});
    await submitFreezoneVideoSeedvr2Upscale("p", { sourceUrl: "/static/a.mp4", scale: 1.5, model: "3b" });
    const calls = vi.mocked(apiCall).mock.calls;
    expect(calls[calls.length - 1]?.[1]).toMatchObject({
      json: { scale: 1.5, model: "3b" },
    });
  });
});

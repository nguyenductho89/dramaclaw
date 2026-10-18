// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * `foreign_media` sits at the **same level** as `data` in the envelope (like `editing_by`), so the canvas contract
 * stays byte-for-byte unchanged. An `apiCall` that unwraps only one envelope layer would drop it, so this read path must take the whole envelope.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCallEnvelope } from "@/api/client";
import { getFreezoneCanvas } from "@/api/canvas";

vi.mock("@/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/client")>();
  return { ...actual, apiCall: vi.fn(), apiCallEnvelope: vi.fn() };
});

const REF = {
  node_id: "n1",
  field: "imageUrl",
  url: "/static/projects/projA/a.png",
  source_project_id: "projA",
};

describe("getFreezoneCanvas", () => {
  beforeEach(() => {
    vi.mocked(apiCallEnvelope).mockReset();
  });

  it("carries the read-time diagnostics next to the payload", async () => {
    vi.mocked(apiCallEnvelope).mockResolvedValue({
      ok: true,
      data: { nodes: [], edges: [], revision: 3 },
      foreign_media: [REF],
    } as never);

    const canvas = await getFreezoneCanvas("projB", "default");

    expect(canvas.revision).toBe(3);
    expect(canvas.foreign_media).toEqual([REF]);
  });

  it("leaves the field off for a clean canvas, and never invents one", async () => {
    vi.mocked(apiCallEnvelope).mockResolvedValue({
      ok: true,
      data: { nodes: [], edges: [], revision: 3 },
      foreign_media: "nonsense",
    } as never);

    expect((await getFreezoneCanvas("projB", "default")).foreign_media).toBeUndefined();
  });

  it("still returns a payload when the backend sends no data at all", async () => {
    vi.mocked(apiCallEnvelope).mockResolvedValue({ ok: true } as never);

    await expect(getFreezoneCanvas("projB", "default")).resolves.toEqual({});
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import { apiCallEnvelope } from "@/api/client";
import { listFreezoneStyleTemplates } from "@/api/ops";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(),
  apiCallEnvelope: vi.fn(),
  apiClient: vi.fn(),
}));

const TEMPLATE = {
  id: "gu-zhuang-01",
  label: "Gongbi Heavy Color",
  category: "period",
  cover: "gu-zhuang-01/cover.jpg",
  samples: ["gu-zhuang-01/f.jpg", "gu-zhuang-01/m.jpg"],
  style_prompt: "gongbi heavy-color painting, blue-green palette",
};

/**
 * The `data` shape of this endpoint has been changed back and forth between two repositories, and every change broke any frontend that did not follow with
 * a blank screen (`templates.find is not a function` bubbling up to the root error boundary). This pins down everything the backend might emit:
 * none of the shapes may throw, and an unrecognised one degrades to an empty gallery at worst.
 */
describe("listFreezoneStyleTemplates tolerance of backend shapes", () => {
  beforeEach(() => {
    vi.mocked(apiCallEnvelope).mockReset();
  });

  it("bare list (the current contract, and the earliest shape)", async () => {
    vi.mocked(apiCallEnvelope).mockResolvedValue({
      ok: true,
      data: [TEMPLATE],
      asset_base: "https://cdn.example.com/style",
      version: "2026-08-06",
    });

    const result = await listFreezoneStyleTemplates("p1");

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0]).toEqual(TEMPLATE);
    expect(result.assetBase).toBe("https://cdn.example.com/style");
    expect(result.version).toBe("2026-08-06");
  });

  it("data is an {asset_base, version, templates} object (the formerly breaking shape)", async () => {
    vi.mocked(apiCallEnvelope).mockResolvedValue({
      ok: true,
      data: {
        asset_base: "https://cdn.example.com/style",
        version: "2026-08-06",
        templates: [TEMPLATE],
      },
    });

    const result = await listFreezoneStyleTemplates("p1");

    expect(result.templates).toEqual([TEMPLATE]);
    expect(result.assetBase).toBe("https://cdn.example.com/style");
    expect(result.version).toBe("2026-08-06");
  });

  it("other common wrappers (data / items / style_templates)", async () => {
    for (const key of ["data", "items", "style_templates"]) {
      vi.mocked(apiCallEnvelope).mockResolvedValue({
        ok: true,
        data: { [key]: [TEMPLATE] },
      });
      const result = await listFreezoneStyleTemplates("p1");
      expect(result.templates, `wrapper key ${key}`).toEqual([TEMPLATE]);
    }
  });

  it("a completely unrecognised shape returns an empty list and does not throw", async () => {
    for (const data of [null, undefined, 42, "nope", { unexpected: true }]) {
      vi.mocked(apiCallEnvelope).mockResolvedValue({ ok: true, data });
      await expect(listFreezoneStyleTemplates("p1")).resolves.toEqual({
        assetBase: "",
        version: "",
        templates: [],
      });
    }
  });

  it("drops entries without an id; missing fields only degrade and never drop the entry", async () => {
    vi.mocked(apiCallEnvelope).mockResolvedValue({
      ok: true,
      data: [
        { label: "No id" },
        null,
        "a string",
        { id: "bare" },
        TEMPLATE,
      ],
    });

    const result = await listFreezoneStyleTemplates("p1");

    expect(result.templates.map((item) => item.id)).toEqual(["bare", TEMPLATE.id]);
    // The entry with missing fields must render safely: label falls back to id, and samples is an array rather than undefined.
    expect(result.templates[0]).toEqual({
      id: "bare",
      label: "bare",
      category: "",
      cover: "",
      samples: [],
      style_prompt: "",
    });
  });

  it("non-string members of samples are removed", async () => {
    vi.mocked(apiCallEnvelope).mockResolvedValue({
      ok: true,
      data: [{ ...TEMPLATE, samples: ["ok.jpg", null, 7, "", "also-ok.jpg"] }],
    });

    const result = await listFreezoneStyleTemplates("p1");

    expect(result.templates[0].samples).toEqual(["ok.jpg", "also-ok.jpg"]);
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// The provider/model round trip of catalog entry -> `ImageModelDefinition.resolveRequest` -> `freezoneAiGateway`.
// The only coupling point on this chain is that "the gateway splits provider/model at the **first** `/`",
// while the catalog's apiModel may itself carry a namespace (OpenRouter's
// `google/gemini-...`). Testing only the shape of resolveRequest's return value cannot reveal the problem --
// the real gateway must do the split, and the two fields the backend finally receives must be asserted.
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  toImageModelDefinition,
  type CatalogImageModelEntry,
} from "@/features/canvas/domain/catalogImageModels";
import { freezoneAiGateway } from "@/features/canvas/infrastructure/freezoneAiGateway";

const submitFreezoneGen = vi.fn();
const submitFreezoneEdit = vi.fn();
const fetchFreezoneJobResult = vi.fn();
const awaitTaskCompletion = vi.fn();

vi.mock("@/api/ops", () => ({
  submitFreezoneGen: (...args: unknown[]) => submitFreezoneGen(...args),
  submitFreezoneEdit: (...args: unknown[]) => submitFreezoneEdit(...args),
  fetchFreezoneJobResult: (...args: unknown[]) => fetchFreezoneJobResult(...args),
}));

vi.mock("@/api/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tasks")>();
  return {
    ...actual,
    awaitTaskCompletion: (...args: unknown[]) => awaitTaskCompletion(...args),
  };
});

vi.mock("@/lib/url-params", () => ({
  readUrl: () => ({ project: "demo", canvas: "default" }),
}));

const JOB_REF = {
  task_type: "freezone_image",
  job_id: "img-1",
  task_key: "freezone_image:img-1",
};

function entry(overrides: Partial<CatalogImageModelEntry>): CatalogImageModelEntry {
  return {
    id: "openrouter/gemini-2.5-flash-image",
    providerId: "openrouter",
    apiModel: "google/gemini-2.5-flash-image-preview",
    label: "Gemini 2.5 Flash Image",
    ...overrides,
  };
}

/** Runs one real submission and returns the payload the gateway hands to the ops layer (provider/model already split). */
async function submittedBody(
  model: CatalogImageModelEntry,
  referenceImages: string[] = [],
): Promise<Record<string, unknown>> {
  const definition = toImageModelDefinition(model);
  const { requestModel } = definition.resolveRequest({
    referenceImageCount: referenceImages.length,
  });
  await freezoneAiGateway.generateImage({
    prompt: "hi",
    model: requestModel,
    modelId: definition.id,
    size: "2K",
    aspectRatio: "1:1",
    referenceImages,
  });
  const spy = referenceImages.length > 0 ? submitFreezoneEdit : submitFreezoneGen;
  return spy.mock.calls[0][1] as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  submitFreezoneGen.mockResolvedValue(JOB_REF);
  submitFreezoneEdit.mockResolvedValue(JOB_REF);
  awaitTaskCompletion.mockResolvedValue({ result: { output_url: "https://x/1.png" } });
});

describe("provider/model round trip of catalog models", () => {
  it("a lower-case resolution catalog still defaults to the 2k tier", () => {
    const definition = toImageModelDefinition(
      entry({ resolutionOptions: ["1k", "2k", "4k"] }),
    );

    expect(definition.defaultResolution).toBe("2k");
  });

  it("OpenRouter namespaced model: provider is openrouter, and model keeps the full multi-segment name", async () => {
    const body = await submittedBody(entry({}));
    expect(body.provider).toBe("openrouter");
    // Key assertion: it must not be truncated to `gemini-2.5-flash-image-preview` -- that string is not among the catalog entry's
    // identifiers, and the backend would answer 400 "model does not match configured media model".
    expect(body.model).toBe("google/gemini-2.5-flash-image-preview");
  });

  it("the edit path (with reference images) keeps the full model name too", async () => {
    const body = await submittedBody(entry({}), ["https://x/base.png"]);
    expect(body.provider).toBe("openrouter");
    expect(body.model).toBe("google/gemini-2.5-flash-image-preview");
  });

  it("the provider must not be lost even when apiModel carries no namespace", async () => {
    const body = await submittedBody(
      entry({
        id: "huimeng/gpt-image-2",
        providerId: "huimeng",
        apiModel: "huimeng_gpt_image2",
      }),
    );
    expect(body.provider).toBe("huimeng");
    expect(body.model).toBe("huimeng_gpt_image2");
  });

  it("when the catalog id disagrees with the provider/apiModel combination, apiModel is sent rather than the id", async () => {
    // The backend can configure any id for an entry; what the backend identifiers recognize is apiModel.
    const body = await submittedBody(
      entry({ id: "custom-slug", providerId: "openai", apiModel: "gpt-image-2" }),
    );
    expect(body.provider).toBe("openai");
    expect(body.model).toBe("gpt-image-2");
    expect(body.modelId).toBe("custom-slug");
  });
});

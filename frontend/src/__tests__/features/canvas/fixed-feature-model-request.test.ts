// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Panels without a model selector (360 panorama / grid action): after the caller picks a model, the quote parameters and the submission fields must share one source.
//
// Previously each side did its own thing -- the quote was computed from the selected model + the converged size/quality, yet the submission carried
// nothing, so the backend ran with its own default model and a fixed 2K. When the first catalog model is not the backend default model,
// or it does not support 2K at all, the price and capability tier shown in the UI differ from what actually runs.
import { describe, expect, it } from "vitest";

import { resolveFixedFeatureModelRequest } from "@/features/canvas/domain/fixedFeatureModelRequest";

const CATALOG_MODEL = {
  catalogId: "cat-77",
  apiModel: "google/gemini-2.5-flash-image-preview",
  resolutionOptions: ["1K", "4K"],
  qualityOptions: ["low", "high"],
};

describe("resolveFixedFeatureModelRequest", () => {
  it("the submitted size/quality exactly match those used for the quote", () => {
    const { submit, billingParams } = resolveFixedFeatureModelRequest(CATALOG_MODEL);
    expect(submit.imageSize).toBe(billingParams.size);
    expect(submit.quality).toBe(billingParams.quality);
  });

  it("when the model does not support the default tier it converges to a tier it really supports instead of forcing 2K/medium", () => {
    const { submit } = resolveFixedFeatureModelRequest(CATALOG_MODEL);
    // The catalog configures only 1K / 4K and low / high.
    expect(submit.imageSize).toBe("1K");
    expect(submit.quality).toBe("low");
  });

  it("carries the model and catalog identity and does not leave the model choice to the backend default", () => {
    const { submit, billingParams } = resolveFixedFeatureModelRequest(CATALOG_MODEL);
    expect(submit.model).toBe(CATALOG_MODEL.apiModel);
    expect(submit.catalogId).toBe("cat-77");
    // The quote side's model identity also comes from the same entry.
    expect(billingParams.image_selection).toBe(CATALOG_MODEL.apiModel);
    expect(billingParams.catalog_id).toBe("cat-77");
  });

  it("the model name carries no provider prefix", () => {
    const { submit } = resolveFixedFeatureModelRequest(CATALOG_MODEL);
    // The old scene-360 route always treats the provider as newapi, so the whole `provider/model` string
    // would be sent to the gateway as the model name as-is.
    expect(submit.model).not.toContain("openrouter/");
  });

  it("the catalog declares no quality: neither sends quality nor quotes by quality", () => {
    const { submit, billingParams } = resolveFixedFeatureModelRequest({
      apiModel: "huimeng_gpt_image2",
      resolutionOptions: ["1K", "2K"],
    });
    expect(submit.quality).toBeUndefined();
    expect(billingParams).not.toHaveProperty("quality");
    expect(submit.imageSize).toBe("2K");
  });

  it("when the catalog configures no resolution it uses the generic fallback tier, and both sides stay consistent", () => {
    const { submit, billingParams } = resolveFixedFeatureModelRequest({
      apiModel: "huimeng_gpt_image2",
    });
    expect(submit.imageSize).toBe("2K");
    expect(billingParams.size).toBe("2K");
  });

  it("does not fabricate a model identity when no model is available", () => {
    const { submit, billingParams } = resolveFixedFeatureModelRequest(undefined);
    expect(submit.model).toBeUndefined();
    expect(submit.catalogId).toBeUndefined();
    expect(billingParams).not.toHaveProperty("image_selection");
  });

  it("extra quote parameters (grid mode) go only into the quote and do not pollute the submission fields", () => {
    const { submit, billingParams } = resolveFixedFeatureModelRequest(CATALOG_MODEL, {
      mode: "multi_camera_nine_grid",
    });
    expect(billingParams.mode).toBe("multi_camera_nine_grid");
    expect(submit).not.toHaveProperty("mode");
  });
});

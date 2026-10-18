// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// "The backend has no image model configured" and "the catalog endpoint is down" must be two different states.
//
// Previously useCatalogImageModels unconditionally swapped an empty catalog for the frontend's hard-coded SHARED_MODELS, flattening the two
// situations into one: under an authoritative empty catalog users saw a bunch of selectable models, picked one, clicked generate, and only then were
// bounced back by the backend `_resolve_catalog_request` with a 409. The failure fallback is right (otherwise at the slightest endpoint hiccup the user
// could do nothing), but disguising "not configured" as "configured" is wrong.
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useCatalogImageModels } from "@/features/canvas/domain/catalogImageModels";
import type { UseFreezoneImageModelsResult } from "@/features/canvas/hooks/useFreezoneImageModels";
import type { ModelOption } from "@/features/canvas/ui/ProviderModelPicker";
import { SHARED_MODELS } from "@/features/canvas/ui/ProviderModelPicker";

let hookState: UseFreezoneImageModelsResult;

// Only the data-fetching hook is replaced; `isAuthoritativeEmptyCatalog` is a pure predicate,
// which `useCatalogImageModels` uses to compute isEmpty, so the real implementation must stay.
vi.mock("@/features/canvas/hooks/useFreezoneImageModels", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/canvas/hooks/useFreezoneImageModels")
  >()),
  useFreezoneImageModels: () => hookState,
  prefetchFreezoneImageModels: () => {},
}));

const CATALOG_MODEL: ModelOption = {
  id: "studio-image-v1",
  providerId: "openrouter",
  apiModel: "google/gemini-2.5-flash-image-preview",
  label: "Studio Image",
};

function read(state: UseFreezoneImageModelsResult) {
  hookState = state;
  return renderHook(() => useCatalogImageModels()).result.current;
}

describe("empty-catalog semantics of useCatalogImageModels", () => {
  it("fetch failure: the hook has already filled in the fallback list, it works as usual and does not count as empty", () => {
    const result = read({
      models: SHARED_MODELS,
      isLoading: false,
      isFallback: true,
      error: new Error("boom"),
    });
    expect(result.isEmpty).toBe(false);
    expect(result.models.length).toBe(SHARED_MODELS.length);
    expect(result.getModel(null)).toBeDefined();
  });

  it("loading: hold on with the fallback first and do not flash \"no available model\"", () => {
    const result = read({
      models: SHARED_MODELS,
      isLoading: true,
      isFallback: true,
      error: null,
    });
    expect(result.isEmpty).toBe(false);
    expect(result.isLoading).toBe(true);
    expect(result.models.length).toBeGreaterThan(0);
  });

  it("the endpoint succeeds but returns an empty list: this is the backend's authoritative answer and must not be covered by hard-coded models", () => {
    const result = read({
      models: [],
      isLoading: false,
      isFallback: false,
      error: null,
    });
    expect(result.isEmpty).toBe(true);
    expect(result.models).toEqual([]);
    // An old model id stored on the node must not be resurrected as a fallback model out of thin air either.
    expect(result.getModel("huimeng_gpt_image2")).toBeUndefined();
    expect(result.getModel(null)).toBeUndefined();
  });

  it("normal catalog: only the models in the catalog appear, with no fallback mixed in", () => {
    const result = read({
      models: [CATALOG_MODEL],
      isLoading: false,
      isFallback: false,
      error: null,
    });
    expect(result.isEmpty).toBe(false);
    expect(result.models.map((model) => model.id)).toEqual([CATALOG_MODEL.id]);
    expect(result.getModel(CATALOG_MODEL.apiModel)?.id).toBe(CATALOG_MODEL.id);
  });
});

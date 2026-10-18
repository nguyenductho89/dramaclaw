// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Dynamic parameters declared by the catalog (`request.parameters`) -> values on the node -> backend `model_params`.
//
// This chain used to break in two places:
//   1. `toImageModelDefinition` translated catalog parameters into the static registry's `extraParamsSchema`,
//      flattening multiselect into single-select and number/boolean options into strings, losing all types;
//   2. even when filled in, `freezoneAiGateway` read only quality from extraParams and discarded every other key
//      -- a user changing a catalog parameter on the node got nothing at submit time, with no hint at all.
// So assertions must go all the way to the ops-layer payload and watch the **value types**; testing only "is the key there"
// cannot catch item 1.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaModelParameterDefinition } from "@/api/ops";
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

const PARAMETERS: MediaModelParameterDefinition[] = [
  {
    key: "styles",
    label: "Style",
    control: "multiselect",
    requestPath: "extra_body.styles",
    options: ["anime", "photoreal", "sketch"],
  },
  {
    key: "steps",
    label: "Steps",
    control: "number",
    requestPath: "extra_body.steps",
    min: 1,
    max: 50,
    step: 1,
  },
  {
    key: "hd",
    label: "HD",
    control: "switch",
    requestPath: "extra_body.hd",
  },
  {
    key: "only_edit",
    label: "Edit only",
    control: "select",
    requestPath: "extra_body.only_edit",
    options: ["a", "b"],
    modes: ["image_to_image"],
  },
];

const CATALOG_ENTRY: CatalogImageModelEntry = {
  id: "studio-image-v1",
  providerId: "openrouter",
  apiModel: "google/gemini-2.5-flash-image-preview",
  label: "Studio Image",
  request: { endpoint: "images/generations", parameters: PARAMETERS },
};

/** Runs one real submission and returns the payload the gateway hands to the ops layer. */
async function submittedBody(
  modelParams: Record<string, unknown>,
  referenceImages: string[] = [],
): Promise<Record<string, unknown>> {
  const definition = toImageModelDefinition(CATALOG_ENTRY);
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
    modelParams,
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

describe("end-to-end round trip of catalog dynamic parameters", () => {
  it("catalog parameters hang on the definition as-is and are no longer downgraded to extraParamsSchema", () => {
    const definition = toImageModelDefinition(CATALOG_ENTRY);
    // As-is: the control type, option types and modes filter must all stay so the UI can draw multi-select and number inputs.
    expect(definition.requestParameters).toEqual(PARAMETERS);
    // The old translated artifact must be gone -- its existence would mean somewhere still draws controls from it,
    // while the submit path does not recognize the values it draws.
    expect(definition.extraParamsSchema).toBeUndefined();
  });

  it("a catalog entry without request.parameters does not conjure parameter fields", () => {
    const definition = toImageModelDefinition({
      id: "plain",
      providerId: "huimeng",
      apiModel: "huimeng_gpt_image2",
      label: "Plain",
    });
    expect(definition.requestParameters).toBeUndefined();
  });

  it("generation path: model_params are sent up as-is without type flattening", async () => {
    const body = await submittedBody({
      styles: ["anime", "sketch"],
      steps: 28,
      hd: true,
    });
    expect(body.modelParams).toEqual({
      styles: ["anime", "sketch"],
      steps: 28,
      hd: true,
    });
    // Arrays stay arrays, numbers stay numbers, booleans stay booleans -- the backend's
    // `media_model_request_schema` validates by the catalog declaration, and stringifying would be rejected outright.
    expect(Array.isArray((body.modelParams as Record<string, unknown>).styles)).toBe(true);
    expect(typeof (body.modelParams as Record<string, unknown>).steps).toBe("number");
    expect(typeof (body.modelParams as Record<string, unknown>).hd).toBe("boolean");
  });

  it("the edit path (with reference images) carries model_params too", async () => {
    const body = await submittedBody({ steps: 12 }, ["https://x/base.png"]);
    expect(body.modelParams).toEqual({ steps: 12 });
  });

  it("does not force-create an empty object when the node has no catalog parameters", async () => {
    const definition = toImageModelDefinition(CATALOG_ENTRY);
    await freezoneAiGateway.generateImage({
      prompt: "hi",
      model: definition.resolveRequest({ referenceImageCount: 0 }).requestModel,
      modelId: definition.id,
      size: "2K",
      aspectRatio: "1:1",
      referenceImages: [],
    });
    const body = submitFreezoneGen.mock.calls[0][1] as Record<string, unknown>;
    expect(body.modelParams).toBeUndefined();
  });

  it("derives the mode from the presence of reference images when none is given: text-to-image uses text_to_image", async () => {
    // Image nodes have no mode selector. With an empty mode the backend filters by "no mode",
    // and catalog parameters that declare modes get dropped wholesale -- filling them in is the same as not filling them in.
    const body = await submittedBody({ steps: 4 });
    expect(body.genMode).toBe("text_to_image");
  });

  it("derives the mode from the presence of reference images when none is given: with reference images it uses image_to_image", async () => {
    const body = await submittedBody({ only_edit: "a" }, ["https://x/base.png"]);
    expect(body.genMode).toBe("image_to_image");
  });

  it("a mode explicitly given by the caller is used and not overridden by derivation", async () => {
    // ImageEditNode has a mode selector, and omni reference / image reference are both modes the catalog recognizes,
    // so they must not be flattened by the either-or derivation here.
    const definition = toImageModelDefinition(CATALOG_ENTRY);
    await freezoneAiGateway.generateImage({
      prompt: "hi",
      model: definition.resolveRequest({ referenceImageCount: 1 }).requestModel,
      modelId: definition.id,
      size: "2K",
      aspectRatio: "1:1",
      referenceImages: ["https://x/base.png"],
      generationMode: "all_reference",
    });
    const body = submitFreezoneEdit.mock.calls[0][1] as Record<string, unknown>;
    expect(body.genMode).toBe("all_reference");
  });

  it("parameters deactivated by mode are still sent, and the backend filters them by modes", async () => {
    // Consistent with ImageGenNode's existing rule: the frontend does no modes trimming, and the backend's
    // `_resolve_catalog_request` silently filters out keys the current mode cannot use.
    // Trimming separately on the frontend would only make the two sides drift apart.
    const body = await submittedBody({ only_edit: "a", steps: 4 });
    expect(body.modelParams).toEqual({ only_edit: "a", steps: 4 });
  });
});

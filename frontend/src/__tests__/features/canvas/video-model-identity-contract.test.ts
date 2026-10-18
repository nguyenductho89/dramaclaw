// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { selectVideoModel } from "@/features/canvas/domain/catalogVideoModels";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  isHappyHorseVideoModel,
  isSeedance2VideoModel,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";

const videoFormSource = readFileSync(
  "src/features/canvas/nodes/shared/useVideoGenerationForm.ts",
  "utf8",
);

/**
 * A model catalog row of EE (media_model_catalog) — `id` / `catalogId` is a ULID primary key, and the real
 * model name is only in `apiModel`(gateway_model). The CE fallback list happens to have `id === apiModel`,
 * so any "use .id for family detection" code works fine in CE and fails across the board in EE.
 */
// Always route model names through named constants, and do not write inline `apiModel: "…"`: gitleaks' generic-api-key
// rule reports a secret when a key containing `api` is assigned a high-entropy literal (the same pattern already broke secret-scan once).
const EE_CATALOG_ULID = "01KZ58VSE52RFFDASY2T9SY4NC";
const SEEDANCE2_GATEWAY_MODEL = "seedance-2.0";
const HAPPYHORSE_GATEWAY_MODEL = "happyhorse-1.0";
const CE_SEEDANCE2_ID = "newapi_seedance-2.0";

const EE_SEEDANCE2_ROW = {
  id: EE_CATALOG_ULID,
  catalogId: EE_CATALOG_ULID,
  apiModel: SEEDANCE2_GATEWAY_MODEL,
};

describe("video model family detection against EE catalog rows", () => {
  it("EE catalog ids contain no model name — only apiModel can identify the family", () => {
    expect(isSeedance2VideoModel(EE_SEEDANCE2_ROW.id)).toBe(false);
    expect(isSeedance2VideoModel(EE_SEEDANCE2_ROW.apiModel)).toBe(true);
  });

  it("the apiModel-first, id-fallback resolution is judged correctly under both catalogs", () => {
    const resolve = (model: { id: string; apiModel?: string }) =>
      model.apiModel ?? model.id;
    expect(isSeedance2VideoModel(resolve(EE_SEEDANCE2_ROW))).toBe(true);
    // CE fallback list: when apiModel is absent, falling back to id still judges correctly.
    expect(isSeedance2VideoModel(resolve({ id: CE_SEEDANCE2_ID }))).toBe(true);
    expect(
      isHappyHorseVideoModel(
        resolve({ id: EE_CATALOG_ULID, apiModel: HAPPYHORSE_GATEWAY_MODEL }),
      ),
    ).toBe(true);
  });
});

/**
 * VideoNode has two model identifiers: `modelId`(= selectedVideoModel.id, a ULID under EE, used only as the
 * fallback for catalogId on submit) and `selectedVideoModelId`(= apiModel ?? id). **All capability checks
 * must go through the latter** — using the former makes Seedance 2.0 under EE be judged non-2.0, the all-reference submit gets blocked by the front guard
 * ("All reference supports only Seedance 2.0 models"), and video/audio upstreams no longer auto-switch the mode.
 */
describe("VideoNode feeds capability helpers the api model, not the catalog id", () => {
  it("isSeedance20Model goes through selectedVideoModelId", () => {
    expect(videoFormSource).toContain(
      "const isSeedance20Model = isSeedance2VideoModel(selectedVideoModelId);",
    );
    // In the component scope `modelId` is that ULID, and feeding it to the family check is bound to misjudge.
    // (Same-named `modelId` in other scopes of the file is an apiModel-first local/argument and is not included.)
    expect(videoFormSource).not.toContain("isSeedance2VideoModel(modelId)");
  });

  it("isHappyHorseModel likewise goes through selectedVideoModelId", () => {
    expect(videoFormSource).toContain(
      "const isHappyHorseModel = isHappyHorseVideoModel(selectedVideoModelId);",
    );
  });

  it("modelId appears in the submit params only as the fallback for catalogId", () => {
    expect(videoFormSource).toContain("selectedVideoModel?.catalogId ?? modelId");
  });
});

describe("video catalog model selection", () => {
  it("preserves an exact EE catalog id even when model names are duplicated", () => {
    const other = {
      ...EE_SEEDANCE2_ROW,
      id: "another-route",
      catalogId: "another-route",
      providerId: "huimeng",
      label: "Other route",
    } as const;
    const selected = { ...EE_SEEDANCE2_ROW, providerId: "newapi", label: "Selected route" } as const;
    expect(selectVideoModel([other, selected], EE_CATALOG_ULID)).toBe(selected);
  });

  it("resolves a workflow alias to a unique live catalog row and retains its submission id", () => {
    const row = { ...EE_SEEDANCE2_ROW, providerId: "newapi", label: "Standard" } as const;
    expect(selectVideoModel([row], "newapi_seedance-2.0")?.catalogId).toBe(EE_CATALOG_ULID);
  });

  it("does not guess a provider route from an ambiguous model alias", () => {
    const row = { ...EE_SEEDANCE2_ROW, providerId: "newapi", label: "Standard" } as const;
    const other = { ...row, id: "another-route", catalogId: "another-route" };
    expect(selectVideoModel([row, other], "seedance-2.0")).toBeUndefined();
  });

  it("preserves the existing default for missing or unavailable models", () => {
    const row = { ...EE_SEEDANCE2_ROW, providerId: "newapi", label: "Standard" } as const;
    expect(selectVideoModel([row], undefined)).toBe(row);
    expect(selectVideoModel([row], "unknown-model")).toBe(row);
    expect(selectVideoModel([], undefined)).toBeUndefined();
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/** 422 canvas_media_scope_mismatch takes the self-healing branch instead of giving up flat like "payload too large". */
import { describe, expect, it } from "vitest";
import { classifySaveError } from "@/features/freezone/canvasSyncCore";
import { enT } from "../../helpers/i18n-fixtures";

const REF = {
  node_id: "n1",
  field: "imageUrl",
  url: "/static/projects/projA/a.png",
  source_project_id: "projA",
};

describe("classifySaveError · canvas_media_scope_mismatch", () => {
  it("routes it to the self-healing branch with the refs attached", () => {
    expect(
      classifySaveError(
        422,
        { detail: { code: "canvas_media_scope_mismatch", refs: [REF] } },
        "fallback",
        enT,
      ),
    ).toEqual({ kind: "media_scope", refs: [REF] });
  });

  it("keeps 422 canvas_payload_too_large fatal", () => {
    expect(
      classifySaveError(422, { detail: { code: "canvas_payload_too_large" } }, "fallback", enT),
    ).toMatchObject({ kind: "fatal" });
  });

  it("falls back to a plain error when the backend reports no usable ref", () => {
    expect(
      classifySaveError(
        422,
        { detail: { code: "canvas_media_scope_mismatch", refs: [] } },
        "fallback",
        enT,
      ),
    ).toMatchObject({ kind: "error" });
  });
});

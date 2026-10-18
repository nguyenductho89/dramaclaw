import { describe, expect, it } from "vitest";

import {
  propReferenceAssetScope,
  sceneReferenceAssetScope,
  stageAssetScope,
} from "./task-scope";

// Golden values produced by the backend's own helpers
// (novelvideo.task_scopes) so the FE hash stays byte-compatible with the
// scope stored on task rows. If these drift, `useTaskController` reconcile
// stops matching and loading state is lost on refresh.
describe("task-scope hashing matches the backend", () => {
  it("scene_reference_asset_scope", () => {
    expect(sceneReferenceAssetScope("Dorm Room", "master")).toBe(
      "scene_ref__5e2a446c54b1",
    );
    // `reverse_master` is the kind the BE uses for the back-side image (not "reverse").
    expect(sceneReferenceAssetScope("Dorm Room", "reverse_master")).toBe(
      "scene_ref__527ff7959ca2",
    );
    expect(sceneReferenceAssetScope("Quán Trà", "master")).toBe(
      "scene_ref__9060b8ad0651",
    );
    expect(sceneReferenceAssetScope("Quán Trà", "reverse_master")).toBe(
      "scene_ref__4dcd6be9237c",
    );
  });

  it("stage_asset_scope", () => {
    expect(stageAssetScope("Dorm Room", "pano_from_master")).toBe(
      "stage_asset__bf7b8ef4bcac",
    );
    expect(stageAssetScope("Dorm Room", "pano_from_text")).toBe(
      "stage_asset__43103904df52",
    );
    expect(stageAssetScope("Dorm Room", "single_face_sharp")).toBe(
      "stage_asset__af27a14e9741",
    );
    expect(stageAssetScope("Dorm Room", "pano_sharp")).toBe(
      "stage_asset__fb4bf220c6e9",
    );
    expect(stageAssetScope("Quán Trà", "pano_from_master")).toBe(
      "stage_asset__06fbb3d5e473",
    );
    expect(stageAssetScope("Quán Trà", "pano_sharp")).toBe(
      "stage_asset__1f3c17bd0c58",
    );
  });

  it("prop_reference_asset_scope", () => {
    expect(propReferenceAssetScope("Prop A")).toBe("prop_ref__d4545b4a4d60");
    expect(propReferenceAssetScope("sword")).toBe("prop_ref__d36303bf3afe");
    expect(propReferenceAssetScope("Bảo Kiếm")).toBe("prop_ref__59459218f466");
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from "vitest";

import { getSceneDirectorStageManifest } from "@/api/viewerManifests";
import { hydrateAssetDragPayload } from "@/features/canvas/domain/assetDragHydrate";
import { spawnAssetNode } from "@/features/canvas/domain/assetDrag";
import type { CanvasAssetDragPayload } from "@/features/canvas/domain/assetDrag";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import type { ThreeDSceneSnapshot } from "@/features/viewer-kit/three-d/engine/viewerApp";
import type { DirectorStageManifest } from "@/features/viewer-kit/three-d/directorManifest";

vi.mock("@/api/viewerManifests", () => ({
  getSceneDirectorStageManifest: vi.fn(),
}));

describe("hydrateAssetDragPayload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("copies a scene director world manifest into a user-imported canvas payload", async () => {
    const scene = {
      schemaVersion: 1,
      savedAt: 1,
      actors: [
        {
          label: "actor-1",
          color: "#ff3344",
          position: [0, 0, 0],
          yawDeg: 0,
          scale: [1, 1, 1],
        },
      ],
      props: [],
      stagings: [],
      camera: { azim: 1, elev: 2, distance: 3, focalPoint: [0, 0, 0] },
    } satisfies ThreeDSceneSnapshot;
    const manifest = {
      viewer_kind: "three_d_director",
      mode: "scene",
      project: "demo",
      scene_id: "Apartment elevator lobby",
      display_name: "Apartment elevator lobby / Director world",
      source: {
        source_type: "sog",
        source_kind: "master",
        ply_url: "/static/demo/director_worlds/apartment_elevator_lobby/v1/master.sog",
      },
      sources: [
        {
          id: "front",
          label: "Front world",
          source_type: "sog",
          source_kind: "master",
          ply_url: "/static/demo/director_worlds/apartment_elevator_lobby/v1/master.sog",
        },
        {
          id: "reverse",
          label: "Back world",
          source_type: "sog",
          source_kind: "reverse",
          ply_url: "/static/demo/director_worlds/apartment_elevator_lobby/v1/reverse.sog",
        },
      ],
      active_source_id: "reverse",
      scene,
      scenes_by_source_id: {
        front: null,
        reverse: scene,
      },
      palette: { actors: [], props: [], anonymous_colors: [], anonymous_prop_colors: [] },
      allowed_destinations: ["view"],
    } satisfies DirectorStageManifest;
    vi.mocked(getSceneDirectorStageManifest).mockResolvedValueOnce(manifest);

    const payload = {
      kind: "model",
      label: "Apartment elevator lobby / Director world",
      url: "/static/demo/director_worlds/apartment_elevator_lobby/v1/reverse.sog",
      mainlineContext: [
        {
          kind: "scene",
          projectId: "demo",
          sceneId: "Apartment elevator lobby",
          role: "scene_director_world",
          label: "Apartment elevator lobby / Director world",
        },
      ],
      source: {
        kind: "scene",
        role: "scene_director_world",
        projectId: "demo",
        meta: { scene_id: "Apartment elevator lobby" },
      },
    } satisfies CanvasAssetDragPayload;

    const hydrated = await hydrateAssetDragPayload(payload);

    expect(getSceneDirectorStageManifest).toHaveBeenCalledWith("demo", "Apartment elevator lobby");
    expect(hydrated.activeSourceId).toBe("reverse");
    expect(hydrated.plyUrl).toBe("/static/demo/director_worlds/apartment_elevator_lobby/v1/reverse.sog");
    expect(hydrated.modelSources).toEqual([
      expect.objectContaining({ id: "front", label: "Front world" }),
      expect.objectContaining({ id: "reverse", label: "Back world" }),
    ]);
    expect(hydrated.scene).toBe(scene);
    expect(hydrated.scenesBySourceId).toEqual({ reverse: scene });
  });

  it("leaves non scene-director-world payloads untouched", async () => {
    const payload = {
      kind: "model",
      label: "Custom 3D",
      url: "/static/demo/custom-world.sog",
      source: { kind: "scene", role: "scene_3gs_master_ply", projectId: "demo" },
    } satisfies CanvasAssetDragPayload;

    await expect(hydrateAssetDragPayload(payload)).resolves.toBe(payload);
    expect(getSceneDirectorStageManifest).not.toHaveBeenCalled();
  });
});

describe("spawnAssetNode — restore chain model/genMode", () => {
  // Minimal fake store: captures every addNode(type, position, data) and returns a stable id. spawnAssetNode
  // uses only store.addNode, and the other methods are unused.
  function fakeStore() {
    const created: Array<{ type: string; data: Record<string, unknown> }> = [];
    const store = {
      addNode: (
        type: string,
        _position: { x: number; y: number },
        data: Record<string, unknown>,
      ) => {
        created.push({ type, data });
        return `node-${created.length}`;
      },
    } as unknown as Parameters<typeof spawnAssetNode>[0];
    return { store, created };
  }

  it("video: payload carries model/genMode -> node data.model / data.genMode are written back", () => {
    const { store, created } = fakeStore();
    const payload = {
      kind: "video",
      label: "v",
      url: "/static/p/v.mp4",
      model: "happyhouse_1_0",
      genMode: "firstLastFrame",
      source: {},
    } satisfies CanvasAssetDragPayload;

    spawnAssetNode(store, payload, { x: 0, y: 0 });

    expect(created[0]?.type).toBe(CANVAS_NODE_TYPES.video);
    expect(created[0]?.data.model).toBe("happyhouse_1_0");
    expect(created[0]?.data.genMode).toBe("firstLastFrame");
  });

  it("video: payload has no model -> data.model is not written (undefined)", () => {
    const { store, created } = fakeStore();
    const payload = {
      kind: "video",
      label: "v",
      url: "/static/p/v.mp4",
      source: {},
    } satisfies CanvasAssetDragPayload;

    spawnAssetNode(store, payload, { x: 0, y: 0 });

    expect(created[0]?.data.model).toBeUndefined();
    expect(created[0]?.data.genMode).toBeUndefined();
  });

  it("image: restoreAsGeneratedImage + model -> restored as a finished image node (imageGen) carrying back the base image and model", () => {
    const { store, created } = fakeStore();
    const payload = {
      kind: "image",
      label: "i",
      url: "/static/p/i.png",
      restoreAsGeneratedImage: true,
      model: "seedream_4_0",
      source: {},
    } satisfies CanvasAssetDragPayload;

    spawnAssetNode(store, payload, { x: 0, y: 0 });

    // imageEdit('imageNode') is a pure generation editor that does not render data.imageUrl, so restoring would be blank -- hence finished-image
    // restoration goes through imageGen('imageGenNode'): it reads data.imageUrl for direct display, is editable, and carries data.model.
    expect(created[0]?.type).toBe(CANVAS_NODE_TYPES.imageGen);
    expect(created[0]?.data.imageUrl).toBe("/static/p/i.png");
    expect(created[0]?.data.model).toBe("seedream_4_0");
  });
});

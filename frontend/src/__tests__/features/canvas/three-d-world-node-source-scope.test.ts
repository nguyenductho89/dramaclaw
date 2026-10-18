// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  directorSourcesForNode,
  isCandidateDirectorWorldNode,
  isSceneDirectorWorldNode,
} from "@/features/canvas/nodes/ThreeDWorldNode";
import type { ThreeDWorldNodeData } from "@/features/canvas/domain/canvasNodes";

describe("ThreeDWorldNode source scope", () => {
  it("keeps a custom candidate committed to a slot local-only", () => {
    const data = {
      displayName: "Submitted · Apartment elevator lobby / Front world",
      slot_target: { kind: "scene_3gs_master_ply", scene_id: "Apartment elevator lobby" },
      activeSourceId: "custom-local",
      sources: [
        {
          id: "custom-local",
          label: "Image 3DGS",
          source_type: "sog",
          source_kind: "custom",
          ply_url: "/static/projects/demo/freezone/_outputs/custom.sog",
          current: true,
        },
        {
          id: "legacy:master:sog:/static/projects/demo/director_worlds/apartment_elevator_lobby/v1/master.sog",
          label: "Front world",
          source_type: "sog",
          source_kind: "master",
          ply_url: "/static/projects/demo/director_worlds/apartment_elevator_lobby/v1/master.sog",
        },
      ],
    } satisfies Partial<ThreeDWorldNodeData> as ThreeDWorldNodeData;

    expect(isCandidateDirectorWorldNode(data)).toBe(true);
    expect(isSceneDirectorWorldNode(data)).toBe(false);
    expect(directorSourcesForNode(data, [])).toEqual([
      expect.objectContaining({ id: "custom-local", label: "Image 3DGS" }),
    ]);
  });

  it("recognizes projected mainline scene 3GS slot nodes as scene director worlds", () => {
    const data = {
      slot_target: { kind: "scene_3gs_master_ply", scene_id: "Apartment elevator lobby" },
      mainline_context: [
        {
          kind: "scene",
          projectId: "demo",
          sceneId: "Apartment elevator lobby",
          role: "scene_3gs_master_ply",
          label: "Apartment elevator lobby / Front world",
        },
      ],
      __freezone_source: {
        kind: "scene",
        role: "scene_3gs_master_ply",
        meta: { scene_id: "Apartment elevator lobby" },
      },
    } satisfies Partial<ThreeDWorldNodeData> as ThreeDWorldNodeData;

    expect(isCandidateDirectorWorldNode(data)).toBe(false);
    expect(isSceneDirectorWorldNode(data)).toBe(true);
  });

  it("does not expose mainline source slots on a user-spawned custom candidate", () => {
    const data = {
      user_spawned: true,
      activeSourceId: "custom-local",
      sources: [
        {
          id: "custom-local",
          label: "Image 3DGS",
          source_type: "sog",
          source_kind: "custom",
          ply_url: "/static/projects/demo/freezone/_outputs/custom.sog",
          current: true,
        },
        {
          id: "legacy:master:sog:/static/projects/demo/director_worlds/apartment_elevator_lobby/v1/master.sog",
          label: "Front world",
          source_type: "sog",
          source_kind: "master",
          ply_url: "/static/projects/demo/director_worlds/apartment_elevator_lobby/v1/master.sog",
        },
      ],
      mainline_context: [
        {
          kind: "scene",
          projectId: "demo",
          sceneId: "Apartment elevator lobby",
          role: "scene_3gs_master_ply",
          label: "Apartment elevator lobby / Front world",
        },
      ],
      __freezone_source: {
        kind: "scene",
        role: "scene_3gs_master_ply",
        meta: { scene_id: "Apartment elevator lobby" },
      },
    } satisfies Partial<ThreeDWorldNodeData> as ThreeDWorldNodeData;

    expect(isCandidateDirectorWorldNode(data)).toBe(true);
    expect(isSceneDirectorWorldNode(data)).toBe(false);
    expect(directorSourcesForNode(data, [])).toEqual([
      expect.objectContaining({ id: "custom-local", label: "Image 3DGS" }),
    ]);
  });

  it("treats imported mainline scene worlds as editable candidates while preserving source choices", () => {
    const data = {
      user_spawned: true,
      activeSourceId: "legacy:reverse:sog:/static/projects/demo/director_worlds/apartment_elevator_lobby/v1/reverse.sog",
      sources: [
        {
          id: "legacy:master:sog:/static/projects/demo/director_worlds/apartment_elevator_lobby/v1/master.sog",
          label: "Front world",
          source_type: "sog",
          source_kind: "master",
          ply_url: "/static/projects/demo/director_worlds/apartment_elevator_lobby/v1/master.sog",
        },
        {
          id: "legacy:reverse:sog:/static/projects/demo/director_worlds/apartment_elevator_lobby/v1/reverse.sog",
          label: "Back world",
          source_type: "sog",
          source_kind: "reverse",
          ply_url: "/static/projects/demo/director_worlds/apartment_elevator_lobby/v1/reverse.sog",
          current: true,
        },
      ],
      mainline_context: [
        {
          kind: "scene",
          projectId: "demo",
          sceneId: "Apartment elevator lobby",
          role: "scene_director_world",
          label: "Apartment elevator lobby / Director world",
        },
      ],
      __freezone_source: {
        kind: "scene",
        role: "scene_director_world",
        meta: { scene_id: "Apartment elevator lobby" },
      },
    } satisfies Partial<ThreeDWorldNodeData> as ThreeDWorldNodeData;

    expect(isCandidateDirectorWorldNode(data)).toBe(true);
    expect(isSceneDirectorWorldNode(data)).toBe(false);
    expect(directorSourcesForNode(data, [])).toEqual([
      expect.objectContaining({ label: "Front world" }),
      expect.objectContaining({ label: "Back world" }),
    ]);
  });
});

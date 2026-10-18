// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";
import { buildChatTaskLabel } from "@/features/superchat/task-notification-label";
import type { TaskState } from "@/task-center/types";

import { enT } from "../../helpers/i18n-fixtures";

// Real translation table: a mistyped key or a missing entry throws on the spot instead of silently echoing the key.
const t = enT as unknown as (key: string, options?: Record<string, unknown>) => string;

function task(overrides: Partial<TaskState>): TaskState {
  return {
    task_key: "task:demo",
    task_id: "id-demo",
    task_type: "unknown",
    username: "alice",
    project: "demo",
    project_id: "demo",
    episode: 0,
    beat_num: null,
    scope: null,
    status: "completed",
    progress: 1,
    current_task: "completed",
    result: null,
    error: null,
    logs: [],
    created_at: "",
    updated_at: "",
    completed_at: "",
    ...overrides,
  };
}

describe("buildChatTaskLabel", () => {
  it("uses scene result fields for scene reference tasks", () => {
    expect(
      buildChatTaskLabel(
        task({
          task_type: "scene_reference_asset",
          result: { scene_name: "University dorm", kind: "master" },
        }),
        t,
      ),
    ).toBe("University dorm — master reference");
  });

  it("uses character result fields for portraits", () => {
    expect(
      buildChatTaskLabel(
        task({
          task_type: "character_portrait",
          result: { mode: "portrait", character_name: "Sutang" },
        }),
        t,
      ),
    ).toBe("Sutang portrait");
  });

  it("uses identity result fields for identity images", () => {
    expect(
      buildChatTaskLabel(
        task({
          task_type: "identity_image",
          result: { character_name: "Sutang", identity_name: "College student" },
        }),
        t,
      ),
    ).toBe("Sutang — “College student” identity image");
  });

  it("falls back to scope when result omits names", () => {
    expect(
      buildChatTaskLabel(
        task({
          task_type: "character_portrait",
          scope: "character:Sutang:identity_portrait:College student",
          result: {},
        }),
        t,
      ),
    ).toBe("Sutang — “College student” identity portrait");
  });

  it("derives sketch grid labels from result metadata", () => {
    expect(
      buildChatTaskLabel(
        task({
          task_type: "sketch_generation",
          episode: 1,
          result: {
            grid_index: 0,
            total_grids: 2,
            beat_numbers: [1, 2, 3, 4, 5],
          },
        }),
        t,
      ),
    ).toBe("Ep 1 · Sketch grid 1/2 (Beat 1-5)");
  });

  it("keeps non-contiguous sketch beat ranges readable", () => {
    expect(
      buildChatTaskLabel(
        task({
          task_type: "sketch_generation",
          episode: 1,
          result: {
            grid_index: 1,
            total_grids: 2,
            beat_numbers: [26, 27, 29, 30, 37],
          },
        }),
        t,
      ),
    ).toBe("Ep 1 · Sketch grid 2/2 (Beat 26-27, 29-30, 37)");
  });
});

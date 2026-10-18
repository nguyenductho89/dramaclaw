// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, it, expect } from "vitest";
import { sampleTask } from "@/__mocks__/msw/handlers/tasks";
import {
  isTerminal,
  isActive,
  ageMs,
  currentTaskText,
  displayLabel,
  originDeepLink,
  taskLogLines,
  taskLogLinesOf,
} from "@/task-center/derivations";

import { enT } from "../helpers/i18n-fixtures";

describe("isTerminal", () => {
  it("returns true for completed", () => expect(isTerminal(sampleTask({ status: "completed" }))).toBe(true));
  it("returns true for failed", () => expect(isTerminal(sampleTask({ status: "failed" }))).toBe(true));
  it("returns false for running", () => expect(isTerminal(sampleTask({ status: "running" }))).toBe(false));
  it("returns false for submitting", () => expect(isTerminal(sampleTask({ status: "submitting" }))).toBe(false));
  it("returns false for pending", () => expect(isTerminal(sampleTask({ status: "pending" }))).toBe(false));
  it("returns false for starting", () => expect(isTerminal(sampleTask({ status: "starting" }))).toBe(false));
});

describe("isActive", () => {
  it("returns true for submitting/queued/pending/starting/running", () => {
    expect(isActive(sampleTask({ status: "submitting" }))).toBe(true);
    expect(isActive(sampleTask({ status: "queued" }))).toBe(true);
    expect(isActive(sampleTask({ status: "pending" }))).toBe(true);
    expect(isActive(sampleTask({ status: "starting" }))).toBe(true);
    expect(isActive(sampleTask({ status: "running" }))).toBe(true);
  });
  it("returns false for terminal", () => {
    expect(isActive(sampleTask({ status: "completed" }))).toBe(false);
    expect(isActive(sampleTask({ status: "failed" }))).toBe(false);
  });
});

describe("ageMs", () => {
  it("computes ms since updated_at", () => {
    const task = sampleTask({ updated_at: "2026-04-18T14:33:12Z" });
    const now = new Date("2026-04-18T14:33:42Z").getTime();
    expect(ageMs(task, now)).toBe(30_000);
  });
});

describe("displayLabel", () => {
  it.each([
    ["freezone_agent_workflow_result", "Create workflow"],
    ["freezone_agent_recipe_result", "Generate Recipe"],
    ["freezone_workflow_confirm", "Confirm workflow"],
  ])("labels %s without exposing the operation scope", (task_type, label) => {
    const task = sampleTask({ task_type, episode: 0, scope: "agent_product_123" });
    expect(displayLabel(task, enT)).toBe(label);
    expect(task.scope).toBe("agent_product_123");
  });

  it("hides the internal workflow draft scope", () => {
    const task = sampleTask({
      task_type: "freezone_workflow_confirm",
      episode: 0,
      scope: "user_admin_en845w:workflow_draft_abc:1",
    });
    expect(displayLabel(task, enT)).toBe("Confirm workflow");
  });

  it("hides the opaque video job id from freezone video titles", () => {
    const task = sampleTask({
      task_type: "freezone_video_gen",
      episode: 0,
      scope: "043a194450664f66",
    });
    expect(displayLabel(task, enT)).toBe("Generate Freezone video");
  });

  it("preserves a supplied workflow name without inventing one from its ID", () => {
    const task = sampleTask({
      task_type: "freezone_agent_workflow_result", episode: 0,
      scope: "agent_product_123", metadata: { workflow_name: "Rainy Night Robot" },
    });
    expect(displayLabel(task, enT)).toBe("Create workflow · Rainy Night Robot");
  });

  // Run against the real locale table: the display_name the backend sends is only a fallback, and the UI must show the one from the locale entries.
  const t = enT as unknown as (k: string, opts?: Record<string, unknown>) => string;

  it("localizes base task type", () => {
    expect(displayLabel(sampleTask({ task_type: "sketch_regen", episode: 3 }), t)).toBe(
      "Sketch regen · ep3",
    );
  });
  it("rebuilds the label when the backend display name is just the type + episode", () => {
    expect(
      displayLabel(
        sampleTask({
          task_type: "episode_scene_planner",
          episode: 3,
          display_name: "Plan scenes · ep3",
        }),
        t,
      ),
    ).toBe("Plan scenes · ep3");
  });
  it("keeps a caller-authored display name untouched", () => {
    expect(
      displayLabel(
        sampleTask({
          task_type: "freezone_gen",
          episode: 0,
          display_name: "Rainy Alley · Version 2",
          display_name_localizable: false,
        }),
        t,
      ),
    ).toBe("Rainy Alley · Version 2");
  });
  // review #447: the display_name that freezone/scripts send from the backend is fixed text ("Generate sketch · EP1 / Beat 3"),
  // which was once marked localizable=false as business content, so other UI languages still leaked it. These two cases pin the rebuild path.
  it("rebuilds freezone display names that are hardcoded Chinese on the backend", () => {
    expect(
      displayLabel(
        sampleTask({
          task_type: "sketch_regen",
          episode: 1,
          beat_num: 3,
          display_name: "Generate sketch · EP1 / Beat 3",
        }),
        t,
      ),
    ).toBe("Sketch regen · ep1 · beat 3");
  });
  it("keeps scene_name when rebuilding a scene-scoped label", () => {
    expect(
      displayLabel(
        sampleTask({
          task_type: "scene_360",
          episode: 0,
          display_name: "Generate 360 panorama · Palace Hall",
          metadata: { scene_name: "Palace Hall" },
        }),
        t,
      ),
    ).toContain("Palace Hall");
  });
  it("composes stage asset labels from metadata", () => {
    expect(
      displayLabel(
        sampleTask({
          task_type: "stage_asset",
          episode: 0,
          display_name: "Scene asset · Palace Hall · Single face to SOG",
          metadata: { scene_name: "Palace Hall", step: "single_face_sharp" },
        }),
        t,
      ),
    ).toBe("Scene asset · Palace Hall · Single face to SOG");
  });
  it("falls back to the backend label for task types with no entry yet", () => {
    expect(
      displayLabel(
        sampleTask({
          task_type: "brand_new_task",
          episode: 0,
          task_type_label: "Brand new task",
        }),
        t,
      ),
    ).toBe("Brand new task");
  });
  it("appends beat when present", () => {
    expect(displayLabel(sampleTask({ task_type: "single_video", episode: 3, beat_num: 7 }), t)).toBe(
      "Single video · ep3 · beat 7",
    );
  });
  it("appends scope when present", () => {
    expect(displayLabel(sampleTask({ task_type: "sketch_regen", episode: 3, scope: "regen__abc" }), t)).toBe(
      "Sketch regen · ep3 · regen__abc",
    );
  });
  it("hides internal episode asset planner run scopes", () => {
    expect(
      displayLabel(
        sampleTask({
          task_type: "episode_scene_planner",
          episode: 3,
          scope: "scene_run_abc123",
        }),
        t,
      ),
    ).toBe("Plan scenes · ep3");
    expect(
      displayLabel(
        sampleTask({
          task_type: "episode_prop_planner",
          episode: 3,
          scope: "prop_run_abc123",
        }),
        t,
      ),
    ).toBe("Plan props · ep3");
  });
});

describe("currentTaskText", () => {
  const t = enT as unknown as (k: string, opts?: Record<string, unknown>) => string;

  it("replaces the backend terminal sentinel with the localized status", () => {
    expect(currentTaskText(sampleTask({ status: "completed", current_task: "Done" }), t)).toBe(
      "Completed",
    );
    expect(currentTaskText(sampleTask({ status: "completed", current_task: "done" }), t)).toBe(
      "Completed",
    );
  });
  it("keeps real progress text as the backend sent it", () => {
    expect(
      currentTaskText(sampleTask({ status: "running", current_task: "Writing beats..." }), t),
    ).toBe("Writing beats...");
    expect(
      currentTaskText(sampleTask({ status: "completed", current_task: "Generating 12 Beats" }), t),
    ).toBe("Generating 12 Beats");
  });
  it("returns empty for a blank current task", () => {
    expect(currentTaskText(sampleTask({ status: "running", current_task: "" }), t)).toBe("");
  });
  it("translates via the backend code when one is present", () => {
    const task = sampleTask({
      status: "running",
      current_task: "Reading and validating source text...",
      current_task_code: "tasks.progress.ingest.reading",
    });
    expect(currentTaskText(task, enT as unknown as typeof t)).toBe(
      "Reading and validating source text...",
    );
    expect(currentTaskText(task, t)).toBe("Reading and validating source text...");
  });
  it("falls back to the backend text when the code has no catalog entry", () => {
    // When the backend sends a new code before the frontend entries catch up, the user sees the backend text, not a bare key.
    const task = sampleTask({
      status: "running",
      current_task: "Some progress not translated yet",
      current_task_code: "tasks.progress.ingest.notYetTranslated",
    });
    expect(currentTaskText(task, enT as unknown as typeof t)).toBe("Some progress not translated yet");
  });
});

describe("taskLogLines", () => {
  const t = enT as unknown as (k: string, opts?: Record<string, unknown>) => string;

  it("translates structured entries and interpolates their params", () => {
    expect(
      taskLogLines(
        [
          {
            text: "File read: 1234 characters",
            code: "tasks.log.ingest.readComplete",
            params: { charCount: 1234 },
          },
        ],
        enT as unknown as typeof t,
      ),
    ).toEqual(["File read: 1234 characters"]);
  });
  it("passes plain strings through untouched", () => {
    // Backend call sites not migrated yet send plain strings directly, and they must not be dropped.
    expect(taskLogLines(["Source text saved", "Task started"], t)).toEqual(["Source text saved", "Task started"]);
  });
  it("keeps structured and plain entries side by side", () => {
    expect(
      taskLogLines(
        [{ text: "Source text saved", code: "tasks.log.ingest.sourceSaved" }, "Task started"],
        enT as unknown as typeof t,
      ),
    ).toEqual(["Source text saved", "Task started"]);
  });
  it("returns an empty array for a missing logs field", () => {
    expect(taskLogLines(undefined, t)).toEqual([]);
  });
});

describe("taskLogLinesOf", () => {
  const t = enT as unknown as (k: string, opts?: Record<string, unknown>) => string;

  it("prefers the structured logs_i18n field", () => {
    expect(
      taskLogLinesOf(
        {
          logs: ["Source text saved"],
          logs_i18n: [{ text: "Source text saved", code: "tasks.log.ingest.sourceSaved" }],
        },
        enT as unknown as typeof t,
      ),
    ).toEqual(["Source text saved"]);
  });
  it("falls back to logs when the backend predates logs_i18n", () => {
    // The other half of a rolling release: an old backend only sends `logs`, and the new frontend must still display them.
    expect(taskLogLinesOf({ logs: ["Source text saved", "Task started"] }, t)).toEqual([
      "Source text saved",
      "Task started",
    ]);
  });
  it("returns an empty array when neither field is present", () => {
    expect(taskLogLinesOf({}, t)).toEqual([]);
    expect(taskLogLinesOf(undefined, t)).toEqual([]);
  });
});

describe("originDeepLink", () => {
  it("returns route info for sketch-family tasks", () => {
    const link = originDeepLink(sampleTask({ task_type: "sketch_regen", project: "demo", episode: 3 }));
    expect(link).toEqual({
      to: "/projects/$project/episodes/$episode/sketches",
      params: { project: "demo", episode: "3" },
    });
  });
  it("returns null for project-level task types (no episode stage)", () => {
    expect(originDeepLink(sampleTask({ task_type: "build_characters" }))).toBeNull();
  });
  it("returns null for unknown task types", () => {
    expect(originDeepLink(sampleTask({ task_type: "no_such_type_ever" }))).toBeNull();
  });
});

it.each([
  ["freezone_image_vectorize", "Generate vector image", "Generate vector image"],
  ["freezone_image_animate_gif", "Convert animated GIF", "Convert animated GIF"],
])("labels %s without internal job IDs", (task_type, zh, en) => {
  const task = sampleTask({ task_type, scope: "opaque-job-gif" });
  expect(displayLabel(task, enT)).toBe(zh);
  expect(displayLabel(task, enT)).toBe(en);
});

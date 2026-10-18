// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, renderHook } from "@testing-library/react";
import i18next from "i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { sampleTask } from "@/__mocks__/msw/handlers/tasks";
import { useTaskCenterStore } from "@/task-center/store";
import { useTaskActivity } from "@/task-center/use-task-activity";
import type { TaskState } from "@/task-center/types";

import { enTranslation } from "../helpers/i18n-fixtures";

const buildScenes = (overrides: Partial<TaskState> = {}): TaskState =>
  sampleTask({
    task_key: "task:build_scenes:alice:demo:0",
    task_type: "build_scenes",
    episode: 0,
    status: "running",
    progress: 0.4,
    current_task: "Extracting scenes…",
    ...overrides,
  });

/** Simulates the provider taking over the project: setProject happens first, hydration arrives later. */
function mountProvider(projectId = "demo") {
  act(() => {
    useTaskCenterStore.getState().setProject(projectId);
  });
}

/** Simulates the task center hydration completing (what the provider does after the first GET /tasks). */
function hydrateWith(tasks: TaskState[]) {
  act(() => {
    useTaskCenterStore.getState().hydrate(tasks);
    useTaskCenterStore.getState().markHydrated();
  });
}

function render() {
  return renderHook(() => useTaskActivity("build_scenes", { episode: 0 }));
}

beforeEach(() => {
  useTaskCenterStore.getState().reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  useTaskCenterStore.getState().reset();
});

describe("useTaskActivity", () => {
  it("reports isRestoring before hydration completes, and isActive is not trustworthy then", () => {
    const { result } = render();
    mountProvider();
    // Initial state after a hard refresh: the store is empty, but only because /tasks has not been fetched yet.
    expect(result.current.isRestoring).toBe(true);
    expect(result.current.isActive).toBe(false);

    hydrateWith([buildScenes()]);

    expect(result.current.isRestoring).toBe(false);
    expect(result.current.isActive).toBe(true);
  });

  it("does not report isRestoring when no provider is running, so a button is not disabled forever", () => {
    const { result } = render();
    // The component is rendered outside TaskCenterProvider: hydration will never arrive.
    expect(result.current.isRestoring).toBe(false);
    expect(result.current.isActive).toBe(false);
  });

  it("after hydration, recognizes tasks still running in the background, and surfaces progress and step text", () => {
    const { result } = render();
    hydrateWith([buildScenes({ progress: 0.4, current_task: "Extracting scenes…" })]);

    expect(result.current.isActive).toBe(true);
    expect(result.current.progress).toBe(0.4);
    expect(result.current.currentTask).toBe("Extracting scenes…");
    expect(result.current.task?.task_type).toBe("build_scenes");
  });

  it("step text is localized by current_task_code, and does not leak the backend's fallback text", async () => {
    // review #462: the scene build page renders this string directly, and it used to return task.current_task,
    // so the English UI would show progress in the backend language all the way through a build task.
    i18next.addResourceBundle("en", "translation", enTranslation, true, true);
    await act(async () => {
      await i18next.changeLanguage("en");
    });
    try {
      const { result } = render();
      hydrateWith([
        buildScenes({
          current_task: "Extracting base scenes from scene headings…",
          current_task_code: "tasks.progress.scenes.extractingFromHeadings",
        }),
      ]);

      expect(result.current.currentTask).toBe(
        "Extracting base scenes from scene headings…",
      );
    } finally {
      await act(async () => {
        await i18next.changeLanguage("en");
      });
    }
  });

  it("echoes the backend text as before when the backend has no code yet, instead of a bare key", () => {
    const { result } = render();
    hydrateWith([buildScenes({ current_task: "Extracting scenes…" })]);

    expect(result.current.currentTask).toBe("Extracting scenes…");
  });

  it("ignores tasks of other types and other episodes", () => {
    const { result } = render();
    hydrateWith([
      sampleTask({ task_key: "a", task_type: "build_characters", episode: 0 }),
      buildScenes({ task_key: "b", episode: 3 }),
    ]);

    expect(result.current.isActive).toBe(false);
  });

  it("a terminal task does not count as active", () => {
    const { result } = render();
    hydrateWith([buildScenes({ status: "completed", progress: 1 })]);

    expect(result.current.isActive).toBe(false);
  });

  it("markStarted covers the gap before the task enters the task center", () => {
    const { result } = render();
    hydrateWith([]);
    expect(result.current.isActive).toBe(false);

    act(() => result.current.markStarted());
    expect(result.current.isActive).toBe(true);

    // The task then arrives from SSE and takes over loading.
    act(() => {
      useTaskCenterStore.getState().upsert(buildScenes());
    });
    expect(result.current.isActive).toBe(true);
    expect(result.current.task).not.toBeNull();
  });

  it("when the task never appears, the optimistic window retracts loading when the time is up", () => {
    const { result } = render();
    hydrateWith([]);

    act(() => result.current.markStarted());
    expect(result.current.isActive).toBe(true);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.isActive).toBe(false);
  });

  it("when SSE arrives before the enqueue response, loading is retracted as soon as the task finishes (no idle wait of 15 seconds)", () => {
    const { result } = render();
    hydrateWith([]);

    // First receive the task pushed by SSE...
    act(() => {
      useTaskCenterStore.getState().upsert(buildScenes());
    });
    // ...the enqueue API only returns now, and the component calls markStarted() as usual.
    act(() => result.current.markStarted());
    expect(result.current.isActive).toBe(true);

    // Task completes: the active task disappears, and the optimistic marker must retire with it.
    act(() => {
      useTaskCenterStore.getState().upsert(buildScenes({ status: "completed", progress: 1 }));
    });
    expect(result.current.isActive).toBe(false);

    // Even if time advances to the timeout point, there should be no rebound.
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.isActive).toBe(false);
  });

  it("when the very first sample hits a terminal state, loading is retracted at once by task_id", () => {
    const { result } = render();
    hydrateWith([]);

    act(() => result.current.markStarted({ taskId: "run-2" }));
    expect(result.current.isActive).toBe(true);

    // With polling fallback (5s) the task finishes between two samples: when this round of GET /tasks comes back
    // it is already terminal, and the active state was never observed from start to finish.
    act(() => {
      useTaskCenterStore
        .getState()
        .hydrate([buildScenes({ task_id: "run-2", status: "completed", progress: 1 })]);
    });

    expect(result.current.isActive).toBe(false);
  });

  it("when a task fails right after enqueue, loading is retracted at once by task_id", () => {
    const { result } = render();
    hydrateWith([]);

    act(() => result.current.markStarted({ taskId: "run-2" }));
    act(() => {
      useTaskCenterStore
        .getState()
        .upsert(buildScenes({ task_id: "run-2", status: "failed", error: "boom" }));
    });

    expect(result.current.isActive).toBe(false);
  });

  it("an old terminal record from the previous round must not clear the new round's optimistic window early", () => {
    const { result } = render();
    // task_key is reused across rounds, and the record of the round that finished stays in the store until pruned.
    hydrateWith([buildScenes({ task_id: "run-1", status: "completed", progress: 1 })]);

    act(() => result.current.markStarted({ taskId: "run-2" }));

    // The new round has only just been enqueued and the task center has not updated yet: loading must still continue.
    expect(result.current.isActive).toBe(true);
  });

  it("falls back to the 15-second cover when no task_id was obtained, without hurting old callers", () => {
    const { result } = render();
    hydrateWith([buildScenes({ task_id: "run-1", status: "completed", progress: 1 })]);

    act(() => result.current.markStarted());
    expect(result.current.isActive).toBe(true);

    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    expect(result.current.isActive).toBe(false);
  });

  it("once the task finishes normally, loading is retracted", () => {
    const { result } = render();
    hydrateWith([buildScenes()]);
    expect(result.current.isActive).toBe(true);

    act(() => {
      useTaskCenterStore.getState().upsert(buildScenes({ status: "completed", progress: 1 }));
    });
    expect(result.current.isActive).toBe(false);
    expect(result.current.progress).toBe(0);
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Wait-budget semantics: a task only counts as detached once "the server no longer reports it"; neither queueing nor execution consumes
// the budget. Heavy backend tasks (video / image / ffmpeg / stage_asset / image-to-3gs) have an execution cap
// of 30 minutes (NEWAPI_VIDEO_HTTP_TIMEOUT_SECONDS in generators/video_generator.py,
// NEWAPI_IMAGE_HTTP_TIMEOUT_SECONDS in nanobanana_grid.py, and
// _run_cmd(timeout=1800) in freezone/jobs.py), and production queueing comes on top of that, so a flat wall-clock cutoff would inevitably kill live tasks.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { apiCall } from "@/api/client";
import type { TaskPollTimeoutError, TaskState } from "@/api/tasks";

vi.mock("@/api/client", () => ({
  apiCall: vi.fn(async () => []),
}));

const listTasksMock = vi.mocked(apiCall);

/** Make the shared poller answer with this task list from now on. */
function serverReports(tasks: Partial<TaskState>[]): void {
  listTasksMock.mockImplementation(async () => tasks as TaskState[]);
}

function task(taskKey: string, status: TaskState["status"]): Partial<TaskState> {
  return { task_key: taskKey, task_type: "freezone_video_generate", status };
}

class MockEventSource {
  static instances: MockEventSource[] = [];
  readyState = 1;
  onerror: ((event: Event) => void) | null = null;

  constructor(public readonly url: string) {
    MockEventSource.instances.push(this);
  }

  addEventListener() {}
  close() {
    this.readyState = 2;
  }
}

/** Drive the 4s shared poller forward without waiting in real time. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

// tasks.ts keeps its pending map / SSE stream / poller in module state, and a
// test that leaves a job pending would otherwise strand the shared poller's
// timer when the fake clock is torn down — the next test's poller sees
// `pollersByProject.has(project)` and never schedules a tick. Reload the module
// per test so every case gets its own monitor.
let tasks: typeof import("@/api/tasks");

beforeEach(async () => {
  MockEventSource.instances.length = 0;
  // @ts-expect-error test EventSource replacement
  globalThis.EventSource = MockEventSource;
  listTasksMock.mockReset();
  serverReports([]);
  vi.useFakeTimers();
  vi.resetModules();
  tasks = await import("@/api/tasks");
});

afterEach(() => {
  vi.useRealTimers();
});

describe("budget is idle-time, not wall-clock", () => {
  it("follows a job that queues 10 minutes and then runs 28", async () => {
    const settled = vi.fn();
    serverReports([task("video-key", "queued")]);
    const promise = tasks.awaitTaskCompletion("video-key", "demo", {
      taskType: "freezone_video_generate",
    }).then(settled, settled);

    // 10 minutes of queueing -- under the old wall-clock budget this time was deducted from the execution budget.
    await advance(10 * 60 * 1000);
    expect(settled).not.toHaveBeenCalled();

    serverReports([task("video-key", "running")]);
    // 28 minutes of execution plus queueing totals 38 minutes > the 35-minute budget.
    await advance(28 * 60 * 1000);
    expect(settled).not.toHaveBeenCalled();

    serverReports([
      { ...task("video-key", "completed"), result: { output_url: "u" } },
    ]);
    await advance(10_000);
    await promise;

    expect(settled).toHaveBeenCalledTimes(1);
    expect((settled.mock.calls[0][0] as TaskState).status).toBe("completed");
  });

  it("never detaches a job the server keeps reporting as running", async () => {
    const settled = vi.fn();
    serverReports([task("long-key", "running")]);
    void tasks.awaitTaskCompletion("long-key", "demo", {
      taskType: "freezone_video_generate",
    }).then(settled, settled);

    await advance(3 * tasks.LONG_JOB_MAX_POLL_MS);

    expect(settled).not.toHaveBeenCalled();
  });

  it("detaches once the task record goes missing for a whole budget", async () => {
    const settled = vi.fn();
    serverReports([task("gone-key", "running")]);
    const promise = tasks.awaitTaskCompletion("gone-key", "demo", {
      taskType: "freezone_video_generate",
    }).then(settled, settled);

    await advance(5 * 60 * 1000);
    expect(settled).not.toHaveBeenCalled();

    // The task record disappears (cleaned up / not found) -- this is the signal for the frontend to stop.
    serverReports([]);
    await advance(tasks.LONG_JOB_MAX_POLL_MS - 60_000);
    expect(settled).not.toHaveBeenCalled();

    await advance(120_000);
    await promise;

    const error = settled.mock.calls[0][0];
    expect(tasks.isTaskPollTimeoutError(error)).toBe(true);
    expect((error as TaskPollTimeoutError).taskKey).toBe("gone-key");
    expect((error as TaskPollTimeoutError).lastStatus).toBe("running");
    // Idle time is counted from the last time the task was heard from, not from submission.
    expect((error as TaskPollTimeoutError).idleMs).toBeGreaterThanOrEqual(
      tasks.LONG_JOB_MAX_POLL_MS,
    );
    expect((error as TaskPollTimeoutError).waitedMs).toBeGreaterThan(
      (error as TaskPollTimeoutError).idleMs,
    );
  });

  it("detaches when the task list itself stays unreachable", async () => {
    const settled = vi.fn();
    listTasksMock.mockImplementation(async () => {
      throw new Error("network down");
    });
    const promise = tasks.awaitTaskCompletion("offline-key", "demo", {
      taskType: "freezone_video_generate",
    }).then(settled, settled);

    await advance(tasks.LONG_JOB_MAX_POLL_MS - 60_000);
    expect(settled).not.toHaveBeenCalled();

    serverReports([]);
    await advance(120_000);
    await promise;

    expect(tasks.isTaskPollTimeoutError(settled.mock.calls[0][0])).toBe(true);
  });
});

describe("budget sizing per task type", () => {
  it("times out short-ceiling tasks on the default budget", async () => {
    const settled = vi.fn();
    const promise = tasks.awaitTaskCompletion("translate-key", "demo", {
      taskType: "freezone_text_translate",
    }).then(settled, settled);

    await advance(tasks.DEFAULT_MAX_POLL_MS - 60_000);
    expect(settled).not.toHaveBeenCalled();

    await advance(120_000);
    await promise;

    expect(tasks.isTaskPollTimeoutError(settled.mock.calls[0][0])).toBe(true);
  });

  it("keeps the default budget for callers that pass no task type", async () => {
    const settled = vi.fn();
    const promise = tasks.awaitTaskCompletion("bare-key", "demo").then(
      settled,
      settled,
    );

    await advance(tasks.DEFAULT_MAX_POLL_MS + 60_000);
    await promise;

    expect(tasks.isTaskPollTimeoutError(settled.mock.calls[0][0])).toBe(true);
  });

  it("covers the backend's 30-minute ceiling for heavy task types", () => {
    expect(tasks.LONG_JOB_MAX_POLL_MS).toBeGreaterThan(30 * 60 * 1000);
    for (const taskType of [
      "freezone_video_generate",
      "freezone_video_upscale",
      "freezone_image_generate",
      "freezone_image_upscale",
      "freezone_audio_separate",
      "stage_asset",
    ]) {
      expect(tasks.pollTimeoutForTaskType(taskType)).toBe(tasks.LONG_JOB_MAX_POLL_MS);
    }
  });

  it("gives SeedVR2 upscale a budget longer than the server's 2h estimate for a 35s clip", () => {
    expect(tasks.pollTimeoutForTaskType("freezone_video_upscale_seedvr2")).toBe(tasks.SEEDVR2_UPSCALE_MAX_POLL_MS);
    expect(tasks.SEEDVR2_UPSCALE_MAX_POLL_MS).toBeGreaterThan(2 * 60 * 60 * 1000);
    expect(tasks.SEEDVR2_UPSCALE_MAX_POLL_MS).toBeGreaterThan(tasks.LONG_JOB_MAX_POLL_MS);
  });

  it("defaults unknown task types to the long budget", () => {
    // When a new backend task type is not registered, prefer waiting longer: waiting too long only delays the fallback,
    // while waiting too short reports a still-running task as failed.
    expect(tasks.pollTimeoutForTaskType("freezone_some_new_job")).toBe(
      tasks.LONG_JOB_MAX_POLL_MS,
    );
    expect(tasks.pollTimeoutForTaskType(null)).toBe(tasks.LONG_JOB_MAX_POLL_MS);
  });
});

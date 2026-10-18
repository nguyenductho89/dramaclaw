// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The task row of a selected-beats regenerate (`sketch_regen` / `selected_regen`) has `beat_num` = None,
 * and the scope is computed by the server as `mode_key__sha1(beats)`, which the frontend cannot reverse. So the sketch /
 * render panels of every beat subscribe to the same registry entry with the same `taskType|project|episode` key,
 * and when one beat is running the panels of the other beats show "generating" as well.
 *
 * The fix: the task row carries the beat numbers covered by this run in its metadata, the controller attaches them to the snapshot,
 * and the panel decides by `covers(beatNum)` whether to show the progress bar. The design of sharing one SSE stream is unchanged.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskControllerProvider } from "@/components/episode/task-controller-provider";
import type { Task } from "@/types/task";

const state = vi.hoisted(() => ({
  tasks: [] as Task[],
}));

vi.mock("@/hooks/use-task-stream", () => ({
  useTaskStream: () => ({
    status: "idle" as const,
    progress: 0,
    currentTask: "",
    result: null,
    error: null,
    logs: [],
  }),
}));

vi.mock("@/lib/queries/tasks", () => ({
  useTasks: () => ({ data: { ok: true, data: state.tasks } }),
  useCancelTask: () => ({
    mutateAsync: vi.fn().mockResolvedValue({ ok: true, data: null }),
    isPending: false,
  }),
}));

import { useTaskController } from "@/hooks/use-task-controller";

const KEY = { taskType: "sketch_regen", project: "demo", episode: 1 } as const;

function wrap(children: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <QueryClientProvider client={qc}>
      <TaskControllerProvider project="demo" episode={1}>
        {children}
      </TaskControllerProvider>
    </QueryClientProvider>
  );
}

function renderController() {
  return renderHook(() => useTaskController({ key: { ...KEY } }), {
    wrapper: ({ children }) => wrap(children),
  });
}

function runningRegen(overrides: Partial<Task> = {}): Task {
  return {
    task_type: "sketch_regen",
    username: "u",
    project: "demo",
    episode: 1,
    status: "running",
    progress: 0.2,
    scope: "sketch_1x1__ab12cd34ef56",
    ...overrides,
  };
}

beforeEach(() => {
  state.tasks = [];
});

describe("useTaskController beat coverage", () => {
  it("the beat number passed to start() decides which panels show generating", () => {
    const { result } = renderController();

    act(() => {
      result.current.start({ scope: "sketch_1x1__ab12cd34ef56", beatNumbers: [9] });
    });

    expect(result.current.started).toBe(true);
    expect(result.current.covers(9)).toBe(true);
    // This is exactly the bug the user saw: beat 11 is not running, yet the panel spins too.
    expect(result.current.covers(11)).toBe(false);
  });

  it("restores the covered range from the task row's metadata.beat_numbers after a refresh", async () => {
    state.tasks = [runningRegen({ metadata: { beat_numbers: [9] } })];

    const { result } = renderController();

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(9)).toBe(true);
    expect(result.current.covers(11)).toBe(false);
  });

  it("when a batch regenerate covers several beats, all those beats count as running", async () => {
    state.tasks = [runningRegen({ metadata: { beat_numbers: [9, 10, 12] } })];

    const { result } = renderController();

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(10)).toBe(true);
    expect(result.current.covers(12)).toBe(true);
    expect(result.current.covers(11)).toBe(false);
  });

  it("falls back to the old behaviour when the task row carries no beat numbers, without hiding a beat that is really running", async () => {
    // Old task rows (enqueued before the backend added metadata) and backends that do not know this field both end up here.
    state.tasks = [runningRegen()];

    const { result } = renderController();

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(9)).toBe(true);
    expect(result.current.covers(11)).toBe(true);
  });

  it("a reconcile of the same task does not wipe a known beat ownership back to unknown", async () => {
    // The task row carries no beat_numbers - the backend has not caught up with this field (e.g. a stale
    // process on a dev machine that was not restarted), or it is an old row enqueued before this change.
    state.tasks = [runningRegen({ task_id: "t1" })];
    const { result } = renderController();

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(11)).toBe(true);

    // After `start()` the controller already knows this run only covers beat 9. The reconcile that follows
    // hits the same task, and a silent task row does not mean "covers everything", so the known ownership must not be wiped.
    act(() => {
      result.current.start({
        scope: "sketch_1x1__ab12cd34ef56",
        taskId: "t1",
        beatNumbers: [9],
      });
    });

    expect(result.current.covers(9)).toBe(true);
    expect(result.current.covers(11)).toBe(false);
  });

  it("with two regenerate tasks at once, the one given by start() is used and is not taken over by someone else's task", async () => {
    // Another sketch_regen sent from the batch panel is ahead in the list. The fallback find in reconcile does not look at scope,
    // and whichever it hits first would redirect this beat's scope / covered range entirely to that one.
    state.tasks = [
      runningRegen({ task_id: "t2", scope: "sketch_1x1__ffffffffffff", metadata: { beat_numbers: [5, 6] } }),
      runningRegen({ task_id: "t1", metadata: { beat_numbers: [9] } }),
    ];
    const { result } = renderController();

    act(() => {
      result.current.start({
        scope: "sketch_1x1__ab12cd34ef56",
        taskId: "t1",
        beatNumbers: [9],
      });
    });

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(9)).toBe(true);
    expect(result.current.covers(5)).toBe(false);
  });

  it("when switching to another task, the previous beat ownership is not carried over", async () => {
    // Another task started from some other entry (such as the batch panel) also carries no beat_numbers. Carrying over the previous
    // [9] would hide the beats this task is really running, so it must fall back to "covers everything".
    state.tasks = [runningRegen({ task_id: "t2" })];
    const { result } = renderController();

    act(() => {
      result.current.start({
        scope: "sketch_1x1__ab12cd34ef56",
        taskId: "t1",
        beatNumbers: [9],
      });
    });

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(11)).toBe(true);
  });

  // The bug the user reported: beat 4 is running a sketch, and switching to beat 5 the "Generate now" button is greyed out, and beat 5
  // has no progress bar either because covers() does not hit - the button became a dead key with no explanation. The backend
  // already supports concurrency (each selection_scope is an independent scope/task row), so adding coversBeat to the key
  // gives each beat its own registry entry, and reconcile also filters by the covered range.
  it("coversBeat keeps this beat from lighting up while another beat is running", async () => {
    state.tasks = [runningRegen({ task_id: "t4", metadata: { beat_numbers: [4] } })];

    // Two panels are mounted under the same provider: wait until the beat 4 cell has claimed successfully, then assert beat 5 was not lit.
    // Asserting only "always false" would be meaningless because it starts out false.
    const { result } = renderHook(
      () => ({
        four: useTaskController({ key: { ...KEY, coversBeat: 4 } }),
        five: useTaskController({ key: { ...KEY, coversBeat: 5 } }),
      }),
      { wrapper: ({ children }) => wrap(children) },
    );

    await waitFor(() => expect(result.current.four.started).toBe(true));
    expect(result.current.five.started).toBe(false);
  });

  it("a task row hit by coversBeat is claimed as usual", async () => {
    state.tasks = [runningRegen({ task_id: "t4", metadata: { beat_numbers: [4] } })];

    const { result } = renderHook(
      () => useTaskController({ key: { ...KEY, coversBeat: 4 } }),
      { wrapper: ({ children }) => wrap(children) },
    );

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(4)).toBe(true);
  });

  it("a task row with unknown coverage is still treated as a hit, without hiding a beat that is really running", async () => {
    state.tasks = [runningRegen({ task_id: "t4" })];

    const { result } = renderHook(
      () => useTaskController({ key: { ...KEY, coversBeat: 5 } }),
      { wrapper: ({ children }) => wrap(children) },
    );

    await waitFor(() => expect(result.current.started).toBe(true));
  });

  it("a task row carrying only beat_num is owned by that single beat", async () => {
    state.tasks = [
      runningRegen({ task_type: "director_control_to_sketch", beat_num: 9, scope: undefined }),
    ];

    const { result } = renderHook(
      () =>
        useTaskController({
          key: { taskType: "director_control_to_sketch", project: "demo", episode: 1 },
        }),
      { wrapper: ({ children }) => wrap(children) },
    );

    await waitFor(() => expect(result.current.started).toBe(true));
    expect(result.current.covers(9)).toBe(true);
    expect(result.current.covers(11)).toBe(false);
  });
});

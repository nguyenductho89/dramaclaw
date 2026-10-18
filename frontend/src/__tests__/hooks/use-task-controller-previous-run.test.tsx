// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The voice-over task row is reused per "project + episode", and the previous (finished) voice-over task of the same episode stays
 * in `/tasks` for an hour. When start() has no taskId, the terminal-state fallback takes that old row as this run's result and
 * closes out on the spot; after the new task really completes beats is no longer refreshed, and the panel keeps showing "not generated".
 *
 * With a taskId, the controller only recognizes this run's task row.
 */
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

const BEATS_KEY = ["beats", "demo", 1];

function renderAudioController() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  const view = renderHook(
    () =>
      useTaskController({
        key: { taskType: "audio_generation_indextts2", project: "demo", episode: 1 },
        invalidateKeys: [BEATS_KEY],
      }),
    {
      wrapper: ({ children }) => (
        <QueryClientProvider client={qc}>
          <TaskControllerProvider project="demo" episode={1}>
            {children}
          </TaskControllerProvider>
        </QueryClientProvider>
      ),
    },
  );
  return { ...view, invalidate };
}

function finishedAudio(taskId: string): Task {
  return {
    task_id: taskId,
    task_type: "audio_generation_indextts2",
    username: "u",
    project: "demo",
    episode: 1,
    status: "completed",
    progress: 1,
  };
}

beforeEach(() => {
  state.tasks = [];
});

describe("useTaskController with a previous finished task of the same kind", () => {
  it("with a taskId on start(), the previous terminal task row does not end this run early", async () => {
    state.tasks = [finishedAudio("previous-run")];
    const { result, invalidate } = renderAudioController();

    act(() => {
      result.current.start({ taskId: "this-run" });
    });
    await act(async () => {});

    expect(result.current.started).toBe(true);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("closes out only after this run's task row ends, and refreshes beats", async () => {
    state.tasks = [finishedAudio("previous-run")];
    const { result, rerender, invalidate } = renderAudioController();

    act(() => {
      result.current.start({ taskId: "this-run" });
    });
    state.tasks = [finishedAudio("this-run")];
    rerender();

    await waitFor(() => expect(result.current.started).toBe(false));
    expect(invalidate).toHaveBeenCalledWith({ queryKey: BEATS_KEY });
  });
});

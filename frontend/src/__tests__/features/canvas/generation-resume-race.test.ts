// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Two timing pitfalls on the refresh-recovery path:
//   1. The task list transiently misses items (a single-row parse failure in the backend list_tasks_for_project is silently skipped),
//      and judging "does not exist" on a single miss would write a still-running task as failed;
//   2. A generationJobId left over from the previous session races the descriptor resume for the same node --
//      the gateway in-memory Map is empty after a refresh, so polling is bound to get not_found, and writing the failure is faster than the resume.
// Both make "refresh the page later to see the result" fail, so they are pinned down here.
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { CURRENT_RUNTIME_SESSION_ID } from "@/features/canvas/application/generationErrorReport";
import {
  DETACHED_GENERATION_PATCH,
  TASK_MISS_CONFIRM_ATTEMPTS,
  nodeNeedsGenerationResume,
  nodeOwnsLiveGenerationJob,
  resumeNodeGeneration,
  staleGenerationJobPatch,
} from "@/features/canvas/application/resumeGeneration";

const listTasks = vi.fn();
const awaitTaskCompletion = vi.fn();
const fetchFreezoneTextGenerateResult = vi.fn();
const resumePersistedHtmlGeneration = vi.fn();

vi.mock("@/api/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tasks")>();
  return {
    ...actual,
    listTasks: (...args: unknown[]) => listTasks(...args),
    awaitTaskCompletion: (...args: unknown[]) => awaitTaskCompletion(...args),
  };
});

vi.mock("@/api/ops", () => ({
  fetchFreezoneJobResult: vi.fn().mockResolvedValue({ url: "out.png" }),
  fetchFreezoneReversePromptResult: vi.fn(),
  fetchFreezoneStoryScriptResult: vi.fn(),
  fetchFreezoneTextGenerateResult: (...args: unknown[]) => fetchFreezoneTextGenerateResult(...args),
}));

vi.mock("@/features/canvas/application/workflowHtmlRuntime", () => ({
  resumePersistedHtmlGeneration: (...args: unknown[]) =>
    resumePersistedHtmlGeneration(...args),
}));

const TASK_KEY = "freezone_image:job-9";

/** An image node awaiting recovery after a refresh: handles complete, still generating. */
function resumableNode(extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "n1",
    type: CANVAS_NODE_TYPES.exportImage,
    position: { x: 0, y: 0 },
    data: {
      isGenerating: true,
      generationTaskKey: TASK_KEY,
      generationTaskType: "freezone_image",
      generationTaskJobId: "job-9",
      ...extra,
    },
  } as unknown as CanvasNode;
}

function resumableTextNode(extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "text-1",
    type: CANVAS_NODE_TYPES.textAnnotation,
    position: { x: 0, y: 0 },
    data: {
      isGenerating: true,
      generationTaskKey: "freezone_text_generate:text-job-1",
      generationTaskType: "freezone_text_generate",
      generationTaskJobId: "text-job-1",
      ...extra,
    },
  } as unknown as CanvasNode;
}

function resumableHtmlNode(extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "html-1",
    type: CANVAS_NODE_TYPES.htmlArtifact,
    position: { x: 0, y: 0 },
    data: {
      isGenerating: true,
      generationTaskKey: "freezone_text_generate:html-job-1",
      generationTaskType: "freezone_text_generate",
      generationTaskJobId: "html-job-1",
      htmlGenerationTitle: "Landing page",
      htmlGenerationPhase: "generating",
      ...extra,
    },
  } as unknown as CanvasNode;
}

function resumableComposeNode(extra: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "compose-1",
    type: CANVAS_NODE_TYPES.videoCompose,
    position: { x: 0, y: 0 },
    data: {
      isGenerating: true,
      generationTaskKey: "task:freezone_video_compose:project:demo:0:compose-job-1",
      generationTaskType: "freezone_video_compose",
      generationTaskJobId: "compose-job-1",
      ...extra,
    },
  } as unknown as CanvasNode;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("recovery path: a missing list item does not mean the task does not exist", () => {
  it("when the first list is empty and the task appears afterwards, it waits for the result as usual without writing a failure", async () => {
    vi.useFakeTimers();
    try {
      listTasks
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ task_key: TASK_KEY, status: "running" }]);
      awaitTaskCompletion.mockResolvedValue({
        task_key: TASK_KEY,
        status: "completed",
        result: { output_url: "out.png" },
      });
      const updateNodeData = vi.fn();

      const pending = resumeNodeGeneration({
        node: resumableNode(),
        projectId: "demo",
        updateNodeData,
      });
      await vi.runAllTimersAsync();
      await pending;

      // The second list hits, so it enters awaitTaskCompletion -- that is the path with idle budget
      // semantics.
      expect(awaitTaskCompletion).toHaveBeenCalledTimes(1);
      const calls = updateNodeData.mock.calls;
      const patch = calls[calls.length - 1]?.[1] as Record<string, unknown>;
      expect(patch.imageUrl).toBe("out.png");
      expect(patch.generationError ?? null).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("only judges the task nonexistent after enough consecutive misses", async () => {
    vi.useFakeTimers();
    try {
      listTasks.mockResolvedValue([]);
      const updateNodeData = vi.fn();

      const pending = resumeNodeGeneration({
        node: resumableNode(),
        projectId: "demo",
        updateNodeData,
      });
      await vi.runAllTimersAsync();
      await pending;

      expect(listTasks).toHaveBeenCalledTimes(TASK_MISS_CONFIRM_ATTEMPTS);
      // The failure is written only once confirmed all the way, without waiting out a whole polling budget in vain.
      expect(awaitTaskCompletion).not.toHaveBeenCalled();
      const calls = updateNodeData.mock.calls;
      const patch = calls[calls.length - 1]?.[1] as Record<string, unknown>;
      expect(patch.isGenerating).toBe(false);
      expect(patch.generationError).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never judges failure when the list endpoint errors -- being unable to list does not mean the task is gone", async () => {
    listTasks.mockRejectedValue(new Error("offline"));
    awaitTaskCompletion.mockResolvedValue({
      task_key: TASK_KEY,
      status: "completed",
      result: { output_url: "out.png" },
    });
    const updateNodeData = vi.fn();

    await resumeNodeGeneration({
      node: resumableNode(),
      projectId: "demo",
      updateNodeData,
    });

    expect(listTasks).toHaveBeenCalledTimes(1);
    expect(awaitTaskCompletion).toHaveBeenCalledTimes(1);
  });
});

describe("recovery path: text tasks fetch results by task type", () => {
  it("after a refresh, uses the text generation result endpoint to recover the body and model", async () => {
    const taskKey = "freezone_text_generate:text-job-1";
    listTasks.mockResolvedValue([{ task_key: taskKey, status: "running" }]);
    awaitTaskCompletion.mockResolvedValue({
      task_key: taskKey,
      status: "completed",
      result: { output_format: "json" },
    });
    fetchFreezoneTextGenerateResult.mockResolvedValue({
      generated_text: "Rain falls on the rails of the old station.",
      model: "DC-freezone-text-writer-LLM",
    });
    const updateNodeData = vi.fn();

    await resumeNodeGeneration({
      node: resumableTextNode(),
      projectId: "demo",
      updateNodeData,
    });

    expect(fetchFreezoneTextGenerateResult).toHaveBeenCalledWith("demo", "text-job-1");
    const calls = updateNodeData.mock.calls;
    const patch = calls[calls.length - 1]?.[1] as Record<string, unknown>;
    expect(patch.content).toBe("Rain falls on the rails of the old station.");
    expect(patch.model).toBe("DC-freezone-text-writer-LLM");
    expect(patch.isGenerating).toBe(false);
  });
});

describe("recovery path: HTML text tasks are saved as an Artifact", () => {
  it("after a refresh, goes through the HTML completer and does not write the source into the plain content field", async () => {
    const taskKey = "freezone_text_generate:html-job-1";
    listTasks.mockResolvedValue([{ task_key: taskKey, status: "running" }]);
    awaitTaskCompletion.mockResolvedValue({
      task_key: taskKey,
      status: "completed",
      result: { output_format: "json" },
    });
    resumePersistedHtmlGeneration.mockResolvedValue(undefined);
    const updateNodeData = vi.fn();

    await resumeNodeGeneration({
      node: resumableHtmlNode(),
      projectId: "demo",
      canvasId: "canvas-1",
      updateNodeData,
    });

    expect(resumePersistedHtmlGeneration).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "html-1",
        projectId: "demo",
        canvasId: "canvas-1",
        jobId: "html-job-1",
        taskKey,
      }),
    );
    expect(fetchFreezoneTextGenerateResult).not.toHaveBeenCalled();
    expect(updateNodeData.mock.calls.some(([, value]) => "content" in value)).toBe(false);
  });
});

describe("recovery path: video compose result is written back to the original node", () => {
  it("after a refresh, writes the finished video and cover of a completed task back to the compose node", async () => {
    const node = resumableComposeNode();
    const taskKey = String(node.data.generationTaskKey);
    listTasks.mockResolvedValue([{ task_key: taskKey, status: "completed" }]);
    awaitTaskCompletion.mockResolvedValue({
      task_key: taskKey,
      status: "completed",
      result: {
        output_url: "/static/project/freezone/compose-job-1.mp4",
        cover_url: "/static/project/freezone/compose-job-1.png",
      },
    });
    const updateNodeData = vi.fn();

    await resumeNodeGeneration({
      node,
      projectId: "demo",
      updateNodeData,
    });

    const calls = updateNodeData.mock.calls;
    const patch = calls[calls.length - 1]?.[1] as Record<string, unknown>;
    expect(patch).toMatchObject({
      resultVideoUrl: "/static/project/freezone/compose-job-1.mp4",
      previewImageUrl: "/static/project/freezone/compose-job-1.png",
      resultVideoTaskKey: taskKey,
      resultVideoJobId: "compose-job-1",
      isGenerating: false,
      generationTaskKey: null,
      generationTaskType: null,
      generationTaskJobId: null,
      generationError: null,
    });
  });
});

describe("recovery path: a stale session's generationJobId must not jump the queue", () => {
  it("old-session jobId + complete descriptor: no polling, the dead id is cleared, and resume has exclusive use", () => {
    const node = resumableNode({
      generationJobId: "gateway-job-1",
      generationClientSessionId: "session-from-before-the-refresh",
    });

    // Key point: do not enter the polling loop. Otherwise the id is not found in the gateway in-memory Map -> not_found ->
    // the error branch clears isGenerating to false, and the descriptor resume is cut off right there.
    expect(nodeOwnsLiveGenerationJob(node)).toBe(false);

    const patch = staleGenerationJobPatch(node);
    expect(patch).toEqual(DETACHED_GENERATION_PATCH);
    expect(patch!.generationJobId).toBeNull();
    // isGenerating and the handles were untouched, so after applying the patch it is still in a recoverable state.
    const patched = { ...node, data: { ...node.data, ...patch } } as CanvasNode;
    expect(nodeNeedsGenerationResume(patched)).toBe(true);
  });

  it("a jobId written in this session is polled as usual and not treated as stale", () => {
    const node = resumableNode({
      generationJobId: "gateway-job-1",
      generationClientSessionId: CURRENT_RUNTIME_SESSION_ID,
    });

    expect(nodeOwnsLiveGenerationJob(node)).toBe(true);
    expect(staleGenerationJobPatch(node)).toBeNull();
  });

  it("old-session jobId without a descriptor: gives a terminal state directly so the node does not spin forever", () => {
    // Old nodes submitted before this PR -- the backend handle was never persisted, so nobody can pick it back up.
    const node = {
      id: "n2",
      type: CANVAS_NODE_TYPES.exportImage,
      position: { x: 0, y: 0 },
      data: {
        isGenerating: true,
        generationJobId: "gateway-job-2",
        generationClientSessionId: "session-from-before-the-refresh",
      },
    } as unknown as CanvasNode;

    const patch = staleGenerationJobPatch(node)!;
    expect(patch.isGenerating).toBe(false);
    expect(patch.generationError).toBeTruthy();
  });

  it("nodes that are not generating are ignored", () => {
    const node = {
      id: "n3",
      type: CANVAS_NODE_TYPES.exportImage,
      position: { x: 0, y: 0 },
      data: { isGenerating: false, generationJobId: "gateway-job-3" },
    } as unknown as CanvasNode;

    expect(nodeOwnsLiveGenerationJob(node)).toBe(false);
    expect(staleGenerationJobPatch(node)).toBeNull();
  });
});

describe("recovery path: an old task must not overwrite a new task on the same node", () => {
  it("when an old video result arrives late, the new task's generating state and handle are kept", async () => {
    const oldTaskKey = "freezone_video_upscale:old-job";
    const newTaskKey = "freezone_video_upscale:new-job";
    const node = {
      ...resumableNode(),
      type: CANVAS_NODE_TYPES.video,
      data: {
        isGenerating: true,
        generationTaskKey: oldTaskKey,
        generationTaskType: "freezone_video_upscale",
        generationTaskJobId: "old-job",
        videoUrl: "previous.mp4",
      },
    } as unknown as CanvasNode;
    const currentData = { ...node.data } as Record<string, unknown>;
    listTasks.mockResolvedValue([{ task_key: oldTaskKey, status: "running" }]);
    let finishOldTask!: (value: unknown) => void;
    awaitTaskCompletion.mockImplementation(() => new Promise((resolve) => {
      finishOldTask = resolve;
    }));
    const updateNodeData = vi.fn();

    const pending = resumeNodeGeneration({
      node,
      projectId: "demo",
      updateNodeData,
      getNodeData: () => currentData,
    });
    await vi.waitFor(() => expect(awaitTaskCompletion).toHaveBeenCalledOnce());
    currentData.generationTaskKey = newTaskKey;
    finishOldTask({
      task_key: oldTaskKey,
      status: "completed",
      result: { output_url: "previous.mp4" },
    });
    await pending;

    expect(updateNodeData).not.toHaveBeenCalled();
    expect(currentData.generationTaskKey).toBe(newTaskKey);
    expect(currentData.isGenerating).toBe(true);
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Detaching the listener != generation failure. The backend is still running, and the task handles on the node (generationTaskKey /
// TaskType / TaskJobId) are the only clue resumeNodeGeneration uses to find the result after a refresh --
// this locks down the two opposite paths "keep the handles and write no error on detach" and "clear the handles and write an error on real failure".
import { beforeEach, describe, expect, it, vi } from "vitest";

import { TaskPollTimeoutError } from "@/api/tasks";
import { regenerateExportImageNode } from "@/features/canvas/application/regenerateExportNode";
import { DETACHED_GENERATION_PATCH } from "@/features/canvas/application/resumeGeneration";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";

const submitFreezoneRedraw = vi.fn();
const awaitTaskCompletion = vi.fn();
const fetchFreezoneJobResult = vi.fn();
const submitGenerateImageJob = vi.fn();

// Only the gateway is replaced and the rest (canvasNodeFactory etc.) stay real, otherwise store.addNode would blow up.
vi.mock("@/features/canvas/application/canvasServices", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("@/features/canvas/application/canvasServices")
  >();
  return {
    ...actual,
    canvasAiGateway: {
      ...actual.canvasAiGateway,
      submitGenerateImageJob: (...args: unknown[]) => submitGenerateImageJob(...args),
    },
  };
});

vi.mock("@/api/ops", () => ({
  submitFreezoneRedraw: (...args: unknown[]) => submitFreezoneRedraw(...args),
  fetchFreezoneJobResult: (...args: unknown[]) => fetchFreezoneJobResult(...args),
}));

vi.mock("@/api/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tasks")>();
  return {
    ...actual,
    awaitTaskCompletion: (...args: unknown[]) => awaitTaskCompletion(...args),
  };
});

vi.mock("@/lib/url-params", () => ({
  readUrl: () => ({ project: "demo" }),
}));

const IMAGE_JOB_REF = {
  task_type: "freezone_image",
  job_id: "img-1",
  task_key: "freezone_image:img-1",
};

const JOB_REF = {
  task_type: "freezone_image_redraw",
  job_id: "job-1",
  task_key: "freezone_image_redraw:job-1",
};

function seedRedrawNode(): string {
  const store = useCanvasStore.getState();
  store.setCanvasData([], []);
  return useCanvasStore.getState().addNode(
    CANVAS_NODE_TYPES.exportImage,
    { x: 0, y: 0 },
    {
      freezoneRedrawRequest: {
        sourceUrl: "src.png",
        maskUrl: "mask.png",
        aspectRatio: "original",
        imageSize: "2K",
      },
    },
  );
}

function nodeData(nodeId: string): Record<string, unknown> {
  const node = useCanvasStore.getState().nodes.find((n) => n.id === nodeId);
  return (node?.data ?? {}) as Record<string, unknown>;
}

beforeEach(() => {
  vi.clearAllMocks();
  submitFreezoneRedraw.mockResolvedValue(JOB_REF);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("repaint node: node state after polling detaches", () => {
  it("on detach keeps isGenerating and the task handles, and writes no error banner", async () => {
    const nodeId = seedRedrawNode();
    awaitTaskCompletion.mockRejectedValue(
      new TaskPollTimeoutError(JOB_REF.task_key, 40 * 60 * 1000, 35 * 60 * 1000, "running"),
    );

    await regenerateExportImageNode(nodeId);

    const data = nodeData(nodeId);
    // The task is still alive: the banner must not be written and the spinner must not stop.
    expect(data.generationError ?? null).toBeNull();
    expect(data.isGenerating).toBe(true);
    // The three handles are fully kept so that it can be picked back up after a refresh.
    expect(data.generationTaskKey).toBe(JOB_REF.task_key);
    expect(data.generationTaskType).toBe(JOB_REF.task_type);
    expect(data.generationTaskJobId).toBe(JOB_REF.job_id);
  });

  it("on real failure still writes the error and clears the handles as before", async () => {
    const nodeId = seedRedrawNode();
    awaitTaskCompletion.mockRejectedValue(new Error("redraw exploded"));

    await regenerateExportImageNode(nodeId);

    const data = nodeData(nodeId);
    expect(data.generationError).toBe("redraw exploded");
    expect(data.isGenerating).toBe(false);
    expect(data.generationTaskKey).toBeNull();
    expect(data.generationTaskType).toBeNull();
    expect(data.generationTaskJobId).toBeNull();
  });

  it("image tasks also persist the handles after submission -- so there is something to keep on detach", async () => {
    const store = useCanvasStore.getState();
    store.setCanvasData([], []);
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.exportImage,
      { x: 0, y: 0 },
      { generationRequestPayload: { prompt: "p", model: "m", size: "2K", aspectRatio: "1:1" } },
    );
    submitGenerateImageJob.mockResolvedValue({ jobId: IMAGE_JOB_REF.job_id, ref: IMAGE_JOB_REF });

    await regenerateExportImageNode(nodeId);

    const data = nodeData(nodeId);
    // The gateway's in-memory job id serves only this session's polling loop...
    expect(data.generationJobId).toBe(IMAGE_JOB_REF.job_id);
    // ...what really survives a refresh is these three handles. Previously this path stored only the jobId, leaving nothing to recover after detaching.
    expect(data.generationTaskKey).toBe(IMAGE_JOB_REF.task_key);
    expect(data.generationTaskType).toBe(IMAGE_JOB_REF.task_type);
    expect(data.generationTaskJobId).toBe(IMAGE_JOB_REF.job_id);
  });

  it("the node state after detaching is really picked up by the resume scan on the next load", async () => {
    const store = useCanvasStore.getState();
    store.setCanvasData([], []);
    const nodeId = useCanvasStore.getState().addNode(
      CANVAS_NODE_TYPES.exportImage,
      { x: 0, y: 0 },
      { generationRequestPayload: { prompt: "p", model: "m", size: "2K", aspectRatio: "1:1" } },
    );
    submitGenerateImageJob.mockResolvedValue({ jobId: IMAGE_JOB_REF.job_id, ref: IMAGE_JOB_REF });
    await regenerateExportImageNode(nodeId);

    // Use the patch that the Canvas.tsx detached branch really writes, not a hand copy -- with a hand copy, whoever
    // adds back an isGenerating: false in Canvas.tsx would still see this case stay green.
    useCanvasStore.getState().updateNodeData(nodeId, DETACHED_GENERATION_PATCH);

    const detached = useCanvasStore.getState().nodes.find((n) => n.id === nodeId)!;
    expect((detached.data as Record<string, unknown>).isGenerating).toBe(true);
    expect((detached.data as Record<string, unknown>).generationError ?? null).toBeNull();

    // Reloading the module = simulating a refresh: sessionOwnedTaskKeys is empty, so the scan no longer skips it.
    // This step is the decision point for whether the hint "refresh the page later to see the result" can be honored.
    vi.resetModules();
    const { nodeNeedsGenerationResume } = await import(
      "@/features/canvas/application/resumeGeneration"
    );
    expect(nodeNeedsGenerationResume(detached)).toBe(true);
  });

  it("on success persists the image and clears the handles", async () => {
    const nodeId = seedRedrawNode();
    awaitTaskCompletion.mockResolvedValue({
      task_key: JOB_REF.task_key,
      status: "completed",
      result: { output_url: "out.png" },
    });

    await regenerateExportImageNode(nodeId);

    const data = nodeData(nodeId);
    expect(data.imageUrl).toBe("out.png");
    expect(data.isGenerating).toBe(false);
    expect(data.generationTaskKey).toBeNull();
  });
});

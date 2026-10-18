// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Equivalence matrix of the workflow image node: text-to-image / image-to-image / multi-reference × submit payload, multi-result,
// resume handle, history refresh.
//
// Why this separate file: the form logic of ImageGenNode moved wholesale into `useImageGenerationForm`
// (shared with the storyboard asset board). The big batch of asset-board-* tests watches the **asset board view**, while the workflow
// node side uses the same hook but with another set of host params (own reference image, upstream edges, album, task
// handle persistence), and before this only the quote and failure state had behavioral coverage. What is added here is "whether what the same hook produces
// under the node view is still the original thing".
//
// Assertions always land on the ops-layer payload and the node data — refactor the middle however you like, these two ends must not change.
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { submitFreezoneGen } from "@/api/ops";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { useImageGenerationForm } from "@/features/canvas/nodes/shared/useImageGenerationForm";
import { useCanvasStore } from "@/stores/canvasStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) =>
      typeof fallback === "string" ? fallback : key,
    i18n: { language: "zh" },
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/generation-credit-cost")>()),
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));

vi.mock("@/lib/url-params", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-params")>()),
  readUrl: () => ({ project: "demo-project", canvas: "canvas-7" }),
}));

let submitSeq = 0;

vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneImageModels: vi.fn(async () => [
    {
      id: "huimeng/test-image",
      providerId: "huimeng",
      apiModel: "test_image_api",
      label: "Test model",
      qualityOptions: ["low", "medium", "high"],
    },
  ]),
  listFreezoneStyleTemplates: vi.fn(async () => []),
  fetchFreezoneCameraOptions: vi.fn(async () => null),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  submitFreezoneGen: vi.fn(async () => {
    submitSeq += 1;
    return {
      task_key: `task-${submitSeq}`,
      task_type: "freezone_gen",
      job_id: `job-${submitSeq}`,
    };
  }),
  fetchFreezoneJobResult: vi.fn(async () => ({ url: "/static/fallback.png" })),
}));

vi.mock("@/api/tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/tasks")>()),
  // Each task returns an image matching its own task_key, making it easy to assert how many the album collected.
  awaitTaskCompletion: vi.fn(async (taskKey: string) => ({
    result: { output_url: `/static/${taskKey}.png` },
  })),
}));

vi.mock("@/features/canvas/application/errorDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/canvas/application/errorDialog")>()),
  showErrorDialog: vi.fn(async () => undefined),
}));

function imageGenNode(data: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "img-1",
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: { prompt: "A cat on the windowsill", modelId: "huimeng/test-image", ...data },
  } as CanvasNode;
}

function uploadNode(id: string, url: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.upload,
    position: { x: 0, y: 0 },
    data: { imageUrl: url },
  } as CanvasNode;
}

function edge(id: string, source: string): { id: string; source: string; target: string } {
  return { id, source, target: "img-1" };
}

function nodeData(): Record<string, unknown> {
  return (useCanvasStore.getState().nodes.find((n) => n.id === "img-1")?.data ??
    {}) as Record<string, unknown>;
}

function payloads() {
  return vi.mocked(submitFreezoneGen).mock.calls.map((call) => call[1]);
}

/** Mount the hook, wait until ready, submit, wait until landed. */
async function submitAndSettle(options?: { onGenerationSettled?: () => void }) {
  const { result } = renderHook(() => useImageGenerationForm("img-1", options));
  await waitFor(() => {
    expect(result.current.submitDisabled).toBe(false);
  });
  await result.current.submit();
  await waitFor(() => {
    expect(nodeData().isGenerating).toBe(false);
  });
  return result;
}

beforeEach(() => {
  submitSeq = 0;
  vi.mocked(submitFreezoneGen).mockClear();
});

describe("image node: submit payload for the three reference-image shapes", () => {
  it("text-to-image — no reference image at all", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode()], []);

    await submitAndSettle();

    expect(payloads()).toHaveLength(1);
    expect(payloads()[0]).toMatchObject({
      genMode: "text_to_image",
      referenceUrls: [],
      model: "test_image_api",
      modelId: "huimeng/test-image",
      // The canvas id is taken from the URL, and the backend archives outputs by it.
      canvasId: "canvas-7",
      nodeId: "img-1",
      quality: "medium",
    });
  });

  it("quality is sent only when the node explicitly sets it", async () => {
    useCanvasStore.getState().setCanvasData(
      [imageGenNode({ quality: "high" })],
      [],
    );

    await submitAndSettle();

    expect(payloads()[0]).toMatchObject({ quality: "high" });
  });

  it("image-to-image — a single upstream image", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([imageGenNode(), uploadNode("src-1", "/static/a.png")], [edge("e1", "src-1")]);

    await submitAndSettle();

    expect(payloads()[0]).toMatchObject({
      genMode: "image_to_image",
      referenceUrls: ["/static/a.png"],
    });
  });

  it("multi-reference — own reference image first, upstream following connection order, URLs deduped", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [
          imageGenNode({ referenceImageUrl: "/static/own.png" }),
          uploadNode("src-1", "/static/a.png"),
          uploadNode("src-2", "/static/b.png"),
          // The same image as the own reference image: it must not appear twice in the list, otherwise the backend's @imageN shifts as a whole.
          uploadNode("src-3", "/static/own.png"),
        ],
        [edge("e1", "src-1"), edge("e2", "src-2"), edge("e3", "src-3")],
      );

    await submitAndSettle();

    expect(payloads()[0]).toMatchObject({
      genMode: "image_to_image",
      referenceUrls: ["/static/own.png", "/static/a.png", "/static/b.png"],
    });
  });
});

describe("image node: multi-result album", () => {
  it("generation count 3 → 3 concurrent submissions, all three land in the same node's album", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode({ count: 3 })], []);

    await submitAndSettle();

    expect(payloads()).toHaveLength(3);
    // Sibling nodes are no longer cloned: there is still only this one image node on the canvas.
    expect(
      useCanvasStore.getState().nodes.filter((n) => n.type === CANVAS_NODE_TYPES.imageGen),
    ).toHaveLength(1);

    const batch = nodeData().generationBatch as string[];
    expect(batch).toHaveLength(3);
    expect([...batch].sort()).toEqual([
      "/static/task-1.png",
      "/static/task-2.png",
      "/static/task-3.png",
    ]);
    // The first to finish becomes the main image at the same time.
    expect(batch).toContain(nodeData().imageUrl);
  });

  it("a single result writes no album (the stacked-card UI appears only with multiple results)", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode({ count: 1 })], []);

    await submitAndSettle();

    expect(payloads()).toHaveLength(1);
    expect(nodeData().generationBatch).toBeNull();
    expect(nodeData().imageUrl).toBe("/static/task-1.png");
  });
});

describe("image node: resume and history", () => {
  it("the task handle is written to the node immediately after submit (so polling can resume after a page refresh)", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode()], []);

    await submitAndSettle();

    expect(nodeData()).toMatchObject({
      generationTaskKey: "task-1",
      generationTaskType: "freezone_gen",
      generationTaskJobId: "job-1",
    });
  });

  it("with multiple results only run 0's handle is persisted (the node holds one; later ones must not overwrite it)", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode({ count: 3 })], []);

    await submitAndSettle();

    expect(nodeData().generationTaskKey).toBe("task-1");
  });

  it("after the whole batch lands, the host is called back to refresh history", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode({ count: 2 })], []);
    const onGenerationSettled = vi.fn();

    await submitAndSettle({ onGenerationSettled });

    await waitFor(() => {
      expect(onGenerationSettled).toHaveBeenCalled();
    });
  });
});

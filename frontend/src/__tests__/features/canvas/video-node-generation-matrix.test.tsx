// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Equivalence matrix of the workflow video node: 7 genModes × 5 submit endpoints, plus the multi-result album,
// task handle (refresh resume) and history refresh callback.
//
// Why this separate file: the form logic of VideoNode moved wholesale into `useVideoGenerationForm`
// (shared with the storyboard asset board). Before and after the move, "which mode hits which endpoint with what payload" is the segment in this refactor
// that most easily slips quietly out of place — it is a long if/else chain, with each branch collecting upstream assets on its own;
// it compiles and types check, but hitting the wrong endpoint gives the backend only a 400, and local tests stay all green.
//
// Assertions always land on the ops-layer payload and the node data — refactor the middle however you like, these two ends must not change.
//
// Mode coverage note: genMode is not a purely controlled field; the hook has a whole set of effects that "auto-correct
// with upstream and model". So the cases here are of two kinds:
//   - Explicit modes (firstFrame / firstLastFrame / allReference): written into the node data,
//     paired with a model + upstream combination that does not trigger the correcting effects;
//   - HappyHorse three states (imageToVideo / imageReference / videoEdit): genMode is **not written**,
//     left to the state machine to derive by upstream type — that is exactly the real online path.
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchFreezoneVideoModels,
  submitFreezoneVideoEdit,
  submitFreezoneVideoExtend,
  submitFreezoneVideoGen,
  submitFreezoneVideoI2v,
  submitFreezoneVideoKeyframes,
  submitFreezoneVideoOmniGen,
} from "@/api/ops";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { showErrorDialog } from "@/features/canvas/application/errorDialog";
import { getFreezoneVideoModelsSnapshot } from "@/features/canvas/hooks/useFreezoneVideoModels";
import { useVideoGenerationForm } from "@/features/canvas/nodes/shared/useVideoGenerationForm";
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
      typeof fallback === "string"
        ? fallback
        : ((fallback as { defaultValue?: string } | undefined)?.defaultValue ?? key),
    i18n: { language: "zh" },
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/generation-credit-cost")>()),
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));

const requestScope = vi.hoisted(() => ({ project: "demo-project" }));

vi.mock("@/lib/url-params", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-params")>()),
  readUrl: () => ({ project: requestScope.project, canvas: "canvas-9" }),
}));

// Submission counter: +1 on each call to any endpoint, so task keys are recognizable (task-1 / task-2 …),
// giving "multiple results each wait for their own task" and "the handle keeps only the first" something to assert on.
const submits = vi.hoisted(() => ({ seq: 0 }));
// The snapshot of the node's data when awaitTaskCompletion runs — the state during task flight can only be seen
// here (after the whole batch ends the hook clears the task handle fields).
const inflight = vi.hoisted(() => ({ snapshots: [] as Record<string, unknown>[] }));

vi.mock("@/api/ops", async (importOriginal) => {
  const nextRef = (taskType: string) => async () => {
    submits.seq += 1;
    return {
      task_key: `task-${submits.seq}`,
      task_type: taskType,
      job_id: `job-${submits.seq}`,
    };
  };
  return {
    ...(await importOriginal<typeof import("@/api/ops")>()),
    fetchFreezoneVideoModels: vi.fn(async () => [
      {
        id: "text-only", providerId: "newapi", label: "Text only",
        apiModel: "text-only", supportedModes: ["text_to_video"],
      },
      {
        id: "huimeng/seedance-1.5-pro",
        providerId: "huimeng",
        apiModel: "seedance-1.5-pro",
        label: "Seedance 1.5 Pro",
        catalogId: "catalog-sd1",
      },
      {
        id: "huimeng/seedance-2.0",
        providerId: "huimeng",
        apiModel: "seedance-2.0",
        label: "Seedance 2.0",
        catalogId: "catalog-sd2",
      },
      {
        id: "video-extend-model", providerId: "newapi", label: "Extend",
        apiModel: "extend-api", catalogId: "catalog-extend",
        supportedModes: ["video_extend"],
      },
      {
        id: "huimeng/happyhorse-1.0",
        providerId: "huimeng",
        apiModel: "happyhorse-1.0",
        label: "HappyHorse 1.0",
        catalogId: "catalog-hh",
      },
    ]),
    fetchFreezoneVideoCameraTemplates: vi.fn(async () => []),
    listFreezoneGenerationHistory: vi.fn(async () => []),
    submitFreezoneVideoGen: vi.fn(nextRef("freezone_video_gen")),
    submitFreezoneVideoKeyframes: vi.fn(nextRef("freezone_video_keyframes")),
    submitFreezoneVideoI2v: vi.fn(nextRef("freezone_video_i2v")),
    submitFreezoneVideoEdit: vi.fn(nextRef("freezone_video_edit")),
    submitFreezoneVideoExtend: vi.fn(nextRef("freezone_video_extend")),
    submitFreezoneVideoOmniGen: vi.fn(nextRef("freezone_video_omni_gen")),
    fetchFreezoneJobResult: vi.fn(async () => ({ url: "/static/fallback.mp4" })),
  };
});

vi.mock("@/api/tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/tasks")>()),
  awaitTaskCompletion: vi.fn(async (taskKey: string) => {
    const { useCanvasStore: store } = await import("@/stores/canvasStore");
    inflight.snapshots.push({
      ...((store.getState().nodes.find((n) => n.id === "vid-1")?.data ?? {}) as Record<
        string,
        unknown
      >),
    });
    // Each task returns a video matching its own task_key, making it easy to assert how many the album collected.
    return { result: { video_url: `/static/${taskKey}.mp4` } };
  }),
}));

vi.mock("@/features/canvas/application/errorDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/canvas/application/errorDialog")>()),
  showErrorDialog: vi.fn(async () => undefined),
}));

const MODEL_SD1 = "huimeng/seedance-1.5-pro";
const MODEL_SD2 = "huimeng/seedance-2.0";
const MODEL_HH = "huimeng/happyhorse-1.0";

function videoNode(data: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "vid-1",
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: { prompt: "A cat jumps onto the table", model: MODEL_SD2, ...data },
  } as CanvasNode;
}

function uploadImageNode(id: string, url: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.upload,
    position: { x: 0, y: 0 },
    data: { imageUrl: url },
  } as CanvasNode;
}

function upstreamVideoNode(id: string, url: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: { videoUrl: url, durationMs: 4000 },
  } as CanvasNode;
}

function edge(
  id: string,
  source: string,
  data?: Record<string, unknown>,
): { id: string; source: string; target: string; data?: Record<string, unknown> } {
  return { id, source, target: "vid-1", ...(data ? { data } : {}) };
}

function nodeData(): Record<string, unknown> {
  return (useCanvasStore.getState().nodes.find((n) => n.id === "vid-1")?.data ??
    {}) as Record<string, unknown>;
}

/** The payload received on the first call of an endpoint (the five endpoints each have their own payload type). */
function payloadOf<P>(
  fn: (project: string, payload: P) => unknown,
): Record<string, unknown> | null {
  const calls = vi.mocked(fn).mock.calls;
  return calls.length > 0 ? (calls[0][1] as unknown as Record<string, unknown>) : null;
}

const ALL_ENDPOINTS = [
  submitFreezoneVideoGen,
  submitFreezoneVideoKeyframes,
  submitFreezoneVideoI2v,
  submitFreezoneVideoEdit,
  submitFreezoneVideoExtend,
  submitFreezoneVideoOmniGen,
] as const;

/** Except for `expected`, none of the other four endpoints may have been touched — a wrong dispatch must be exposed on the spot. */
function expectOnlyEndpointCalled(expected: (typeof ALL_ENDPOINTS)[number]) {
  for (const endpoint of ALL_ENDPOINTS) {
    if (endpoint === expected) {
      expect(vi.mocked(endpoint)).toHaveBeenCalled();
    } else {
      expect(vi.mocked(endpoint)).not.toHaveBeenCalled();
    }
  }
}

/** Mount the hook, wait until ready, submit, wait until landed. */
async function submitAndSettle(options?: { onGenerationSettled?: () => void }) {
  const { result } = renderHook(() => useVideoGenerationForm("vid-1", options));
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
  requestScope.project = "demo-project";
  submits.seq = 0;
  inflight.snapshots = [];
  for (const endpoint of ALL_ENDPOINTS) vi.mocked(endpoint).mockClear();
  vi.mocked(showErrorDialog).mockClear();
});

describe("video node: genMode → submit endpoint dispatch", () => {
  it("text-to-video → /video/gen", async () => {
    useCanvasStore.getState().setCanvasData([videoNode({ genMode: "textToVideo" })], []);

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoGen);
    expect(payloadOf(submitFreezoneVideoGen)).toMatchObject({
      genMode: "textToVideo",
      prompt: "A cat jumps onto the table",
      // What is submitted to the backend is the media catalog id, not the frontend display id.
      model: "catalog-sd2",
      canvasId: "canvas-9",
      nodeId: "vid-1",
    });
  });

  it("video extend → /video/video-extend, keeping the single source video and the prompt", async () => {
    useCanvasStore.getState().setCanvasData(
      [videoNode({ model: "video-extend-model", genMode: "videoExtend" }),
        upstreamVideoNode("source-1", "/static/source.mp4")],
      [edge("e1", "source-1")],
    );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoExtend);
    expect(payloadOf(submitFreezoneVideoExtend)).toMatchObject({
      genMode: "videoExtend", videoUrl: "/static/source.mp4",
      prompt: "A cat jumps onto the table", model: "catalog-extend",
      canvasId: "canvas-9", nodeId: "vid-1",
    });
  });

  it("first-frame-to-video → /video/keyframes, with the first frame only", async () => {
    // Seedance 1.x: a single-image first frame is the only path it can take, and no correcting effect changes the mode.
    useCanvasStore
      .getState()
      .setCanvasData(
        [
          videoNode({ model: MODEL_SD1, genMode: "firstFrame" }),
          uploadImageNode("img-1", "/static/first.png"),
        ],
        [edge("e1", "img-1")],
      );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoKeyframes);
    expect(payloadOf(submitFreezoneVideoKeyframes)).toMatchObject({
      genMode: "firstFrame",
      firstFrameUrl: "/static/first.png",
      // In first-frame mode the last frame must stay empty, otherwise the backend would run it as a first-last-frame interpolation task.
      lastFrameUrl: null,
      model: "catalog-sd1",
    });
  });

  it("first-last-frame → /video/keyframes, splitting first and last by the slots on the edges", async () => {
    useCanvasStore.getState().setCanvasData(
      [
        videoNode({ genMode: "firstLastFrame" }),
        uploadImageNode("img-1", "/static/tail.png"),
        uploadImageNode("img-2", "/static/head.png"),
      ],
      [
        // Deliberately put the "last frame" edge first: slots are split by the keyframeSlot on the edges,
        // not by connection order.
        edge("e1", "img-1", { keyframeSlot: "last" }),
        edge("e2", "img-2", { keyframeSlot: "first" }),
      ],
    );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoKeyframes);
    expect(payloadOf(submitFreezoneVideoKeyframes)).toMatchObject({
      genMode: "firstLastFrame",
      firstFrameUrl: "/static/head.png",
      lastFrameUrl: "/static/tail.png",
    });
  });

  it("image-to-video (HappyHorse + single-image upstream) → /video/i2v, 1 image", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [videoNode({ model: MODEL_HH }), uploadImageNode("img-1", "/static/a.png")],
        [edge("e1", "img-1")],
      );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoI2v);
    expect(payloadOf(submitFreezoneVideoI2v)).toMatchObject({
      genMode: "imageToVideo",
      imageUrls: ["/static/a.png"],
      model: "catalog-hh",
    });
  });

  it("image reference (HappyHorse + multi-image upstream) → /video/i2v, carrying several in connection order", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [
          videoNode({ model: MODEL_HH }),
          uploadImageNode("img-1", "/static/a.png"),
          uploadImageNode("img-2", "/static/b.png"),
        ],
        [edge("e1", "img-1"), edge("e2", "img-2")],
      );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoI2v);
    expect(payloadOf(submitFreezoneVideoI2v)).toMatchObject({
      // The same endpoint, split on the backend into "image-reference video" by image count and genMode.
      genMode: "imageReference",
      imageUrls: ["/static/a.png", "/static/b.png"],
    });
  });

  it("video edit (HappyHorse + video upstream) → /video/edit, carrying the source video", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [
          videoNode({ model: MODEL_HH }),
          upstreamVideoNode("src-1", "/static/source.mp4"),
          uploadImageNode("img-1", "/static/a.png"),
        ],
        [edge("e1", "src-1"), edge("e2", "img-1")],
      );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoEdit);
    expect(payloadOf(submitFreezoneVideoEdit)).toMatchObject({
      genMode: "videoEdit",
      videoUrl: "/static/source.mp4",
      imageUrls: ["/static/a.png"],
      model: "catalog-hh",
    });
  });

  it("all reference (Seedance 2.0 + image + video) → /video/omni-gen, classifying references by type", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [
          videoNode({ genMode: "allReference" }),
          uploadImageNode("img-1", "/static/a.png"),
          upstreamVideoNode("src-1", "/static/source.mp4"),
        ],
        [edge("e1", "img-1"), edge("e2", "src-1")],
      );

    await submitAndSettle();

    expectOnlyEndpointCalled(submitFreezoneVideoOmniGen);
    expect(payloadOf(submitFreezoneVideoOmniGen)).toMatchObject({
      genMode: "allReference",
      references: [
        { type: "image", url: "/static/a.png" },
        { type: "video", url: "/static/source.mp4" },
      ],
      model: "catalog-sd2",
    });
  });

  it("all reference hitting a non-2.0 model is blocked on the frontend, sending no request", async () => {
    // Seedance 1.x cannot go through omni-gen; letting it through would only yield a backend 400.
    useCanvasStore
      .getState()
      .setCanvasData(
        [
          videoNode({ model: MODEL_SD1, genMode: "allReference" }),
          uploadImageNode("img-1", "/static/a.png"),
        ],
        [edge("e1", "img-1")],
      );

    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));
    await waitFor(() => expect(result.current.submitDisabled).toBe(true));
    await result.current.submit();

    for (const endpoint of ALL_ENDPOINTS) {
      expect(vi.mocked(endpoint)).not.toHaveBeenCalled();
    }
    expect(showErrorDialog).not.toHaveBeenCalled();
  });
});

describe("video node: multi-result album", () => {
  it("generation count 3 → 3 concurrent submissions, all three land in the same node's album", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([videoNode({ genMode: "textToVideo", count: 3 })], []);

    await submitAndSettle();

    expect(vi.mocked(submitFreezoneVideoGen)).toHaveBeenCalledTimes(3);
    // Sibling nodes are no longer cloned: there is still only this one video node on the canvas.
    expect(
      useCanvasStore.getState().nodes.filter((n) => n.type === CANVAS_NODE_TYPES.video),
    ).toHaveLength(1);

    const batch = nodeData().generationBatch as string[];
    expect(batch).toHaveLength(3);
    expect([...batch].sort()).toEqual([
      "/static/task-1.mp4",
      "/static/task-2.mp4",
      "/static/task-3.mp4",
    ]);
    // The first to finish becomes the main video at the same time.
    expect(batch).toContain(nodeData().videoUrl);
  });

  it("a single result writes no album (the stacked-card UI appears only with multiple results)", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([videoNode({ genMode: "textToVideo", count: 1 })], []);

    await submitAndSettle();

    expect(vi.mocked(submitFreezoneVideoGen)).toHaveBeenCalledTimes(1);
    expect(nodeData().generationBatch).toBeNull();
    expect(nodeData().videoUrl).toBe("/static/task-1.mp4");
  });
});

describe("video node: resume and history", () => {
  it("while the task is in flight the node carries the handle (so polling can resume after a page refresh), cleared after landing", async () => {
    useCanvasStore.getState().setCanvasData([videoNode({ genMode: "textToVideo" })], []);

    await submitAndSettle();

    expect(inflight.snapshots).toHaveLength(1);
    expect(inflight.snapshots[0]).toMatchObject({
      generationTaskKey: "task-1",
      generationTaskType: "freezone_video_gen",
      generationTaskJobId: "job-1",
    });
    // After the whole batch ends the handle must be cleared, otherwise next time the canvas opens it would poll a task long since finished.
    expect(nodeData().generationTaskKey).toBeNull();
  });

  it("with concurrent runs only the first's handle is persisted (the node holds one; later ones must not overwrite it)", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([videoNode({ genMode: "textToVideo", count: 3 })], []);

    await submitAndSettle();

    expect(inflight.snapshots).toHaveLength(3);
    const seen = inflight.snapshots.map((snapshot) => snapshot.generationTaskKey);
    expect(seen).toContain("task-1");
    // Once task-2 / task-3 appear, it means later tasks overwrote the first's handle.
    expect(seen.every((key) => key == null || key === "task-1")).toBe(true);
  });

  it("after the whole batch lands, the host is called back to refresh history", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([videoNode({ genMode: "textToVideo", count: 2 })], []);
    const onGenerationSettled = vi.fn();

    await submitAndSettle({ onGenerationSettled });

    await waitFor(() => {
      expect(onGenerationSettled).toHaveBeenCalled();
    });
  });
});


it("rejects AI-persisted imageToVideo on a text-only model before submitting", async () => {
  useCanvasStore.getState().setCanvasData(
    [videoNode({ model: "text-only", genMode: "imageToVideo" }),
      uploadImageNode("img-1", "/static/a.png")],
    [edge("e1", "img-1")],
  );
  const { result } = renderHook(() => useVideoGenerationForm("vid-1"));
  await waitFor(() => expect(result.current.selectedVideoModelId).toBe("text-only"));
  expect(result.current.submitDisabled).toBe(true);
  await result.current.submit();
  for (const endpoint of ALL_ENDPOINTS) expect(endpoint).not.toHaveBeenCalled();
});

describe("video model selection when the catalog request fails", () => {
  it.each([
    ["seedance-2.0", "newapi_seedance-2.0"],
    ["newapi_seedance-2.0", "newapi_seedance-2.0"],
    ["seedance-1.5-pro", "newapi_seedance-1.5-pro"],
    ["seedance-1.0-pro-fast", "newapi_seedance-1.0-pro-fast"],
  ])("preserves %s in the fallback catalog", async (persisted, expected) => {
    requestScope.project = `fallback-${persisted}`;
    vi.mocked(fetchFreezoneVideoModels).mockRejectedValueOnce(new Error("catalog unavailable"));
    useCanvasStore.getState().setCanvasData([videoNode({ model: persisted })], []);

    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));
    await waitFor(() => {
      expect(getFreezoneVideoModelsSnapshot(requestScope.project).error?.message)
        .toBe("catalog unavailable");
    });
    expect(result.current.selectedVideoModelId).toBe(expected);
  });

  it("submits the standard model instead of Fast after a catalog failure", async () => {
    requestScope.project = "fallback-standard-submit";
    vi.mocked(fetchFreezoneVideoModels).mockRejectedValueOnce(new Error("catalog unavailable"));
    useCanvasStore.getState().setCanvasData([
      videoNode({ model: "seedance-2.0", genMode: "textToVideo" }),
    ], []);

    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));
    await waitFor(() => {
      expect(getFreezoneVideoModelsSnapshot(requestScope.project).error?.message)
        .toBe("catalog unavailable");
    });
    await act(async () => {
      await result.current.submit();
    });

    expect(payloadOf(submitFreezoneVideoGen)).toMatchObject({ model: "newapi_seedance-2.0" });
  });
});

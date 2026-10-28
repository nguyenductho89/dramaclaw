// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// The dedicated guidance for "assets with a real person blocked by content safety" relies on finding the vendor error code in the **faithful** diagnostic
// payload. The normalized display copy does not carry this code — once the policy check is changed back to scan resolved/display,
// the user sees only a vague "Video generation failed" and does not know to turn on the "Real-person asset review" switch.
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { submitFreezoneVideoGen } from "@/api/ops";
import { showErrorDialog } from "@/features/canvas/application/errorDialog";
import { compileWorkflowNodePrompt } from "@/features/canvas/application/workflowRecipeRuntime";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { useVideoGenerationForm } from "@/features/canvas/nodes/shared/useVideoGenerationForm";
import { useCanvasStore } from "@/stores/canvasStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

// t returns the key: simulating the real runtime "with translations", so the display copy therefore does not contain the vendor error code —
// which is exactly the two paths this case must tell apart.
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => `translated:${key}` }),
}));

vi.mock("@/lib/queries/generation-credit-cost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/generation-credit-cost")>()),
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));

vi.mock("@/lib/url-params", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-params")>()),
  readUrl: () => ({ project: "demo-project", canvas: "default" }),
}));

vi.mock("@/features/canvas/application/errorDialog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/canvas/application/errorDialog")>()),
  showErrorDialog: vi.fn(async () => undefined),
}));

vi.mock("@/features/canvas/application/workflowRecipeRuntime", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("@/features/canvas/application/workflowRecipeRuntime")>();
  return { ...original, compileWorkflowNodePrompt: vi.fn(original.compileWorkflowNodePrompt) };
});

const POLICY_CODE = "InputImageSensitiveContentDetected.PrivateInformation";
const RAW_BACKEND_ERROR = `provider rejected: ${POLICY_CODE} (request_id=req-xyz789)`;

vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneVideoModels: vi.fn(async () => [
    {
      id: "huimeng/test-video",
      providerId: "huimeng",
      apiModel: "test_video_api",
      label: "Test video model",
      humanReview: true,
      supportedModes: ["text_to_video", "first_frame"],
    },
  ]),
  fetchFreezoneVideoCameraTemplates: vi.fn(async () => []),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  submitFreezoneVideoGen: vi.fn(async () => {
    throw new Error(RAW_BACKEND_ERROR);
  }),
  submitFreezoneVideoKeyframes: vi.fn(async () => {
    throw new Error(RAW_BACKEND_ERROR);
  }),
}));

function seed() {
  useCanvasStore.getState().setCanvasData(
    [
      {
        id: "vid-1",
        type: CANVAS_NODE_TYPES.video,
        position: { x: 0, y: 0 },
        data: {
          prompt: "A cat jumps onto the table",
          modelId: "huimeng/test-video",
          genMode: "textToVideo",
        },
      } as CanvasNode,
    ],
    [],
  );
}

describe("VideoNode error notification contract", () => {
  beforeEach(() => {
    vi.mocked(showErrorDialog).mockClear();
    seed();
  });

  it("routes a policy-blocked failure to the real-person-review guidance", async () => {
    useCanvasStore.getState().setCanvasData([
      {
        id: "vid-1", type: CANVAS_NODE_TYPES.video, position: { x: 0, y: 0 },
        data: { prompt: "a cat", model: "huimeng/test-video", genMode: "firstFrame" },
      } as CanvasNode,
      {
        id: "img-1", type: CANVAS_NODE_TYPES.upload, position: { x: 0, y: 0 },
        data: { imageUrl: "/static/frame.png" },
      } as CanvasNode,
    ], [{ id: "ref", source: "img-1", target: "vid-1" }]);
    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(false);
    });
    await result.current.submit().catch(() => undefined);

    await waitFor(() => {
      expect(showErrorDialog).toHaveBeenCalled();
    });
    const dialogCalls = vi.mocked(showErrorDialog).mock.calls;
    const [message, title, details] = dialogCalls[dialogCalls.length - 1];
    expect(String(message)).toContain("node.videoNode.generation.faceBlockedMessage");
    expect(String(title)).toContain("node.videoNode.generation.faceBlockedTitle");
    // The diagnostic payload is passed through to the dialog as is — what shows when expanding "Details" must be the vendor's original text.
    expect(String(details)).toContain(POLICY_CODE);
  });

  it("does not tell text-to-video users to enable a hidden review switch", async () => {
    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));
    await waitFor(() => expect(result.current.submitDisabled).toBe(false));
    await result.current.submit();
    const calls = vi.mocked(showErrorDialog).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(String(calls[calls.length - 1][0])).not.toContain("Real-person asset review");
  });

  it("falls back to the generic dialog when the failure is not policy-related", async () => {
    vi.mocked(submitFreezoneVideoGen).mockImplementationOnce(async () => {
      throw new Error("upstream timed out (request_id=req-timeout)");
    });

    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(false);
    });
    await result.current.submit().catch(() => undefined);

    await waitFor(() => {
      expect(showErrorDialog).toHaveBeenCalled();
    });
    const dialogCalls = vi.mocked(showErrorDialog).mock.calls;
    const [message] = dialogCalls[dialogCalls.length - 1];
    expect(String(message)).not.toContain("node.videoNode.generation.faceBlockedMessage");
  });

  it("records a Recipe compilation failure on the node for the workflow runner", async () => {
    const ended = "recipe attempt ended (failed); rerun the node to start a new attempt";
    vi.mocked(compileWorkflowNodePrompt).mockRejectedValueOnce(new Error(ended));
    vi.mocked(submitFreezoneVideoGen).mockClear();

    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(false);
    });
    await result.current.submit().catch(() => undefined);

    const data = useCanvasStore.getState().nodes.find((node) => node.id === "vid-1")?.data;
    expect(data?.generationError).toContain(ended);
    expect(data?.isGenerating).toBe(false);
    expect(submitFreezoneVideoGen).not.toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// The three fields left on the node on generation failure must each do their own job:
//   generationError        → the localized/normalized copy shown to the user
//   generationErrorDetails → the raw backend payload, untouched (tickets rely on it)
//   generationErrorRequestId → the request id extracted from the raw payload
// Overwriting details with display is the easiest regression to make, and it is invisible in the UI.
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { submitFreezoneGen } from "@/api/ops";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { useImageGenerationForm } from "@/features/canvas/nodes/shared/useImageGenerationForm";
import { InsufficientCreditsError } from "@/lib/api-errors";
import { useCanvasStore } from "@/stores/canvasStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

// Key point: t returns the key rather than defaultValue, so the "localized display copy" and the "raw backend
// payload" naturally differ, and the assertions can prove the two were stored separately. The real runtime is like this too (translations exist).
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

const RAW_BACKEND_ERROR =
  "gateway rejected the request: quota exhausted (request_id=req-abc123)";

vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneImageModels: vi.fn(async () => [
    {
      id: "huimeng/test-image",
      providerId: "huimeng",
      apiModel: "test_image_api",
      label: "Test model",
    },
  ]),
  listFreezoneStyleTemplates: vi.fn(async () => []),
  fetchFreezoneCameraOptions: vi.fn(async () => null),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  submitFreezoneGen: vi.fn(async () => {
    throw new InsufficientCreditsError(RAW_BACKEND_ERROR, 402);
  }),
}));

// After the whole batch fails an error dialog pops up once, which the test tree does not need.
vi.mock("@/features/canvas/application/errorDialog", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/canvas/application/errorDialog")
  >()),
  showErrorDialog: vi.fn(async () => undefined),
}));

function seed() {
  useCanvasStore.getState().setCanvasData(
    [
      {
        id: "img-1",
        type: CANVAS_NODE_TYPES.imageGen,
        position: { x: 0, y: 0 },
        data: { prompt: "A cat on the windowsill", modelId: "huimeng/test-image" },
      } as CanvasNode,
    ],
    [],
  );
}

function nodeData(): Record<string, unknown> {
  return (useCanvasStore.getState().nodes.find((n) => n.id === "img-1")?.data ??
    {}) as Record<string, unknown>;
}

describe("ImageGen error notification contract", () => {
  beforeEach(() => {
    seed();
  });

  it("shows structured reference validation errors from the shared image form", async () => {
    const issue = {
      media: "image", index: 1, name: "small.png", reference_key: "freezone/small.png",
      code: "minWidth", actual: 200, expected: 300,
    };
    vi.mocked(submitFreezoneGen).mockRejectedValueOnce({
      body: { detail: { code: "REFERENCE_MEDIA_INVALID", errors: [issue] } },
    });
    const { result } = renderHook(() => useImageGenerationForm("img-1"));
    await waitFor(() => expect(result.current.submitDisabled).toBe(false));
    await result.current.submit().catch(() => undefined);
    await waitFor(() => expect(result.current.referenceErrors).toHaveLength(1));
    expect(result.current.referenceErrors[0]).toMatchObject(issue);
    expect(result.current.referenceErrorsOpen).toBe(true);
    expect(nodeData().generationError).toBe("translated:referenceValidation.title");
    expect(nodeData().isGenerating).toBe(false);
  });

  it("stores the raw backend error separately from the displayed message", async () => {
    const { result } = renderHook(() => useImageGenerationForm("img-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(false);
    });
    await result.current.submit().catch(() => undefined);

    await waitFor(() => {
      expect(nodeData().generationErrorDetails).toBeTruthy();
    });

    // The raw payload stays in details untouched.
    expect(nodeData().generationErrorDetails).toBe(RAW_BACKEND_ERROR);
    // The display copy is localized, so it does not equal the raw payload.
    expect(nodeData().generationError).toBe("translated:common.insufficientCredits");
    expect(nodeData().generationError).not.toBe(RAW_BACKEND_ERROR);
    // The request id is extracted from the raw payload and stored separately for tickets to cite.
    expect(nodeData().generationErrorRequestId).toBe("req-abc123");
    // A failure must end loading, otherwise the node keeps spinning forever.
    expect(nodeData().isGenerating).toBe(false);
  });

  it("localizes storage failures while preserving their raw diagnostic details", async () => {
    const raw = "Request error: MediaStorageUnavailable('MEDIA_STORAGE_ACCESS_DENIED: Media storage access denied.')";
    vi.mocked(submitFreezoneGen).mockRejectedValueOnce(new Error(raw));
    const { result } = renderHook(() => useImageGenerationForm("img-1"));
    await waitFor(() => expect(result.current.submitDisabled).toBe(false));
    await result.current.submit().catch(() => undefined);
    await waitFor(() => expect(nodeData().generationErrorDetails).toBe(raw));
    expect(nodeData().generationError).toBe(
      "MEDIA_STORAGE_ACCESS_DENIED: translated:settings.mediaStorage.errors.MEDIA_STORAGE_ACCESS_DENIED",
    );
    expect(nodeData().isGenerating).toBe(false);
  });
});

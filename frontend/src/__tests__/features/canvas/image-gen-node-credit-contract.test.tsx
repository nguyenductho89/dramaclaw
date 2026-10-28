// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Billing contract of image generation — **behavioral assertions**, not source grep.
//
// Quote and submit-disabled conditions live in `useImageGenerationForm`, and the workflow ImageGenNode and
// the storyboard AssetBoardImageGenForm both mount it, so asserting against the hook covers both views at once.
// This file replaces the old readFileSync + toContain version: after a refactor moved the code into a new
// file, that style still "passed" as long as the string moved along, with zero verification power.
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { submitFreezoneGen } from "@/api/ops";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { useImageGenerationForm } from "@/features/canvas/nodes/shared/useImageGenerationForm";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useCanvasStore } from "@/stores/canvasStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

vi.mock("react-i18next", async () => {
  const { enT } = await import("@/__tests__/helpers/i18n-fixtures");
  return { useTranslation: () => ({ t: enT }) };
});

// Replace only the hook, keeping the real BillingRuleNotConfiguredError — the assertions depend on instanceof.
vi.mock("@/lib/queries/generation-credit-cost", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/queries/generation-credit-cost")>()),
  useGenerationCreditCost: vi.fn(() => ({ data: undefined, error: null })),
}));

vi.mock("@/lib/url-params", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/url-params")>()),
  readUrl: () => ({ project: "demo-project", canvas: "default" }),
}));

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
  submitFreezoneGen: vi.fn(async () => ({
    task_key: "task-1",
    task_type: "freezone_gen",
    job_id: "job-1",
  })),
  fetchFreezoneJobResult: vi.fn(async () => ({ url: "/static/out.png" })),
}));

vi.mock("@/api/tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/tasks")>()),
  awaitTaskCompletion: vi.fn(async () => ({
    result: { output_url: "/static/out.png" },
  })),
}));

const IMAGE_GENERATE_FEATURE_KEY = "freezone.image_generate";

function imageNode(data: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "img-1",
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: {
      prompt: "A cat on the windowsill",
      modelId: "huimeng/test-image",
      ...data,
    },
  } as CanvasNode;
}

function seed(data: Record<string, unknown> = {}) {
  useCanvasStore.getState().setCanvasData([imageNode(data)], []);
}

function latestProbe() {
  const featureCalls = vi
    .mocked(useGenerationCreditCost)
    .mock.calls.filter((call) => call[1] === IMAGE_GENERATE_FEATURE_KEY);
  return featureCalls[featureCalls.length - 1] ?? null;
}

function nodeData(): Record<string, unknown> {
  return (useCanvasStore.getState().nodes.find((n) => n.id === "img-1")?.data ??
    {}) as Record<string, unknown>;
}

describe("canvas image generation credit contract", () => {
  beforeEach(() => {
    vi.mocked(useGenerationCreditCost).mockClear();
    vi.mocked(useGenerationCreditCost).mockReturnValue({
      data: undefined,
      error: null,
    } as ReturnType<typeof useGenerationCreditCost>);
    vi.mocked(submitFreezoneGen).mockClear();
  });

  it("quotes the explicit image-generation feature with the requested count", async () => {
    seed({ count: 3 });

    renderHook(() => useImageGenerationForm("img-1"));

    await waitFor(() => {
      expect(latestProbe()).not.toBeNull();
    });
    const [, , options] = latestProbe()!;
    expect(options).toMatchObject({
      surface: "canvas",
      // The count goes into both pricing_quantity and quantity — missing either makes the price count as 1.
      quantity: 3,
      params: expect.objectContaining({ pricing_quantity: 3 }),
    });
  });

  it("blocks submission and reports it on the node when the billing rule is missing", async () => {
    vi.mocked(useGenerationCreditCost).mockReturnValue({
      data: undefined,
      error: new BillingRuleNotConfiguredError("no rule", 409),
    } as unknown as ReturnType<typeof useGenerationCreditCost>);
    seed();

    const { result } = renderHook(() => useImageGenerationForm("img-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(true);
    });

    await result.current.submit();

    expect(submitFreezoneGen).not.toHaveBeenCalled();
    expect(String(nodeData().generationError)).toContain("billing rules are not configured");
    expect(nodeData().generationErrorDetails).toBe(nodeData().generationError);
    expect(nodeData().isGenerating).toBe(false);
  });

  it("allows submission once the billing rule resolves", async () => {
    seed();

    const { result } = renderHook(() => useImageGenerationForm("img-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(false);
    });
  });
});

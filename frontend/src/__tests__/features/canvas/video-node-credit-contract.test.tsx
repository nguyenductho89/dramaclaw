// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Billing contract of video generation — **behavioral assertions**, not source grep.
//
// Quote and submit-disabled conditions live in `useVideoGenerationForm`, and the workflow VideoNode and the storyboard
// AssetBoardVideoGenForm both mount it, so asserting against the hook covers both views at once. This
// file replaces the old readFileSync + toContain version: after a refactor moved the code into a new file,
// that style still "passed" as long as the string moved along, with zero verification power.
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { useVideoGenerationForm } from "@/features/canvas/nodes/shared/useVideoGenerationForm";
import { BillingRuleNotConfiguredError } from "@/lib/api-errors";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
import { useCanvasStore } from "@/stores/canvasStore";
import { submitFreezoneVideoGen } from "@/api/ops";

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
  fetchFreezoneVideoModels: vi.fn(async () => [
    {
      id: "huimeng/test-video",
      providerId: "huimeng",
      apiModel: "test_video_api",
      label: "Test video model",
      catalogId: "catalog-1",
    },
  ]),
  fetchFreezoneVideoCameraTemplates: vi.fn(async () => []),
  listFreezoneGenerationHistory: vi.fn(async () => []),
  submitFreezoneVideoGen: vi.fn(async () => ({
    task_key: "task-1",
    task_type: "freezone_video_gen",
    job_id: "job-1",
  })),
}));

const VIDEO_GENERATE_FEATURE_KEY = "freezone.video_generate";

function videoNode(data: Record<string, unknown> = {}): CanvasNode {
  return {
    id: "vid-1",
    type: CANVAS_NODE_TYPES.video,
    position: { x: 0, y: 0 },
    data: {
      prompt: "A cat jumps onto the table",
      modelId: "huimeng/test-video",
      genMode: "textToVideo",
      ...data,
    },
  } as CanvasNode;
}

function seed(data: Record<string, unknown> = {}) {
  useCanvasStore.getState().setCanvasData([videoNode(data)], []);
}

/** The most recent (value, options) of the quote hook. */
function latestProbe() {
  const calls = vi.mocked(useGenerationCreditCost).mock.calls;
  const featureCalls = calls.filter((call) => call[1] === VIDEO_GENERATE_FEATURE_KEY);
  return featureCalls[featureCalls.length - 1] ?? null;
}

function nodeData(): Record<string, unknown> {
  return (useCanvasStore.getState().nodes.find((n) => n.id === "vid-1")?.data ??
    {}) as Record<string, unknown>;
}

describe("canvas video generation credit contract", () => {
  beforeEach(() => {
    vi.mocked(useGenerationCreditCost).mockClear();
    vi.mocked(useGenerationCreditCost).mockReturnValue({
      data: undefined,
      error: null,
    } as ReturnType<typeof useGenerationCreditCost>);
    vi.mocked(submitFreezoneVideoGen).mockClear();
  });

  it("quotes the product feature with the output and input-video parameters", async () => {
    seed({ count: 2, durationSec: 5 });

    renderHook(() => useVideoGenerationForm("vid-1"));

    await waitFor(() => {
      expect(latestProbe()).not.toBeNull();
    });
    const [, , options] = latestProbe()!;
    expect(options).toMatchObject({
      surface: "canvas",
      quantity: 2,
      params: expect.objectContaining({
        catalog_id: "catalog-1",
        video_backend: "test_video_api",
        operation: "textToVideo",
        // Video is priced by "count × duration", not by count.
        pricing_quantity: 2 * 5,
        video_input_present: false,
        input_video_duration_seconds: 0,
      }),
    });
  });

  it("blocks submission and reports it on the node when the billing rule is missing", async () => {
    vi.mocked(useGenerationCreditCost).mockReturnValue({
      data: undefined,
      error: new BillingRuleNotConfiguredError("no rule", 409),
    } as unknown as ReturnType<typeof useGenerationCreditCost>);
    seed();

    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(true);
    });

    await result.current.submit();

    expect(submitFreezoneVideoGen).not.toHaveBeenCalled();
    expect(String(nodeData().generationError)).toContain("billing rules are not configured");
    expect(nodeData().generationErrorDetails).toBe(nodeData().generationError);
    expect(nodeData().isGenerating).toBe(false);
  });

  it("gates the error-state regenerate path on the billing rule too", async () => {
    // The retry button on the failure banner is the only entry that can still submit while the node is unselected, and its disabled is wired
    // to submitDisabled (VideoNode.tsx); handleSubmit also blocks once more at the start.
    vi.mocked(useGenerationCreditCost).mockReturnValue({
      data: undefined,
      error: new BillingRuleNotConfiguredError("no rule", 409),
    } as unknown as ReturnType<typeof useGenerationCreditCost>);
    seed({ generationError: "Upstream service timed out", isGenerating: false });

    const { result } = renderHook(() =>
      // Unselected — the host turned off regular quoting, and the failure state must still get the billing gate.
      useVideoGenerationForm("vid-1", { costProbeEnabled: false }),
    );

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(true);
    });

    await result.current.submit();
    expect(submitFreezoneVideoGen).not.toHaveBeenCalled();
  });

  it("allows submission once the billing rule resolves", async () => {
    seed();

    const { result } = renderHook(() => useVideoGenerationForm("vid-1"));

    await waitFor(() => {
      expect(result.current.submitDisabled).toBe(false);
    });
  });
});

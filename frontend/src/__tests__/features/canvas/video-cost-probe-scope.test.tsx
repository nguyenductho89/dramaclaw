// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { useVideoGenerationForm } from "@/features/canvas/nodes/shared/useVideoGenerationForm";
import { useGenerationCreditCost } from "@/lib/queries/generation-credit-cost";
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
  }),
}));

// Quoting goes through react-query and there is no QueryClientProvider in the test tree — short-circuited to a spy,
// which only watches what value it is fed (null = no request sent).
vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: vi.fn(() => ({ data: undefined, error: null })),
  BillingRuleNotConfiguredError: class BillingRuleNotConfiguredError extends Error {},
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
    },
  ]),
  fetchFreezoneVideoCameraTemplates: vi.fn(async () => []),
  listFreezoneGenerationHistory: vi.fn(async () => []),
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

/** The feature key the quote hook most recently received (null means no request this round). */
function latestProbeValue(): string | null {
  const calls = vi.mocked(useGenerationCreditCost).mock.calls;
  if (calls.length === 0) return null;
  return (calls[calls.length - 1][1] ?? null) as string | null;
}

function everyProbeValue(): Array<string | null> {
  return vi
    .mocked(useGenerationCreditCost)
    .mock.calls.map((call) => (call[1] ?? null) as string | null);
}

describe("video generation cost probe scope", () => {
  beforeEach(() => {
    vi.mocked(useGenerationCreditCost).mockClear();
  });

  it("probes by default so always-mounted hosts keep their quote", async () => {
    useCanvasStore.getState().setCanvasData([videoNode()], []);

    renderHook(() => useVideoGenerationForm("vid-1"));

    await waitFor(() => {
      expect(latestProbeValue()).toBe(VIDEO_GENERATE_FEATURE_KEY);
    });
  });

  it("never probes for an idle node whose host disabled the probe", async () => {
    useCanvasStore.getState().setCanvasData([videoNode()], []);

    renderHook(() =>
      useVideoGenerationForm("vid-1", { costProbeEnabled: false }),
    );

    // Let the model list land and run all debounces to completion, confirming no round secretly enabled the quote.
    await waitFor(() => {
      expect(vi.mocked(useGenerationCreditCost).mock.calls.length).toBeGreaterThan(1);
    });
    expect(everyProbeValue().every((value) => value === null)).toBe(true);
  });

  it("still probes a failed node so the regenerate button keeps its billing gate", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [videoNode({ generationError: "Upstream service timed out", isGenerating: false })],
        [],
      );

    renderHook(() =>
      useVideoGenerationForm("vid-1", { costProbeEnabled: false }),
    );

    await waitFor(() => {
      expect(latestProbeValue()).toBe(VIDEO_GENERATE_FEATURE_KEY);
    });
  });
});

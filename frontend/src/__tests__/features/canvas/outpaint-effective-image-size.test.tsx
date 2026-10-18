// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Outpaint panel: the quote, the UI display and the submission must use the same resolution tier.
//
// The panel's `imageSize` is the raw value the user picked last time, defaulting to '2K'. When the backend configures only
// other tiers for a model, `pickAllowedOption` converges it to effectiveImageSize -- the dropdown shows
// the converged value and the quote uses the converged value too, only the submission carried the out-of-range raw value: the user saw A,
// was billed for A, and the backend received B (which could even be judged invalid outright for not being in the catalog tiers).
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OutpaintEditorOverlay } from "@/features/canvas/ui/OutpaintEditorOverlay";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

// NodeToolbar renders content only when mounted on a real ReactFlow store; here only the buttons in the toolbar matter,
// so a pass-through shell replaces it.
vi.mock("@xyflow/react", () => ({
  NodeToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Position: { Top: "top", Bottom: "bottom" },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The backend configured only 1K / 4K for this model -- the panel's default '2K' is not among the tiers.
const CATALOG_MODEL = {
  id: "studio-image-v1",
  providerId: "openrouter" as const,
  apiModel: "google/gemini-2.5-flash-image-preview",
  label: "Studio Image",
  resolutionOptions: ["1K", "4K"],
};

type ImageCatalogState = {
  models: (typeof CATALOG_MODEL)[];
  isLoading: boolean;
  isFallback: boolean;
  error: Error | null;
};

/** Provides a normal catalog by default; an individual case can switch to loading / fetch failed / authoritative empty catalog. */
const LOADED_CATALOG: ImageCatalogState = {
  models: [CATALOG_MODEL],
  isLoading: false,
  isFallback: false,
  error: null,
};

let imageCatalogState: ImageCatalogState = LOADED_CATALOG;

// Only the data-fetching hook is replaced; `isAuthoritativeEmptyCatalog` is a pure predicate that the panel
// uses to decide whether to disable submit, so the real implementation must stay.
vi.mock("@/features/canvas/hooks/useFreezoneImageModels", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/canvas/hooks/useFreezoneImageModels")
  >()),
  useFreezoneImageModels: () => imageCatalogState,
  prefetchFreezoneImageModels: () => {},
}));

const submitFreezoneOutpaint = vi.fn();
const fetchFreezoneJobResult = vi.fn();
const awaitTaskCompletion = vi.fn();
const useGenerationCreditCost = vi.fn();

vi.mock("@/api/ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ops")>();
  return {
    ...actual,
    submitFreezoneOutpaint: (...args: unknown[]) => submitFreezoneOutpaint(...args),
    fetchFreezoneJobResult: (...args: unknown[]) => fetchFreezoneJobResult(...args),
  };
});

vi.mock("@/api/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/tasks")>();
  return {
    ...actual,
    awaitTaskCompletion: (...args: unknown[]) => awaitTaskCompletion(...args),
  };
});

vi.mock("@/lib/url-params", () => ({
  readUrl: () => ({ project: "demo", canvas: "default" }),
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: (...args: unknown[]) => useGenerationCreditCost(...args),
}));

const NODE: CanvasNode = {
  id: "src-node",
  type: "exportImage",
  position: { x: 0, y: 0 },
  data: {
    imageUrl: "https://x/src.png",
    aspectRatio: "1:1",
  },
} as unknown as CanvasNode;

function renderOverlay() {
  return render(
    <OutpaintEditorOverlay
      node={NODE}
      imageSource="https://x/src.png?token=1"
      onClose={() => {}}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  imageCatalogState = LOADED_CATALOG;
  submitFreezoneOutpaint.mockResolvedValue({
    task_type: "freezone_image",
    job_id: "out-1",
    task_key: "freezone_image:out-1",
  });
  awaitTaskCompletion.mockResolvedValue({ result: { output_url: "https://x/out.png" } });
  useGenerationCreditCost.mockReturnValue({ data: undefined, error: null });
});

describe("outpaint panel resolution tiers", () => {
  it("submits the converged tier, not the out-of-range raw selection", async () => {
    renderOverlay();
    fireEvent.click(screen.getByTitle("outpaintEditor.submit"));

    await waitFor(() => expect(submitFreezoneOutpaint).toHaveBeenCalled());
    const body = submitFreezoneOutpaint.mock.calls[0][1] as Record<string, unknown>;
    // The default state is '2K', but the model has only 1K / 4K configured -> it must land on the first available tier '1K'.
    expect(body.imageSize).toBe("1K");
    expect(body.imageSize).not.toBe("2K");
  });

  it("the quote and the submission use the same tier", async () => {
    renderOverlay();
    const quoteOptions = useGenerationCreditCost.mock.calls[0][2] as {
      params: Record<string, unknown>;
    };
    fireEvent.click(screen.getByTitle("outpaintEditor.submit"));

    await waitFor(() => expect(submitFreezoneOutpaint).toHaveBeenCalled());
    const body = submitFreezoneOutpaint.mock.calls[0][1] as Record<string, unknown>;
    // Whatever tier the quote endpoint receives is the tier the backend bills; the submission must be exactly the same.
    expect(body.imageSize).toBe(quoteOptions.params.size);
  });

  it("a tier explicitly picked by the user is submitted as-is when within the allowed range", async () => {
    renderOverlay();
    // Open the resolution dropdown (the trigger shows the current converged value 1K) and pick a tier the model really supports.
    fireEvent.click(screen.getByText("1K"));
    fireEvent.click(screen.getByText("4K"));
    fireEvent.click(screen.getByTitle("outpaintEditor.submit"));

    await waitFor(() => expect(submitFreezoneOutpaint).toHaveBeenCalled());
    const body = submitFreezoneOutpaint.mock.calls[0][1] as Record<string, unknown>;
    expect(body.imageSize).toBe("4K");
  });
});

describe("outpaint panel authoritative empty catalog", () => {
  it("disables submit and sends no request when the backend has no image model configured", () => {
    imageCatalogState = { models: [], isLoading: false, isFallback: false, error: null };
    renderOverlay();
    // This used to carry `?? SHARED_MODELS.find(...)`: the catalog was clearly empty, yet the panel propped itself up with the frontend's
    // hard-coded model, and a user clicking would only receive a 409 from the backend.
    const button = screen.getByTitle("modelParams.noModelsAvailable");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(submitFreezoneOutpaint).not.toHaveBeenCalled();
  });

  it("submit still works when a fetch failure falls back to the fallback list", async () => {
    imageCatalogState = {
      models: [CATALOG_MODEL],
      isLoading: false,
      isFallback: true,
      error: new Error("boom"),
    };
    renderOverlay();
    fireEvent.click(screen.getByTitle("outpaintEditor.submit"));
    await waitFor(() => expect(submitFreezoneOutpaint).toHaveBeenCalled());
  });
});

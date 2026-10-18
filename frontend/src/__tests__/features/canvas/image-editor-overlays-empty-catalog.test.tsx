// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// The upscale / repaint panels: submit must be disabled when the backend has no image model configured.
//
// Both panels used to tail their model selection with `?? SHARED_MODELS.find(...)`: the catalog was clearly
// empty (the endpoint returned an empty list successfully = the backend's authoritative answer), yet the panel propped itself up with a frontend hard-coded model,
// the UI looked perfectly normal, and only when the user clicked was it bounced back by the backend `_resolve_catalog_request` with a 409.
// The fallback on fetch failure is right (otherwise the user could do nothing at the slightest endpoint hiccup), but disguising "not configured" as
// "configured" is wrong.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { UpscaleEditorOverlay } from "@/features/canvas/ui/UpscaleEditorOverlay";
import { RedrawOverlay } from "@/features/canvas/ui/RedrawOverlay";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

// NodeToolbar renders content only when mounted on a real ReactFlow store; here only the buttons in the toolbar matter.
vi.mock("@xyflow/react", () => ({
  NodeToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Position: { Top: "top", Bottom: "bottom" },
  useStore: (selector: (state: { transform: number[] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

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

const LOADED_CATALOG: ImageCatalogState = {
  models: [CATALOG_MODEL],
  isLoading: false,
  isFallback: false,
  error: null,
};

const EMPTY_CATALOG: ImageCatalogState = {
  models: [],
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

const submitFreezoneUpscale = vi.fn();
const fetchFreezoneJobResult = vi.fn();
const awaitTaskCompletion = vi.fn();
const useGenerationCreditCost = vi.fn();

vi.mock("@/api/ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ops")>();
  return {
    ...actual,
    submitFreezoneUpscale: (...args: unknown[]) => submitFreezoneUpscale(...args),
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

const UPSCALE_NODE: CanvasNode = {
  id: "upscale-node",
  type: "exportImage",
  position: { x: 0, y: 0 },
  data: {
    imageUrl: "https://x/src.png",
    aspectRatio: "1:1",
    upscaleSourceUrl: "https://x/src.png",
  },
} as unknown as CanvasNode;

const REDRAW_NODE: CanvasNode = {
  id: "redraw-node",
  type: "exportImage",
  position: { x: 0, y: 0 },
  data: { imageUrl: "https://x/src.png", aspectRatio: "1:1" },
} as unknown as CanvasNode;

beforeEach(() => {
  vi.clearAllMocks();
  imageCatalogState = LOADED_CATALOG;
  submitFreezoneUpscale.mockResolvedValue({
    task_type: "freezone_image",
    job_id: "up-1",
    task_key: "freezone_image:up-1",
  });
  awaitTaskCompletion.mockResolvedValue({ result: { output_url: "https://x/out.png" } });
  useGenerationCreditCost.mockReturnValue({ data: undefined, error: null });
});

describe("upscale panel", () => {
  it("disables submit and sends no request when the backend has no image model configured", () => {
    imageCatalogState = EMPTY_CATALOG;
    render(<UpscaleEditorOverlay node={UPSCALE_NODE} />);

    const button = screen.getByTitle("modelParams.noModelsAvailable");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(submitFreezoneUpscale).not.toHaveBeenCalled();
  });

  it("submit still works when a fetch failure falls back to the fallback list", async () => {
    imageCatalogState = {
      models: [CATALOG_MODEL],
      isLoading: false,
      isFallback: true,
      error: new Error("boom"),
    };
    render(<UpscaleEditorOverlay node={UPSCALE_NODE} />);

    fireEvent.click(screen.getByTitle("upscaleEditor.submit"));
    await waitFor(() => expect(submitFreezoneUpscale).toHaveBeenCalled());
  });
});

describe("repaint panel", () => {
  it("disables submit when the backend has no image model configured", () => {
    imageCatalogState = EMPTY_CATALOG;
    render(
      <RedrawOverlay
        node={REDRAW_NODE}
        imageSource="https://x/src.png?token=1"
        onClose={() => {}}
      />,
    );

    const button = screen.getByTitle("modelParams.noModelsAvailable");
    expect(button).toBeDisabled();
  });
});

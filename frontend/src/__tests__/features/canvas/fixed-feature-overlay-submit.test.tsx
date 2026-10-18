// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// The 360 panorama / grid action panels: submission must carry the same model and tier used for quoting.
//
// Unit-testing `resolveFixedFeatureModelRequest` can only prove the resolved result is self-consistent; what these two panels
// actually got wrong was never putting the resolved result into the payload -- so assertions must land on the payload the ops helper
// receives.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Scene360Overlay } from "@/features/canvas/ui/Scene360Overlay";
import { GridActionConfirmOverlay } from "@/features/canvas/ui/GridActionConfirmOverlay";
import type { GridActionRequest } from "@/features/canvas/ui/GridActionConfirmOverlay";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

vi.mock("@xyflow/react", () => ({
  NodeToolbar: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Position: { Top: "top", Bottom: "bottom" },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// The first catalog entry is deliberately not the G2 that 360 uses, verifying that backend ordering does not change the 360 execution model.
const CATALOG_MODEL = {
  catalogId: "cat-77",
  id: "studio-image-v1",
  providerId: "openrouter" as const,
  apiModel: "google/gemini-2.5-flash-image-preview",
  label: "Studio Image",
  resolutionOptions: ["1K", "4K"],
  qualityOptions: ["low", "high"],
};

const SCENE_360_MODEL = {
  catalogId: "cat-g2",
  id: "lingshan-g2",
  providerId: "newapi" as const,
  apiModel: "LingShan-G2",
  label: "LingShan-G2",
  resolutionOptions: ["1K", "2K", "4K"],
  qualityOptions: ["low", "medium", "high"],
};

type CatalogModel = typeof CATALOG_MODEL | typeof SCENE_360_MODEL;

type ImageCatalogState = {
  models: CatalogModel[];
  isLoading: boolean;
  isFallback: boolean;
  error: Error | null;
};

/** Provides a normal catalog by default; an individual case can switch to loading / fetch failed / authoritative empty catalog. */
const LOADED_CATALOG: ImageCatalogState = {
  models: [CATALOG_MODEL, SCENE_360_MODEL],
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

const submitFreezoneScene360 = vi.fn();
const submitFreezoneTemplateEdit = vi.fn();
const fetchFreezoneJobResult = vi.fn();
const awaitTaskCompletion = vi.fn();
const useGenerationCreditCost = vi.fn();

vi.mock("@/api/ops", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/api/ops")>();
  return {
    ...actual,
    submitFreezoneScene360: (...args: unknown[]) => submitFreezoneScene360(...args),
    submitFreezoneTemplateEdit: (...args: unknown[]) => submitFreezoneTemplateEdit(...args),
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
  data: { imageUrl: "https://x/src.png", aspectRatio: "1:1" },
} as unknown as CanvasNode;

const JOB_REF = {
  task_type: "freezone_scene_360",
  job_id: "j-1",
  task_key: "freezone_scene_360:j-1",
};

/** The params the quote hook received (the third argument). */
function quotedParams(): Record<string, unknown> {
  const options = useGenerationCreditCost.mock.calls[0][2] as {
    params: Record<string, unknown>;
  };
  return options.params;
}

beforeEach(() => {
  vi.clearAllMocks();
  imageCatalogState = LOADED_CATALOG;
  submitFreezoneScene360.mockResolvedValue(JOB_REF);
  submitFreezoneTemplateEdit.mockResolvedValue({ ...JOB_REF, task_type: "freezone_edit" });
  awaitTaskCompletion.mockResolvedValue({ result: { output_url: "https://x/out.png" } });
  useGenerationCreditCost.mockReturnValue({ data: undefined, error: null });
});

describe("360 panorama panel", () => {
  it("always uses LingShan-G2, and the submission matches the quote parameters", async () => {
    render(
      <Scene360Overlay node={NODE} imageSource="https://x/src.png?t=1" onClose={() => {}} />,
    );
    const quoted = quotedParams();
    fireEvent.click(screen.getByTitle("scene360.submit"));

    await waitFor(() => expect(submitFreezoneScene360).toHaveBeenCalled());
    const payload = submitFreezoneScene360.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.model).toBe(SCENE_360_MODEL.apiModel);
    expect(payload.catalogId).toBe(SCENE_360_MODEL.catalogId);
    expect(payload.imageSize).toBe("2K");
    expect(payload.quality).toBe("medium");
    expect(payload).not.toHaveProperty("aspectRatio");
    expect(screen.queryByText("21:9")).not.toBeInTheDocument();
    // Same source as the quote.
    expect(payload.imageSize).toBe(quoted.size);
    expect(payload.quality).toBe(quoted.quality);
    expect(payload.model).toBe(quoted.image_selection);
    expect(payload.catalogId).toBe(quoted.catalog_id);
  });

  it("disables submit when the catalog has no LingShan-G2, without falling back to the first model", () => {
    imageCatalogState = {
      models: [CATALOG_MODEL],
      isLoading: false,
      isFallback: false,
      error: null,
    };
    render(
      <Scene360Overlay node={NODE} imageSource="https://x/src.png?t=1" onClose={() => {}} />,
    );
    const button = screen.getByTitle("modelParams.noModelsAvailable");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(submitFreezoneScene360).not.toHaveBeenCalled();
  });

  it("disables submit and sends no request when the backend has no image model configured", () => {
    imageCatalogState = { models: [], isLoading: false, isFallback: false, error: null };
    render(
      <Scene360Overlay node={NODE} imageSource="https://x/src.png?t=1" onClose={() => {}} />,
    );
    // This panel has no model selector, and submitting would only get a 409 from the backend `_resolve_catalog_request`.
    const button = screen.getByTitle("modelParams.noModelsAvailable");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(submitFreezoneScene360).not.toHaveBeenCalled();
  });

  it("while the catalog is still loading it does not count as \"no model\" and must not flash unavailable", () => {
    imageCatalogState = {
      models: [SCENE_360_MODEL],
      isLoading: true,
      isFallback: true,
      error: null,
    };
    render(
      <Scene360Overlay node={NODE} imageSource="https://x/src.png?t=1" onClose={() => {}} />,
    );
    expect(screen.getByTitle("scene360.submit")).not.toBeDisabled();
  });
});

describe("grid action panel", () => {
  const REQUEST: GridActionRequest = {
    nodeId: NODE.id,
    key: "multiCameraGrid",
    label: "Multi-Camera 3x3",
    prompt: "Generate a nine-grid multi-camera view",
    cost: 0,
  };

  it("submission carries the model, catalog identity, size and quality used for quoting", async () => {
    render(
      <GridActionConfirmOverlay
        node={NODE}
        imageSource="https://x/src.png?t=1"
        request={REQUEST}
        onClose={() => {}}
      />,
    );
    const quoted = quotedParams();
    fireEvent.click(screen.getByTitle("nodeToolbar.gridMenu.confirmBar.submit"));

    await waitFor(() => expect(submitFreezoneTemplateEdit).toHaveBeenCalled());
    const payload = submitFreezoneTemplateEdit.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.model).toBe(CATALOG_MODEL.apiModel);
    expect(payload.catalogId).toBe(CATALOG_MODEL.catalogId);
    expect(payload.imageSize).toBe("1K");
    expect(payload.quality).toBe("low");
    expect(payload.imageSize).toBe(quoted.size);
    expect(payload.quality).toBe(quoted.quality);
    expect(payload.model).toBe(quoted.image_selection);
    expect(payload.catalogId).toBe(quoted.catalog_id);
    // mode belongs only to the quote dimension and must not be mixed into the model field.
    expect(payload.mode).toBe("multi_camera_nine_grid");
    expect(quoted.mode).toBe("multi_camera_nine_grid");
  });

  it("disables submit and sends no request when the backend has no image model configured", () => {
    imageCatalogState = { models: [], isLoading: false, isFallback: false, error: null };
    render(
      <GridActionConfirmOverlay
        node={NODE}
        imageSource="https://x/src.png?t=1"
        request={REQUEST}
        onClose={() => {}}
      />,
    );
    const button = screen.getByTitle("modelParams.noModelsAvailable");
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(submitFreezoneTemplateEdit).not.toHaveBeenCalled();
  });

  it("submit still works when a fetch failure falls back to the fallback list", async () => {
    imageCatalogState = {
      models: [CATALOG_MODEL],
      isLoading: false,
      isFallback: true,
      error: new Error("boom"),
    };
    render(
      <GridActionConfirmOverlay
        node={NODE}
        imageSource="https://x/src.png?t=1"
        request={REQUEST}
        onClose={() => {}}
      />,
    );
    fireEvent.click(screen.getByTitle("nodeToolbar.gridMenu.confirmBar.submit"));
    await waitFor(() => expect(submitFreezoneTemplateEdit).toHaveBeenCalled());
  });
});

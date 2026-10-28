// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Catalog params are filtered by `modes`: when `MediaModelParameterChip` cannot get a mode, params that declare modes are
// **not rendered at all** (the whole control returns null), so the user cannot see them in the UI and has no way to
// set them.
//
// Of the three image hosts only ImageEditNode has a mode selector, and its `data.generationMode` is undefined until
// the user manually picks one; in the node data of ImageGenNode / StoryboardGenNode there is no
// such field at all. So "pass `data.generationMode` straight to the control" means undefined in all three places —
// the control always hides the params. What is locked here is "what is passed to the control must be the derived mode".
//
// This file replaces the old readFileSync + toContain version: that style passed as long as the strings were still in the source
// file, neither verifying that the derived value is right nor that the control really shows up. It is changed to render assertions here
// — a param is declared under only one mode, and the control appearing/disappearing is the evidence that "the derived value equals that mode".
//
// The submit-side mode is covered up to the ops payload by `catalog-image-model-params.test.ts`; this one only
// watches the render-side wiring, because if the control does not show, a correct submit side has no value to submit.
import { render, renderHook, waitFor } from "@testing-library/react";
import { ReactFlowProvider } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MediaModelParameterDefinition } from "@/api/ops";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { ImageEditNode } from "@/features/canvas/nodes/ImageEditNode";
import { StoryboardGenNode } from "@/features/canvas/nodes/StoryboardGenNode";
import { useImageGenerationForm } from "@/features/canvas/nodes/shared/useImageGenerationForm";
import { MediaModelParameterChip } from "@/features/canvas/ui/MediaModelParameterChip";
import { useCanvasStore } from "@/stores/canvasStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

vi.mock('@/lib/model-task-access', () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));

vi.mock("react-i18next", () => ({
  initReactI18next: { type: "3rdParty", init: () => {} },
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
}));

// Each case swaps out "which params the catalog declares", using each param's own modes as a probe.
const catalog = vi.hoisted(() => ({
  parameters: [] as unknown[],
}));

vi.mock("@/features/canvas/domain/catalogImageModels", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/features/canvas/domain/catalogImageModels")>();
  const buildModel = () =>
    actual.toImageModelDefinition({
      id: "huimeng/test-image",
      providerId: "huimeng",
      apiModel: "test_image_api",
      label: "Test model",
      request: {
        parameters: catalog.parameters,
      } as never,
    });
  return {
    ...actual,
    useCatalogImageModels: () => {
      const model = buildModel();
      return {
        models: [model],
        getModel: () => model,
        isLoading: false,
        isEmpty: false,
      };
    },
  };
});

/** A param visible only under this one `mode`. Control appears == the derived mode is it. */
function paramForMode(mode: string): MediaModelParameterDefinition {
  return {
    key: `p_${mode}`,
    label: `Param ${mode}`,
    control: "number",
    modes: [mode],
  } as unknown as MediaModelParameterDefinition;
}

/** React Flow passes these required props to node components together; just fill them in for tests. */
const REACT_FLOW_NODE_PROPS = {
  type: "",
  draggable: true,
  selectable: true,
  deletable: true,
  dragging: false,
  zIndex: 0,
  isConnectable: true,
  positionAbsoluteX: 0,
  positionAbsoluteY: 0,
} as const;

/** The trigger button of `MediaModelParameterChip` has only an icon, so locate it by title. */
function paramsChip(): HTMLElement | null {
  return document.querySelector('button[title="canvas.modelParams.title"]');
}

function imageGenNode(id: string, data: Record<string, unknown> = {}): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: { prompt: "A cat", modelId: "huimeng/test-image", ...data },
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

beforeEach(() => {
  catalog.parameters = [];
  useCanvasStore.getState().setCanvasData([], []);
});

describe("consequences for the model-param control when the mode is missing", () => {
  it("when mode is undefined, no param that declares modes renders at all", () => {
    const { container } = render(
      <MediaModelParameterChip parameters={[paramForMode("image_to_image")]} onChange={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders once it gets the matching mode", () => {
    render(
      <MediaModelParameterChip
        parameters={[paramForMode("image_to_image")]}
        mode="image_to_image"
        onChange={vi.fn()}
      />,
    );
    expect(paramsChip()).not.toBeNull();
  });
});

describe("the mode ImageGenNode (shared generation form) hands out", () => {
  it("with no reference image it is derived as text-to-image, not left empty", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode("img-1")], []);

    const { result } = renderHook(() => useImageGenerationForm("img-1"));

    await waitFor(() => {
      expect(result.current.formProps.modelParamsMode).toBe("text_to_image");
    });
  });

  it("with an upstream reference image it is derived as image-to-image", async () => {
    useCanvasStore
      .getState()
      .setCanvasData(
        [imageGenNode("img-1"), uploadNode("src-1", "/static/ref.png")],
        [{ id: "e1", source: "src-1", target: "img-1" }],
      );

    const { result } = renderHook(() => useImageGenerationForm("img-1"));

    await waitFor(() => {
      expect(result.current.formProps.modelParamsMode).toBe("image_to_image");
    });
  });

  it("it always has a value even when the node data has no generationMode field", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([imageGenNode("img-1", { generationMode: undefined })], []);

    const { result } = renderHook(() => useImageGenerationForm("img-1"));

    await waitFor(() => {
      expect(result.current.formProps.modelParamsMode).toBeTruthy();
    });
  });
});

describe("the mode ImageEditNode hands to the model-param control", () => {
  function renderNode(data: Record<string, unknown>) {
    return render(
      <ReactFlowProvider>
        {/* The node component only takes these few props passed by React Flow */}
        <ImageEditNode
          {...REACT_FLOW_NODE_PROPS}
          id="edit-1"
          data={data as never}
          selected
          width={520}
          height={520}
        />
      </ReactFlowProvider>,
    );
  }

  it("when the user never picked a mode and there is no upstream image, text-to-image params are still visible", () => {
    catalog.parameters = [paramForMode("text_to_image")];
    const node = {
      id: "edit-1",
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: { model: "huimeng/test-image" },
    } as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);

    renderNode(node.data as Record<string, unknown>);

    // Passing the bare data.generationMode (undefined) would make this null.
    expect(paramsChip()).not.toBeNull();
  });

  it("with an upstream image it is derived as all reference, and only params declared under that mode appear", () => {
    catalog.parameters = [paramForMode("all_reference")];
    const node = {
      id: "edit-1",
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: { model: "huimeng/test-image" },
    } as CanvasNode;
    useCanvasStore
      .getState()
      .setCanvasData(
        [node, uploadNode("src-1", "/static/ref.png")],
        [{ id: "e1", source: "src-1", target: "edit-1" }],
      );

    renderNode(node.data as Record<string, unknown>);

    expect(paramsChip()).not.toBeNull();
  });

  it("with no upstream image the all-reference-only param should not appear (proving the derived value is not arbitrary)", () => {
    catalog.parameters = [paramForMode("all_reference")];
    const node = {
      id: "edit-1",
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: { model: "huimeng/test-image" },
    } as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);

    renderNode(node.data as Record<string, unknown>);

    expect(paramsChip()).toBeNull();
  });

  it("when the user manually picked a mode theirs prevails", () => {
    catalog.parameters = [paramForMode("all_reference")];
    const node = {
      id: "edit-1",
      type: CANVAS_NODE_TYPES.imageEdit,
      position: { x: 0, y: 0 },
      data: { model: "huimeng/test-image", generationMode: "all_reference" },
    } as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);

    renderNode(node.data as Record<string, unknown>);

    expect(paramsChip()).not.toBeNull();
  });
});

describe("the mode StoryboardGenNode hands to the model-param control", () => {
  function seedAndRender(params: MediaModelParameterDefinition[]) {
    catalog.parameters = params;
    const node = {
      id: "sb-1",
      type: CANVAS_NODE_TYPES.storyboardGen,
      position: { x: 0, y: 0 },
      data: { model: "huimeng/test-image", frames: [] },
    } as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);
    render(
      <ReactFlowProvider>
        <StoryboardGenNode
          {...REACT_FLOW_NODE_PROPS}
          id="sb-1"
          data={node.data as never}
          selected
          width={520}
          height={520}
        />
      </ReactFlowProvider>,
    );
  }

  it("always image-to-image (the grid image is always submitted as a reference image), regardless of node data", () => {
    seedAndRender([paramForMode("image_to_image")]);
    expect(paramsChip()).not.toBeNull();
  });

  it("text-to-image-only params never appear on the storyboard generation node", () => {
    seedAndRender([paramForMode("text_to_image")]);
    expect(paramsChip()).toBeNull();
  });
});

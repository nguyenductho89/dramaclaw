// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// The palette button and prompt insertion were extracted together with the generation form UI into `ImageGenerationForm` (which can mount standalone
// outside React Flow), and ImageGenNode itself only renders that component. This locks **the path a user can walk through**:
// the palette appears on the panel → expand to see entries → one click writes the standard phrasing into the prompt.
//
// This file replaces the old readFileSync + toContain version. That style passed as long as strings like `<NodeContext
// PromptPaletteButton` / `insertTextAtCursor(` were still in the source — it would find none of: the button
// not rendering because the palette is empty, an insertion being a no-op because the ref is not wired, or the wrong nodeId fetching another node's
// context.
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { MainlineContext } from "@/features/freezone/context/mainlineContext";
import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { ImageGenerationForm } from "@/features/canvas/nodes/shared/ImageGenerationForm";
import { useImageGenerationForm } from "@/features/canvas/nodes/shared/useImageGenerationForm";
import { useCanvasStore } from "@/stores/canvasStore";

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverMock);

// The palette button's copy goes through i18n keys; here t falls back to the key, convenient for locating by aria-label.
vi.mock("react-i18next", () => ({
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

const PALETTE_BUTTON_LABEL = "node.imageGen.contextPalette.button";

function beatContext(overrides: Partial<MainlineContext> = {}): MainlineContext {
  return {
    kind: "beat",
    projectId: "demo-project",
    episode: 1,
    beat: 2,
    label: "EP1 / Beat 2",
    sketchColors: { "identity:diner_young_man_young_adult": "#FF00FF" },
    propMarkerColors: { "prop:carton": "#B71C1C" },
    ...overrides,
  };
}

/** Host: like ImageGenNode, "hook produces formProps → spread into the form", without React Flow. */
function Host({ nodeId }: { nodeId: string }) {
  const { formProps } = useImageGenerationForm(nodeId);
  return (
    <ImageGenerationForm
      {...formProps}
      onStylePickerOpenChange={() => {}}
      onOpenAssetLibrary={() => {}}
    />
  );
}

function imageGenNode(id: string): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data: { prompt: "", modelId: "huimeng/test-image" },
  } as CanvasNode;
}

function beatContextNode(id: string, ctx: MainlineContext = beatContext()): CanvasNode {
  return {
    id,
    type: CANVAS_NODE_TYPES.beatContext,
    position: { x: 0, y: 0 },
    data: { mainline_context: [ctx] },
  } as CanvasNode;
}

function paletteButton() {
  return screen.queryByRole("button", { name: PALETTE_BUTTON_LABEL });
}

describe("ImageGenNode's context palette", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("when the canvas has a beat context, a palette button appears on the panel", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([imageGenNode("img-1"), beatContextNode("beat-1")], []);

    render(<Host nodeId="img-1" />);

    await waitFor(() => {
      expect(paletteButton()).not.toBeNull();
    });
  });

  it("still works without a beat context, only the entries degrade into anonymous colors", async () => {
    useCanvasStore.getState().setCanvasData([imageGenNode("img-1")], []);

    render(<Host nodeId="img-1" />);

    await waitFor(() => {
      expect(paletteButton()).not.toBeNull();
    });
    fireEvent.click(paletteButton()!);

    // An anonymous entry has no character name, only a color block; the inserted phrasing accordingly carries no quotes.
    const swatch = await screen.findByTitle("#FF00FF");
    fireEvent.click(swatch);

    await waitFor(() => {
      const editor = document.querySelector<HTMLElement>("[contenteditable='true']");
      expect(editor?.textContent ?? "").toContain("#FF00FF-marked character");
    });
    const editor = document.querySelector<HTMLElement>("[contenteditable='true']");
    expect(editor?.textContent ?? "").not.toContain('"');
  });

  it("when the canvas has several beat contexts, only the one it is connected to counts", async () => {
    // With two or more beat contexts → the "unique on the whole canvas" fallback does not apply, and the upstream must be found along edges by nodeId.
    // A wrong nodeId (say hard-coded to another id) would fail to get the named entry here.
    useCanvasStore.getState().setCanvasData(
      [
        imageGenNode("img-1"),
        beatContextNode("beat-1"),
        beatContextNode(
          "beat-2",
          beatContext({
            beat: 7,
            sketchColors: { "identity:rooftop_woman_middle_aged": "#00FFCC" },
            propMarkerColors: {},
          }),
        ),
      ],
      [{ id: "e1", source: "beat-1", target: "img-1", data: { propagates: true } }],
    );

    render(<Host nodeId="img-1" />);

    await waitFor(() => {
      expect(paletteButton()).not.toBeNull();
    });
    fireEvent.click(paletteButton()!);

    expect(await screen.findByText(/diner_young_man_young_adult/)).toBeInTheDocument();
    expect(screen.queryByText(/rooftop_woman_middle_aged/)).toBeNull();
  });

  it("after expanding, clicking an entry inserts the standard phrasing into the prompt editor", async () => {
    useCanvasStore
      .getState()
      .setCanvasData([imageGenNode("img-1"), beatContextNode("beat-1")], []);

    render(<Host nodeId="img-1" />);

    await waitFor(() => {
      expect(paletteButton()).not.toBeNull();
    });
    fireEvent.click(paletteButton()!);

    // A named entry resolves the character name from sketchColors.
    const entry = await screen.findByText(/diner_young_man_young_adult/);
    fireEvent.click(entry);

    // What is inserted is the phrasing of contextPromptPaletteInsertionText: color + "character name".
    await waitFor(() => {
      const editor = document.querySelector<HTMLElement>("[contenteditable='true']");
      expect(editor?.textContent ?? "").toContain(
        '#FF00FF-marked character "diner_young_man_young_adult"',
      );
    });
  });
});

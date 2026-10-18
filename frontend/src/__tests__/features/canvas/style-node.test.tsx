// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { FreezoneStyleTemplate } from "@/api/ops";
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
} from "@/features/canvas/domain/canvasNodes";
import { StyleNode } from "@/features/canvas/nodes/StyleNode";
import { useCanvasStore } from "@/stores/canvasStore";

const TEMPLATES: FreezoneStyleTemplate[] = [
  {
    id: "golden_age",
    label: "Golden Age",
    category: "Era",
    cover: "golden_age/cover.webp",
    samples: ["golden_age/female.webp"],
    style_prompt: "Golden Age prompt",
  },
  {
    id: "cyberpunk",
    label: "Cyberpunk",
    category: "Sci-fi",
    cover: "cyberpunk/cover.webp",
    samples: ["cyberpunk/female.webp"],
    style_prompt: "Cyberpunk prompt",
  },
];

vi.mock("@xyflow/react", async () => {
  const actual =
    await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    Handle: ({ id, type }: { id?: string; type?: string }) => (
      <div data-testid={`handle-${type ?? "unknown"}-${id ?? "default"}`} />
    ),
  };
});

vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
  NodeHeader: ({ titleText }: { titleText: string }) => <div>{titleText}</div>,
}));

vi.mock("@/features/canvas/hooks/useFreezoneStyleTemplates", () => ({
  useFreezoneStyleTemplates: () => ({
    templates: TEMPLATES,
    assetBase: "",
    isLoading: false,
    error: null,
    retry: () => {},
  }),
}));

function seedCanvas(options: { withImageNode: boolean; templateId: string | null }) {
  const nodes: CanvasNode[] = [
    {
      id: "style_1",
      type: CANVAS_NODE_TYPES.style,
      position: { x: 0, y: 0 },
      data: { styleTemplateId: options.templateId },
    } as CanvasNode,
  ];
  const edges: CanvasEdge[] = [];
  if (options.withImageNode) {
    nodes.push({
      id: "image_1",
      type: CANVAS_NODE_TYPES.imageGen,
      position: { x: 400, y: 0 },
      data: { styleTemplateId: options.templateId, prompt: "" },
    } as CanvasNode);
    edges.push({
      id: "e-style_1-image_1",
      source: "style_1",
      target: "image_1",
    } as CanvasEdge);
  }
  useCanvasStore.getState().setCanvasData(nodes, edges);
}

function renderStyleNode(templateId: string | null) {
  const node = useCanvasStore.getState().nodes.find((item) => item.id === "style_1");
  return render(
    <StyleNode
      id="style_1"
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {...({ type: CANVAS_NODE_TYPES.style, dragging: false, zIndex: 0 } as any)}
      data={(node?.data as { styleTemplateId: string | null }) ?? { styleTemplateId: templateId }}
    />,
  );
}

describe("StyleNode", () => {
  beforeEach(() => {
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("the card holds only the cover, and the style name goes in the node title", () => {
    seedCanvas({ withImageNode: true, templateId: "golden_age" });
    renderStyleNode("golden_age");

    expect(screen.getByAltText("Golden Age")).toHaveAttribute(
      "src",
      "/style-gallery/golden_age/cover.webp",
    );
    // The title carries the category and follows when the style changes; the card no longer has a second place with the style name.
    expect(screen.getByText("Style · Era · Golden Age")).toBeInTheDocument();
    expect(screen.queryByText("Golden Age")).not.toBeInTheDocument();
  });

  it("the title is not overwritten by the style after the user renamed it", () => {
    seedCanvas({ withImageNode: true, templateId: "golden_age" });
    render(
      <StyleNode
        id="style_1"
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        {...({ type: CANVAS_NODE_TYPES.style, dragging: false, zIndex: 0 } as any)}
        data={{ styleTemplateId: "golden_age", displayName: "Hero visual style" }}
      />,
    );

    expect(screen.getByText("Hero visual style")).toBeInTheDocument();
  });

  it("writes the picked style to the downstream image node, not to itself", async () => {
    const user = userEvent.setup();
    seedCanvas({ withImageNode: true, templateId: "golden_age" });
    renderStyleNode("golden_age");

    await user.click(screen.getByRole("button", { name: "Style Golden Age" }));
    await user.click(screen.getByRole("button", { name: "Use Cyberpunk" }));

    const nodes = useCanvasStore.getState().nodes;
    // The source of truth is the image node; the style node's own data is aligned by reconciliation over there, and is not written here.
    expect(
      (nodes.find((node) => node.id === "image_1")?.data as { styleTemplateId?: string })
        ?.styleTemplateId,
    ).toBe("cyberpunk");
    expect(
      (nodes.find((node) => node.id === "style_1")?.data as { styleTemplateId?: string })
        ?.styleTemplateId,
    ).toBe("golden_age");
  });

  it("clearing the style in the gallery clears the downstream image node", async () => {
    const user = userEvent.setup();
    seedCanvas({ withImageNode: true, templateId: "golden_age" });
    renderStyleNode("golden_age");

    await user.click(screen.getByRole("button", { name: "Style Golden Age" }));
    await user.click(screen.getByRole("button", { name: "Clear style" }));

    expect(
      (
        useCanvasStore
          .getState()
          .nodes.find((node) => node.id === "image_1")?.data as {
          styleTemplateId?: string | null;
        }
      )?.styleTemplateId,
    ).toBeNull();
  });

  it("the button at the top right can open the gallery", async () => {
    const user = userEvent.setup();
    seedCanvas({ withImageNode: true, templateId: "golden_age" });
    renderStyleNode("golden_age");

    await user.click(screen.getByRole("button", { name: "Change style" }));

    expect(
      screen.getByRole("button", { name: "View Cyberpunk details" }),
    ).toBeInTheDocument();
  });

  it("stays inert when no image node consumes it", async () => {
    const user = userEvent.setup();
    seedCanvas({ withImageNode: false, templateId: "golden_age" });
    renderStyleNode("golden_age");

    expect(screen.getByText("No image node connected")).toBeInTheDocument();
    // It cannot write anywhere, so the entry button should not show either.
    expect(screen.queryByRole("button", { name: "Change style" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Style Golden Age" }));
    // The gallery must not open — with no downstream image node a style change would be written nowhere.
    expect(
      screen.queryByRole("button", { name: "View Cyberpunk details" }),
    ).not.toBeInTheDocument();
  });
});

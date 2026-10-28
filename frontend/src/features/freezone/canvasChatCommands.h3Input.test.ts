import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNode } from "@/features/canvas/domain/canvasNodes";
import { isWorkflowUserInputNode } from "./canvasChatCommands";

function imageNode(data: Record<string, unknown>): CanvasNode {
  return {
    id: "img-1",
    type: CANVAS_NODE_TYPES.imageGen,
    position: { x: 0, y: 0 },
    data,
  } as unknown as CanvasNode;
}

describe("isWorkflowUserInputNode with H3 template inputs", () => {
  it("keeps an uploaded picture instead of regenerating it from the template prompt", () => {
    expect(
      isWorkflowUserInputNode(
        imageNode({ h3TemplateInput: true, prompt: "a sunlit staircase", referenceImageUrl: "/static/a.png" }),
      ),
    ).toBe(true);
  });

  it("still generates a template input that has no upload", () => {
    expect(isWorkflowUserInputNode(imageNode({ h3TemplateInput: true, prompt: "a sunlit staircase" }))).toBe(false);
  });

  it("does not change ordinary image nodes that have both a prompt and a reference", () => {
    expect(isWorkflowUserInputNode(imageNode({ prompt: "x", referenceImageUrl: "/static/a.png" }))).toBe(false);
  });
});

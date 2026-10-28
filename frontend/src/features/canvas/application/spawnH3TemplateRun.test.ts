import { describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { H3_PROMPT_TEMPLATES, h3TemplateRunnablePrompt } from "@/features/canvas/domain/h3PromptTemplates";
import { spawnH3TemplateInputs, type SpawnH3TemplateDeps } from "./spawnH3TemplateRun";

function makeDeps(rejectIndex?: number) {
  let counter = 0;
  const calls: Array<{ type: string; data: Record<string, unknown> | undefined }> = [];
  const edges: Array<[string, string]> = [];
  const deps: SpawnH3TemplateDeps = {
    addNode: vi.fn((type, _position, data) => {
      calls.push({ type, data: data as Record<string, unknown> | undefined });
      counter += 1;
      return `n${counter}`;
    }),
    addEdge: vi.fn((source, target) => {
      if (rejectIndex !== undefined && edges.length === rejectIndex) {
        edges.push([source, target]);
        return null;
      }
      edges.push([source, target]);
      return `e-${source}-${target}`;
    }),
    autoGroupSpawn: vi.fn(() => "group-1"),
    updateNodeData: vi.fn(),
  };
  return { deps, calls, edges };
}

const target = { id: "video-1", position: { x: 1000, y: 200 }, height: 400 };

describe("spawnH3TemplateInputs", () => {
  it("creates one image node per picture, connected in order, and fills the video node", () => {
    const template = H3_PROMPT_TEMPLATES.find((item) => item.id === "fal_desert_fashion")!;
    const { deps, calls, edges } = makeDeps();
    const result = spawnH3TemplateInputs(target, template, { genMode: "imageReference" }, deps);

    expect(calls.map((call) => call.type)).toEqual(Array(4).fill(CANVAS_NODE_TYPES.imageGen));
    expect(calls[0].data).toMatchObject({
      h3TemplateInput: true,
      user_spawned: true,
      aspectRatio: "16:9",
      prompt: template.inputs[0].imagePrompt,
    });
    expect(edges).toEqual([
      ["n1", "video-1"],
      ["n2", "video-1"],
      ["n3", "video-1"],
      ["n4", "video-1"],
    ]);
    expect(result.imageNodeIds).toEqual(["n1", "n2", "n3", "n4"]);
    expect(result.rejectedNodeIds).toEqual([]);

    expect(deps.updateNodeData).toHaveBeenCalledWith(
      "video-1",
      expect.objectContaining({
        genMode: "imageReference",
        prompt: h3TemplateRunnablePrompt(template),
        aspectRatio: template.aspectRatio,
        durationSec: template.durationSec,
        cameraMovement: null,
        referenceOrder: ["n1", "n2", "n3", "n4"],
      }),
    );
    expect(deps.autoGroupSpawn).toHaveBeenCalledWith("video-1", ["n1", "n2", "n3", "n4"], {
      label: template.title.en,
    });
  });

  it("creates an audio node after the pictures for audio-driven templates", () => {
    const template = H3_PROMPT_TEMPLATES.find((item) => item.id === "voice_cloned_narration")!;
    const { deps, calls } = makeDeps();
    const result = spawnH3TemplateInputs(target, template, { genMode: "imageReference" }, deps);
    expect(calls.map((call) => call.type)).toEqual([
      CANVAS_NODE_TYPES.imageGen,
      CANVAS_NODE_TYPES.imageGen,
      CANVAS_NODE_TYPES.audio,
    ]);
    expect(calls[2].data).not.toHaveProperty("prompt");
    expect(result.audioNodeIds).toEqual(["n3"]);
    expect(deps.updateNodeData).toHaveBeenCalledWith(
      "video-1",
      expect.objectContaining({ referenceOrder: ["n1", "n2", "n3"] }),
    );
  });

  it("stacks inputs to the left of the video node without overlapping", () => {
    const template = H3_PROMPT_TEMPLATES.find((item) => item.id === "fal_binocular_film")!;
    const { deps } = makeDeps();
    spawnH3TemplateInputs(target, template, {}, deps);
    const positions = (deps.addNode as ReturnType<typeof vi.fn>).mock.calls.map((call) => call[1]);
    expect(new Set(positions.map((p) => p.x)).size).toBe(1);
    expect(positions[0].x).toBeLessThan(target.position.x);
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i].y - positions[i - 1].y).toBeGreaterThanOrEqual(360);
    }
  });

  it("reports inputs whose edge was rejected", () => {
    const template = H3_PROMPT_TEMPLATES.find((item) => item.id === "fal_desert_fashion")!;
    const { deps } = makeDeps(2);
    const result = spawnH3TemplateInputs(target, template, {}, deps);
    expect(result.rejectedNodeIds).toEqual(["n3"]);
  });
});

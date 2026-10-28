// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { getDownstreamSpawnTypes } from "@/features/canvas/domain/nodeRegistry";
import { NodeSelectionMenu } from "@/features/canvas/NodeSelectionMenu";

const translations: Record<string, string> = {
  "node.menu.sectionAddNode": "Add node",
  "node.menu.sectionAddResource": "Add resource",
  "node.menu.sectionSkillNode": "Skill node",
  "node.menu.uploadImage": "Upload resource",
  "node.menu.image": "Image",
  "node.menu.aiImageGeneration": "AI Image",
  "node.menu.storyboard": "Cell extraction result",
  "node.menu.storyboardGen": "Multi-version grid",
  "node.menu.beatContext": "Shot context",
  "node.menu.textAnnotation": "Text",
  "node.menu.video": "Video",
  "node.menu.audio": "Audio",
  "node.menu.videoStory": "Video story",
  "node.menu.videoCompose": "Video compose",
  "node.menu.script": "Script",
  "node.menu.pano360Viewer": "360° Panorama",
  "node.menu.threeDWorld": "3D World",
  "node.menu.videoBreakdown": "Frame-by-frame breakdown",
  "canvas.nodeMenu.referenceGenerate": "Generate from this node",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => translations[key] ?? key,
  }),
}));

describe("NodeSelectionMenu", () => {
  it("shows standalone shot context in the add-node menu", () => {
    render(
      <NodeSelectionMenu
        position={{ x: 12, y: 16 }}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Shot context")).toBeInTheDocument();
  });

  it("offers Frame-by-frame breakdown when dragging a line out of a video node", () => {
    // The "Generate from this node" entries are hand-written: a type the allowlist lets through
    // but that has no entry here would be silently swallowed -- feed in the real downstream
    // candidates so a missing entry fails right here.
    const allowedTypes = getDownstreamSpawnTypes(CANVAS_NODE_TYPES.video);
    expect(allowedTypes).toContain(CANVAS_NODE_TYPES.videoBreakdown);

    render(
      <NodeSelectionMenu
        position={{ x: 12, y: 16 }}
        allowedTypes={allowedTypes}
        onSelect={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(screen.getByText("Generate from this node")).toBeInTheDocument();
    expect(screen.getByText("Frame-by-frame breakdown")).toBeInTheDocument();
  });
});

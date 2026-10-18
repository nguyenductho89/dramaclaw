// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

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
});

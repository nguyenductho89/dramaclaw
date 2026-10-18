// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { CanvasAddNodePanel } from "@/features/canvas/ui/CanvasAddNodePanel";

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

describe("CanvasAddNodePanel", () => {
  it("shows standalone shot context in the quick add panel", async () => {
    const user = userEvent.setup();
    const onSelectNode = vi.fn();
    const onClose = vi.fn();

    render(
      <CanvasAddNodePanel skillItems={[]} onSelectNode={onSelectNode} onSelectSkill={vi.fn()} onClose={onClose} />,
    );

    await user.click(screen.getByRole("button", { name: /Shot context/ }));

    expect(onSelectNode).toHaveBeenCalledWith(CANVAS_NODE_TYPES.beatContext);
    expect(onClose).toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { H3PromptPreview, buildH3PictureMap, splitH3PromptTags } from "./h3-prompt-preview";

describe("buildH3PictureMap", () => {
  it("numbers the first frame as Picture 1 and skips scenes for subjects", () => {
    const map = buildH3PictureMap({
      firstFrame: { name: "Render", src: "/f.png" },
      lastFrame: null,
      references: [
        { kind: "character", name: "Yui (modern schoolgirl)", src: "/a.png" },
        { kind: "scene", name: "Nihonbashi Bridge", src: "/s.png" },
        { kind: "prop", name: "phone", src: "/p.png" },
      ],
    });
    expect(map.pictures[1].name).toBe("Render");
    expect(map.pictures[2].name).toBe("Yui (modern schoolgirl)");
    expect(map.pictures[3].name).toBe("Nihonbashi Bridge");
    expect(map.pictures[4].name).toBe("phone");
    expect(map.subjects[1].name).toBe("Yui (modern schoolgirl)");
    expect(map.subjects[2].name).toBe("phone");
    expect(map.subjects[3]).toBeUndefined();
  });

  it("starts references at Picture 1 when there is no first frame", () => {
    const map = buildH3PictureMap({
      firstFrame: null,
      lastFrame: null,
      references: [{ kind: "character", name: "Yui", src: null }],
    });
    expect(map.pictures[1].name).toBe("Yui");
  });

  it("puts the last frame right after the first frame", () => {
    const map = buildH3PictureMap({
      firstFrame: { name: "A", src: null },
      lastFrame: { name: "B", src: null },
      references: [],
    });
    expect(map.pictures[2].name).toBe("B");
  });
});

describe("splitH3PromptTags", () => {
  it("splits text around Picture and Subject tags", () => {
    const parts = splitH3PromptTags("<Subject 1> is Yui, shown in <Picture 2>.");
    expect(parts.map((p) => p.type)).toEqual(["subject", "text", "picture", "text"]);
  });
});

describe("H3PromptPreview", () => {
  it("renders every tag as a chip and flags tags that point at no image", () => {
    const map = buildH3PictureMap({
      firstFrame: null,
      lastFrame: null,
      references: [{ kind: "character", name: "Yui", src: null }],
    });
    render(<H3PromptPreview prompt="<Picture 1> and <Picture 7>" map={map} />);
    const chips = screen.getAllByTestId("h3-tag-chip");
    expect(chips).toHaveLength(2);
    expect(chips[1].className).toContain("destructive");
  });
});

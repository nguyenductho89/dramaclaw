// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import type { MainlineContext } from "@/features/freezone/context/mainlineContext";
import {
  buildContextPromptPalette,
  buildContextPromptPaletteForNode,
  contextPromptPaletteInsertionText,
} from "@/features/canvas/nodes/contextPromptPalette";

function beatContext(overrides: Partial<MainlineContext> = {}): MainlineContext {
  return {
    kind: "beat",
    projectId: "project-1",
    episode: 1,
    beat: 2,
    label: "EP1 / Beat 2",
    sketchColors: {
      "identity:diner_young_man_young_adult": "#FF00FF",
      "identity:diner_young_woman_young_adult": "#00E5FF",
    },
    propMarkerColors: {
      "prop:carton": "#B71C1C",
    },
    ...overrides,
  };
}

describe("context prompt palette", () => {
  it("always returns the default palettes and decorates matching beat context colors", () => {
    const palette = buildContextPromptPalette([beatContext()]);

    expect(palette.actorEntries).toHaveLength(12);
    expect(palette.propEntries).toHaveLength(10);
    expect(palette.actorEntries[0]).toEqual({
      kind: "actor",
      id: "identity:diner_young_man_young_adult",
      label: "diner_young_man_young_adult",
      named: true,
      color: "#FF00FF",
    });
    expect(palette.actorEntries[1]).toEqual({
      kind: "actor",
      id: "actor:#00FFFF",
      label: "",
      named: false,
      color: "#00FFFF",
    });
    expect(palette.propEntries[0]).toEqual({
      kind: "prop",
      id: "prop:carton",
      label: "carton",
      named: true,
      color: "#B71C1C",
    });
  });

  it("uses anonymous color-only palettes without beat context colors", () => {
    const palette = buildContextPromptPalette([
      {
        kind: "scene",
        projectId: "project-1",
        sceneId: "noodle_shop",
      },
    ]);

    expect(palette.hasEntries).toBe(true);
    expect(palette.actorEntries[0]).toEqual({
      kind: "actor",
      id: "actor:#FF00FF",
      label: "",
      named: false,
      color: "#FF00FF",
    });
    expect(palette.propEntries[0]).toEqual({
      kind: "prop",
      id: "prop:#B71C1C",
      label: "",
      named: false,
      color: "#B71C1C",
    });
  });

  it("falls back to the only canvas beat context with colors", () => {
    const palette = buildContextPromptPaletteForNode(
      [
        {
          id: "beat-context-1",
          type: "beatContextNode",
          data: { mainline_context: [beatContext()] },
        },
        {
          id: "image-gen-1",
          type: "imageGenNode",
          data: { mainline_context: [] },
        },
      ],
      [],
      "image-gen-1",
    );

    expect(palette.hasEntries).toBe(true);
    expect(palette.actorEntries[0].label).toBe("diner_young_man_young_adult");
    expect(palette.propEntries[0].label).toBe("carton");
  });

  it("falls back to a standalone BeatContextNode beat_context palette", () => {
    const palette = buildContextPromptPaletteForNode(
      [
        {
          id: "standalone-beat-context",
          type: "beatContextNode",
          data: {
            context_scope: "standalone",
            beat_context: {
              schema: "beat_context.v1",
              source: "standalone",
              sketch_colors: {
                "heroine_raincoat": "#FF00FF",
              },
              prop_marker_colors: {
                "red_umbrella": "#B71C1C",
              },
            },
          },
        },
        {
          id: "image-gen-1",
          type: "imageGenNode",
          data: { mainline_context: [] },
        },
      ],
      [],
      "image-gen-1",
    );

    expect(palette.actorEntries[0].label).toBe("heroine_raincoat");
    expect(palette.propEntries[0].label).toBe("red_umbrella");
  });

  it("still exposes the default palettes when multiple canvas beat palettes exist", () => {
    const palette = buildContextPromptPaletteForNode(
      [
        {
          id: "beat-context-1",
          type: "beatContextNode",
          data: { mainline_context: [beatContext({ beat: 1 })] },
        },
        {
          id: "beat-context-2",
          type: "beatContextNode",
          data: { mainline_context: [beatContext({ beat: 2 })] },
        },
        {
          id: "image-gen-1",
          type: "imageGenNode",
          data: { mainline_context: [] },
        },
      ],
      [],
      "image-gen-1",
    );

    expect(palette.hasEntries).toBe(true);
    expect(palette.actorEntries).toHaveLength(12);
    expect(palette.propEntries).toHaveLength(10);
    expect(palette.actorEntries[0].named).toBe(false);
    expect(palette.actorEntries[0].label).toBe("");
    expect(palette.propEntries[0].named).toBe(false);
    expect(palette.propEntries[0].label).toBe("");
  });

  it("builds insertion text that preserves name and exact color", () => {
    expect(
      contextPromptPaletteInsertionText({
        kind: "actor",
        id: "identity:diner_young_man_young_adult",
        label: "diner_young_man_young_adult",
        named: true,
        color: "#FF00FF",
      }),
    ).toBe('#FF00FF-marked character "diner_young_man_young_adult"');

    expect(
      contextPromptPaletteInsertionText({
        kind: "prop",
        id: "prop:carton",
        label: "carton",
        named: true,
        color: "#B71C1C",
      }),
    ).toBe('#B71C1C-marked prop "carton"');
  });

  it("builds insertion text without names for anonymous palette colors", () => {
    expect(
      contextPromptPaletteInsertionText({
        kind: "actor",
        id: "actor:#FF00FF",
        label: "",
        named: false,
        color: "#FF00FF",
      }),
    ).toBe("#FF00FF-marked character");

    expect(
      contextPromptPaletteInsertionText({
        kind: "prop",
        id: "prop:#B71C1C",
        label: "",
        named: false,
        color: "#B71C1C",
      }),
    ).toBe("#B71C1C-marked prop");
  });
});

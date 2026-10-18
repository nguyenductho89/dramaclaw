// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { CANVAS_NODE_TYPES, type CanvasNodeType } from "@/features/canvas/domain/canvasNodes";
import {
  canvasNodeDefinitions,
  getAllowedDownstreamTargetTypes,
  getDownstreamSpawnTypes,
  getMenuNodeDefinitions,
  getUpstreamSpawnTypes,
  isManualConnectionAllowed,
  isUpstreamConnectionAllowed,
  DOWNSTREAM_SPAWN_WHITELIST,
  UPSTREAM_SPAWN_WHITELIST,
} from "@/features/canvas/domain/nodeRegistry";

describe("canvas node registry", () => {
  it("keeps ordinary audio nodes on the stable reference-voice default", () => {
    const definition = canvasNodeDefinitions[CANVAS_NODE_TYPES.audio];
    const data = definition.createDefaultData() as Record<string, unknown>;

    expect(data).not.toHaveProperty("speechMode");
    expect(data).not.toHaveProperty("presetModel");
    expect(data).not.toHaveProperty("presetVoice");
  });

  it("creates standalone shot context nodes from the menu with local schema data", () => {
    const definition = canvasNodeDefinitions[CANVAS_NODE_TYPES.beatContext];
    const data = definition.createDefaultData() as Record<string, unknown>;

    expect(getMenuNodeDefinitions().map((item) => item.type)).toContain(
      CANVAS_NODE_TYPES.beatContext,
    );
    expect(definition.menuLabelKey).toBe("node.menu.beatContext");
    expect(data).toMatchObject({
      context_scope: "standalone",
      beat_context: {
        schema: "beat_context.v1",
        source: "standalone",
        title: "Custom shot context",
        visual_description: "",
        narration_segment: "",
        scene_id: "",
        detected_identities: [],
        detected_props: [],
        sketch_colors: {},
        prop_marker_colors: {},
      },
      snapshot: {
        visualDescription: "",
        narrationSegment: "",
        sceneId: "",
        detectedIdentities: [],
        detectedProps: [],
        sketchColors: {},
        propMarkerColors: {},
      },
      syncStatus: "fresh",
    });
    expect(data).not.toHaveProperty("mainline_context");
  });
});

const IMAGE_NODE_TYPES = [
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.upload,
  CANVAS_NODE_TYPES.exportImage,
] as const;

describe("edge creation whitelist", () => {
  it("an audio node cannot connect to an image node", () => {
    for (const imageType of IMAGE_NODE_TYPES) {
      expect(isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.audio, imageType)).toBe(false);
    }
  });

  it("the downstream of an audio node is only video and video compose", () => {
    // Only these two node kinds read upstream audio (a video's audio-track material / a composition's audio track), and connecting elsewhere
    // has no effect at all, just a misleading line on the canvas.
    const allTypes = Object.keys(canvasNodeDefinitions) as CanvasNodeType[];
    const reachable = allTypes.filter((type) =>
      isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.audio, type),
    );

    expect([...reachable].sort()).toEqual(
      [CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.videoCompose].sort(),
    );
  });

  it("the video -> audio provenance edge left by \"vocal/background separation\" is legal", () => {
    // The audio/video separation action of NodeActionToolbar produces both a "background audio" audio node
    // and a "silent" video node from one video node, and both edges are drawn back to the source video. The audio edge used to be silently dropped by the edge gate.
    expect(isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.audio)).toBe(
      true,
    );
    expect(isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.video)).toBe(
      true,
    );
    // Opening up video does not open up all types: images still cannot connect into an audio node.
    expect(isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.imageGen, CANVAS_NODE_TYPES.audio)).toBe(
      false,
    );
  });

  it("a style node can only connect to image nodes and does not allow manual line dragging", () => {
    const allTypes = Object.keys(canvasNodeDefinitions) as CanvasNodeType[];
    const reachable = allTypes.filter((type) =>
      isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.style, type),
    );
    expect(reachable).toEqual([CANVAS_NODE_TYPES.imageGen]);

    // That edge is built by the image node's reconciliation logic following styleTemplateId (the edge gate must let it through), but
    // manual line dragging must not be offered -- a style node attached to a second image node would be rewritten back and forth by both sides' reconciliation
    // into the other's style, never converging.
    expect(
      isManualConnectionAllowed(CANVAS_NODE_TYPES.style, CANVAS_NODE_TYPES.imageGen),
    ).toBe(false);
  });

  it("a style node is not in the create menu or the connect menu", () => {
    // An empty style node dragged out by hand has no owning image node, and nobody consumes it.
    expect(getMenuNodeDefinitions().map((item) => item.type)).not.toContain(
      CANVAS_NODE_TYPES.style,
    );
    expect(getUpstreamSpawnTypes(CANVAS_NODE_TYPES.imageGen)).not.toContain(
      CANVAS_NODE_TYPES.style,
    );
  });

  it("the new downstream whitelist does not hurt existing connections", () => {
    // Text -> audio (the only legal upstream of an audio node) is still allowed.
    expect(
      isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.textAnnotation, CANVAS_NODE_TYPES.audio),
    ).toBe(true);
    // Source types without a downstream whitelist are unaffected by the new table.
    expect(getAllowedDownstreamTargetTypes(CANVAS_NODE_TYPES.imageGen)).toBeNull();
    expect(
      isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.imageGen, CANVAS_NODE_TYPES.video),
    ).toBe(true);
    expect(
      isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.videoCompose),
    ).toBe(true);
  });

  it("the menu's product whitelist does not conflict with the edge creation rules", () => {
    // The assertion lands on the **declared** whitelist, not on the return value of getXxxSpawnTypes -- those two functions
    // already filter by the edge rules at their exit, so asserting their output with the same predicate is always true and guards
    // nothing against drift. What is checked here is the cells "written in the product intent but never allowed by the edge rules": at runtime
    // they are silently filtered out, the menu and the whitelist no longer match, and nobody notices.
    const conflicts: string[] = [];
    for (const [source, targets] of Object.entries(DOWNSTREAM_SPAWN_WHITELIST)) {
      for (const target of targets ?? []) {
        if (!isUpstreamConnectionAllowed(source as CanvasNodeType, target)) {
          conflicts.push(`downstream whitelist ${source} -> ${target}`);
        }
      }
    }
    for (const [target, sources] of Object.entries(UPSTREAM_SPAWN_WHITELIST)) {
      for (const source of sources ?? []) {
        if (!isUpstreamConnectionAllowed(source, target as CanvasNodeType)) {
          conflicts.push(`upstream whitelist ${source} -> ${target}`);
        }
      }
    }

    expect(conflicts).toEqual([]);
  });
});

describe("connect menu candidates", () => {
  it("the upstream menu of an audio node has no video", () => {
    // The video -> audio edge is a provenance edge built by the "vocal/background separation" routine, and the edge gate must let it through
    // (otherwise existing edges would be dropped by load normalization), but a user manually wiring a video in would do nothing
    // -- AudioOperationsPanel reads only text upstream. Neither the menu nor manual dragging should offer it.
    expect(getUpstreamSpawnTypes(CANVAS_NODE_TYPES.audio)).toEqual([
      CANVAS_NODE_TYPES.textAnnotation,
    ]);
    expect(isManualConnectionAllowed(CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.audio)).toBe(
      false,
    );
    // But the edge rules themselves still allow it -- which is exactly why the two must be kept separate.
    expect(isUpstreamConnectionAllowed(CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.audio)).toBe(
      true,
    );
  });

  it("menu candidates of the other nodes are unaffected", () => {
    expect(getUpstreamSpawnTypes(CANVAS_NODE_TYPES.video)).toEqual([
      CANVAS_NODE_TYPES.textAnnotation,
      CANVAS_NODE_TYPES.imageGen,
      CANVAS_NODE_TYPES.audio,
    ]);
    expect(getUpstreamSpawnTypes(CANVAS_NODE_TYPES.imageGen)).toEqual([
      CANVAS_NODE_TYPES.textAnnotation,
      CANVAS_NODE_TYPES.script,
      CANVAS_NODE_TYPES.upload,
    ]);
    expect(getDownstreamSpawnTypes(CANVAS_NODE_TYPES.audio)).toEqual([
      CANVAS_NODE_TYPES.video,
      CANVAS_NODE_TYPES.videoCompose,
    ]);
    // The downstream of image-type nodes does not include audio.
    expect(getDownstreamSpawnTypes(CANVAS_NODE_TYPES.imageGen)).not.toContain(
      CANVAS_NODE_TYPES.audio,
    );
  });
});

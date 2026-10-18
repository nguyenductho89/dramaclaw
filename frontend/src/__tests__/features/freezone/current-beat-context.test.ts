// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { getCurrentBeatContextFromNode } from "@/features/freezone/context/currentBeatContext";

describe("getCurrentBeatContextFromNode", () => {
  it("uses standalone beat_context as the current canvas-owned context", () => {
    const context = {
      schema: "beat_context.v1",
      source: "standalone",
      title: "Custom shot context",
      visual_description: "{{Heroine_raincoat}} holds [[Red umbrella]] outside the convenience store on a rainy night",
      detected_identities: ["Heroine_raincoat"],
      detected_props: ["Red umbrella"],
      sketch_colors: { "Heroine_raincoat": "#FF00FF" },
      prop_marker_colors: { "Red umbrella": "#B71C1C" },
    };

    expect(
      getCurrentBeatContextFromNode({
        id: "context",
        type: "beatContextNode",
        data: {
          context_scope: "standalone",
          beat_context: context,
          snapshot: {
            detectedIdentities: ["Old identity"],
          },
        },
      }),
    ).toEqual(context);
  });

  it("keeps standalone detected identities and props as selected state filtered by visual markers", () => {
    expect(
      getCurrentBeatContextFromNode({
        id: "context",
        type: "beatContextNode",
        data: {
          context_scope: "standalone",
          beat_context: {
            schema: "beat_context.v1",
            source: "standalone",
            visual_description: "{{Heroine}} picks up [[Umbrella]]",
            detected_identities: ["Heroine", "Old identity"],
            detected_props: ["Umbrella", "Old prop"],
          },
        },
      }),
    ).toMatchObject({
      visual_description: "{{Heroine}} picks up [[Umbrella]]",
      detected_identities: ["Heroine"],
      detected_props: ["Umbrella"],
    });
  });

  it("keeps standalone no-character and no-prop markers that never appear in visual markers", () => {
    expect(
      getCurrentBeatContextFromNode({
        id: "context",
        type: "beatContextNode",
        data: {
          context_scope: "standalone",
          beat_context: {
            schema: "beat_context.v1",
            source: "standalone",
            visual_description: "Outside the convenience store on a rainy night, nobody around",
            detected_identities: ["__NO_CHARACTER__"],
            detected_props: ["__NO_PROP__"],
          },
        },
      }),
    ).toMatchObject({
      detected_identities: ["__NO_CHARACTER__"],
      detected_props: ["__NO_PROP__"],
    });
  });

  it("uses snapshot plus local edit fields for mainline BeatContextNode and ignores leaked standalone data", () => {
    expect(
      getCurrentBeatContextFromNode({
        id: "context",
        type: "beatContextNode",
        data: {
          projectId: "demo",
          episode: 1,
          beat: 4,
          beat_context: {
            schema: "beat_context.v1",
            source: "standalone",
            detected_identities: ["Wrong standalone identity"],
            detected_props: ["Wrong standalone prop"],
          },
          snapshot: {
            visualDescription: "Mainline synced frame",
            narrationSegment: "Mainline narration",
            sceneId: "Noodle shop",
            detectedIdentities: ["Mainline man"],
            detectedProps: ["Cardboard box"],
            sketchColors: { "Mainline man": "#FF00FF" },
          },
          beat_edit_fields: {
            visual_description: "Canvas local frame",
            detected_identities: ["Local woman"],
            detected_props: ["Antenna TV"],
            prop_marker_colors: { "Antenna TV": "#B71C1C" },
          },
          mainline_context: [
            {
              kind: "beat",
              projectId: "demo",
              episode: 1,
              beat: 4,
            },
          ],
        },
      }),
    ).toEqual({
      episode: 1,
      beat: 4,
      scene_id: "Noodle shop",
      visual_description: "Canvas local frame",
      narration_segment: "Mainline narration",
      detected_identities: ["Local woman", "Mainline man"],
      detected_props: ["Antenna TV", "Cardboard box"],
      sketch_colors: { "Mainline man": "#FF00FF" },
      prop_marker_colors: { "Antenna TV": "#B71C1C" },
    });
  });
});

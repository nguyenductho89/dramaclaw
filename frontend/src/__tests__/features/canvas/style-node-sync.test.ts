// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  advanceStyleNodeSync,
  isStyleSyncReady,
  resolveStyleNodePlacement,
  resolveStyleNodeSyncAction,
  STYLE_NODE_GAP,
  INITIAL_STYLE_NODE_SYNC_STATE,
  type StyleNodeSnapshot,
  type StyleNodeSyncAction,
  type StyleNodeSyncState,
} from "@/features/canvas/application/styleNodeSync";

/**
 * Most cases cover the normal state where a style node serves exactly one image node; sharing is the abnormal state,
 * which gets its own group of cases. Hence the default sharedWithOtherTargets: false.
 */
function styleNode(
  id: string,
  templateId: string | null,
  shared = false,
): StyleNodeSnapshot {
  return { id, templateId, sharedWithOtherTargets: shared };
}

describe("resolveStyleNodeSyncAction", () => {
  describe("first sync (lastSyncedTemplateId is undefined)", () => {
    it("creates one when a style is selected but the canvas has no style node", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: null,
          lastSyncedTemplateId: undefined,
          everObservedStyleNode: false,
        }),
      ).toEqual({ kind: "create", templateId: "golden_age" });
    });

    it("does nothing when an existing canvas already carries a matching style node", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: styleNode("n1", "golden_age"),
          lastSyncedTemplateId: undefined,
          everObservedStyleNode: false,
        }),
      ).toEqual({ kind: "none" });
    });

    it("creates no node when no style is selected", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: null,
          styleNode: null,
          lastSyncedTemplateId: undefined,
          everObservedStyleNode: false,
        }),
      ).toEqual({ kind: "none" });
    });
  });

  describe("selection changes", () => {
    it("creates a node going from none to some", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: null,
          lastSyncedTemplateId: null,
          everObservedStyleNode: false,
        }),
      ).toEqual({ kind: "create", templateId: "golden_age" });
    });

    it("rewrites the existing node when the style changes instead of creating another", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "cyberpunk",
          styleNode: styleNode("n1", "golden_age"),
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "update", nodeId: "n1", templateId: "cyberpunk" });
    });

    it("deletes the upstream node when the style is cleared", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: null,
          styleNode: styleNode("n1", "golden_age"),
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "remove", nodeId: "n1" });
    });

    it("does not delete twice when the style is cleared but the node is already gone", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: null,
          styleNode: null,
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "none" });
    });
  });

  describe("selection unchanged", () => {
    it("must not be misjudged as \"the user deleted it\" right after creating the node, before the store flows back", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: null,
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: false,
        }),
      ).toEqual({ kind: "none" });
    });

    it("clears the image node's style in reverse after the user manually deletes the style node", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: null,
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "clear-selection" });
    });

    it("is steady when the node is still there and consistent", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: styleNode("n1", "golden_age"),
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "none" });
    });

    it("pulls the node back when its data disagrees with the selection", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: styleNode("n1", null),
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "update", nodeId: "n1", templateId: "golden_age" });
    });
  });

  /**
   * A style node wired to two image nodes is an abnormal state (edges get cloned along when a node is duplicated),
   * where both sides fight to rewrite it to their own style -- one writes in a frame and the other writes back in the next,
   * and React throws Maximum update depth exceeded. The write side no longer produces such edges,
   * so this is the safety net: when encountered, do nothing and leave the canvas in a usable state.
   */
  describe("style node shared by multiple image nodes", () => {
    it("does not fight over rewriting the shared node's style", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "cyberpunk",
          styleNode: styleNode("n1", "golden_age", true),
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "none" });
    });

    it("does not delete the shared node when clearing its own selection", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: null,
          styleNode: styleNode("n1", "golden_age", true),
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "none" });
    });

    it("stays steady as before when the shared node matches its own selection", () => {
      expect(
        resolveStyleNodeSyncAction({
          selectedTemplateId: "golden_age",
          styleNode: styleNode("n1", "golden_age", true),
          lastSyncedTemplateId: "golden_age",
          everObservedStyleNode: true,
        }),
      ).toEqual({ kind: "none" });
    });

    it("two image nodes running in turn never write each other back", () => {
      // A wants cyberpunk, B wants golden_age, and the shared node is currently golden_age.
      // Without the safety net this would be update -> update -> update ... never stopping.
      const shared = styleNode("shared", "golden_age", true);
      const a = advanceStyleNodeSync(
        { lastSyncedTemplateId: "golden_age", everObservedStyleNode: true },
        { selectedTemplateId: "cyberpunk", styleNode: shared },
      );
      const b = advanceStyleNodeSync(
        { lastSyncedTemplateId: "golden_age", everObservedStyleNode: true },
        { selectedTemplateId: "golden_age", styleNode: shared },
      );

      expect(a.action).toEqual({ kind: "none" });
      expect(b.action).toEqual({ kind: "none" });
    });
  });
});

/**
 * Feeds a series of "frames" to the state machine and collects each frame's action -- each rerun of the effect in the component is one frame,
 * while the bookkeeping state stays in a ref across frames. Timing pitfalls only show up when running consecutively.
 */
function runFrames(
  frames: ReadonlyArray<{
    selectedTemplateId: string | null;
    styleNode: StyleNodeSnapshot | null;
  }>,
): { actions: StyleNodeSyncAction[]; state: StyleNodeSyncState } {
  let state = INITIAL_STYLE_NODE_SYNC_STATE;
  const actions: StyleNodeSyncAction[] = [];
  for (const frame of frames) {
    const result = advanceStyleNodeSync(state, frame);
    state = result.state;
    actions.push(result.action);
  }
  return { actions, state };
}

describe("advanceStyleNodeSync", () => {
  it("the frames after creating the node and before the store flows back do not clear the just-selected style", () => {
    const { actions } = runFrames([
      // The user picked a style in the image wall.
      { selectedTemplateId: "golden_age", styleNode: null },
      // addNode has been dispatched, but upstream cannot see it in this frame yet.
      { selectedTemplateId: "golden_age", styleNode: null },
      { selectedTemplateId: "golden_age", styleNode: null },
      // Flowed back.
      {
        selectedTemplateId: "golden_age",
        styleNode: styleNode("n1", "golden_age"),
      },
    ]);

    expect(actions).toEqual([
      { kind: "create", templateId: "golden_age" },
      { kind: "none" },
      { kind: "none" },
      { kind: "none" },
    ]);
  });

  it("only clears the selection in reverse when the user really deleted the node, and only once", () => {
    const { actions } = runFrames([
      { selectedTemplateId: "golden_age", styleNode: null },
      {
        selectedTemplateId: "golden_age",
        styleNode: styleNode("n1", "golden_age"),
      },
      // The user deleted the style node on the canvas.
      { selectedTemplateId: "golden_age", styleNode: null },
      // The frame after clearing: the selection is already null.
      { selectedTemplateId: null, styleNode: null },
      { selectedTemplateId: null, styleNode: null },
    ]);

    expect(actions).toEqual([
      { kind: "create", templateId: "golden_age" },
      { kind: "none" },
      { kind: "clear-selection" },
      { kind: "none" },
      { kind: "none" },
    ]);
  });

  it("clearing the style deletes the node only once, and flow-back delay does not delete again", () => {
    const { actions } = runFrames([
      { selectedTemplateId: "golden_age", styleNode: null },
      {
        selectedTemplateId: "golden_age",
        styleNode: styleNode("n1", "golden_age"),
      },
      // The user clicked "Clear style".
      {
        selectedTemplateId: null,
        styleNode: styleNode("n1", "golden_age"),
      },
      // deleteNode has been dispatched, and upstream still carries it in this frame.
      {
        selectedTemplateId: null,
        styleNode: styleNode("n1", "golden_age"),
      },
      { selectedTemplateId: null, styleNode: null },
    ]);

    expect(actions).toEqual([
      { kind: "create", templateId: "golden_age" },
      { kind: "none" },
      { kind: "remove", nodeId: "n1" },
      { kind: "none" },
      { kind: "none" },
    ]);
  });

  it("re-selecting a style after deleting the node recreates it and is not misjudged as a user deletion", () => {
    const { actions } = runFrames([
      { selectedTemplateId: "golden_age", styleNode: null },
      {
        selectedTemplateId: "golden_age",
        styleNode: styleNode("n1", "golden_age"),
      },
      { selectedTemplateId: null, styleNode: styleNode("n1", "golden_age") },
      { selectedTemplateId: null, styleNode: null },
      // Select another one.
      { selectedTemplateId: "cyberpunk", styleNode: null },
      { selectedTemplateId: "cyberpunk", styleNode: null },
    ]);

    expect(actions.slice(4)).toEqual([
      { kind: "create", templateId: "cyberpunk" },
      { kind: "none" },
    ]);
  });

  it("changing the style reuses the same node", () => {
    const { actions } = runFrames([
      {
        selectedTemplateId: "golden_age",
        styleNode: styleNode("n1", "golden_age"),
      },
      {
        selectedTemplateId: "cyberpunk",
        styleNode: styleNode("n1", "golden_age"),
      },
      {
        selectedTemplateId: "cyberpunk",
        styleNode: styleNode("n1", "cyberpunk"),
      },
    ]);

    expect(actions).toEqual([
      { kind: "none" },
      { kind: "update", nodeId: "n1", templateId: "cyberpunk" },
      { kind: "none" },
    ]);
  });

  it("existing canvas: creates the node in the first frame when there is a styleTemplateId but no style node", () => {
    const { actions } = runFrames([
      { selectedTemplateId: "golden_age", styleNode: null },
    ]);

    expect(actions).toEqual([{ kind: "create", templateId: "golden_age" }]);
  });

  it("an empty node with no style selected never conjures a style node", () => {
    const { actions } = runFrames([
      { selectedTemplateId: null, styleNode: null },
      { selectedTemplateId: null, styleNode: null },
    ]);

    expect(actions).toEqual([{ kind: "none" }, { kind: "none" }]);
  });
});

describe("resolveStyleNodePlacement", () => {
  it("places it directly left of the image node with a gap", () => {
    expect(
      resolveStyleNodePlacement({
        imageNodePosition: { x: 1000, y: 200 },
        imageNodeHeight: 360,
        styleNodeWidth: 220,
        styleNodeHeight: 124,
      }),
    ).toEqual({ x: 1000 - 220 - STYLE_NODE_GAP, y: 200 + (360 - 124) / 2 });
  });

  it("centers even when the image node is shorter than the style node, without sticking to the top", () => {
    // A collapsed image node may be shorter than the style card, in which case y should shift up instead of being clamped to 0.
    expect(
      resolveStyleNodePlacement({
        imageNodePosition: { x: 0, y: 0 },
        imageNodeHeight: 64,
        styleNodeWidth: 220,
        styleNodeHeight: 124,
      }),
    ).toEqual({ x: -220 - STYLE_NODE_GAP, y: -30 });
  });

  it("loses no precision on a negative-coordinate canvas", () => {
    expect(
      resolveStyleNodePlacement({
        imageNodePosition: { x: -840.5, y: -120 },
        imageNodeHeight: 361,
        styleNodeWidth: 220,
        styleNodeHeight: 124,
      }),
    ).toEqual({ x: -840.5 - 220 - STYLE_NODE_GAP, y: -120 + 118.5 });
  });
});

/**
 * The admission criterion for reconciliation. Canvases saved before launch contain only old style ids (this version swapped the 30 old sets for 45
 * new ones, with zero overlap); if this gate were removed, opening any old canvas would conjure a pile of empty-shell
 * style nodes, and also mark the canvas dirty, auto-save it and push it onto the undo stack.
 */
describe("isStyleSyncReady", () => {
  const templates = [{ id: "golden_age" }, { id: "cyberpunk" }];

  it("does nothing until the list arrives -- not even for \"no style selected\"", () => {
    expect(isStyleSyncReady(null, [])).toBe(false);
    expect(isStyleSyncReady("golden_age", [])).toBe(false);
  });

  it("list arrived, no style selected: reconciliation is allowed (empty-shell nodes that should go must be deleted)", () => {
    expect(isStyleSyncReady(null, templates)).toBe(true);
  });

  it("only acts when the selected id is in the list", () => {
    expect(isStyleSyncReady("golden_age", templates)).toBe(true);
  });

  it("an old id in an existing canvas is not found -- no create, no delete, no write", () => {
    expect(isStyleSyncReady("three_oclock_2300", templates)).toBe(false);
  });
});

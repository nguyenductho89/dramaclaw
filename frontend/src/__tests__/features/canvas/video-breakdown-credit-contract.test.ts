// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Breakdown is billable (same family as video-story analysis, sharing the freezone.video_analyze pricing rule).
// The charge point is the node's own "start breakdown" button, not the toolbar entry that merely spawns the node -
// the toolbar only does addNode, and clicking it deducts nothing. The price tag must be nailed to the button that
// actually spends money, or it misleads the user.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nodeSource = readFileSync(
  "src/features/canvas/nodes/VideoBreakdownNode.tsx",
  "utf8",
);
const toolbarSource = readFileSync(
  "src/features/canvas/ui/NodeActionToolbar.tsx",
  "utf8",
);

/**
 * Turn a snippet copied with its real indentation into a regex that ignores indentation/line breaks and only cares
 * about token order. These assertions store a "roughly looks like this" code skeleton as-is; following the source's
 * indentation verbatim would be brittle - a stray reformat nearby (e.g. prettier changing indent depth) would make it
 * fail as a false positive, forcing a test edit instead of signaling an actual regression.
 */
function flexible(snippet: string): RegExp {
  const tokens = snippet.split(/\s+/).filter(Boolean);
  return new RegExp(tokens.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"));
}

describe("canvas video breakdown credit contract", () => {
  it("quotes the shared video_analyze feature under its own ledger operation", () => {
    // Aligned with the EE side's FEATURE_BILLING_SPECS["freezone_video_breakdown"] and the CE route
    // _enqueue_or_start_freezone_video_analysis's billing_operation.
    expect(nodeSource).toContain('const breakdownCreditCost = useGenerationCreditCost(');
    expect(nodeSource).toMatch(
      flexible('"feature", "freezone.video_analyze",'),
    );
    expect(nodeSource).toContain(
      '{ surface: "canvas", params: { operation: "video_breakdown" } }',
    );
  });

  it("shows and blocks on an unconfigured rule", () => {
    expect(nodeSource).toContain(
      "breakdownCreditCost.error instanceof BillingRuleNotConfiguredError",
    );
    expect(nodeSource).toContain('t("common.billingRuleNotConfiguredShort")');
    // The button must be genuinely unclickable when the pricing rule is unconfigured, not just a pill that reads
    // "needs configuration" while the button still works.
    expect(nodeSource).toMatch(
      flexible("disabled={ !videoSource || isBreakingDown || breakdownBillingRuleMissing }"),
    );
    expect(nodeSource).toMatch(
      flexible("if (breakdownBillingRuleMissing) return; void handleStartBreakdown();"),
    );
  });

  it("puts the pill on the start button, with the same disabled predicate", () => {
    // The pill's grayed-out state and the button's disabled state must share the same predicate, otherwise you get
    // "button unclickable but the price tag still looks live".
    expect(nodeSource).toMatch(
      flexible(
        "<CreditCostPill display={breakdownCreditCostDisplay} promotion={breakdownCreditCost.data?.data.promotion} disabled={ !videoSource || isBreakingDown || breakdownBillingRuleMissing } />",
      ),
    );
  });

  it("keeps the toolbar entry price-free because it only spawns the node", () => {
    // The toolbar's "Frame-by-frame breakdown" = addNode + addEdge: it submits no task and deducts nothing. Putting a
    // price tag there would make users think a single click spends money (compare "Parse": that one submits directly,
    // so it carries a price tag).
    const entry = toolbarSource.slice(
      toolbarSource.indexOf('key="video-frame-analysis"'),
      toolbarSource.indexOf('key="video-subtitle-removal"'),
    );
    expect(entry).not.toBe("");
    expect(entry).not.toContain("CreditCostPill");
  });

  it("wires motion capture to the browser-side depth capture", () => {
    // Depth motion capture is computed in the browser: it submits no task and deducts nothing; the entry lives in the
    // same dropdown, and the previous test already guarantees this section has no price tag, so here we only pin that
    // it is wired to the real handler rather than a placeholder.
    const entry = toolbarSource.slice(
      toolbarSource.indexOf('key="video-frame-analysis"'),
      toolbarSource.indexOf('key="video-subtitle-removal"'),
    );
    expect(entry).toContain("onSelect={handleVideoMotionCapture}");
    expect(entry).not.toContain('handleVideoStub("motion-capture")');
  });

  it("wires frame crop to the in-node crop mode", () => {
    // Frame crop happens in the browser and deducts nothing; the entry only toggles the source node's isCropMode, and the box and floating bar are mounted by VideoNode.
    const entry = toolbarSource.slice(
      toolbarSource.indexOf('key="video-frame-analysis"'),
      toolbarSource.indexOf('key="video-subtitle-removal"'),
    );
    // The crop-entering implementation is lifted into the component-level handleOpenVideoCrop (the agent's
    // open_video_crop_tool goes through it too); the dropdown item only toggles entering/leaving.
    expect(entry).toContain("handleOpenVideoCrop();");
    expect(toolbarSource).toContain("isCropMode: true");
    expect(entry).not.toContain('handleVideoStub("frame-crop")');
  });

  it("guards crop-adjacent mode entries against an in-flight crop, with a toast", () => {
    // Until a crop finishes uploading, it must not be interrupted by other toolbar entries: when the result lands it
    // sets isCropMode back to false, and switching away midway would fight with that wrap-up, see videoCropInFlight.ts.
    // These five places used to call `if (isVideoCropInFlight(node.id)) return;` directly - a silent block, so the
    // user clicked and nothing happened and assumed it was stuck. Now they all go through guardVideoCropInFlight,
    // which shows a hint while blocking.
    // A regex rather than a hardcoded whole line: that line later gained named imports such as
    // requestVideoCropFocus; as long as isVideoCropInFlight still comes from this module it should count,
    // regardless of what else the same line carries.
    expect(toolbarSource).toMatch(
      /import\s*\{[^}]*\bisVideoCropInFlight\b[^}]*\}\s*from\s*"@\/features\/canvas\/application\/videoCrop\/videoCropInFlight";/,
    );
    expect(toolbarSource).toContain(
      't("node.videoNode.crop.busy")',
    );
    const guardDefinitionCount = (toolbarSource.match(/const guardVideoCropInFlight/g) ?? []).length;
    expect(guardDefinitionCount).toBe(1);
    // The five old bare calls are all retired; only the one inside guardVideoCropInFlight itself remains.
    const rawCallCount = (toolbarSource.match(/if \(isVideoCropInFlight\(node\.id\)\) return;/g) ?? []).length;
    expect(rawCallCount).toBe(0);
    const guardCallCount = (toolbarSource.match(/if \(guardVideoCropInFlight\(node\.id\)\) return;/g) ?? []).length;
    expect(guardCallCount).toBe(5);

    const frameAnalysisEntry = toolbarSource.slice(
      toolbarSource.indexOf('key="video-frame-analysis"'),
      toolbarSource.indexOf('key="video-subtitle-removal"'),
    );
    expect(frameAnalysisEntry).toContain("guardVideoCropInFlight(node.id)");
    expect(toolbarSource).toMatch(
      flexible(
        "if (guardVideoCropInFlight(node.id)) return; handleOpenVideoExtend();",
      ),
    );
    expect(toolbarSource).toMatch(
      flexible("updateNodeData(node.id, { isExtendPickMode: true, isCropMode: false });"),
    );
  });

  it("keeps smart extend as a standalone toolbar button", () => {
    const entry = toolbarSource.slice(
      toolbarSource.indexOf('key="video-extend"'),
      toolbarSource.indexOf('key="video-hd"'),
    );
    expect(entry).toContain("handleVideoExtendPick();");
    expect(entry).toContain("!hasVideo || !extendModel");
  });

  it("clears isCropMode from both subtitle-erase entries", () => {
    // When Smart subtitle erase / Box-select subtitle erase switch into the subtitle state, they must clear frame crop
    // along the way, otherwise the overlays of the two modes would stack.
    const subtitleEntry = toolbarSource.slice(
      toolbarSource.indexOf('key="video-subtitle-removal"'),
      toolbarSource.indexOf('key="video-separate-av"'),
    );
    const cropClearCount = subtitleEntry.match(/isCropMode: false/g)?.length ?? 0;
    expect(cropClearCount).toBe(2);
    expect(subtitleEntry).toContain("guardVideoCropInFlight(node.id)");
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Breakdown is billable (same family as video-story analysis, sharing the freezone.video_analyze pricing rule).
// The charge point is the node's own "start breakdown" button, not the toolbar entry that merely spawns the node -
// the price tag must be nailed to the button that actually spends money, or it misleads the user.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const nodeSource = readFileSync(
  "src/features/canvas/nodes/VideoBreakdownNode.tsx",
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

  // NOTE: upstream also asserts that the toolbar's dropdown entry for breakdown (shared with frame crop / smart
  // extend / depth capture / subtitle erase) stays price-free, since it only spawns the node rather than submitting
  // the paid task. This codebase does not have that dropdown (crop / extend / depth-capture are not ported here;
  // NodeActionToolbar.tsx only wires handleCreateVideoBreakdown through the agent's run_video_breakdown action, with
  // no JSX toolbar button of its own) - there is no toolbar price tag to assert the absence of, so that coverage is
  // intentionally not ported.
});

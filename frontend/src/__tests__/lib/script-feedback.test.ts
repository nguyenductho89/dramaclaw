// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  getScriptReviewFeedback,
  mergeTaskLogs,
} from "@/lib/script-feedback";

describe("script feedback helpers", () => {
  it("reports review failure from script_writer task result", () => {
    expect(
      getScriptReviewFeedback({
        review_passed: false,
        review_summary: "Line 3 is missing a visual description",
      }),
    ).toEqual({
      type: "warning",
      key: "episode.script.scriptReviewFailed",
      values: { summary: "Line 3 is missing a visual description" },
    });
  });

  it("reports review success when script_writer task passes review", () => {
    expect(
      getScriptReviewFeedback({
        review_passed: true,
        review_summary: "ok",
      }),
    ).toEqual({
      type: "success",
      key: "episode.script.scriptReviewPassed",
    });
  });

  it("deduplicates task logs while preserving order", () => {
    expect(mergeTaskLogs(["Start", "Generating line 1"], ["Generating line 1", "Done"])).toEqual([
      "Start",
      "Generating line 1",
      "Done",
    ]);
  });
});

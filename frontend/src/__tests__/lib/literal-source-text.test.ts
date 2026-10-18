// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { splitLiteralSourceText } from "@/lib/literal-source-text";

describe("splitLiteralSourceText", () => {
  it("normalizes newlines, trims rows, and drops empty rows", () => {
    expect(splitLiteralSourceText(" First line\r\n\r\nSecond line \r Third line\n   ")).toEqual([
      "First line",
      "Second line",
      "Third line",
    ]);
  });
});

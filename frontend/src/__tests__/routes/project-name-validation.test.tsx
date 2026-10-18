// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import {
  PROJECT_NAME_MAX_LENGTH,
  getProjectNameValidationKey,
} from "@/routes/_app/index";

describe("project name length validation", () => {
  it("accepts a 64-character name", () => {
    expect(PROJECT_NAME_MAX_LENGTH).toBe(64);
    expect(getProjectNameValidationKey("a".repeat(64))).toBeNull();
  });

  it("rejects a 65-character name", () => {
    expect(getProjectNameValidationKey("a".repeat(65))).toBe("project.nameTooLong");
  });
});

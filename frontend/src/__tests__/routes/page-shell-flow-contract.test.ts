// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { FLOW_ITEM, PAGE_SHELL_FLOW } from "@/lib/page-shell";

function read(path: string) {
  return readFileSync(resolve(process.cwd(), path), "utf8");
}

const FIXED_SHELL = "-m-6 flex h-[calc(100%+3rem)] flex-col overflow-hidden";

// Every project page that fills <main> with the fixed-height shell must let it grow with its
// content below `lg`; otherwise a stacked layout is clipped and cannot be scrolled by touch.
describe("page shell grows with its content on small screens", () => {
  it.each([
    "src/routes/_app/projects.$project/characters.lazy.tsx",
    "src/routes/_app/projects.$project/styles.tsx",
    "src/routes/_app/projects.$project/ingest.tsx",
    "src/routes/_app/projects.$project/tasks.tsx",
    "src/routes/_app/projects.$project/episodes.tsx",
  ])("%s adds PAGE_SHELL_FLOW to the fixed shell", (path) => {
    const source = read(path);

    expect(source).toContain(FIXED_SHELL);
    expect(source).toContain("PAGE_SHELL_FLOW");
    expect(source).not.toContain(`className="${FIXED_SHELL}"`);
  });

  it("only overrides height and overflow below lg", () => {
    for (const token of `${PAGE_SHELL_FLOW} ${FLOW_ITEM}`.split(" ")) {
      expect(token.startsWith("max-lg:")).toBe(true);
    }
  });
});

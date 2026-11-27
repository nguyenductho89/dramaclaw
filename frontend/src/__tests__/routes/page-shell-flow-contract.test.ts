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

// The episode layout renders <Outlet /> in a plain block, where `flex-1` has no effect. A tab
// without `h-full` grows to its content and the layout clips it on desktop.
describe("H3 Shots tab scrolls inside the episode layout", () => {
  const source = read("src/routes/_app/projects.$project/episodes.$episode/h3-shots.lazy.tsx");

  it("takes the layout height from lg up and its natural height below lg", () => {
    expect(source).toContain("flex h-full min-h-0 flex-col gap-4 p-4 max-lg:h-auto lg:flex-row");
  });

  it("collapses the episode header from a root that exists when the hook mounts", () => {
    const workbench = source.slice(source.indexOf("function H3ShotsWorkbench"), source.indexOf("export function H3ShotsTabContent"));

    expect(workbench).toContain("useHideHeaderOnScroll<HTMLDivElement>()");
    expect(workbench).toContain("ref={scrollHideRef}");
  });

  it("keeps the stacked beat list in a short scroll box", () => {
    expect(source).toContain("overflow-y-auto max-lg:max-h-[45dvh]");
  });
});

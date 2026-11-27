// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Project pages fill <main> with a fixed-height shell (`-m-6 h-[calc(100%+3rem)]
// overflow-hidden`) and scroll inside their panes. That only works while the panes sit
// side by side. Below `lg` a page stacks its panes, so the shell has to grow with its
// content and let <main> (overflow-y-auto) scroll; otherwise everything past the first
// screen is clipped and cannot be reached by touch.

/** Added to the page shell: natural height below `lg`, still at least as tall as <main>. */
export const PAGE_SHELL_FLOW =
  "max-lg:h-auto max-lg:min-h-[calc(100%+3rem)] max-lg:overflow-visible";

/** Added to a wrapper that normally takes the remaining height (`flex-1 min-h-0 overflow-hidden`). */
export const FLOW_ITEM = "max-lg:flex-none max-lg:overflow-visible";

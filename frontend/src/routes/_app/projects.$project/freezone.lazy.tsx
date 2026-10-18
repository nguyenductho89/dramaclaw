// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { createLazyFileRoute } from "@tanstack/react-router";

/**
 * This route itself no longer renders the canvas. The canvas is mounted by FreezoneCanvasHost outside the _app.tsx route animation
 * container, so that switching between "Freezone / Mainline" in the top bar does not unmount and rebuild the whole tree; only
 * the route itself is kept here, as the address marker for "currently on the freezone" - the host decides visibility and activation by pathname.
 */
function FreezoneProjectRoute() {
  return null;
}

export const Route = createLazyFileRoute("/_app/projects/$project/freezone")({
  component: FreezoneProjectRoute,
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  beginRouteSwitch,
  endRouteSwitch,
} from "@/lib/route-switch-transition";

/**
 * The whole value of this module lies in the order "the overlay hits the screen first, the navigation happens afterwards" - wait one frame less,
 * and the synchronous long task of the navigation swallows the overlay together with the new page into the same commit, and the user still sees
 * a hitch and then a sudden page change. So what is tested is the frame order, not the rendered result.
 */
describe("beginRouteSwitch", () => {
  let frames: Array<() => void>;

  beforeEach(() => {
    frames = [];
    vi.stubGlobal("requestAnimationFrame", (cb: () => void) => {
      frames.push(cb);
      return frames.length;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      frames[id - 1] = () => {};
    });
  });

  afterEach(() => {
    // phase is module-level. endRouteSwitch only takes navigating, so first push any state that may be stuck in armed
    // through two frames, so no residue leaks into the next case.
    flushFrame();
    flushFrame();
    endRouteSwitch();
    vi.unstubAllGlobals();
  });

  const flushFrame = () => {
    const pending = frames.splice(0, frames.length);
    pending.forEach((cb) => cb());
  };

  it("defers the navigation to the second frame", () => {
    const navigate = vi.fn();
    beginRouteSwitch(navigate);

    expect(navigate).not.toHaveBeenCalled();
    flushFrame();
    // The first-frame callback still runs before this frame is painted, the overlay is not on screen, so it must not navigate.
    expect(navigate).not.toHaveBeenCalled();
    flushFrame();
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("two quick clicks only navigate for the last one", () => {
    const first = vi.fn();
    const second = vi.fn();
    beginRouteSwitch(first);
    flushFrame();
    beginRouteSwitch(second);
    flushFrame();
    flushFrame();

    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("when the previous navigation lands, the just-clicked one that has not departed yet is not swallowed", () => {
    // Route landing calls endRouteSwitch. The user clicked a second menu in the two frames before the previous page landed,
    // and that click must still be sent out, otherwise they stay on the previous page with no feedback at all.
    const navigate = vi.fn();
    beginRouteSwitch(navigate);
    flushFrame();
    endRouteSwitch();
    flushFrame();

    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("without rAF, navigates directly and does not leave the UI stuck behind the overlay", () => {
    vi.stubGlobal("requestAnimationFrame", undefined);
    const navigate = vi.fn();
    beginRouteSwitch(navigate);
    expect(navigate).toHaveBeenCalledTimes(1);
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Module-level registry of in-flight frame crops: VideoNode unmount/remount and toolbar mode switches must both read
// the same source of truth, rather than each keeping its own state that the other cannot see.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  cancelVideoCrop,
  clearVideoCropInFlight,
  isVideoCropInFlight,
  markVideoCropInFlight,
  useVideoCropInFlight,
} from "@/features/canvas/application/videoCrop/videoCropInFlight";

describe("videoCropInFlight", () => {
  it("marks, reports and clears a node id", () => {
    const nodeId = "v-mark-clear";
    expect(isVideoCropInFlight(nodeId)).toBe(false);

    markVideoCropInFlight(nodeId);
    expect(isVideoCropInFlight(nodeId)).toBe(true);

    clearVideoCropInFlight(nodeId);
    expect(isVideoCropInFlight(nodeId)).toBe(false);
  });

  it("re-renders the hook when the node's in-flight state changes", () => {
    const nodeId = "v-hook-rerender";
    const { result } = renderHook(() => useVideoCropInFlight(nodeId));
    expect(result.current).toBe(false);

    act(() => {
      markVideoCropInFlight(nodeId);
    });
    expect(result.current).toBe(true);

    act(() => {
      clearVideoCropInFlight(nodeId);
    });
    expect(result.current).toBe(false);
  });

  it("keeps two node ids independent", () => {
    const nodeA = "v-a";
    const nodeB = "v-b";

    markVideoCropInFlight(nodeA);
    expect(isVideoCropInFlight(nodeA)).toBe(true);
    expect(isVideoCropInFlight(nodeB)).toBe(false);

    clearVideoCropInFlight(nodeA);
    expect(isVideoCropInFlight(nodeA)).toBe(false);
    expect(isVideoCropInFlight(nodeB)).toBe(false);
  });

  it("returns a not-yet-aborted signal when marking", () => {
    const nodeId = "v-signal";
    const signal = markVideoCropInFlight(nodeId);
    expect(signal?.aborted).toBe(false);
    clearVideoCropInFlight(nodeId);
  });

  it("cancelVideoCrop aborts the signal but leaves the in-flight state to submit's cleanup", () => {
    const nodeId = "v-cancel";
    const signal = markVideoCropInFlight(nodeId);

    cancelVideoCrop(nodeId);

    expect(signal?.aborted).toBe(true);
    // Cancel only sends a signal; the registry is actually cleared by the submit flow's finally. Otherwise, before reaching finally,
    // clicking submit again would not reveal that a crop is already running.
    expect(isVideoCropInFlight(nodeId)).toBe(true);

    clearVideoCropInFlight(nodeId);
    expect(isVideoCropInFlight(nodeId)).toBe(false);
  });

  it("returns null instead of the existing signal when marking a node twice", () => {
    // Double registration used to hand back the existing signal, so the caller mistakenly thought it had control of this submission
    // and raced the first registrant for the same finally clearing the registry; see the file header comment.
    const nodeId = "v-double-mark";
    const first = markVideoCropInFlight(nodeId);
    expect(first).not.toBeNull();

    const second = markVideoCropInFlight(nodeId);
    expect(second).toBeNull();
    // A second, failed registration must not displace the first registration.
    expect(isVideoCropInFlight(nodeId)).toBe(true);
    expect(first?.aborted).toBe(false);

    clearVideoCropInFlight(nodeId);
  });

  it("is a no-op to cancel after the node has already been cleared", () => {
    const nodeId = "v-cancel-after-clear";
    markVideoCropInFlight(nodeId);
    clearVideoCropInFlight(nodeId);

    expect(() => cancelVideoCrop(nodeId)).not.toThrow();
    expect(isVideoCropInFlight(nodeId)).toBe(false);
  });

  it("is a no-op to cancel a node id that was never marked", () => {
    expect(() => cancelVideoCrop("v-never-marked")).not.toThrow();
    expect(isVideoCropInFlight("v-never-marked")).toBe(false);
  });

  it("keeps abort signals independent per node id", () => {
    const nodeA = "v-signal-a";
    const nodeB = "v-signal-b";
    const signalA = markVideoCropInFlight(nodeA);
    const signalB = markVideoCropInFlight(nodeB);

    cancelVideoCrop(nodeA);

    expect(signalA?.aborted).toBe(true);
    expect(signalB?.aborted).toBe(false);

    clearVideoCropInFlight(nodeA);
    clearVideoCropInFlight(nodeB);
  });
});

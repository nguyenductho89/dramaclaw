// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// When the imageNaturalWidth/Height record cannot be trusted. It underpins two things: whether the body image dares to be fed a
// downscaled copy, and what onLoad takes as the real size to write back into node data. Trusting it wrongly does not just blur the picture; it
// persists numbers belonging to another image, making the badge and auto size wrong together, and they stay wrong.
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { useNaturalSizeRecordTrust } from "@/features/canvas/hooks/useNaturalSizeRecordTrust";

const A = "/static/projects/p/a.png";
const B = "/static/projects/p/b.png";

describe("useNaturalSizeRecordTrust", () => {
  it("trust the record at mount: persisted data has no \"previous image\" to compare against", () => {
    const { result } = renderHook(() => useNaturalSizeRecordTrust(A));
    expect(result.current.distrusted).toBe(false);
  });

  // This is exactly the same-ratio image swap scene. The copy cannot recognize it: the card copies of 5504x3072 and 2752x1536
  // are both 1280x714, and nodeBodyRecordDescribesImage lets it all through. So the criterion can only be the swap itself.
  it("distrusts on the spot after an image swap, even when the new and old images have exactly the same ratio", () => {
    const { result, rerender } = renderHook(
      ({ subject }) => useNaturalSizeRecordTrust(subject),
      { initialProps: { subject: A } },
    );
    expect(result.current.distrusted).toBe(false);

    rerender({ subject: B });

    expect(result.current.distrusted).toBe(true);
  });

  // If not lifted, this node feeds the original forever from then on -- giving back the entire benefit of this change.
  it("lifts after the real size is measured and uses the copy again", () => {
    const { result, rerender } = renderHook(
      ({ subject }) => useNaturalSizeRecordTrust(subject),
      { initialProps: { subject: A } },
    );
    rerender({ subject: B });
    expect(result.current.distrusted).toBe(true);

    act(() => result.current.trustAgain());

    expect(result.current.distrusted).toBe(false);
  });

  // Falling back to the original may not persist either (a node whose size was adjusted by hand returns early in onLoad). The record
  // still does not match then, and the copy would cry distrust once more -- without this gate it is a copy -> original -> copy infinite loop.
  it("falls back only once per image, so a correction that did not persist does not flip-flop", () => {
    const { result } = renderHook(() => useNaturalSizeRecordTrust(A));

    act(() => result.current.distrustRecord());
    expect(result.current.distrusted).toBe(true);
    act(() => result.current.trustAgain());
    act(() => result.current.distrustRecord());

    expect(result.current.distrusted).toBe(false);
  });

  it("the gate is recorded per image, not per node: switching to the next image can fall back once more", () => {
    const { result, rerender } = renderHook(
      ({ subject }) => useNaturalSizeRecordTrust(subject),
      { initialProps: { subject: A } },
    );
    act(() => result.current.distrustRecord());
    act(() => result.current.trustAgain());

    rerender({ subject: B });

    expect(result.current.distrusted).toBe(true);
  });

  it("with no image there is nothing to distrust", () => {
    const { result } = renderHook(() => useNaturalSizeRecordTrust(null));
    act(() => result.current.distrustRecord());
    expect(result.current.distrusted).toBe(false);
  });

  // This is the path the generation flow really takes: ImageGenNode empties the body image during isGenerating
  // (visiblePreviewUrl = null), so the subject sequence is old image -> null -> new result. If
  // null were also treated as the "previous image", then when the new result arrives the previous seen would be null and it would be taken for a
  // first mount and the old record trusted for nothing -- precisely the moment distrust is needed most: when the same node regenerates, the new and old results
  // usually share the same target aspect ratio, and the copy check cannot tell either.
  it("temporarily hiding the image during generation does not stop recognizing it as an image swap when it comes back", () => {
    const { result, rerender } = renderHook(
      ({ subject }: { subject: string | null }) => useNaturalSizeRecordTrust(subject),
      { initialProps: { subject: A as string | null } },
    );
    expect(result.current.distrusted).toBe(false);

    rerender({ subject: null });
    rerender({ subject: B });

    expect(result.current.distrusted).toBe(true);
  });

  // The reverse must also hold: after a failed/cancelled generation the old image is put back as-is, nothing was swapped, and it should not fall back to the original
  // and run a measurement for nothing.
  it("hiding and then putting the same image back as-is does not count as an image swap", () => {
    const { result, rerender } = renderHook(
      ({ subject }: { subject: string | null }) => useNaturalSizeRecordTrust(subject),
      { initialProps: { subject: A as string | null } },
    );

    rerender({ subject: null });
    rerender({ subject: A });

    expect(result.current.distrusted).toBe(false);
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PikoInspirationStation } from "@/features/piko-mini-game/PikoInspirationStation";

// jsdom does not implement HTMLMediaElement loading/playing, and calling it directly throws "Not implemented".
const loadSpy = vi.fn();

beforeEach(() => {
  loadSpy.mockClear();
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(loadSpy);
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function renderLibrary() {
  const { container } = render(<PikoInspirationStation open onClose={() => {}} />);
  const video = container.querySelector("video");
  expect(video).not.toBeNull();
  const card = video!.closest("button");
  expect(card).not.toBeNull();
  return { card: card!, video: video! };
}

describe("piko hover video recovery after a load failure", () => {
  it("hovering again after load() fails should reload rather than skip permanently", () => {
    const { card, video } = renderLibrary();

    fireEvent.pointerEnter(card);
    expect(loadSpy).toHaveBeenCalledTimes(1);

    // Transient network error: this load has already terminated, and the guard must let the next hover through,
    // otherwise this card can only be recovered by closing the dialog and remounting.
    fireEvent.pointerLeave(card);
    fireEvent.error(video);

    fireEvent.pointerEnter(card);
    expect(loadSpy).toHaveBeenCalledTimes(2);
  });

  it("restore the cover after a load failure, leaving no black image", () => {
    const { card, video } = renderLibrary();
    const poster = video.getAttribute("poster");
    expect(poster).toBeTruthy();

    fireEvent.pointerEnter(card);
    // First-frame readiness removes the poster; this simulates the case where it was already removed and playback was then interrupted.
    video.removeAttribute("poster");
    fireEvent.error(video);

    expect(video.getAttribute("poster")).toBe(poster);
  });

  it("repeated hover during loading must not interrupt, and load() is still called only once", () => {
    const { card } = renderLibrary();

    fireEvent.pointerEnter(card);
    fireEvent.pointerLeave(card);
    fireEvent.pointerEnter(card);
    fireEvent.pointerLeave(card);
    fireEvent.pointerEnter(card);

    expect(loadSpy).toHaveBeenCalledTimes(1);
  });
});

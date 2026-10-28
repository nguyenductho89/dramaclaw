// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Smart continuation renders "Continue the 00:00-00:04 clip of X:" as a read-only
// chip at the very front of the input, and does **not write it into data.prompt**. So there are two
// bottom lines: serialization must not carry it out (that would mix it into the user's
// body text, and one backspace would eat half the instruction), and backspace must not eat it either.
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render } from "@testing-library/react";

import { PromptMentionEditor } from "@/features/canvas/nodes/PromptMentionEditor";

beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
});

const prefix = {
  text: "Continue the 00:00-00:04 clip of Video (2):",
  thumbnailUrl: "https://example.com/poster.jpg",
};

function editorOf(container: HTMLElement): HTMLElement {
  return container.querySelector(".prompt-mention-editor") as HTMLElement;
}

describe("PromptMentionEditor — continuation prefix", () => {
  it("image + text render as a single non-editable chip", () => {
    const { container } = render(
      <PromptMentionEditor value="" onChange={() => {}} candidates={[]} prefix={prefix} />,
    );

    const chip = container.querySelector("[data-prompt-prefix]") as HTMLElement;
    expect(chip).toBeTruthy();
    expect(chip.textContent).toBe(prefix.text);
    expect(chip.querySelector("img")?.getAttribute("src")).toBe(prefix.thumbnailUrl);
  });

  it("falls back to the video first frame when there is no static thumbnail — a video node's thumbUrl is often empty", () => {
    const { container } = render(
      <PromptMentionEditor
        value=""
        onChange={() => {}}
        candidates={[]}
        prefix={{
          text: prefix.text,
          thumbnailUrl: null,
          videoUrl: "https://example.com/a.mp4",
        }}
      />,
    );

    const chip = container.querySelector("[data-prompt-prefix]") as HTMLElement;
    expect(chip.querySelector("img")).toBeNull();
    const video = chip.querySelector("video");
    expect(video?.getAttribute("src")).toBe("https://example.com/a.mp4");
    expect(video?.getAttribute("preload")).toBe("metadata");
  });

  it("the prefix does not take part in serialization — it is not user-written content", () => {
    const onChange = vi.fn();
    const { container } = render(
      <PromptMentionEditor
        value="Keep the story going"
        onChange={onChange}
        candidates={[]}
        prefix={prefix}
      />,
    );

    // Serialized result matches value → no onChange. If the prefix were read back, we would receive
    // "Continue the … clip of Video (2): Keep the story going" here, and the instruction would be mixed into the user's body text on the spot.
    fireEvent.input(editorOf(container));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("backspace with the caret against the prefix has no effect and cannot delete the instruction", () => {
    const onChange = vi.fn();
    const { container } = render(
      <PromptMentionEditor value="" onChange={onChange} candidates={[]} prefix={prefix} />,
    );

    const editor = editorOf(container);
    const chip = container.querySelector("[data-prompt-prefix]") as HTMLElement;
    const selection = window.getSelection();
    const range = document.createRange();
    range.setStartAfter(chip);
    range.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(range);

    const event = new KeyboardEvent("keydown", {
      key: "Backspace",
      bubbles: true,
      cancelable: true,
    });
    editor.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(container.querySelector("[data-prompt-prefix]")).toBeTruthy();
  });

  it("with a prefix the placeholder moves to ::after, driven by a data attribute", () => {
    const { container, rerender } = render(
      <PromptMentionEditor
        value=""
        onChange={() => {}}
        candidates={[]}
        prefix={prefix}
        placeholder="Enter the content to continue"
      />,
    );

    // :empty is already broken by the chip, so the ::before rule no longer applies; this attribute feeds ::after instead.
    expect(editorOf(container).dataset.prefixPlaceholder).toBe("Enter the content to continue");

    rerender(
      <PromptMentionEditor
        value="Continue"
        onChange={() => {}}
        candidates={[]}
        prefix={prefix}
        placeholder="Enter the content to continue"
      />,
    );
    expect(editorOf(container).dataset.prefixPlaceholder).toBe("");
  });

  it("the remove button is attached only when onPrefixRemove is given; clicking it hands the prefix back to the parent", () => {
    const onPrefixRemove = vi.fn();
    const { container } = render(
      <PromptMentionEditor
        value=""
        onChange={() => {}}
        candidates={[]}
        prefix={prefix}
        onPrefixRemove={onPrefixRemove}
      />,
    );

    const remove = container.querySelector("[data-prompt-prefix-remove]") as HTMLElement;
    expect(remove).toBeTruthy();
    expect(remove.getAttribute("aria-label")).toBe("Remove prefix");
    // The thumbnail is not displaced, only covered by CSS on hover — the two share the left-hand cell.
    expect(remove.parentElement?.querySelector("img")).toBeTruthy();

    fireEvent.click(remove);
    expect(onPrefixRemove).toHaveBeenCalledTimes(1);
  });

  it("without onPrefixRemove the prefix is read-only and has no remove button", () => {
    const { container } = render(
      <PromptMentionEditor value="" onChange={() => {}} candidates={[]} prefix={prefix} />,
    );
    expect(container.querySelector("[data-prompt-prefix-remove]")).toBeNull();
  });

  it("without a prefix the input behaves exactly as before", () => {
    const { container } = render(
      <PromptMentionEditor value="Write something" onChange={() => {}} candidates={[]} />,
    );
    expect(container.querySelector("[data-prompt-prefix]")).toBeNull();
    expect(editorOf(container).dataset.prefixPlaceholder).toBe("");
  });
});

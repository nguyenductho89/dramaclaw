// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// After the style list fails to load it must be possible to try again. The sibling useFreezoneCameraOptions fetches "once per tab"
// and a failure is permanent -- losing camera parameters costs at most a few options, but losing styles leaves a whole wall of
// placeholder blocks, and an already selected style is still sent with generation requests, leaving the user with no remedy at all.
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchTemplates = vi.fn();

vi.mock("@/api/ops", () => ({
  listFreezoneStyleTemplates: (project: string) => fetchTemplates(project),
}));

import { useFreezoneStyleTemplates } from "@/features/canvas/hooks/useFreezoneStyleTemplates";

const TEMPLATE = {
  id: "golden_age",
  label: "Golden Age",
  category: "Period",
  cover: "golden_age/cover.webp",
  samples: ["golden_age/female.webp"],
  style_prompt: "Golden Age prompt",
};

// The module-level cache is bucketed by project, so switching to a different project in each case gives a clean state.
let seq = 0;
function nextProject() {
  seq += 1;
  return `proj-${seq}`;
}

describe("useFreezoneStyleTemplates retry", () => {
  beforeEach(() => {
    fetchTemplates.mockReset();
  });

  it("retry can fetch the list back after a failure", async () => {
    const project = nextProject();
    fetchTemplates.mockRejectedValueOnce(new Error("boom"));

    const { result } = renderHook(() => useFreezoneStyleTemplates(project));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.templates).toEqual([]);
    expect(result.current.isLoading).toBe(false);

    fetchTemplates.mockResolvedValueOnce({
      templates: [TEMPLATE],
      assetBase: "https://cdn.example.com/style-gallery",
    });
    act(() => result.current.retry());

    await waitFor(() => expect(result.current.templates).toHaveLength(1));
    expect(result.current.error).toBeNull();
    expect(result.current.assetBase).toBe("https://cdn.example.com/style-gallery");
    expect(fetchTemplates).toHaveBeenCalledTimes(2);
  });

  it("calling retry in the success state does not needlessly fetch again", async () => {
    const project = nextProject();
    fetchTemplates.mockResolvedValueOnce({
      templates: [TEMPLATE],
      assetBase: "",
    });

    const { result } = renderHook(() => useFreezoneStyleTemplates(project));
    await waitFor(() => expect(result.current.templates).toHaveLength(1));

    act(() => result.current.retry());

    expect(fetchTemplates).toHaveBeenCalledTimes(1);
  });

  it("re-rendering does not retry by itself -- that would become a fail/re-render infinite loop", async () => {
    const project = nextProject();
    fetchTemplates.mockRejectedValue(new Error("boom"));

    const { result, rerender } = renderHook(() =>
      useFreezoneStyleTemplates(project),
    );
    await waitFor(() => expect(result.current.error).not.toBeNull());

    rerender();
    rerender();

    expect(fetchTemplates).toHaveBeenCalledTimes(1);
  });
});

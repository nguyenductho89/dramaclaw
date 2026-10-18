// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { SketchSection } from "@/components/episode/beat-workbench/sketch-section";
import { useAspectRatioStore } from "@/stores/aspect-ratio-store";
import type { Beat } from "@/types/episode";

const markSeenMock = vi.fn();
const stageManifestMock = vi.fn();
const backgroundAnchorsMock = vi.fn();
const updateBackgroundAnchorMock = vi.fn();
const uploadBackgroundAnchorMock = vi.fn();
const directorStatusMock = vi.fn();
const directorConvertMock = vi.fn();
const taskStartMock = vi.fn();
const regenerateSketchMock = vi.fn();
const poolSelectMock = vi.fn();
const creditCostMock = vi.fn();
const taskControllerKeyMock = vi.fn();
const trackRegenScopeMock = vi.fn();

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, string | number>) => {
      if (key === "episode.beat.noSketch") return "No sketch";
      if (key === "common.generateNew") return "Generate new";
      if (key === "common.regenerate") return "Regenerate";
      if (key === "episode.workbench.sketch.generateNow") return "Generate now";
      if (key === "episode.workbench.sketch.regenDesc") return `Regenerate ${vars?.n} beats`;
      if (key === "episode.workbench.sketch.generateDesc") return `Generate ${vars?.n} beats`;
      if (key === "episode.workbench.sketch.directorControl") return "Director composite asset";
      if (key === "episode.workbench.sketch.directorControlFile") return "Combined + env-only + metadata";
      if (key === "episode.workbench.sketch.convertDirectorControl") return "Convert to sketch";
      if (key === "episode.workbench.sketch.convertDirectorStarted") return "Started";
      if (key === "episode.workbench.sketch.convertDirectorFailed") return "Failed to start";
      if (key === "episode.workbench.sketch.openDirectorWorld") return "Director world";
      if (key === "episode.workbench.sketch.chooseBackground") return "Background";
      if (key === "episode.workbench.sketch.poseEdit") return "Pose edit";
      if (key === "episode.workbench.sketch.cropEdit") return "Crop save";
      return key;
    },
  }),
}));

vi.mock("@/lib/queries/sketches", () => ({
  StalePoolSelectError: class StalePoolSelectError extends Error {},
  usePoolSelect: () => ({ mutateAsync: poolSelectMock, isPending: false }),
  useRegenerateSketches: () => ({ mutateAsync: regenerateSketchMock, isPending: false }),
  useGenerateMissingManualSketches: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUploadBeatImage: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useBeatDirectorStageManifest: () => stageManifestMock(),
  useBeatBackgroundAnchors: () => backgroundAnchorsMock(),
  useUpdateBeatBackgroundAnchor: () => ({ mutateAsync: updateBackgroundAnchorMock, isPending: false }),
  useUploadBeatBackgroundAnchor: () => ({ mutateAsync: uploadBackgroundAnchorMock, isPending: false }),
  useDirectorControlFrameStatus: () => directorStatusMock(),
  useDirectorControlToSketch: () => ({ mutateAsync: directorConvertMock, isPending: false }),
}));

vi.mock("@/lib/queries/scripts", () => ({
  useScript: () => ({
    data: {
      ok: true,
      data: {
        sketch_colors: {
          "Lu Chen_young_adult": "#00ffff CYAN",
        },
      },
    },
  }),
}));

vi.mock("@/lib/queries/sketch-settings", () => ({
  useSketchSettings: () => ({
    data: {
      ok: true,
      data: {
        sketch_image_selection: "doubao_seedream-3.0-t2i",
        options: {},
      },
    },
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: (...args: unknown[]) => creditCostMock(...args),
}));

vi.mock("@/lib/queries/characters", () => ({
  useCharacters: () => ({
    data: [{ name: "Lu Chen" }],
  }),
}));

vi.mock("@/lib/queries/episodes", () => ({
  useEpisodeDetail: () => ({
    data: {
      ok: true,
      data: {
        prop_menu: [
          {
            prop_id: "sheepskin notebook",
            marker_color: "#d4af37 GOLD",
          },
        ],
      },
    },
  }),
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: (options: { key: unknown }) => {
    taskControllerKeyMock(options.key);
    return { start: taskStartMock };
  },
}));

vi.mock("@/hooks/use-scoped-task-batch-invalidation", () => ({
  useScopedTaskBatchInvalidation: () => ({ track: trackRegenScopeMock }),
}));

vi.mock("@/hooks/use-now", () => ({
  useNow: () => 1_717_000_000_000,
}));

vi.mock("@/components/episode/beat-workbench/sketch-pose-editor-dialog", () => ({
  SketchPoseEditorDialog: () => null,
}));

vi.mock("@/components/episode/beat-workbench/sketch-crop-dialog", () => ({
  SketchCropDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="sketch-crop-dialog" /> : null,
}));

vi.mock("@/features/viewer-kit/three-d/ThreeDDirectorDialog", () => ({
  ThreeDDirectorDialog: ({ open }: { open: boolean }) =>
    open ? <div data-testid="three-d-director-dialog" /> : null,
}));

vi.mock("@/stores/seen-pool-store", () => ({
  useSeenPoolStore: (selector: (state: { markSeen: typeof markSeenMock; seen: Record<string, string[]> }) => unknown) =>
    selector({ markSeen: markSeenMock, seen: {} }),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function makeBeat(overrides: Partial<Beat> = {}): Beat {
  return {
    beat_number: 4,
    narration_segment: "Found the book in the secret room",
    visual_description: "Lu Chen holds up [[flashlight]] and opens [[sheepskin notebook]]",
    sketch_url: "/static/sketches/beat_04.png",
    detected_identities: ["Lu Chen_young_adult"],
    detected_props: ["sheepskin notebook"],
    ...overrides,
  } as Beat;
}

describe("SketchSection", () => {
  beforeEach(() => {
    useAspectRatioStore.getState().reset();
    regenerateSketchMock.mockReset();
    regenerateSketchMock.mockResolvedValue({
      ok: true,
      scope: "1x1_16-9_sketch__beat_04",
    });
    poolSelectMock.mockReset();
    poolSelectMock.mockResolvedValue({
      ok: true,
      data: {
        beat_num: 4,
        pool_id: "pool-sketch-4",
        image_type: "sketch",
        sketch_url: "/static/sketches/ep001/beat_04.png",
      },
    });
    stageManifestMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          viewer_kind: "three_d_director",
          mode: "beat",
          project: "demo",
          scene_id: "Basement",
          display_name: "Basement",
          source: {
            ply_url: "/static/director_worlds/scene/master_sharp.ply",
            source_kind: "master",
          },
          palette: { actors: [], props: [], anonymous_colors: [] },
          allowed_destinations: ["view", "beat_selected_background"],
        },
      },
      isLoading: false,
    });
    uploadBackgroundAnchorMock.mockReset();
    uploadBackgroundAnchorMock.mockResolvedValue({ ok: true, data: {} });
    backgroundAnchorsMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          can_choose: true,
          current_anchor: "master",
          anchors: [
            { id: "master", label: "master", exists: true, url: "/static/master.png" },
          ],
          error: "",
        },
      },
      isLoading: false,
      refetch: vi.fn(),
    });
    updateBackgroundAnchorMock.mockReset();
    updateBackgroundAnchorMock.mockResolvedValue({
      ok: true,
      data: { current_anchor: "selected_background", anchors: [] },
    });
    directorStatusMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          ready: false,
          url: null,
          scope: "director_control_to_sketch:ep001:beat_04",
        },
      },
      isLoading: false,
    });
    directorConvertMock.mockReset();
    taskStartMock.mockReset();
    directorConvertMock.mockResolvedValue({
      ok: true,
      task_type: "sketch_generation",
      scope: "director_control_to_sketch:ep001:beat_04",
    });
    creditCostMock.mockReset();
    creditCostMock.mockReturnValue({
      data: { ok: true, data: { cost: 1, display: "1 credit" } },
    });
    taskControllerKeyMock.mockReset();
    trackRegenScopeMock.mockReset();
  });

  it("keeps sketch identity, detected props, and local marked props in the right-side info row", () => {
    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.getByTitle("Lu Chen · Young adult")).toBeInTheDocument();
    expect(screen.getByText("sheepskin notebook")).toBeInTheDocument();
    expect(screen.getByText("flashlight")).toBeInTheDocument();
  });

  it("displays portrait sketches at the generated 2:3 asset ratio", () => {
    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.getByAltText("Beat 4 sketch").parentElement).toHaveStyle({
      aspectRatio: "2 / 3",
    });
  });

  it("does not duplicate a marked prop that AI already detected", () => {
    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.getAllByText("sheepskin notebook")).toHaveLength(1);
  });

  it("shows beat Director World and single-beat background actions", () => {
    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.getByRole("button", { name: /Director world/ })).toBeEnabled();
    expect(screen.getByRole("button", { name: /Background/ })).toBeEnabled();
  });

  it("promotes a pool-only sketch before opening crop", async () => {
    render(
      <SketchSection
        beat={makeBeat({ sketch_url: "" })}
        project="demo"
        episode={1}
        images={[
          {
            id: "pool-sketch-4",
            type: "sketch",
            mode: "1x1_2-3_sketch",
            grid_index: 0,
            cell_index: 0,
            row: 0,
            col: 0,
            original_beat: 4,
            cell_url: "/static/grids/ep001/pool-sketch-4.png",
            grid_url: "/static/grids/ep001/grid.png",
            grid_path: "grids/ep001/grid.png",
            stale: false,
          },
        ]}
        assignments={{ "4": "pool-sketch-4" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Crop save/ }));

    await waitFor(() =>
      expect(poolSelectMock).toHaveBeenCalledWith({
        beatNum: 4,
        poolId: "pool-sketch-4",
      }),
    );
    expect(screen.getByTestId("sketch-crop-dialog")).toBeInTheDocument();
  });

  it("refetches single-beat backgrounds before opening the dialog", async () => {
    const refetch = vi.fn().mockResolvedValue({
      data: {
        ok: true,
        data: {
          can_choose: true,
          current_anchor: "master",
          anchors: [
            { id: "master", label: "master", exists: true, url: "/static/master.png" },
          ],
          error: "",
        },
      },
    });
    backgroundAnchorsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      refetch,
    });

    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Background/ }));

    await waitFor(() => expect(refetch).toHaveBeenCalled());
    expect(await screen.findByText("master")).toBeInTheDocument();
  });

  it("shows director control preview and conversion action when combined frame is ready", () => {
    directorStatusMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          ready: true,
          url: "/static/admin/demo/director_control_frames/ep001/beat_04/combined.png",
          scope: "director_control_to_sketch:ep001:beat_04",
          mode_key: "1x1_16-9_sketch",
        },
      },
      dataUpdatedAt: 1_717_000_000_123,
      isLoading: false,
    });

    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.getByText("Director composite asset")).toBeInTheDocument();
    expect(screen.getByText("Combined + env-only + metadata")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Convert to sketch/ })).toBeEnabled();
    expect(creditCostMock).toHaveBeenCalledWith(
      "feature",
      "mainline.director_control_to_sketch",
      expect.objectContaining({
        imageRole: "sketch",
        modeKey: "1x1_16-9_sketch",
      }),
    );
    expect(taskControllerKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: "director_control_to_sketch",
        beatNum: 4,
      }),
    );
    expect(screen.getByAltText("Beat 4 Director World control frame")).toHaveAttribute(
      "src",
      "/static/projects/demo/director_control_frames/ep001/beat_04/combined.png?st_v=1717000000123",
    );
  });

  it("does not stack st_v on director control previews that already have a file version", () => {
    directorStatusMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          ready: true,
          url: "/static/admin/demo/director_control_frames/ep001/beat_04/combined.png?v=file-version",
          scope: "director_control_to_sketch:ep001:beat_04",
        },
      },
      dataUpdatedAt: 1_717_000_000_123,
      isLoading: false,
    });

    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.getByAltText("Beat 4 Director World control frame")).toHaveAttribute(
      "src",
      "/static/projects/demo/director_control_frames/ep001/beat_04/combined.png?v=file-version",
    );
  });

  it("starts director control conversion with returned task scope", async () => {
    directorStatusMock.mockReturnValue({
      data: {
        ok: true,
        data: {
          ready: true,
          url: "/static/admin/demo/director_control_frames/ep001/beat_04/combined.png",
          scope: "director_control_to_sketch:ep001:beat_04",
        },
      },
      isLoading: false,
    });

    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Convert to sketch/ }));

    await waitFor(() => expect(directorConvertMock).toHaveBeenCalled());
    expect(taskStartMock).toHaveBeenCalledWith({
      scope: "director_control_to_sketch:ep001:beat_04",
    });
  });

  it("downloads the current sketch url when it is not backed by a pool image", () => {
    const originalCreateElement = document.createElement.bind(document);
    const anchor = originalCreateElement("a") as HTMLAnchorElement;
    const clickSpy = vi.spyOn(anchor, "click").mockImplementation(() => {});
    const createElementSpy = vi
      .spyOn(document, "createElement")
      .mockImplementation(((tagName: string, options?: ElementCreationOptions) => {
        if (tagName === "a") return anchor;
        return originalCreateElement(tagName, options);
      }) as typeof document.createElement);

    try {
      render(
        <SketchSection
          beat={makeBeat()}
          project="demo"
          episode={1}
          images={[]}
          assignments={{}}
        />,
      );

      const downloadButton = screen.getByRole("button", { name: "common.download" });
      expect(downloadButton).toBeEnabled();

      fireEvent.click(downloadButton);

      expect(anchor.getAttribute("href")).toBe("/static/sketches/beat_04.png");
      expect(anchor.download).toBe("beat_4_sketch.png");
      expect(clickSpy).toHaveBeenCalled();
    } finally {
      createElementSpy.mockRestore();
      clickSpy.mockRestore();
    }
  });

  it("uses the project aspect for single-beat sketch regeneration", async () => {
    useAspectRatioStore.getState().setOrientation("demo", "landscape");

    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Regenerate/ }));
    fireEvent.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(regenerateSketchMock).toHaveBeenCalled());
    expect(regenerateSketchMock).toHaveBeenCalledWith({
      beatIndices: [4],
      modeKey: "1x1_16-9_sketch",
      imageGenerationSelection: "doubao_seedream-3.0-t2i",
    });
  });

  // While beat 4 is running a sketch, after switching to beat 5 "Generate now" must not be greyed out: the sketch_regen registry
  // entry must be split per beat (coversBeat) instead of one for the whole episode.
  it("scopes the sketch_regen controller to this beat's coverage", () => {
    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(taskControllerKeyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        taskType: "sketch_regen",
        coversBeat: 4,
      }),
    );
    // After splitting entries per beat, the cell that was switched away from has no owner, and the global task bus has to cover the refresh.
    const regenKey = taskControllerKeyMock.mock.calls
      .map(([key]) => key as { taskType: string; beatNum?: number })
      .find((key) => key.taskType === "sketch_regen");
    expect(regenKey?.beatNum).toBeUndefined();
  });

  it("tracks the dispatched regen scope so a backgrounded beat still refreshes", async () => {
    render(
      <SketchSection
        beat={makeBeat()}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /Regenerate/ }));
    fireEvent.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() =>
      expect(trackRegenScopeMock).toHaveBeenCalledWith("1x1_16-9_sketch__beat_04"),
    );
  });

  it("shows generate new for the current beat when the beat has no sketch", async () => {
    render(
      <SketchSection
        beat={makeBeat({ sketch_url: "" })}
        project="demo"
        episode={1}
        images={[]}
        assignments={{}}
      />,
    );

    expect(screen.queryByRole("button", { name: /Regenerate/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Generate now/ }));
    fireEvent.click(screen.getByRole("button", { name: "common.confirm" }));

    await waitFor(() => expect(regenerateSketchMock).toHaveBeenCalledWith({
      beatIndices: [4],
      modeKey: "1x1_2-3_sketch",
      imageGenerationSelection: "doubao_seedream-3.0-t2i",
    }));
  });
});

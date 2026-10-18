// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { BeatContextNode } from "@/features/canvas/nodes/BeatContextNode";
import type { BeatContextNodeData } from "@/features/canvas/domain/canvasNodes";
import { buildBeatContextNodeRefreshPatch } from "@/features/freezone/context/beatContextSnapshot";
import { setFreezoneCanvasMetadata } from "@/features/freezone/canvasMetadataContext";
import { useCanvasStore } from "@/stores/canvasStore";

const updateBeat = vi.fn().mockResolvedValue({ ok: true, data: null });
const listFreezoneBeatContext = vi.fn();
const createCanvasFromPreset = vi.fn();
const getFreezoneCanvas = vi.fn();

vi.mock("@xyflow/react", async () => {
  const actual =
    await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    Handle: ({ id, type }: { id?: string; type?: string }) => (
      <div data-testid={`handle-${type ?? "unknown"}-${id ?? "default"}`} />
    ),
  };
});

vi.mock("@/api/projects", () => ({
  listFreezoneBeatContext: (...args: unknown[]) =>
    listFreezoneBeatContext(...args),
  updateBeat: (...args: unknown[]) => updateBeat(...args),
}));

vi.mock("@/api/canvas", () => ({
  createCanvasFromPreset: (...args: unknown[]) =>
    createCanvasFromPreset(...args),
  getFreezoneCanvas: (...args: unknown[]) => getFreezoneCanvas(...args),
}));

vi.mock("@/features/canvas/ui/NodeResizeHandle", () => ({
  NodeResizeHandle: () => <div data-testid="resize-handle" />,
}));

vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
  NodeHeader: ({ titleText }: { titleText: string }) => <div>{titleText}</div>,
}));

vi.mock("@/lib/queries/episodes", () => ({
  useEpisodeDetail: () => ({
    data: {
      ok: true,
      data: {
        number: 1,
        title: "EP1",
        identity_ids: ["diner_young_man_young_adult", "diner_young_woman_young_adult"],
        scene_menu: [{ scene_id: "noodle_shop" }],
        prop_menu: [{ prop_id: "bill" }, { prop_id: "red_stool" }],
      },
    },
  }),
  useEpisodeBeats: () => ({
    data: {
      ok: true,
      data: [
        {
          beat_number: 3,
          narration_segment: "",
          visual_description: "",
          scene_ref: { scene_id: "noodle_shop" },
          time_of_day: "night",
          detected_identities: [],
          detected_props: [],
        },
      ],
    },
  }),
}));

async function chooseUiSelectOption(
  user: ReturnType<typeof userEvent.setup>,
  label: string,
  optionName: string,
) {
  await user.click(screen.getByRole("button", { name: label }));
  await user.click(await screen.findByRole("option", { name: optionName }));
}

function makeData(
  overrides: Partial<BeatContextNodeData> = {},
): BeatContextNodeData {
  return {
    displayName: "EP1 / Beat 3",
    projectId: "demo",
    episode: 1,
    beat: 3,
    content: "Wide shot, inside the Lanzhou noodle shop.",
    snapshot: {
      visualDescription: "Wide shot, inside the Lanzhou noodle shop.",
      sceneId: "noodle_shop",
      timeOfDay: "",
      detectedIdentities: [],
      detectedProps: [],
      selectedBackgroundExists: false,
      currentSketchExists: false,
      currentFrameExists: false,
    },
    mainline_context: [
      {
        kind: "beat",
        projectId: "demo",
        episode: 1,
        beat: 3,
      },
    ],
    syncStatus: "fresh",
    ...overrides,
  };
}

function renderNode(data: BeatContextNodeData = makeData()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <BeatContextNode
        id="context_beat"
        type="beatContextNode"
        data={data}
        selected={false}
        dragging={false}
        draggable={true}
        selectable={true}
        deletable={true}
        zIndex={0}
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  updateBeat.mockClear();
  createCanvasFromPreset.mockReset();
  getFreezoneCanvas.mockReset();
  setFreezoneCanvasMetadata(null);
  listFreezoneBeatContext.mockReset();
  listFreezoneBeatContext.mockResolvedValue({
    episodes: [
      {
        episode: 1,
        beats: [
          {
            episode: 1,
            beat: 3,
            label: "EP1 / Beat 3",
            visual_description: "Wide shot, inside the Lanzhou noodle shop.",
            narration_segment: "",
            scene_id: "noodle_shop",
            time_of_day: "night",
            detected_identities: [],
            detected_props: [],
            sketch_colors: {},
            prop_marker_colors: {},
            assets: [],
          },
        ],
      },
    ],
  });
  createCanvasFromPreset.mockResolvedValue({
    canvas_id: "default",
    reused: false,
    url: "/freezone/?canvas=default",
  });
  getFreezoneCanvas.mockResolvedValue({
    nodes: [],
    edges: [],
    metadata: null,
  });
  useCanvasStore.getState().setCanvasData([], []);
});

function localeValue(locale: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((value, part) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[part];
  }, locale);
}

describe("BeatContextNode", () => {
  it("defines i18n labels for shot context standalone UI in vi and en", () => {
    const vi = JSON.parse(
      readFileSync("public/locales/vi/translation.json", "utf-8"),
    );
    const en = JSON.parse(
      readFileSync("public/locales/en/translation.json", "utf-8"),
    );
    const keys = [
      "node.beatContextNode.standaloneTitle",
      "node.beatContextNode.fields.visual",
      "node.beatContextNode.fields.props",
      "node.beatContextNode.status.standaloneLocalOnly",
      "node.beatContextNode.palette.propColors",
    ];
    for (const key of keys) {
      expect(localeValue(vi, key)).toEqual(expect.any(String));
      expect(localeValue(en, key)).toEqual(expect.any(String));
    }
    expect(localeValue(en, "node.menu.beatContext")).toBe("Shot Context");
    expect(localeValue(en, "node.beatContextNode.heading")).toBe("Shot Context");
    expect(localeValue(en, "node.beatContextNode.standaloneTitle")).toBe("Custom Shot Context");
    expect(localeValue(en, "viewer.threeD.beatOverlay.title")).toBe("Shot overlay");
  });

  it("preserves local time of day when sync response omits the field", () => {
    const patch = buildBeatContextNodeRefreshPatch(
      "demo",
      {
        episode: 1,
        beat: 3,
        label: "EP1 / Beat 3",
        visual_description: "Wide shot, inside the Lanzhou noodle shop.",
        narration_segment: "",
        scene_id: "noodle_shop",
        detected_identities: [],
        detected_props: [],
        sketch_colors: {},
        prop_marker_colors: {},
        assets: [],
      },
      makeData({
        snapshot: {
          ...makeData().snapshot,
          timeOfDay: "night",
        },
        beat_edit_fields: {
          time_of_day: "night",
        },
      }),
    );

    expect(patch.snapshot?.timeOfDay).toBe("night");
    expect(patch.beat_edit_fields?.time_of_day).toBe("night");
  });

  it("renders selectable identity and prop chips instead of CSV inputs", () => {
    renderNode();

    expect(screen.getByText("Appearing identities")).toBeInTheDocument();
    expect(screen.getByText("Appearing props")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /diner_young_man_young_adult/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /bill/ })).toBeInTheDocument();
  });

  it("shows assigned identity and prop colors on selectable chips", () => {
    renderNode(
      makeData({
        snapshot: {
          ...makeData().snapshot,
          sketchColors: {
            diner_young_man_young_adult: "#FF00FF MAGENTA",
          },
          propMarkerColors: {
            bill: "#5D4037 BROWN",
          },
        },
      }),
    );

    expect(
      screen.getByTestId("beat-context-color-identity-diner_young_man_young_adult"),
    ).toHaveStyle({
      backgroundColor: "#FF00FF",
    });
    expect(screen.getByTestId("beat-context-color-prop-bill")).toHaveStyle({
      backgroundColor: "#5D4037",
    });
  });
  it("renders standalone context as local-only without mainline sync", () => {
    renderNode(
      makeData({
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "Custom Shot Context",
          visual_description: "On a rainy night, the heroine stands at the convenience store entrance and looks back.",
          narration_segment: "",
          scene_id: "store_entrance",
          detected_identities: [],
          detected_props: [],
          sketch_colors: {},
          prop_marker_colors: {},
        },
      }),
    );

    expect(screen.getByText("Custom Shot Context")).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Sync to mainline" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("EP? / Beat ?")).not.toBeInTheDocument();
    expect(screen.queryByText("EP1 / Beat 3")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Scene")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Time")).not.toBeInTheDocument();
  });

  it("treats beat nodes with mainline_context as mainline even if default standalone fields leaked in", () => {
    renderNode(
      makeData({
        context_scope: "standalone",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "Custom Shot Context",
          visual_description: "",
          narration_segment: "",
          detected_identities: [],
          detected_props: [],
          sketch_colors: {},
          prop_marker_colors: {},
        },
      }),
    );

    expect(screen.getAllByText("EP1 / Beat 3").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Scene")).toBeInTheDocument();
    expect(screen.getByLabelText("Time")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sync to mainline" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Context is synced; skills use this node."),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Custom context; only used on this canvas."),
    ).not.toBeInTheDocument();
  });

  it("inserts standalone mention templates and derives identity and prop chips", () => {
    renderNode(
      makeData({
        displayName: "Shot Context",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "Custom Shot Context",
          visual_description: "",
          narration_segment: "",
          detected_identities: [],
          detected_props: [],
          sketch_colors: {},
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    const visual = screen.getByPlaceholderText("Unset; click to enter the opening frame");
    fireEvent.change(visual, { target: { value: "@", selectionStart: 1 } });

    const identityTemplate = screen.getByText("Character").closest("button");
    expect(identityTemplate).not.toBeNull();
    fireEvent.click(identityTemplate!);

    expect(screen.getByDisplayValue("{{}}")).toBeInTheDocument();

    fireEvent.change(visual, {
      target: {
        value: "{{Heroine}} picks up @",
        selectionStart: "{{Heroine}} picks up @".length,
      },
    });

    const propTemplate = screen.getByText("Prop").closest("button");
    expect(propTemplate).not.toBeNull();
    fireEvent.click(propTemplate!);

    expect(screen.getByDisplayValue("{{Heroine}} picks up [[]]")).toBeInTheDocument();
    fireEvent.change(visual, {
      target: {
        value: "{{Heroine}} picks up [[umbrella]]",
        selectionStart: "{{Heroine}} picks up [[umbrella]]".length,
      },
    });
    fireEvent.blur(visual);

    expect(
      screen.getByDisplayValue("{{Heroine}} picks up [[umbrella]]"),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Heroine/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /umbrella/ })).toBeInTheDocument();
    expect(updateBeat).not.toHaveBeenCalled();
  });

  it("removes standalone prop chips when prop markers are removed from visual text", async () => {
    renderNode(
      makeData({
        displayName: "Shot Context",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "Custom Shot Context",
          visual_description: "{{Kris}} holding a [[umbrella]] and [[black suit]]",
          narration_segment: "",
          detected_identities: ["Kris"],
          detected_props: ["umbrella", "black suit"],
          sketch_colors: {},
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    const visual = screen.getByDisplayValue(
      "{{Kris}} holding a [[umbrella]] and [[black suit]]",
    );
    expect(screen.getByRole("button", { name: /umbrella/ })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /black suit/ }),
    ).toBeInTheDocument();

    fireEvent.change(visual, {
      target: {
        value: "{{Kris}} holding a [[umbrella]]",
        selectionStart: "{{Kris}} holding a [[umbrella]]".length,
      },
    });
    fireEvent.blur(visual);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /umbrella/ })).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /black suit/ }),
      ).not.toBeInTheDocument();
    });
    expect(updateBeat).not.toHaveBeenCalled();
  });

  it("keeps standalone identity options when their chips are toggled off", async () => {
    const user = userEvent.setup();
    renderNode(
      makeData({
        displayName: "Shot Context",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "Custom Shot Context",
          visual_description: "{{Heroine}} picks up [[umbrella]]",
          narration_segment: "",
          detected_identities: ["Heroine"],
          detected_props: ["umbrella"],
          sketch_colors: { "Heroine": "#FF00FF" },
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    const identityChip = screen.getByRole("button", { name: /Heroine/ });
    expect(identityChip).toHaveAttribute("aria-pressed", "true");
    await user.click(identityChip);

    const toggledChip = screen.getByRole("button", { name: /Heroine/ });
    expect(toggledChip).toBeInTheDocument();
    expect(toggledChip).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByDisplayValue("{{Heroine}} picks up [[umbrella]]"),
    ).toBeInTheDocument();
    expect(updateBeat).not.toHaveBeenCalled();
  });

  it("does not restore a toggled-off standalone identity when the visual draft is saved", async () => {
    const user = userEvent.setup();
    renderNode(
      makeData({
        displayName: "Shot Context",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "Custom Shot Context",
          visual_description: "{{Heroine}} picks up [[umbrella]]",
          narration_segment: "",
          detected_identities: ["Heroine"],
          detected_props: ["umbrella"],
          sketch_colors: { "Heroine": "#FF00FF" },
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    await user.click(screen.getByRole("button", { name: /Heroine/ }));
    expect(screen.getByRole("button", { name: /Heroine/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.blur(screen.getByDisplayValue("{{Heroine}} picks up [[umbrella]]"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Heroine/ })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });

  it("shows standalone identity options from visual markers even when not selected", () => {
    renderNode(
      makeData({
        displayName: "Shot Context",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "Custom Shot Context",
          visual_description: "{{Heroine}} picks up [[umbrella]]",
          narration_segment: "",
          detected_identities: [],
          detected_props: [],
          sketch_colors: {},
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    expect(screen.getByRole("button", { name: /Heroine/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: /umbrella/ })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.getByRole("button", { name: "No character appears" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByRole("button", { name: "No prop appears" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("selects the empty standalone identity and prop sentinels when visual markers are absent", async () => {
    const user = userEvent.setup();
    renderNode(
      makeData({
        displayName: "Shot Context",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "Custom Shot Context",
          visual_description: "{{Heroine}} picks up [[umbrella]]",
          narration_segment: "",
          detected_identities: ["Heroine"],
          detected_props: ["umbrella"],
          sketch_colors: {},
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    const visual = screen.getByDisplayValue("{{Heroine}} picks up [[umbrella]]");
    await user.clear(visual);
    await user.type(visual, "empty shot");
    fireEvent.blur(visual);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "No character appears" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "No prop appears" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
    });
  });

  it("allows standalone identity and prop colors to be edited from the round palette", async () => {
    const user = userEvent.setup();
    renderNode(
      makeData({
        displayName: "Shot Context",
        context_scope: "standalone",
        projectId: undefined,
        episode: undefined,
        beat: undefined,
        mainline_context: undefined,
        syncStatus: "fresh",
        beat_context: {
          schema: "beat_context.v1",
          source: "standalone",
          title: "Custom Shot Context",
          visual_description: "{{Heroine}} picks up [[umbrella]]",
          narration_segment: "",
          detected_identities: ["Heroine"],
          detected_props: ["umbrella"],
          sketch_colors: {},
          prop_marker_colors: {},
        },
        snapshot: {},
      }),
    );

    expect(
      document.querySelector('input[type=\"color\"]'),
    ).not.toBeInTheDocument();
    const identityColor = screen.getByLabelText("Identity color Heroine");
    const propColor = screen.getByLabelText("Prop color umbrella");

    await user.click(identityColor);
    const actorCyan = screen.getByRole("button", { name: "Actor colors #00FFFF" });
    expect(actorCyan.closest(".max-h-56.overflow-auto")).toBeNull();
    await user.click(actorCyan);
    expect(identityColor).toHaveStyle({ backgroundColor: "#00FFFF" });

    await user.click(propColor);
    await user.click(screen.getByRole("button", { name: "Prop color #B71C1C" }));
    expect(propColor).toHaveStyle({ backgroundColor: "#B71C1C" });

    expect(updateBeat).not.toHaveBeenCalled();
  });

  it("does not restore stale persisted syncing status as an active refresh", () => {
    renderNode(makeData({ syncStatus: "syncing" }));

    expect(screen.queryByText("Syncing to mainline...")).not.toBeInTheDocument();
    expect(
      screen.getByText("Context is synced; skills use this node."),
    ).toBeInTheDocument();
  });

  it("inserts identity and prop tokens into the local beat context draft", async () => {
    const user = userEvent.setup();
    renderNode();

    const visual = screen.getByDisplayValue("Wide shot, inside the Lanzhou noodle shop.");
    await user.clear(visual);
    await user.type(visual, "Character @");
    const identityMention = (
      await screen.findByText("{{diner_young_man_young_adult}}")
    ).closest("button");
    expect(identityMention).not.toBeNull();

    await user.click(identityMention!);

    expect(updateBeat).not.toHaveBeenCalled();
    expect(
      screen.getByDisplayValue("Character {{diner_young_man_young_adult}}"),
    ).toBeInTheDocument();

    const updatedVisual =
      screen.getByDisplayValue("Character {{diner_young_man_young_adult}}");
    await user.clear(updatedVisual);
    await user.type(updatedVisual, "Prop @");
    const propMention = (await screen.findByText("[[bill]]")).closest("button");
    expect(propMention).not.toBeNull();
    await user.click(propMention!);

    expect(updateBeat).not.toHaveBeenCalled();
    expect(screen.getByDisplayValue("Prop [[bill]]")).toBeInTheDocument();
  });

  it("updates scene and time as local draft fields", async () => {
    const user = userEvent.setup();
    renderNode(
      makeData({
        snapshot: { ...makeData().snapshot, sceneId: "", timeOfDay: "" },
      }),
    );

    await chooseUiSelectOption(user, "Scene", "noodle_shop");
    expect(updateBeat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Scene" })).toHaveTextContent("noodle_shop");

    await chooseUiSelectOption(user, "Time", "Night");
    expect(updateBeat).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Time" })).toHaveTextContent("Night");
  });

  it("preserves scene variant when syncing local beat edits", async () => {
    const user = userEvent.setup();
    const data = makeData({
      snapshot: {
        ...makeData().snapshot,
        sceneId: "noodle_shop",
        sceneVariantId: "rainy_night",
      },
      beat_edit_fields: {
        scene_id: "noodle_shop",
        scene_variant_id: "rainy_night",
      },
    });
    renderNode(data);

    await user.click(screen.getByRole("button", { name: "Sync to mainline" }));

    await waitFor(() => {
      expect(updateBeat).toHaveBeenCalledWith(
        "demo",
        1,
        3,
        expect.objectContaining({
          scene_ref: { scene_id: "noodle_shop", variant_id: "rainy_night" },
        }),
      );
    });
  });

  it("links selected identities to the frame skill after sync without page refresh", async () => {
    const user = userEvent.setup();
    const data = makeData();
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "context_beat",
          type: CANVAS_NODE_TYPES.beatContext,
          position: { x: 0, y: 0 },
          data,
        },
        {
          id: "identity_ref",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: -300, y: 0 },
          data: {
            displayName: "diner_young_man_young_adult",
            mainline_context: [
              {
                kind: "identity",
                identityId: "diner_young_man_young_adult",
                role: "character_identity",
              },
            ],
          },
        },
        {
          id: "skill_frame",
          type: CANVAS_NODE_TYPES.skill,
          position: { x: 300, y: 0 },
          data: {
            displayName: "Frame from context",
            skill_id: "freezone.frame_from_context",
          },
        },
      ],
      [
        {
          id: "edge_context_to_skill_frame",
          source: "context_beat",
          target: "skill_frame",
          sourceHandle: "source",
          targetHandle: "beat_context",
          type: "disconnectableEdge",
          data: {
            edgeKind: "role_binding",
            role: "beat_context",
            propagates: true,
          },
        },
      ],
    );
    listFreezoneBeatContext.mockResolvedValueOnce({
      episodes: [
        {
          episode: 1,
          beats: [
            {
              episode: 1,
              beat: 3,
              label: "EP1 / Beat 3",
              visual_description: "Wide shot, inside the Lanzhou noodle shop.",
              narration_segment: "",
              scene_id: "noodle_shop",
              time_of_day: "night",
              detected_identities: ["diner_young_man_young_adult"],
              detected_props: [],
              sketch_colors: {},
              prop_marker_colors: {},
              assets: [],
            },
          ],
        },
      ],
    });

    renderNode(data);
    await user.click(
      screen.getByRole("button", { name: /diner_young_man_young_adult/ }),
    );

    await waitFor(() => {
      expect(
        useCanvasStore.getState().edges.some((edge) => {
          const edgeData = edge.data as
            | {
                role?: string;
                autoBeatContextProjection?: boolean;
                reference_target?: { identity_id?: string };
              }
            | undefined;
          return (
            edge.source === "identity_ref" &&
            edge.target === "skill_frame" &&
            edge.targetHandle === "identity:diner_young_man_young_adult" &&
            edgeData?.role === "identity" &&
            edgeData.reference_target?.identity_id === "diner_young_man_young_adult" &&
            edgeData.autoBeatContextProjection === true
          );
        }),
      ).toBe(true);
    });
  });

  it("saves identity selection locally and restores the backend preset only after manual sync", async () => {
    const user = userEvent.setup();
    setFreezoneCanvasMetadata({
      preset: {
        scope: "beat",
        episode: 1,
        beat: 3,
        primary_slot: "render",
      },
    });
    const data = makeData();
    getFreezoneCanvas.mockResolvedValueOnce({
      nodes: [],
      edges: [],
      metadata: null,
      revision: "before-restore",
    });
    getFreezoneCanvas.mockResolvedValueOnce({
      nodes: [
        {
          id: "context_beat",
          type: CANVAS_NODE_TYPES.beatContext,
          position: { x: 0, y: 0 },
          data,
        },
        {
          id: "real_identity_ref",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 120, y: 120 },
          data: {
            displayName: "diner_young_woman_young_adult",
            preset_managed: true,
            mainline_context: [
              {
                kind: "identity",
                projectId: "demo",
                identityId: "diner_young_woman_young_adult",
                role: "character_identity",
              },
            ],
          },
        },
      ],
      edges: [],
      metadata: {
        preset: {
          scope: "beat",
          episode: 1,
          beat: 3,
          primary_slot: "render",
        },
      },
    });
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "context_beat",
          type: CANVAS_NODE_TYPES.beatContext,
          position: { x: 0, y: 0 },
          data,
        },
        {
          id: "local_upload",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 800, y: 200 },
          data: {
            displayName: "My temp node",
            imageUrl: "/local.png",
            aspectRatio: "1:1",
            user_spawned: true,
          },
        },
        {
          id: "bad_projection",
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 100, y: 100 },
          data: { displayName: "Wrong projection", autoBeatContextProjection: true },
        },
      ],
      [],
    );

    renderNode(data);
    await user.click(
      screen.getByRole("button", { name: /diner_young_woman_young_adult/ }),
    );

    expect(updateBeat).not.toHaveBeenCalled();
    expect(createCanvasFromPreset).not.toHaveBeenCalled();
    expect(screen.queryByText("Syncing to mainline...")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Sync to mainline" }));

    await waitFor(() => {
      const state = useCanvasStore.getState();
      expect(updateBeat).toHaveBeenCalledWith(
        "demo",
        1,
        3,
        expect.objectContaining({
          detected_identities: ["diner_young_woman_young_adult"],
        }),
      );
      expect(createCanvasFromPreset).toHaveBeenCalledWith(
        "demo",
        expect.objectContaining({
          scope: "beat",
          episode: 1,
          beat: 3,
          canvas_id: "default",
          overwrite_existing: true,
        }),
      );
      expect(state.nodes.some((node) => node.id === "real_identity_ref")).toBe(
        true,
      );
      expect(state.nodes.some((node) => node.id === "local_upload")).toBe(true);
      expect(state.nodes.some((node) => node.id === "bad_projection")).toBe(
        false,
      );
    });
  });
});

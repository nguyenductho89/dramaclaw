// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { BatchBar } from "@/components/episode/beat-workbench/batch-bar";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "zh",
    fallbackLng: "zh",
    interpolation: { escapeValue: false },
    resources: {
      zh: {
        translation: {
          common: {
            cancel: "Cancel",
            confirmExecute: "Confirm execution",
            error: "Errors",
            ok: "OK",
            billingRuleNotConfiguredShort: "Configure",
          },
          episode: {
            script: { identityRequired: "Identity planning required" },
            workbench: {
              batch: {
                rewriteScript: "Rewrite all scripts",
                rewriteScriptTitle: "Rewrite all scripts?",
                rewriteScriptDesc: "Regenerate all beat narrations from source/adapted text. Existing text and sketch stale marks will be affected.",
                genSketch: "Generate Sketches",
                genSketchTitle: "Generate all sketches?",
                genSketchDesc: "Generate sketches for all beats. Existing sketches won't be overwritten; new ones enter the candidate pool.",
                aiOptimize: "Generate all-beat video prompts",
                aiOptimizeTitle: "Generate all-beat video prompts?",
                aiOptimizeDesc: "Use SuperPower to analyze this episode's sketches and generate video prompts for all beats.",
                aiDetect: "AI detect",
                aiDetectTooltip: "AI detect",
                aiDetectRunning: "AI detecting characters...",
                aiDetectEmpty: "AI returned no detections",
                aiDetectSuccess:
                  "AI detect complete: {{beats}} beats, {{ids}} identities, {{props}} props",
                aiDetectReview:
                  "Review each beat; add missing identities or props under More if AI missed anything.",
                reassignColors: "Reassign colors",
                reassignColorsTooltip: "Reassign colors",
                reassignColorsTitle: "Reassign sketch colors?",
                reassignColorsDesc: "Reassign sketch colors?",
                reassignColorsSuccess:
                  "Assigned {{count}} identities, {{propCount}} props",
                insertManualBeforeFirst: "Before first shot",
                insertManualBeforeFirstTooltip: "Before first shot",
                genMissingManualTitle: "Fill missing sketches?",
                genMissingManualDesc: "Batch generate sketches for newly inserted manual shots in this episode that are missing one, grouped by scene.",
                genMissingManual: "Fill sketches",
                genMissingManualTooltip: "Generate sketches for newly inserted manual shots in this episode that are missing one, grouped by scene",
                genMissingManualEmpty: "No manual shots are missing a sketch",
                genMissingManualDispatched:
                  "Dispatched {{count}} manual-shot sketch task(s)",
                genRender: "Render full episode",
                genRenderShort: "All renders",
                genRenderTooltip: "Open full-episode Render Plan (standard generate_grid mode)",
                genAudio: "Generate Audio",
                genAudioTitle: "Generate all audio?",
                genAudioDesc: "Generate TTS voiceover for all beats missing audio.",
                genAudioUnavailableForVideoModel: "The current video model does not need separate full-episode audio generation",
                videoModel: "Video model",
                sketchSettingsLabel: "Sketch settings",
                renderSettingsLabel: "Render settings",
                videoSettingsLabel: "Video settings",
                genVideo: "Generate video",
                genVideoTitle: "Generate video?",
                genVideoDesc: "Generate video clips for all beats missing video. Requires sketches/renders and audio first.",
                narrationIncompatible: "This model only supports dialogue shots ({{count}} narration beats incompatible)",
                globalOptimizeStarted: "Global optimize started",
                selectedCount: "{{count}} beats selected",
                clearSelection: "Clear selection",
                singleRegen: "Single redraw",
                autoCombine: "Batch redraw",
                regenSketchSingleTitle: "Single redraw {{count}} beat sketches?",
                regenSketchSingleDesc: "Split #{{beats}} into 1×1 sketch tasks using the current aspect ratio.",
                dispatched: "Dispatched {{count}} beats → {{mode}}",
                dispatchedBatch: " × {{batches}} batches",
                dispatchFailed: "Dispatch failed",
                sketch: "Sketch",
                sketchGroupRunning: "Matching sketch group is already running",
                sketchGroupSkippedRunning: "Skipped {{count}} running sketch groups",
              },
              video: {
                noteDefault: "Default",
                noteDialogue: "Dialogue shot",
              },
            },
            renderSettings: {
              model: "Model",
              modelPlaceholder: "Choose",
              sketchAspectPadding: "Sketch fit",
            },
            sketchSettings: {
              model: "Sketch model",
              modelPlaceholder: "Select sketch model",
              wide16x9: "16:9",
            },
            renderPlan: {
              dispatched: "Render started",
            },
          },
        },
      },
    },
  });
});

const {
  assignColorsMock,
  detectIdentitiesMock,
  generateMissingManualMock,
  regenerateSketchesMock,
  sketchStartMock,
  toastSuccessMock,
  audioQuoteState,
} = vi.hoisted(() => ({
  assignColorsMock: vi.fn(),
  detectIdentitiesMock: vi.fn(),
  generateMissingManualMock: vi.fn(),
  regenerateSketchesMock: vi.fn(),
  sketchStartMock: vi.fn(),
  toastSuccessMock: vi.fn(),
  audioQuoteState: { prereqErrors: [] as string[] },
}));

vi.mock("@/lib/queries/sketches", () => ({
  useAssignColors: () => ({
    mutateAsync: assignColorsMock,
    isPending: false,
  }),
  useDetectIdentities: () => ({
    mutateAsync: detectIdentitiesMock,
    isPending: false,
  }),
  useGenerateMissingManualSketches: () => ({
    mutateAsync: generateMissingManualMock,
    isPending: false,
  }),
  useRegenerateSketches: () => ({
    mutateAsync: regenerateSketchesMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/sketch-image-usage", () => ({
  useSketchImageUsage: () => ({ data: undefined }),
}));

vi.mock("@/lib/queries/audio", () => ({
  useAudioBillingQuote: () => ({
    data: {
      ok: true,
      data: {
        beat_numbers: [1, 2, 3],
        quantity: 3,
        unit_cost: 6,
        cost: 18,
        display: "18",
        prereq_errors: audioQuoteState.prereqErrors,
      },
    },
    error: null,
  }),
  useGenerateAudio: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/episodes", () => ({
  useEpisodeBeats: () => ({
    data: {
      ok: true,
      data: [
        {
          beat_number: 1,
          narration_segment: "n1",
          visual_description: "v1",
          scene_ref: { scene_id: "store" },
        },
        {
          beat_number: 2,
          narration_segment: "n2",
          visual_description: "v2",
          scene_ref: { scene_id: "store" },
        },
      ],
    },
  }),
  useEpisodeDetail: () => ({
    data: { ok: true, data: { identity_ids: ["Hero_Main"] } },
  }),
}));

vi.mock("@/lib/queries/scripts", () => ({
  useGenerateScript: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/sketch-regen-queue", () => ({
  useSaveSketchRegenQueue: () => ({
    mutate: vi.fn(),
    isPending: false,
  }),
  useSketchRegenQueue: () => ({
    data: { ok: true, data: { items: [] } },
  }),
}));

vi.mock("@/lib/queries/tasks", () => ({
  useTasks: () => ({
    data: { ok: true, data: [] },
  }),
}));

vi.mock("@/lib/queries/video", () => ({
  useGlobalOptimize: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useGlobalOptimizeBillingQuote: () => ({
    data: {
      ok: true,
      data: {
        beat_numbers: [1, 2],
        quantity: 2,
        unit_cost: 6,
        cost: 12,
        display: "12",
      },
    },
  }),
  useVideoBackends: () => ({
    data: {
      ok: true,
      data: [
        {
          value: "seedance",
          label: "Seedance 1.0",
          is_default: true,
          is_seedance2: false,
          dialogue_only: false,
        },
        {
          value: "huimeng_seedance-2.0-fast",
          label: "Seedance 2.0 Fast",
          is_default: false,
          is_seedance2: true,
          dialogue_only: false,
        },
      ],
    },
  }),
}));

vi.mock("@/lib/queries/sketch-settings", () => ({
  useSketchSettings: () => ({
    data: {
      ok: true,
      data: {
        sketch_image_selection: "newapi_gpt_image2",
        options: {},
      },
    },
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({
    data: {
      ok: true,
      data: {
        cost: 5,
        display: "5",
      },
    },
  }),
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: (opts: { key: { taskType: string } }) => ({
    started: false,
    stopping: false,
    stream: { status: "idle" },
    start:
      opts.key.taskType === "sketch_generation" ? sketchStartMock : vi.fn(),
    stop: vi.fn(),
  }),
}));

vi.mock("@/components/episode/beat-workbench/render-settings-controls", () => ({
  RenderModelSelect: () => <div data-testid="render-model-select" />,
  RenderCheckboxes: () => <div data-testid="render-checkboxes" />,
}));

vi.mock("@/components/episode/beat-workbench/sketch-settings-controls", () => ({
  SketchModelSelect: () => <div data-testid="sketch-model-select" />,
  SketchAspectCheckbox: () => <div data-testid="sketch-aspect-checkbox" />,
}));

vi.mock("@/components/episode/beat-workbench/insert-manual-shot-dialog", () => ({
  InsertManualShotDialog: () => null,
}));

vi.mock("@/components/episode/beat-workbench/render-plan-dialog", () => ({
  RenderPlanDialog: () => null,
}));

vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "toast-1"),
    success: toastSuccessMock,
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}));

beforeEach(() => {
  assignColorsMock.mockReset();
  assignColorsMock.mockResolvedValue({
    ok: true,
    data: { count: 1, prop_count: 2 },
  });
  detectIdentitiesMock.mockReset();
  detectIdentitiesMock.mockResolvedValue({
    ok: true,
    data: {
      total_beats: 3,
      total_identities: 2,
      total_props: 1,
      review_message: "Backend review hint",
    },
  });
  generateMissingManualMock.mockReset();
  generateMissingManualMock.mockResolvedValue({
    ok: true,
    task_type: "sketch_generation",
    data: {
      dispatched: 1,
      scopes: ["selected__manual__1-2"],
      segments: [[1, 2]],
    },
  });
  regenerateSketchesMock.mockReset();
  regenerateSketchesMock.mockResolvedValue({
    ok: true,
    scope: "sketch_grid:demo",
  });
  sketchStartMock.mockReset();
  toastSuccessMock.mockReset();
});

const DEFAULT_BEATS = [
  {
    beat_number: 1,
    narration_segment: "n1",
    visual_description: "v1",
    scene_ref: { scene_id: "store" },
    is_manual_shot: true,
    sketch_url: null,
  },
  {
    beat_number: 2,
    narration_segment: "n2",
    visual_description: "v2",
    scene_ref: { scene_id: "store" },
    is_manual_shot: true,
    sketch_url: null,
  },
  {
    beat_number: 3,
    narration_segment: "n3",
    visual_description: "v3",
    scene_ref: { scene_id: "store" },
    audio_type: "narration",
    is_manual_shot: false,
    sketch_url: "/sketch-3.png",
  },
];

describe("BatchBar", () => {
  beforeEach(() => {
    audioQuoteState.prereqErrors = [];
  });

  it("hides whole-episode script rewrite from the batch toolbar", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(
      screen.queryByRole("button", { name: "Rewrite script" }),
    ).not.toBeInTheDocument();
  });

  it("hides whole-episode sketch generation from the batch toolbar", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByRole("button", { name: "Generate Sketches" })).not.toBeInTheDocument();
  });

  it("hides whole-episode render generation from the batch toolbar", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByRole("button", { name: "All renders" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Plan render" })).not.toBeInTheDocument();
  });

  it("does not expose the 0.5K render setting", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByText("0.5K")).not.toBeInTheDocument();
  });

  it("hides whole-beat video prompt generation from the batch toolbar", () => {
    // The narrated drama (narrated) used to be the only place this entry showed up, and now it is not offered there either.
    const { rerender } = render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          spineTemplate="narrated"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(
      screen.queryByRole("button", { name: /Generate all-beat video prompts/ }),
    ).not.toBeInTheDocument();

    rerender(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          spineTemplate="drama"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(
      screen.queryByRole("button", { name: /Generate all-beat video prompts/ }),
    ).not.toBeInTheDocument();
  });

  it("keeps video model and missing-manual sketch actions out of the top batch toolbar", () => {
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    expect(screen.queryByText("Video model")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Fill in missing sketches" })).not.toBeInTheDocument();
  });

  it.each([
    ["narrated" as const, "seedance"],
    ["narrated" as const, "huimeng_seedance-2.0-fast"],
    ["drama" as const, "seedance"],
  ])(
    "hides whole-episode audio from the batch toolbar (%s / %s)",
    (spineTemplate, videoBackend) => {
      render(
        <I18nextProvider i18n={i18n}>
          <BatchBar
            project="demo"
            episode={1}
            beats={DEFAULT_BEATS}
            videoBackend={videoBackend}
            spineTemplate={spineTemplate}
            sketchAspectRatio="2:3"
            onSketchAspectRatioChange={vi.fn()}
          />
        </I18nextProvider>,
      );

      expect(screen.queryByRole("button", { name: "Generate Audio" })).not.toBeInTheDocument();
    },
  );

  it("shows AI detect and reassign color actions in the top batch toolbar", async () => {
    const user = userEvent.setup();
    render(
      <I18nextProvider i18n={i18n}>
        <BatchBar
          project="demo"
          episode={1}
          beats={DEFAULT_BEATS}
          videoBackend="seedance"
          sketchAspectRatio="2:3"
          onSketchAspectRatioChange={vi.fn()}
        />
      </I18nextProvider>,
    );

    const aiDetectButton = screen.getByRole("button", { name: "AI detect" });
    expect(aiDetectButton).toHaveTextContent("5");
    await user.click(aiDetectButton);

    expect(detectIdentitiesMock).toHaveBeenCalledTimes(1);
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "AI detect done: 3 beats, 2 identities, 1 props\nBackend review hint",
      { id: "toast-1" },
    );

    await user.click(screen.getByRole("button", { name: "Reassign colors" }));
    await user.click(screen.getByRole("button", { name: "Confirm execution" }));

    expect(assignColorsMock).toHaveBeenCalledWith({ force: true });
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Assigned 1 identities, 2 props",
    );
  });

});

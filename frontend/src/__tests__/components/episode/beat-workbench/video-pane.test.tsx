// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { toast } from "sonner";

import {
  shouldDisableDialogueOnlyBackendForBeat,
  VideoPane,
} from "@/components/episode/beat-workbench/video-pane";
import { BackendStatusError } from "@/lib/api-errors";
import { useAspectRatioStore } from "@/stores/aspect-ratio-store";
import type { Beat } from "@/types/episode";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "vi",
    fallbackLng: "vi",
    interpolation: { escapeValue: false },
    resources: {
      vi: {
        translation: {
          common: {
            confirm: "Confirm",
            cancel: "Cancel",
            download: "Download",
            regenerate: "Regenerate",
            save: "Save",
            close: "Close",
          },
          episode: {
            workbench: {
              video: {
                started: "Beat #{{n}} video started",
                regenFailed: "Regen failed",
                model: "Model",
                generating: "Generating...",
                genFailed: "Generation failed",
                notGenerated: "Not generated",
                genTitle: "Generate video?",
                genDesc: "References and prompt double-checked. Generate video clip for Beat #{{n}}.",
                regenTitle: "Regenerate video?",
                regenDesc: "Regenerate video clip for Beat #{{n}}.",
                noteDefault: "Default",
                noteDialogue: "Dialogue shot",
                switched: "Beat #{{n}} switched to another version",
                switchFailed: "Switch failed",
                seedance2Prompt: "Seedance2.0 subject prompt",
                seedance2Ready: "Configured",
                seedance2Missing: "Missing",
                seedance2Saved: "Seedance2 config saved",
                seedance2Inspector: "Seedance2 Inspector",
                seedance2PreviewMode: "Seedance2 preview mode",
                mediaStatus: "Media status",
                promptStatus: "Prompt status",
                videoVersions: "Video versions ({{count}})",
                renderReady: "Render",
                audioReady: "Audio",
                videoReady: "Video",
                seedance2References: "References",
                seedance2Voice: "Voice",
                seedance2ReferenceStats: "{{selected}} sent / {{missing}} missing",
                seedance2TextOverlay: "Screen text",
                seedance2AtReferences: "@ refs",
                seedance2MentionCandidates: "Reference candidates",
                seedance2ReferenceDetails: "Reference details",
                seedance2ReferenceSent: "Sent",
                seedance2ReferenceMissing: "Missing",
                seedance2ReferenceFallback: "Missing image",
                seedance2ReferenceImage: "Reference image",
                seedance2ReferenceEmpty: "No references",
                seedance2AssetUpload: "Upload asset",
                seedance2AssetUploaded: "Seedance2 reference uploaded",
                seedance2AssetDelete: "Delete",
                seedance2AssetDeleted: "Seedance2 reference deleted",
                seedance2AssetCrop: "Crop",
                seedance2AssetCropped: "Seedance2 reference cropped",
                seedance2AssetCropTitle: "Crop Seedance2 reference",
                seedance2AssetAudioTrim: "Trim audio",
                seedance2AssetAudioTrimTitle: "Trim Seedance2 reference audio",
                seedance2AssetAudioTrimHint: "Seedance 2.0 works best with a clear single-speaker voice sample of 3-5 seconds.",
                seedance2AssetAudioTrimStart: "Start (s)",
                seedance2AssetAudioTrimDuration: "Duration",
                seedance2AssetAudioTrimApply: "Trim to 3-5 seconds",
                seedance2AssetAudioTrimInvalid: "Invalid trim values",
                seedance2AssetAudioTrimmed: "Seedance2 reference audio trimmed",
                seedance2CropWidth: "Width",
                seedance2CropHeight: "Height",
                seedance2ModeLabels: {
                  first_frame: "First-frame mode",
                  first_last_frame: "First-last-frame mode",
                  multimodal_reference: "Multi-reference mode",
                },
                mode: "Generation mode",
                duration: "Duration",
                resolution: "Resolution",
                ratio: "Aspect",
                generateAudio: "Generate audio",
                returnLastFrame: "Return last frame",
                returnLastFramePending: "Waiting for last frame",
                humanReview: "Human review",
                generateVideo: "Generate video",
                preview: {
                  render: "Render",
                  sketch: "Sketch",
                  audio: "Audio",
                  video: "Video",
                },
                previewMissing: {
                  render: "No render frame",
                  sketch: "No sketch",
                  audio: "No audio",
                  video: "No video",
                },
                seedance2PromptGuidance: "AI writing guidance",
                seedance2GuidanceSubject: "Subject",
                seedance2GuidanceScene: "Scene",
                seedance2GuidanceLighting: "Lighting",
                seedance2GuidanceCamera: "Lens",
                seedance2GuidanceStyle: "Style",
                seedance2GuidanceSubjectTemplate:
                  "Subject: Define the primary character or object, its current action and state, and avoid competing focal subjects.",
                seedance2GuidanceSceneTemplate:
                  "Scene: Describe the spatial background, location relationships, key props, and environmental materials while staying consistent with the references.",
                seedance2GuidanceLightingTemplate:
                  "Lighting: Describe the key light, tonal layers, color temperature, and atmosphere while avoiding unintended flicker.",
                seedance2GuidanceCameraTemplate:
                  "Camera: Specify shot size, viewpoint, movement speed, and direction so the camera move is clear and executable.",
                seedance2GuidanceStyleTemplate:
                  "Style: Define visual texture, period, color direction, and realism to prevent style drift.",
                seedance2GuidanceNoSubtitleTemplate:
                  "No subtitles: Do not generate any text or subtitles; keep the frame visually clean.",
                seedance2SceneOptimizeLabels: {
                  anime: "Anime",
                  realistic: "Realistic",
                },
                seedance2GeneratePrompt: "AI optimize",
                seedance2PromptGenerated: "Seedance2 prompt optimized",
                seedance2SubjectPromptGenerated: "Subject prompt optimized",
                grokVideoInspector: "Grok Video Inspector",
                happyHorseInspector: "HappyHorse Inspector",
                grokPromptLabel: "Grok prompt",
                subjectPromptLabel: "Subject prompt",
                generateGrokPrompt: "Generate Grok prompt",
                generateSubjectPrompt: "Generate subject prompt",
                seedance2CropTitleWithAspect: "Crop {{aspect}}",
                seedance2CropDragHandle: "Move crop area",
                seedance2PromptGeneratedOtherBeat: "Subject prompt optimized and saved back to beat #{{n}}",
                seedance2PromptGenerateFailed: "Seedance2 prompt generation failed",
                videoPrompt: "Video prompt",
                keyframePrompt: "Single-beat video prompt",
                generateBeatVideoPrompt: "Generate this beat prompt",
                beatVideoPromptGenerated: "This beat video prompt generated",
                beatVideoPromptGenerateStarted: "This beat video prompt generation started",
                beatVideoPromptGenerateFailed: "This beat video prompt generation failed",
                beatVideoPromptRequired:
                  "Beat #{{n}} is missing a video prompt. Generate this beat prompt first.",
                seedance2PromptRequired:
                  "Beat #{{n}} is missing the Seedance2.0 main prompt. Fill it in or run AI optimize first.",
                seedance2OverlayEnabled: "Enable",
                seedance2OverlayKind: "Type",
                seedance2OverlayKindAdCopy: "Ad copy",
                seedance2OverlayKindSubtitle: "Subtitle",
                seedance2OverlayKindSpeechBubble: "Speech bubble",
                seedance2OverlayPlacement: "Placement",
                seedance2OverlayTiming: "Timing",
                seedance2OverlayStyle: "Style",
                seedance2OverlayContent: "Text content",
                seedance2OverlaySpeaker: "Speaker",
                seedance2OverlaySpeakerNone: "None",
                narratorVoice: "Narrator voice",
                narratorVoiceReady: "Narrator voice",
                narratorVoiceMissing: "Voice missing",
                narratorVoiceUpload: "Upload",
                narratorVoiceRecord: "Record",
                narratorVoiceProjectAudio: "Project audio",
                narratorVoiceDelete: "Delete",
              },
            },
          },
        },
      },
      en: {
        translation: {
          episode: {
            workbench: {
              video: {
                seedance2GuidanceCamera: "Camera",
                seedance2GuidanceCameraTemplate:
                  "Camera: Specify shot size, viewpoint, movement speed, and direction so the camera move is clear and executable.",
              },
            },
          },
        },
      },
    },
  });
});

const updateBeatMock: Mock = vi.fn();
const regenerateMock: Mock = vi.fn();
const poolSelectMock: Mock = vi.fn();
const taskStartMock: Mock = vi.fn();
const deleteNarratorVoiceMock: Mock = vi.fn();
const generateSeedance2PromptMock: Mock = vi.fn();
const generateBeatVideoPromptMock: Mock = vi.fn();
const cropSeedance2AssetMock: Mock = vi.fn();
const trimSeedance2AssetMock: Mock = vi.fn();
const videoQueryMockState = vi.hoisted(() => ({
  hideReturnedLastFrame: false,
  includeAudioAsset: false,
  seedance2AssetsOverride: null as Array<Record<string, unknown>> | null,
}));

vi.mock("@/lib/queries/video", () => ({
  useGenerateMiniMaxH3Prompt: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRegenerateBeatVideo: () => ({
    mutateAsync: regenerateMock,
    isPending: false,
  }),
  useUploadSeedance2Asset: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteSeedance2Asset: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useCropSeedance2Asset: () => ({
    mutateAsync: cropSeedance2AssetMock,
    isPending: false,
  }),
  useTrimSeedance2Asset: () => ({
    mutateAsync: trimSeedance2AssetMock,
    isPending: false,
  }),
  useVideoBackends: () => ({
    data: {
      ok: true,
      data: [
        {
          value: "newapi_seedance-1.0-pro-fast",
          label: "Seedance 1.0 Pro Fast",
          is_default: true,
          is_seedance2: false,
          dialogue_only: false,
          min_duration: 4,
          max_duration: 12,
        },
        {
          value: "newapi_seedance-1.5-pro",
          label: "Seedance 1.5 Pro",
          is_default: false,
          is_seedance2: false,
          dialogue_only: true,
          min_duration: 4,
          max_duration: 12,
        },
        {
          value: "huimeng_seedance-2.0-fast",
          label: "HuiMeng Seedance 2.0 Fast",
          is_default: false,
          is_seedance2: true,
          dialogue_only: false,
          min_duration: 4,
          max_duration: 15,
        },
        {
          value: "newapi_seedance-2.0-fast",
          label: "Seedance2.0 Fast",
          is_default: false,
          is_seedance2: true,
          dialogue_only: false,
          min_duration: 4,
          max_duration: 15,
        },
        {
          value: "newapi_seedance-2.0",
          label: "Seedance2.0",
          is_default: false,
          is_seedance2: true,
          dialogue_only: false,
          min_duration: 4,
          max_duration: 15,
        },
        {
          value: "newapi_seedance-2.0-value",
          label: "Seedance2.0 Value",
          is_default: false,
          is_seedance2: true,
          dialogue_only: false,
          min_duration: 4,
          max_duration: 15,
        },
        {
          value: "newapi_seedance-2.0-fast-value",
          label: "Seedance2.0 Fast Value",
          is_default: false,
          is_seedance2: true,
          dialogue_only: false,
          min_duration: 4,
          max_duration: 15,
        },
      ],
    },
  }),
  useVideoPool: () => ({
    data: {
      ok: true,
      data: {
        episode: 1,
        beat_assignments: { "1": "vid-2" },
        videos: [
          {
            id: "vid-1",
            beat_num: 1,
            video_path: "old.mp4",
            video_url: "/static/old.mp4",
            generated_at: "2026-05-16T09:00:00Z",
            duration: 5,
            video_mode: "first_frame",
            backend: "newapi_seedance-2.0-fast",
            prompt: "old",
          },
          {
            id: "vid-2",
            beat_num: 1,
            video_path: "new.mp4",
            video_url: "/static/new.mp4",
            generated_at: "2026-05-16T10:00:00Z",
            duration: 5,
            video_mode: "first_frame",
            backend: "newapi_seedance-2.0-fast",
            prompt: "new",
          },
        ],
      },
    },
  }),
  useVideoPoolSelect: () => ({
    mutateAsync: poolSelectMock,
    isPending: false,
  }),
  useNarratorVoiceStatus: () => ({
    data: {
      ok: true,
      data: {
        narration_style: "third_person",
        source: "project_narrator",
        reference_path: "assets/narrator/voice.wav",
        reference_url: "/static/demo/assets/narrator/voice.wav",
        reference_sha256: "sha-voice",
        heading: "Third-person project narration voice",
        detail: "assets/narrator/voice.wav",
        explanation: "Third-person narration uses one project-level voice for every non-dialogue beat.",
        is_first_person: false,
      },
    },
    isLoading: false,
    isError: false,
  }),
  useNarratorVoiceSources: () => ({
    data: {
      ok: true,
      data: {
        options: [
          {
            label: "Audio generated · beat_01.mp3",
            path: "/project/audio/ep001/beat_01.mp3",
            rel_path: "audio/ep001/beat_01.mp3",
          },
        ],
      },
    },
    isLoading: false,
    isError: false,
  }),
  useUploadNarratorVoice: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useRecordNarratorVoice: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useCopyProjectNarratorVoice: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useDeleteNarratorVoice: () => ({
    mutateAsync: deleteNarratorVoiceMock,
    isPending: false,
  }),
  useGenerateSeedance2Prompt: () => ({
    mutateAsync: generateSeedance2PromptMock,
    isPending: false,
  }),
  useGenerateBeatVideoPrompt: () => ({
    mutateAsync: generateBeatVideoPromptMock,
    isPending: false,
  }),
  useSeedance2BeatStatus: () => ({
    data: {
      ok: true,
      data: {
        beat_number: 1,
        audio_type: "dialogue",
        seedance2_config_json: "",
        media: {
          render_ready: true,
          audio_ready: true,
          video_ready: true,
        },
        voice: {
          required: true,
          ready: true,
          label: "Voice ready",
          detail: "Lu Chen_young_adult",
          speaker: "Lu Chen_young_adult",
        },
        prompt: {
          ready: true,
          source: "generated",
          status: "AI generate",
          has_guidance: true,
          text_overlay_enabled: true,
          text_overlay: {
            enabled: true,
            kind: "caption",
            content: "North gate of Deer Town",
            placement: "center",
            timing: "auto",
            style: "white text",
          },
          inputs_stale: false,
        },
        assets: {
          total: 5,
          selected: 4,
          missing: 1,
          images: 3,
          audios: 1,
          fallbacks: 1,
          items: (
            videoQueryMockState.seedance2AssetsOverride ?? [
            {
              key: "first_frame",
              label: "Current render · Beat 1",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "image1",
              note: "Sent as a reference image in multi-reference mode",
              path: "frames/ep001/beat_01.png",
              url: "/static/demo/frames/ep001/beat_01.png",
              crop_source_path: "frames/ep001/beat_01.png",
              can_crop: true,
              can_delete: false,
            },
            {
              key: "manual:image:2",
              label: "Manual asset 2",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "image2",
              note: "Manual reference image",
              path: "seedance2/manual_02.png",
              url: "/static/demo/seedance2/manual_02.png",
              can_crop: true,
              can_delete: true,
            },
            {
              key: "manual:image:3",
              label: "Manual asset 3",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "image3",
              note: "Manual reference image",
              path: "seedance2/manual_03.png",
              url: "/static/demo/seedance2/manual_03.png",
              can_crop: true,
              can_delete: true,
            },
            {
              key: "manual:image:4",
              label: "Manual asset 4",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "image4",
              note: "Manual reference image",
              path: "seedance2/manual_04.png",
              url: "/static/demo/seedance2/manual_04.png",
              can_crop: true,
              can_delete: true,
            },
            {
              key: "manual:image:5",
              label: "Manual asset 5",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "image5",
              note: "Manual reference image",
              path: "seedance2/manual_05.png",
              url: "/static/demo/seedance2/manual_05.png",
              can_crop: true,
              can_delete: true,
            },
            {
              key: "manual:image:6",
              label: "Manual asset 6",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "image6",
              note: "Manual reference image",
              path: "seedance2/manual_06.png",
              url: "/static/demo/seedance2/manual_06.png",
              can_crop: true,
              can_delete: true,
            },
            {
              key: "manual:image:7",
              label: "Manual asset 7",
              media_type: "image",
              selected: true,
              exists: true,
              reference_label: "image7",
              note: "Manual reference image",
              path: "seedance2/manual_07.png",
              url: "/static/demo/seedance2/manual_07.png",
              can_crop: true,
              can_delete: true,
            },
            {
              key: "returned_last_frame",
              label: "Returned last frame · Beat 1",
              media_type: "image",
              selected: false,
              exists: true,
              reference_label: "Last frame",
              note: "Seedance2 returned last frame",
              path: "seedance2/beat_01_last_frame.png",
              url: "/static/demo/seedance2/beat_01_last_frame.png",
              can_crop: false,
              can_delete: false,
            },
            ...(videoQueryMockState.includeAudioAsset
              ? [
                  {
                    key: "voice:narrator",
                    label: "Project narrator voice",
                    media_type: "audio",
                    selected: true,
                    exists: true,
                    reference_label: "Audio 1",
                    note: "Seedance2 narrator reference voice",
                    path: "assets/narrator/voice.mp3",
                    url: "/static/demo/assets/narrator/voice.mp3",
                    abs_path: "/project/assets/narrator/voice.mp3",
                    can_crop: false,
                    can_trim: true,
                    can_delete: false,
                  },
                ]
              : []),
            {
              key: "identity:Lu Chen_young_adult",
              label: "Lu Chen · Young adult",
              media_type: "image",
              selected: false,
              exists: false,
              reference_label: "not_sent",
              note: "Used as the character identity image for consistency when an image exists",
            },
          ]).filter(
            (asset) =>
              !videoQueryMockState.hideReturnedLastFrame ||
              asset.key !== "returned_last_frame",
          ),
        },
      },
    },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/lib/queries/scripts", () => ({
  useUpdateBeat: () => ({
    mutateAsync: updateBeatMock,
    isPending: false,
  }),
}));

vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: (kind: string, value?: string) => ({
    data:
      kind === "feature" && value === "mainline.beat_video_prompt"
        ? { ok: true, data: { cost: 5, display: "5" } }
        : kind === "feature" && value === "mainline.seedance2_prompt"
          ? { ok: true, data: { cost: 6, display: "6" } }
        : kind === "feature" && value === "mainline.beat_video_generation"
          ? { ok: true, data: { cost: 10, display: "10" } }
        : { ok: true, data: { cost: 0, display: null } },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({
    start: taskStartMock,
    started: false,
  }),
}));

vi.mock("@/hooks/use-now", () => ({
  useNow: () => new Date("2026-05-16T10:30:00Z"),
}));

vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

function makeBeat(overrides: Partial<Beat> = {}): Beat {
  return {
    beat_number: 1,
    narration_segment: "Narration",
    visual_description: "Visual",
    audio_type: "narration",
    video_mode: "first_frame",
    detected_identities: ["Lu Chen_young_adult"],
    video_prompt: "base video prompt",
    keyframe_prompt: "",
    frame_url: "/static/frame.png",
    audio_url: "/static/audio.mp3",
    video_url: "/static/new.mp4",
    seedance2_config_json: JSON.stringify({
      mode: "multimodal_reference",
      duration: 5,
      resolution: "720p",
      ratio: "9:16",
      generate_audio: false,
      return_last_frame: false,
      human_review: false,
      prompt_source: "generated",
      final_prompt: "existing seedance2 prompt",
      text_overlay: {
        enabled: false,
        kind: "caption",
        content: "",
        placement: "center",
        timing: "auto",
        style: "",
      },
    }),
    ...overrides,
  };
}

function renderPane(
  beat: Beat = makeBeat(),
  options: { showAudioMediaStatus?: boolean; defaultBackend?: string } = {},
) {
  return render(
    <I18nextProvider i18n={i18n}>
      <VideoPane
        beat={beat}
        project="demo"
        episode={1}
        state="ready"
        defaultBackend={options.defaultBackend ?? "huimeng_seedance-2.0-fast"}
        showAudioMediaStatus={options.showAudioMediaStatus}
      />
    </I18nextProvider>,
  );
}

beforeEach(() => {
  videoQueryMockState.hideReturnedLastFrame = false;
  videoQueryMockState.includeAudioAsset = false;
  videoQueryMockState.seedance2AssetsOverride = null;
  useAspectRatioStore.getState().reset();
  updateBeatMock.mockReset();
  updateBeatMock.mockResolvedValue({ ok: true, data: makeBeat() });
  regenerateMock.mockReset();
  regenerateMock.mockResolvedValue({ ok: true, task_id: "task-1" });
  poolSelectMock.mockReset();
  taskStartMock.mockReset();
  deleteNarratorVoiceMock.mockReset();
  deleteNarratorVoiceMock.mockResolvedValue({ ok: true, data: {} });
  cropSeedance2AssetMock.mockReset();
  cropSeedance2AssetMock.mockResolvedValue({ ok: true, data: {} });
  trimSeedance2AssetMock.mockReset();
  trimSeedance2AssetMock.mockResolvedValue({ ok: true, data: {} });
  generateSeedance2PromptMock.mockReset();
  generateSeedance2PromptMock.mockResolvedValue({
    ok: true,
    data: {
      final_prompt: "optimized seedance2 prompt",
      seedance2_config_json: JSON.stringify({
        mode: "first_frame",
        duration: 5,
        resolution: "720p",
        ratio: "9:16",
        generate_audio: false,
        return_last_frame: false,
        human_review: false,
        prompt_guidance: "more camera motion",
        prompt_source: "generated",
        final_prompt: "optimized seedance2 prompt",
      }),
      beat: makeBeat({
        seedance2_config_json: JSON.stringify({
          prompt_guidance: "more camera motion",
          prompt_source: "generated",
          final_prompt: "optimized seedance2 prompt",
        }),
      }),
    },
  });
  generateBeatVideoPromptMock.mockReset();
  generateBeatVideoPromptMock.mockResolvedValue({
    ok: true,
    data: {
      field: "video_prompt",
      prompt: "generated 1.x motion prompt",
      beat: makeBeat({ video_prompt: "generated 1.x motion prompt" }),
    },
  });
});

async function waitForSeedance2Autosave(times = 1) {
  await waitFor(() => expect(updateBeatMock).toHaveBeenCalledTimes(times), {
    timeout: 2000,
  });
}

function expandSeedance2References() {
  const trigger = screen.getByRole("button", { name: /Reference details/ });
  if (trigger.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(trigger);
  }
}

describe("VideoPane Seedance2 inspector", () => {
  it("renders and saves the 1.x video prompt while showing image-only reference details", () => {
    videoQueryMockState.includeAudioAsset = true;
    renderPane(
      makeBeat({
        video_mode: "first_frame",
        video_prompt: "base video prompt",
      }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );

    expect(screen.queryByText("Seedance2 Inspector")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Video prompt")).toHaveValue("base video prompt");
    expect(screen.getByRole("button", { name: /Reference details/ })).toBeInTheDocument();
    expect(screen.getByText("Current render · Beat 1")).toBeInTheDocument();
    expect(screen.queryByText("Manual asset 2")).not.toBeInTheDocument();
    expect(screen.queryByText("Project narrator voice")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Upload asset" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Generation mode")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Video prompt"), {
      target: { value: "updated motion prompt" },
    });
    fireEvent.blur(screen.getByLabelText("Video prompt"));

    expect(updateBeatMock).toHaveBeenCalledWith({
      beatNum: 1,
      data: { video_prompt: "updated motion prompt" },
    });
  });

  it("uses a 9:16 video-input crop for 1.x when the project aspect is 2:3", async () => {
    const user = userEvent.setup();
    renderPane(
      makeBeat({
        video_mode: "first_frame",
        video_prompt: "base video prompt",
      }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );
    expandSeedance2References();

    await user.click(screen.getAllByRole("button", { name: "Crop" })[0]);

    expect(await screen.findByText("Crop 9:16")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "2:3" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "16:9" })).not.toBeInTheDocument();
  });

  it("generates a single 1.x beat video prompt from the video pane", async () => {
    const user = userEvent.setup();
    renderPane(
      makeBeat({ video_mode: "first_frame", video_prompt: "" }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );

    const promptButton = screen.getByRole("button", {
      name: "Generate this beat prompt",
    });
    expect(promptButton).toHaveTextContent("5");
    await user.click(promptButton);

    expect(generateBeatVideoPromptMock).toHaveBeenCalledWith({ beatNum: 1 });
    expect(screen.getByLabelText("Video prompt")).toHaveValue(
      "generated 1.x motion prompt",
    );
  });

  it("treats async 1.x beat video prompt task startup as success", async () => {
    const user = userEvent.setup();
    generateBeatVideoPromptMock.mockResolvedValueOnce({
      ok: true,
      task_type: "beat_video_prompt",
      task_id: "task-prompt-1",
      task_key: "task:beat_video_prompt:project:proj_123:1:beat:1",
      message: "Ep 1 Beat 1 prompt generation queued",
    });
    renderPane(
      makeBeat({ video_mode: "first_frame", video_prompt: "" }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );

    await user.click(screen.getByRole("button", { name: "Generate this beat prompt" }));

    expect(generateBeatVideoPromptMock).toHaveBeenCalledWith({ beatNum: 1 });
    expect(screen.getByLabelText("Video prompt")).toHaveValue("");
    expect(toast.success).toHaveBeenCalledWith(
      "This beat video prompt generation started",
    );
    expect(toast.error).not.toHaveBeenCalledWith(
      "This beat video prompt generation failed",
    );
  });

  it("shows a missing-media prerequisite without starting task tracking", async () => {
    const user = userEvent.setup();
    const message = "Beat 1 is missing a sketch or first frame, generate a sketch or preview first";
    generateBeatVideoPromptMock.mockRejectedValueOnce(
      new BackendStatusError(message, 409, {
        ok: false,
        code: "VIDEO_PROMPT_PREREQUISITE_REQUIRED",
        error: message,
      }),
    );
    renderPane(
      makeBeat({ video_mode: "first_frame", video_prompt: "" }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );

    await user.click(screen.getByRole("button", { name: "Generate this beat prompt" }));

    expect(toast.error).toHaveBeenCalledWith(message);
    expect(taskStartMock).not.toHaveBeenCalled();
  });

  it("renders keyframe prompt editing for 1.x keyframe beats", () => {
    renderPane(
      makeBeat({
        video_mode: "keyframe",
        video_prompt: "first frame prompt",
        keyframe_prompt: "transition prompt",
      }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );

    expect(screen.getByLabelText("Single-beat video prompt")).toHaveValue(
      "transition prompt",
    );

    fireEvent.change(screen.getByLabelText("Single-beat video prompt"), {
      target: { value: "updated transition prompt" },
    });
    fireEvent.blur(screen.getByLabelText("Single-beat video prompt"));

    expect(updateBeatMock).toHaveBeenCalledWith({
      beatNum: 1,
      data: { keyframe_prompt: "updated transition prompt" },
    });
  });

  it("does not show legacy 1.x prompt controls for Seedance2 backends", () => {
    renderPane(makeBeat());

    expect(screen.getByText("Seedance2 Inspector")).toBeInTheDocument();
    expect(screen.queryByLabelText("Video prompt")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Single-beat video prompt")).not.toBeInTheDocument();
  });

  it("blocks 1.x video generation when the beat video prompt is empty", async () => {
    const user = userEvent.setup();
    renderPane(
      makeBeat({ video_url: null, video_mode: "first_frame", video_prompt: "" }),
      { defaultBackend: "newapi_seedance-1.0-pro-fast" },
    );

    await user.click(screen.getByRole("button", { name: "Regenerate" }));

    expect(toast.error).toHaveBeenCalledWith(
      "Beat #1 is missing a video prompt. Generate this beat prompt first.",
    );
    expect(screen.queryByText("Generate video?")).not.toBeInTheDocument();
    expect(regenerateMock).not.toHaveBeenCalled();
  });

  it("blocks Seedance2 video generation when final prompt is empty", async () => {
    const user = userEvent.setup();
    renderPane(
      makeBeat({
        video_url: null,
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          duration: 5,
          resolution: "720p",
          ratio: "9:16",
          final_prompt: "",
        }),
      }),
    );

    await user.click(screen.getAllByRole("button", { name: "Regenerate" })[0]);

    expect(toast.error).toHaveBeenCalledWith(
      "Beat #1 is missing the Seedance2.0 main prompt. Fill it in or run AI optimize first.",
    );
    expect(screen.queryByText("Generate video?")).not.toBeInTheDocument();
    expect(regenerateMock).not.toHaveBeenCalled();
  });

  it("surfaces backend validation errors for single beat video generation", async () => {
    const user = userEvent.setup();
    regenerateMock.mockResolvedValueOnce({
      ok: false,
      error: "Beat 1 is not dialogue; Seedance 1.5 with audio is only allowed for dialogue beats",
    });
    renderPane();

    await user.click(screen.getAllByRole("button", { name: "Regenerate" })[0]);
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    expect(toast.error).toHaveBeenCalledWith(
      "Beat 1 is not dialogue; Seedance 1.5 with audio is only allowed for dialogue beats",
    );
    expect(taskStartMock).not.toHaveBeenCalled();
  });

  it("saves the current Seedance2 draft before regenerating video", async () => {
    const user = userEvent.setup();
    renderPane();

    fireEvent.change(screen.getByLabelText("Seedance2.0 subject prompt"), {
      target: { value: "draft prompt used for generation" },
    });
    fireEvent.change(screen.getByLabelText("Duration"), {
      target: { value: "8" },
    });
    await user.click(screen.getAllByRole("button", { name: "Regenerate" })[0]);
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(updateBeatMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(regenerateMock).toHaveBeenCalledTimes(1));
    expect(updateBeatMock.mock.invocationCallOrder[0]).toBeLessThan(
      regenerateMock.mock.invocationCallOrder[0],
    );
    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config).toMatchObject({
      final_prompt: "draft prompt used for generation",
      duration: 8,
    });
  });

  it("clamps Seedance2 duration to the selected backend bounds before saving", async () => {
    const user = userEvent.setup();
    renderPane();

    const durationInput = screen.getByLabelText("Duration");
    expect(durationInput).toHaveAttribute("min", "4");
    expect(durationInput).toHaveAttribute("max", "15");

    fireEvent.change(durationInput, {
      target: { value: "3" },
    });
    await user.click(screen.getAllByRole("button", { name: "Regenerate" })[0]);
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(updateBeatMock).toHaveBeenCalledTimes(1));
    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.duration).toBe(4);
  });

  it("disables dialogue-only backends by the current beat audio type", () => {
    const dialogueOnlyBackend = {
      value: "seedance_pro",
      label: "Seedance 1.5 with audio",
      is_default: false,
      is_seedance2: false,
      dialogue_only: true,
    };

    expect(
      shouldDisableDialogueOnlyBackendForBeat(
        dialogueOnlyBackend,
        makeBeat({ audio_type: "dialogue" }),
      ),
    ).toBe(false);
    expect(
      shouldDisableDialogueOnlyBackendForBeat(
        dialogueOnlyBackend,
        makeBeat({ audio_type: "narration" }),
      ),
    ).toBe(true);
  });

  it("renders Seedance2 media, config, and version status", () => {
    renderPane();

    expect(screen.getByText("Seedance2 Inspector")).toBeInTheDocument();
    expect(screen.queryByText("Media status")).not.toBeInTheDocument();
    expect(screen.queryByText("Prompt status")).not.toBeInTheDocument();
    expect(screen.queryByText("Config status")).not.toBeInTheDocument();
    expect(screen.getByText("Video versions (2)")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Reference details/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(screen.getByText("image1")).toBeInTheDocument();
    expect(screen.getByText("Manual asset 7")).toBeInTheDocument();
    expect(screen.getByText("Current render · Beat 1")).toBeInTheDocument();
    expect(screen.getByText("Lu Chen · Young adult")).toBeInTheDocument();
    expect(screen.getByText("Used as the character identity image for consistency when an image exists")).toBeInTheDocument();
    expect(screen.getByText("Reference image")).toBeInTheDocument();
    expect(screen.getByText("Missing image")).toBeInTheDocument();
    expect(screen.queryByText("not_sent")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Upload asset" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Insert reference" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Crop" }).length).toBeGreaterThan(0);
    expect(screen.getByText("Voice ready")).toBeInTheDocument();
    expect(screen.getAllByText("4 sent / 1 missing").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Screen text" })).not.toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: "Seedance2 preview mode" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Audio" })).not.toBeInTheDocument();
    expect(screen.getAllByText("Render").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Configured").length).toBeGreaterThan(0);
  });

  it("renders a single Seedance2 video generation action", () => {
    renderPane(makeBeat({ beat_number: 2, video_url: null }));

    expect(screen.getAllByRole("button", { name: "Generate video" })).toHaveLength(1);
  });

  it("shows image thumbnails in the Seedance2 reference details", () => {
    renderPane();
    expandSeedance2References();

    expect(screen.getByAltText("Current render · Beat 1")).toHaveAttribute(
      "src",
      "/static/demo/frames/ep001/beat_01.png",
    );
    expect(screen.getByAltText("Manual asset 2")).toHaveAttribute(
      "src",
      "/static/demo/seedance2/manual_02.png",
    );
    expect(
      screen.getByAltText("Manual asset 2").closest("[data-seedance2-reference-tile]"),
    ).toHaveClass("aspect-square", "w-[6.75rem]");
    expect(
      screen.getByAltText("Manual asset 2").closest("[data-seedance2-reference-tile]")?.parentElement,
    ).toHaveClass("grid-cols-[repeat(auto-fill,minmax(6.75rem,6.75rem))]");
    expect(screen.getByAltText("Manual asset 2")).toHaveClass("object-cover");
  });

  it("hides the audio media status when disabled for drama projects", () => {
    renderPane(makeBeat(), { showAudioMediaStatus: false });

    expect(screen.getAllByText("Render").length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Audio" })).not.toBeInTheDocument();
  });

  it("shows readable backend labels on video version thumbnails", () => {
    renderPane();

    expect(screen.getAllByText("Seedance2.0 Fast").length).toBeGreaterThan(0);
    expect(screen.queryByText("newapi_seedance-2.0-fast")).not.toBeInTheDocument();
  });

  it("shows scene optimize styles only for Seedance2 value models", async () => {
    const user = userEvent.setup();
    renderPane(makeBeat({ seedance2_config_json: "" }), {
      defaultBackend: "newapi_seedance-2.0-value",
    });

    expect(screen.getByRole("radiogroup", { name: "Style" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Anime" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await user.click(screen.getByRole("radio", { name: "Realistic" }));
    await waitForSeedance2Autosave();

    const payload =
      updateBeatMock.mock.calls[updateBeatMock.mock.calls.length - 1][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.scene_optimize).toBe("realistic");
  });

  it("uses model-specific Seedance2 resolution options", async () => {
    const user = userEvent.setup();
    renderPane(makeBeat({ seedance2_config_json: "" }), {
      defaultBackend: "newapi_seedance-2.0",
    });

    await user.click(screen.getByRole("combobox", { name: "Resolution" }));
    expect(await screen.findByRole("option", { name: "480p" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "720p" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "1080p" })).toBeInTheDocument();
  });

  it("hides unsupported Seedance2 value resolution options", async () => {
    const user = userEvent.setup();
    renderPane(makeBeat({ seedance2_config_json: "" }), {
      defaultBackend: "newapi_seedance-2.0-value",
    });

    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Anime" })).toHaveAttribute(
        "aria-checked",
        "true",
      ),
    );
    await user.click(screen.getByLabelText("Resolution"));
    expect(await screen.findByRole("option", { name: "720p" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "480p" })).not.toBeInTheDocument();
    expect(screen.getByRole("option", { name: "1080p" })).toBeInTheDocument();
  });

  it("normalizes unsupported saved Seedance2 value resolution", async () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          resolution: "480p",
          final_prompt: "existing seedance2 prompt",
        }),
      }),
      { defaultBackend: "newapi_seedance-2.0-value" },
    );

    await waitForSeedance2Autosave();

    const payload =
      updateBeatMock.mock.calls[updateBeatMock.mock.calls.length - 1][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.resolution).toBe("720p");
  });

  it("normalizes Seedance2 resolution before generation after backend switches", async () => {
    const user = userEvent.setup();
    const beat = makeBeat({
      seedance2_config_json: JSON.stringify({
        mode: "multimodal_reference",
        duration: 5,
        resolution: "1080p",
        ratio: "9:16",
        final_prompt: "existing seedance2 prompt",
      }),
    });
    const view = renderPane(beat, {
      defaultBackend: "newapi_seedance-2.0",
    });

    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VideoPane
          beat={beat}
          project="demo"
          episode={1}
          state="ready"
          defaultBackend="newapi_seedance-2.0-fast"
        />
      </I18nextProvider>,
    );
    await user.click(screen.getAllByRole("button", { name: "Regenerate" })[0]);
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(regenerateMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(updateBeatMock).toHaveBeenCalled());
    const saveBeforeRegenerateIndex = updateBeatMock.mock.invocationCallOrder.findIndex(
      (order) => order < regenerateMock.mock.invocationCallOrder[0],
    );
    expect(saveBeforeRegenerateIndex).toBeGreaterThanOrEqual(0);
    const payload = updateBeatMock.mock.calls[saveBeforeRegenerateIndex][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.resolution).toBe("720p");
    expect(updateBeatMock.mock.invocationCallOrder[saveBeforeRegenerateIndex]).toBeLessThan(
      regenerateMock.mock.invocationCallOrder[0],
    );
  });

  it("hides scene optimize styles for non-value Seedance2 models", () => {
    renderPane();

    expect(screen.queryByRole("radiogroup", { name: "Style" })).not.toBeInTheDocument();
  });

  it("does not expose raw Seedance2 mode names in the Seedance2 controls", () => {
    renderPane();

    expect(screen.getAllByText("Configured").length).toBeGreaterThan(0);
    expect(screen.getByLabelText("Generation mode")).toHaveTextContent("Multi-reference mode");
    expect(screen.queryByText("multimodal_reference")).not.toBeInTheDocument();
  });

  it("uses first-generation confirmation copy when the beat has no video", async () => {
    const user = userEvent.setup();
    renderPane(makeBeat({ beat_number: 2, video_url: null }));

    await user.click(screen.getAllByRole("button", { name: "Generate video" })[0]);

    expect(screen.getByText("Generate video?")).toBeInTheDocument();
    expect(
      screen.getByText("References and prompt double-checked. Generate video clip for Beat #2."),
    ).toBeInTheDocument();
    expect(screen.queryByText("Regenerate video?")).not.toBeInTheDocument();
  });

  it("uses the Seedance2 configured ratio for multimodal image asset crops", async () => {
    const user = userEvent.setup();
    useAspectRatioStore.getState().setOrientation("demo", "landscape");
    renderPane();
    expandSeedance2References();

    await user.click(screen.getAllByRole("button", { name: "Crop" })[0]);
    expect(await screen.findByText("Crop 9:16")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "16:9" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("X")).not.toBeInTheDocument();

    const image = screen
      .getAllByAltText("Current render · Beat 1")
      .find((element) => element.closest('[role="dialog"]'));
    if (!image) throw new Error("crop image not found");
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 569,
    });
    Object.defineProperty(image, "naturalHeight", {
      configurable: true,
      value: 839,
    });
    fireEvent.load(image);

    await waitFor(() => {
      expect(screen.getByLabelText("Move crop area")).toHaveStyle({
        left: "8.611599297012302%",
        top: "0%",
        width: "82.95254833040421%",
        height: "100%",
      });
    });

    const cropButtons = screen.getAllByRole("button", { name: "Crop" });
    await user.click(cropButtons[cropButtons.length - 1]);
    expect(cropSeedance2AssetMock).toHaveBeenCalledWith({
      beatNum: 1,
      assetKey: "first_frame",
      sourcePath: "frames/ep001/beat_01.png",
      target: "reference_image",
      crop: { x: 49, y: 0, width: 472, height: 839 },
    });
  });

  it("uses the configured output ratio for first-frame Seedance2 crops", async () => {
    const user = userEvent.setup();
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "first_frame",
          mode_user_set: true,
          final_prompt: "wide video prompt",
          ratio: "16:9",
        }),
      }),
    );
    expandSeedance2References();

    await user.click(screen.getAllByRole("button", { name: "Crop" })[0]);
    expect(await screen.findByText("Crop 16:9")).toBeInTheDocument();

    const image = screen
      .getAllByAltText("Current render · Beat 1")
      .find((element) => element.closest('[role="dialog"]'));
    if (!image) throw new Error("crop image not found");
    Object.defineProperty(image, "naturalWidth", {
      configurable: true,
      value: 569,
    });
    Object.defineProperty(image, "naturalHeight", {
      configurable: true,
      value: 839,
    });
    fireEvent.load(image);

    await waitFor(() => {
      expect(screen.getByLabelText("Move crop area")).toHaveStyle({
        left: "0%",
        top: "30.870083432657925%",
        width: "100%",
        height: "38.14064362336114%",
      });
    });

    const cropButtons = screen.getAllByRole("button", { name: "Crop" });
    await user.click(cropButtons[cropButtons.length - 1]);
    expect(cropSeedance2AssetMock).toHaveBeenCalledWith({
      beatNum: 1,
      assetKey: "first_frame",
      sourcePath: "frames/ep001/beat_01.png",
      target: "first_frame",
      crop: { x: 0, y: 259, width: 569, height: 320 },
    });
  });

  it("keeps using the original render as crop source after a video-input override exists", async () => {
    const user = userEvent.setup();
    videoQueryMockState.seedance2AssetsOverride = [
      {
        key: "first_frame",
        label: "Current render · Beat 1",
        media_type: "image",
        selected: true,
        exists: true,
        reference_label: "image1",
        note: "First-frame mode sends only this one first-frame image and does not mix in reference images.",
        path: "video_inputs/ep001/beat_01/first_frame.png",
        url: "/static/demo/video_inputs/ep001/beat_01/first_frame.png",
        abs_path: "/project/video_inputs/ep001/beat_01/first_frame.png",
        crop_source_path: "frames/ep001/beat_01.png",
        crop_source_abs_path: "/project/frames/ep001/beat_01.png",
        crop_source_url: "/static/demo/frames/ep001/beat_01.png",
        can_crop: true,
        can_delete: false,
      },
    ];
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "first_frame",
          mode_user_set: true,
          final_prompt: "wide video prompt",
        }),
      }),
    );
    expandSeedance2References();

    await user.click(screen.getAllByRole("button", { name: "Crop" })[0]);
    await screen.findByRole("dialog");
    const cropImage = screen
      .getAllByAltText("Current render · Beat 1")
      .find((element) => element.closest('[role="dialog"]'));
    if (!cropImage) throw new Error("crop image not found");
    expect(cropImage).toHaveAttribute("src", "/static/demo/frames/ep001/beat_01.png");
    const cropButtons = await screen.findAllByRole("button", { name: "Crop" });
    await user.click(cropButtons[cropButtons.length - 1]);

    expect(cropSeedance2AssetMock).toHaveBeenCalledWith(
      expect.objectContaining({
        assetKey: "first_frame",
        target: "first_frame",
        sourcePath: "/project/frames/ep001/beat_01.png",
      }),
    );
  });

  it("does not override the configured first-frame crop ratio with the project aspect", async () => {
    const user = userEvent.setup();
    useAspectRatioStore.getState().setOrientation("demo", "landscape");
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "first_frame",
          mode_user_set: true,
          final_prompt: "wide video prompt",
          ratio: "9:16",
        }),
      }),
    );
    expandSeedance2References();

    await user.click(screen.getAllByRole("button", { name: "Crop" })[0]);
    expect(await screen.findByText("Crop 9:16")).toBeInTheDocument();
  });

  it("allows trimming Seedance2 audio reference assets", async () => {
    const user = userEvent.setup();
    videoQueryMockState.includeAudioAsset = true;
    renderPane();
    expandSeedance2References();

    const audioTile = screen
      .getByText("Project narrator voice")
      .closest("[data-seedance2-reference-tile]");
    if (!audioTile) throw new Error("audio tile not found");
    await user.click(within(audioTile as HTMLElement).getByRole("button", { name: "Crop" }));
    await user.click(screen.getByRole("button", { name: "Trim to 3-5 seconds" }));

    expect(trimSeedance2AssetMock).toHaveBeenCalledWith({
      beatNum: 1,
      assetKey: "voice:narrator",
      sourcePath: "/project/assets/narrator/voice.mp3",
      startSeconds: 0,
      durationSeconds: 4,
    });
  });

  it("autosaves prompt and basic Seedance2 config as one JSON patch", async () => {
    renderPane();

    fireEvent.change(screen.getByLabelText("Seedance2.0 subject prompt"), {
      target: { value: "new seedance2 prompt" },
    });
    fireEvent.change(screen.getByLabelText("Duration"), {
      target: { value: "8" },
    });
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    expect(payload.beatNum).toBe(1);
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config).toMatchObject({
      final_prompt: "new seedance2 prompt",
      duration: 8,
      generate_audio: true,
      generate_audio_user_set: false,
      human_review: true,
      mode: "multimodal_reference",
      resolution: "720p",
      ratio: "9:16",
    });
    expect(screen.queryByRole("checkbox", { name: "Generate audio" })).not.toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "Human review" })).not.toBeInTheDocument();
  });

  it("autosave keeps the trailing space left by an inserted @mention", async () => {
    renderPane(makeBeat({ seedance2_config_json: "" }));

    fireEvent.change(screen.getByLabelText("Seedance2.0 subject prompt"), {
      target: { value: "@image1 @image2 " },
    });
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    // The trailing separator must survive the save → re-parse → draft-reset
    // round-trip, otherwise the next reference glues onto the last one.
    expect(config.final_prompt).toBe("@image1 @image2 ");
  });

  it("defaults new Seedance2 drafts to the project render aspect", async () => {
    useAspectRatioStore.getState().setOrientation("demo", "landscape");
    renderPane(makeBeat({ seedance2_config_json: "" }));

    fireEvent.change(screen.getByLabelText("Seedance2.0 subject prompt"), {
      target: { value: "new landscape prompt" },
    });
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.ratio).toBe("16:9");
  });

  it("inserts the highlighted @ mention candidate when pressing Enter", async () => {
    renderPane();
    const textarea = (await screen.findByLabelText(
      "Seedance2.0 subject prompt",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "@" } });
    expect(await screen.findByText("Reference candidates")).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    await waitFor(() => expect(textarea.value).toContain("@image1"));
  });

  it("navigates @ mention candidates with arrows and inserts on Tab", async () => {
    renderPane();
    const textarea = (await screen.findByLabelText(
      "Seedance2.0 subject prompt",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "@" } });
    expect(await screen.findByText("Reference candidates")).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    fireEvent.keyDown(textarea, { key: "Tab" });
    await waitFor(() => expect(textarea.value).toContain("@image2"));
  });

  it("keeps already-inserted references available in the @ mention dropdown", async () => {
    renderPane();
    const textarea = (await screen.findByLabelText(
      "Seedance2.0 subject prompt",
    )) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "@image1 @" } });
    expect(await screen.findByText("Reference candidates")).toBeInTheDocument();
    fireEvent.keyDown(textarea, { key: "Enter" });
    // Selecting a mention appends a trailing space so the next keystroke can't
    // glue onto it.
    await waitFor(() => expect(textarea.value).toBe("@image1 @image1 "));
  });

  it("normalizes legacy unmarked first_frame Seedance2 configs to the NiceGUI multimodal default", async () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "first_frame",
          final_prompt: "legacy prompt",
        }),
      }),
    );

    fireEvent.change(screen.getByLabelText("Seedance2.0 subject prompt"), {
      target: { value: "legacy prompt updated" },
    });
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.mode).toBe("multimodal_reference");
  });

  it("persists legacy unmarked first_frame configs so status assets use multimodal mode", async () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "first_frame",
          final_prompt: "legacy prompt",
        }),
      }),
    );

    await waitFor(() => expect(updateBeatMock).toHaveBeenCalledTimes(1));
    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.mode).toBe("multimodal_reference");
    expect(config.mode_user_set).toBe(false);
  });

  it("persists legacy React-forced Seedance2 audio-off configs back to the NiceGUI audio default", async () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          generate_audio: false,
          generate_audio_user_set: true,
          final_prompt: "legacy adapter-forced audio-off prompt",
        }),
      }),
    );

    await waitFor(() => expect(updateBeatMock).toHaveBeenCalledTimes(1));
    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.generate_audio).toBe(true);
    expect(config.generate_audio_user_set).toBe(false);
  });

  it("autosaves Seedance2 mode changes so reference assets refresh by mode", async () => {
    const user = userEvent.setup();
    renderPane();

    const modeTrigger = screen.getByLabelText("Generation mode");
    expect(modeTrigger).toHaveTextContent("Multi-reference mode");
    expect(modeTrigger).not.toHaveTextContent("multimodal_reference");
    await user.click(modeTrigger);
    expect(await screen.findByRole("option", { name: "First-frame mode" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "First-last-frame mode" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Multi-reference mode" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "first_last_frame" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "First-last-frame mode" }));
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.mode).toBe("first_last_frame");
    expect(config.mode_user_set).toBe(true);
  });

  it("does not render manual Seedance2 save actions", () => {
    renderPane();

    expect(screen.queryByRole("button", { name: "Save config" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Save prompt" })).not.toBeInTheDocument();
  });

  it("keeps Seedance2 API audio generation enabled by default", async () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          generate_audio: false,
          generate_audio_user_set: true,
          final_prompt: "legacy adapter-forced audio-off prompt",
        }),
      }),
    );

    fireEvent.change(screen.getByLabelText("Seedance2.0 subject prompt"), {
      target: { value: "seedance2 prompt with generated audio" },
    });
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.generate_audio).toBe(true);
    expect(config.generate_audio_user_set).toBe(false);
  });

  it("shows and downloads the returned last frame when enabled", () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          duration: 5,
          resolution: "720p",
          ratio: "9:16",
          generate_audio: false,
          return_last_frame: true,
          human_review: false,
          final_prompt: "existing seedance2 prompt",
        }),
      }),
    );

    const image = screen
      .getAllByAltText("Returned last frame · Beat 1")
      .find((element) => element.closest("[data-seedance2-returned-last-frame]"));
    if (!image) throw new Error("returned last frame image not found");
    const panel = image.closest("[data-seedance2-returned-last-frame]");

    expect(image).toHaveAttribute(
      "src",
      "/static/demo/seedance2/beat_01_last_frame.png",
    );
    expect(panel).toBeTruthy();
    expect(within(panel as HTMLElement).getByRole("link", { name: "Download" })).toHaveAttribute(
      "href",
      "/static/demo/seedance2/beat_01_last_frame.png",
    );
  });

  it("shows a returned last frame image box before the image is ready", () => {
    videoQueryMockState.hideReturnedLastFrame = true;

    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          duration: 5,
          resolution: "720p",
          ratio: "9:16",
          generate_audio: false,
          return_last_frame: true,
          human_review: false,
          final_prompt: "existing seedance2 prompt",
        }),
      }),
    );

    const panel = screen.getByTestId("seedance2-returned-last-frame-panel");
    const box = screen.getByTestId("seedance2-returned-last-frame-box");
    expect(panel).toBeInTheDocument();
    expect(panel).toHaveClass("w-fit", "max-w-full");
    expect(box).toHaveClass("w-[7.5rem]", "max-w-full");
    expect(box).toHaveStyle({ aspectRatio: "9 / 16" });
    expect(within(panel).getByText("Waiting for last frame")).toBeInTheDocument();
    expect(within(panel).queryByRole("link", { name: "Download" })).not.toBeInTheDocument();
  });

  it("opens Seedance2 mention candidates when typing @ and inserts the selected reference", async () => {
    const user = userEvent.setup();
    renderPane();

    fireEvent.change(screen.getByLabelText("Seedance2.0 subject prompt"), {
      target: { value: "Camera pushes in @" },
    });
    expect(screen.getByText("Reference candidates")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "@image1" }));

    expect(screen.getByLabelText("Seedance2.0 subject prompt")).toHaveValue("Camera pushes in @image1 ");
  });

  it("appends a space when picking consecutive references via the popover", async () => {
    const user = userEvent.setup();
    renderPane();
    const textarea = screen.getByLabelText(
      "Seedance2.0 subject prompt",
    ) as HTMLTextAreaElement;

    fireEvent.change(textarea, { target: { value: "@" } });
    await user.click(screen.getByRole("button", { name: "@image1" }));
    expect(textarea).toHaveValue("@image1 ");

    fireEvent.change(textarea, { target: { value: "@image1 @" } });
    await user.click(screen.getByRole("button", { name: "@image2" }));
    expect(textarea).toHaveValue("@image1 @image2 ");
  });

  it("keeps a space after every popover pick when typing @ between them", async () => {
    const user = userEvent.setup();
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          final_prompt: "",
        }),
      }),
    );
    const textarea = screen.getByLabelText(
      "Seedance2.0 subject prompt",
    ) as HTMLTextAreaElement;

    await user.click(textarea);
    await user.type(textarea, "@");
    await user.click(screen.getByRole("button", { name: "@image1" }));
    await user.type(textarea, "@");
    await user.click(screen.getByRole("button", { name: "@image2" }));

    expect(textarea.value).toBe("@image1 @image2 ");
  });

  it("inserts an @ reference when dragging a reference image into the prompt editor", () => {
    renderPane();
    expandSeedance2References();
    const image = screen.getByAltText("Manual asset 2");
    const textarea = screen.getByLabelText("Seedance2.0 subject prompt");
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      effectAllowed: "",
      dropEffect: "",
    };

    fireEvent.dragStart(image, { dataTransfer });
    fireEvent.drop(textarea, { dataTransfer });

    expect(textarea).toHaveValue("existing seedance2 prompt\n@image2 ");
  });

  it("makes uploaded image and audio reference tiles draggable", () => {
    videoQueryMockState.includeAudioAsset = true;
    renderPane();
    expandSeedance2References();
    const imageTile = screen
      .getByText("Manual asset 2")
      .closest("[data-seedance2-reference-tile]");
    const audioTile = screen
      .getByText("Project narrator voice")
      .closest("[data-seedance2-reference-tile]");
    if (!imageTile) throw new Error("image tile not found");
    if (!audioTile) throw new Error("audio tile not found");
    const textarea = screen.getByLabelText("Seedance2.0 subject prompt");
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      effectAllowed: "",
      dropEffect: "",
    };

    expect(imageTile).toHaveAttribute("draggable", "true");
    expect(audioTile).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(audioTile, { dataTransfer });
    fireEvent.drop(textarea, { dataTransfer });

    expect(textarea).toHaveValue("existing seedance2 prompt\n@audio1 ");
  });

  it("inserts a dragged @ reference at the prompt cursor position", () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          final_prompt: "Reference as the starting composition",
        }),
      }),
    );
    expandSeedance2References();
    const image = screen.getByAltText("Manual asset 2");
    const textarea = screen.getByLabelText("Seedance2.0 subject prompt") as HTMLTextAreaElement;
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      effectAllowed: "",
      dropEffect: "",
    };

    textarea.focus();
    textarea.setSelectionRange(9, 9);
    fireEvent.dragStart(image, { dataTransfer });
    fireEvent.drop(textarea, { dataTransfer });

    expect(textarea).toHaveValue("Reference@image2  as the starting composition");
  });

  it("uses the prompt cursor position from before dragging the image tile steals focus", () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          final_prompt: "Reference as the starting composition",
        }),
      }),
    );
    expandSeedance2References();
    const image = screen.getByAltText("Manual asset 2");
    const textarea = screen.getByLabelText("Seedance2.0 subject prompt") as HTMLTextAreaElement;
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      effectAllowed: "",
      dropEffect: "",
    };

    textarea.focus();
    textarea.setSelectionRange(9, 9);
    fireEvent.select(textarea);
    fireEvent.blur(textarea);
    fireEvent.dragStart(image, { dataTransfer });
    fireEvent.drop(textarea, { dataTransfer });

    expect(textarea).toHaveValue("Reference@image2  as the starting composition");
  });

  it("inserts a dragged reference even when the prompt already mentions it", () => {
    renderPane();
    expandSeedance2References();
    const image = screen.getByAltText("Manual asset 2");
    const textarea = screen.getByLabelText("Seedance2.0 subject prompt");
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      effectAllowed: "",
      dropEffect: "",
    };

    fireEvent.change(textarea, { target: { value: "Existing @image2" } });
    fireEvent.dragStart(image, { dataTransfer });
    fireEvent.drop(textarea, { dataTransfer });

    expect(textarea).toHaveValue("Existing @image2 @image2 ");
  });

  it("accepts browser image drags whose dragover data lacks the custom reference type", () => {
    renderPane();
    const textarea = screen.getByLabelText("Seedance2.0 subject prompt");
    const dataTransfer = {
      types: ["text/plain"],
      getData: vi.fn((type: string) => (type === "text/plain" ? "@image2" : "")),
      dropEffect: "",
    };

    expect(fireEvent.dragOver(textarea, { dataTransfer })).toBe(false);
    fireEvent.drop(textarea, { dataTransfer });

    expect(textarea).toHaveValue("existing seedance2 prompt\n@image2 ");
  });

  it("hides screen text overlay controls and disables stale overlay config on save", async () => {
    renderPane(
      makeBeat({
        seedance2_config_json: JSON.stringify({
          final_prompt: "existing seedance2 prompt",
          text_overlay: {
            enabled: true,
            kind: "speech_bubble",
            content: "North gate of Deer Town",
            placement: "bottom center",
            timing: "throughout the clip",
            style: "clean and readable",
            speaker: "Lu Chen_young_adult",
          },
        }),
      }),
    );

    expect(screen.queryByRole("button", { name: "Screen text" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Text content")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Seedance2.0 subject prompt"), {
      target: { value: "updated seedance2 prompt" },
    });
    await waitForSeedance2Autosave();

    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.text_overlay).toMatchObject({
      enabled: false,
      kind: "speech_bubble",
      content: "North gate of Deer Town",
      placement: "bottom center",
      timing: "throughout the clip",
      style: "clean and readable",
      speaker: "Lu Chen_young_adult",
    });
  });

  it("generates Seedance2 final prompt from the current draft and guidance", async () => {
    const user = userEvent.setup();
    renderPane();

    fireEvent.change(screen.getByLabelText("AI writing guidance"), {
      target: { value: "more camera motion" },
    });
    fireEvent.change(screen.getByLabelText("Seedance2.0 subject prompt"), {
      target: { value: "manual reference prompt" },
    });
    const optimizeButton = screen.getByRole("button", { name: "AI optimize" });
    expect(optimizeButton).toHaveTextContent("6");
    await user.click(optimizeButton);

    expect(generateSeedance2PromptMock).toHaveBeenCalledTimes(1);
    expect(generateSeedance2PromptMock).toHaveBeenCalledWith({
      beatNum: 1,
      manualPromptReference: "manual reference prompt",
      promptGuidance: "more camera motion",
      promptGuidanceTemplateKeys: [],
    });
    expect(screen.getByLabelText("Seedance2.0 subject prompt")).toHaveValue(
      "optimized seedance2 prompt",
    );
  });

  it("does not write an AI-optimized prompt onto the beat switched to mid-flight", async () => {
    const user = userEvent.setup();
    // Hold the optimize request open so we can switch beats before it resolves.
    let resolveOptimize: (value: unknown) => void = () => {};
    const deferred = new Promise((resolve) => {
      resolveOptimize = resolve;
    });
    generateSeedance2PromptMock.mockReturnValueOnce(deferred);

    const beatA = makeBeat({ beat_number: 1 });
    const beatB = makeBeat({
      beat_number: 2,
      seedance2_config_json: JSON.stringify({
        mode: "multimodal_reference",
        duration: 5,
        resolution: "720p",
        ratio: "9:16",
        final_prompt: "beat two prompt",
      }),
    });
    const view = renderPane(beatA);

    // Trigger AI optimize on Beat A (request now pending).
    await user.click(screen.getByRole("button", { name: "AI optimize" }));
    expect(generateSeedance2PromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ beatNum: 1 }),
    );

    // User switches to Beat B while the optimize request is still in flight.
    view.rerender(
      <I18nextProvider i18n={i18n}>
        <VideoPane
          beat={beatB}
          project="demo"
          episode={1}
          state="ready"
          defaultBackend="huimeng_seedance-2.0-fast"
        />
      </I18nextProvider>,
    );
    expect(screen.getByLabelText("Seedance2.0 subject prompt")).toHaveValue(
      "beat two prompt",
    );

    // The optimize result for Beat A returns *after* the switch.
    resolveOptimize({
      ok: true,
      data: {
        final_prompt: "optimized seedance2 prompt",
        seedance2_config_json: JSON.stringify({
          mode: "multimodal_reference",
          duration: 5,
          resolution: "720p",
          ratio: "9:16",
          prompt_source: "generated",
          final_prompt: "optimized seedance2 prompt",
        }),
        beat: makeBeat({ beat_number: 1 }),
      },
    });

    // Result is attributed back to Beat A, not the now-mounted Beat B.
    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Subject prompt optimized and saved back to beat #1"),
    );
    expect(screen.getByLabelText("Seedance2.0 subject prompt")).toHaveValue(
      "beat two prompt",
    );
    const leakedToBeatB = updateBeatMock.mock.calls.some((call) => {
      try {
        return (
          JSON.parse(call[0].data.seedance2_config_json).final_prompt ===
          "optimized seedance2 prompt"
        );
      } catch {
        return false;
      }
    });
    expect(leakedToBeatB).toBe(false);
  });

  it("opens reference mention candidates from the custom prompt field", async () => {
    const user = userEvent.setup();
    renderPane();

    const guidance = screen.getByLabelText("AI writing guidance");
    fireEvent.change(guidance, { target: { value: "Keep @" } });
    expect(screen.getByText("Reference candidates")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "@image1" }));

    expect(guidance).toHaveValue("Keep @image1 ");
  });

  it("inserts a dragged reference into the custom prompt field", () => {
    videoQueryMockState.includeAudioAsset = true;
    renderPane();
    expandSeedance2References();
    const audioTile = screen
      .getByText("Project narrator voice")
      .closest("[data-seedance2-reference-tile]");
    if (!audioTile) throw new Error("audio tile not found");
    const guidance = screen.getByLabelText("AI writing guidance");
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: vi.fn((type: string, value: string) => data.set(type, value)),
      getData: vi.fn((type: string) => data.get(type) ?? ""),
      effectAllowed: "",
      dropEffect: "",
    };

    fireEvent.change(guidance, { target: { value: "Voice reference: " } });
    fireEvent.dragStart(audioTile, { dataTransfer });
    fireEvent.drop(guidance, { dataTransfer });

    expect(guidance).toHaveValue("Voice reference: @audio1 ");
  });

  it("places the AI optimize button in the main prompt input field", () => {
    renderPane();
    const promptField = screen.getByTestId("seedance2-prompt-panel");

    expect(promptField).toBeTruthy();
    expect(
      within(promptField as HTMLElement).getByRole("button", { name: "AI optimize" }),
    ).toBeInTheDocument();
  });

  it("appends and saves Seedance2 prompt guidance templates without duplicates", async () => {
    const user = userEvent.setup();
    renderPane();

    await user.click(screen.getByRole("button", { name: "Lens" }));
    await user.click(screen.getByRole("button", { name: "Lens" }));

    const template =
      "Camera: Specify shot size, viewpoint, movement speed, and direction so the camera move is clear and executable.";
    expect(screen.getByLabelText("AI writing guidance")).toHaveValue(template);
    await waitForSeedance2Autosave();
    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.prompt_guidance).toBe(template);
    expect(config.prompt_guidance_template_keys).toEqual(["camera"]);

    await user.click(screen.getByRole("button", { name: "AI optimize" }));
    expect(generateSeedance2PromptMock).toHaveBeenCalledWith(
      expect.objectContaining({ promptGuidanceTemplateKeys: ["camera"] }),
    );
  });

  it("uses the current UI language for Seedance2 guidance after switching", async () => {
    const user = userEvent.setup();
    await i18n.changeLanguage("en");
    renderPane(
      makeBeat({
        narration_segment: "She raises her phone.",
        visual_description: "Ji-won walks through the subway corridor.",
        video_prompt: "Legacy prompt text must not affect language detection.",
      }),
    );
    await act(async () => {
      await i18n.changeLanguage("vi");
    });

    await user.click(screen.getByRole("button", { name: "Lens" }));

    const template =
      "Camera: Specify shot size, viewpoint, movement speed, and direction so the camera move is clear and executable.";
    expect(screen.getByLabelText("AI writing guidance")).toHaveValue(template);
    await waitForSeedance2Autosave();
    const payload = updateBeatMock.mock.calls[0][0];
    const config = JSON.parse(payload.data.seedance2_config_json);
    expect(config.prompt_guidance).toBe(template);
  });

  it("inserts English Seedance2 guidance in the English UI", async () => {
    const user = userEvent.setup();
    await i18n.changeLanguage("en");
    renderPane();

    await user.click(screen.getByRole("button", { name: "Camera" }));

    expect(screen.getByLabelText("AI writing guidance")).toHaveValue(
      "Camera: Specify shot size, viewpoint, movement speed, and direction so the camera move is clear and executable.",
    );
    await act(async () => {
      await i18n.changeLanguage("vi");
    });
  });

  it("does not render project narrator voice management inside the video pane", () => {
    renderPane();

    expect(screen.queryByText("Narrator voice")).not.toBeInTheDocument();
    expect(screen.queryByText("Third-person project narration voice")).not.toBeInTheDocument();
    expect(screen.queryByText("assets/narrator/voice.wav")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Project audio" })).not.toBeInTheDocument();
    expect(deleteNarratorVoiceMock).not.toHaveBeenCalled();
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import type { VideoGenMode } from "@/features/canvas/domain/canvasNodes";
import {
  audioReferenceDurationRejection,
  audioReferenceTotalDurationLimitMs,
  formatAudioDurationClips,
  MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS,
  GEN_MODE_TO_CATALOG_MODE,
  isGrokVideoChannelModel,
  isHappyHorseVideoModel,
  isMultishotOnlyModel,
  isSeedance1xVideoModel,
  isSeedance2VideoModel,
  isVideoModeSupportedByModel,
  referenceDurationLimitsMs,
  resolveVideoKeyframeUrls,
  videoEmptyStateCtaModes,
  videoModeForcesAutomaticAspectRatio,
  videoModeRequiresMedia,
  videoModeRequiresPrompt,
  videoModelAcceptsMultipleImages,
  videoModelDefaultGenerateAudio,
  videoModelDefaultMode,
  videoModelSupportsGenerateAudio,
  videoModelReferenceDisabledReason,
  videoMultiImageAutoSwitchMode,
  videoNoUpstreamResetMode,
  videoReferenceAutoSwitchAction,
  type VideoReferenceAutoSwitchAction,
  videoSubmitMediaRejectionReason,
  videoUpstreamImageDefaultMode,
} from "@/features/canvas/nodes/shared/videoModelCapabilities";

describe("video mode effective ratio", () => {
  it.each([
    ["firstFrame", true],
    ["firstLastFrame", true],
    ["videoEdit", true],
    ["videoExtend", true],
    ["textToVideo", false],
    ["imageToVideo", false],
    ["imageReference", false],
    ["allReference", false],
  ] as const)("%s whether to be forced to follow the input assets", (mode, expected) => {
    expect(videoModeForcesAutomaticAspectRatio(mode)).toBe(expected);
  });
});

// Aligned with the real model ids of backend freezone/video_node.py (apiModel == id == backend model).
const SEEDANCE2_FAST = "newapi_seedance-2.0-fast";
const SEEDANCE2_VALUE = "newapi_seedance-2.0-fast-value";
const SEEDANCE10_PRO_FAST = "newapi_seedance-1.0-pro-fast";
const SEEDANCE15_PRO = "newapi_seedance-1.5-pro";
const HAPPYHORSE = "newapi_happyhorse-1.0";

describe("video model family detection", () => {
  it("classifies Seedance 2.0 variants (not 1.x)", () => {
    for (const id of [SEEDANCE2_FAST, SEEDANCE2_VALUE, "seedance-2.0"]) {
      expect(isSeedance2VideoModel(id)).toBe(true);
      expect(isSeedance1xVideoModel(id)).toBe(false);
    }
  });

  it("classifies Seedance 1.x variants (not 2.0)", () => {
    for (const id of [SEEDANCE10_PRO_FAST, SEEDANCE15_PRO, "seedance-1.0"]) {
      expect(isSeedance1xVideoModel(id)).toBe(true);
      expect(isSeedance2VideoModel(id)).toBe(false);
    }
  });

  it("classifies HappyHorse and Grok channels distinctly", () => {
    expect(isHappyHorseVideoModel(HAPPYHORSE)).toBe(true);
    expect(isSeedance2VideoModel(HAPPYHORSE)).toBe(false);
    expect(isSeedance1xVideoModel(HAPPYHORSE)).toBe(false);
    expect(isGrokVideoChannelModel("newapi_grok-video-channel")).toBe(true);
  });

  it("tolerates null / empty / oddly-formatted ids without misclassifying", () => {
    for (const id of [null, undefined, "", "  "]) {
      expect(isSeedance2VideoModel(id)).toBe(false);
      expect(isSeedance1xVideoModel(id)).toBe(false);
      expect(isHappyHorseVideoModel(id)).toBe(false);
    }
    // Separator-insensitive: after normalize `seedance20` is still 2.0 and does not leak into 1.x.
    expect(isSeedance2VideoModel("SEEDANCE 2.0 FAST")).toBe(true);
  });
});

describe("video native audio capability", () => {
  it("preserves legacy support and default when catalog fields are absent", () => {
    expect(videoModelSupportsGenerateAudio(SEEDANCE2_FAST)).toBe(true);
    expect(videoModelDefaultGenerateAudio({ apiModel: SEEDANCE2_FAST })).toBe(true);
  });

  it("defaults native audio on whenever the model supports it", () => {
    expect(videoModelSupportsGenerateAudio({ supportsGenerateAudio: true })).toBe(true);
    expect(
      videoModelDefaultGenerateAudio({
        supportsGenerateAudio: true,
      }),
    ).toBe(true);
    expect(
      videoModelDefaultGenerateAudio({
        supportsGenerateAudio: false,
      }),
    ).toBe(false);
  });
});

describe("videoEmptyStateCtaModes — CTA by model capability", () => {
  it("Seedance 2.0 → all reference / image-to-video / first frame / image reference / first-last-frame", () => {
    expect(videoEmptyStateCtaModes(SEEDANCE2_FAST)).toEqual([
      "allReference",
      "imageToVideo",
      "firstFrame",
      "imageReference",
      "firstLastFrame",
    ]);
  });

  it("Seedance 1.x → only 'first frame' (all reference would 400, first-last-frame silently drops the last frame, multi-image unsupported)", () => {
    for (const id of [SEEDANCE10_PRO_FAST, SEEDANCE15_PRO]) {
      const cta = videoEmptyStateCtaModes(id);
      expect(cta).toEqual(["firstFrame"]);
      // Regression guard: the 1.x empty state never shows entries only 2.0 supports.
      expect(cta).not.toContain("allReference");
      expect(cta).not.toContain("firstLastFrame");
    }
  });

  it("HappyHorse → image-to-video / first frame / image reference (no all reference / first-last-frame)", () => {
    const cta = videoEmptyStateCtaModes(HAPPYHORSE);
    expect(cta).toEqual(["imageToVideo", "firstFrame", "imageReference"]);
    expect(cta).not.toContain("allReference");
    expect(cta).not.toContain("firstLastFrame");
  });

  it("every CTA mode is supported by the same model (CTA ⊆ supported)", () => {
    for (const id of [SEEDANCE2_FAST, SEEDANCE10_PRO_FAST, HAPPYHORSE]) {
      for (const mode of videoEmptyStateCtaModes(id)) {
        expect(isVideoModeSupportedByModel(mode, id)).toBe(true);
      }
    }
  });
});

describe("catalog supportedModes is the single source of truth for mode entries", () => {
  const firstFrameOnly = {
    apiModel: SEEDANCE15_PRO,
    supportedModes: ["text_to_video", "first_frame"],
  };
  const imageReferenceOnly = {
    apiModel: "custom-reference-model",
    supportedModes: ["text_to_video", "image_reference"],
  };
  const imageToVideoOnly = {
    apiModel: "custom-image-to-video-model",
    supportedModes: ["text_to_video", "image_to_video"],
  };
  const comfyAllReference = {
    apiModel: "minimax_h3_r2v",
    supportedModes: ["text_to_video", "image_reference", "all_reference"],
  };

  it("a model that declares only first_frame still has a real first-frame entry and does not wrongly enter image-to-video", () => {
    expect(isVideoModeSupportedByModel("firstFrame", firstFrameOnly)).toBe(true);
    expect(isVideoModeSupportedByModel("imageToVideo", firstFrameOnly)).toBe(false);
    expect(videoEmptyStateCtaModes(firstFrameOnly)).toEqual(["firstFrame"]);
    expect(videoUpstreamImageDefaultMode(firstFrameOnly)).toBe("firstFrame");
  });

  it("image-to-video and image reference are controlled by two independent catalog capabilities", () => {
    expect(isVideoModeSupportedByModel("firstFrame", imageReferenceOnly)).toBe(false);
    expect(isVideoModeSupportedByModel("imageToVideo", imageReferenceOnly)).toBe(false);
    expect(isVideoModeSupportedByModel("imageReference", imageReferenceOnly)).toBe(true);
    expect(videoEmptyStateCtaModes(imageReferenceOnly)).toEqual(["imageReference"]);
    expect(videoUpstreamImageDefaultMode(imageReferenceOnly)).toBe("imageReference");

    expect(isVideoModeSupportedByModel("imageToVideo", imageToVideoOnly)).toBe(true);
    expect(isVideoModeSupportedByModel("imageReference", imageToVideoOnly)).toBe(false);
    expect(videoEmptyStateCtaModes(imageToVideoOnly)).toEqual(["imageToVideo"]);
    expect(videoUpstreamImageDefaultMode(imageToVideoOnly)).toBe("imageToVideo");
  });

  it("the frontend mode → catalog capability mapping distinguishes first frame from image reference", () => {
    expect(GEN_MODE_TO_CATALOG_MODE.firstFrame).toBe("first_frame");
    expect(GEN_MODE_TO_CATALOG_MODE.imageToVideo).toBe("image_to_video");
    expect(GEN_MODE_TO_CATALOG_MODE.imageReference).toBe("image_reference");
  });

  it("video extend opens only after the catalog declares it explicitly", () => {
    const seedance25 = {
      apiModel: "seedance-2.5",
      supportedModes: ["text_to_video", "all_reference", "video_edit"],
    };
    expect(isVideoModeSupportedByModel("videoExtend", "seedance-2.5")).toBe(false);
    expect(isVideoModeSupportedByModel("videoExtend", seedance25)).toBe(false);
    expect(
      isVideoModeSupportedByModel("videoExtend", {
        ...seedance25,
        supportedModes: [...seedance25.supportedModes, "video_extend"],
      }),
    ).toBe(true);
  });

  it("a non-Seedance model that declares all_reference can use multi-image, video and audio assets", () => {
    expect(isVideoModeSupportedByModel("allReference", comfyAllReference)).toBe(true);
    expect(videoUpstreamImageDefaultMode(comfyAllReference)).toBe("allReference");
    expect(videoMultiImageAutoSwitchMode("imageToVideo", comfyAllReference, 2)).toBe(
      "allReference",
    );
    expect(
      videoModelReferenceDisabledReason(comfyAllReference, {
        images: 9,
        videos: 3,
        audios: 3,
      }),
    ).toBeNull();
    expect(
      videoSubmitMediaRejectionReason("allReference", comfyAllReference, {
        images: 9,
        videos: 3,
        audios: 3,
      }),
    ).toBeNull();
  });
});

describe("isVideoModeSupportedByModel — mode gating by model", () => {
  const commonModes: VideoGenMode[] = ["textToVideo", "firstFrame"];

  it("all reference / first-last-frame are Seedance 2.0 only", () => {
    for (const mode of ["allReference", "firstLastFrame"] as VideoGenMode[]) {
      expect(isVideoModeSupportedByModel(mode, SEEDANCE2_FAST)).toBe(true);
      expect(isVideoModeSupportedByModel(mode, SEEDANCE10_PRO_FAST)).toBe(false);
      expect(isVideoModeSupportedByModel(mode, SEEDANCE15_PRO)).toBe(false);
      expect(isVideoModeSupportedByModel(mode, HAPPYHORSE)).toBe(false);
    }
  });

  it("text-to-video / first frame are supported by all video models", () => {
    for (const id of [SEEDANCE2_FAST, SEEDANCE10_PRO_FAST, HAPPYHORSE]) {
      for (const mode of commonModes) {
        expect(isVideoModeSupportedByModel(mode, id)).toBe(true);
      }
    }
  });

  it("Seedance 1.x does not disguise image reference as first frame", () => {
    for (const mode of ["imageToVideo", "imageReference"] as VideoGenMode[]) {
      expect(isVideoModeSupportedByModel(mode, SEEDANCE10_PRO_FAST)).toBe(false);
      expect(isVideoModeSupportedByModel(mode, SEEDANCE15_PRO)).toBe(false);
    }
  });

  it("video edit is HappyHorse only", () => {
    expect(isVideoModeSupportedByModel("videoEdit", HAPPYHORSE)).toBe(true);
    expect(isVideoModeSupportedByModel("videoEdit", SEEDANCE2_FAST)).toBe(false);
    expect(isVideoModeSupportedByModel("videoEdit", SEEDANCE10_PRO_FAST)).toBe(false);
  });
});

describe("videoUpstreamImageDefaultMode — auto-derived default on first image", () => {
  it("Seedance 2.0 defaults to 'all reference' when images are connected", () => {
    expect(videoUpstreamImageDefaultMode(SEEDANCE2_FAST)).toBe("allReference");
  });

  it("Seedance 1.x defaults to 'first frame' rather than all reference when images are connected (otherwise submit certainly 400s)", () => {
    expect(videoUpstreamImageDefaultMode(SEEDANCE10_PRO_FAST)).toBe("firstFrame");
    expect(videoUpstreamImageDefaultMode(SEEDANCE15_PRO)).toBe("firstFrame");
  });
});

describe("resolveVideoKeyframeUrls — stable edge slots", () => {
  it("stable slots take priority over an editable title, so a renamed last frame is not promoted to first frame", () => {
    expect(
      resolveVideoKeyframeUrls([
        { url: "last.png", slot: "last" },
      ]),
    ).toEqual({ firstFrameUrl: null, lastFrameUrl: "last.png" });
  });

  it("a canvas without slots fills by connection order", () => {
    expect(
      resolveVideoKeyframeUrls([
        { url: "legacy-last.png" },
        { url: "unassigned.png" },
      ]),
    ).toEqual({ firstFrameUrl: "legacy-last.png", lastFrameUrl: "unassigned.png" });
  });
});

describe("videoSubmitMediaRejectionReason — pre-submit asset guard (P1/P2)", () => {
  const none = { images: 0, videos: 0, audios: 0 };

  it("an existing video extend is blocked from submitting after the model capability is revoked", () => {
    const videoEditOnly = {
      apiModel: "seedance-2.5",
      supportedModes: ["video_edit"],
      referenceVideoMax: 1,
    };
    const counts = { ...none, videos: 1 };

    expect(
      videoSubmitMediaRejectionReason("videoExtend", videoEditOnly, counts),
    ).toBe("node.videoOps.modeDisabled.modelNoVideoExtend");
    expect(
      videoSubmitMediaRejectionReason(
        "videoExtend",
        {
          ...videoEditOnly,
          supportedModes: ["video_edit", "video_extend"],
        },
        counts,
      ),
    ).toBeNull();
  });

  it("Seedance 1.x: video connected → blocked (P1 silently drops video)", () => {
    expect(
      videoSubmitMediaRejectionReason("imageToVideo", SEEDANCE10_PRO_FAST, { ...none, videos: 1 }),
    ).toBeTruthy();
    expect(
      videoSubmitMediaRejectionReason("textToVideo", SEEDANCE10_PRO_FAST, { ...none, videos: 1 }),
    ).toBeTruthy();
  });

  it("Seedance 1.x: audio connected → blocked (P1 silently drops audio)", () => {
    expect(
      videoSubmitMediaRejectionReason("imageToVideo", SEEDANCE10_PRO_FAST, { ...none, audios: 1 }),
    ).toBeTruthy();
  });

  it("Seedance 1.x: >1 image → blocked (P2 multi-image 400), whether imageReference or imageToVideo", () => {
    for (const mode of ["imageReference", "imageToVideo"] as VideoGenMode[]) {
      expect(
        videoSubmitMediaRejectionReason(mode, SEEDANCE10_PRO_FAST, { images: 2, videos: 0, audios: 0 }),
      ).toBeTruthy();
      expect(
        videoSubmitMediaRejectionReason(mode, SEEDANCE15_PRO, { images: 9, videos: 0, audios: 0 }),
      ).toBeTruthy();
    }
  });

  it("Seedance 1.x: single image / pure text → allowed", () => {
    expect(
      videoSubmitMediaRejectionReason("firstFrame", SEEDANCE10_PRO_FAST, { ...none, images: 1 }),
    ).toBeNull();
    expect(
      videoSubmitMediaRejectionReason("firstFrame", SEEDANCE10_PRO_FAST, { ...none, images: 1 }),
    ).toBeNull();
    expect(videoSubmitMediaRejectionReason("textToVideo", SEEDANCE10_PRO_FAST, none)).toBeNull();
  });

  it("Seedance 2.0: all reference consuming video/audio/multi-image → allowed", () => {
    expect(
      videoSubmitMediaRejectionReason("allReference", SEEDANCE2_FAST, { images: 9, videos: 1, audios: 1 }),
    ).toBeNull();
  });

  it("HappyHorse: video edit consuming video and image reference consuming multi-image → allowed", () => {
    expect(
      videoSubmitMediaRejectionReason("videoEdit", HAPPYHORSE, { ...none, videos: 1 }),
    ).toBeNull();
    expect(
      videoSubmitMediaRejectionReason("imageReference", HAPPYHORSE, { images: 5, videos: 0, audios: 0 }),
    ).toBeNull();
  });

  it("after the catalog explicitly opens audio, video edit consumes standalone audio", () => {
    const audioVideoEditModel = {
      apiModel: "custom-video-editor",
      supportedModes: ["video_edit"],
      referenceAudioMax: 2,
    };
    expect(
      videoSubmitMediaRejectionReason("videoEdit", audioVideoEditModel, {
        images: 0,
        videos: 1,
        audios: 1,
      }),
    ).toBeNull();
    expect(
      videoSubmitMediaRejectionReason(
        "videoEdit",
        { ...audioVideoEditModel, referenceAudioMax: 0 },
        { images: 0, videos: 1, audios: 1 },
      ),
    ).toBeTruthy();
  });
});

describe("videoMultiImageAutoSwitchMode — auto mode change when first frame gets several images", () => {
  // This is the bug itself: the i2v endpoint dispatches by image count (1 = image-to-video, 2-9 = image reference),
  // after a second image is connected what it does is actually image reference, yet the UI mode still says "first-frame-to-video".
  it("Seedance 2.0: first frame gets a 2nd image → switch to all reference", () => {
    expect(videoMultiImageAutoSwitchMode("imageToVideo", SEEDANCE2_FAST, 2)).toBe(
      "allReference",
    );
    expect(videoMultiImageAutoSwitchMode("imageToVideo", SEEDANCE2_VALUE, 9)).toBe(
      "allReference",
    );
  });

  it("single image / no image stays — that is exactly how a first frame is meant to be used", () => {
    for (const images of [0, 1]) {
      expect(
        videoMultiImageAutoSwitchMode("imageToVideo", SEEDANCE2_FAST, images),
      ).toBeNull();
    }
  });

  it("handles first-frame mode only, never meddling with other modes", () => {
    for (const mode of [
      "textToVideo",
      "imageReference",
      "allReference",
      "firstLastFrame",
      "videoEdit",
    ] as VideoGenMode[]) {
      expect(videoMultiImageAutoSwitchMode(mode, SEEDANCE2_FAST, 5)).toBeNull();
    }
  });

  // HappyHorse's own state machine (videos>0→video edit / images>1→image reference) already settles it,
  // and meddling again here would only make two updateNodeData calls fight.
  it("HappyHorse stays, left to its own state machine", () => {
    expect(videoMultiImageAutoSwitchMode("imageToVideo", HAPPYHORSE, 3)).toBeNull();
  });

  // Switching mode cannot save 1.x: its i2v endpoint gives a direct 400 for >1 image, and any mode we switch to is a 400. Stay on first frame,
  // and let the submit guard's "this model supports only 1 image at a time" say the real problem — "switch the model" — clearly.
  it("Seedance 1.x stays: multi-image is certainly a 400, the problem is in the model not the mode", () => {
    for (const id of [SEEDANCE10_PRO_FAST, SEEDANCE15_PRO]) {
      expect(videoMultiImageAutoSwitchMode("imageToVideo", id, 2)).toBeNull();
      expect(videoSubmitMediaRejectionReason("imageToVideo", id, {
        images: 2,
        videos: 0,
        audios: 0,
      })).toBeTruthy();
    }
  });

  // The catalog-declared supportedModes outranks the heuristics (same basis as the visible tabs).
  it("when the catalog declares no all reference it falls back to image reference; with neither, it stays", () => {
    expect(
      videoMultiImageAutoSwitchMode(
        "imageToVideo",
        {
          id: SEEDANCE2_FAST,
          apiModel: SEEDANCE2_FAST,
          supportedModes: ["text_to_video", "first_frame", "image_reference"],
        },
        2,
      ),
    ).toBe("imageReference");
    expect(
      videoMultiImageAutoSwitchMode(
        "imageToVideo",
        {
          id: SEEDANCE2_FAST,
          apiModel: SEEDANCE2_FAST,
          supportedModes: ["text_to_video", "first_frame"],
        },
        2,
      ),
    ).toBeNull();
  });

  // Auto mode change and the submit guard must close: after the switch that mode must really be submittable, otherwise the user is merely moved
  // from one pit into another.
  it("the mode switched to is allowed by the submit guard", () => {
    const counts = { images: 3, videos: 0, audios: 0 };
    const target = videoMultiImageAutoSwitchMode("imageToVideo", SEEDANCE2_FAST, counts.images);
    expect(target).not.toBeNull();
    expect(
      videoSubmitMediaRejectionReason(target as VideoGenMode, SEEDANCE2_FAST, counts),
    ).toBeNull();
  });

  // The auto mode switch merely steers the UI right; what truly backs up submit is the reference cap: in case the mode was not switched away (say the
  // effect has not run, or someone later adds a bail condition), submit can only carry 1 image and must never quietly
  // turn into image reference through the count. This cap is structural and does not accept a media catalog referenceImageMax override.
  it("the image cap of first frame and single-image image-to-video is locked at 1, and not overridden by the media catalog config", () => {
    const source = readFileSync(
      "src/features/canvas/nodes/shared/videoFormOptions.ts",
      "utf8",
    );
    expect(source).toContain("firstFrame: { image: 1, video: 0, audio: 0 }");
    expect(source).toContain("imageToVideo: { image: 1, video: 0, audio: 0 }");
    expect(source).toContain("const FIXED_IMAGE_CAP_BY_MODE");
    expect(source).toContain(
      "image: FIXED_IMAGE_CAP_BY_MODE[mode] ?? model?.referenceImageMax ?? defaults.image",
    );
  });
});

describe("HappyHorse single-image default mode", () => {
  it("defaults to image-to-video, with first frame still an independent mode selectable after catalog declaration", () => {
    const configured = {
      apiModel: HAPPYHORSE,
      supportedModes: [
        "text_to_video",
        "first_frame",
        "image_to_video",
        "image_reference",
        "video_edit",
      ],
    };
    expect(videoUpstreamImageDefaultMode(configured)).toBe("imageToVideo");
    expect(isVideoModeSupportedByModel("firstFrame", configured)).toBe(true);
    expect(isVideoModeSupportedByModel("imageToVideo", configured)).toBe(true);
  });

  // The default must really be usable, otherwise connecting one image pushes into a tab whose hover hint says "unavailable".
  it("image reference is available with 1~9 images", () => {
    const source = readFileSync(
      "src/features/canvas/nodes/VideoOperationsPanel.tsx",
      "utf8",
    );
    // The copy is in the locale entries, so the keys are matched here; the wording is checked separately against the en entries, so neither end drifts quietly.
    expect(source).toContain(
      'if (images === 0) return t("node.videoOps.modeDisabled.needImages1to9");',
    );
    expect(source).toContain(
      'if (images > 9) return t("node.videoOps.modeDisabled.imageReferenceMax9");',
    );
    const en = JSON.parse(readFileSync("public/locales/en/translation.json", "utf8"));
    expect(en.node.videoOps.modeDisabled.needImages1to9).toBe("Connect image nodes (1–9)");
    expect(en.node.videoOps.modeDisabled.imageReferenceMax9).toBe(
      "“Image reference” supports at most 9 images",
    );
  });
});

describe("videoModelReferenceDisabledReason — model selector graying guard", () => {
  const none = { images: 0, videos: 0, audios: 0 };

  // Regression: it was once written as `counts.images > 0` graying out unconditionally, and one image node locked the whole Seedance 1 series
  // out — yet a single-image first frame is exactly the only mode 1.x can use, and the backend 400s only with >1 image.
  it("Seedance 1.x: single image → selectable (not grayed out)", () => {
    for (const id of [SEEDANCE10_PRO_FAST, SEEDANCE15_PRO]) {
      expect(videoModelReferenceDisabledReason(id, { ...none, images: 1 })).toBeNull();
      expect(videoModelReferenceDisabledReason(id, none)).toBeNull();
    }
  });

  it("Seedance 1.x: >1 image → grayed out", () => {
    expect(
      videoModelReferenceDisabledReason(SEEDANCE15_PRO, { ...none, images: 2 }),
    ).toBeTruthy();
  });

  it("Seedance 1.x: video / audio connected → grayed out", () => {
    expect(
      videoModelReferenceDisabledReason(SEEDANCE10_PRO_FAST, { ...none, videos: 1 }),
    ).toBeTruthy();
    expect(
      videoModelReferenceDisabledReason(SEEDANCE10_PRO_FAST, { ...none, audios: 1 }),
    ).toBeTruthy();
  });

  // The two guards are a pair; if thresholds drift apart you get self-contradictions like "selectable yet blocked on submit" or the reverse.
  it("same threshold as the submit guard: single image allowed / multi-image blocked are judged consistently", () => {
    for (const images of [0, 1, 2, 9]) {
      const counts = { ...none, images };
      const pickerBlocked = videoModelReferenceDisabledReason(SEEDANCE15_PRO, counts) != null;
      const submitBlocked =
        videoSubmitMediaRejectionReason("firstFrame", SEEDANCE15_PRO, counts) != null;
      expect(pickerBlocked).toBe(submitBlocked);
    }
  });

  it("Seedance 2.0: multi-image + video + audio are not grayed out (all reference eats everything)", () => {
    for (const id of [SEEDANCE2_FAST, SEEDANCE2_VALUE]) {
      expect(
        videoModelReferenceDisabledReason(id, { images: 9, videos: 1, audios: 1 }),
      ).toBeNull();
    }
  });

  it("HappyHorse: multi-image / video not grayed out (r2v and video edit each have a path), audio grayed out", () => {
    expect(
      videoModelReferenceDisabledReason(HAPPYHORSE, { images: 9, videos: 1, audios: 0 }),
    ).toBeNull();
    // Audio can be consumed only by all reference (2.0), and HappyHorse can never reach allReference — without blocking
    // it would put the user into the dead end of "selectable yet submit certain to be blocked".
    expect(
      videoModelReferenceDisabledReason(HAPPYHORSE, { ...none, audios: 1 }),
    ).toBeTruthy();
  });

  it("when the catalog declares video_edit and an audio cap above 0, a model with audio is still selectable", () => {
    expect(
      videoModelReferenceDisabledReason(
        {
          apiModel: "custom-video-editor",
          supportedModes: ["video_edit"],
          referenceAudioMax: 1,
        },
        { ...none, videos: 1, audios: 1 },
      ),
    ).toBeNull();
  });

  // After the admin takes down a model's "video edit" in the console, the heuristic assumption "HappyHorse can naturally eat video"
  // no longer holds — the catalog declaration is the fact.
  it("HappyHorse: when the catalog has no video_edit, connecting video → grayed out", () => {
    const withoutVideoEdit = {
      apiModel: HAPPYHORSE,
      supportedModes: [
        "text_to_video",
        "first_frame",
        "image_reference",
        "first_last_frame",
      ],
    };
    expect(
      videoModelReferenceDisabledReason(withoutVideoEdit, { ...none, videos: 1 }),
    ).toBe("node.videoModel.reason.videoUnsupported");
    // If the catalog still keeps video_edit, let it through as before, so the whole model is not collaterally hit.
    expect(
      videoModelReferenceDisabledReason(
        { apiModel: HAPPYHORSE, supportedModes: [...withoutVideoEdit.supportedModes, "video_edit"] },
        { ...none, videos: 1 },
      ),
    ).toBeNull();
  });

  // Regression: the selector once collapsed the model into `model.apiModel ?? model.id` before passing it in, and the catalog-declared
  // supportedModes were lost entirely on this path, leaving only heuristics — after the admin took down HappyHorse's video
  // edit, it was still selectable in the selector, and once selected every mode was gray and submit was blocked too, a
  // dead end. This locks "pass the whole ModelOption", the same source as VideoNode's submit guard.
  it("the model selector must pass the whole ModelOption to the graying guard (not just the id)", () => {
    const source = readFileSync(
      "src/features/canvas/nodes/shared/VideoGenerationForm.tsx",
      "utf8",
    );
    expect(source).toMatch(
      /videoModelReferenceDisabledReason\(\s*model,\s*modelUpstreamCounts/,
    );
    expect(source).not.toContain(
      "videoModelReferenceDisabledReason(model.apiModel ?? model.id",
    );
  });

  it("Grok Video Channel: images only, at most 8", () => {
    const GROK = "newapi_grok-video-channel";
    expect(videoModelReferenceDisabledReason(GROK, { ...none, images: 8 })).toBeNull();
    expect(videoModelReferenceDisabledReason(GROK, { ...none, images: 9 })).toBeTruthy();
    expect(videoModelReferenceDisabledReason(GROK, { ...none, videos: 1 })).toBeTruthy();
    expect(videoModelReferenceDisabledReason(GROK, { ...none, audios: 1 })).toBeTruthy();
  });
});

// The invariant the two guards truly want to hold — not per-threshold equality (HappyHorse's multi-image/video are digested by its own
// paths, and the two sides judge differently anyway), but "what can be selected must be workable". This grid test is the searchlight for the dead ends
// of the "HappyHorse + audio" kind back then: the selector lets it through, yet no mode it supports can
// pass the submit guard. Grok is not in the grid: the backend FREEZONE_DISABLED_VIDEO_BACKENDS turned it off,
// it never appears in the selector at all, and its branch is dormant.
describe("graying guard × submit guard — a combination that is not grayed out must have a submittable mode", () => {
  const ALL_MODES: VideoGenMode[] = [
    "textToVideo",
    "firstFrame",
    "imageToVideo",
    "imageReference",
    "allReference",
    "firstLastFrame",
    "videoEdit",
  ];
  const PICKER_MODELS = [
    SEEDANCE10_PRO_FAST,
    SEEDANCE15_PRO,
    SEEDANCE2_FAST,
    SEEDANCE2_VALUE,
    HAPPYHORSE,
  ];

  it("holds for every model × every asset combination", () => {
    const deadEnds: string[] = [];
    for (const modelId of PICKER_MODELS) {
      for (const images of [0, 1, 2, 9]) {
        for (const videos of [0, 1]) {
          for (const audios of [0, 1]) {
            const counts = { images, videos, audios };
            if (videoModelReferenceDisabledReason(modelId, counts) != null) {
              continue; // already grayed out — the user cannot select it, so there is no dead end to speak of
            }
            const usable = ALL_MODES.some(
              (mode) =>
                isVideoModeSupportedByModel(mode, modelId) &&
                videoSubmitMediaRejectionReason(mode, modelId, counts) == null,
            );
            if (!usable) {
              deadEnds.push(`${modelId} + ${JSON.stringify(counts)}`);
            }
          }
        }
      }
    }
    expect(deadEnds).toEqual([]);
  });
});

// The selector's real order: Fast comes before the base 2.0 (see ProviderModelPicker VIDEO_MODELS).
// This order is the key — picking the target must not take the lazy "first 2.0", which would land on Fast.
const SEEDANCE2_BASE = "newapi_seedance-2.0";
const MODELS = [
  { id: SEEDANCE2_FAST, apiModel: SEEDANCE2_FAST },
  { id: SEEDANCE2_BASE, apiModel: SEEDANCE2_BASE },
  { id: SEEDANCE2_VALUE, apiModel: SEEDANCE2_VALUE },
  { id: SEEDANCE15_PRO, apiModel: SEEDANCE15_PRO },
  { id: SEEDANCE10_PRO_FAST, apiModel: SEEDANCE10_PRO_FAST },
];

function expectSwitch(action: VideoReferenceAutoSwitchAction) {
  if (action.kind !== "switch") {
    throw new Error(`expected switch, actually got ${action.kind}`);
  }
  return action;
}

describe("videoReferenceAutoSwitchAction — when video/audio is connected, replace 1.x with 2.0", () => {
  // Normal arguments: the list is ready and the latch is not set yet. Loading timing and the latch itself are verified frame by frame in the next describe.
  const pick = (
    currentModelId: string | null | undefined,
    counts: { videos: number; audios: number },
    models: readonly { id: string; apiModel?: string }[],
  ) =>
    videoReferenceAutoSwitchAction({
      counts,
      currentModelId,
      models,
      modelsLoading: false,
      alreadySwitched: false,
    });

  it("Seedance 1.x + video → switch to the base 2.0 (not the Fast listed first), landing on all reference", () => {
    expect(pick(SEEDANCE10_PRO_FAST, { videos: 1, audios: 0 }, MODELS)).toEqual({
      kind: "switch",
      modelId: SEEDANCE2_BASE,
      genMode: "allReference",
    });
  });

  it("Seedance 1.x + audio → likewise switch to the base 2.0", () => {
    expect(pick(SEEDANCE15_PRO, { videos: 0, audios: 1 }, MODELS)).toEqual({
      kind: "switch",
      modelId: SEEDANCE2_BASE,
      genMode: "allReference",
    });
  });

  it("no base model among the candidates (only fast / value variants delivered) → fall back to any 2.0", () => {
    const action = pick(SEEDANCE10_PRO_FAST, { videos: 1, audios: 0 }, [
      { id: SEEDANCE2_VALUE, apiModel: SEEDANCE2_VALUE },
      { id: SEEDANCE2_FAST, apiModel: SEEDANCE2_FAST },
    ]);
    expect(expectSwitch(action).modelId).toBe(SEEDANCE2_VALUE);
  });

  it("assets not connected / already removed → release (release the latch), writing no patch", () => {
    expect(pick(SEEDANCE10_PRO_FAST, { videos: 0, audios: 0 }, MODELS)).toEqual({
      kind: "release",
    });
  });

  it("what is returned is the id rather than apiModel — what is stored into VideoNodeData.model is the id", () => {
    const renamed = [{ id: "picker-id-2.0", apiModel: "newapi_seedance-2.0" }];
    const action = pick(SEEDANCE15_PRO, { videos: 1, audios: 0 }, renamed);
    expect(expectSwitch(action).modelId).toBe("picker-id-2.0");
  });

  it("2.0 / HappyHorse / Grok are not grabbed: each has its own path or channel", () => {
    for (const id of [SEEDANCE2_FAST, HAPPYHORSE, "newapi_grok-video-channel"]) {
      expect(pick(id, { videos: 1, audios: 1 }, MODELS)).toEqual({ kind: "none" });
    }
  });

  it("no 2.0 in the candidate list (API anomaly) → better not to move than switch blindly", () => {
    expect(
      pick(SEEDANCE10_PRO_FAST, { videos: 1, audios: 0 }, [
        { id: SEEDANCE15_PRO, apiModel: SEEDANCE15_PRO },
      ]),
    ).toEqual({ kind: "none" });
    expect(pick(SEEDANCE10_PRO_FAST, { videos: 1, audios: 0 }, [])).toEqual({ kind: "none" });
  });

  // After the switch it must be self-consistent: the new model + new mode should be neither grayed out by the selector nor blocked by the submit guard,
  // otherwise the user is pushed from one dead end into another.
  it("the switch result is self-consistent: with the same assets the target model is neither grayed out nor blocked by the submit guard", () => {
    const counts = { images: 1, videos: 1, audios: 1 };
    const next = expectSwitch(pick(SEEDANCE10_PRO_FAST, counts, MODELS));
    expect(videoModelReferenceDisabledReason(next.modelId, counts)).toBeNull();
    expect(videoSubmitMediaRejectionReason(next.genMode, next.modelId, counts)).toBeNull();
    expect(isVideoModeSupportedByModel(next.genMode, next.modelId)).toBe(true);
  });
});

// useFreezoneVideoModels returns **not an empty array** during pending but the hard-coded
// VIDEO_MODELS (isLoading: true / isFallback: true). So "the list is non-empty" can never be taken as
// "the list is ready" — a 2.0 picked from the fallback may not exist in the project's real list, switching early
// and also setting the latch means the real list is not corrected again when it returns, and the node gets stuck on a model the backend does not recognize. Below the component's
// effect is replayed frame by frame, watching this timing specifically.
describe("videoReferenceAutoSwitchAction — gate during async model-list loading", () => {
  // The hard-coded fallback given first while loading: it contains 2.0.
  const FALLBACK_WITH_2 = MODELS;
  // The project's real list: the API delivered only 1.x, with no 2.0 at all.
  const REAL_ONLY_1X = [
    { id: SEEDANCE15_PRO, apiModel: SEEDANCE15_PRO },
    { id: SEEDANCE10_PRO_FAST, apiModel: SEEDANCE10_PRO_FAST },
  ];
  // The project's real list: the model id differs from the hard-coded one, but there is indeed a base 2.0.
  const REAL_WITH_2 = [
    { id: "proj-2.0-fast", apiModel: SEEDANCE2_FAST },
    { id: "proj-2.0", apiModel: SEEDANCE2_BASE },
  ];

  interface Frame {
    currentModelId: string;
    models: readonly { id: string; apiModel?: string }[];
    modelsLoading: boolean;
    counts?: { videos: number; audios: number };
  }

  /** Run the component effect's branch as is: compute action → update the latch / record writes. */
  function replay(frames: readonly Frame[]) {
    let latched = false;
    const writes: { modelId: string; genMode: VideoGenMode }[] = [];
    for (const frame of frames) {
      const action = videoReferenceAutoSwitchAction({
        counts: frame.counts ?? { videos: 1, audios: 0 },
        currentModelId: frame.currentModelId,
        models: frame.models,
        modelsLoading: frame.modelsLoading,
        alreadySwitched: latched,
      });
      if (action.kind === "release") {
        latched = false;
      } else if (action.kind === "switch") {
        latched = true;
        writes.push({ modelId: action.modelId, genMode: action.genMode });
      }
    }
    return { writes, latched };
  }

  // This is the regression the reviewer called out by name: the fallback has 2.0, but the real list has only 1.x.
  it("fallback has 2.0 but the real list has only 1.x → no write throughout, never writing a model absent from the list", () => {
    const { writes, latched } = replay([
      { currentModelId: SEEDANCE15_PRO, models: FALLBACK_WITH_2, modelsLoading: true },
      { currentModelId: SEEDANCE15_PRO, models: REAL_ONLY_1X, modelsLoading: false },
      { currentModelId: SEEDANCE15_PRO, models: REAL_ONLY_1X, modelsLoading: false },
    ]);
    expect(writes).toEqual([]);
    // Not latched either: if the real list adds a 2.0 some day, this transition still has a chance to be rescued.
    expect(latched).toBe(false);
  });

  it("while loading do not move; switch only when the real list arrives, switching to an id in the real list, only once", () => {
    const { writes } = replay([
      { currentModelId: SEEDANCE15_PRO, models: FALLBACK_WITH_2, modelsLoading: true },
      { currentModelId: SEEDANCE15_PRO, models: FALLBACK_WITH_2, modelsLoading: true },
      { currentModelId: SEEDANCE15_PRO, models: REAL_WITH_2, modelsLoading: false },
      // After the switch selectedVideoModelId becomes the new model, and the effect still runs a few more frames.
      { currentModelId: "proj-2.0", models: REAL_WITH_2, modelsLoading: false },
    ]);
    expect(writes).toEqual([{ modelId: "proj-2.0", genMode: "allReference" }]);
  });

  // isFallback is deliberately not an argument: in the three **settled** cases "the URL has no project", "the fetch failed", "the backend returned an empty list"
  // it stays true, and then what the selector renders is exactly this VIDEO_MODELS,
  // the 2.0 is in it and the user can also select it manually. Following isFallback to block = permanently turning off the rescue.
  it("a settled fallback (isLoading already false) rescues as usual, not giving up just because it is a fallback", () => {
    const { writes } = replay([
      { currentModelId: SEEDANCE15_PRO, models: FALLBACK_WITH_2, modelsLoading: true },
      { currentModelId: SEEDANCE15_PRO, models: FALLBACK_WITH_2, modelsLoading: false },
    ]);
    expect(writes).toEqual([{ modelId: SEEDANCE2_BASE, genMode: "allReference" }]);
  });

  // The point of the latch: when undo restores the model to 1.x while the video edge is still there, it must not correct back again,
  // otherwise updateNodeData would push another past and clear the future, and ⌘Z would look like it does nothing.
  it("after the latch is set, even if the model is undone back to 1.x (asset edge still present) there is no more correction", () => {
    const { writes } = replay([
      { currentModelId: SEEDANCE15_PRO, models: MODELS, modelsLoading: false },
      { currentModelId: SEEDANCE2_BASE, models: MODELS, modelsLoading: false },
      // ⌘Z: model goes back to 1.x, with the video edge still there
      { currentModelId: SEEDANCE15_PRO, models: MODELS, modelsLoading: false },
      { currentModelId: SEEDANCE15_PRO, models: MODELS, modelsLoading: false },
    ]);
    expect(writes).toHaveLength(1);
  });

  it("after assets are removed the latch is released, and the next connection can rescue once more", () => {
    const { writes } = replay([
      { currentModelId: SEEDANCE15_PRO, models: MODELS, modelsLoading: false },
      // Pull the wire: videos goes to zero → release
      {
        currentModelId: SEEDANCE15_PRO,
        models: MODELS,
        modelsLoading: false,
        counts: { videos: 0, audios: 0 },
      },
      // Reconnect
      { currentModelId: SEEDANCE15_PRO, models: MODELS, modelsLoading: false },
    ]);
    expect(writes).toHaveLength(2);
  });

  it("assets removed while loading → still release (release just resets a ref, no need to wait for the list)", () => {
    const action = videoReferenceAutoSwitchAction({
      counts: { videos: 0, audios: 0 },
      currentModelId: SEEDANCE15_PRO,
      models: FALLBACK_WITH_2,
      modelsLoading: true,
      alreadySwitched: true,
    });
    expect(action).toEqual({ kind: "release" });
  });
});

describe("audioReferenceDurationRejection — pre-submit audio duration guard", () => {
  const clip = (label: string, durationMs: number | null) => ({ label, durationMs });

  it("a single clip shorter than 1.8s → blocked, naming which one (vendor DurationTooShort)", () => {
    const rejection = audioReferenceDurationRejection([
      clip("bgm.mp3", 5_000),
      clip("sfx.wav", 900),
    ]);
    expect(rejection).toEqual({
      kind: "tooShort",
      clips: [{ label: "sfx.wav", durationMs: 900 }],
    });
  });

  it("exactly 1.8s passes, 1.799s is blocked (the boundary takes a closed interval, consistent with the vendor 1.8s lower bound)", () => {
    expect(audioReferenceDurationRejection([clip("a", 1_800)])).toBeNull();
    expect(audioReferenceDurationRejection([clip("a", 1_799)])?.kind).toBe("tooShort");
  });

  it("a single clip longer than 15.2s → blocked, naming which one; exactly 15.2s passes", () => {
    expect(audioReferenceDurationRejection([clip("a", 15_200)])).toBeNull();
    expect(
      audioReferenceDurationRejection([clip("bgm.mp3", 5_000), clip("long.wav", 15_201)]),
    ).toEqual({
      kind: "tooLong",
      clips: [{ label: "long.wav", durationMs: 15_201 }],
    });
  });

  // This once asserted "3 clips of 6s totaling 18s are also accepted by the vendor". Measured in the 2026-08-06 3060 environment, that was refuted: the vendor has
  // another `audio total duration ... must be less than or equal to 15.2` in r2v,
  // and an 18s combination that is compliant per item still gets a 400. Do not change it back to allow.
  it("compliant per item but total over the limit → blocked, carrying the total duration and the limit", () => {
    expect(
      audioReferenceDurationRejection([
        clip("a", 6_000),
        clip("b", 6_000),
        clip("c", 6_000),
      ]),
    ).toEqual({
      kind: "totalTooLong",
      clips: [
        { label: "a", durationMs: 6_000 },
        { label: "b", durationMs: 6_000 },
        { label: "c", durationMs: 6_000 },
      ],
      totalMs: 18_000,
      limitMs: 15_200,
    });
  });

  it("a total exactly at the cap of 15.2s passes, and 1ms more is blocked", () => {
    expect(
      audioReferenceDurationRejection([clip("a", 9_000), clip("b", 6_200)]),
    ).toBeNull();
    expect(
      audioReferenceDurationRejection([clip("a", 9_000), clip("b", 6_201)])?.kind,
    ).toBe("totalTooLong");
  });

  it("a single clip at the 15.2s cap is not wrongly hit by the total rule (the fallback cap equals the per-item cap)", () => {
    expect(audioReferenceDurationRejection([clip("a", 15_200)])).toBeNull();
  });

  it("single-too-long is reported before the total (replace that one first, then talk about overall trimming)", () => {
    expect(
      audioReferenceDurationRejection([clip("a", 20_000), clip("b", 6_000)])?.kind,
    ).toBe("tooLong");
  });

  it("the total cap follows the passed-in value (admin referenceAudioTotalMaxSeconds)", () => {
    const clips = [clip("a", 6_000), clip("b", 6_000)];
    expect(audioReferenceDurationRejection(clips)).toBeNull();
    expect(audioReferenceDurationRejection(clips, { totalLimitMs: 30_000 })).toBeNull();
    expect(audioReferenceDurationRejection(clips, { totalLimitMs: 10_000 })).toEqual({
      kind: "totalTooLong",
      clips: [
        { label: "a", durationMs: 6_000 },
        { label: "b", durationMs: 6_000 },
      ],
      totalMs: 12_000,
      limitMs: 10_000,
    });
  });

  it("perClipLimits: false judges only the total — 1.8~15.2 are seedance2-specific numbers, do not use them to block other models", () => {
    // The admin configured a 60s total duration for a non-seedance2 model: one 25s audio is entirely legal for it,
    // and still applying the per-item 15.2s would be us 400-ing a normal submission out of thin air.
    const options = { totalLimitMs: 60_000, perClipLimits: false };
    expect(audioReferenceDurationRejection([clip("a", 25_000)], options)).toBeNull();
    expect(audioReferenceDurationRejection([clip("a", 500)], options)).toBeNull();
    // The total rule still governs.
    expect(
      audioReferenceDurationRejection([clip("a", 40_000), clip("b", 25_000)], options),
    ).toMatchObject({ kind: "totalTooLong", totalMs: 65_000, limitMs: 60_000 });
  });

  it("entries that cannot be probed do not count toward the total — the sum can only be smaller, so a computed overrun is definitely real", () => {
    // 3 clips of 6s with one unmeasurable: the visible part 12s is not over, and passes to the backend ffprobe fallback.
    expect(
      audioReferenceDurationRejection([
        clip("a", 6_000),
        clip("b", null),
        clip("c", 6_000),
      ]),
    ).toBeNull();
  });

  it("when both too short and too long exist, report too short first (one kind at a time, do not list them mixed)", () => {
    expect(
      audioReferenceDurationRejection([clip("long", 20_000), clip("short", 500)]),
    ).toEqual({
      kind: "tooShort",
      clips: [{ label: "short", durationMs: 500 }],
    });
  });

  it("multiple out-of-range entries of the same kind are all listed at once", () => {
    expect(
      audioReferenceDurationRejection([
        clip("a", 900),
        clip("b", 5_000),
        clip("c", 1_000),
      ])?.clips,
    ).toEqual([
      { label: "a", durationMs: 900 },
      { label: "c", durationMs: 1_000 },
    ]);
  });

  it("entries whose duration cannot be probed (null) do not take part in the judgment → pass to the backend fallback", () => {
    expect(audioReferenceDurationRejection([clip("unknown", null)])).toBeNull();
    expect(
      audioReferenceDurationRejection([clip("unknown", null), clip("ok", 15_200)]),
    ).toBeNull();
  });

  it("no audio references → not blocked", () => {
    expect(audioReferenceDurationRejection([])).toBeNull();
  });

  it("supports the admin-configured lower bound of total duration, and does not wrongly block when unprobed assets exist", () => {
    expect(
      audioReferenceDurationRejection([clip("a", 4_000), clip("b", 5_000)], {
        minMs: null,
        maxMs: null,
        totalMinMs: 10_000,
        totalLimitMs: null,
        perClipLimits: false,
      }),
    ).toMatchObject({ kind: "totalTooShort", totalMs: 9_000, limitMs: 10_000 });
    expect(
      audioReferenceDurationRejection([clip("a", 4_000), clip("unknown", null)], {
        minMs: null,
        maxMs: null,
        totalMinMs: 10_000,
        totalLimitMs: null,
        perClipLimits: false,
      }),
    ).toBeNull();
  });
});

describe("referenceDurationLimitsMs — catalog duration config", () => {
  it("reads the audio and video per-clip/total duration config separately", () => {
    const model = {
      referenceAudioMinSeconds: 1.8,
      referenceAudioTotalMaxSeconds: 15.2,
      referenceVideoMaxSeconds: 12,
      referenceVideoTotalMinSeconds: 5,
    };
    expect(referenceDurationLimitsMs(model, "audio")).toEqual({
      minMs: 1_800,
      maxMs: undefined,
      totalMinMs: undefined,
      totalMaxMs: 15_200,
    });
    expect(referenceDurationLimitsMs(model, "video")).toEqual({
      minMs: undefined,
      maxMs: 12_000,
      totalMinMs: 5_000,
      totalMaxMs: undefined,
    });
  });
});

describe("audioReferenceTotalDurationLimitMs — catalog first, 15.2s fallback", () => {
  it("not configured / configured with an illegal value → fallback 15.2s", () => {
    expect(audioReferenceTotalDurationLimitMs(null)).toBe(15_200);
    expect(audioReferenceTotalDurationLimitMs(undefined)).toBe(15_200);
    expect(audioReferenceTotalDurationLimitMs({})).toBe(15_200);
    for (const bad of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        audioReferenceTotalDurationLimitMs({ referenceAudioTotalMaxSeconds: bad }),
      ).toBe(MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS);
    }
  });

  it("configured, follow the config, and **decimals are accepted** — 15.2 itself is not an integer", () => {
    expect(
      audioReferenceTotalDurationLimitMs({ referenceAudioTotalMaxSeconds: 30 }),
    ).toBe(30_000);
    expect(
      audioReferenceTotalDurationLimitMs({ referenceAudioTotalMaxSeconds: 15.2 }),
    ).toBe(15_200);
    // Do not casually apply Number.isInteger: that would silently fall a 12.5s configured by the admin back to 15.2s, looser than the backend.
    expect(
      audioReferenceTotalDurationLimitMs({ referenceAudioTotalMaxSeconds: 12.5 }),
    ).toBe(12_500);
  });

  it("vendorCapMs is min-ed with the catalog value — configuring looser must not exceed the vendor hard cap", () => {
    const capped = { vendorCapMs: MAX_AUDIO_REFERENCE_TOTAL_DURATION_MS };
    // The admin configures 60s for seedance2: 3 clips of 6s all pass locally and still 400 at the vendor. It must take the min.
    expect(
      audioReferenceTotalDurationLimitMs(
        { referenceAudioTotalMaxSeconds: 60 },
        capped,
      ),
    ).toBe(15_200);
    // Tightening goes through as is.
    expect(
      audioReferenceTotalDurationLimitMs({ referenceAudioTotalMaxSeconds: 8 }, capped),
    ).toBe(8_000);
    // When not configured it is the hard cap itself.
    expect(audioReferenceTotalDurationLimitMs(null, capped)).toBe(15_200);
    // Without vendorCapMs (a model with unknown bounds) there is no hard cap to take, and 60s is used as is.
    expect(
      audioReferenceTotalDurationLimitMs({ referenceAudioTotalMaxSeconds: 60 }),
    ).toBe(60_000);
  });
});

describe("formatAudioDurationClips — the {{clips}} in the hint follows locale layout", () => {
  // Use the real translation.json rather than a fake t(): what is guarded here is "en users must not see CJK punctuation",
  // and a fake string cannot test it. Parsing + {{var}} interpolation matches i18next's default behavior (escapeValue: false).
  const locale = (language: "vi" | "en") => {
    const bundle = JSON.parse(
      readFileSync(`public/locales/${language}/translation.json`, "utf8"),
    );
    return (key: string, vars?: Record<string, string | number>) => {
      const value = key
        .split(".")
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], bundle);
      if (typeof value !== "string") throw new Error(`missing translation key: ${key}`);
      return value.replace(/{{(\w+)}}/g, (_, name: string) => String(vars?.[name] ?? ""));
    };
  };

  const CLIPS = [
    { label: "sfx.wav", durationMs: 900 },
    { label: "bgm.mp3", durationMs: 1_200 },
  ];

  it("vi uses half-width brackets + commas too", () => {
    expect(formatAudioDurationClips(CLIPS, locale("vi"))).toBe(
      "sfx.wav (0.9s), bgm.mp3 (1.2s)",
    );
  });

  it("English uses half-width brackets + commas, and leaks no CJK punctuation", () => {
    const formatted = formatAudioDurationClips(CLIPS, locale("en"));
    expect(formatted).toBe("sfx.wav (0.9s), bgm.mp3 (1.2s)");
    expect(formatted).not.toMatch(/[\u3000-\u303f\uff00-\uffef]/);
  });

  it("no separator for a single entry", () => {
    expect(formatAudioDurationClips([CLIPS[0]], locale("en"))).toBe("sfx.wav (0.9s)");
  });

  it("milliseconds hugging the threshold are not rounded to a legal value (otherwise the hint contradicts itself)", () => {
    // 1.799s was once displayed as "1.8s" and 15.201s as "15.2s" — what the user saw was exactly
    // a legal boundary value, yet they were told it is out of bounds. Display at millisecond precision, and do not go back to toFixed(1).
    expect(
      formatAudioDurationClips([{ label: "a.wav", durationMs: 1_799 }], locale("en")),
    ).toBe("a.wav (1.799s)");
    expect(
      formatAudioDurationClips([{ label: "b.wav", durationMs: 15_201 }], locale("en")),
    ).toBe("b.wav (15.201s)");
  });

  it("whole seconds carry no trailing 0", () => {
    expect(
      formatAudioDurationClips([{ label: "c.wav", durationMs: 6_000 }], locale("en")),
    ).toBe("c.wav (6s)");
    expect(
      formatAudioDurationClips([{ label: "d.wav", durationMs: 15_200 }], locale("en")),
    ).toBe("d.wav (15.2s)");
  });

  it("the fallback label when the file name is missing also follows the language (no longer hard-coded)", () => {
    expect(locale("vi")("node.videoNode.audio.clipFallbackLabel", { index: 2 })).toBe(
      "Âm thanh 2",
    );
    expect(locale("en")("node.videoNode.audio.clipFallbackLabel", { index: 2 })).toBe(
      "Audio 2",
    );
  });
});

describe("videoModeRequiresPrompt — submit validation by mode", () => {
  it("text-to-video / all reference must carry a prompt", () => {
    expect(videoModeRequiresPrompt("textToVideo")).toBe(true);
    expect(videoModeRequiresPrompt("allReference")).toBe(true);
  });

  it("first frame / image reference / first-last-frame / video edit allow an empty prompt", () => {
    for (const mode of [
      "firstFrame",
      "imageToVideo",
      "imageReference",
      "firstLastFrame",
      "videoEdit",
    ] as VideoGenMode[]) {
      expect(videoModeRequiresPrompt(mode)).toBe(false);
    }
  });
});

describe("videoModeRequiresMedia — whether the mode must have upstream assets", () => {
  it("text-to-video is the only mode that needs no assets", () => {
    expect(videoModeRequiresMedia("textToVideo")).toBe(false);
  });

  it("all reference needs assets too (the omni endpoint cannot send without assets)", () => {
    // It is **parallel** to videoModeRequiresPrompt rather than either-or: all reference needs both.
    // If only the prompt were checked, after assets are emptied the button would stay clickable, and clicking it is silently blocked by handleSubmit's
    // references.length === 0 — the user sees "clicked and nothing happened".
    expect(videoModeRequiresMedia("allReference")).toBe(true);
    expect(videoModeRequiresPrompt("allReference")).toBe(true);
  });

  it("all the other generation modes need assets", () => {
    for (const mode of [
      "firstFrame",
      "imageToVideo",
      "imageReference",
      "firstLastFrame",
      "videoEdit",
    ] as VideoGenMode[]) {
      expect(videoModeRequiresMedia(mode)).toBe(true);
    }
  });
});

describe("videoNoUpstreamResetMode — fall back to text-to-video once assets are emptied", () => {
  const EMPTY = { images: 0, videos: 0, audios: 0 };

  it("after the upstream is cleared, any asset mode falls back to text-to-video", () => {
    for (const mode of [
      "allReference",
      "imageReference",
      "firstFrame",
      "imageToVideo",
      "firstLastFrame",
      "videoEdit",
    ] as VideoGenMode[]) {
      expect(videoNoUpstreamResetMode(mode, EMPTY)).toBe("textToVideo");
    }
  });

  it("stays if it is already text-to-video (avoiding one patch per frame)", () => {
    expect(videoNoUpstreamResetMode("textToVideo", EMPTY)).toBeNull();
  });

  it.each([
    ["image", { images: 1, videos: 0, audios: 0 }],
    ["video", { images: 0, videos: 1, audios: 0 }],
    ["audio", { images: 0, videos: 0, audios: 1 }],
  ] as const)("stays when the upstream still has %s assets", (_label, counts) => {
    expect(videoNoUpstreamResetMode("allReference", counts)).toBeNull();
  });
});

describe("VideoNode wiring: assets emptied → text-to-video", () => {
  const source = readFileSync("src/features/canvas/nodes/VideoNode.tsx", "utf8");

  it("the reverse-reset effect judges by node type, not by resolved URLs", () => {
    // upstreamCounts (resolved URLs) would count an image node just laid out by the empty-state CTA with no image yet as 0,
    // and using it would push the three CTAs straight back to text-to-video.
    expect(source).toContain(
      "videoNoUpstreamResetMode(genMode, upstreamTypeCounts)",
    );
  });

  it("the reset does not enter the undo stack", () => {
    // This is a derived result of "the user deleted assets", not an independent change; recording it in past would let this effect immediately undo
    // ⌘Z and also clear the redo stack, blocking the path of "going back to before the connection".
    expect(source).toContain(
      "updateNodeData(id, { genMode: target }, { recordHistory: false });",
    );
  });

  it("the submit gate splits prompt and assets into two parallel checks", () => {
    expect(source).toContain(
      "(videoModeRequiresPrompt(genMode) && !hasPromptText) ||\n      (videoModeRequiresMedia(genMode) && !hasRequiredMediaForMode);",
    );
    // The old ternary: a mode that needs a prompt no longer looks at assets — so all reference slipped through.
    expect(source).not.toContain(
      "videoModeRequiresPrompt(genMode)\n        ? !hasPromptText\n        : !hasRequiredMediaForMode",
    );
  });
});


describe("node-specific video modes", () => {
  const textOnly = { id: "text-only", supportedModes: ["text_to_video"] };
  it("rejects unsupported modes even when a single image is present", () => {
    expect(videoSubmitMediaRejectionReason("imageToVideo", textOnly,
      { images: 1, videos: 0, audios: 0 })).toBe("node.videoModel.reason.modeUnsupported");
  });
  it("does not infer or silently discard image input for a text-only model", () => {
    expect(videoUpstreamImageDefaultMode(textOnly)).toBeNull();
    expect(videoSubmitMediaRejectionReason("textToVideo", textOnly,
      { images: 1, videos: 0, audios: 0 })).toBe("node.videoModel.reason.imageUnsupported");
    expect(videoSubmitMediaRejectionReason("textToVideo", textOnly,
      { images: 0, videos: 0, audios: 0 })).toBeNull();
  });
});

// MiniMax H3 Multishot (2026-10-25) — runpod_minimax_h3_multishot's catalog
// entry declares supportedModes: ["multishot"] only (api/routes/freezone.py's
// _freezone_dev_media_model_catalog_entries), so it is a multishot-ONLY
// model: no text_to_video, no image modes a 1-shot model would have.
describe("MiniMax H3 Multishot", () => {
  const multishotOnly = {
    apiModel: "runpod_minimax_h3_multishot",
    supportedModes: ["multishot"],
    referenceImageMax: 3,
    maxShots: 2,
  };
  const multishot1Shot = {
    apiModel: "runpod_minimax_h3",
    supportedModes: ["text_to_video", "first_frame", "image_reference"],
  };

  it("the frontend mode -> catalog capability mapping is identity", () => {
    expect(GEN_MODE_TO_CATALOG_MODE.multishot).toBe("multishot");
  });

  it("is supported ONLY via an explicit catalog declaration, never by heuristics", () => {
    expect(isVideoModeSupportedByModel("multishot", multishotOnly)).toBe(true);
    // No supportedModes at all (a legacy/heuristic model id) must never be
    // treated as multishot-capable — there is no legacy model this applies to.
    expect(isVideoModeSupportedByModel("multishot", "some-legacy-model-id")).toBe(false);
    expect(isVideoModeSupportedByModel("multishot", null)).toBe(false);
  });

  it("a multishot-only model does not support any 1-shot mode", () => {
    for (const mode of [
      "textToVideo",
      "firstFrame",
      "imageToVideo",
      "firstLastFrame",
      "imageReference",
      "allReference",
      "videoEdit",
      "videoExtend",
    ] as const) {
      expect(isVideoModeSupportedByModel(mode, multishotOnly)).toBe(false);
    }
  });

  it("isMultishotOnlyModel distinguishes the multishot backend from the 1-shot H3 backend", () => {
    expect(isMultishotOnlyModel(multishotOnly)).toBe(true);
    expect(isMultishotOnlyModel(multishot1Shot)).toBe(false);
    expect(isMultishotOnlyModel("runpod_minimax_h3_multishot")).toBe(false); // bare string: no supportedModes to read
  });

  it("videoModelDefaultMode lands a multishot-only model on multishot, not textToVideo", () => {
    expect(videoModelDefaultMode(multishotOnly)).toBe("multishot");
    expect(videoModelDefaultMode(multishot1Shot)).toBe("textToVideo");
  });

  it("the empty-state CTA and upstream-image default both include multishot for a multishot-only model", () => {
    expect(videoEmptyStateCtaModes(multishotOnly)).toEqual(["multishot"]);
    expect(videoUpstreamImageDefaultMode(multishotOnly)).toBe("multishot");
  });

  it("accepts multiple images (start frame + shared references), unlike a single-image-only model", () => {
    expect(videoModelAcceptsMultipleImages(multishotOnly)).toBe(true);
  });

  it("does not reset to textToVideo when upstream assets are cleared (textToVideo is unsupported)", () => {
    expect(
      videoNoUpstreamResetMode("multishot", { images: 0, videos: 0, audios: 0 }),
    ).toBeNull();
    expect(
      videoNoUpstreamResetMode("multishot", { images: 1, videos: 0, audios: 0 }),
    ).toBeNull();
  });

  it("an attached image is never flagged imageUnsupported for a multishot-only model", () => {
    // Before adding "multishot" to videoEmptyStateCtaModes' order list, this
    // model's CTA list was empty for every mode, so ANY attached image on a
    // multishot node incorrectly read as imageUnsupported.
    expect(
      videoSubmitMediaRejectionReason("multishot", multishotOnly, {
        images: 1,
        videos: 0,
        audios: 0,
      }),
    ).toBeNull();
  });

  it("flags too many images past 1 start frame + referenceImageMax shared references", () => {
    // 1 start frame + 3 shared refs = 4 is the cap for this model.
    expect(
      videoSubmitMediaRejectionReason("multishot", multishotOnly, {
        images: 4,
        videos: 0,
        audios: 0,
      }),
    ).toBeNull();
    expect(
      videoSubmitMediaRejectionReason("multishot", multishotOnly, {
        images: 5,
        videos: 0,
        audios: 0,
      }),
    ).toBe("node.videoModel.reason.multishotTooManyImages");
  });

  it("video and audio assets are rejected (multishot takes images only)", () => {
    expect(
      videoSubmitMediaRejectionReason("multishot", multishotOnly, {
        images: 1,
        videos: 1,
        audios: 0,
      }),
    ).toBe("node.videoModel.reason.videoUnsupported");
    expect(
      videoSubmitMediaRejectionReason("multishot", multishotOnly, {
        images: 1,
        videos: 0,
        audios: 1,
      }),
    ).toBe("node.videoModel.reason.audioUnsupported");
  });

  it("the model-selector disabled reason matches the submit guard for the image cap", () => {
    expect(
      videoModelReferenceDisabledReason(multishotOnly, { images: 4, videos: 0, audios: 0 }),
    ).toBeNull();
    expect(
      videoModelReferenceDisabledReason(multishotOnly, { images: 5, videos: 0, audios: 0 }),
    ).toBe("node.videoModel.reason.multishotTooManyImages");
  });

  it("falls back to a 3-image shared-reference cap when the model has no referenceImageMax yet", () => {
    const noMaxYet = { apiModel: "runpod_minimax_h3_multishot", supportedModes: ["multishot"] };
    expect(
      videoSubmitMediaRejectionReason("multishot", noMaxYet, { images: 4, videos: 0, audios: 0 }),
    ).toBeNull();
    expect(
      videoSubmitMediaRejectionReason("multishot", noMaxYet, { images: 5, videos: 0, audios: 0 }),
    ).toBe("node.videoModel.reason.multishotTooManyImages");
  });
});

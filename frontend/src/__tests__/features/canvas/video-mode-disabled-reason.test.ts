// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { describe, expect, it } from "vitest";

import { videoModeDisabledReason } from "@/features/canvas/nodes/VideoOperationsPanel";
import { enT } from "../../helpers/i18n-fixtures";

const NONE = { videos: 0, images: 0, audios: 0 };

/** A non-HappyHorse model that declares video_edit in the catalog (such as seedance-2.0-mini / 2.5). */
const WITH_VIDEO_EDIT = [
  "text_to_video",
  "first_frame",
  "first_last_frame",
  "all_reference",
  "image_reference",
  "video_edit",
];
/** Seedance 2.0 without video_edit. */
const WITHOUT_VIDEO_EDIT = [
  "text_to_video",
  "first_frame",
  "first_last_frame",
  "all_reference",
  "image_reference",
];
const WITH_VIDEO_EXTEND = [...WITHOUT_VIDEO_EDIT, "video_extend"];

describe("videoModeDisabledReason — mode availability when a video is connected upstream", () => {
  /**
   * Regression: after 1 video was connected, "Video edit" was grayed out, with the hover saying "With video upstream, only
   * 'All reference' is available". That rule was written back when video edit was HappyHorse-only; later the
   * catalog's models also declared video_edit, and the tab showed up yet was implicated by the same rule.
   */
  it("allows 'Video edit' when 1 video is connected (the model declares video_edit)", () => {
    expect(
      videoModeDisabledReason(
        "videoEdit",
        "seedance-2.0-mini",
        { ...NONE, videos: 1 },
        enT,
        WITH_VIDEO_EDIT,
      ),
    ).toBeNull();
  });

  it("still blocks the other modes when a video is connected, and the hint names the 'Video edit' way out", () => {
    for (const mode of ["textToVideo", "firstFrame", "firstLastFrame", "imageReference"] as const) {
      expect(
        videoModeDisabledReason(mode, "seedance-2.0-mini", { ...NONE, videos: 1 }, enT, WITH_VIDEO_EDIT),
      ).toBe("With video upstream, only “All reference” or “Video edit” are available");
    }
    expect(
      videoModeDisabledReason(
        "allReference",
        "seedance-2.0-mini",
        { ...NONE, videos: 1 },
        enT,
        WITH_VIDEO_EDIT,
      ),
    ).toBeNull();
  });

  it("when the model has no video_edit the hint does not mention that way out", () => {
    expect(
      videoModeDisabledReason(
        "textToVideo",
        "seedance-2.0",
        { ...NONE, videos: 1 },
        enT,
        WITHOUT_VIDEO_EDIT,
      ),
    ).toBe("With video upstream, only “All reference” is available");
  });

  it("with no video connected, 'Video edit' says to connect one", () => {
    expect(
      videoModeDisabledReason("videoEdit", "seedance-2.0-mini", NONE, enT, WITH_VIDEO_EDIT),
    ).toBe("Connect a video node (exactly 1)");
  });

  it("'Video edit' is unavailable when several videos are connected", () => {
    expect(
      videoModeDisabledReason(
        "videoEdit",
        "seedance-2.0-mini",
        { ...NONE, videos: 2 },
        enT,
        WITH_VIDEO_EDIT,
      ),
    ).toBe("“Video edit” supports exactly 1 connected video node");
  });

  it("when the model does not support video edit, it says so is the model's matter, not the upstream's", () => {
    expect(
      videoModeDisabledReason(
        "videoEdit",
        "seedance-2.0",
        { ...NONE, videos: 1 },
        enT,
        WITHOUT_VIDEO_EDIT,
      ),
    ).toBe("This model doesn't support “Video edit”");
  });

  /** HappyHorse takes its own branch, and this change must not touch it. */
  it("HappyHorse's existing judgments are unaffected", () => {
    expect(videoModeDisabledReason("videoEdit", "happyhorse-1.0", { ...NONE, videos: 1 }, enT)).toBeNull();
    expect(videoModeDisabledReason("videoEdit", "happyhorse-1.0", NONE, enT)).toBe(
      "Connect a video node (exactly 1)",
    );
    expect(videoModeDisabledReason("textToVideo", "happyhorse-1.0", { ...NONE, videos: 1 }, enT)).toBe(
      "A video node is connected — use “Video edit”",
    );
  });

  it("video extend requires the model to declare the capability and exactly one source video connected", () => {
    expect(
      videoModeDisabledReason(
        "videoExtend",
        "seedance-2.5",
        { ...NONE, videos: 1 },
        enT,
        WITH_VIDEO_EXTEND,
      ),
    ).toBeNull();
    expect(
      videoModeDisabledReason(
        "videoExtend",
        "seedance-2.5",
        { ...NONE, videos: 1, images: 1 },
        enT,
        WITH_VIDEO_EXTEND,
      ),
    ).toBe("“Video extend” accepts only the source video; remove image or audio assets");
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFn } from "@/lib/i18n-types";

/**
 * The "input -> product" rows in the task details (metadata source_label /
 * target_label) are fixed English strings written by the freezone routes.
 *
 * They go through a display-layer dictionary instead of "backend sends a code":
 * `source_label` is not only a display string, freezone.py also uses it as pipeline
 * data (written into canvas_scene_refs[].label), so the backend value stays as is and
 * is only translated at render time. Unknown values are shown unchanged.
 */
const TASK_IO_LABEL_KEYS: Record<string, string> = {
  // source_label
  "Beat context": "taskCenter.io.beatContext",
  "Master + Reverse": "taskCenter.io.masterReverse",
  "Scene Master + Reverse": "taskCenter.io.sceneMasterReverse",
  "Director composite": "taskCenter.io.directorComposite",
  Background: "taskCenter.io.background",
  "Current background": "taskCenter.io.currentBackground",
  "Background candidate": "taskCenter.io.backgroundCandidate",
  "Input reference": "taskCenter.io.inputReference",
  "Sketch + background + identities/props": "taskCenter.io.sketchBackgroundIdentityProps",
  // target_label
  "360 panorama": "taskCenter.io.pano360",
  "Current sketch": "taskCenter.io.currentSketch",
  "Sketch candidate": "taskCenter.io.sketchCandidate",
  "Current sketch candidate": "taskCenter.io.currentSketchCandidate",
  "Current storyboard": "taskCenter.io.currentStoryboard",
  "Storyboard candidate": "taskCenter.io.storyboardCandidate",
};

/** Returns the localized text for a known input/product label, or the raw value otherwise. */
export function taskIoLabel(value: string | null | undefined, t: TFn): string {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  const key = TASK_IO_LABEL_KEYS[raw];
  return key ? t(key) : raw;
}

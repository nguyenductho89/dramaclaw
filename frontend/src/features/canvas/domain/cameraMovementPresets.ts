// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Camera-movement presets. Fallback list used when
// `/freezone/video/camera-templates` is loading or unavailable. The runtime
// source of truth is the backend endpoint, fetched via
// `useFreezoneVideoCameraTemplates`. Mirrors libtv's 23-entry camera-movement catalog;
// each entry ships with a short .mp4 preview at `public/video/camera-presets/`.

import type { FreezoneVideoCameraTemplate } from "@/api/ops";
import type { TFn } from "@/lib/i18n-types";

export type CameraMovementPreset = FreezoneVideoCameraTemplate;

// This table is a local fallback copy of the structure returned by the backend `/freezone/video/camera-templates`:
// label should match the English label returned by the backend exactly (the reverse lookups below match
// the local mp4 by label/promptFragment), and promptFragment is content spliced into the prompt and read by the model.
// Neither is translated per language; the text shown in the UI goes through cameraMovementPresetLabel(), looking up an entry by id.
// i18n-exempt-start
export const CAMERA_MOVEMENT_PRESETS: ReadonlyArray<CameraMovementPreset> = [
  { id: 'fixed', label: 'Locked-off shot', videoUrl: '/video/camera-presets/fixed.mp4', promptFragment: 'Locked-off shot' },
  { id: 'follow', label: 'Follow shot', videoUrl: '/video/camera-presets/follow.mp4', promptFragment: 'Follow shot' },
  { id: 'spiral-up', label: 'Orbit and rise', videoUrl: '/video/camera-presets/spiral-up.mp4', promptFragment: 'Camera orbits and rises' },
  { id: 'spiral-down', label: 'Orbit and descend', videoUrl: '/video/camera-presets/spiral-down.mp4', promptFragment: 'Camera orbits and descends' },
  { id: 'tilt-up', label: 'Tilt up', videoUrl: '/video/camera-presets/tilt-up.mp4', promptFragment: 'Camera tilts up' },
  { id: 'tilt-down', label: 'Tilt down', videoUrl: '/video/camera-presets/tilt-down.mp4', promptFragment: 'Camera tilts down' },
  { id: 'pan-left', label: 'Pan left', videoUrl: '/video/camera-presets/pan-left.mp4', promptFragment: 'Camera pans left' },
  { id: 'pan-right', label: 'Pan right', videoUrl: '/video/camera-presets/pan-right.mp4', promptFragment: 'Camera pans right' },
  { id: 'crane-up', label: 'Pedestal up', videoUrl: '/video/camera-presets/crane-up.mp4', promptFragment: 'Camera rises' },
  { id: 'crane-down', label: 'Pedestal down', videoUrl: '/video/camera-presets/crane-down.mp4', promptFragment: 'Camera descends' },
  { id: 'truck-left', label: 'Truck left', videoUrl: '/video/camera-presets/truck-left.mp4', promptFragment: 'Camera trucks left' },
  { id: 'truck-right', label: 'Truck right', videoUrl: '/video/camera-presets/truck-right.mp4', promptFragment: 'Camera trucks right' },
  { id: 'dolly-in', label: 'Dolly in', videoUrl: '/video/camera-presets/dolly-in.mp4', promptFragment: 'Camera dollies in' },
  { id: 'dolly-out', label: 'Dolly out', videoUrl: '/video/camera-presets/dolly-out.mp4', promptFragment: 'Camera dollies out' },
  { id: 'zoom-in', label: 'Zoom in', videoUrl: '/video/camera-presets/zoom-in.mp4', promptFragment: 'Zoom in' },
  { id: 'zoom-out', label: 'Zoom out', videoUrl: '/video/camera-presets/zoom-out.mp4', promptFragment: 'Zoom out' },
  { id: 'dolly-zoom', label: 'Dolly zoom', videoUrl: '/video/camera-presets/dolly-zoom.mp4', promptFragment: 'Dolly zoom (vertigo effect)' },
  { id: 'orbit', label: 'Orbit shot', videoUrl: '/video/camera-presets/orbit.mp4', promptFragment: 'Camera orbits the subject' },
  { id: 'roll', label: 'Barrel roll', videoUrl: '/video/camera-presets/roll.mp4', promptFragment: 'Camera barrel roll' },
  { id: 'fpv', label: 'First-person view', videoUrl: '/video/camera-presets/fpv.mp4', promptFragment: 'First-person view shot' },
  { id: 'drone', label: 'Drone', videoUrl: '/video/camera-presets/drone.mp4', promptFragment: 'Drone aerial shot' },
  { id: 'aerial', label: 'High aerial', videoUrl: '/video/camera-presets/aerial.mp4', promptFragment: 'High-altitude aerial shot' },
  { id: 'handheld', label: 'Handheld', videoUrl: '/video/camera-presets/handheld.mp4', promptFragment: 'Handheld shot' },
];
// i18n-exempt-end

/**
 * Display label for a camera preset. Locale entry keyed by preset id; the
 * backend-supplied `label` stays the fallback for templates we don't ship.
 */
export function cameraMovementPresetLabel(preset: CameraMovementPreset, t: TFn): string {
  return t(`canvas.cameraMovement.presets.${preset.id}`, { defaultValue: preset.label });
}

export function findCameraMovementPreset(
  templates: ReadonlyArray<CameraMovementPreset>,
  id: string | null | undefined,
): CameraMovementPreset | null {
  if (!id) return null;
  return templates.find((preset) => preset.id === id) ?? null;
}

// Reverse lookups built from the bundled 23-entry catalog so backend templates
// without a `videoUrl` can borrow the matching local mp4 (`public/video/
// camera-presets/<id>.mp4`). The backend likely returns English labels /
// promptFragments verbatim — match those first; id fallback covers the case
// where backend ids happen to align with our kebab-case ones.
const LOCAL_VIDEO_URL_BY_ID = new Map<string, string>();
const LOCAL_VIDEO_URL_BY_LABEL = new Map<string, string>();
const LOCAL_VIDEO_URL_BY_FRAGMENT = new Map<string, string>();
for (const preset of CAMERA_MOVEMENT_PRESETS) {
  if (!preset.videoUrl) continue;
  LOCAL_VIDEO_URL_BY_ID.set(preset.id, preset.videoUrl);
  LOCAL_VIDEO_URL_BY_LABEL.set(preset.label.trim(), preset.videoUrl);
  LOCAL_VIDEO_URL_BY_FRAGMENT.set(preset.promptFragment.trim(), preset.videoUrl);
}

/**
 * Resolve a preview video URL for a camera preset. Priority:
 *   1. The template's own `videoUrl` (backend-supplied).
 *   2. Local mp4 matched by exact English label.
 *   3. Local mp4 matched by exact promptFragment.
 *   4. Local mp4 matched by id.
 * Returns null if nothing matches (caller should skip rendering <video>).
 */
export function resolveCameraPresetVideoUrl(
  preset: CameraMovementPreset,
): string | null {
  if (preset.videoUrl) return preset.videoUrl;
  const label = preset.label.trim();
  const fragment = preset.promptFragment.trim();
  return (
    LOCAL_VIDEO_URL_BY_LABEL.get(label) ??
    LOCAL_VIDEO_URL_BY_FRAGMENT.get(fragment) ??
    LOCAL_VIDEO_URL_BY_ID.get(preset.id) ??
    null
  );
}

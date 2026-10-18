// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { apiCall } from "./client";

/**
 * The Beat's selected_background.png comes from "pick a source -> copy" of the scene assets (master / reverse / director_env).
 * The backend implementation is in utils/background_anchor.py
 * (select_background_anchor) + the route PATCH /background-anchor.
 *
 * The frontend exposes this API on the beat workbench - the user clicks the "Use as background source" button on a scene_master /
 * scene_reverse_master node -> this is called -> the selected background is
 * refreshed into this beat's slot.
 *
 * Supported anchor_id (see background_anchor.py:22-25):
 *   - "master"               (= the scene_master image)
 *   - "reverse"              (= the scene_reverse_master image)
 *   - "director_env_only"    (= the director-stage environment render, without actors)
 *   - "selected_background"  (self, already selected; generally not set actively)
 *
 * scene_director_pano_360 / scene_3gs_*_ply are not directly supported for now (a 360 panorama is 2:1 and
 * needs a cropper to pick a region; a 3GS world needs a capture screenshot first). These two are left for later cropper
 * / capture step UI integration.
 */
export type BackgroundAnchorId =
  | "master"
  | "reverse"
  | "director_env_only"
  | "selected_background";

export interface BackgroundAnchorsResponse {
  ok: boolean;
  data?: {
    scene_id?: string;
    selected_anchor_id?: string;
    anchors?: Array<{
      id?: string;
      anchor_id?: string;
      label?: string;
      url?: string;
      exists?: boolean;
    }>;
  };
  error?: string;
}

/**
 * PATCH /background-anchor - choose anchor_id as the beat's background source,
 * and the backend snapshots the matching source file (master.png / reverse.png etc.) into
 * the beat's selected_background.png slot.
 */
export async function selectBeatBackgroundAnchor(
  project: string,
  episode: number,
  beat: number,
  anchorId: BackgroundAnchorId,
): Promise<BackgroundAnchorsResponse> {
  return await apiCall<BackgroundAnchorsResponse>(
    `projects/${encodeURIComponent(project)}/episodes/${episode}/beats/${beat}/background-anchor`,
    {
      method: "PATCH",
      json: { anchor_id: anchorId },
    },
  );
}

/**
 * POST /background-anchor/upload - upload an external image as the beat's
 * selected_background.png. The backend converts to RGB + saves + updates scene_ref.
 *
 * Use: the current-view screenshot of a 360 panorama + the framing screenshot of a 3GS world - these two sources
 * are not fixed files directly supported by anchor_id (master/reverse/director_env_only),
 * but blobs produced live by framing in the viewer, so they go through the upload path.
 *
 * Backend multipart/form-data, field name 'file'.
 */
export async function uploadBeatBackgroundAnchor(
  project: string,
  episode: number,
  beat: number,
  blob: Blob,
  filename: string,
): Promise<BackgroundAnchorsResponse> {
  const form = new FormData();
  form.append("file", blob, filename);
  return await apiCall<BackgroundAnchorsResponse>(
    `projects/${encodeURIComponent(project)}/episodes/${episode}/beats/${beat}/background-anchor/upload`,
    {
      method: "POST",
      body: form,
      // No timeout on uploads: the clock would race the user's uplink, not the
      // server (see uploadApi in lib/api.ts).
      timeout: false,
    },
  );
}

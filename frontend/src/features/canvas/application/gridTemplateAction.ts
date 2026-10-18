// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { type FreezoneTemplateEditMode } from '@/api/ops';

/**
 * Grid template action key. Shared by the two views: the workflow toolbar's "3x3 grid" dropdown and the storyboard detail toolbar's
 * "Grid templates" dropdown; after selection both go through the same "build a feature node first -> only submit with the up button" interaction
 * (see {@link ../application/assetBoardImageOps#spawnAssetBoardImageOpNode}).
 */
export type GridActionKey =
  | 'multiCameraGrid'
  | 'plotFourGrid'
  | 'faceThreeView'
  | 'productThreeView'
  | 'serialStoryboard25'
  | 'cinematicLightCorrection'
  | 'characterThreeView'
  | 'sceneSettingSheet'
  | 'frameProjection3sLater'
  | 'frameProjection5sEarlier';

export const GRID_ACTION_MODE_MAP: Record<GridActionKey, FreezoneTemplateEditMode> = {
  multiCameraGrid: 'multi_camera_nine_grid',
  plotFourGrid: 'story_pitch_four_grid',
  faceThreeView: 'character_face_three_view',
  productThreeView: 'product_three_view',
  serialStoryboard25: 'storyboard_25_grid',
  cinematicLightCorrection: 'cinematic_light_correction',
  characterThreeView: 'character_three_view_generation',
  sceneSettingSheet: 'scene_setting_sheet',
  frameProjection3sLater: 'image_projection_after_3s',
  frameProjection5sEarlier: 'image_projection_before_5s',
};

/** Whether the image model supports the quality parameter (the grid live-price query needs to carry the right params per model). */
export function imageModelSupportsQuality(apiModel: string | null | undefined): boolean {
  const normalized = String(apiModel ?? '').trim().toLowerCase();
  return (
    normalized === 'gpt-image-2'
    || normalized === 'image-2'
    || normalized === 'image-2-official'
    || normalized.includes('gpt-image')
  );
}

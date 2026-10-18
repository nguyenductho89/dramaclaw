// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import {
  fetchFreezoneJobResult,
  submitFreezoneScene360,
  submitFreezoneTemplateEdit,
  DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO,
  FREEZONE_SCENE_360_ASPECT_RATIOS,
  type FreezoneJobRef,
  type FreezoneScene360AspectRatio,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import {
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  EXPORT_RESULT_NODE_DEFAULT_WIDTH,
  EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
} from '@/features/canvas/domain/canvasNodes';
import { readUrl } from '@/lib/url-params';
import { useCanvasStore } from '@/stores/canvasStore';

import { GRID_ACTION_MODE_MAP, type GridActionKey } from './gridTemplateAction';
import { generationTaskDescriptor } from './resumeGeneration';

/**
 * One-image "feature" key. = 11 capabilities: 10 grid templates (reusing
 * {@link GRID_ACTION_MODE_MAP}) + panorama.
 *
 * The interaction is now exactly the same in both views: click a feature -> first build an empty image generation node (node name = feature name)
 * -> edit the prompt/reference images/ratio in its input box, or switch to another feature -> only submit with the up button.
 * The workflow side's old "confirm to submit" floating bar (GridActionConfirmOverlay) was removed at the user's request.
 *
 * Multi-angle / lighting are **not in this table** (removed at the user's request): their value lies in the slider groups for orbit angle, pitch angle,
 * shot size / brightness, color temperature, key light direction, and degrading to "one prompt, click generate" is not useful;
 * the two complete editors on the detail toolbar remain and go through the workflow's "confirm to submit".
 */
export type AssetBoardImageOpKey = GridActionKey | 'scene360';

/** Grouping of the feature box (matches liblib's four columns: storyboard narrative / space & camera / design sheets / texture tuning). */
export type AssetBoardImageOpCategoryKey = 'narrative' | 'space' | 'setting' | 'texture';

export interface AssetBoardImageOpDef {
  key: AssetBoardImageOpKey;
  /** Feature name. Also the displayName of the new node, and the prompt sent when the prompt is empty. */
  label: string;
  /** A short line under the feature name in the feature box (one sentence on what this feature produces). */
  summary: string;
  /** Placeholder text of the input box after this feature is selected (matches liblib "Click to generate, directly based on the current image..."). */
  description: string;
  category: AssetBoardImageOpCategoryKey;
  /** Hard-coded fallback compute cost used for pricing (shown when the live price has not come back, same source as the toolbar). */
  cost: number;
}

export const ASSET_BOARD_IMAGE_OP_CATEGORY_LABELS: Record<
  AssetBoardImageOpCategoryKey,
  string
> = {
  get narrative() { return i18n.t('canvas.assetBoard.imageOps.category.narrative'); },
  get space() { return i18n.t('canvas.assetBoard.imageOps.category.space'); },
  get setting() { return i18n.t('canvas.assetBoard.imageOps.category.setting'); },
  get texture() { return i18n.t('canvas.assetBoard.imageOps.category.texture'); },
};

/**
 * The feature list. label has the same name as the toolbar's `GRID_ACTION_DEFS` / the panorama, multi-angle, lighting buttons -
 * one capability must go by the same name in both views.
 */
export const ASSET_BOARD_IMAGE_OPS: readonly AssetBoardImageOpDef[] = [
  {
    key: 'plotFourGrid',
    get label() { return i18n.t('nodeToolbar.gridMenu.plotFourGrid'); },
    get summary() { return i18n.t('canvas.assetBoard.imageOps.feature.plotFourGrid.summary'); },
    get description() { return i18n.t('canvas.assetBoard.imageOps.feature.plotFourGrid.description'); },
    category: 'narrative',
    cost: 8,
  },
  {
    key: 'serialStoryboard25',
    get label() { return i18n.t('nodeToolbar.gridMenu.serialStoryboard25'); },
    get summary() { return i18n.t('canvas.assetBoard.imageOps.feature.serialStoryboard25.summary'); },
    get description() { return i18n.t('canvas.assetBoard.imageOps.feature.serialStoryboard25.description'); },
    category: 'narrative',
    cost: 32,
  },
  {
    key: 'frameProjection3sLater',
    get label() { return i18n.t('nodeToolbar.gridMenu.frameProjection3sLater'); },
    get summary() { return i18n.t('canvas.assetBoard.imageOps.feature.frameProjection3sLater.summary'); },
    get description() { return i18n.t('canvas.assetBoard.imageOps.feature.frameProjection3sLater.description'); },
    category: 'narrative',
    cost: 4,
  },
  {
    key: 'frameProjection5sEarlier',
    get label() { return i18n.t('nodeToolbar.gridMenu.frameProjection5sEarlier'); },
    get summary() { return i18n.t('canvas.assetBoard.imageOps.feature.frameProjection5sEarlier.summary'); },
    get description() { return i18n.t('canvas.assetBoard.imageOps.feature.frameProjection5sEarlier.description'); },
    category: 'narrative',
    cost: 4,
  },
  {
    key: 'multiCameraGrid',
    get label() { return i18n.t('nodeToolbar.gridMenu.multiCameraGrid'); },
    get summary() { return i18n.t('canvas.assetBoard.imageOps.feature.multiCameraGrid.summary'); },
    get description() { return i18n.t('canvas.assetBoard.imageOps.feature.multiCameraGrid.description'); },
    category: 'space',
    cost: 14,
  },
  {
    key: 'scene360',
    get label() { return i18n.t('canvas.assetBoard.imageOps.pano'); },
    get summary() { return i18n.t('canvas.assetBoard.imageOps.feature.scene360.summary'); },
    get description() { return i18n.t('canvas.assetBoard.imageOps.feature.scene360.description'); },
    category: 'space',
    cost: 10,
  },
  {
    key: 'characterThreeView',
    get label() { return i18n.t('nodeToolbar.gridMenu.characterThreeView'); },
    get summary() { return i18n.t('canvas.assetBoard.imageOps.feature.characterThreeView.summary'); },
    get description() { return i18n.t('canvas.assetBoard.imageOps.feature.characterThreeView.description'); },
    category: 'setting',
    cost: 6,
  },
  {
    key: 'faceThreeView',
    get label() { return i18n.t('nodeToolbar.gridMenu.faceThreeView'); },
    get summary() { return i18n.t('canvas.assetBoard.imageOps.feature.faceThreeView.summary'); },
    get description() { return i18n.t('canvas.assetBoard.imageOps.feature.faceThreeView.description'); },
    category: 'setting',
    cost: 6,
  },
  {
    key: 'productThreeView',
    get label() { return i18n.t('nodeToolbar.gridMenu.productThreeView'); },
    get summary() { return i18n.t('canvas.assetBoard.imageOps.feature.productThreeView.summary'); },
    get description() { return i18n.t('canvas.assetBoard.imageOps.feature.productThreeView.description'); },
    category: 'setting',
    cost: 6,
  },
  {
    key: 'sceneSettingSheet',
    get label() { return i18n.t('nodeToolbar.gridMenu.sceneSettingSheet'); },
    get summary() { return i18n.t('canvas.assetBoard.imageOps.feature.sceneSettingSheet.summary'); },
    get description() { return i18n.t('canvas.assetBoard.imageOps.feature.sceneSettingSheet.description'); },
    category: 'setting',
    cost: 6,
  },
  {
    key: 'cinematicLightCorrection',
    get label() { return i18n.t('nodeToolbar.gridMenu.cinematicLightCorrection'); },
    get summary() { return i18n.t('canvas.assetBoard.imageOps.feature.cinematicLightCorrection.summary'); },
    get description() { return i18n.t('canvas.assetBoard.imageOps.feature.cinematicLightCorrection.description'); },
    category: 'texture',
    cost: 4,
  },
];

export const ASSET_BOARD_IMAGE_OP_MAP: Record<AssetBoardImageOpKey, AssetBoardImageOpDef> =
  Object.fromEntries(ASSET_BOARD_IMAGE_OPS.map((op) => [op.key, op])) as Record<
    AssetBoardImageOpKey,
    AssetBoardImageOpDef
  >;

export function isAssetBoardImageOpKey(value: unknown): value is AssetBoardImageOpKey {
  return typeof value === 'string' && value in ASSET_BOARD_IMAGE_OP_MAP;
}

/**
 * Whether it is one of the 9 grid templates. Useful for pricing: grids go through `image_selection`, while panorama has no matching
 * pricing basis, and it is better not to show anything than to put a text-to-image price on it and mislead.
 */
export function isGridImageOpKey(key: AssetBoardImageOpKey): key is GridActionKey {
  return key in GRID_ACTION_MODE_MAP;
}

const isGridOpKey = isGridImageOpKey;

function readString(data: Record<string, unknown>, field: string): string | null {
  const value = data[field];
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Clicking a feature = **create the node first, do not submit**: build an empty imageGen node downstream of the source node and connect an edge,
 * node name = feature name, `imageOpKey` remembers the selected feature, `imageOpSourceUrl` remembers the source image.
 * The workflow toolbar's "3x3 grid" dropdown and the storyboard detail toolbar both go through here.
 *
 * Building imageGen (rather than the exportImage result node used for orchestration) is a precondition of this interaction: both views only
 * render generation forms for imageGen / video nodes, and with no form there is no input box and the feature chip has nowhere to hang.
 *
 * @returns the new node id; null when the source node no longer exists.
 */
export function spawnAssetBoardImageOpNode(
  sourceNodeId: string,
  imageSource: string,
  opKey: AssetBoardImageOpKey,
): string | null {
  const def = ASSET_BOARD_IMAGE_OP_MAP[opKey];
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === sourceNodeId);
  if (!node) {
    return null;
  }

  const sourceAspectRatio =
    readString(node.data as Record<string, unknown>, 'aspectRatio') ?? DEFAULT_ASPECT_RATIO;
  const position = store.findNodePosition(
    node.id,
    EXPORT_RESULT_NODE_DEFAULT_WIDTH,
    EXPORT_RESULT_NODE_LAYOUT_HEIGHT,
  );
  const nextNodeId = store.addNode(
    CANVAS_NODE_TYPES.imageGen,
    position,
    {
      displayName: def.label,
      prompt: '',
      imageUrl: null,
      previewImageUrl: null,
      // A panorama product is an ultra-wide image anyway, so set the node ratio right first so the user does not have to adjust it.
      aspectRatio: opKey === 'scene360' ? DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO : sourceAspectRatio,
      imageOpKey: opKey,
      imageOpSourceUrl: imageSource.split('?')[0],
      isGenerating: false,
      generationStartedAt: null,
      generationError: null,
    } as unknown as Parameters<typeof store.addNode>[2],
  );
  store.addEdge(node.id, nextNodeId);
  return nextNodeId;
}

/** Switch the feature in the feature box: change the key + rename the node accordingly (when the user has not renamed it). */
export function switchAssetBoardImageOp(nodeId: string, nextKey: AssetBoardImageOpKey): void {
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  const data = node.data as Record<string, unknown>;
  const currentKey = data.imageOpKey;
  if (currentKey === nextKey) return;
  const nextDef = ASSET_BOARD_IMAGE_OP_MAP[nextKey];
  // Only follow along when the node name is still the previous feature name (= not edited by the user); otherwise respect the user's name.
  const currentLabel = isAssetBoardImageOpKey(currentKey)
    ? ASSET_BOARD_IMAGE_OP_MAP[currentKey].label
    : null;
  const displayName = readString(data, 'displayName');
  const patch: Record<string, unknown> = { imageOpKey: nextKey };
  if (!displayName || displayName === currentLabel) {
    patch.displayName = nextDef.label;
  }
  if (nextKey === 'scene360') {
    patch.aspectRatio = DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO;
  }
  store.updateNodeData(nodeId, patch);
}

/** Close the chip: degrade to a plain image generation node (the up button goes through regular text-to-image / image-to-image). */
export function clearAssetBoardImageOp(nodeId: string): void {
  useCanvasStore.getState().updateNodeData(nodeId, { imageOpKey: null });
}

function resolveScene360AspectRatio(data: Record<string, unknown>): FreezoneScene360AspectRatio {
  const value = data.aspectRatio;
  return FREEZONE_SCENE_360_ASPECT_RATIOS.includes(value as FreezoneScene360AspectRatio)
    ? (value as FreezoneScene360AspectRatio)
    : DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO;
}

function submitOp(
  project: string,
  opKey: AssetBoardImageOpKey,
  sourceUrl: string,
  prompt: string,
  data: Record<string, unknown>,
): Promise<FreezoneJobRef> {
  if (isGridOpKey(opKey)) {
    return submitFreezoneTemplateEdit(project, {
      sourceUrl,
      mode: GRID_ACTION_MODE_MAP[opKey],
      prompt,
    });
  }
  // Besides grids only panorama remains (multi-angle/lighting were removed from the feature table, see AssetBoardImageOpKey).
  // The panorama ratio is its own 2:1 / 21:9, and does not take the generic ratio.
  const imageSize = readString(data, 'size') ?? undefined;
  return submitFreezoneScene360(project, {
    referenceUrl: sourceUrl,
    aspectRatio: resolveScene360AspectRatio(data),
    ...(imageSize ? { imageSize } : {}),
  });
}

/**
 * The real submission when the up button is pressed: **write the result back to the node itself** (unlike outpaint/upscale and the other orchestrations that build another
 * result node) - the user configured the parameters on this node, so the product should land on this node.
 *
 * Submit -> poll -> backfill url / write the error, the same semantics as the other one-image orchestrations on the canvas.
 *
 * @returns the background chain that resolves on settle (never rejects).
 */
export async function runAssetBoardImageOp(nodeId: string): Promise<void> {
  const project = readUrl().project;
  const store = useCanvasStore.getState();
  const node = store.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) return;
  const data = node.data as Record<string, unknown>;
  const opKey = data.imageOpKey;
  if (!isAssetBoardImageOpKey(opKey)) return;

  const sourceUrl = readString(data, 'imageOpSourceUrl');
  if (!project || !sourceUrl) {
    const message = !project ? i18n.t('canvas.assetBoard.imageOps.missingProject') : i18n.t('canvas.assetBoard.imageOps.missingSource');
    console.error('[asset-board-op] cannot submit', { project, sourceUrl });
    store.updateNodeData(nodeId, { generationError: message });
    return;
  }

  const def = ASSET_BOARD_IMAGE_OP_MAP[opKey];
  // If the prompt is left blank, send the feature name (consistent with the toolbar's behavior of "confirm to submit").
  const prompt = readString(data, 'prompt') ?? def.label;

  store.updateNodeData(nodeId, {
    isGenerating: true,
    generationStartedAt: Date.now(),
    generationError: null,
  });

  try {
    const ref = await submitOp(project, opKey, sourceUrl, prompt, data);
    useCanvasStore.getState().updateNodeData(nodeId, generationTaskDescriptor(ref));
    const completed = await awaitTaskCompletion(ref.task_key, project);
    const directUrl = completed.result?.['output_url'] as string | undefined;
    let url = directUrl;
    if (!url) {
      const fallback = await fetchFreezoneJobResult(project, ref.task_type, ref.job_id);
      url = fallback.url;
    }
    useCanvasStore.getState().updateNodeData(nodeId, {
      imageUrl: url,
      previewImageUrl: url,
      isGenerating: false,
      generationStartedAt: null,
      generationError: null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[asset-board-op] generation failed', err);
    useCanvasStore.getState().updateNodeData(nodeId, {
      isGenerating: false,
      generationStartedAt: null,
      generationError: message,
    });
  }
}

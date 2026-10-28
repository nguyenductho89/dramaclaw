// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CANVAS_NODE_TYPES,
  type CanvasNodeData,
  type CanvasNodeType,
} from '@/features/canvas/domain/canvasNodes';
import {
  h3TemplateRunnablePrompt,
  type H3PromptTemplate,
} from '@/features/canvas/domain/h3PromptTemplates';

/** Nominal ImageGenNode size (DEFAULT_WIDTH/HEIGHT in ImageGenNode.tsx), used to stack the inputs without overlap. */
const INPUT_WIDTH = 580;
const INPUT_HEIGHT = 360;
const GAP_X = 40;
const GAP_Y = 24;
const FALLBACK_TARGET_HEIGHT = 380;

export interface SpawnH3TemplateTarget {
  id: string;
  position: { x: number; y: number };
  height?: number;
}

export interface SpawnH3TemplateDeps {
  addNode: (
    type: CanvasNodeType,
    position: { x: number; y: number },
    data?: Partial<CanvasNodeData>,
  ) => string;
  addEdge: (source: string, target: string) => string | null;
  autoGroupSpawn: (
    sourceNodeId: string,
    spawnedNodeIds: string[],
    opts?: { label?: string },
  ) => string | null;
  updateNodeData: (nodeId: string, data: Partial<CanvasNodeData>) => void;
}

export interface SpawnH3TemplateResult {
  imageNodeIds: string[];
  audioNodeIds: string[];
  /** Inputs whose edge into the video node was rejected (for example by the reference limit). */
  rejectedNodeIds: string[];
}

/**
 * Applies an H3 template to a video node: one image node per `<Picture N>` input (pre-filled with the
 * template's image prompt) and one empty audio node per `<Audio N>`, connected in order so that
 * Picture 1 is the first frame, then the video node's prompt, ratio, duration and mode are filled.
 *
 * The video node numbers its references by edge order, so edges are added strictly in input order
 * and `referenceOrder` pins the same order. `videoPatch` carries the mode-dependent fields the
 * caller already computed (genMode, modelParams).
 */
export function spawnH3TemplateInputs(
  target: SpawnH3TemplateTarget,
  template: H3PromptTemplate,
  videoPatch: Partial<CanvasNodeData>,
  deps: SpawnH3TemplateDeps,
): SpawnH3TemplateResult {
  const inputs = template.inputs;
  const totalH = INPUT_HEIGHT * inputs.length + GAP_Y * Math.max(0, inputs.length - 1);
  const baseX = target.position.x - INPUT_WIDTH - GAP_X;
  const startY = target.position.y + ((target.height || FALLBACK_TARGET_HEIGHT) - totalH) / 2;

  const imageNodeIds: string[] = [];
  const audioNodeIds: string[] = [];
  const rejectedNodeIds: string[] = [];

  inputs.forEach((input, index) => {
    const position = { x: baseX, y: startY + index * (INPUT_HEIGHT + GAP_Y) };
    const isAudio = input.label.startsWith('<Audio');
    const nodeId = isAudio
      ? deps.addNode(CANVAS_NODE_TYPES.audio, position, { user_spawned: true } as Partial<CanvasNodeData>)
      : deps.addNode(CANVAS_NODE_TYPES.imageGen, position, {
          user_spawned: true,
          h3TemplateInput: true,
          prompt: input.imagePrompt ?? '',
          aspectRatio: template.aspectRatio,
        } as Partial<CanvasNodeData>);
    (isAudio ? audioNodeIds : imageNodeIds).push(nodeId);
    if (deps.addEdge(nodeId, target.id) === null) {
      rejectedNodeIds.push(nodeId);
    }
  });

  deps.updateNodeData(target.id, {
    ...videoPatch,
    prompt: h3TemplateRunnablePrompt(template),
    aspectRatio: template.aspectRatio,
    durationSec: template.durationSec,
    cameraMovement: null,
    referenceOrder: [...imageNodeIds, ...audioNodeIds],
  } as Partial<CanvasNodeData>);

  deps.autoGroupSpawn(target.id, [...imageNodeIds, ...audioNodeIds], {
    label: template.title.en,
  });

  return { imageNodeIds, audioNodeIds, rejectedNodeIds };
}

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import {
  CANVAS_NODE_TYPES,
  type TextNodeMode,
  type UploadImageNodeData,
  type VideoNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

/** Default instruction for "image reverse-prompt" (placeholder/default value of the text node's instruction). */
export const IMAGE_TO_PROMPT_DEFAULT_CONTENT =
  'Generate a structured English prompt from the image, covering the subject description, environment, lighting, camera language, and style keywords.';

/** Default music description for "text to music" - pre-filled into the text node on click, and the user can edit from it. */
export const TEXT_TO_MUSIC_DEFAULT_CONTENT =
  'Create a modern branded electronic track (about 110 BPM) with a clean, powerful bass line, crisp electronic drums, and an overall premium, futuristic feel. The intro builds the groove with a rhythmic bass and a simple synth tone. The main section adds a steady drum pattern with clear rhythm and restrained tension. The build-up layers in richer textures, the synth tone lifts and the groove strengthens without getting crowded. The ending thins out the drums, leaving only low frequencies and an ambient fade-out for a clean finish.';

/** Text node capabilities that really exist (any other value falls back to writing). */
export const TEXT_NODE_REAL_MODES: ReadonlySet<TextNodeMode> = new Set<TextNodeMode>([
  'writing',
  'textToVideo',
  'imageToPrompt',
  'textToMusic',
  'textToMusicGen',
]);

/**
 * Capabilities that use the "compact view": the node body is just a preview card, with input/submit landing in the operation panel hanging below it.
 * Also one of the criteria for "the capability picker no longer shows" - a node that already chose these two capabilities should not pop the picker again.
 */
export const TEXT_NODE_COMPACT_MODES: ReadonlySet<TextNodeMode> = new Set<TextNodeMode>([
  'textToVideo',
  'imageToPrompt',
]);

/** Landing size of the derived video node (consistent with TextAnnotationNode.spawnVideoNode). */
const SPAWN_VIDEO_LAYOUT_WIDTH = 580;
const SPAWN_VIDEO_LAYOUT_HEIGHT = 680;
/** Landing size of the derived audio node (consistent with TextAnnotationNode.spawnAudioNode). */
const SPAWN_AUDIO_LAYOUT_WIDTH = 480;
const SPAWN_AUDIO_LAYOUT_HEIGHT = 180;
/** Width of the upstream upload node for reverse-prompt (lands to the left of the text node, same as the original implementation). */
const SPAWN_UPLOAD_WIDTH = 320;
const SPAWN_UPLOAD_GAP = 60;

/** Resolve the current body of the text node (addNode's seedData must carry it into the downstream video node's prompt). */
function readNodeContent(nodeId: string): string {
  const data = useCanvasStore.getState().nodes.find((node) => node.id === nodeId)?.data as
    | { content?: unknown }
    | undefined;
  return typeof data?.content === 'string' ? data.content : '';
}

/**
 * Text to video: derive a video node downstream of the text node and connect an edge (text -> video), with the seed carrying
 * genMode='textToVideo' and the current body as the prompt.
 *
 * (Moved verbatim out of TextAnnotationNode.spawnVideoNode, with zero semantic change.)
 */
export function spawnTextToVideoNode(nodeId: string): string {
  const store = useCanvasStore.getState();
  const position = store.findNodePosition(
    nodeId,
    SPAWN_VIDEO_LAYOUT_WIDTH,
    SPAWN_VIDEO_LAYOUT_HEIGHT,
  );
  const seedData: Partial<VideoNodeData> = {
    genMode: 'textToVideo',
    prompt: readNodeContent(nodeId),
  };
  const newNodeId = store.addNode(CANVAS_NODE_TYPES.video, position, seedData);
  store.addEdge(nodeId, newNodeId);
  useCanvasStore.getState().autoGroupSpawn(nodeId, [newNodeId], { label: i18n.t('canvas.spawnGroup.textToVideo') });
  return newNodeId;
}

/**
 * Image reverse-prompt: derive an image-only upload node **upstream on the left** of the text node and connect an edge
 * (upload -> text). imageOnly makes the title "Upload image", accept=image/*, and rejects video/audio.
 *
 * (Moved verbatim out of TextAnnotationNode.spawnUploadNode, with zero semantic change.)
 */
export function spawnImageToPromptUploadNode(nodeId: string): string {
  const store = useCanvasStore.getState();
  const sourceNode = store.nodes.find((node) => node.id === nodeId);
  const sourceX = sourceNode?.position.x ?? 0;
  const sourceY = sourceNode?.position.y ?? 0;
  const position = {
    x: sourceX - SPAWN_UPLOAD_WIDTH - SPAWN_UPLOAD_GAP,
    y: sourceY,
  };
  const seedData: Partial<UploadImageNodeData> = { imageOnly: true };
  const newNodeId = store.addNode(CANVAS_NODE_TYPES.upload, position, seedData);
  store.addEdge(newNodeId, nodeId);
  useCanvasStore
    .getState()
    .autoGroupSpawn(nodeId, [newNodeId], { label: i18n.t('canvas.spawnGroup.imageToPrompt') });
  return newNodeId;
}

/**
 * Clone audio / text to music: derive an audio node downstream of the text node and connect an edge (text -> audio),
 * isomorphic with "text to video" deriving a video node. audioKind decides whether the downstream audio node goes through voice cloning (speech)
 * or text-to-music (music).
 *
 * (Moved verbatim out of TextAnnotationNode.spawnAudioNode, with zero semantic change.)
 */
export function spawnTextNodeAudio(nodeId: string, audioKind: 'speech' | 'music'): string {
  const store = useCanvasStore.getState();
  const position = store.findNodePosition(
    nodeId,
    SPAWN_AUDIO_LAYOUT_WIDTH,
    SPAWN_AUDIO_LAYOUT_HEIGHT,
  );
  const newNodeId = store.addNode(CANVAS_NODE_TYPES.audio, position, { audioKind });
  store.addEdge(nodeId, newNodeId);
  const label = audioKind === 'music' ? i18n.t('canvas.spawnGroup.textToMusic') : i18n.t('canvas.spawnGroup.cloneAudio');
  useCanvasStore.getState().autoGroupSpawn(nodeId, [newNodeId], { label });
  return newNodeId;
}

export interface ApplyTextNodeModeResult {
  /** The canvas node id derived this time (writing derives nothing -> null). */
  spawnedNodeId: string | null;
  /**
   * Whether the caller should switch the text node into edit mode. In the workflow this corresponds to enterEditMode() (including setCenter
   * zoom), and in the storyboard detail to expanding the body textarea - the zoom semantics belong only to the canvas, so how to "enter editing" is left
   * to the caller, and this function only reports "should enter".
   */
  enterEdit: boolean;
}

/**
 * Text node capability selection (moved verbatim out of TextAnnotationNode.handlePickMode, with zero semantic change):
 *
 * - `writing`: only switch mode, then enter edit mode;
 * - `textToMusicGen`: **first** derive the downstream music audio node, **then** switch this node back to writing +
 *   pickerDismissed + pre-fill the default music description, then enter edit mode (the order matches the original implementation - the music description
 *   must be written after the derivation, so it syncs to the just-built downstream audio node);
 * - `textToVideo` / `imageToPrompt` / `textToMusic`: switch mode first, then derive the matching downstream/upstream node.
 */
export function applyTextNodeMode(
  nodeId: string,
  mode: TextNodeMode,
): ApplyTextNodeModeResult {
  const updateNodeData = useCanvasStore.getState().updateNodeData;
  if (mode === 'writing') {
    updateNodeData(nodeId, { mode });
    return { spawnedNodeId: null, enterEdit: true };
  }
  if (mode === 'textToMusicGen') {
    const spawnedNodeId = spawnTextNodeAudio(nodeId, 'music');
    // The text node returns to plain-text editing, closes the capability picker, and pre-fills the default music description (synced to the downstream audio node).
    updateNodeData(nodeId, {
      mode: 'writing',
      pickerDismissed: true,
      content: TEXT_TO_MUSIC_DEFAULT_CONTENT,
    });
    return { spawnedNodeId, enterEdit: true };
  }
  updateNodeData(nodeId, { mode });
  if (mode === 'textToVideo') {
    return { spawnedNodeId: spawnTextToVideoNode(nodeId), enterEdit: false };
  }
  if (mode === 'imageToPrompt') {
    return { spawnedNodeId: spawnImageToPromptUploadNode(nodeId), enterEdit: false };
  }
  if (mode === 'textToMusic') {
    return { spawnedNodeId: spawnTextNodeAudio(nodeId, 'speech'), enterEdit: false };
  }
  return { spawnedNodeId: null, enterEdit: false };
}

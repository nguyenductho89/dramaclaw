// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  AUTO_REQUEST_ASPECT_RATIO,
  CANVAS_NODE_TYPES,
  DEFAULT_ASPECT_RATIO,
  type BeatContextNodeData,
  type AudioNodeData,
  type ImageSize,
  type CanvasNodeData,
  type CanvasNodeType,
  type ExportImageNodeData,
  type GroupNodeData,
  type ImageEditNodeData,
  type ImageGenNodeData,
  type Pano360ViewerNodeData,
  type ScriptNodeData,
  type SkillNodeData,
  type StoryboardSplitNodeData,
  type StoryboardGenNodeData,
  type StyleNodeData,
  type TextAnnotationNodeData,
  type ThreeDWorldNodeData,
  type UploadImageNodeData,
  type VideoComposeNodeData,
  type VideoNodeData,
  type VideoStoryNodeData,
} from './canvasNodes';
import { DEFAULT_NODE_DISPLAY_NAME } from './nodeDisplay';
import { SKILL_SCHEMA_VERSION } from '@/features/freezone/context/skillRoles';
import { DEFAULT_IMAGE_MODEL_ID } from '../models';
import {
  DEFAULT_SHARED_MODEL_ID,
  DEFAULT_VIDEO_MODEL_ID,
} from '../ui/ProviderModelPicker';
import { readLastVideoModel } from './lastVideoModel';

export type MenuIconKey = 'upload' | 'sparkles' | 'layout' | 'text' | 'video' | 'audio' | 'script' | 'pano360' | 'threeDWorld' | 'videoCompose';

export interface CanvasNodeCapabilities {
  toolbar: boolean;
  promptInput: boolean;
}

export interface CanvasNodeConnectivity {
  sourceHandle: boolean;
  targetHandle: boolean;
  connectMenu: {
    fromSource: boolean;
    fromTarget: boolean;
  };
}

export interface CanvasNodeDefinition<TData extends CanvasNodeData = CanvasNodeData> {
  type: CanvasNodeType;
  menuLabelKey: string;
  menuIcon: MenuIconKey;
  visibleInMenu: boolean;
  capabilities: CanvasNodeCapabilities;
  connectivity: CanvasNodeConnectivity;
  createDefaultData: () => TData;
}

const uploadNodeDefinition: CanvasNodeDefinition<UploadImageNodeData> = {
  type: CANVAS_NODE_TYPES.upload,
  menuLabelKey: 'node.menu.uploadImage',
  menuIcon: 'upload',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: false,
    connectMenu: {
      fromSource: false,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.upload],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: '1:1',
    isSizeManuallyAdjusted: false,
    sourceFileName: null,
  }),
};

const imageEditNodeDefinition: CanvasNodeDefinition<ImageEditNodeData> = {
  type: CANVAS_NODE_TYPES.imageEdit,
  menuLabelKey: 'node.menu.aiImageGeneration',
  menuIcon: 'sparkles',
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.imageEdit],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isSizeManuallyAdjusted: false,
    requestAspectRatio: AUTO_REQUEST_ASPECT_RATIO,
    prompt: '',
    model: DEFAULT_IMAGE_MODEL_ID,
    size: '2K' as ImageSize,
    extraParams: {},
    generationMode: 'text_to_image',
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const imageGenNodeDefinition: CanvasNodeDefinition<ImageGenNodeData> = {
  type: CANVAS_NODE_TYPES.imageGen,
  menuLabelKey: 'node.menu.image',
  menuIcon: 'sparkles',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.imageGen],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: '16:9',
    isSizeManuallyAdjusted: false,
    requestAspectRatio: AUTO_REQUEST_ASPECT_RATIO,
    prompt: '',
    model: DEFAULT_SHARED_MODEL_ID,
    size: '2K' as ImageSize,
    count: 1,
    styleTemplateId: null,
    focusRegion: null,
    cameraSelection: null,
    referenceImageUrl: null,
    marks: [],
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const exportImageNodeDefinition: CanvasNodeDefinition<ExportImageNodeData> = {
  type: CANVAS_NODE_TYPES.exportImage,
  menuLabelKey: 'node.menu.uploadImage',
  menuIcon: 'upload',
  visibleInMenu: false,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.exportImage],
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isSizeManuallyAdjusted: false,
    resultKind: 'generic',
  }),
};

const beatContextNodeDefinition: CanvasNodeDefinition<BeatContextNodeData> = {
  type: CANVAS_NODE_TYPES.beatContext,
  menuLabelKey: 'node.menu.beatContext',
  menuIcon: 'text',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: false,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.beatContext],
    content: '',
    context_scope: 'standalone',
    beat_context: {
      schema: 'beat_context.v1',
      source: 'standalone',
      // The canonical title written into node data; the one shown in the UI comes from the standaloneTitle entry.
      title: 'Custom shot context', // i18n-exempt - canonical value
      visual_description: '',
      narration_segment: '',
      scene_id: '',
      time_of_day: '',
      detected_identities: [],
      detected_props: [],
      sketch_colors: {},
      prop_marker_colors: {},
    },
    snapshot: {
      visualDescription: '',
      narrationSegment: '',
      sceneId: '',
      timeOfDay: '',
      detectedIdentities: [],
      detectedProps: [],
      sketchColors: {},
      propMarkerColors: {},
    },
    syncStatus: 'fresh',
  }),
};

const groupNodeDefinition: CanvasNodeDefinition<GroupNodeData> = {
  type: CANVAS_NODE_TYPES.group,
  menuLabelKey: 'node.menu.storyboard',
  menuIcon: 'layout',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: false,
    targetHandle: false,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.group],
    // Like displayName, a canonical default value written into the canvas JSON; title display goes through headerTitle
    label: 'Group', // i18n-exempt
  }),
};

const textAnnotationNodeDefinition: CanvasNodeDefinition<TextAnnotationNodeData> = {
  type: CANVAS_NODE_TYPES.textAnnotation,
  menuLabelKey: 'node.menu.textAnnotation',
  menuIcon: 'text',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.textAnnotation],
    content: '',
    model: DEFAULT_SHARED_MODEL_ID,
    extraParams: {},
    isGenerating: false,
  }),
};

const storyboardSplitDefinition: CanvasNodeDefinition<StoryboardSplitNodeData> = {
  type: CANVAS_NODE_TYPES.storyboardSplit,
  menuLabelKey: 'node.menu.storyboard',
  menuIcon: 'layout',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.storyboardSplit],
    aspectRatio: DEFAULT_ASPECT_RATIO,
    frameAspectRatio: DEFAULT_ASPECT_RATIO,
    gridRows: 2,
    gridCols: 2,
    frames: [],
    exportOptions: {
      showFrameIndex: false,
      showFrameNote: false,
      notePlacement: 'overlay',
      imageFit: 'cover',
      frameIndexPrefix: 'S',
      cellGap: 8,
      outerPadding: 0,
      fontSize: 4,
      backgroundColor: '#0f1115',
      textColor: '#f8fafc',
    },
  }),
};

const storyboardGenNodeDefinition: CanvasNodeDefinition<StoryboardGenNodeData> = {
  type: CANVAS_NODE_TYPES.storyboardGen,
  menuLabelKey: 'node.menu.storyboardGen',
  menuIcon: 'sparkles',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.storyboardGen],
    gridRows: 2,
    gridCols: 2,
    frames: [],
    ratioControlMode: 'cell',
    model: DEFAULT_IMAGE_MODEL_ID,
    size: '2K' as ImageSize,
    requestAspectRatio: AUTO_REQUEST_ASPECT_RATIO,
    extraParams: {},
    imageUrl: null,
    previewImageUrl: null,
    aspectRatio: DEFAULT_ASPECT_RATIO,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const videoNodeDefinition: CanvasNodeDefinition<VideoNodeData> = {
  type: CANVAS_NODE_TYPES.video,
  menuLabelKey: 'node.menu.video',
  menuIcon: 'video',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.video],
    videoUrl: null,
    previewImageUrl: null,
    aspectRatio: '16:9',
    isSizeManuallyAdjusted: false,
    sourceFileName: null,
    widthPx: null,
    heightPx: null,
    durationMs: null,
    isUploading: false,
    isAnalyzing: false,
    analysisResult: null,
    analysisError: null,
    // generation panel defaults
    prompt: '',
    genMode: 'textToVideo',
    // Inherit the model the user last chose for video nodes; fall back to the default model when there is no record.
    model: readLastVideoModel() ?? DEFAULT_VIDEO_MODEL_ID,
    quality: '720P',
    durationSec: 5,
    count: 1,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const audioNodeDefinition: CanvasNodeDefinition<AudioNodeData> = {
  type: CANVAS_NODE_TYPES.audio,
  menuLabelKey: 'node.menu.audio',
  menuIcon: 'audio',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.audio],
    audioUrl: null,
    sourceFileName: null,
    durationMs: null,
    isUploading: false,
    text: '',
    emotionPrompt: '',
    // Default voice: left empty. AudioOperationsPanel fetches the voice library references once on mount
    // and lands on the first one; hard-coding project_narrator here would make the initialization
    // effect bail early, so the user would always see "Project narrator" and be unable to replace it.
    voiceLanguage: '',
    isGenerating: false,
    generationStartedAt: null,
  }),
};

const videoStoryNodeDefinition: CanvasNodeDefinition<VideoStoryNodeData> = {
  type: CANVAS_NODE_TYPES.videoStory,
  menuLabelKey: 'node.menu.videoStory',
  menuIcon: 'video',
  // Only ever spawned programmatically (after video-analyze success), never
  // through the double-click or "+" menus.
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: false,
    targetHandle: true,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.videoStory],
    sourceVideoUrl: null,
    rows: [],
    rawResult: null,
    isAnalyzing: false,
    analysisError: null,
  }),
};

const videoComposeNodeDefinition: CanvasNodeDefinition<VideoComposeNodeData> = {
  type: CANVAS_NODE_TYPES.videoCompose,
  menuLabelKey: 'node.menu.videoCompose',
  menuIcon: 'videoCompose',
  visibleInMenu: true,
  capabilities: {
    toolbar: true,
    promptInput: false,
  },
  connectivity: {
    // Accepts >= 2 upstream video (optionally audio) nodes; the compose result can continue to output downstream.
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.videoCompose],
    resultVideoUrl: null,
    previewImageUrl: null,
    resolution: '1080p',
  }),
};

// Hard-coded script generation model id (the script generation endpoint does not provide a list yet). Kept in sync with
// SCRIPT_MODELS inside ScriptNode, and only used for createDefaultData to pick the default.
const DEFAULT_SCRIPT_MODEL_ID = 'gvlm-3.1';

const scriptNodeDefinition: CanvasNodeDefinition<ScriptNodeData> = {
  type: CANVAS_NODE_TYPES.script,
  menuLabelKey: 'node.menu.script',
  menuIcon: 'script',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.script],
    prompt: '',
    model: DEFAULT_SCRIPT_MODEL_ID,
    lastAction: null,
    scriptResult: null,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 60000,
  }),
};

const pano360ViewerNodeDefinition: CanvasNodeDefinition<Pano360ViewerNodeData> = {
  type: CANVAS_NODE_TYPES.pano360Viewer,
  menuLabelKey: 'node.menu.pano360Viewer',
  menuIcon: 'pano360',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    // The panorama viewer both receives an upstream texture and can output screenshot nodes downstream (capture current / 2x2 / 4x3),
    // so both ends need handles - otherwise screenshot edges would be filtered out when the canvas re-hydrates.
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: false,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.pano360Viewer],
    imageUrl: null,
    previewImageUrl: null,
    sourceNodeId: null,
    sphereCorrectionDeg: { roll: 0, pitch: 0, yaw: 0 },
    frontYawDeg: 0,
    fovDeg: 70,
    lastExportedEntry: null,
  }),
};

const threeDWorldNodeDefinition: CanvasNodeDefinition<ThreeDWorldNodeData> = {
  type: CANVAS_NODE_TYPES.threeDWorld,
  menuLabelKey: 'node.menu.threeDWorld',
  menuIcon: 'threeDWorld',
  visibleInMenu: true,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.threeDWorld],
    prompt: '',
    model: 'marble-1.1',
    taskKey: null,
    plyUrl: null,
    sourceNodeId: null,
    sourceKind: null,
    isGenerating: false,
    generationStartedAt: null,
    generationDurationMs: 90000,
    errorMessage: null,
  }),
};

const skillNodeDefinition: CanvasNodeDefinition<SkillNodeData> = {
  type: CANVAS_NODE_TYPES.skill,
  menuLabelKey: 'node.menu.skill',
  menuIcon: 'sparkles',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: true,
    connectMenu: {
      fromSource: true,
      fromTarget: true,
    },
  },
  createDefaultData: () => ({
    displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.skill],
    skill_id: '',
    skill_schema_version: SKILL_SCHEMA_VERSION,
  }),
};

// Style nodes are built/deleted by the image node's reconciliation logic (see styleNodeSync), and are in neither the create menu nor
// the connect menu - an empty style node dragged out by hand has no owning image node and nobody consumes it.
const styleNodeDefinition: CanvasNodeDefinition<StyleNodeData> = {
  type: CANVAS_NODE_TYPES.style,
  menuLabelKey: 'node.menu.style',
  menuIcon: 'sparkles',
  visibleInMenu: false,
  capabilities: {
    toolbar: false,
    promptInput: false,
  },
  connectivity: {
    sourceHandle: true,
    targetHandle: false,
    connectMenu: {
      fromSource: false,
      fromTarget: false,
    },
  },
  // Do not write displayName: the title defaults to being computed by the node itself as "Style · Category · Style name", and hard-coding it would never
  // follow a style change again. displayName exists only after the user renames manually, and then the user's wins.
  createDefaultData: () => ({
    styleTemplateId: null,
  }),
};

const derivedMediaDefinition = (type: CanvasNodeType): CanvasNodeDefinition => ({
  type,
  menuLabelKey: type === CANVAS_NODE_TYPES.vectorSvg ? 'canvas.derivedMedia.vector' : 'canvas.derivedMedia.animated',
  menuIcon: type === CANVAS_NODE_TYPES.vectorSvg ? 'upload' : 'video',
  visibleInMenu: false,
  capabilities: { toolbar: true, promptInput: false },
  connectivity: { sourceHandle: true, targetHandle: true, connectMenu: { fromSource: false, fromTarget: false } },
  createDefaultData: () => ({ imageUrl: null, aspectRatio: '16:9' }),
});
export const canvasNodeDefinitions: Record<CanvasNodeType, CanvasNodeDefinition> = {
  vectorSvgNode: derivedMediaDefinition(CANVAS_NODE_TYPES.vectorSvg),
  animatedGifNode: derivedMediaDefinition(CANVAS_NODE_TYPES.animatedGif),
  [CANVAS_NODE_TYPES.htmlArtifact]: {
    type: CANVAS_NODE_TYPES.htmlArtifact, menuLabelKey: 'node.menu.htmlArtifact', menuIcon: 'layout', visibleInMenu: true,
    capabilities: { toolbar: false, promptInput: false },
    connectivity: { sourceHandle: true, targetHandle: true, connectMenu: { fromSource: false, fromTarget: false } },
    createDefaultData: () => ({ displayName: DEFAULT_NODE_DISPLAY_NAME[CANVAS_NODE_TYPES.htmlArtifact], artifactId: '', artifactVersion: 0 }),
  },
  [CANVAS_NODE_TYPES.upload]: uploadNodeDefinition,
  [CANVAS_NODE_TYPES.imageEdit]: imageEditNodeDefinition,
  [CANVAS_NODE_TYPES.imageGen]: imageGenNodeDefinition,
  [CANVAS_NODE_TYPES.exportImage]: exportImageNodeDefinition,
  [CANVAS_NODE_TYPES.beatContext]: beatContextNodeDefinition,
  [CANVAS_NODE_TYPES.textAnnotation]: textAnnotationNodeDefinition,
  [CANVAS_NODE_TYPES.group]: groupNodeDefinition,
  [CANVAS_NODE_TYPES.storyboardSplit]: storyboardSplitDefinition,
  [CANVAS_NODE_TYPES.storyboardGen]: storyboardGenNodeDefinition,
  [CANVAS_NODE_TYPES.video]: videoNodeDefinition,
  [CANVAS_NODE_TYPES.audio]: audioNodeDefinition,
  [CANVAS_NODE_TYPES.videoStory]: videoStoryNodeDefinition,
  [CANVAS_NODE_TYPES.videoCompose]: videoComposeNodeDefinition,
  [CANVAS_NODE_TYPES.script]: scriptNodeDefinition,
  [CANVAS_NODE_TYPES.pano360Viewer]: pano360ViewerNodeDefinition,
  [CANVAS_NODE_TYPES.threeDWorld]: threeDWorldNodeDefinition,
  [CANVAS_NODE_TYPES.skill]: skillNodeDefinition,
  [CANVAS_NODE_TYPES.style]: styleNodeDefinition,
};

export function getNodeDefinition(type: CanvasNodeType): CanvasNodeDefinition {
  return canvasNodeDefinitions[type];
}

export function getMenuNodeDefinitions(): CanvasNodeDefinition[] {
  return Object.values(canvasNodeDefinitions).filter((definition) => definition.visibleInMenu);
}

export function nodeHasSourceHandle(type: CanvasNodeType): boolean {
  return canvasNodeDefinitions[type].connectivity.sourceHandle;
}

export function nodeHasTargetHandle(type: CanvasNodeType): boolean {
  return canvasNodeDefinitions[type].connectivity.targetHandle;
}

// "Target node type" -> whitelist of allowed upstream (source) node types. This table and the DOWNSTREAM_TARGET_WHITELIST below
// are the single source of truth for edge rules: the UI layer (connect menu /
// manual drag / isValidConnection) and the store's edge gates (onConnect / addEdge /
// addEdgeWithData / load normalization) all query them through isUpstreamConnectionAllowed, so that
// no edge creation path bypasses the rules. A target type not in the table means "no extra type restriction", constrained only by
// the handle-level default rules.
const UPSTREAM_SOURCE_WHITELIST: Partial<Record<CanvasNodeType, readonly CanvasNodeType[]>> = {
  // The upstream of an audio node can only be text nodes (generation source), plus video nodes - the latter is the provenance edge left by the "vocal/background
  // separation" action: that action produces both a "background audio" audio node and a
  // "silent" video node from one video node, with both edges drawn back to the source video. Without the video entry, the audio edge would be silently dropped by the edge
  // gate, leaving one side connected to the silent video and the background audio hanging alone on the canvas.
  [CANVAS_NODE_TYPES.audio]: [CANVAS_NODE_TYPES.textAnnotation, CANVAS_NODE_TYPES.video],
};

// "Source node type" -> whitelist of allowed downstream (target) node types. Symmetric with the table above: that one
// gates by target (who can connect into me), this one gates by source (whom I can connect to). Together the two tables form the edge rules,
// likewise queried by all edge creation paths. A source type not in the table means "no extra restriction on downstream types".
//
// Audio is currently the only type that needs gating by source: only video nodes (audio track material) and video compose (audio track)
// read upstream audio, and connecting to image / script / 3D nodes has no effect, just a misleading line on the canvas.
// This rule was already written elsewhere - getDownstreamSpawnTypes(audio) only gives
// [video, videoCompose], and the upstream menu of image nodes in Canvas.resolveAllowedNodeTypes
// also explicitly says "does not accept audio" - but those two only govern what the menu can create; when a drag lands on an **existing** node
// nobody blocked it. Putting it here is what really closes the gate.
const DOWNSTREAM_TARGET_WHITELIST: Partial<Record<CanvasNodeType, readonly CanvasNodeType[]>> = {
  [CANVAS_NODE_TYPES.audio]: [CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.videoCompose],
  // A style node is only the projection of an image node's styleTemplateId; connecting it elsewhere has no effect.
  [CANVAS_NODE_TYPES.style]: [CANVAS_NODE_TYPES.imageGen],
};

// Return the upstream source types allowed for a target type; null means the type imposes no extra type restriction.
export function getAllowedUpstreamSourceTypes(
  targetType: CanvasNodeType,
): readonly CanvasNodeType[] | null {
  return UPSTREAM_SOURCE_WHITELIST[targetType] ?? null;
}

// Return the downstream target types allowed for a source type; null means the type imposes no extra type restriction.
export function getAllowedDownstreamTargetTypes(
  sourceType: CanvasNodeType,
): readonly CanvasNodeType[] | null {
  return DOWNSTREAM_TARGET_WHITELIST[sourceType] ?? null;
}

// Determine whether a connection from sourceType to targetType is legal: both whitelists must be passed.
export function isUpstreamConnectionAllowed(
  sourceType: CanvasNodeType,
  targetType: CanvasNodeType,
): boolean {
  const allowedSources = UPSTREAM_SOURCE_WHITELIST[targetType];
  if (allowedSources && !allowedSources.includes(sourceType)) {
    return false;
  }
  const allowedTargets = DOWNSTREAM_TARGET_WHITELIST[sourceType];
  if (allowedTargets && !allowedTargets.includes(targetType)) {
    return false;
  }
  return true;
}

// Edges established only by system actions and **not open for users to create by hand**. The two tables above must let them through (otherwise
// load normalization would drop existing edges), but the connect menu and manual dragging should not offer them - an edge the user draws
// themselves would have no consumer and be a misleading line.
const SYSTEM_ONLY_CONNECTIONS: readonly (readonly [CanvasNodeType, CanvasNodeType])[] = [
  // "Vocal/background separation" draws the produced "background audio" audio node back to the source video, a provenance edge. An audio node
  // itself only reads text upstream (AudioOperationsPanel only takes text), so connecting a video in by hand
  // would do nothing.
  [CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.audio],
  // A style node and an image node are one-to-one: that edge is built by the reconciliation logic following styleTemplateId.
  // If manual dragging were opened, one style node could attach to a second image node, and the reconciliation on both sides would each think
  // "the style carried by the node differs from mine", rewriting it back and forth into the other's style, never converging.
  [CANVAS_NODE_TYPES.style, CANVAS_NODE_TYPES.imageGen],
];

// Determine whether a user can **manually** establish this edge: the edge rules allow it and it is not a system-only edge. Menu candidates and
// manual dragging query this; the store's edge gate still queries isUpstreamConnectionAllowed.
export function isManualConnectionAllowed(
  sourceType: CanvasNodeType,
  targetType: CanvasNodeType,
): boolean {
  if (!isUpstreamConnectionAllowed(sourceType, targetType)) {
    return false;
  }
  return !SYSTEM_ONLY_CONNECTIONS.some(
    ([source, target]) => source === sourceType && target === targetType,
  );
}

export function getConnectMenuNodeTypes(handleType: 'source' | 'target'): CanvasNodeType[] {
  const fromSource = handleType === 'source';
  return Object.values(canvasNodeDefinitions)
    .filter((definition) => (fromSource
      ? definition.connectivity.connectMenu.fromSource
      : definition.connectivity.connectMenu.fromTarget))
    .filter((definition) => (fromSource
      ? definition.connectivity.targetHandle
      : definition.connectivity.sourceHandle))
    .map((definition) => definition.type);
}

// Downstream candidates shared by image-type nodes (upload / imageEdit / imageGen / exportImage).
const IMAGE_DOWNSTREAM_SPAWN_TYPES: readonly CanvasNodeType[] = [
  CANVAS_NODE_TYPES.textAnnotation,
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.video,
  CANVAS_NODE_TYPES.script,
  CANVAS_NODE_TYPES.pano360Viewer,
  CANVAS_NODE_TYPES.threeDWorld,
];

// The product whitelist for "which downstream nodes can be created starting from the right source handle". This is the one shared by the + menu
// (NodeSpawnPlusOverlay) and the drag-to-empty menu (Canvas.handleConnectEnd).
// A source type not in the table falls back to the registry's connectMenu.fromSource default list.
//
// What is written here is **product intent**, not a guarantee that the edge can be built - the edge rules (the two tables above +
// SYSTEM_ONLY_CONNECTIONS) have the final say and are applied once more on use. If the two conflict, the test
// "menu whitelist does not conflict with edge rules" goes red.
export const DOWNSTREAM_SPAWN_WHITELIST: Partial<
  Record<CanvasNodeType, readonly CanvasNodeType[]>
> = {
  // Video: only text / video / video compose / script are allowed - image, audio, multi-version should not be downstream.
  [CANVAS_NODE_TYPES.video]: [
    CANVAS_NODE_TYPES.textAnnotation,
    CANVAS_NODE_TYPES.video,
    CANVAS_NODE_TYPES.videoCompose,
    CANVAS_NODE_TYPES.script,
  ],
  // Audio: only video (audio track material) and video compose (audio track) downstream can understand it.
  [CANVAS_NODE_TYPES.audio]: [CANVAS_NODE_TYPES.video, CANVAS_NODE_TYPES.videoCompose],
  // 360 panorama viewer: screenshots are all images, so downstream only accepts image-type nodes.
  [CANVAS_NODE_TYPES.pano360Viewer]: [
    CANVAS_NODE_TYPES.imageGen,
    CANVAS_NODE_TYPES.imageEdit,
    CANVAS_NODE_TYPES.exportImage,
    CANVAS_NODE_TYPES.upload,
  ],
  [CANVAS_NODE_TYPES.upload]: IMAGE_DOWNSTREAM_SPAWN_TYPES,
  [CANVAS_NODE_TYPES.imageEdit]: IMAGE_DOWNSTREAM_SPAWN_TYPES,
  [CANVAS_NODE_TYPES.imageGen]: IMAGE_DOWNSTREAM_SPAWN_TYPES,
  [CANVAS_NODE_TYPES.exportImage]: IMAGE_DOWNSTREAM_SPAWN_TYPES,
};

// Given the origin node type, return "the set of downstream node types that can be created from the right source handle".
export function getDownstreamSpawnTypes(
  originType: CanvasNodeType | undefined,
): CanvasNodeType[] {
  const base = getConnectMenuNodeTypes('source');
  if (!originType) return base;
  // Go through the manual edge rules once more: candidates in the menu must really be connectable. Otherwise after the user clicks, the new node
  // is built but the edge is rejected by the edge gate, leaving an orphan node on the canvas (e.g. script -> audio).
  const connectable = base.filter((type) => isManualConnectionAllowed(originType, type));
  const allowed = DOWNSTREAM_SPAWN_WHITELIST[originType];
  if (allowed) {
    return connectable.filter((type) => allowed.includes(type));
  }
  if (originType === CANVAS_NODE_TYPES.textAnnotation || originType === CANVAS_NODE_TYPES.script) {
    return connectable.filter((type) => type !== CANVAS_NODE_TYPES.videoCompose);
  }
  return connectable;
}

// The product whitelist for "which upstream nodes can be created from the left target handle" - a mirror of the table above.
// Likewise only product intent, which must still pass the manual edge rules on use.
export const UPSTREAM_SPAWN_WHITELIST: Partial<
  Record<CanvasNodeType, readonly CanvasNodeType[]>
> = {
  // 3D world: upstream only allows text / image nodes (Phase 1).
  [CANVAS_NODE_TYPES.threeDWorld]: [
    CANVAS_NODE_TYPES.textAnnotation,
    CANVAS_NODE_TYPES.imageGen,
  ],
  // Image node: upstream only allows text (textAnnotation / script) + image (upload),
  // and does not accept audio / video / 3D world.
  [CANVAS_NODE_TYPES.imageGen]: [
    CANVAS_NODE_TYPES.textAnnotation,
    CANVAS_NODE_TYPES.script,
    CANVAS_NODE_TYPES.upload,
  ],
  // Video node: upstream only allows text / image / audio, consistent with the whitelist of the "+"
  // button on the left of NodeSpawnPlusOverlay.
  [CANVAS_NODE_TYPES.video]: [
    CANVAS_NODE_TYPES.textAnnotation,
    CANVAS_NODE_TYPES.imageGen,
    CANVAS_NODE_TYPES.audio,
  ],
};

// Given the target node type, return "the set of upstream node types that can be created from the left target handle".
//
// Unlike the downstream side, most branches here **do not reuse base**: base only takes types whose connectMenu.fromTarget
// is true, while fromTarget of textAnnotation / imageGen is false, so reusing it would
// wrongly kill them. So the whitelist here "rewrites the candidate set" rather than "filters the candidate set".
export function getUpstreamSpawnTypes(
  originType: CanvasNodeType | undefined,
): CanvasNodeType[] {
  const base = getConnectMenuNodeTypes('target');
  if (!originType) return base;
  // Every branch finally passes through the manual edge rules: the menu's candidates must be ones the user can really connect. Without this,
  // the upstream menu of an audio node would show "video" - that is the provenance edge of "vocal/background separation", and an audio node
  // only reads text upstream, so connecting a video in by hand would do nothing.
  const manual = (types: readonly CanvasNodeType[]) =>
    types.filter((type) => isManualConnectionAllowed(type, originType));

  // 3D world is the only branch that intersects with base (historical behavior, not adjusted in this change).
  if (originType === CANVAS_NODE_TYPES.threeDWorld) {
    const allowed = UPSTREAM_SPAWN_WHITELIST[originType] ?? [];
    return manual(base.filter((type) => allowed.includes(type)));
  }

  const declared = UPSTREAM_SPAWN_WHITELIST[originType];
  if (declared) {
    return manual(declared);
  }

  // For targets constrained by the upstream type whitelist (e.g. audio <- text): use the domain-layer whitelist directly, ensuring the connect menu,
  // manual dragging, isValidConnection and the store's edge gate share the same rules.
  const allowedUpstream = getAllowedUpstreamSourceTypes(originType);
  if (allowedUpstream) {
    return manual(allowedUpstream);
  }

  return manual(base);
}

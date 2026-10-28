// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { Edge, Node, XYPosition } from '@xyflow/react';
import type {
  DirectorControlFrameBundle,
  DirectorObjectLayer,
  DirectorWorldSource,
} from '@/features/viewer-kit/three-d/directorManifest';
import type { KeyElementCategory } from './keyElements';

export const CANVAS_NODE_TYPES = {
  vectorSvg: 'vectorSvgNode',
  animatedGif: 'animatedGifNode',
  htmlArtifact: 'htmlArtifactNode',
  upload: 'uploadNode',
  imageEdit: 'imageNode',
  imageGen: 'imageGenNode',
  exportImage: 'exportImageNode',
  beatContext: 'beatContextNode',
  textAnnotation: 'textAnnotationNode',
  group: 'groupNode',
  storyboardSplit: 'storyboardNode',
  storyboardGen: 'storyboardGenNode',
  video: 'videoNode',
  audio: 'audioNode',
  videoStory: 'videoStoryNode',
  videoBreakdown: 'videoBreakdownNode',
  videoCompose: 'videoComposeNode',
  script: 'scriptNode',
  pano360Viewer: 'pano360ViewerNode',
  threeDWorld: 'threeDWorldNode',
  skill: 'skillNode',
  style: 'styleNode',
} as const;

export type CanvasNodeType = (typeof CANVAS_NODE_TYPES)[keyof typeof CANVAS_NODE_TYPES];

export const DEFAULT_ASPECT_RATIO = '1:1';
export const AUTO_REQUEST_ASPECT_RATIO = 'auto';
export const DEFAULT_NODE_WIDTH = 320;
export const EXPORT_RESULT_NODE_DEFAULT_WIDTH = 480;
export const EXPORT_RESULT_NODE_LAYOUT_HEIGHT = 360;
export const EXPORT_RESULT_NODE_MIN_WIDTH = 300;
export const EXPORT_RESULT_NODE_MIN_HEIGHT = 300;
// The resize lower bound is deliberately smaller than the creation/compact size, otherwise a node cannot shrink below its initial size (with keepAspectRatio
// the short side is the binding constraint, and after ratio conversion landscape/portrait both shrink to a consistent small box).
export const EXPORT_RESULT_NODE_RESIZE_MIN_EDGE = 140;

export const IMAGE_SIZES = ['0.5K', '1K', '2K', '4K'] as const;
export const IMAGE_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '21:9',
] as const;

export type ImageSize = (typeof IMAGE_SIZES)[number];

/** Image quality value advertised by the selected media model. */
export type ImageQuality = string;

export interface NodeDisplayData {
  displayName?: string;
  /**
   * The workflow runner has scheduled this node action. This is deliberately
   * separate from `isGenerating`, which is owned by the node after it accepts
   * and submits the generation request.
   */
  workflowActionRunning?: boolean;
  workflowActionStartedAt?: number | null;
  /** Key element category: the user marks this node as a key element and categorizes it (see domain/keyElements).
   *  Display-only metadata, persisted at canvas level, not read by the workflow side - undefined/null when unmarked. */
  keyElementCategory?: KeyElementCategory | null;
  /** Auto sequence number for unnamed nodes: written at creation and appended to the default name ("Text 1", "Text 2"...),
   *  avoiding duplicate names among nodes of the same type. Once the user edits displayName this number is no longer shown.
   *  See getDefaultNodeDisplayName / nextAutoTitleIndex in domain/nodeDisplay. */
  autoTitleIndex?: number;
  /**
   * The moment the node was created (epoch ms), written by nodeFactory and never changed afterwards.
   * Unlike `generationStartedAt`, this field is **persistent**: the latter is written back to
   * null after each generation pipeline finishes and exists only during the tens of seconds of spinning, leaving nothing afterwards. The sidebar outline relies on this field to tell
   * apart same-named nodes from "generating the same prompt three times", so the generation flow must never touch it.
   *
   * Nodes in old canvases (saved before the field was added) lack it and must be treated as undefined when read.
   */
  createdAt?: number | null;
  /**
   * Marker for nodes brought in by a cross-project paste, before the assets are copied into this project / after a failure (see
   * application/crossProjectAssets). While `'copying'` the media fields are always null - the source project's
   * URL never appears in the store or persisted data; the field is removed once the target project address is filled in.
   */
  assetMigration?: 'copying' | 'failed';
  [key: string]: unknown;
}

export interface NodeImageData extends NodeDisplayData {
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  isSizeManuallyAdjusted?: boolean;
  /**
   * The "replace asset" button at the top-right of the card is **always visible** (no need to select the node first). Clicking to
   * swap in a local file is a capability every card with content has; this switch only governs when the button is visible: the
   * output groups of frame-by-frame breakdown (storyboard/motion/music) are reference assets and swapping images is a frequent
   * action, so it is always shown; other nodes still show it only when selected, so the canvas isn't covered with a row of upload icons.
   */
  allowLocalReplace?: boolean;
  candidate_origin?: Record<string, unknown>;
  output_role?: string;
  committed_at?: string | null;
  committed_slot_url?: string | null;
  director_control_bundle?: DirectorControlFrameBundle;
  media_kind?: string;
  [key: string]: unknown;
}

export interface UploadImageNodeData extends NodeImageData {
  sourceFileName?: string | null;
  isUploading?: boolean;
  uploadError?: string | null;
  imageOnly?: boolean;
}

export type VideoGenMode =
  | 'textToVideo'
  | 'allReference'
  | 'firstFrame'
  | 'imageToVideo'
  | 'firstLastFrame'
  | 'imageReference'
  | 'videoEdit'
  | 'videoExtend'
  /**
   * MiniMax H3 Multishot (long continuous video, 2026-10-25) — chains an
   * ordered list of shots (text only; no per-shot image, see
   * {@link VideoMultishotShot}) into ONE continuous output video, starting
   * from a single upstream "start frame" image plus up to N shared
   * reference images. Only shown for a model whose catalog entry declares
   * `supportedModes: ["multishot"]` — see videoModelCapabilities.ts.
   */
  | 'multishot';

export type VideoGenQuality = string;
export type VideoGenCount = 1 | 2 | 4;
export type Seedance2SceneOptimize = 'anime' | 'realistic';

/**
 * One shot in a {@link VideoNodeData.multishotShots} list — raw,
 * user-authored visual text before any AI rewriting, plus the result of
 * the last `/freezone/video/multishot/review` call for that shot (if any).
 * `id` is client-generated (see `generateFrameId` in StoryboardGenNode.tsx
 * for the established pattern) and is how shot rows line up with the
 * review response and the final `shot_prompts` sent to the enqueue route —
 * never array order alone, since rows can be reordered/removed.
 */
export interface VideoMultishotShot {
  id: string;
  /** User's own freeform visual description — becomes `visual_description` server-side (see freezone/multishot.py). */
  description: string;
  /** AI-rewritten (or hand-edited) H3 prompt from the last review call. Null until reviewed. */
  finalPrompt?: string | null;
  lint?: Array<{ severity: 'error' | 'warning'; code: string; message: string }>;
  fallbackUsed?: boolean;
}

/** Failure reason for depth motion capture; `failed` is the fallback, with the raw error kept in errorDetail. */
export type DepthCaptureErrorCode =
  | 'tooLong'
  | 'noVideoTrack'
  | 'cannotDecode'
  | 'cancelled'
  | 'failed';

/** Processing state of depth motion capture (computed in the browser); on success it is written back to videoUrl and cleared to null. */
export interface DepthCaptureState {
  status: 'running' | 'failed';
  /** Integer percentage from 0 to 100. */
  progress: number;
  /** Source video address to rerun on retry. */
  sourceVideoUrl: string;
  errorCode: DepthCaptureErrorCode | null;
  errorDetail: string | null;
}

export interface VideoNodeData extends NodeDisplayData {
  videoUrl: string | null;
  previewImageUrl?: string | null;
  /**
   * The node is used as an "upstream video reference asset" (e.g. spawned by a script node).
   * Only the video itself + the top toolbar (edit/upscale/parse/...) are shown,
   * and the bottom generation panel (mode tabs / prompt / submit) is not rendered.
   */
  referenceOnly?: boolean;
  /** See NodeImageData.allowLocalReplace. */
  allowLocalReplace?: boolean;
  aspectRatio: string;
  isSizeManuallyAdjusted?: boolean;
  sourceFileName?: string | null;
  widthPx?: number | null;
  heightPx?: number | null;
  durationMs?: number | null;
  isUploading?: boolean;
  /** Processing state of the depth-motion-capture output node, see DepthCaptureState. */
  depthCapture?: DepthCaptureState | null;
  isAnalyzing?: boolean;
  analysisResult?: string | null;
  analysisError?: string | null;
  isSeparatingAv?: boolean;
  // clip editor (libtv-style) ------------------------------------------------
  isClipMode?: boolean;
  clipStartMs?: number | null;
  clipEndMs?: number | null;
  // frame crop ------------------------------------------------------
  /**
   * Temporary state on the **source** video node: a crop box is overlaid on the picture and a ratio bar hangs below.
   * The box itself is not persisted (writing the store at pointermove frequency would flush the undo stack); only this
   * toggle is node data. Mutually exclusive with isClipMode / isExtendPickMode / subtitleEraseMode.
   */
  isCropMode?: boolean;
  // smart extend (libtv-style) --------------------------------------
  /**
   * Temporary state on the **source** video node: currently capturing the "pre-extend video", with a segment-selection
   * track hanging below the card. The selection is not persisted (it takes a dozen drags to settle, and writing the store
   * each time would flush the undo stack); only clicking "Confirm extend" carries the range into the newly created
   * downstream node. Mutually exclusive with isClipMode.
   */
  isExtendPickMode?: boolean;
  /**
   * Downstream node produced by "smart extend": model locked to Seedance 2.5, mode locked to all-round reference, with a
   * fixed "Continue the mm:ss-mm:ss segment of X:" line ahead of the prompt. The prefix is not written into the prompt
   * itself (see extendPromptPrefix of [[videoExtendClip]]); it is only concatenated at submission time.
   */
  isExtendMode?: boolean;
  /** Asset name in the prefix, taken from the source node's displayName. Renaming the source node does not apply retroactively - the instruction has already been issued. */
  extendSourceName?: string;
  extendStartMs?: number;
  extendEndMs?: number;
  // subtitle erase (libtv-style smart subtitle removal) ----------------------------------
  /** `smart` = auto-estimate bottom subtitle band; `box` = user-drawn region. */
  subtitleEraseMode?: 'smart' | 'box' | null;
  /** Box coords normalized 0..1 against the source frame. Only set in 'box' mode. */
  subtitleEraseBox?: { x: number; y: number; width: number; height: number } | null;
  // generation fields (libtv-style operation panel)
  prompt?: string;
  /**
   * All result URLs (including the main video) when generation count > 1. When collapsed the node renders as
   * a stacked-card album (same as the image node); videoUrl always equals the one chosen as the main video.
   * Empty for single generation.
   */
  generationBatch?: string[] | null;
  genMode?: VideoGenMode;
  model?: string;
  quality?: VideoGenQuality;
  durationSec?: number;
  generateAudio?: boolean;
  modelParams?: Record<string, unknown>;
  /**
   * Real-person asset review switch. Shown only for Seedance 2.0 video models. When enabled the request body carries
   * `human_review: true`, lowering the chance of being blocked when assets contain real faces (no guarantee of passing; review may take longer).
   * Not sent when default false / not shown.
   */
  humanReview?: boolean;
  sceneOptimize?: Seedance2SceneOptimize;
  count?: VideoGenCount;
  /** id of a [[cameraMovementPresets]] entry — libtv-style camera movement preset. */
  cameraMovement?: string | null;
  // MiniMax H3 Multishot (2026-10-25) ----------------------------------------
  /** Ordered shot list for `genMode === 'multishot'`. `prompt` above doubles as the node's overall "director guidance" in this mode. */
  multishotShots?: VideoMultishotShot[];
  /** Fingerprint from the last `/freezone/video/multishot/review` call — must match at submit time or the backend returns 409 `INPUT_STALE`. */
  multishotReviewFingerprint?: string | null;
  multishotReviewedAt?: string | null;
  /**
   * Upstream reference order manually adjusted by dragging (list of upstream node ids). Decides the display order of reference chips,
   * the "Image N / Audio N" numbering, and the reference / first-last-frame order submitted to the backend. Upstream nodes not listed
   * (e.g. newly connected) come after, falling back to the node y coordinate.
   */
  referenceOrder?: string[];
  /** Uploaded document reference for all-reference generation. */
  referenceFileUrl?: string | null;
  referenceFileName?: string | null;
  /** Public HTTP(S) page reference for all-reference generation. */
  referenceLink?: string | null;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  generationError?: string | null;
  // Video upscale markers ----------------------------------------------------
  // Video nodes spawned by a video node's "Upscale" action carry these fields: they reuse the video node's player / badge /
  // size (same as plain video nodes), but isUpscaleNode suppresses the bottom generation panel and uses the
  // VideoUpscaleEditorOverlay that stays while selected instead (submitting submitFreezoneVideoUpscale; the upscale result is written back to this node's
  // videoUrl).
  /** Marks this video node as a "video upscale" node (parameter panel + upscale submission, not regular generation). */
  isUpscaleNode?: boolean;
  /** Static address of the upstream video to upscale. */
  upscaleSourceUrl?: string;
  /** Target resolution tier. */
  upscaleResolution?: '1080p' | '2k' | '4k';
  /** Denoise strength. */
  upscaleDenoise?: 'none' | '1x' | '2x';
  /**
   * Draft timeline when the storyboard detail "Edit" opens the compose timeline for this video node itself (written back when the dialog closes,
   * restored on reopen/refresh). Same semantics as {@link VideoComposeNodeData.draftTimeline},
   * structured as `ComposeTimelineState`; stored as unknown here so the domain layer does not depend back on the compose feature layer.
   */
  draftTimeline?: unknown;
  /** Target frame rate; auto keeps the source frame rate. */
  upscaleTargetFps?: 'auto' | 30 | 60 | 90;
  /** Slow-motion factor; auto keeps the original speed. */
  upscaleSlowdown?: 'auto' | '2x';
  /** Whether to enable smart frame interpolation when adjusting the frame rate. */
  upscaleSmartInterpolation?: boolean;
  /** Scene type of the source video. */
  upscaleScene?: 'realistic' | 'anime';
  /** Whether to enable dedicated face enhancement. */
  upscaleFaceEnhance?: boolean;
  [key: string]: unknown;
}

/**
 * "Video compose" node. After >= 2 upstream video nodes (optionally audio nodes) are connected, opens a libtv-style
 * timeline editor ({@link VideoComposeModal}) to arrange and export. The final compose goes through the backend
 * `submitFreezoneVideoCompose`, and the export address is written back to `resultVideoUrl`.
 */
export interface VideoComposeNodeData extends NodeDisplayData {
  /** The video url of the latest compose export. */
  resultVideoUrl?: string | null;
  /** Persistent task key of the latest successful result write-back, used for idempotent convergence. */
  resultVideoTaskKey?: string | null;
  /** Compose task ID of the latest successful result write-back. */
  resultVideoJobId?: string | null;
  /** Cover of the result video (empty while not yet generated). */
  previewImageUrl?: string | null;
  /** The export resolution used last time. */
  resolution?: '720p' | '1080p';
  /**
   * Draft timeline of the compose editor (written back when the dialog closes, restored on reopen/refresh). Structured as
   * `ComposeTimelineState`; stored as unknown here so the domain layer does not depend back on the compose feature layer.
   */
  draftTimeline?: unknown;
  /**
   * Compose input order declared by the dynamic workflow. Values are workflowPlanNodeId, not canvas UUIDs;
   * the frontend uses it to restore the shot-semantic order, avoiding treating layout position as playback order.
   */
  compositionInputOrder?: string[];
  [key: string]: unknown;
}

export type ExportImageNodeResultKind =
  | 'generic'
  | 'storyboardGenOutput'
  | 'storyboardSplitExport'
  | 'storyboardFrameEdit'
  | 'matte'
  | 'upscale';

export interface ExportImageNodeData extends NodeImageData {
  resultKind?: ExportImageNodeResultKind;
}

export interface GroupNodeData extends NodeDisplayData {
  label: string;
  /** Group background color (base hex, see groupColors.ts). Empty/absent uses the default base color. */
  backgroundColor?: string | null;
  /**
   * Marks a group created via "Merge storyboard group" — its members are laid out as an
   * ordered shot grid. Plain "Group" groups leave this unset.
   */
  storyboardGroup?: boolean;
  /** Cell aspect ratio key for the storyboard grid, e.g. "16:9". */
  storyboardAspect?: string;
  /** Column count of the storyboard grid. */
  storyboardCols?: number;
  /** Show a 1-based index badge on each cell. */
  storyboardShowIndex?: boolean;
  /** Largest member content box at merge time — the cell-size floor for re-layout. */
  storyboardBaseWidth?: number;
  storyboardBaseHeight?: number;
  [key: string]: unknown;
}

export type TextNodeMode =
  | 'writing'
  | 'textToVideo'
  | 'imageToPrompt'
  // textToMusic: a historical name that actually means "clone audio" (voice-cloning TTS), deriving a speech audio node.
  | 'textToMusic'
  // textToMusicGen: "text to music", deriving an audio node with audioKind='music' (via /freezone/audio/music).
  | 'textToMusicGen';

export interface TextAnnotationNodeData extends NodeDisplayData {
  content: string;
  /**
   * The node is used as an "upstream reference asset" (e.g. spawned by a script node).
   * Only the edit card is shown; the mode list / model selection / submit button are not rendered.
   */
  referenceOnly?: boolean;
  /**
   * Steering description shown in the ops textarea for `imageToPrompt` mode.
   * Kept separate from `content` so the API result can overwrite the preview
   * card without erasing the user's instruction.
   */
  instruction?: string;
  mode?: TextNodeMode;
  model?: string;
  /**
   * The user has already chosen once from the capability picker (e.g. "text to music" derived a downstream audio node).
   * When true this text node is always a plain-text editing area, and no longer falls back to the "Try" picker when empty.
   */
  pickerDismissed?: boolean;
  extraParams?: Record<string, unknown>;
  isGenerating?: boolean;
  /** Start timestamp of async tasks such as reverse-prompt, feeding the generating loading overlay's simulated progress. */
  generationStartedAt?: number | null;
  [key: string]: unknown;
}

export interface BeatContextNodeData extends NodeDisplayData {
  content?: string;
  projectId?: string;
  episode?: number;
  beat?: number;
  snapshot?: {
    visualDescription?: string;
    narrationSegment?: string;
    sceneId?: string;
    sceneVariantId?: string;
    timeOfDay?: string;
    detectedIdentities?: string[];
    detectedProps?: string[];
    sketchColors?: Record<string, string>;
    propMarkerColors?: Record<string, string>;
    selectedBackgroundExists?: boolean;
    currentSketchExists?: boolean;
    currentFrameExists?: boolean;
    [key: string]: unknown;
  };
  syncStatus?: 'fresh' | 'stale' | 'syncing' | 'error';
  errorMessage?: string;
  mainline_context?: unknown;
  beat_edit_fields?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ImageEditNodeData extends NodeImageData {
  prompt: string;
  model: string;
  size: ImageSize;
  requestAspectRatio?: string;
  generationMode?: 'text_to_image' | 'image_to_image' | 'all_reference' | 'image_reference';
  extraParams?: Record<string, unknown>;
  /** Dynamic parameter values declared by the backend "media model" catalog, sent as `model_params` on submit. */
  modelParams?: Record<string, unknown>;
  capabilityId?: string;
  capabilityParams?: Record<string, unknown>;
  capabilityInputs?: Record<
    string,
    {
      nodeId?: string;
      role?: string;
      sourceUrl?: string;
      assetKind?: string;
    }
  >;
  capabilityOutputKind?: string;
  capabilityDefaultPushTarget?: Record<string, unknown>;
  compiledPromptPreview?: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
}

export type ImageGenCount = 1 | 2 | 4;

export interface ImageGenFocusRegion {
  /** Normalized 0-1 coordinates against the upstream source image. */
  sourceUrl: string;
  x: number;
  y: number;
  width: number;
  height: number;
  aspectRatio?: string;
}

export interface ImageGenCameraSelection {
  cameraBodyId?: string | null;
  lensId?: string | null;
  focalLengthMm?: number | null;
  aperture?: string | null;
}

export interface ImageGenNodeData extends NodeImageData {
  prompt: string;
  model: string;
  size: ImageSize;
  /**
   * All result URLs (including the main image) when generation count > 1. When collapsed the node renders as a
   * stacked-card album (cards peek out from behind the main image), and imageUrl always equals the one
   * chosen as the main image. Empty for single-image generation.
   */
  generationBatch?: string[] | null;
  /** Quality preset for image2 models; defaults to 'medium' when unset. */
  quality?: ImageQuality;
  modelParams?: Record<string, unknown>;
  requestAspectRatio?: string;
  count?: ImageGenCount;
  styleTemplateId?: string | null;
  focusRegion?: ImageGenFocusRegion | null;
  cameraSelection?: ImageGenCameraSelection | null;
  /** User-uploaded reference image, fed into the generation request. */
  referenceImageUrl?: string | null;
  /**
   * Set on image nodes created from an H3 video template. When the user uploads their own picture
   * into such a node, a workflow run uses it as-is instead of regenerating it from the template prompt.
   */
  h3TemplateInput?: boolean;
  /**
   * Storyboard "feature" node: the empty node built after clicking a one-image feature in the image detail (grid template / panorama /
   * multi-angle / lighting) carries this key; the input box shows it as a closable feature chip,
   * and submitting with the up button goes through the matching capability instead of regular text-to-image. For the value domain see `AssetBoardImageOpKey` in
   * application/assetBoardImageOps (not imported here, the domain does not depend on application).
   * After it is cleared (chip closed) the node degrades to a plain image generation node.
   */
  imageOpKey?: string | null;
  /** Source image URL of a feature node (= the image when the feature was clicked), sent as source_url on submit. */
  imageOpSourceUrl?: string | null;
  /** Present/mainline workflow nodes can auto-commit their generated image to slot_target. */
  autoCommitOnGenerate?: boolean;
  /** Local-only marks/annotations placed on upstream image. */
  marks?: Array<{ id: string; label: string; x: number; y: number }>;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  /** Last failure reason, kept on the node until the next submit. */
  generationError?: string | null;
  /** Gateway request id parsed from the last failure, for support tracing. */
  generationErrorRequestId?: string | null;
}

export interface StoryboardFrameItem {
  id: string;
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio?: string;
  note: string;
  order: number;
}

export interface StoryboardExportOptions {
  showFrameIndex: boolean;
  showFrameNote: boolean;
  notePlacement: 'overlay' | 'bottom';
  imageFit: 'cover' | 'contain';
  frameIndexPrefix: string;
  cellGap: number;
  outerPadding: number;
  fontSize: number;
  backgroundColor: string;
  textColor: string;
}

export interface StoryboardSplitNodeData {
  displayName?: string;
  aspectRatio: string;
  frameAspectRatio?: string;
  gridRows: number;
  gridCols: number;
  frames: StoryboardFrameItem[];
  exportOptions?: StoryboardExportOptions;
  [key: string]: unknown;
}

export interface StoryboardGenFrameItem {
  id: string;
  description: string;
  referenceIndex: number | null;
}

export type StoryboardRatioControlMode = 'overall' | 'cell';

export interface StoryboardGenNodeData {
  displayName?: string;
  gridRows: number;
  gridCols: number;
  frames: StoryboardGenFrameItem[];
  ratioControlMode?: StoryboardRatioControlMode;
  model: string;
  size: ImageSize;
  requestAspectRatio: string;
  extraParams?: Record<string, unknown>;
  /** Dynamic parameter values declared by the backend "media model" catalog, sent as `model_params` on submit. */
  modelParams?: Record<string, unknown>;
  imageUrl: string | null;
  previewImageUrl?: string | null;
  aspectRatio: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  [key: string]: unknown;
}

export type AudioTextSegment =
  | { type: 'text'; value: string }
  | { type: 'pause'; durationSec: number }
  | { type: 'filler'; token: string };

/**
 * Backend freezone-audio voice reference: scope is required, while character_name / identity_id / slot
 * depend on scope. Isomorphic with `FreezoneAudioVoiceRef` in ops.ts, but the frontend keeps its own
 * camelCase fields here so node data is not serialized as snake_case.
 */
export interface AudioVoiceRef {
  scope:
    | 'project_narrator'
    | 'user_custom'
    | 'character_default'
    | 'character_age_group'
    | 'identity'
    | 'identity_resolved';
  characterName?: string;
  identityId?: string;
  slot?: string;
  /** Required when scope=user_custom: account-level "my voice" ID (from /freezone/audio/voices). */
  voiceId?: string;
}

export interface AudioNodeData extends NodeDisplayData {
  audioUrl: string | null;
  sourceFileName?: string | null;
  durationMs?: number | null;
  isUploading?: boolean;
  /** See NodeImageData.allowLocalReplace. */
  allowLocalReplace?: boolean;
  /**
   * Generation type of the audio node:
   * - 'speech' (default/absent): clone audio, text to speech (/freezone/audio/speech), using voiceRef/tone words.
   * - 'music': text to music (/freezone/audio/eleven-music), using text as the music description prompt.
   */
  audioKind?: 'speech' | 'music';
  /**
   * Voice source in speech mode:
   * - preset: system voice, direct text-to-speech, no reference audio needed.
   * - clone: project/character/account voice, needs existing reference audio.
   */
  speechMode?: 'preset' | 'clone';
  presetVoice?: string;
  presetModel?: string;
  /** New/converted nodes use explicit voice selection; absent on historical canvas nodes. */
  voicePolicyConfirmed?: boolean;
  /** music mode: generation length (ms), range 3000-600000, defaulting to the backend default 30000 when absent. */
  musicLengthMs?: number;
  /** music mode: whether to force instrumental (force_instrumental), default true when absent. */
  forceInstrumental?: boolean;
  /** music mode: whether to strictly follow the music section duration policy (respect_sections_durations), default true when absent. */
  respectSectionsDurations?: boolean;
  // operations panel (TTS) ---------------------------------------------------
  /** Plain text to synthesize. New field, the main one going forward. */
  text?: string;
  /** Legacy field: segments left by the segment editor; kept only for compatibility with old node data. */
  segments?: AudioTextSegment[];
  /**
   * Tone words (emotion prompt). Free user input, mapped to the backend `emotion_prompt` on submit.
   * Example: "tense, hushed, with a hint of fear". When empty the backend uses the project's narration style default.
   */
  emotionPrompt?: string;
  /** The selected voice reference (a record from the freezone-audio references endpoint). */
  voiceRef?: AudioVoiceRef | null;
  /** Whether the latest voice list load confirmed at least one usable voice; absent means not yet confirmed. */
  voiceAvailable?: boolean;
  /** Display name of the current voice (cached from the references endpoint, avoiding a reload of the list after each selection). */
  voiceLabel?: string;
  /** Language label of the current voice (from references; may be empty). */
  voiceLanguage?: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  /**
   * Generation failure info. Persisted into node data (not panel-local state), so after canvas virtualization
   * unmount/remount the error + retry can still be shown and is not lost when components are rebuilt. Cleared on success/start.
   */
  generationError?: string | null;
  /** Transient: which format the download menu is currently transcoding to. */
  convertingAudioFormat?: 'mp3' | 'm4a' | 'wav' | null;
  [key: string]: unknown;
}

export interface VideoStoryRow {
  /** Shot number — 1-based shot index, optional because some payloads only sequence rows by array order. */
  shotNumber?: number | string | null;
  /** Start time (HH:MM:SS or seconds, kept as string for display flexibility). */
  startTime?: string | null;
  /** End time. */
  endTime?: string | null;
  /** Duration (e.g. "1.2s"). */
  duration?: string | null;
  /** Visual description. */
  visualDescription?: string | null;
  /** Narrative content. */
  narrative?: string | null;
  /** Shot size. */
  shotSize?: string | null;
  /** Camera angle. */
  cameraAngle?: string | null;
  /** Camera movement. */
  cameraMovement?: string | null;
  /** Focal length and depth of field. */
  focalAndDof?: string | null;
  /** Lighting. */
  lighting?: string | null;
  /** Background music. */
  backgroundMusic?: string | null;
  /** Vocals / sound effects. */
  voiceAndSfx?: string | null;
  /** Image generation prompt. */
  imagePrompt?: string | null;
  /** Video motion prompt. */
  videoMotionPrompt?: string | null;
  /** Static URL of the keyframe. */
  keyframeUrl?: string | null;
  /** Raw backend row kept around so we can render fields we didn't normalize. */
  raw?: Record<string, unknown>;
}

export interface VideoStoryNodeData extends NodeDisplayData {
  /** Source video URL the rows were derived from (for audit / re-runs). */
  sourceVideoUrl?: string | null;
  rows: VideoStoryRow[];
  /** Last successful raw payload from the backend for debug/regen. */
  rawResult?: Record<string, unknown> | null;
  isAnalyzing?: boolean;
  /** Analysis start timestamp, used to simulate the progress percentage of the loading overlay. */
  analysisStartedAt?: number | null;
  analysisError?: string | null;
  [key: string]: unknown;
}

/**
 * Frame-by-frame breakdown dimensions. One breakdown run can pick several dimensions at once,
 * each producing an independent result group downstream (storyboard group / motion-camera reference / music-BGM reference clip).
 */
export const VIDEO_BREAKDOWN_DIMENSIONS = ['storyboard', 'motion', 'music'] as const;
export type VideoBreakdownDimension = (typeof VIDEO_BREAKDOWN_DIMENSIONS)[number];

/**
 * Frame-by-frame breakdown node: splits a video into three dimensions — storyboard / motion / music.
 *
 * Source video has two origins — local upload (via /freezone/upload into OSS) and "pick from canvas"
 * (click an existing video node on the canvas, connect an edge and backfill the URL). Both paths only
 * ever write `sourceVideoUrl`; the node itself does not distinguish the origin.
 */
export interface VideoBreakdownNodeData extends NodeDisplayData {
  /** Video URL to break down; empty means the node is in its "upload a video to start" empty state. */
  sourceVideoUrl?: string | null;
  /** Source thumbnail (inherited from the upstream video node's cover when picked from canvas). */
  previewImageUrl?: string | null;
  /** Uploaded file name / upstream node title, shown as the source label. */
  sourceFileName?: string | null;
  /** Upstream video node id selected via "pick from canvas", audit-only. */
  sourceNodeId?: string | null;
  /** Selected breakdown dimensions, at least one kept at all times. */
  dimensions?: VideoBreakdownDimension[];
  /** A local upload is in progress — the source area shows a loading state and blocks re-triggering. */
  isUploading?: boolean;
  /** A breakdown task is in progress. */
  isBreakingDown?: boolean;
  breakdownStartedAt?: number | null;
  breakdownError?: string | null;
  [key: string]: unknown;
}

export type ScriptGenAction = 'fromScript' | 'fromVideoRef' | 'fromCharacter';

export interface ScriptNodeData extends NodeDisplayData {
  /** Story / reference description text entered in the operation area */
  prompt?: string;
  /** Id of the selected script generation model (hard-coded by the frontend, not provided by the backend API) */
  model?: string;
  /** The quick action the user clicked last (does not affect submission, only used for UI highlight / default hint) */
  lastAction?: ScriptGenAction | null;
  /** Generation result ({ title, rows[] } returned by the freezone story-script endpoint). */
  scriptResult?: unknown;
  /** Title of the latest generation, convenient to show in the node header. */
  scriptTitle?: string | null;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  /** Error message of the latest failed generation, rendered on the node body (still visible after the submit panel is deselected). */
  generationError?: string | null;
  [key: string]: unknown;
}

/**
 * 360 panorama viewer node.
 * View state (viewYawDeg / viewPitchDeg) is only the "current view" when Photo Sphere Viewer renders,
 * and does not take part in persistence (every time the user opens the node it returns to yaw=0/pitch=0).
 * What is persisted are the "correction" parameters: sphereCorrectionDeg rotates the texture to horizontal, frontYawDeg aligns the
 * "front" of the render coordinate system to the scene's real front, and fovDeg is the default FOV.
 */
export interface Pano360ViewerNodeData extends NodeDisplayData {
  imageUrl: string | null;
  previewImageUrl?: string | null;
  /** Upstream connected node id, used only for audit. */
  sourceNodeId?: string | null;
  /** Sphere texture correction (in degrees, roll/pitch/yaw all in [-180, 180], pitch clamped internally to [-90, 90]). */
  sphereCorrectionDeg: { roll: number; pitch: number; yaw: number };
  /** The yaw corresponding to the scene's "front" (in degrees, [-180, 180]). */
  frontYawDeg: number;
  /** Default FOV, in degrees, range [FOV_MIN, FOV_MAX] = [5, 170]. */
  fovDeg: number;
  /** JSON of the last screenshot export, for debugging; not part of the persisted lifecycle. */
  lastExportedEntry?: Record<string, unknown> | null;
  [key: string]: unknown;
}

/**
 * 3D world node. Image upstreams go through freezone/image-to-3gs: plain images use source_kind="master",
 * 360 panoramas use source_kind="pano". The node can also add a 360 image directly as a pano360 source
 * for director-world framing. After generation completes `sources` is written first, with `plyUrl`/`panoUrl` remaining as
 * the node's local shortcut fields.
 */
export interface ThreeDWorldNodeData extends NodeDisplayData {
  /** User prompt (entered below the operation panel). */
  prompt?: string;
  /** Model id. The model is not integrated yet, so the frontend hard-codes 'marble-1.1'. */
  model?: string;
  /** task_key of the image-to-3gs async task, used for await + UI state display. */
  taskKey?: string | null;
  /** Static address of the 3GS package returned after the backend SHARP run finishes; SOG preferred, old PLY still compatible. */
  plyUrl?: string | null;
  /** Used when a 360 panorama is a world source; it can only turn to frame, not move through real space. */
  panoUrl?: string | null;
  /** Director World sources, kept in manifest-native source shape. */
  sources?: DirectorWorldSource[];
  /** Active Director World source id, mapped to manifest.active_source_id. */
  activeSourceId?: string | null;
  /** Per-source director scene snapshots; keeps pano/SOG camera and placements independent. */
  scenesBySourceId?: Record<string, unknown>;
  /** Per-source object layers, mapped to manifest snake_case when supported. */
  layersBySourceId?: Record<string, DirectorObjectLayer>;
  /** Source node id, used only for audit. */
  sourceNodeId?: string | null;
  /** Source type: image / text — decides which API the submission goes through. */
  sourceKind?: 'image' | 'text' | null;
  /** Source type of image-to-3gs (the backend source_kind field):
   * master/reverse generate a single-face 3GS, pano goes through the 360 panorama. Default master. */
  plyKind?: 'master' | 'reverse' | 'pano';
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationDurationMs?: number;
  /** Error message (shown when submission or the task fails). */
  errorMessage?: string | null;
  /**
   * Node thumbnail. When added from the asset library, the scene image of the same scene is filled in as the cover; once an upstream
   * image node is connected the upstream image takes priority, with no upstream it falls back to previewImageUrl, and only when that is also absent
   * is the Orbit placeholder shown.
   */
  previewImageUrl?: string | null;
  /**
   * Snapshot of the 3D viewer's internal editing state (actors / props / staging + camera view).
   * Written when the user presses the viewer sidebar's "Save scene edits" button; restored automatically on the next viewer entry.
   * The structure is defined by the viewer engine itself as `ThreeDSceneSnapshot`, transparent to the canvas store.
   */
  scene?: unknown;
  [key: string]: unknown;
}

export interface SkillNodeData extends NodeDisplayData {
  skill_id: string;
  skill_schema_version?: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationError?: string | null;
  skillRunId?: string | null;
  skillInputSignature?: string | null;
  skillIdempotencyKey?: string | null;
  generationTaskKey?: string | null;
  generationTaskType?: string | null;
  generationTaskJobId?: string | null;
  parameters?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface HtmlArtifactNodeData extends NodeDisplayData {
  artifactId?: string | null;
  artifactVersion?: number | null;
  prompt?: string;
  isGenerating?: boolean;
  generationStartedAt?: number | null;
  generationError?: string | null;
  generationTaskKey?: string | null;
  generationTaskType?: string | null;
  generationTaskJobId?: string | null;
  htmlGenerationArtifactId?: string | null;
  htmlGenerationBaseVersion?: number | null;
  htmlGenerationSourceVersion?: number | null;
  htmlGenerationTitle?: string | null;
  htmlGenerationSelectionToken?: string | null;
  htmlSelectionToken?: string | null;
  htmlGenerationPhase?:
    | 'generating'
    | 'saving'
    | 'save_failed'
    | 'conflict'
    | 'invalid_output'
    | 'generation_failed'
    | 'completed';
  [key: string]: unknown;
}

/**
 * "Style node" on the canvas: the projection of an image node's `styleTemplateId` onto the canvas; it does not take part in
 * generation requests itself (submission still reads the downstream image node's `styleTemplateId`). Create/edit/delete are driven by
 * the reconciliation rules of [[styleNodeSync]]; users cannot create one separately from a menu.
 */
export interface StyleNodeData extends NodeDisplayData {
  styleTemplateId: string | null;
}

export type CanvasNodeData =
  | UploadImageNodeData
  | ExportImageNodeData
  | BeatContextNodeData
  | TextAnnotationNodeData
  | GroupNodeData
  | ImageEditNodeData
  | ImageGenNodeData
  | StoryboardSplitNodeData
  | StoryboardGenNodeData
  | VideoNodeData
  | AudioNodeData
  | VideoStoryNodeData
  | VideoBreakdownNodeData
  | VideoComposeNodeData
  | ScriptNodeData
  | Pano360ViewerNodeData
  | ThreeDWorldNodeData
  | SkillNodeData
  | HtmlArtifactNodeData
  | StyleNodeData;

export type CanvasNode = Node<CanvasNodeData, CanvasNodeType>;
export type VideoKeyframeSlot = 'first' | 'last';

export interface CanvasEdgeData extends Record<string, unknown> {
  /** Stable keyframe role for an image connected to a video node. */
  keyframeSlot?: VideoKeyframeSlot;
}

export type CanvasEdge = Edge<CanvasEdgeData>;

export interface NodeCreationDto {
  type: CanvasNodeType;
  position: XYPosition;
  data?: Partial<CanvasNodeData>;
}

export interface StoryboardNodeCreationDto {
  position: XYPosition;
  rows: number;
  cols: number;
  frames: StoryboardFrameItem[];
}

export const NODE_TOOL_TYPES = {
  crop: 'crop',
  annotate: 'annotate',
  splitStoryboard: 'split-storyboard',
} as const;

export type NodeToolType = (typeof NODE_TOOL_TYPES)[keyof typeof NODE_TOOL_TYPES];

export interface ActiveToolDialog {
  nodeId: string;
  toolType: NodeToolType;
}

/**
 * The sole switch for the "replace asset" button at the top-right inside the card (NodeMediaReplaceButton).
 *
 * Only the output groups of frame-by-frame breakdown (storyboard / motion / music) carry allowLocalReplace - those are reference
 * assets, and swapping in your own image/track is a frequent action, so the button stays on the card. Every other node gets no
 * in-card button (otherwise the canvas is covered with a row of upload icons, and it is easy to mis-click and replace a generated
 * result); their "drag onto the asset library to replace" gesture goes through the AssetCommitHandle floating outside the node -
 * the two entry points are mutually exclusive, see SelectedNodeOverlay.
 */
export function hasInlineMediaReplaceButton(
  data: { allowLocalReplace?: boolean } | null | undefined
): boolean {
  return data?.allowLocalReplace === true;
}

export function isUploadNode(
  node: CanvasNode | null | undefined
): node is Node<UploadImageNodeData, typeof CANVAS_NODE_TYPES.upload> {
  return node?.type === CANVAS_NODE_TYPES.upload;
}

export function isImageEditNode(
  node: CanvasNode | null | undefined
): node is Node<ImageEditNodeData, typeof CANVAS_NODE_TYPES.imageEdit> {
  return node?.type === CANVAS_NODE_TYPES.imageEdit;
}

export function isImageGenNode(
  node: CanvasNode | null | undefined
): node is Node<ImageGenNodeData, typeof CANVAS_NODE_TYPES.imageGen> {
  return node?.type === CANVAS_NODE_TYPES.imageGen;
}

export function isExportImageNode(
  node: CanvasNode | null | undefined
): node is Node<ExportImageNodeData, typeof CANVAS_NODE_TYPES.exportImage> {
  return node?.type === CANVAS_NODE_TYPES.exportImage;
}

/**
 * "Upscale result node with no image yet": the kind pre-created by `createUpscaleResultNode`, where the user has not yet pressed up to submit
 * (or the task has not yet filled back).
 *
 * The `previewImageUrl` of such a node stores the **source image to be enlarged**, used as a reference for the editor; but it is not
 * this node's content. If anyone renders it as a thumbnail, the user would think it is already the enlarged result - so
 * every judgment about "what this node looks like / whether it has material to operate on" must ask here first, and the answer is no.
 */
export function isPendingUpscaleNode(node: CanvasNode | null | undefined): boolean {
  if (!isExportImageNode(node)) return false;
  const data = node.data as { resultKind?: unknown; imageUrl?: unknown };
  return data.resultKind === 'upscale' && !data.imageUrl;
}

export function isStyleNode(
  node: CanvasNode | null | undefined
): node is Node<StyleNodeData, typeof CANVAS_NODE_TYPES.style> {
  return node?.type === CANVAS_NODE_TYPES.style;
}

export function isBeatContextNode(
  node: CanvasNode | null | undefined
): node is Node<BeatContextNodeData, typeof CANVAS_NODE_TYPES.beatContext> {
  return node?.type === CANVAS_NODE_TYPES.beatContext;
}

export function isGroupNode(
  node: CanvasNode | null | undefined
): node is Node<GroupNodeData, typeof CANVAS_NODE_TYPES.group> {
  return node?.type === CANVAS_NODE_TYPES.group;
}

export function isStoryboardGroupNode(
  node: CanvasNode | null | undefined
): node is Node<GroupNodeData, typeof CANVAS_NODE_TYPES.group> {
  return isGroupNode(node) && node.data.storyboardGroup === true;
}

export function isProtectedProjectionGroupNode(
  node: CanvasNode | null | undefined
): node is Node<GroupNodeData, typeof CANVAS_NODE_TYPES.group> {
  if (!isGroupNode(node)) {
    return false;
  }
  return (
    node.data.user_spawned !== true &&
    typeof node.data.projection_key === 'string' &&
    node.data.projection_key.trim().length > 0
  );
}

export function isTextAnnotationNode(
  node: CanvasNode | null | undefined
): node is Node<TextAnnotationNodeData, typeof CANVAS_NODE_TYPES.textAnnotation> {
  return node?.type === CANVAS_NODE_TYPES.textAnnotation;
}

export function isStoryboardSplitNode(
  node: CanvasNode | null | undefined
): node is Node<StoryboardSplitNodeData, typeof CANVAS_NODE_TYPES.storyboardSplit> {
  return node?.type === CANVAS_NODE_TYPES.storyboardSplit;
}

export function isStoryboardGenNode(
  node: CanvasNode | null | undefined
): node is Node<StoryboardGenNodeData, typeof CANVAS_NODE_TYPES.storyboardGen> {
  return node?.type === CANVAS_NODE_TYPES.storyboardGen;
}

export function isVideoNode(
  node: CanvasNode | null | undefined
): node is Node<VideoNodeData, typeof CANVAS_NODE_TYPES.video> {
  return node?.type === CANVAS_NODE_TYPES.video;
}

export function isAudioNode(
  node: CanvasNode | null | undefined
): node is Node<AudioNodeData, typeof CANVAS_NODE_TYPES.audio> {
  return node?.type === CANVAS_NODE_TYPES.audio;
}

export function isSkillNode(
  node: CanvasNode | null | undefined
): node is Node<SkillNodeData, typeof CANVAS_NODE_TYPES.skill> {
  return node?.type === CANVAS_NODE_TYPES.skill;
}

export function isVideoStoryNode(
  node: CanvasNode | null | undefined
): node is Node<VideoStoryNodeData, typeof CANVAS_NODE_TYPES.videoStory> {
  return node?.type === CANVAS_NODE_TYPES.videoStory;
}

export function isVideoBreakdownNode(
  node: CanvasNode | null | undefined
): node is Node<VideoBreakdownNodeData, typeof CANVAS_NODE_TYPES.videoBreakdown> {
  return node?.type === CANVAS_NODE_TYPES.videoBreakdown;
}

export function isScriptNode(
  node: CanvasNode | null | undefined
): node is Node<ScriptNodeData, typeof CANVAS_NODE_TYPES.script> {
  return node?.type === CANVAS_NODE_TYPES.script;
}

export function isVideoComposeNode(
  node: CanvasNode | null | undefined
): node is Node<VideoComposeNodeData, typeof CANVAS_NODE_TYPES.videoCompose> {
  return node?.type === CANVAS_NODE_TYPES.videoCompose;
}

export function isPano360ViewerNode(
  node: CanvasNode | null | undefined
): node is Node<Pano360ViewerNodeData, typeof CANVAS_NODE_TYPES.pano360Viewer> {
  return node?.type === CANVAS_NODE_TYPES.pano360Viewer;
}

export function isThreeDWorldNode(
  node: CanvasNode | null | undefined
): node is Node<ThreeDWorldNodeData, typeof CANVAS_NODE_TYPES.threeDWorld> {
  return node?.type === CANVAS_NODE_TYPES.threeDWorld;
}

export function nodeHasImage(node: CanvasNode | null | undefined): boolean {
  if (!node) {
    return false;
  }

  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
    return Boolean(node.data.imageUrl);
  }

  if (isStoryboardSplitNode(node)) {
    return node.data.frames.some((frame) => Boolean(frame.imageUrl));
  }

  if (isStoryboardGenNode(node)) {
    return Boolean(node.data.imageUrl);
  }

  return false;
}

// The single image an image-bearing node's toolbar/tools should act on.
// imageGen has no generated result until the user hits Generate, but an uploaded
// reference image (referenceImageUrl) is still the image shown on the node — operations
// like matting / crop / cell extraction should target it, matching ImageGenNode's previewUrl
// fallback order (imageUrl → previewImageUrl → referenceImageUrl).
export function resolveNodeSourceImageUrl(
  node: CanvasNode | null | undefined
): string | null {
  if (!node) {
    return null;
  }
  if (isImageGenNode(node)) {
    return node.data.imageUrl || node.data.previewImageUrl || node.data.referenceImageUrl || null;
  }
  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
    return node.data.imageUrl || node.data.previewImageUrl || null;
  }
  return null;
}

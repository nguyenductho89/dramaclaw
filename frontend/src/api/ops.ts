// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { apiCall, apiCallEnvelope, apiClient } from "./client";
import { workflowProductOperation } from "@/features/canvas/application/workflowExecutionActivity";
import { readReferenceMediaLimits, type ReferenceMediaLimits } from "./referenceMediaLimits";

// Per-node generation history -------------------------------------------- //

/**
 * Optional canvas/node context the backend uses to record a per-node
 * generation history entry. Generation-style endpoints accept these; omitting
 * them is harmless (the backend simply skips history recording). Mixed into
 * each generation payload via {@link FreezoneNodeContext}.
 */
export interface FreezoneNodeContext {
  /** Current canvas id, usually "default". */
  canvasId?: string | null;
  /** Id of the node that triggered the generation. */
  nodeId?: string | null;
  modelParams?: Record<string, unknown>;
}

export type FreezoneRecipeNodeKind = "image" | "video" | "audio" | "text";
export type FreezoneRecipeCompileMode =
  | "deterministic"
  | "memory_cache"
  | "persistent_cache"
  | "model"
  | "timeout_fallback";

export interface FreezoneRecipeCompileMetadata {
  mode: FreezoneRecipeCompileMode;
  prompt: string;
  recipeIds: string[];
}

export interface FreezoneRecipeCompilePayload {
  projectId?: string;
  productOperationId?: string;
  recipeId: string;
  recipeVersion?: string;
  recipePipeline?: Array<{ id: string; version?: string }>;
  skillId?: string;
  skillVersion?: string;
  confirmedInputs?: Record<string, unknown>;
  nodeKind: FreezoneRecipeNodeKind;
  promptStrategy?: "template" | "user_message" | "previous_output" | "llm_refine";
  nodePrompt?: string;
  userGoal?: string;
  upstreamText?: string;
  referenceMedia?: Array<{
    kind: "image" | "video" | "audio";
    label?: string;
  }>;
  onCompileMetadata?: (metadata: FreezoneRecipeCompileMetadata) => void;
}

const RECIPE_MODEL_TIMEOUT_MS = 10 * 60 * 1000;
const RECIPE_COMPILE_BATCH_WINDOW_MS = 15;
const RECIPE_COMPILE_BATCH_MAX_ITEMS = 12;

interface FreezoneRecipeCompileWireData {
  prompt: string;
  compile_mode?: FreezoneRecipeCompileMode;
  recipe_ids?: string[];
}

interface PendingRecipeCompile {
  payload: FreezoneRecipeCompilePayload;
  resolve: (prompt: string) => void;
  reject: (error: unknown) => void;
}

const pendingRecipeCompiles: PendingRecipeCompile[] = [];
let recipeCompileBatchTimer: ReturnType<typeof setTimeout> | null = null;
let recipeCompileRequestSequence = 0;

function recipeCompileJson(payload: FreezoneRecipeCompilePayload) {
  return {
    ...(payload.projectId ? { project_id: payload.projectId } : {}),
    ...(payload.productOperationId
      ? { product_operation_id: payload.productOperationId }
      : {}),
    recipe_id: payload.recipeId,
    recipe_version: payload.recipeVersion ?? "",
    ...(payload.recipePipeline?.length
      ? { recipe_pipeline: payload.recipePipeline }
      : {}),
    skill_id: payload.skillId ?? "",
    skill_version: payload.skillVersion ?? "",
    confirmed_inputs: payload.confirmedInputs ?? {},
    node_kind: payload.nodeKind,
    prompt_strategy: payload.promptStrategy ?? "llm_refine",
    node_prompt: payload.nodePrompt ?? "",
    user_goal: payload.userGoal ?? "",
    upstream_text: payload.upstreamText ?? "",
    reference_media: payload.referenceMedia ?? [],
  };
}

function resolveRecipeCompile(
  pending: PendingRecipeCompile,
  data: FreezoneRecipeCompileWireData,
): void {
  pending.payload.onCompileMetadata?.({
    mode: data.compile_mode ?? "model",
    prompt: data.prompt,
    recipeIds: Array.isArray(data.recipe_ids)
      ? data.recipe_ids.filter((item): item is string => typeof item === "string" && item.length > 0)
      : [
          pending.payload.recipeId,
          ...(pending.payload.recipePipeline ?? []).map((item) => item.id),
        ],
  });
  pending.resolve(data.prompt);
}

async function sendSingleRecipeCompile(pending: PendingRecipeCompile): Promise<void> {
  try {
    const data = await apiCall<FreezoneRecipeCompileWireData>("freezone/recipes/compile", {
      method: "POST",
      // Prompt compilation invokes the text model before the media task exists.
      timeout: RECIPE_MODEL_TIMEOUT_MS,
      json: recipeCompileJson(pending.payload),
    });
    resolveRecipeCompile(pending, data);
  } catch (error) {
    pending.reject(error);
  }
}

async function sendRecipeCompileBatch(batch: PendingRecipeCompile[]): Promise<void> {
  if (batch.length === 1) {
    await sendSingleRecipeCompile(batch[0]);
    return;
  }
  const requests = batch.map((pending) => ({
    requestId: `recipe-compile:${Date.now()}:${recipeCompileRequestSequence++}`,
    pending,
  }));
  try {
    const data = await apiCall<{
      items: Array<{
        request_id: string;
        ok: boolean;
        data?: FreezoneRecipeCompileWireData | null;
        error?: string;
        retryable?: boolean;
      }>;
    }>("freezone/recipes/compile-batch", {
      method: "POST",
      timeout: RECIPE_MODEL_TIMEOUT_MS,
      json: {
        items: requests.map(({ requestId, pending }) => ({
          request_id: requestId,
          ...recipeCompileJson(pending.payload),
        })),
      },
    });
    const resultsById = new Map(data.items.map((item) => [item.request_id, item]));
    for (const { requestId, pending } of requests) {
      const result = resultsById.get(requestId);
      if (result?.ok && result.data) {
        resolveRecipeCompile(pending, result.data);
      } else {
        const message = result?.error || "Recipe batch compilation returned no result";
        pending.reject(new Error(result?.retryable ? `HTTP 503: ${message}` : message));
      }
    }
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? Number((error as { status?: unknown }).status)
        : 0;
    if (status === 404 || status === 405) {
      await Promise.all(batch.map((pending) => sendSingleRecipeCompile(pending)));
      return;
    }
    for (const { pending } of requests) pending.reject(error);
  }
}

function flushRecipeCompileBatch(): void {
  if (recipeCompileBatchTimer !== null) {
    clearTimeout(recipeCompileBatchTimer);
    recipeCompileBatchTimer = null;
  }
  const batch = pendingRecipeCompiles.splice(0, RECIPE_COMPILE_BATCH_MAX_ITEMS);
  if (batch.length > 0) void sendRecipeCompileBatch(batch);
  if (pendingRecipeCompiles.length > 0) scheduleRecipeCompileBatch();
}

function scheduleRecipeCompileBatch(): void {
  if (pendingRecipeCompiles.length >= RECIPE_COMPILE_BATCH_MAX_ITEMS) {
    flushRecipeCompileBatch();
    return;
  }
  if (recipeCompileBatchTimer !== null) return;
  recipeCompileBatchTimer = setTimeout(
    flushRecipeCompileBatch,
    RECIPE_COMPILE_BATCH_WINDOW_MS,
  );
}

export function compileFreezoneRecipePrompt(
  payload: FreezoneRecipeCompilePayload,
): Promise<string> {
  return new Promise((resolve, reject) => {
    pendingRecipeCompiles.push({ payload, resolve, reject });
    scheduleRecipeCompileBatch();
  });
}

export async function generateFreezoneRecipeText(
  payload: Omit<FreezoneRecipeCompilePayload, "nodeKind">,
): Promise<string> {
  const data = await apiCall<{ content: string }>("freezone/recipes/generate-text", {
    method: "POST",
    // Recipe-backed text generation is a model call and can legitimately take
    // longer than the shared 30s API-client timeout.
    timeout: RECIPE_MODEL_TIMEOUT_MS,
    json: {
      ...(payload.projectId ? { project_id: payload.projectId } : {}),
      ...(payload.productOperationId
        ? { product_operation_id: payload.productOperationId }
        : {}),
      recipe_id: payload.recipeId,
      recipe_version: payload.recipeVersion ?? "",
      ...(payload.recipePipeline?.length
        ? { recipe_pipeline: payload.recipePipeline }
        : {}),
      skill_id: payload.skillId ?? "",
      skill_version: payload.skillVersion ?? "",
      confirmed_inputs: payload.confirmedInputs ?? {},
      node_kind: "text",
      node_prompt: payload.nodePrompt ?? "",
      user_goal: payload.userGoal ?? "",
      upstream_text: payload.upstreamText ?? "",
      reference_media: payload.referenceMedia ?? [],
    },
  });
  return data.content;
}

/**
 * Map the camelCase node context to the backend's snake_case body fields,
 * emitting keys only when present so legacy callers stay byte-identical.
 */
function nodeContextBody(ctx: FreezoneNodeContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (ctx.canvasId) out.canvas_id = ctx.canvasId;
  if (ctx.nodeId) out.node_id = ctx.nodeId;
  if (ctx.modelParams) out.model_params = ctx.modelParams;
  const operation = workflowProductOperation(ctx.nodeId);
  if (operation?.generationAttemptId) {
    out.product_operation_id = operation.operationId;
    out.generation_attempt_id = operation.generationAttemptId;
  }
  return out;
}

/** One recorded generation attempt for a node (see generation-history GET). */
export interface FreezoneGenerationHistoryRecord {
  schema_version: number;
  canvas_id: string;
  node_id: string;
  /** ISO timestamp the backend recorded the attempt. */
  recorded_at: string;
  /** Stable record id, e.g. "freezone_gen:<job_id>". */
  id: string;
  task_type: string;
  task_key: string;
  job_id: string;
  /** "completed" | "failed" | other backend status strings. */
  status: string;
  /** "image" | "video" | "audio" | "text" | "3d" ... */
  media_type: string;
  /** Raw task result payload; shape varies by task_type. */
  result: Record<string, unknown>;
  /** Registry model id (backfilled into data.model on restore). Absent on old records. */
  model?: string;
  /** Generation mode (video genMode / image generationMode). Absent on old records. */
  gen_mode?: string;
}

/**
 * Read a node's recorded generation history (most recent first per the
 * backend). Returns `[]` when the node has no history yet. The endpoint is
 * independent of canvas JSON, so this never touches the saved-canvas flow.
 */
export async function fetchNodeGenerationHistory(
  project: string,
  canvasId: string,
  nodeId: string,
  limit = 100,
): Promise<FreezoneGenerationHistoryRecord[]> {
  const data = await apiCall<{ records?: FreezoneGenerationHistoryRecord[] }>(
    `projects/${encodeURIComponent(project)}/freezone/canvases/${encodeURIComponent(
      canvasId,
    )}/nodes/${encodeURIComponent(nodeId)}/generation-history?limit=${limit}`,
  );
  return data?.records ?? [];
}

/**
 * Read the whole canvas's generation history in one request (most recent
 * first). Unlike {@link fetchNodeGenerationHistory} this is not scoped to a
 * single node, and the backend aggregates across every node that ever recorded
 * history on this canvas — including nodes since deleted from the canvas — so
 * their past attempts stay visible in the history browser.
 */
export async function fetchCanvasGenerationHistory(
  project: string,
  canvasId: string,
  limit = 500,
): Promise<FreezoneGenerationHistoryRecord[]> {
  const data = await apiCall<{ records?: FreezoneGenerationHistoryRecord[] }>(
    `projects/${encodeURIComponent(project)}/freezone/canvases/${encodeURIComponent(
      canvasId,
    )}/generation-history?limit=${limit}`,
  );
  return data?.records ?? [];
}

/** Remove one entry from the history browser; the underlying media is retained. */
export async function deleteNodeGenerationHistoryRecord(
  project: string,
  canvasId: string,
  nodeId: string,
  recordId: string,
): Promise<{ deleted: boolean }> {
  return await apiCall<{ deleted: boolean }>(
    `projects/${encodeURIComponent(project)}/freezone/canvases/${encodeURIComponent(
      canvasId,
    )}/nodes/${encodeURIComponent(nodeId)}/generation-history?record_id=${encodeURIComponent(recordId)}`,
    { method: "DELETE" },
  );
}

// /freezone/gen ----------------------------------------------------------- //

export type FreezoneProvider =
  | "newapi"
  | "openrouter"
  | "huimeng"
  | "openai";

export interface FreezoneGenCamera {
  /** id from /freezone/image/camera-options.camera_bodies */
  cameraBodyId?: string | null;
  /** id from /freezone/image/camera-options.lenses */
  lensId?: string | null;
  focalLengthMm?: number | null;
  aperture?: string | null;
}

export interface FreezoneGenStyle {
  /** id from /freezone/image/style-templates */
  templateId?: string | null;
}

export interface FreezoneGenPayload extends FreezoneNodeContext {
  prompt: string;
  aspectRatio?: string;
  imageSize?: string;
  referenceUrls?: string[];
  camera?: FreezoneGenCamera | null;
  style?: FreezoneGenStyle | null;
  /** Override `NANOBANANA_PROVIDER` env default for the reference-image path. */
  provider?: FreezoneProvider | null;
  /** Override the provider's default model (e.g. "gpt-image-2"). */
  model?: string | null;
  /** Registry model id (for restore; differs from the model string after the provider split). */
  modelId?: string | null;
  /** Generation mode (for restore): text_to_image / image_to_image / all_reference / image_reference. */
  genMode?: string | null;
  /** Only honored by openai gpt-image-2 (low / medium / high / auto). */
  quality?: string | null;
}

export interface FreezoneJobRef {
  task_type:
    | "freezone_image_vectorize"
    | "freezone_image_animate_gif"
    | "freezone_gen"
    | "freezone_edit"
    | "freezone_multi_view"
    | "freezone_relight"
    | "freezone_scene_360"
    | "freezone_template_edit"
    | "freezone_upscale"
    | "freezone_outpaint"
    | "freezone_redraw"
    | "freezone_video_gen"
    | "freezone_video_omni_gen"
    | "freezone_video_i2v"
    | "freezone_video_multishot"
    | "freezone_video_erase"
    | "freezone_video_compose"
    | "freezone_video_upscale"
    | "freezone_audio_separate"
    | "freezone_audio_speech"
    | "freezone_audio_eleven_music"
    | "freezone_image_reverse_prompt"
    | "freezone_text_generate"
    | "freezone_text_translate"
    | "freezone_story_script"
    | "freezone_analyze_video_story"
    | "stage_asset";
  job_id: string;
  task_key: string;
}

// /freezone/video/gen ----------------------------------------------------- //

export type FreezoneVideoAspectRatio = string;

export type FreezoneVideoResolution = string;

/** Local element marker on the source image, used to anchor subjects/objects. */
export interface FreezoneVideoMark {
  label: string;
  sourceUrl?: string;
  pointX?: number | null;
  pointY?: number | null;
  boxX?: number | null;
  boxY?: number | null;
  boxWidth?: number | null;
  boxHeight?: number | null;
  note?: string;
}

export interface FreezoneVideoGenPayload extends FreezoneNodeContext {
  prompt: string;
  /** e.g. locked_off / follow_tracking / orbit_up */
  cameraTemplateId?: string | null;
  characterIds?: string[];
  marks?: FreezoneVideoMark[];
  aspectRatio?: FreezoneVideoAspectRatio;
  resolution?: FreezoneVideoResolution;
  /** seconds; spec only requires ≥1, the UI typically caps higher. */
  durationSeconds?: number;
  generateAudio?: boolean;
  /** Backend model id, e.g. huimeng_seedance20_fast / seedance_pro. */
  model?: string;
  /** Fixed business mode of the text-to-video entry. */
  genMode: "textToVideo";
  /**
   * Real-person material review. Set `true` when the input contains real
   * human faces so the backend routes the job through the human-review path
   * (may take longer, approval not guaranteed). Omitted/false otherwise.
   * Text-to-video ignores this value and always submits false.
   */
  humanReview?: boolean;
  sceneOptimize?: "anime" | "realistic" | null;
}

export async function submitFreezoneVideoGen(
  project: string,
  payload: FreezoneVideoGenPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/gen`,
    {
      method: "POST",
      json: {
        prompt: payload.prompt,
        camera_template_id: payload.cameraTemplateId ?? null,
        character_ids: payload.characterIds ?? [],
        marks: (payload.marks ?? []).map((m) => ({
          label: m.label,
          source_url: m.sourceUrl ?? "",
          point_x: m.pointX ?? null,
          point_y: m.pointY ?? null,
          box_x: m.boxX ?? null,
          box_y: m.boxY ?? null,
          box_width: m.boxWidth ?? null,
          box_height: m.boxHeight ?? null,
          note: m.note ?? "",
        })),
        aspect_ratio: payload.aspectRatio ?? "16:9",
        resolution: payload.resolution ?? "720p",
        duration_seconds: Math.max(payload.durationSeconds ?? 5, 1),
        generate_audio: payload.generateAudio ?? false,
        ...(payload.model ? { model: payload.model, model_id: payload.model } : {}),
        gen_mode: payload.genMode,
        // Text-to-video must never inherit real-person review from old node data.
        human_review: false,
        scene_optimize: payload.sceneOptimize ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/video/upscale ------------------------------------------------- //

/** Target clarity tier. Scales by long edge: 1080p=1920, 2k=2560, 4k=3840. */
export type FreezoneVideoUpscaleResolution = "1080p" | "2k" | "4k";

export type FreezoneVideoTargetFps = "auto" | number;
export type FreezoneVideoSlowdown = "auto" | "2x" | "3x" | "4x" | "5x";
export type FreezoneVideoScene = "realistic" | "anime";

export interface FreezoneVideoProbe {
  width: number;
  height: number;
  fps: number;
  duration: number;
  upscale_resolutions: FreezoneVideoUpscaleResolution[];
  frame_rate_resolutions: FreezoneVideoUpscaleResolution[];
}

export interface FreezoneVideoUpscalePayload extends FreezoneNodeContext {
  /** Static URL of the source video to upscale. */
  sourceUrl: string;
  resolution?: FreezoneVideoUpscaleResolution;
  targetFps?: FreezoneVideoTargetFps;
  slowdown?: FreezoneVideoSlowdown;
  smartInterpolation?: boolean;
  scene?: FreezoneVideoScene;
  faceEnhance?: boolean;
}

export async function submitFreezoneVideoUpscale(
  project: string,
  payload: FreezoneVideoUpscalePayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/upscale`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        resolution: payload.resolution ?? "1080p",
        target_fps: payload.targetFps === "auto" ? null : payload.targetFps,
        slowdown: payload.slowdown ?? "auto",
        smart_interpolation: payload.smartInterpolation ?? true,
        scene: payload.scene ?? "realistic",
        face_enhance: payload.faceEnhance ?? false,
        ...nodeContextBody(payload),
      },
    },
  );
}

export async function quoteFreezoneVideoUpscale(
  project: string,
  payload: FreezoneVideoUpscalePayload,
): Promise<{ cost: number; display: string; promotion?: { name?: string; discount_basis_points?: number; ends_at?: string | null } }> {
  return await apiCall<{ cost: number; display: string; promotion?: { name?: string; discount_basis_points?: number; ends_at?: string | null } }>(
    `projects/${encodeURIComponent(project)}/freezone/video/upscale/quote`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        resolution: payload.resolution ?? "1080p",
        target_fps: payload.targetFps === "auto" ? null : payload.targetFps,
        slowdown: payload.slowdown ?? "auto",
        smart_interpolation: payload.smartInterpolation ?? true,
        scene: payload.scene ?? "realistic",
        face_enhance: payload.faceEnhance ?? false,
      },
    },
  );
}

export async function probeFreezoneVideoUpscale(
  project: string,
  sourceUrl: string,
): Promise<FreezoneVideoProbe> {
  return await apiCall<FreezoneVideoProbe>(
    `projects/${encodeURIComponent(project)}/freezone/video/upscale/probe?source_url=${encodeURIComponent(sourceUrl)}`,
  );
}

export interface FreezoneVideoKeyframesPayload extends FreezoneNodeContext {
  /** Static URL of the first frame. At least one of first/last must be set. */
  firstFrameUrl?: string | null;
  lastFrameUrl?: string | null;
  prompt?: string;
  cameraTemplateId?: string | null;
  marks?: FreezoneVideoMark[];
  aspectRatio?: FreezoneVideoAspectRatio;
  resolution?: FreezoneVideoResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
  model?: string;
  /** Keyframe business mode. Provide only the first frame, only the last frame, or both. */
  genMode: "firstFrame" | "firstLastFrame";
  /** See {@link FreezoneVideoGenPayload.humanReview}. */
  humanReview?: boolean;
  sceneOptimize?: "anime" | "realistic" | null;
}

export async function submitFreezoneVideoKeyframes(
  project: string,
  payload: FreezoneVideoKeyframesPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/keyframes`,
    {
      method: "POST",
      json: {
        first_frame_url: payload.firstFrameUrl ?? null,
        last_frame_url: payload.lastFrameUrl ?? null,
        prompt: payload.prompt ?? "",
        camera_template_id: payload.cameraTemplateId ?? null,
        marks: (payload.marks ?? []).map((m) => ({
          label: m.label,
          source_url: m.sourceUrl ?? "",
          point_x: m.pointX ?? null,
          point_y: m.pointY ?? null,
          box_x: m.boxX ?? null,
          box_y: m.boxY ?? null,
          box_width: m.boxWidth ?? null,
          box_height: m.boxHeight ?? null,
          note: m.note ?? "",
        })),
        aspect_ratio: payload.aspectRatio ?? "16:9",
        resolution: payload.resolution ?? "720p",
        duration_seconds: Math.max(payload.durationSeconds ?? 5, 1),
        generate_audio: payload.generateAudio ?? false,
        ...(payload.model ? { model: payload.model, model_id: payload.model } : {}),
        gen_mode: payload.genMode,
        human_review: payload.humanReview ?? false,
        scene_optimize: payload.sceneOptimize ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/video/i2v ----------------------------------------------------- //
//
// Unified endpoint for single-image image-to-video and multi-image image reference. Both
// use image_reference provider semantics and never occupy the first-frame slot.

export interface FreezoneVideoI2vPayload extends FreezoneNodeContext {
  /** Image reference URLs. imageToVideo requires one; imageReference uses the catalog cap. */
  imageUrls: string[];
  prompt?: string;
  cameraTemplateId?: string | null;
  marks?: FreezoneVideoMark[];
  aspectRatio?: FreezoneVideoAspectRatio;
  resolution?: FreezoneVideoResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
  /** default huimeng_seedance10_fast (matches keyframes); multi-image prefers seedance 2.0. */
  model?: string;
  /** Required product entry; both values execute as image_reference. */
  genMode: "imageToVideo" | "imageReference";
  /** See {@link FreezoneVideoGenPayload.humanReview}. */
  humanReview?: boolean;
  sceneOptimize?: "anime" | "realistic" | null;
}

export async function submitFreezoneVideoI2v(
  project: string,
  payload: FreezoneVideoI2vPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/i2v`,
    {
      method: "POST",
      json: {
        image_urls: payload.imageUrls,
        prompt: payload.prompt ?? "",
        camera_template_id: payload.cameraTemplateId ?? null,
        marks: (payload.marks ?? []).map((m) => ({
          label: m.label,
          source_url: m.sourceUrl ?? "",
          point_x: m.pointX ?? null,
          point_y: m.pointY ?? null,
          box_x: m.boxX ?? null,
          box_y: m.boxY ?? null,
          box_width: m.boxWidth ?? null,
          box_height: m.boxHeight ?? null,
          note: m.note ?? "",
        })),
        aspect_ratio: payload.aspectRatio ?? "16:9",
        resolution: payload.resolution ?? "720p",
        duration_seconds: Math.max(payload.durationSeconds ?? 5, 1),
        generate_audio: payload.generateAudio ?? false,
        ...(payload.model ? { model: payload.model, model_id: payload.model } : {}),
        gen_mode: payload.genMode,
        human_review: payload.humanReview ?? false,
        scene_optimize: payload.sceneOptimize ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/video/video-edit ---------------------------------------------- //
//
// Video editing: 1 source video, plus reference images / separate reference audio depending on media catalog capabilities.

export interface FreezoneVideoEditPayload extends FreezoneNodeContext {
  /** Static URL of the source video, required. */
  videoUrl: string;
  /** Static URLs of 0-5 reference images. */
  imageUrls?: string[];
  /** Static URLs of separate reference audio; count and duration limits come from the media model catalog. */
  audioUrls?: string[];
  prompt?: string;
  cameraTemplateId?: string | null;
  marks?: FreezoneVideoMark[];
  resolution?: FreezoneVideoResolution;
  /** Video-edit audio policy: auto = automatic / origin = keep the original audio. */
  audioSetting?: "auto" | "origin";
  generateAudio?: boolean;
  /** default newapi_happyhorse-1.0. */
  model?: string;
  /** Fixed business mode of the video-edit entry. */
  genMode: "videoEdit";
  humanReview?: boolean;
}

export async function submitFreezoneVideoEdit(
  project: string,
  payload: FreezoneVideoEditPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/video-edit`,
    {
      method: "POST",
      json: {
        video_url: payload.videoUrl,
        image_urls: payload.imageUrls ?? [],
        audio_urls: payload.audioUrls ?? [],
        prompt: payload.prompt ?? "",
        camera_template_id: payload.cameraTemplateId ?? null,
        marks: (payload.marks ?? []).map((m) => ({
          label: m.label,
          source_url: m.sourceUrl ?? "",
          point_x: m.pointX ?? null,
          point_y: m.pointY ?? null,
          box_x: m.boxX ?? null,
          box_y: m.boxY ?? null,
          box_width: m.boxWidth ?? null,
          box_height: m.boxHeight ?? null,
          note: m.note ?? "",
        })),
        resolution: payload.resolution ?? "720p",
        audio_setting: payload.audioSetting ?? "auto",
        generate_audio: payload.generateAudio ?? false,
        ...(payload.model ? { model: payload.model, model_id: payload.model } : {}),
        gen_mode: payload.genMode,
        human_review: payload.humanReview ?? false,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/video/video-extend -------------------------------------------- //

export interface FreezoneVideoExtendPayload extends FreezoneNodeContext {
  /** Static URL of the source video to extend, required. */
  videoUrl: string;
  /** What to generate after the source video ends. */
  prompt: string;
  cameraTemplateId?: string | null;
  resolution?: FreezoneVideoResolution;
  /** Duration of the newly generated extension clip. */
  durationSeconds?: number;
  generateAudio?: boolean;
  model?: string;
  genMode: "videoExtend";
  humanReview?: boolean;
}

export async function submitFreezoneVideoExtend(
  project: string,
  payload: FreezoneVideoExtendPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/video-extend`,
    {
      method: "POST",
      json: {
        video_url: payload.videoUrl,
        prompt: payload.prompt,
        camera_template_id: payload.cameraTemplateId ?? null,
        resolution: payload.resolution ?? "720p",
        duration_seconds: Math.max(payload.durationSeconds ?? 5, 1),
        generate_audio: payload.generateAudio ?? false,
        ...(payload.model ? { model: payload.model, model_id: payload.model } : {}),
        gen_mode: payload.genMode,
        human_review: payload.humanReview ?? false,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/video/multishot ------------------------------------------------ //
// MiniMax H3 Multishot (long continuous video, 2026-10-25): a dedicated
// pair of endpoints (review → enqueue), not routed through
// `_start_or_enqueue_freezone_video_gen`/`create_video_generator` like
// every other video mode above — the backend needs a whole chain's worth
// of shots in one call, not one prompt/one call. See freezone/multishot.py.

export interface FreezoneMultishotShotInput {
  id: string;
  /** User's own freeform visual description — becomes `visual_description` server-side. */
  description: string;
}

export interface FreezoneMultishotReferenceImageInput {
  url: string;
  name?: string;
  kind?: "character" | "scene" | "prop";
}

export interface FreezoneMultishotShotReviewResult {
  id: string;
  description: string;
  /** AI-rewritten (or no-LLM-fallback) H3 prompt for this shot. */
  prompt: string;
  lint: Array<{ severity: "error" | "warning"; code: string; message: string }>;
  fallback_used: boolean;
}

export interface FreezoneMultishotReferenceReview {
  tag: string;
  name: string;
  kind: string;
  url: string;
  source: "canvas" | "library";
}

export interface FreezoneVideoMultishotReviewResult {
  backend: string;
  checkpoint: "fl2va" | "ref2va";
  sampling: Record<string, unknown>;
  width: number;
  height: number;
  frames_per_shot: number;
  shot_seconds: number;
  total_duration_seconds: number;
  max_shots: number;
  start_image_url: string;
  references: FreezoneMultishotReferenceReview[];
  shots: FreezoneMultishotShotReviewResult[];
  worker_status: Record<string, unknown> | null;
  issues: string[];
  can_enqueue: boolean;
  input_fingerprint: string;
}

/** Common fields shared by the review request and the enqueue request. */
export interface FreezoneVideoMultishotPayload extends FreezoneNodeContext {
  /** Must be the Freezone MiniMax H3 Multishot backend id, from /freezone/video/models. */
  model: string;
  /** Static URL of the chain's single start frame (shot 1 only). */
  startImageUrl: string;
  /** Canvas-connected shared reference images (0-3, capped server-side). */
  referenceImages?: FreezoneMultishotReferenceImageInput[];
  /** Video character library entry ids, used as additional shared reference images. */
  characterIds?: string[];
  /** Ordered shot list, 2-8 entries (see FreezoneMultishotShotInput). */
  shots: FreezoneMultishotShotInput[];
  /** Optional overall direction applied to every shot (style/mood notes). */
  directorGuidance?: string;
  cameraTemplateId?: string | null;
  aspectRatio: "16:9" | "9:16";
  /** Seconds per shot before snapping to H3's frame grid; applies to every shot. */
  shotDurationSeconds?: number;
}

function multishotRequestBody(payload: FreezoneVideoMultishotPayload): Record<string, unknown> {
  return {
    model: payload.model,
    gen_mode: "multishot",
    start_image_url: payload.startImageUrl,
    reference_images: (payload.referenceImages ?? []).map((ref) => ({
      url: ref.url,
      name: ref.name ?? "",
      kind: ref.kind ?? "character",
    })),
    character_ids: payload.characterIds ?? [],
    shots: payload.shots.map((shot) => ({ id: shot.id, description: shot.description })),
    director_guidance: payload.directorGuidance ?? "",
    camera_template_id: payload.cameraTemplateId ?? null,
    aspect_ratio: payload.aspectRatio,
    shot_duration_seconds: payload.shotDurationSeconds ?? 6,
    ...nodeContextBody(payload),
  };
}

/**
 * Dry-run review: resolves the start frame + shared references, computes
 * the chain's sampling plan, and writes a fresh AI-rewritten H3 prompt for
 * every shot — no enqueue, no RunPod call (but not free: one LLM call per
 * shot). Call this first; pass its `input_fingerprint` back as
 * `reviewFingerprint` to {@link submitFreezoneVideoMultishot}, along with
 * each shot's (possibly hand-edited) prompt as `shotPrompts`.
 */
export async function reviewFreezoneVideoMultishot(
  project: string,
  payload: FreezoneVideoMultishotPayload,
): Promise<FreezoneVideoMultishotReviewResult> {
  return await apiCall<FreezoneVideoMultishotReviewResult>(
    `projects/${encodeURIComponent(project)}/freezone/video/multishot/review`,
    { method: "POST", json: multishotRequestBody(payload) },
  );
}

export interface FreezoneMultishotShotPromptInput {
  id: string;
  finalPrompt: string;
}

export interface FreezoneVideoMultishotSubmitPayload extends FreezoneVideoMultishotPayload {
  /** From the matching review call's `input_fingerprint` — a mismatch returns HTTP 409 `INPUT_STALE`. */
  reviewFingerprint: string;
  /** One entry per shot, by id — normally the review's own `prompt` verbatim; may be hand-edited (re-linted server-side). */
  shotPrompts: FreezoneMultishotShotPromptInput[];
}

export async function submitFreezoneVideoMultishot(
  project: string,
  payload: FreezoneVideoMultishotSubmitPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/multishot`,
    {
      method: "POST",
      json: {
        ...multishotRequestBody(payload),
        review_fingerprint: payload.reviewFingerprint,
        shot_prompts: payload.shotPrompts.map((p) => ({ id: p.id, final_prompt: p.finalPrompt })),
      },
    },
  );
}

// /freezone/video/omni-gen ------------------------------------------------ //

export type FreezoneVideoReferenceType = "image" | "video" | "audio" | "file" | "link";

export interface FreezoneVideoReferenceItem {
  type: FreezoneVideoReferenceType;
  url: string;
  role?: string;
  label?: string;
}

export interface FreezoneVideoOmniGenPayload extends FreezoneNodeContext {
  prompt: string;
  theme?: string;
  cameraTemplateId?: string | null;
  /** Mixed media references; file/link support and limits come from the model catalog. */
  references?: FreezoneVideoReferenceItem[];
  marks?: FreezoneVideoMark[];
  aspectRatio?: FreezoneVideoAspectRatio;
  resolution?: FreezoneVideoResolution;
  durationSeconds?: number;
  generateAudio?: boolean;
  /** default huimeng_seedance20_fast per backend default. */
  model?: string;
  /** Fixed business mode of the omni-reference entry. */
  genMode: "allReference";
  /**
   * Canvas "smart extend": still goes through the all-reference entry, but the backend submits it to the model as a video extension task
   * (task type and prompt requirements are the same as video extension).
   */
  continuation?: boolean;
  /** See {@link FreezoneVideoGenPayload.humanReview}. */
  humanReview?: boolean;
  sceneOptimize?: "anime" | "realistic" | null;
}

export async function submitFreezoneVideoOmniGen(
  project: string,
  payload: FreezoneVideoOmniGenPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/omni-gen`,
    {
      method: "POST",
      json: {
        prompt: payload.prompt,
        theme: payload.theme ?? "",
        camera_template_id: payload.cameraTemplateId ?? null,
        references: (payload.references ?? []).map((r) => ({
          type: r.type,
          url: r.url,
          role: r.role ?? "",
          label: r.label ?? "",
        })),
        marks: (payload.marks ?? []).map((m) => ({
          label: m.label,
          source_url: m.sourceUrl ?? "",
          point_x: m.pointX ?? null,
          point_y: m.pointY ?? null,
          box_x: m.boxX ?? null,
          box_y: m.boxY ?? null,
          box_width: m.boxWidth ?? null,
          box_height: m.boxHeight ?? null,
          note: m.note ?? "",
        })),
        aspect_ratio: payload.aspectRatio ?? "16:9",
        resolution: payload.resolution ?? "720p",
        duration_seconds: Math.max(payload.durationSeconds ?? 5, 1),
        generate_audio: payload.generateAudio ?? false,
        ...(payload.model ? { model: payload.model, model_id: payload.model } : {}),
        gen_mode: payload.genMode,
        ...(payload.continuation ? { continuation: true } : {}),
        human_review: payload.humanReview ?? false,
        scene_optimize: payload.sceneOptimize ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

export async function submitFreezoneGen(
  project: string,
  payload: FreezoneGenPayload,
): Promise<FreezoneJobRef> {
  const camera = payload.camera
    ? {
        camera_body: payload.camera.cameraBodyId ?? "",
        lens: payload.camera.lensId ?? "",
        focal_length_mm: payload.camera.focalLengthMm ?? 0,
        aperture: payload.camera.aperture ?? "",
      }
    : null;
  const style = payload.style?.templateId
    ? { template_id: payload.style.templateId }
    : null;
  // The backend can only open reference images by static path: any `data:` base64 is first uploaded and replaced with an upload URL,
  // other http(s)/static URLs are kept as-is (only the `?v=` cache string is stripped). This is the single safety net here,
  // so individual callers cannot forget to sanitize and put base64 into reference_urls.
  const referenceUrls = await ensureBackendImageUrls(
    project,
    payload.referenceUrls,
  );
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/gen`,
    {
      method: "POST",
      json: {
        prompt: payload.prompt,
        aspect_ratio: payload.aspectRatio ?? "1:1",
        image_size: payload.imageSize ?? "2K",
        reference_urls: referenceUrls,
        camera,
        style,
        provider: payload.provider ?? null,
        model: payload.model ?? null,
        ...(payload.modelId ? { model_id: payload.modelId } : {}),
        ...(payload.genMode ? { gen_mode: payload.genMode } : {}),
        quality: payload.quality ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/video/erase --------------------------------------------------- //

/**
 * Per `FreezoneVideoEraseRequest` in openapi.json:
 * - `smart_subtitle`: backend auto-estimates the bottom subtitle band.
 * - `box`: front-end supplies a normalized box (0..1 against source frame).
 */
export type FreezoneVideoEraseMode = "smart_subtitle" | "box";

export interface FreezoneVideoEraseBox {
  /** Top-left x, normalized 0..1 against the source video frame. */
  x: number;
  /** Top-left y, normalized 0..1 against the source video frame. */
  y: number;
  /** Width, normalized (0, 1]. */
  width: number;
  /** Height, normalized (0, 1]. */
  height: number;
}

export interface FreezoneVideoErasePayload {
  sourceUrl: string;
  mode: FreezoneVideoEraseMode;
  /** Required when `mode === "box"`; ignored otherwise. */
  box?: FreezoneVideoEraseBox | null;
}

export async function submitFreezoneVideoErase(
  project: string,
  payload: FreezoneVideoErasePayload,
): Promise<FreezoneJobRef> {
  const body: Record<string, unknown> = {
    source_url: payload.sourceUrl,
    mode: payload.mode,
  };
  if (payload.mode === "box" && payload.box) {
    body.box_x = payload.box.x;
    body.box_y = payload.box.y;
    body.box_width = payload.box.width;
    body.box_height = payload.box.height;
  }
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/erase`,
    { method: "POST", json: body },
  );
}

// /freezone/video/compose ------------------------------------------------- //

export type FreezoneVideoComposeResolution = "720p" | "1080p";
export type FreezoneVideoComposeTrackKind = "video" | "audio";

export interface FreezoneVideoComposeItemPayload {
  itemId: string;
  sourceUrl: string;
  /** Position on the output timeline, in seconds. */
  timelineStart?: number;
  /** Trim start within source media, in seconds. */
  sourceStart?: number;
  /** Trim end within source media, in seconds. Must be > sourceStart. */
  sourceEnd: number;
  volume?: number;
  muted?: boolean;
  /**
   * Playback rate (speed ramp). 1 = original speed. ⚠️ Only honored if the BE compose
   * endpoint implements it; otherwise the field is ignored (export stays 1×).
   */
  speed?: number;
}

export interface FreezoneVideoComposeTrackPayload {
  trackId: string;
  kind: FreezoneVideoComposeTrackKind;
  items: FreezoneVideoComposeItemPayload[];
}

export interface FreezoneVideoComposePayload {
  title?: string;
  canvasId?: string;
  nodeId?: string;
  resolution?: FreezoneVideoComposeResolution;
  fps?: number;
  backgroundColor?: string;
  keepOriginalAudio?: boolean;
  /**
   * Cover image URL (a stable address already uploaded to the backend). When the backend supports it, it is attached to the MP4 as a cover stream
   * (attached_pic, which does not change the main duration); otherwise it is ignored and the frontend thumbnail still uses the same url.
   */
  coverUrl?: string | null;
  tracks: FreezoneVideoComposeTrackPayload[];
}

export async function submitFreezoneVideoCompose(
  project: string,
  payload: FreezoneVideoComposePayload,
): Promise<FreezoneJobRef> {
  const body: Record<string, unknown> = {
    title: payload.title ?? "",
    canvas_id: payload.canvasId ?? "",
    node_id: payload.nodeId ?? "",
    resolution: payload.resolution ?? "1080p",
    fps: payload.fps ?? 30,
    background_color: payload.backgroundColor ?? "#000000",
    keep_original_audio: payload.keepOriginalAudio ?? true,
    cover_url: payload.coverUrl ?? "",
    tracks: payload.tracks.map((track) => ({
      track_id: track.trackId,
      kind: track.kind,
      items: track.items.map((item) => ({
        item_id: item.itemId,
        source_url: item.sourceUrl,
        timeline_start: item.timelineStart ?? 0,
        source_start: item.sourceStart ?? 0,
        source_end: item.sourceEnd,
        volume: item.volume ?? 1,
        muted: item.muted ?? false,
        speed: item.speed ?? 1,
      })),
    })),
  };
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/compose`,
    { method: "POST", json: body },
  );
}

// /freezone/video/audio-separate ----------------------------------------- //

/**
 * Per `FreezoneAudioSeparateRequest` in openapi.json the only required field is
 * `source_url`. Backend returns two artifacts via the task SSE: the extracted
 * audio track and a silent (muted) version of the original video.
 */
export interface FreezoneAudioSeparatePayload {
  sourceUrl: string;
  /** Target beat; when given, the separated audio carries the beat_audio slot_target and can be committed directly. */
  targetEpisode?: number;
  targetBeat?: number;
}

export async function submitFreezoneAudioSeparate(
  project: string,
  payload: FreezoneAudioSeparatePayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video/audio-separate`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        target_episode: payload.targetEpisode,
        target_beat: payload.targetBeat,
      },
    },
  );
}

/**
 * Result shape for `freezone_audio_separate` isn't typed in openapi.json — the
 * endpoint declares `{}` (free-form). The light-version backend ships two
 * artifacts (audio track + silent video); callers walk the tree to find the
 * two URLs by extension.
 */
export async function fetchFreezoneAudioSeparateResult(
  project: string,
  jobId: string,
): Promise<Record<string, unknown>> {
  return await apiCall<Record<string, unknown>>(
    `projects/${encodeURIComponent(project)}/freezone/jobs/freezone_audio_separate/${encodeURIComponent(jobId)}/result`,
  );
}

// /freezone/image/reverse-prompt ----------------------------------------- //

/**
 * `source_url` is required; `instruction` steers the returned prompt.
 */
export interface FreezoneReversePromptPayload extends FreezoneNodeContext {
  sourceUrl: string;
  instruction?: string;
}

export async function submitFreezoneReversePrompt(
  project: string,
  payload: FreezoneReversePromptPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/image/reverse-prompt`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        instruction: payload.instruction ?? "",
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/image/style-templates ---------------------------------------- //

export interface FreezoneStyleTemplate {
  id: string;
  label: string;
  category: string;
  cover: string;
  samples: string[];
  style_prompt: string;
  author?: string;
}

export interface FreezoneStyleTemplateList {
  assetBase: string;
  version: string;
  templates: FreezoneStyleTemplate[];
}

function coerceLegacyStyleTemplateList(payload: unknown): FreezoneStyleTemplate[] {
  let candidate: unknown = payload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const wrapper = candidate as Record<string, unknown>;
    if (Array.isArray(wrapper.templates)) candidate = wrapper.templates;
    else if (Array.isArray(wrapper.data)) candidate = wrapper.data;
    else if (Array.isArray(wrapper.items)) candidate = wrapper.items;
    else if (Array.isArray(wrapper.style_templates)) candidate = wrapper.style_templates;
  }
  if (!Array.isArray(candidate)) return [];
  return candidate.filter(
    (item): item is FreezoneStyleTemplate =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as { id?: unknown }).id === "string" &&
      Boolean((item as { id: string }).id.trim()),
  );
}

function coerceStyleTemplateList(payload: unknown): FreezoneStyleTemplate[] {
  // Older backends return a bare list; newer ones wrap it next to `asset_base`.
  // Accept both, and never hand a non-array to callers that call `.find()`.
  let candidate: unknown = payload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const wrapper = candidate as Record<string, unknown>;
    if (Array.isArray(wrapper.templates)) candidate = wrapper.templates;
    else if (Array.isArray(wrapper.data)) candidate = wrapper.data;
    else if (Array.isArray(wrapper.items)) candidate = wrapper.items;
    else if (Array.isArray(wrapper.style_templates)) candidate = wrapper.style_templates;
  }
  if (!Array.isArray(candidate)) return [];
  const result: FreezoneStyleTemplate[] = [];
  for (const item of candidate) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const id = pickString(entry, "id", "template_id", "templateId", "key");
    if (!id) continue;
    result.push({
      id,
      label: pickString(entry, "label", "display_name", "displayName", "title", "name") ?? id,
      category: pickString(entry, "category", "group", "kind") ?? "",
      cover: pickString(entry, "cover", "cover_url", "coverUrl", "thumbnail") ?? "",
      samples: pickStringArray(entry, "samples", "sample_urls", "sampleUrls"),
      style_prompt:
        pickString(entry, "style_prompt", "stylePrompt", "prompt", "prompt_fragment") ?? "",
    });
  }
  return result;
}

export async function listFreezoneStyleTemplates(
  project: string,
): Promise<FreezoneStyleTemplateList> {
  let envelope: Awaited<ReturnType<typeof apiCallEnvelope<unknown>>>;
  try {
    envelope = await apiCallEnvelope<unknown>(
      `projects/${encodeURIComponent(project)}/freezone/image/style-templates`,
    );
  } catch (error) {
    // Compatibility for embedders/tests that still expose only the legacy
    // apiCall surface. Real transport errors must retain their original result.
    if (!String(error).includes('No "apiCallEnvelope" export')) throw error;
    const payload = await apiCall<unknown>(
      `projects/${encodeURIComponent(project)}/freezone/image/style-templates`,
    );
    return coerceLegacyStyleTemplateList(payload) as unknown as FreezoneStyleTemplateList;
  }
  const nested =
    envelope.data && typeof envelope.data === "object" && !Array.isArray(envelope.data)
      ? (envelope.data as Record<string, unknown>)
      : {};
  const meta = (key: string) =>
    pickString(envelope, key) ?? pickString(nested, key) ?? "";
  return {
    assetBase: meta("asset_base"),
    version: meta("version"),
    templates: coerceStyleTemplateList(envelope.data),
  };
}

// /freezone/image/camera-options ----------------------------------------- //

export interface FreezoneCameraIdLabel {
  id: string;
  label: string;
}

export interface FreezoneCameraOptions {
  camera_bodies: FreezoneCameraIdLabel[];
  lenses: FreezoneCameraIdLabel[];
  focal_lengths_mm: number[];
  apertures: string[];
}

export async function fetchFreezoneCameraOptions(
  project: string,
): Promise<FreezoneCameraOptions> {
  return await apiCall<FreezoneCameraOptions>(
    `projects/${encodeURIComponent(project)}/freezone/image/camera-options`,
  );
}

// /freezone/image/models -------------------------------------------------- //

export type MediaModelParameterControl = "select" | "number" | "switch" | "text" | "multiselect";
export interface MediaModelParameterDefinition {
  key: string;
  label: string;
  control: MediaModelParameterControl;
  requestPath: string;
  options?: Array<string | number | boolean>;
  default?: unknown;
  min?: number;
  max?: number;
  step?: number;
  required?: boolean;
  modes?: string[];
}
export interface MediaModelRequestSchema {
  endpoint: "images/generations" | "video/generations" | "audio/speech";
  parameters?: MediaModelParameterDefinition[];
  omitPaths?: string[];
}

export interface FreezoneImageModelInfo extends ReferenceMediaLimits {
  /** Opaque database identity used by new billing and task records. */
  catalogId?: string;
  /** Stable picker id, e.g. `"newapi_gpt_image2"`. */
  id: string;
  /** Provider tab id (`huimeng` / `openrouter` / `openai`). */
  providerId: FreezoneProvider;
  /** Value sent to backend `model` field. */
  apiModel: string;
  /** Display label in the model chip. */
  label: string;
  resolutionOptions?: string[];
  qualityOptions?: string[];
  ratioOptions?: string[];
  referenceImageMax?: number | null;
  request?: MediaModelRequestSchema;
}

// Provider inference for raw model strings the backend may return without
// metadata (e.g. just a flat string list). Order matters — first match wins.
const MODEL_PROVIDER_HINTS: Array<{
  match: (raw: string) => boolean;
  providerId: FreezoneProvider;
}> = [
  { match: (s) => s.toLowerCase().startsWith("huimeng"), providerId: "huimeng" },
  { match: (s) => s.toLowerCase().includes("/gemini"), providerId: "openrouter" },
  { match: (s) => s.toLowerCase().startsWith("google/"), providerId: "openrouter" },
  { match: (s) => s.toLowerCase().startsWith("anthropic/"), providerId: "openrouter" },
  { match: (s) => s.toLowerCase().startsWith("openrouter/"), providerId: "openrouter" },
  { match: (s) => s.toLowerCase().startsWith("gpt-image"), providerId: "openai" },
  { match: (s) => s.toLowerCase().startsWith("dall-e"), providerId: "openai" },
];

function inferProvider(raw: string): FreezoneProvider {
  for (const hint of MODEL_PROVIDER_HINTS) {
    if (hint.match(raw)) return hint.providerId;
  }
  return "huimeng";
}

function pickString(record: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

function pickNumber(record: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function pickBoolean(record: Record<string, unknown>, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") return value;
  }
  return undefined;
}

function pickStringArray(record: Record<string, unknown>, ...keys: string[]): string[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === "string" && item.length > 0);
    }
  }
  return [];
}

function pickMediaRequestSchema(value: unknown): MediaModelRequestSchema | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const schema = value as Record<string, unknown>;
  if (typeof schema.endpoint !== "string") return undefined;
  return schema as unknown as MediaModelRequestSchema;
}

function normalizeProviderId(raw: string | null): FreezoneProvider | null {
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (
    lowered === "newapi" ||
    lowered === "huimeng" ||
    lowered === "openrouter" ||
    lowered === "openai"
  ) {
    return lowered;
  }
  return null;
}

function modelEntryFromObject(entry: Record<string, unknown>): FreezoneImageModelInfo | null {
  const apiModel = pickString(entry, "model", "apiModel", "api_model", "name");
  if (!apiModel) return null;
  const providerId =
    normalizeProviderId(pickString(entry, "providerId", "provider_id", "provider")) ??
    inferProvider(apiModel);
  const id = pickString(entry, "id") ?? `${providerId}/${apiModel}`;
  const label = pickString(entry, "label", "displayName", "display_name") ?? apiModel;
  const catalogId = pickString(entry, "catalogId", "catalog_id");
  return {
    ...(catalogId ? { catalogId } : {}),
    id,
    providerId,
    apiModel,
    label,
    resolutionOptions: pickStringArray(entry, "resolutionOptions", "resolution_options"),
    qualityOptions: pickStringArray(entry, "qualityOptions", "quality_options"),
    ratioOptions: pickStringArray(entry, "ratioOptions", "ratio_options"),
    ...readReferenceMediaLimits(entry),
    referenceImageMax: pickNumber(entry, "referenceImageMax", "reference_image_max"),
    request: pickMediaRequestSchema(entry.request),
  };
}

function modelEntryFromString(raw: string): FreezoneImageModelInfo {
  const providerId = inferProvider(raw);
  return {
    id: `${providerId}/${raw}`,
    providerId,
    apiModel: raw,
    label: raw,
  };
}

function coerceModelList(payload: unknown): FreezoneImageModelInfo[] {
  // Accept several shapes the backend might return — schema is empty in
  // openapi.json so we normalize defensively rather than guess one shape.
  let candidate: unknown = payload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const wrapper = candidate as Record<string, unknown>;
    if (Array.isArray(wrapper.models)) candidate = wrapper.models;
    else if (Array.isArray(wrapper.data)) candidate = wrapper.data;
    else if (Array.isArray(wrapper.items)) candidate = wrapper.items;
    else {
      // provider→models[] map: { huimeng: [...], openrouter: [...] }
      const flattened: FreezoneImageModelInfo[] = [];
      for (const [providerRaw, value] of Object.entries(wrapper)) {
        const providerId = normalizeProviderId(providerRaw);
        if (!providerId || !Array.isArray(value)) continue;
        for (const item of value) {
          if (typeof item === "string") {
            flattened.push({
              id: `${providerId}/${item}`,
              providerId,
              apiModel: item,
              label: item,
            });
          } else if (item && typeof item === "object") {
            const entry = modelEntryFromObject(item as Record<string, unknown>);
            if (entry) flattened.push({ ...entry, providerId });
          }
        }
      }
      if (flattened.length > 0) return flattened;
    }
  }

  if (!Array.isArray(candidate)) return [];
  const result: FreezoneImageModelInfo[] = [];
  for (const item of candidate) {
    if (typeof item === "string") {
      result.push(modelEntryFromString(item));
    } else if (item && typeof item === "object") {
      const entry = modelEntryFromObject(item as Record<string, unknown>);
      if (entry) result.push(entry);
    }
  }
  return result;
}

export async function fetchFreezoneImageModels(
  project: string,
): Promise<FreezoneImageModelInfo[]> {
  const payload = await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/image/models`,
  );
  return coerceModelList(payload);
}

// /freezone/video/models -------------------------------------------------- //

/** Provider tab id for video generation models. */
export type FreezoneVideoProvider = "newapi" | "seedance" | "huimeng";

export interface FreezoneVideoModelInfo extends ReferenceMediaLimits {
  /** Opaque database identity used by new billing and task records. */
  catalogId?: string;
  /** Stable picker id, e.g. `"seedance_2"` (backend currently keys by api id). */
  id: string;
  /** Provider tab id (`seedance` / `huimeng`). */
  providerId: FreezoneVideoProvider;
  /** Value sent to backend `/freezone/video/gen` `model` field. */
  apiModel: string;
  /** Display label in the model chip. */
  label: string;
  /** Supported output resolution values for this model, when advertised by backend. */
  resolutionOptions?: FreezoneVideoResolution[];
  humanReview?: boolean;
  /** Whether this model can produce native synchronized audio. Missing means legacy-supported. */
  supportsGenerateAudio?: boolean;
  /** Smallest supported duration in seconds, when advertised by backend. */
  minDuration?: number | null;
  /** Largest supported duration in seconds, when advertised by backend. */
  maxDuration?: number | null;
  /** Supported Seedance 2.0 Value style hints, when advertised by backend. */
  sceneOptimizeOptions?: Array<"anime" | "realistic">;
  /** Default Seedance 2.0 Value style hint, when advertised by backend. */
  defaultSceneOptimize?: "anime" | "realistic" | null;
  ratioOptions?: string[];
  supportedModes?: string[];
  referenceImageMax?: number | null;
  referenceVideoMax?: number | null;
  referenceAudioMax?: number | null;
  referenceFileMax?: number | null;
  referenceLinkMax?: number | null;
  referenceFileTypes?: string[];
  /** Multishot only — shot-list add/remove bound (RUNPOD_H3_MULTISHOT_MAX_SHOTS server-side, read at request time). */
  maxShots?: number | null;
  referenceAudioMinSeconds?: number | null;
  referenceAudioMaxSeconds?: number | null;
  referenceAudioTotalMinSeconds?: number | null;
  /**
   * Upper limit of the **total duration** of reference audio (seconds). Besides the per-clip 1.8~15.2s, the vendor r2v has a separate total limit
   * (see the note in videoModelCapabilities); this is its admin-configurable value. When unset the frontend falls back to
   * 15.2s. Fractions are allowed, so do not treat it as an integer field.
   */
  referenceAudioTotalMaxSeconds?: number | null;
  referenceVideoMinSeconds?: number | null;
  referenceVideoMaxSeconds?: number | null;
  referenceVideoTotalMinSeconds?: number | null;
  referenceVideoTotalMaxSeconds?: number | null;
  request?: MediaModelRequestSchema;
}

// Provider inference for raw model ids the backend may return without
// metadata. Order matters — first match wins. Anything we don't recognize
// falls back to `seedance` (the primary provider).
const VIDEO_MODEL_PROVIDER_HINTS: Array<{
  match: (raw: string) => boolean;
  providerId: FreezoneVideoProvider;
}> = [
  { match: (s) => s.toLowerCase().startsWith("huimeng"), providerId: "huimeng" },
  { match: (s) => s.toLowerCase().startsWith("seedance"), providerId: "seedance" },
];

function inferVideoProvider(raw: string): FreezoneVideoProvider {
  for (const hint of VIDEO_MODEL_PROVIDER_HINTS) {
    if (hint.match(raw)) return hint.providerId;
  }
  return "seedance";
}

function normalizeVideoProviderId(raw: string | null): FreezoneVideoProvider | null {
  if (!raw) return null;
  const lowered = raw.toLowerCase();
  if (lowered === "newapi" || lowered === "seedance" || lowered === "huimeng") return lowered;
  return null;
}

function videoModelEntryFromObject(
  entry: Record<string, unknown>,
): FreezoneVideoModelInfo | null {
  const apiModel = pickString(entry, "model", "apiModel", "api_model", "name");
  if (!apiModel) return null;
  const providerId =
    normalizeVideoProviderId(pickString(entry, "providerId", "provider_id", "provider")) ??
    inferVideoProvider(apiModel);
  const id = pickString(entry, "id") ?? apiModel;
  const label = pickString(entry, "label", "displayName", "display_name") ?? apiModel;
  const catalogId = pickString(entry, "catalogId", "catalog_id");
  const resolutionOptions = pickStringArray(entry, "resolutionOptions", "resolution_options");
  const sceneOptimizeOptions = pickStringArray(entry, "sceneOptimizeOptions", "scene_optimize_options")
    .map((value) => value.toLowerCase())
    .filter((value): value is "anime" | "realistic" =>
      value === "anime" || value === "realistic"
    );
  const defaultSceneOptimizeRaw = pickString(entry, "defaultSceneOptimize", "default_scene_optimize")
    ?.toLowerCase();
  const defaultSceneOptimize =
    defaultSceneOptimizeRaw === "anime" || defaultSceneOptimizeRaw === "realistic"
      ? defaultSceneOptimizeRaw
      : null;
  return {
    ...(catalogId ? { catalogId } : {}),
    id,
    providerId,
    apiModel,
    label,
    ...(resolutionOptions.length > 0 ? { resolutionOptions } : {}),
    humanReview: pickBoolean(entry, "humanReview", "human_review"),
    supportsGenerateAudio: pickBoolean(
      entry,
      "supportsGenerateAudio",
      "supports_generate_audio",
    ),
    minDuration: pickNumber(entry, "minDuration", "min_duration"),
    maxDuration: pickNumber(entry, "maxDuration", "max_duration"),
    ...(sceneOptimizeOptions.length > 0 ? { sceneOptimizeOptions } : {}),
    defaultSceneOptimize,
    ratioOptions: pickStringArray(entry, "ratioOptions", "ratio_options"),
    supportedModes: pickStringArray(entry, "supportedModes", "supported_modes"),
    referenceImageMax: pickNumber(entry, "referenceImageMax", "reference_image_max"),
    ...readReferenceMediaLimits(entry),
    referenceVideoMax: pickNumber(entry, "referenceVideoMax", "reference_video_max"),
    referenceAudioMax: pickNumber(entry, "referenceAudioMax", "reference_audio_max"),
    referenceFileMax: pickNumber(entry, "referenceFileMax", "reference_file_max"),
    referenceLinkMax: pickNumber(entry, "referenceLinkMax", "reference_link_max"),
    referenceFileTypes: pickStringArray(entry, "referenceFileTypes", "reference_file_types"),
    maxShots: pickNumber(entry, "maxShots", "max_shots"),
    referenceAudioMinSeconds: pickNumber(
      entry,
      "referenceAudioMinSeconds",
      "reference_audio_min_seconds",
    ),
    referenceAudioMaxSeconds: pickNumber(
      entry,
      "referenceAudioMaxSeconds",
      "reference_audio_max_seconds",
    ),
    referenceAudioTotalMinSeconds: pickNumber(
      entry,
      "referenceAudioTotalMinSeconds",
      "reference_audio_total_min_seconds",
    ),
    referenceAudioTotalMaxSeconds: pickNumber(
      entry,
      "referenceAudioTotalMaxSeconds",
      "reference_audio_total_max_seconds",
    ),
    referenceVideoMinSeconds: pickNumber(
      entry,
      "referenceVideoMinSeconds",
      "reference_video_min_seconds",
    ),
    referenceVideoMaxSeconds: pickNumber(
      entry,
      "referenceVideoMaxSeconds",
      "reference_video_max_seconds",
    ),
    referenceVideoTotalMinSeconds: pickNumber(
      entry,
      "referenceVideoTotalMinSeconds",
      "reference_video_total_min_seconds",
    ),
    referenceVideoTotalMaxSeconds: pickNumber(
      entry,
      "referenceVideoTotalMaxSeconds",
      "reference_video_total_max_seconds",
    ),
    request: pickMediaRequestSchema(entry.request),
  };
}

function videoModelEntryFromString(raw: string): FreezoneVideoModelInfo {
  const providerId = inferVideoProvider(raw);
  return {
    id: raw,
    providerId,
    apiModel: raw,
    label: raw,
  };
}

function coerceVideoModelList(payload: unknown): FreezoneVideoModelInfo[] {
  let candidate: unknown = payload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const wrapper = candidate as Record<string, unknown>;
    if (Array.isArray(wrapper.models)) candidate = wrapper.models;
    else if (Array.isArray(wrapper.data)) candidate = wrapper.data;
    else if (Array.isArray(wrapper.items)) candidate = wrapper.items;
    else {
      // provider→models[] map: { seedance: [...], huimeng: [...] }
      const flattened: FreezoneVideoModelInfo[] = [];
      for (const [providerRaw, value] of Object.entries(wrapper)) {
        const providerId = normalizeVideoProviderId(providerRaw);
        if (!providerId || !Array.isArray(value)) continue;
        for (const item of value) {
          if (typeof item === "string") {
            flattened.push({
              id: item,
              providerId,
              apiModel: item,
              label: item,
            });
          } else if (item && typeof item === "object") {
            const entry = videoModelEntryFromObject(item as Record<string, unknown>);
            if (entry) flattened.push({ ...entry, providerId });
          }
        }
      }
      if (flattened.length > 0) return flattened;
    }
  }

  if (!Array.isArray(candidate)) return [];
  const result: FreezoneVideoModelInfo[] = [];
  for (const item of candidate) {
    if (typeof item === "string") {
      result.push(videoModelEntryFromString(item));
    } else if (item && typeof item === "object") {
      const entry = videoModelEntryFromObject(item as Record<string, unknown>);
      if (entry) result.push(entry);
    }
  }
  return result;
}

export async function fetchFreezoneVideoModels(
  project: string,
): Promise<FreezoneVideoModelInfo[]> {
  const payload = await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/video/models`,
  );
  return coerceVideoModelList(payload);
}

// /freezone/video/camera-templates --------------------------------------- //

export interface FreezoneVideoCameraTemplate {
  /** Stable id used by the picker + sent to backend as `camera_template_id`. */
  id: string;
  /** Display label (e.g. "Camera descends"). */
  label: string;
  /** Prompt fragment prepended to the user's prompt when this template is active. */
  promptFragment: string;
  /** Optional preview video URL. Falls back to `/video/camera-presets/<id>.mp4`. */
  videoUrl: string | null;
}

function coerceCameraTemplateList(payload: unknown): FreezoneVideoCameraTemplate[] {
  // openapi.json schema is empty `{}` — backend shape isn't documented.
  // Accept several common envelopes defensively.
  let candidate: unknown = payload;
  if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
    const wrapper = candidate as Record<string, unknown>;
    if (Array.isArray(wrapper.templates)) candidate = wrapper.templates;
    else if (Array.isArray(wrapper.data)) candidate = wrapper.data;
    else if (Array.isArray(wrapper.items)) candidate = wrapper.items;
    else if (Array.isArray(wrapper.camera_templates)) candidate = wrapper.camera_templates;
  }
  if (!Array.isArray(candidate)) return [];
  const result: FreezoneVideoCameraTemplate[] = [];
  for (const item of candidate) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const id = pickString(entry, "id", "template_id", "templateId", "name", "key");
    if (!id) continue;
    const label =
      pickString(entry, "label", "display_name", "displayName", "title", "name") ?? id;
    const promptFragment =
      pickString(
        entry,
        "promptFragment",
        "prompt_fragment",
        "prompt",
        "fragment",
        "description",
      ) ?? label;
    const videoUrl = pickString(
      entry,
      "videoUrl",
      "video_url",
      "previewUrl",
      "preview_url",
      "thumbnail",
      "thumbnail_url",
    );
    result.push({ id, label, promptFragment, videoUrl });
  }
  return result;
}

export async function fetchFreezoneVideoCameraTemplates(
  project: string,
): Promise<FreezoneVideoCameraTemplate[]> {
  const payload = await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/video/camera-templates`,
  );
  return coerceCameraTemplateList(payload);
}

// /freezone/edit ---------------------------------------------------------- //

export interface FreezoneEditPayload extends FreezoneNodeContext {
  prompt: string;
  baseUrl: string;
  extraReferenceUrls?: string[];
  aspectRatio?: string;
  imageSize?: string;
  provider?: FreezoneProvider | null;
  model?: string | null;
  /** Registry model id (for restore; differs from the model string after the provider split). */
  modelId?: string | null;
  /** Generation mode (for restore): text_to_image / image_to_image / all_reference / image_reference. */
  genMode?: string | null;
  quality?: string | null;
}

export async function submitFreezoneEdit(
  project: string,
  payload: FreezoneEditPayload,
): Promise<FreezoneJobRef> {
  // The base image and extra reference images must likewise be static URLs the backend can resolve; base64 is uploaded first.
  const baseUrl = await ensureBackendImageUrl(project, payload.baseUrl);
  const extraReferenceUrls = await ensureBackendImageUrls(
    project,
    payload.extraReferenceUrls,
  );
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/edit`,
    {
      method: "POST",
      json: {
        prompt: payload.prompt,
        base_url: baseUrl,
        extra_reference_urls: extraReferenceUrls,
        aspect_ratio: payload.aspectRatio ?? "2:3",
        image_size: payload.imageSize ?? "2K",
        provider: payload.provider ?? null,
        model: payload.model ?? null,
        ...(payload.modelId ? { model_id: payload.modelId } : {}),
        ...(payload.genMode ? { gen_mode: payload.genMode } : {}),
        quality: payload.quality ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/sketch-from-context ------------------------------------------- //

export type FreezoneSketchContextSource =
  | "beat"
  | "selected_background"
  | "director_combined"
  | "background_candidate";

export interface FreezoneSketchFromContextPayload extends FreezoneNodeContext {
  episode: number;
  beat: number;
  sourceKind?: FreezoneSketchContextSource;
  sourceUrl?: string | null;
  provider?: FreezoneProvider | null;
  model?: string | null;
  quality?: string | null;
}

export async function submitFreezoneSketchFromContext(
  project: string,
  payload: FreezoneSketchFromContextPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/sketch-from-context`,
    {
      method: "POST",
      json: {
        episode: payload.episode,
        beat: payload.beat,
        source_kind: payload.sourceKind ?? "beat",
        source_url: payload.sourceUrl ?? null,
        provider: payload.provider ?? null,
        model: payload.model ?? null,
        quality: payload.quality ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/frame-from-context -------------------------------------------- //

export interface FreezoneFrameFromContextPayload extends FreezoneNodeContext {
  episode: number;
  beat: number;
  sketchUrl: string;
  backgroundUrl?: string | null;
  provider?: FreezoneProvider | null;
  model?: string | null;
  quality?: string | null;
}

export async function submitFreezoneFrameFromContext(
  project: string,
  payload: FreezoneFrameFromContextPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/frame-from-context`,
    {
      method: "POST",
      json: {
        episode: payload.episode,
        beat: payload.beat,
        sketch_url: payload.sketchUrl,
        background_url: payload.backgroundUrl ?? null,
        provider: payload.provider ?? null,
        model: payload.model ?? null,
        quality: payload.quality ?? null,
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/image-to-3gs --------------------------------------------------- //

/** SHARP / 3GS source type; master/reverse are single-sided SOG, pano uses 360 panorama generation. */
export type FreezoneImageTo3GSKind = "master" | "reverse" | "pano";

export interface FreezoneImageTo3GSPayload extends FreezoneNodeContext {
  /** Static URL of the source image, usually from a Freezone image node. */
  sourceUrl: string;
  /** Defaults to master; the current 3D world node only uses master. */
  sourceKind?: FreezoneImageTo3GSKind;
}

export async function submitFreezoneImageTo3GS(
  project: string,
  payload: FreezoneImageTo3GSPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/image-to-3gs`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        source_kind: payload.sourceKind ?? "master",
        ...nodeContextBody(payload),
      },
    },
  );
}

// /freezone/extract-frames ------------------------------------------------ //

export interface FreezoneExtractPayload {
  videoUrl: string;
  maxFrames?: number;
  sceneThreshold?: number;
}

export async function submitFreezoneExtract(
  project: string,
  payload: FreezoneExtractPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/extract-frames`,
    {
      method: "POST",
      json: {
        video_url: payload.videoUrl,
        max_frames: payload.maxFrames ?? 20,
        scene_threshold: payload.sceneThreshold ?? 0.3,
      },
    },
  );
}

// /freezone/analyze-shots ------------------------------------------------- //

export interface FreezoneAnalyzePayload {
  frameUrls: string[];
  /** Analysis is a backend capability; Freezone UI sends OpenRouter by default. */
  provider?: "openrouter" | null;
  /** Optional backend model override for internal/debug use. */
  model?: string | null;
}

export async function submitFreezoneAnalyze(
  project: string,
  payload: FreezoneAnalyzePayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/analyze-shots`,
    {
      method: "POST",
      json: {
        frame_urls: payload.frameUrls,
        provider: payload.provider ?? null,
        model: payload.model ?? null,
      },
    },
  );
}

// /freezone/redraw -------------------------------------------------------- //

export type FreezoneRedrawAspectRatio =
  | "original"
  | "1:1"
  | "4:3"
  | "3:4"
  | "16:9"
  | "9:16";

/**
 * Aspect-ratio values accepted by the redraw endpoint itself (kept consistent with the
 * Literal of the backend `FreezoneRedrawRequest.aspect_ratio`).
 *
 * This is not a model capability but an API contract: even if the admin configures other ratios for a model, redraw can
 * only submit these values, so the frontend takes "model config ∩ API contract".
 */
export const FREEZONE_REDRAW_ASPECT_RATIOS: readonly FreezoneRedrawAspectRatio[] = [
  "original",
  "1:1",
  "4:3",
  "3:4",
  "16:9",
  "9:16",
];

export interface FreezoneRedrawPayload {
  sourceUrl: string;
  /** Optional mask static URL. Transparent pixels = editable region (inpainting). */
  maskUrl?: string | null;
  prompt?: string;
  aspectRatio?: FreezoneRedrawAspectRatio;
  numImages?: number;
  imageSize?: string;
  model?: string;
}

export async function submitFreezoneRedraw(
  project: string,
  payload: FreezoneRedrawPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/redraw`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        mask_url: payload.maskUrl ?? null,
        prompt: payload.prompt ?? "",
        aspect_ratio: payload.aspectRatio ?? "original",
        num_images: payload.numImages ?? 1,
        image_size: payload.imageSize ?? "2K",
        ...(payload.model ? { model: payload.model } : {}),
      },
    },
  );
}

// /freezone/upscale ------------------------------------------------------- //

export type FreezoneUpscaleScaleFactor = 2 | 4 | 6;

export interface FreezoneUpscalePayload {
  sourceUrl: string;
  scaleFactor?: FreezoneUpscaleScaleFactor;
  imageSize?: string;
  model?: string;
}

export async function submitFreezoneUpscale(
  project: string,
  payload: FreezoneUpscalePayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/upscale`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        scale_factor: payload.scaleFactor ?? 2,
        image_size: payload.imageSize ?? "2K",
        ...(payload.model ? { model: payload.model } : {}),
      },
    },
  );
}

// /freezone/outpaint ------------------------------------------------------ //

export type FreezoneOutpaintAspectRatio =
  | "original"
  | "1:1"
  | "4:3"
  | "3:4"
  | "16:9"
  | "9:16";

export interface FreezoneOutpaintPayload {
  sourceUrl: string;
  targetAspectRatio?: FreezoneOutpaintAspectRatio;
  numImages?: number;
  imageSize?: string;
  model?: string;
}

export async function submitFreezoneOutpaint(
  project: string,
  payload: FreezoneOutpaintPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/outpaint`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        target_aspect_ratio: payload.targetAspectRatio ?? "original",
        num_images: payload.numImages ?? 1,
        image_size: payload.imageSize ?? "2K",
        ...(payload.model ? { model: payload.model } : {}),
      },
    },
  );
}

// /freezone/multi-view ---------------------------------------------------- //

export type FreezoneMultiViewPreset =
  | "custom"
  | "fisheye"
  | "oblique"
  | "front"
  | "front_up"
  | "full_body"
  | "back";

export type FreezoneMultiViewShotSize =
  | "extreme_close_up"
  | "close_up"
  | "medium_close"
  | "medium"
  | "full_body"
  | "wide"
  | "extreme_wide";

export interface FreezoneMultiViewPayload {
  sourceUrl: string;
  preset?: FreezoneMultiViewPreset;
  yawDegrees?: number;
  pitchDegrees?: number;
  shotSize?: FreezoneMultiViewShotSize;
  prompt?: string;
  imageSize?: string;
  model?: string;
}

export async function submitFreezoneMultiView(
  project: string,
  payload: FreezoneMultiViewPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/multi-view`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        preset: payload.preset ?? "custom",
        yaw_degrees: payload.yawDegrees ?? 0,
        pitch_degrees: payload.pitchDegrees ?? 0,
        shot_size: payload.shotSize ?? "medium",
        prompt: payload.prompt ?? "",
        image_size: payload.imageSize ?? "2K",
        ...(payload.model ? { model: payload.model } : {}),
      },
    },
  );
}

// /freezone/relight ------------------------------------------------------- //

export type FreezoneRelightScope = "global" | "local";

export type FreezoneRelightKeyLightDirection =
  | "left"
  | "top"
  | "right"
  | "front"
  | "bottom"
  | "back";

export interface FreezoneRelightPayload {
  sourceUrl: string;
  lightingReferenceUrl?: string | null;
  scope?: FreezoneRelightScope;
  smartMode?: boolean;
  brightness?: number;
  colorHex?: string;
  /** Color temperature (Kelvin). Backend `color_temperature_kelvin: int | null`, range 1500-10000. */
  colorTemperatureKelvin?: number | null;
  keyLightDirection?: FreezoneRelightKeyLightDirection;
  rimLight?: boolean;
  prompt?: string;
  imageSize?: string;
  model?: string;
}

export async function submitFreezoneRelight(
  project: string,
  payload: FreezoneRelightPayload,
): Promise<FreezoneJobRef> {
  // Both the source image and the lighting reference image go through static URLs; base64 is uploaded first.
  const sourceUrl = await ensureBackendImageUrl(project, payload.sourceUrl);
  const lightingReferenceUrl = payload.lightingReferenceUrl
    ? await ensureBackendImageUrl(project, payload.lightingReferenceUrl)
    : null;
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/relight`,
    {
      method: "POST",
      json: {
        source_url: sourceUrl,
        lighting_reference_url: lightingReferenceUrl,
        scope: payload.scope ?? "global",
        smart_mode: payload.smartMode ?? true,
        brightness: payload.brightness ?? 50,
        color_hex: payload.colorHex ?? "#ffffff",
        color_temperature_kelvin: payload.colorTemperatureKelvin ?? null,
        key_light_direction: payload.keyLightDirection ?? "front",
        rim_light: payload.rimLight ?? false,
        prompt: payload.prompt ?? "",
        image_size: payload.imageSize ?? "2K",
        ...(payload.model ? { model: payload.model } : {}),
      },
    },
  );
}

// /freezone/scene-360 ----------------------------------------------------- //

/** @deprecated Panorama output is fixed to 2:1 by the backend; the type is kept only for old canvas data. */
export type FreezoneScene360AspectRatio = "2:1" | "21:9";

/** @deprecated Panorama output is fixed to 2:1 by the backend. */
export const FREEZONE_SCENE_360_ASPECT_RATIOS: readonly FreezoneScene360AspectRatio[] =
  ["2:1", "21:9"];

export const DEFAULT_FREEZONE_SCENE_360_ASPECT_RATIO: FreezoneScene360AspectRatio =
  "2:1";

export interface FreezoneScene360Payload {
  referenceUrl: string;
  imageSize?: string;
  /** @deprecated The backend fixes the output to 2:1; this value is no longer written into the request. */
  aspectRatio?: FreezoneScene360AspectRatio;
  model?: string;
  /** Media model catalog identity; the backend bills by catalog pricing rules from it (same basis as the frontend quote). */
  catalogId?: string;
  quality?: string;
  mode?: "candidate" | "commit";
}

/**
 * **Single-image 360 (simple pipeline)** — the old path: it treats one image as a reference and runs the generic
 * image-edit generation of a panorama. No master/reverse overlap analysis, spatial contract or stitching;
 * suited to quick generation on the freezone free canvas ("try 360 on any image").
 * Asset-scoped scene 360 generation uses
 * {@link submitFreezoneScene360FromMaster} (the complex workflow), not this one.
 */
export async function submitFreezoneScene360(
  project: string,
  payload: FreezoneScene360Payload,
): Promise<FreezoneJobRef> {
  // The reference image must be a static URL the backend can resolve; base64 is uploaded first.
  const referenceUrl = await ensureBackendImageUrl(project, payload.referenceUrl);
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/scene-360`,
    {
      method: "POST",
      json: {
        reference_url: referenceUrl,
        image_size: payload.imageSize ?? "2K",
        mode: payload.mode ?? "candidate",
        // The final 360 output contract is fixed at 2:1; upstream ratio adaptation is a backend implementation detail.
        // The panel has no model selector, so the quote and execution must use the same fixed model.
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.catalogId ? { catalog_id: payload.catalogId } : {}),
        ...(payload.quality ? { quality: payload.quality } : {}),
      },
    },
  );
}

// /scenes/{name}/pano/generate-async --------------------------------------- //

export interface ScenePanoFromMasterPayload {
  sceneId: string;
  /** The backend automatically falls back to text if master does not exist; the FE passes 'master' by default. */
  source?: "master" | "text";
  style?: string;
  provider?: string;
  model?: string;
  imageSize?: string;
  quality?: string;
  timeoutSeconds?: number;
}

/**
 * **Complex scene 360 workflow (complex pipeline)** — runs the stage_asset
 * `pano_from_master` step:
 *  - reads the scene's master + reverse_master files
 *  - runs the overlap analyzer (master/reverse edge-blend analysis)
 *  - runs the spatial contract analyzer
 *  - calls BuilderGPT/supertale_scene_360_gpt_image2.py to generate pano_360.png
 *  - writes to the stage_manifest canonical path (the same file as the asset canvas pano viewer)
 *
 * Asset-scoped scene 360 generation uses this complex path, not the simple
 * `/freezone/scene-360` endpoint.
 *
 * Note: this goes through the scenes route (not the freezone route), so the response is the
 * `{ok, task_type:"stage_asset", task_key, scope, task_id, backend}` structure —
 * cast to the FreezoneJobRef shape (task_key + job_id + task_type) for upper layers.
 */
export async function submitFreezoneScene360FromMaster(
  project: string,
  payload: ScenePanoFromMasterPayload,
): Promise<FreezoneJobRef> {
  const sceneId = payload.sceneId;
  if (!sceneId) throw new Error("submitFreezoneScene360FromMaster: missing sceneId");
  const result = await apiCall<{
    ok: boolean;
    task_type: string;
    task_key: string;
    task_id?: string;
    scope?: string;
    backend?: string;
    error?: string;
  }>(
    `projects/${encodeURIComponent(project)}/scenes/${encodeURIComponent(sceneId)}/pano/generate-async`,
    {
      method: "POST",
      json: {
        source: payload.source ?? "master",
        ...(payload.style ? { style: payload.style } : {}),
        ...(payload.provider ? { provider: payload.provider } : {}),
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.imageSize ? { image_size: payload.imageSize } : {}),
        ...(payload.quality ? { quality: payload.quality } : {}),
        ...(payload.timeoutSeconds ? { timeout_seconds: payload.timeoutSeconds } : {}),
      },
    },
  );
  if (!result.ok || result.error) {
    throw new Error(result.error ?? "scene 360 from master failed");
  }
  return {
    task_key: result.task_key,
    job_id: result.task_id ?? result.scope ?? sceneId,
    task_type: "stage_asset",
  } as FreezoneJobRef;
}

// /freezone/template-edit ------------------------------------------------- //

export type FreezoneTemplateEditMode =
  | "multi_camera_nine_grid"
  | "story_pitch_four_grid"
  | "character_face_three_view"
  | "product_three_view"
  | "storyboard_25_grid"
  | "cinematic_light_correction"
  | "character_three_view_generation"
  | "scene_setting_sheet"
  | "image_projection_after_3s"
  | "image_projection_before_5s";

export interface FreezoneTemplateEditPayload {
  sourceUrl: string;
  mode: FreezoneTemplateEditMode;
  prompt?: string;
  imageSize?: string;
  model?: string;
  /** Media model catalog identity; the backend bills by catalog pricing rules from it (same basis as the frontend quote). */
  catalogId?: string;
  quality?: string;
}

export async function submitFreezoneTemplateEdit(
  project: string,
  payload: FreezoneTemplateEditPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/template-edit`,
    {
      method: "POST",
      json: {
        source_url: payload.sourceUrl,
        mode: payload.mode,
        prompt: payload.prompt ?? "",
        image_size: payload.imageSize ?? "2K",
        // Same as scene-360: the quote uses the first catalog model, and execution must use the same model/quality.
        ...(payload.model ? { model: payload.model } : {}),
        ...(payload.catalogId ? { catalog_id: payload.catalogId } : {}),
        ...(payload.quality ? { quality: payload.quality } : {}),
      },
    },
  );
}

// /freezone/jobs/{type}/{id}/result --------------------------------------- //

export interface FreezoneJobResult {
  gif_task_key?: string;
  gif_job_id?: string;
  gif_task_type?: string;
  output_url?: string;
  gif_url?: string;
  svg_url?: string;
  url: string;
  size: number;
  cover_url?: string | null;
}

export async function fetchFreezoneJobResult(
  project: string,
  taskType:
    | "freezone_image_vectorize"
    | "freezone_image_animate_gif"
    | "freezone_gen"
    | "freezone_edit"
    | "freezone_upscale"
    | "freezone_extract"
    | "freezone_analyze"
    | "freezone_multi_view"
    | "freezone_relight"
    | "freezone_scene_360"
    | "freezone_template_edit"
    | "freezone_outpaint"
    | "freezone_redraw"
    | "freezone_video_gen"
    | "freezone_video_omni_gen"
    | "freezone_video_i2v"
    | "freezone_video_multishot"
    | "freezone_video_erase"
    | "freezone_video_compose"
    | "freezone_video_upscale"
    | "freezone_audio_separate"
    | "freezone_audio_speech"
    | "freezone_audio_eleven_music"
    | "freezone_image_reverse_prompt"
    | "freezone_text_generate"
    | "freezone_text_translate"
    | "freezone_story_script"
    | "freezone_analyze_video_story"
    | "stage_asset",
  jobId: string,
): Promise<FreezoneJobResult> {
  return await apiCall<FreezoneJobResult>(
    `projects/${encodeURIComponent(project)}/freezone/jobs/${encodeURIComponent(taskType)}/${encodeURIComponent(jobId)}/result`,
  );
}

/**
 * `freezone_image_reverse_prompt` results aren't files — the dedicated job
 * result endpoint returns `{ prompt: "..." }` directly. SSE `task.result` only
 * carries `{ output_format: "json" }`, so the text must be fetched here.
 */
export interface FreezoneReversePromptResult {
  prompt: string;
}

export async function fetchFreezoneReversePromptResult(
  project: string,
  jobId: string,
): Promise<FreezoneReversePromptResult> {
  return await apiCall<FreezoneReversePromptResult>(
    `projects/${encodeURIComponent(project)}/freezone/jobs/freezone_image_reverse_prompt/${encodeURIComponent(jobId)}/result`,
  );
}

// /freezone/audio/references + /freezone/audio/speech -------------------- //

/**
 * Voice scope defined by the backend.
 * - project_narrator: project narrator
 * - character_default: character default voice
 * - character_age_group: character age-group voice (needs slot)
 * - identity: the identity's own voice (needs identity_id)
 * - identity_resolved: the actual voice resolved by fallback identity -> age group -> character default
 */
export type FreezoneAudioVoiceRefScope =
  | "project_narrator"
  | "user_custom"
  | "character_default"
  | "character_age_group"
  | "identity"
  | "identity_resolved";

export interface FreezoneAudioVoiceRef {
  scope: FreezoneAudioVoiceRefScope;
  /** Required when scope=character_* / identity*; matches the project character name. */
  characterName?: string;
  /** Required when scope=identity / identity_resolved. */
  identityId?: string;
  /** Required when scope=character_age_group: child/youth/middle/elder. */
  slot?: string;
  /** Required when scope=user_custom: from GET/POST /freezone/audio/voices. */
  voiceId?: string;
}

/**
 * A single record returned by `GET /freezone/audio/references`. openapi gives no schema ({}),
 * so this is inferred from the backend description; the UI reads defensively and ignores unknown fields.
 */
export interface FreezoneAudioReferenceItem {
  scope: FreezoneAudioVoiceRefScope;
  /** Present when scope=character_* or identity*. */
  character_name?: string | null;
  /** Present when scope=identity / identity_resolved. */
  identity_id?: string | null;
  /** Present when scope=character_age_group: child/youth/middle/elder. */
  slot?: string | null;
  /** Present when scope=user_custom: account-level voice ID (from POST /freezone/audio/voices). */
  voice_id?: string | null;
  /** Display name (from the backend; the frontend falls back to composing one if missing). */
  label?: string | null;
  /** Language / accent description. */
  language?: string | null;
  /** Gender (if the backend provides it). */
  gender?: string | null;
  /** Preview audio static URL (if the backend provides it). */
  preview_url?: string | null;
  [key: string]: unknown;
}

export interface FreezoneAudioReferencesResult {
  /** List of voice references available in the project. */
  available: FreezoneAudioReferenceItem[];
  [key: string]: unknown;
}

export async function fetchFreezoneAudioReferences(
  project: string,
): Promise<FreezoneAudioReferencesResult> {
  const payload = await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/audio/references`,
  );
  // Fault tolerance: the backend may return an array directly, or { available: [...] }, or { items: [...] }.
  if (Array.isArray(payload)) {
    return { available: payload as FreezoneAudioReferenceItem[] };
  }
  if (payload && typeof payload === "object") {
    const wrapper = payload as Record<string, unknown>;
    if (Array.isArray(wrapper.available)) {
      return wrapper as unknown as FreezoneAudioReferencesResult;
    }
    if (Array.isArray(wrapper.items)) {
      return { available: wrapper.items as FreezoneAudioReferenceItem[] };
    }
    if (Array.isArray(wrapper.data)) {
      return { available: wrapper.data as FreezoneAudioReferenceItem[] };
    }
  }
  return { available: [] };
}

export interface FreezoneAudioSpeechPayload extends FreezoneNodeContext {
  /** Dialogue / narration text to synthesize. */
  text: string;
  /** preset needs no reference audio; clone uses voiceRef to clone the voice. */
  speechMode?: "preset" | "clone";
  presetModel?: string;
  presetVoice?: string;
  /** Emotion prompt; if empty the project narration style is used. Example: "tense, lowered voice, a hint of fear". */
  emotionPrompt?: string;
  /** Voice reference; if omitted the project default narrator is used. */
  voiceRef?: FreezoneAudioVoiceRef | null;
  /** Target beat; when given, the generated audio carries the beat_audio slot_target and can be committed directly. */
  targetEpisode?: number;
  targetBeat?: number;
}

export async function submitFreezoneAudioSpeech(
  project: string,
  payload: FreezoneAudioSpeechPayload,
): Promise<FreezoneJobRef> {
  const voiceRefBody = payload.voiceRef
    ? {
        scope: payload.voiceRef.scope,
        character_name: payload.voiceRef.characterName ?? "",
        identity_id: payload.voiceRef.identityId ?? "",
        slot: payload.voiceRef.slot ?? "",
        voice_id: payload.voiceRef.voiceId ?? "",
      }
    : null;
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/audio/speech`,
    {
      method: "POST",
      json: {
        ...nodeContextBody(payload),
        text: payload.text,
        speech_mode: payload.speechMode ?? "clone",
        preset_model: payload.presetModel ?? "edge-tts",
        preset_voice: payload.presetVoice ?? "Serena",
        emotion_prompt: payload.emotionPrompt ?? "",
        voice_ref: voiceRefBody,
        target_episode: payload.targetEpisode,
        target_beat: payload.targetBeat,
      },
    },
  );
}

// /freezone/audio/eleven-music ------------------------------------------- //

/**
 * Text-to-music request. Everything except input is optional; omitted fields use backend defaults.
 * model / response_format / output_format need not be sent by the frontend (backend defaults LingShan-MU-11 / mp3 /
 * mp3_44100_128), so they are not exposed here.
 */
export interface FreezoneAudioMusicPayload extends FreezoneNodeContext {
  /** Music description prompt (style, instruments, mood, etc.); maps to backend `input`. */
  prompt: string;
  /** Length in milliseconds, range 3000-600000; if empty the backend default 30000 is used. */
  musicLengthMs?: number;
  /** Whether to force instrumental only; if empty the backend default true is used. */
  forceInstrumental?: boolean;
  /** Whether to strictly follow the music section duration policy; if empty the backend default true is used. */
  respectSectionsDurations?: boolean;
  /** Target beat; when given, the generated audio carries the beat_audio slot_target and can be committed directly. */
  targetEpisode?: number;
  targetBeat?: number;
}

/**
 * Text-to-music. Returns an async job handle; fetch the result with
 * fetchFreezoneJobResult('freezone_audio_eleven_music').
 */
export async function submitFreezoneAudioMusic(
  project: string,
  payload: FreezoneAudioMusicPayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/audio/eleven-music`,
    {
      method: "POST",
      json: {
        ...nodeContextBody(payload),
        input: payload.prompt,
        music_length_ms: payload.musicLengthMs,
        force_instrumental: payload.forceInstrumental,
        respect_sections_durations: payload.respectSectionsDurations,
        target_episode: payload.targetEpisode,
        target_beat: payload.targetBeat,
      },
    },
  );
}

// /freezone/audio/voices ------------------------------------------------- //
//
// The list of "my voices" (scope=user_custom) is fetched uniformly through /freezone/audio/references
// (mixed into available[], filtered by scope). Only POST is kept here: upload a piece of audio to clone
// an account-level voice.

/**
 * Response of POST /freezone/audio/voices. openapi is an empty object, so fields are defined by inference.
 * Callers generally only need `voice_id`; the rest is only for immediate display after upload.
 */
export interface FreezoneAudioVoiceItem {
  voice_id: string;
  name?: string | null;
  language?: string | null;
  gender?: string | null;
  preview_url?: string | null;
  [key: string]: unknown;
}

export interface CreateFreezoneAudioVoiceOptions {
  /** Same as uploadFreezoneImage: pass false for large uploads to disable ky's default 30s timeout. */
  timeoutMs?: number | false;
}

export async function createFreezoneAudioVoice(
  project: string,
  file: File | Blob,
  name?: string,
  options?: CreateFreezoneAudioVoiceOptions,
): Promise<FreezoneAudioVoiceItem> {
  const fd = new FormData();
  fd.append(
    "file",
    file,
    file instanceof File ? file.name : "voice.wav",
  );
  if (name && name.trim()) fd.append("name", name.trim());
  const resp = await apiClient(
    `projects/${encodeURIComponent(project)}/freezone/audio/voices`,
    {
      method: "POST",
      body: fd,
      timeout: options?.timeoutMs ?? false,
    },
  ).json<{ ok: boolean; data?: FreezoneAudioVoiceItem; error?: string }>();
  if (!resp.ok || !resp.data) {
    throw new Error(resp.error ?? "voice upload failed");
  }
  return resp.data;
}

// /freezone/text/translate ------------------------------------------------ //

export interface FreezoneTextGeneratePayload extends FreezoneNodeContext {
  prompt: string;
}

export async function submitFreezoneTextGenerate(
  project: string,
  payload: FreezoneTextGeneratePayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/text/generate`,
    {
      method: "POST",
      json: {
        prompt: payload.prompt,
        ...nodeContextBody(payload),
      },
    },
  );
}

export interface FreezoneTextGenerateResult {
  generated_text: string;
  model: string;
}

export async function fetchFreezoneTextGenerateResult(
  project: string,
  jobId: string,
): Promise<FreezoneTextGenerateResult> {
  return await apiCall<FreezoneTextGenerateResult>(
    `projects/${encodeURIComponent(project)}/freezone/jobs/freezone_text_generate/${encodeURIComponent(jobId)}/result`,
  );
}

export type FreezoneTextTranslateNodeType =
  | "generic"
  | "image"
  | "video"
  | "audio"
  | "text";

export interface FreezoneTextTranslatePayload extends FreezoneNodeContext {
  text: string;
  /** Hints the translator at the calling node's tone. Defaults to "generic". */
  nodeType?: FreezoneTextTranslateNodeType;
}

export async function submitFreezoneTextTranslate(
  project: string,
  payload: FreezoneTextTranslatePayload,
): Promise<FreezoneJobRef> {
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/text/translate`,
    {
      method: "POST",
      json: {
        text: payload.text,
        node_type: payload.nodeType ?? "generic",
        ...nodeContextBody(payload),
      },
    },
  );
}

export interface FreezoneTextTranslateResult {
  translated_text: string;
  source_language: "en" | "vi";
  target_language: "en" | "vi";
  node_type: FreezoneTextTranslateNodeType;
}

export async function fetchFreezoneTextTranslateResult(
  project: string,
  jobId: string,
): Promise<FreezoneTextTranslateResult> {
  return await apiCall<FreezoneTextTranslateResult>(
    `projects/${encodeURIComponent(project)}/freezone/jobs/freezone_text_translate/${encodeURIComponent(jobId)}/result`,
  );
}

// /freezone/text/story-script -------------------------------------------- //

/** Character reference input item (used by the character generation script). */
export interface FreezoneStoryScriptCharacterRef {
  /** Character name or character label. */
  name?: string;
  /** Optional: existing character description. */
  description?: string;
  /** Character reference image static URL (/static/...). */
  imageUrl?: string;
  /** Optional: character role or narrative function (e.g. "female lead"). */
  role?: string;
}

export interface FreezoneStoryScriptPayload extends FreezoneNodeContext {
  /**
   * Text input: script / plot text. The backend requires at least one of source_text / source_url / video_url /
   * character_refs.
   */
  sourceText?: string;
  /** Static URL of a text resource; the backend fetches it and runs the generation flow. */
  sourceUrl?: string;
  /** Video input: static URL of an uploaded video; the backend parses the video first and then generates the same story script table. */
  videoUrl?: string;
  /** Total video duration (seconds), to make the script table timestamps more accurate. */
  durationSec?: number;
  /** Character reference input: with no text / video, generate the story script table from character images and descriptions. */
  characterRefs?: FreezoneStoryScriptCharacterRef[];
  /** Extra prompt supplied by the user (steering), e.g. style or shot preferences. */
  prompt?: string;
}

export async function submitFreezoneStoryScript(
  project: string,
  payload: FreezoneStoryScriptPayload,
): Promise<FreezoneJobRef> {
  const body: Record<string, unknown> = { ...nodeContextBody(payload) };
  if (payload.sourceText != null) body.source_text = payload.sourceText;
  if (payload.sourceUrl != null) body.source_url = payload.sourceUrl;
  if (payload.videoUrl != null) body.video_url = payload.videoUrl;
  if (payload.durationSec != null) body.duration_sec = payload.durationSec;
  if (payload.prompt != null) body.prompt = payload.prompt;
  if (payload.characterRefs && payload.characterRefs.length > 0) {
    body.character_refs = payload.characterRefs.map((ref) => {
      const item: Record<string, unknown> = {};
      if (ref.name != null) item.name = ref.name;
      if (ref.description != null) item.description = ref.description;
      if (ref.imageUrl != null) item.image_url = ref.imageUrl;
      if (ref.role != null) item.role = ref.role;
      return item;
    });
  }
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/text/story-script`,
    { method: "POST", json: body },
  );
}

/**
 * One row of the story script table. Field names must align with the backend `FreezoneStoryScriptRow`
 * (`src/novelvideo/api/schemas.py`) character for character — early frontends used
 * shorthand like `character` / `action`, which the backend never sent, so the table only showed
 * "-" (issue #207).
 */
export interface FreezoneStoryScriptRow {
  shot_no?: string | number | null;
  duration?: string | number | null;
  visual_description?: string | null;
  character_1?: string | null;
  character_description_1?: string | null;
  /** Character image 1 URL, backfilled by the backend by matching the character name against character_refs. */
  character_image_1?: string | null;
  character_2?: string | null;
  character_description_2?: string | null;
  /** Character image 2 URL, backfilled by the backend by matching the character name against character_refs. */
  character_image_2?: string | null;
  /** Reference image URL; in video reference mode the backend backfills the corresponding keyframe by keyframe_index. */
  reference?: string | null;
  /** In video reference mode, the input keyframe index of this shot (1-based, 0 = none). */
  keyframe_index?: number | null;
  shot?: string | null;
  character_action?: string | null;
  emotion?: string | null;
  scene_tags?: string | null;
  lighting_mood?: string | null;
  sound?: string | null;
  dialogue?: string | null;
  shot_prompt?: string | null;
  video_motion_prompt?: string | null;
  [key: string]: unknown;
}

export interface FreezoneStoryScriptResult {
  title?: string | null;
  rows: FreezoneStoryScriptRow[];
  /** Static URL of keyframes extracted in video reference mode, in order of keyframe_index. */
  frame_urls?: string[] | null;
}

export async function fetchFreezoneStoryScriptResult(
  project: string,
  jobId: string,
): Promise<FreezoneStoryScriptResult> {
  return await apiCall<FreezoneStoryScriptResult>(
    `projects/${encodeURIComponent(project)}/freezone/jobs/freezone_story_script/${encodeURIComponent(jobId)}/result`,
  );
}

// /freezone/upload (multipart) -------------------------------------------- //

export interface FreezoneUploadResult {
  url: string;
  filename: string;
  size: number;
}

export interface FreezoneUploadOptions {
  /**
   * Override the default ky timeout (30s). Pass `false` to disable —
   * required for multi-MB video uploads on slow links, otherwise ky aborts
   * the in-flight request and DevTools shows the row as `canceled`.
   */
  timeoutMs?: number | false;
  /** ky passes this straight through to the underlying fetch; omitted means not cancellable (historical behavior). */
  signal?: AbortSignal;
}

export async function uploadFreezoneImage(
  project: string,
  file: File | Blob,
  filename?: string,
  options?: FreezoneUploadOptions,
): Promise<FreezoneUploadResult> {
  const fd = new FormData();
  fd.append("file", file, filename ?? (file instanceof File ? file.name : "upload.png"));
  // ky's `body: FormData` skips the json envelope helper, so we go direct.
  const resp = await apiClient(
    `projects/${encodeURIComponent(project)}/freezone/upload`,
    {
      method: "POST",
      body: fd,
      timeout: options?.timeoutMs ?? false,
      signal: options?.signal,
    },
  ).json<{ ok: boolean; data?: FreezoneUploadResult; error?: string }>();
  if (!resp.ok || !resp.data) {
    throw new Error(resp.error ?? "upload failed");
  }
  return resp.data;
}

export async function uploadFreezoneReferenceFile(
  project: string,
  file: File,
): Promise<FreezoneUploadResult> {
  const fd = new FormData();
  fd.append("file", file, file.name);
  const resp = await apiClient(
    `projects/${encodeURIComponent(project)}/freezone/reference-file-upload`,
    {
      method: "POST",
      body: fd,
      timeout: false,
    },
  ).json<{ ok: boolean; data?: FreezoneUploadResult; error?: string }>();
  if (!resp.ok || !resp.data) {
    throw new Error(resp.error ?? "upload failed");
  }
  return resp.data;
}

// /freezone/assets/copy ---------------------------------------------------- //

export interface FreezoneAssetCopyFailure {
  source: string;
  /** invalid_source / not_found / forbidden / unavailable / copy_failed */
  reason: string;
}

export interface FreezoneAssetCopyResult {
  /** Source URL (original string) -> new URL in the target project. */
  mapping: Record<string, string>;
  failed: FreezoneAssetCopyFailure[];
}

/**
 * Cross-project paste: have the backend copy `sources` (same-origin asset URLs of the source project) into `project`.
 * Bytes do not pass through the browser; on OSS deployments this is a server-side CopyObject. A single failure only shows up in `failed`.
 */
export async function copyFreezoneAssets(
  project: string,
  sources: string[],
): Promise<FreezoneAssetCopyResult> {
  return apiCall<FreezoneAssetCopyResult>(
    `projects/${encodeURIComponent(project)}/freezone/assets/copy`,
    { method: "POST", json: { sources }, timeout: false },
  );
}

/** Same endpoint as image upload — backend treats the upload as a generic blob. */
export async function uploadFreezoneVideo(
  project: string,
  file: File | Blob,
  filename?: string,
  options?: FreezoneUploadOptions,
): Promise<FreezoneUploadResult> {
  // Disable the 30s default timeout: video files routinely run into the tens
  // of MB and the upload streams the body, so a short timeout cancels the
  // request before the server ever sees the end of the body.
  return await uploadFreezoneImage(project, file, filename, { timeoutMs: false, ...options });
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, payload = ""] = dataUrl.split(",", 2);
  const mimeMatch = /data:([^;]+)/.exec(meta);
  const mime = mimeMatch?.[1] ?? "image/png";
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function extensionForMime(mime: string): string {
  if (mime === "image/png") return "png";
  if (mime === "image/jpeg" || mime === "image/jpg") return "jpg";
  if (mime === "image/webp") return "webp";
  if (mime === "image/gif") return "gif";
  return "png";
}

/**
 * Coerce an arbitrary image reference into a backend-resolvable static path.
 *
 * - `data:` URLs are uploaded via `/freezone/upload` first; the response URL
 *   is what backends like `/freezone/image/reverse-prompt` can actually open.
 * - Anything else (already a `/static/...` path, http(s) URL, blob:, etc.) is
 *   returned as-is, minus the `?v=<ts>` cache buster that breaks backend path
 *   lookup (same strip pattern as `RedrawOverlay`).
 */
export async function ensureBackendImageUrl(
  project: string,
  rawUrl: string,
): Promise<string> {
  if (rawUrl.startsWith("data:")) {
    const blob = dataUrlToBlob(rawUrl);
    const ext = extensionForMime(blob.type);
    const uploaded = await uploadFreezoneImage(
      project,
      blob,
      `paste-${Date.now()}.${ext}`,
    );
    return uploaded.url.split("?")[0];
  }
  return rawUrl.split("?")[0];
}

/**
 * Batch variant of {@link ensureBackendImageUrl}: coerce a list of image
 * references into backend-resolvable static URLs. Empty / blank entries are
 * dropped; original order is preserved; uploads run in parallel.
 */
export async function ensureBackendImageUrls(
  project: string,
  rawUrls: readonly string[] | null | undefined,
): Promise<string[]> {
  if (!rawUrls || rawUrls.length === 0) return [];
  const cleaned = rawUrls.filter(
    (url): url is string => typeof url === "string" && url.trim().length > 0,
  );
  return await Promise.all(
    cleaned.map((url) => ensureBackendImageUrl(project, url)),
  );
}

// /freezone/extract-frames + analyze-shots -------------------------------- //

export interface FreezoneExtractFramesPayload {
  videoUrl: string;
  maxFrames?: number;
  sceneThreshold?: number;
}

export async function submitFreezoneExtractFrames(
  project: string,
  payload: FreezoneExtractFramesPayload,
): Promise<unknown> {
  return await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/extract-frames`,
    {
      method: "POST",
      json: {
        video_url: payload.videoUrl,
        max_frames: payload.maxFrames ?? 20,
        scene_threshold: payload.sceneThreshold ?? 0.3,
      },
    },
  );
}

export interface FreezoneAnalyzeShotsPayload {
  frameUrls: string[];
}

export async function submitFreezoneAnalyzeShots(
  project: string,
  payload: FreezoneAnalyzeShotsPayload,
): Promise<unknown> {
  return await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/analyze-shots`,
    {
      method: "POST",
      json: {
        frame_urls: payload.frameUrls,
      },
    },
  );
}

// /freezone/analyze-video-story ------------------------------------------ //

export interface FreezoneAnalyzeVideoStoryPayload {
  /** /static/... URL inside the project. */
  videoUrl: string;
  /** 3..50, defaults to 20 backend-side. */
  maxFrames?: number;
  /** 0..1 ffmpeg scene threshold; defaults to 0.3 backend-side. */
  sceneThreshold?: number;
  /** Optional total duration (seconds) — improves table timestamp accuracy. */
  durationSec?: number;
}

export async function submitFreezoneAnalyzeVideoStory(
  project: string,
  payload: FreezoneAnalyzeVideoStoryPayload,
): Promise<FreezoneJobRef> {
  const body: Record<string, unknown> = {
    video_url: payload.videoUrl,
  };
  if (payload.maxFrames != null) body.max_frames = payload.maxFrames;
  if (payload.sceneThreshold != null) body.scene_threshold = payload.sceneThreshold;
  if (payload.durationSec != null) body.duration_sec = payload.durationSec;
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/analyze-video-story`,
    { method: "POST", json: body },
  );
}

// /freezone/video-breakdown ---------------------------------------------- //

export type FreezoneVideoBreakdownDimension = "storyboard" | "motion" | "music";

export interface FreezoneVideoBreakdownPayload {
  /** /static/... URL inside the project. */
  videoUrl: string;
  /** Omit to run all three dimensions. */
  dimensions?: FreezoneVideoBreakdownDimension[];
  /** Keyframe cap, 3..80; defaults to 40 backend-side (actual count tracks duration). */
  maxFrames?: number;
  /** 0..1 ffmpeg scene threshold; defaults to 0.3 backend-side. */
  sceneThreshold?: number;
  /** Optional total duration (seconds) — improves shot timestamp accuracy. */
  durationSec?: number;
  /** Shots per storyboard group when the model gives no segments; default 4. */
  storyboardGroupSize?: number;
  /** Max motion reference clips; default 3. */
  maxMotionClips?: number;
  /** Per-clip cap in seconds; default 6. */
  motionClipMaxSec?: number;
  /** BGM reference length in seconds; default 15. */
  musicClipSec?: number;
}

export interface FreezoneVideoBreakdownShot {
  code: string;
  shot: number;
  segment: number;
  start_time: number;
  end_time: number;
  duration: number;
  shot_size: string;
  lighting: string;
  camera_angle: string;
  camera_movement: string;
  description: string;
  narrative: string;
  image_prompt: string;
  motion_prompt: string;
  image_url: string | null;
}

export interface FreezoneVideoBreakdownGroup {
  group_index: number;
  segment: number;
  label: string;
  shots: FreezoneVideoBreakdownShot[];
}

export interface FreezoneVideoBreakdownMotionClip {
  code: string;
  shot: number;
  start_time: number;
  end_time: number;
  duration_sec: number;
  camera_movement: string;
  camera_angle: string;
  description: string;
  motion_prompt: string;
  video_url: string | null;
  preview_image_url: string | null;
}

export interface FreezoneVideoBreakdownMusicClip {
  code: string;
  start_time: number;
  end_time: number;
  duration_sec: number;
  description: string;
  mood: string;
  instruments: string[];
  bpm: number | null;
  audio_url: string | null;
}

/** Shape of `completed.result` for the `freezone_video_breakdown` task. */
export interface FreezoneVideoBreakdownResult {
  job_id: string;
  source_video_url?: string | null;
  duration_sec?: number | null;
  model?: string | null;
  title?: string | null;
  summary?: string | null;
  dimensions?: FreezoneVideoBreakdownDimension[];
  storyboard?: { label: string; groups: FreezoneVideoBreakdownGroup[] } | null;
  motion?: { label: string; clips: FreezoneVideoBreakdownMotionClip[] } | null;
  /** `clip` is null when the source video has no audio track. */
  music?: { label: string; clip: FreezoneVideoBreakdownMusicClip | null } | null;
  frame_urls?: (string | null)[];
  output_url?: string | null;
}

export async function submitFreezoneVideoBreakdown(
  project: string,
  payload: FreezoneVideoBreakdownPayload,
): Promise<FreezoneJobRef> {
  const body: Record<string, unknown> = {
    video_url: payload.videoUrl,
  };
  if (payload.dimensions?.length) body.dimensions = payload.dimensions;
  if (payload.maxFrames != null) body.max_frames = payload.maxFrames;
  if (payload.sceneThreshold != null) body.scene_threshold = payload.sceneThreshold;
  if (payload.durationSec != null) body.duration_sec = payload.durationSec;
  if (payload.storyboardGroupSize != null) {
    body.storyboard_group_size = payload.storyboardGroupSize;
  }
  if (payload.maxMotionClips != null) body.max_motion_clips = payload.maxMotionClips;
  if (payload.motionClipMaxSec != null) body.motion_clip_max_sec = payload.motionClipMaxSec;
  if (payload.musicClipSec != null) body.music_clip_sec = payload.musicClipSec;
  return await apiCall<FreezoneJobRef>(
    `projects/${encodeURIComponent(project)}/freezone/video-breakdown`,
    { method: "POST", json: body },
  );
}

// /freezone/video/character-library -------------------------------------- //

export type FreezoneAssetLibraryMedia = "image" | "video" | "audio";
export type FreezoneAssetLibrarySource =
  | "upload"
  | "character"
  | "scene"
  | "prop";

/** Purpose category. Old entries lack this field; the read side derives it from source/media. */
export type FreezoneAssetLibraryCategory =
  | "other"
  | "character"
  | "scene"
  | "prop"
  | "style"
  | "audio";

/**
 * User-created asset library folders. System folders (main line / unsorted assets / same-named directories per category) are not persisted;
 * the frontend generates them from reserved keys, and only the user-created folders here are read back from the backend.
 */
export interface FreezoneAssetLibraryFolder {
  id: string;
  name: string;
  /** Cover image URL, taken from an asset in the folder; empty if never set, and the frontend draws the default folder icon. */
  cover?: string | null;
  created_at?: string;
}

export interface FreezoneVideoCharacterLibraryItem {
  id?: string;
  name: string;
  media?: FreezoneAssetLibraryMedia;
  source?: FreezoneAssetLibrarySource;
  category?: FreezoneAssetLibraryCategory;
  /** Save location: system folder key or user-created folder id. Old entries lack it; the read side derives it from the category. */
  folder?: string;
  image_urls?: string[];
  video_url?: string | null;
  audio_url?: string | null;
  cover_url?: string | null;
  created_at?: string;
  updated_at?: string;
  [key: string]: unknown;
}

export interface FreezoneAddVideoCharacterLibraryItemPayload {
  name: string;
  media?: FreezoneAssetLibraryMedia;
  imageUrls?: string[];
  videoUrl?: string;
  audioUrl?: string;
  category?: FreezoneAssetLibraryCategory;
  folder?: string;
}

export async function fetchFreezoneVideoCharacterLibrary(
  project: string,
): Promise<unknown> {
  return await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/video/character-library`,
  );
}

export async function submitFreezoneAddVideoCharacterLibraryItem(
  project: string,
  payload: FreezoneAddVideoCharacterLibraryItemPayload,
): Promise<unknown> {
  const body: Record<string, unknown> = {
    name: payload.name,
    media: payload.media ?? "image",
  };
  if (payload.imageUrls && payload.imageUrls.length > 0) {
    body.image_urls = payload.imageUrls;
  }
  if (payload.videoUrl) body.video_url = payload.videoUrl;
  if (payload.audioUrl) body.audio_url = payload.audioUrl;
  if (payload.category) body.category = payload.category;
  if (payload.folder) body.folder = payload.folder;
  return await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/video/character-library`,
    { method: "POST", json: body },
  );
}

export async function fetchFreezoneAssetLibraryFolders(
  project: string,
): Promise<FreezoneAssetLibraryFolder[]> {
  return await apiCall<FreezoneAssetLibraryFolder[]>(
    `projects/${encodeURIComponent(project)}/freezone/video/asset-library/folders`,
  );
}

export async function createFreezoneAssetLibraryFolder(
  project: string,
  name: string,
): Promise<FreezoneAssetLibraryFolder> {
  return await apiCall<FreezoneAssetLibraryFolder>(
    `projects/${encodeURIComponent(project)}/freezone/video/asset-library/folders`,
    { method: "POST", json: { name } },
  );
}

/** Rename / change cover. Send only the fields to change; the other is kept as is. */
export async function updateFreezoneAssetLibraryFolder(
  project: string,
  folderId: string,
  patch: { name?: string; cover?: string },
): Promise<FreezoneAssetLibraryFolder> {
  return await apiCall<FreezoneAssetLibraryFolder>(
    `projects/${encodeURIComponent(project)}/freezone/video/asset-library/folders/${encodeURIComponent(folderId)}`,
    { method: "PATCH", json: patch },
  );
}

/** Empty the whole cabinet: delete the folder together with the assets inside. Returns the number of assets deleted. */
export async function deleteFreezoneAssetLibraryFolder(
  project: string,
  folderId: string,
): Promise<{ deleted_items: number }> {
  return await apiCall<{ deleted_items: number }>(
    `projects/${encodeURIComponent(project)}/freezone/video/asset-library/folders/${encodeURIComponent(folderId)}`,
    { method: "DELETE" },
  );
}

/**
 * Idempotently sync main-line character/scene/prop reference images and character voices into the asset library. The backend upserts by a stable composite id,
 * so repeated syncs only update, no duplicates. Returns the full library after sync (apiCall unwraps data).
 */
export async function syncFreezoneAssetLibraryFromMainline(
  project: string,
): Promise<FreezoneVideoCharacterLibraryItem[]> {
  return await apiCall<FreezoneVideoCharacterLibraryItem[]>(
    `projects/${encodeURIComponent(project)}/freezone/video/asset-library/sync-from-mainline`,
    { method: "POST" },
  );
}

export async function renameFreezoneVideoCharacterLibraryItem(
  project: string,
  itemId: string,
  name: string,
): Promise<FreezoneVideoCharacterLibraryItem> {
  return await apiCall<FreezoneVideoCharacterLibraryItem>(
    `projects/${encodeURIComponent(project)}/freezone/video/character-library/${encodeURIComponent(itemId)}`,
    { method: "PATCH", json: { name } },
  );
}

export async function deleteFreezoneVideoCharacterLibraryItem(
  project: string,
  itemId: string,
): Promise<unknown> {
  return await apiCall<unknown>(
    `projects/${encodeURIComponent(project)}/freezone/video/character-library/${encodeURIComponent(itemId)}`,
    { method: "DELETE" },
  );
}

// /freezone/init ---------------------------------------------------------- //

export async function initFreezone(project: string): Promise<{ freezone_dir: string }> {
  return await apiCall<{ freezone_dir: string }>(
    `projects/${encodeURIComponent(project)}/freezone/init`,
    { method: "POST" },
  );
}

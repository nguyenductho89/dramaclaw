"""API request/response Pydantic models."""

from decimal import Decimal

from typing import Annotated, Any, Literal, Optional

from fastapi import HTTPException
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, field_validator, model_validator

from novelvideo.models import SceneRef
from novelvideo.freezone.asset_copy import MAX_SOURCE_URL_LENGTH, MAX_SOURCES_PER_REQUEST
from novelvideo.freezone.slots import PushTarget

ProjectStatus = Literal["active", "archived", "deleted"]
ProjectStatusFilter = Literal["all", "active", "archived", "deleted", "visible"]
FREEZONE_DEFAULT_IMAGE_SELECTION = "newapi_gpt_image2"
FREEZONE_DEFAULT_IMAGE_MODEL = FREEZONE_DEFAULT_IMAGE_SELECTION
CANVAS_MAX_NODES = 50_000
CANVAS_MAX_EDGES = 200_000


# ── Common responses ──────────────────────────────────────────────────────────────────


class OkResponse(BaseModel):
    ok: bool = True
    data: Any = None


class TaskResponse(BaseModel):
    ok: bool = True
    task_id: str = ""
    task_type: str = ""
    message: str = ""


class ErrorResponse(BaseModel):
    ok: bool = False
    error: str = ""


# ── Projects ──────────────────────────────────────────────────────────────────────


class ProjectCreate(BaseModel):
    name: str = Field(max_length=64)


class ProjectSummary(BaseModel):
    id: str = ""
    name: str
    owner_type: str = "user"
    owner_id: str = ""
    owner_username: str = ""
    effective_role: str = ""
    home_node_id: str = ""
    status: ProjectStatus
    archived_at: Optional[str] = None
    deleted_at: Optional[str] = None
    purged_at: Optional[str] = None
    updated_at: Optional[str] = None
    episode_count: Optional[int] = None
    beat_count: Optional[int] = None


class ProjectGrantCreate(BaseModel):
    principal_type: Literal["user", "team"] = "user"
    principal_id: Optional[str] = None
    principal_username: Optional[str] = None
    role: Literal["viewer", "editor", "admin"]


class ProjectGrantUpdate(BaseModel):
    role: Literal["viewer", "editor", "admin"]


class ProjectGrantSummary(BaseModel):
    id: str
    project_id: str
    principal_type: str
    principal_id: str
    principal_username: Optional[str] = None
    role: str
    created_at: Optional[str] = None
    effective: bool = True
    inactive_reason: Literal["principal_access_changed"] | None = None


class ProjectUpdate(BaseModel):
    spine_template: Optional[Literal["drama", "narrated"]] = None
    aspect_ratio: Optional[Literal["2:3", "9:16", "16:9"]] = None
    visual_style: Optional[str] = None
    narration_style: Optional[str] = None
    ethnicity: Optional[str] = None
    rhythm: Optional[str] = None
    tts_provider: Optional[str] = None
    tts_model: Optional[str] = None
    tts_voice: Optional[str] = None
    grid_mode: Optional[str] = None
    grid_model: Optional[str] = None
    video_backend: Optional[str] = None
    use_director_render: Optional[bool] = None
    video_resolution: Optional[str] = None
    add_subtitles: Optional[bool] = None
    sketch_image_selection: Optional[str] = None
    render_image_selection: Optional[str] = None
    sketch_aspect_padding: Optional[bool] = None


class RenderSettingsUpdate(BaseModel):
    render_image_selection: Optional[str] = None
    sketch_aspect_padding: Optional[bool] = None


class SketchSettingsUpdate(BaseModel):
    sketch_image_selection: Optional[str] = None


class BeatBackgroundAnchorUpdate(BaseModel):
    anchor_id: str


# ── Import ──────────────────────────────────────────────────────────────────────


class IngestStart(BaseModel):
    filename: str
    rebuild: bool = False
    spine_template: Optional[Literal["drama", "narrated"]] = None


# ── Characters ──────────────────────────────────────────────────────────────────────


class PortraitGenRequest(BaseModel):
    style: Optional[str] = None
    ethnicity: str = "Chinese"
    model: Optional[str] = None


# ── Episodes ──────────────────────────────────────────────────────────────────────


class EpisodePlanRequest(BaseModel):
    target_episodes: int = 10
    planning_mode: str = "chapters"


# ── Script ──────────────────────────────────────────────────────────────────────


class ContentUpdateRequest(BaseModel):
    content: str


class RewriteGenerateRequest(BaseModel):
    target_beats: int = 18
    beat_chars_min: int = 14
    beat_chars_max: int = 20
    narration_style: Optional[str] = None


class ScriptGenerateRequest(BaseModel):
    pass


class BeatUpdate(BaseModel):
    narration_segment: Optional[str] = None
    visual_description: Optional[str] = None
    scene_ref: Optional[SceneRef] = None
    time_of_day: Optional[str] = None
    video_prompt: Optional[str] = None
    keyframe_prompt: Optional[str] = None
    video_mode: Optional[str] = None  # "first_frame" | "keyframe"
    seedance2_config_json: Optional[str] = None
    audio_type: Optional[str] = None  # "silence" | "narration" | "dialogue"
    speaker: Optional[str] = None  # Speaker identity ID (required for dialogue)
    detected_identities: Optional[list[str]] = None
    detected_props: Optional[list[str]] = None
    # MiniMax H3 Multishot grouping (2026-10-19) — see
    # `models.py`'s `NovelVisualBeat.multishot_chain_id`. "" clears it.
    multishot_chain_id: Optional[str] = None


class Seedance2PromptGenerateRequest(BaseModel):
    manual_prompt_reference: Optional[str] = None
    prompt_guidance: Optional[str] = None
    prompt_guidance_template_keys: Optional[list[str]] = None


class BeatVideoPromptGenerateRequest(BaseModel):
    language: str = "en"


class MiniMaxH3PromptGenerateRequest(BaseModel):
    # Optional override so the rewritten prompt's timestamps match whatever
    # duration the review dialog is currently showing (which may itself be
    # overriding the beat's natural `resolve_target_video_duration`) —
    # without it, this route and `/video/review` could silently disagree on
    # the beat's duration and the written prompt would describe a clip
    # longer or shorter than what actually gets submitted.
    duration: Optional[float] = None
    # Free-text director notes from the review dialog's prompt-guidance box
    # (the same field other video backends call `prompt_guidance`) — passed
    # through to `MiniMaxH3BeatContext.director_guidance`. Advisory only.
    prompt_guidance: Optional[str] = None


class MultishotVideoRequest(BaseModel):
    """Enqueue request for `POST .../multishot/{chain_id}/video` — see
    `generators/runpod_minimax_h3_multishot_video.py` and
    `runpod-h3-qwen-endpoints.md` section 5. `review_fingerprint` must match
    the `input_fingerprint` the matching `/multishot/{chain_id}/review` call
    just returned, same change-detection pattern as `SingleVideoRequest`."""

    review_fingerprint: Optional[str] = None


class SegmentPlanApplyRequest(BaseModel):
    """`POST .../segments/apply` body — the (possibly user-edited) output
    of `POST .../segments/plan`. Applying replaces every existing
    `multishot_chain_id` grouping for this episode with this set — see
    `agents/segment_planner.py` and `generators/segment_store.py`."""

    segments: list[dict] = Field(
        default_factory=list,
        description="[{chain_id, beat_numbers, shot_seconds, reason}], from /segments/plan",
    )


class SegmentFrameApproveRequest(BaseModel):
    frame_fingerprint: str = ""


class SegmentFramesGenerateRequest(BaseModel):
    image_generation_selection: Optional[str] = None
    force: bool = False
    # When given, restricts this call to just these segments (the UI's
    # per-segment "generate"/"regenerate this one" button) instead of
    # every segment in the episode.
    chain_ids: Optional[list[str]] = None


class SegmentVideoEntry(BaseModel):
    chain_id: str
    review_fingerprint: Optional[str] = None


class SegmentVideosGenerateRequest(BaseModel):
    """`POST .../segments/videos/generate` body — one or more approved
    segments to enqueue in one call. Each entry's `review_fingerprint`
    must match what `/segments/videos/review` just returned for that
    `chain_id`, same contract as `MultishotVideoRequest`."""

    segments: list[SegmentVideoEntry] = Field(default_factory=list)


class StagingSetDressingEntry(BaseModel):
    """One persistent/semi-persistent prop placement within a scene's
    staging bible — see `generators/staging_store.SetDressingItem`."""

    prop_id: str
    placement_note: str = ""
    persistent: bool = False
    from_beat: int = 0


class StagingSceneUpdate(BaseModel):
    """One scene's staging bible, as written by `PUT .../staging` (manual
    edit) or returned by `POST .../staging/plan` (AI-proposed) — see
    `generators/staging_store.SceneStaging`."""

    camera: str = ""
    blocking: dict[str, str] = Field(default_factory=dict)
    set_dressing: list[StagingSetDressingEntry] = Field(default_factory=list)
    scale_note: str = ""


class StagingUpdateRequest(BaseModel):
    """Body for `PUT .../episodes/{episode_num}/staging` — a full or
    partial hand edit of the episode's staging sidecar
    (`generators/staging_store.py`). Scenes not included are left
    unchanged; a scene included replaces that scene's entry wholesale."""

    scenes: dict[str, StagingSceneUpdate] = Field(default_factory=dict)


class QwenEditPrompts(BaseModel):
    """Prompt override for a render-review-capable RunPod render path —
    `runpod_qwen_edit_render` / `_multi` (Qwen-Image-Edit-2511) and, since
    2026-10-18, `runpod_qwen21_render` / `_multi` (Qwen-Image 2.1). Same
    shape covers both providers (see
    `generators/render_review_registry.py`'s `RenderReviewStrategy`) — see
    `render/review` and `generators/qwen_edit_prompt_store.py`."""

    full_prompt: str = ""
    scene_prompt: str = ""
    inpaint_prompts: dict[str, str] = Field(default_factory=dict)


class RenderReviewRequest(BaseModel):
    """Body for `POST .../beats/{b}/render/review` — a dry run, mirroring
    `SingleVideoRequest`'s review fields for `/video/review`. Only
    meaningful for render-review-capable selections (see
    `generators/render_review_registry.py`); other selections get
    `{"ok": true, "supported": false}` back."""

    image_generation_selection: Optional[str] = None
    qwen_edit_prompts: Optional[QwenEditPrompts] = None


class QwenEditPromptGenerateRequest(BaseModel):
    """Body for `POST .../beats/{b}/qwen-edit-prompt/generate` (AI
    rewrite) — dispatches by selection via
    `generators/render_review_registry.py`, not Edit-2511-specific despite
    the route name."""

    image_generation_selection: Optional[str] = None


class Seedance2AssetDeleteRequest(BaseModel):
    media_kind: Literal["images", "audios"]
    path: str


class Seedance2AssetCropRequest(BaseModel):
    asset_key: str
    source_path: str
    target: Literal["reference_image", "first_frame", "last_frame"] = "reference_image"
    x: float = 0
    y: float = 0
    width: float
    height: float


class Seedance2AssetAudioTrimRequest(BaseModel):
    asset_key: str
    source_path: str
    start_seconds: float = 0
    duration_seconds: float = 4


# ── Image pool selection ────────────────────────────────────────────────────────────────


class PoolSelectRequest(BaseModel):
    pool_id: str
    force: bool = False


class VideoPoolSelectRequest(BaseModel):
    pool_id: str


class GlobalOptimizeRequest(BaseModel):
    language: str = "en"  # "en" English (Gemini)


class VideoGenerateRequest(BaseModel):
    resolution: str = "720x1280"
    video_backend: str = "newapi_seedance-1.0-pro-fast"
    use_director_render: bool = False


class VideoBackendOption(BaseModel):
    value: str
    label: str
    is_default: bool = False
    is_seedance2: bool = False
    is_happyhorse: bool = False
    is_grok_video: bool = False
    is_runpod_h3: bool = False
    dialogue_only: bool = False
    min_duration: Optional[int] = None
    max_duration: Optional[int] = None
    resolution_options: Optional[list[str]] = None
    ratio_options: Optional[list[str]] = None
    supported_modes: Optional[list[str]] = None
    reference_image_max: Optional[int] = None
    reference_video_max: Optional[int] = None
    reference_audio_max: Optional[int] = None


class VideoComposeRequest(BaseModel):
    add_subtitles: bool = True
    add_bgm: bool = False
    resolution: str = "720x1280"


# ── TTS ───────────────────────────────────────────────────────────────────────


class TTSGenerateRequest(BaseModel):
    provider: Optional[str] = None
    voice: Optional[str] = None
    model: Optional[str] = None
    rate: Optional[str] = None
    mode: Optional[str] = None
    beat_numbers: Optional[list[int]] = None


class TTSPreviewRequest(BaseModel):
    text: str
    provider: Optional[str] = None
    voice: Optional[str] = None
    model: Optional[str] = None


# ── Sketch & first frame ──────────────────────────────────────────────────────────────


class SketchGenerateRequest(BaseModel):
    style: Optional[str] = None
    model: str = "nanobanana"
    grid_index: int = 0
    sketch_scene_grouping: bool = True
    aspect_ratio: Literal["2:3", "16:9"] = "2:3"
    image_generation_selection: Optional[str] = None


# ── Regeneration ──────────────────────────────────────────────────────────────────────


class GridRegenerateRequest(BaseModel):
    style: Optional[str] = None
    model: str = "nanobanana"
    scene_grouping: bool = False
    character_grouping: bool = False
    image_generation_selection: Optional[str] = None
    sketch_aspect_padding: Optional[bool] = None


class BeatsRegenerateRequest(BaseModel):
    beat_indices: list[int]
    style: Optional[str] = None
    model: str = "nanobanana"
    mode_key: str = "1x1_2-3"
    image_generation_selection: Optional[str] = None
    sketch_aspect_padding: Optional[bool] = None
    batch_id: Optional[str] = Field(default=None, max_length=100)
    batch_size: Optional[int] = Field(default=None, ge=1, le=9)
    # Review screen support (see `/render/review`): `review_fingerprint` is
    # echoed back from a prior review call so the route can detect the
    # sketch/references changed underneath the user (`input_stale`);
    # `qwen_edit_prompts`, when given, is a hand-edited/AI-rewritten
    # override for `runpod_qwen_edit*` selections, saved to the sidecar
    # store before this request is enqueued.
    review_fingerprint: Optional[str] = None
    qwen_edit_prompts: Optional[QwenEditPrompts] = None


class SketchRegenerateRequest(BaseModel):
    beat_indices: list[int]
    style: Optional[str] = None
    model: str = "nanobanana"
    mode_key: str = "1x1_2-3"
    image_generation_selection: Optional[str] = None


class SketchRegenQueueItem(BaseModel):
    id: str
    modeKey: str
    modeLabel: str
    beatNumbers: list[int] = Field(default_factory=list)
    sceneIds: list[str] = Field(default_factory=list)
    createdAt: str
    taskScope: Optional[str] = None


class SketchRegenQueueUpdate(BaseModel):
    items: list[SketchRegenQueueItem] = Field(default_factory=list)


class OperatorPasswordVerifyRequest(BaseModel):
    password: str = ""


class InsertManualShotRequest(BaseModel):
    # None means insert before the first beat. Otherwise insert after this beat_number.
    after_beat_number: Optional[int] = None
    visual_description: str
    duration_seconds: Optional[float] = None
    scene_ref: Optional[SceneRef] = None
    time_of_day: Optional[str] = None
    detected_identities: Optional[list[str]] = None
    detected_props: Optional[list[str]] = None
    audio_type: Literal["silence", "narration", "dialogue"] = "silence"
    speaker: Optional[str] = None
    narration_segment: Optional[str] = None


class SingleVideoRequest(BaseModel):
    resolution: str = "720x1280"
    video_backend: str = "newapi_seedance-1.0-pro-fast"
    use_director_render: bool = False
    seedance2_config_json: Optional[str] = None
    mode: Optional[str] = None
    duration: Optional[int] = None
    ratio: Optional[str] = None
    generate_audio: Optional[bool] = None
    return_last_frame: Optional[bool] = None
    human_review: Optional[bool] = None
    scene_optimize: Optional[str] = None
    final_prompt: Optional[str] = None
    audio_setting: Optional[str] = None
    prompt_guidance: Optional[str] = None
    text_overlay: Optional[dict[str, Any]] = None
    batch_id: Optional[str] = Field(default=None, max_length=100)
    batch_size: Optional[int] = Field(default=None, ge=1, le=9)
    # Review screen support (see `/video/review`): `review_fingerprint` is
    # echoed back from a prior review call so the route can detect the
    # inputs changed underneath the user (409 `input_stale`); the rest let
    # the review dialog override what the route would otherwise resolve
    # from the beat, for the `runpod_minimax_h3` backend.
    review_fingerprint: Optional[str] = None
    h3_profile: Optional[Literal["formal", "draft"]] = None
    h3_reference_keys: Optional[list[str]] = None
    # Per-generation override for `runpod_minimax_h3`'s env-gated two-stage
    # (upscale + redraw pass) / audio-refine passes — None means "use the
    # RUNPOD_H3_TWO_STAGE_ENABLED/RUNPOD_H3_AUDIO_REFINE_ENABLED .env
    # default" (see `generators/runpod_minimax_h3_video.py`'s `generate()`).
    two_stage: Optional[bool] = None
    audio_refine: Optional[bool] = None


# ── Style ──────────────────────────────────────────────────────────────────────


class StyleCreateRequest(BaseModel):
    id: str
    name: str
    label: str
    config: dict


# ── Episode editing ─────────────────────────────────────────────────────────────────


class EpisodeUpdate(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    title: Optional[str] = None
    content_summary: Optional[str] = Field(
        default=None,
        validation_alias=AliasChoices("summary", "content_summary"),
        serialization_alias="summary",
    )
    character_names: Optional[list[str]] = None
    key_events: Optional[list[str]] = None
    cliffhanger: Optional[str] = None
    identity_ids: Optional[list[str]] = None
    beat_source_text: Optional[str] = None
    identity_default_map: Optional[dict[str, str]] = None


# ── Character editing ─────────────────────────────────────────────────────────────────


class CharacterCreate(BaseModel):
    name: str
    role: str = ""
    is_main: bool = False
    gender: str = ""
    age_group: str = "youth"
    description: str = ""
    face_prompt: str = ""


# ── Freezone ─────────────────────────────────────────────────────────────────


class FreezoneImageCameraConfig(BaseModel):
    """Image node camera parameters."""

    camera_body: str = Field(default="", description="Camera body, e.g. Panavision DXL2")
    lens: str = Field(default="", description="Lens model, e.g. Arri Signature Prime")
    focal_length_mm: Optional[int] = Field(
        default=None,
        description="Focal length in mm, e.g. 35",
    )
    aperture: str = Field(default="", description="Aperture, e.g. f/4")


class FreezoneImageStyleConfig(BaseModel):
    """Image node style template parameters."""

    template_id: str = Field(description="Style template id")


class FreezoneWorkflowMediaLink(BaseModel):
    canvas_id: str = Field(default="", max_length=200)
    node_id: str = Field(default="", max_length=200)
    product_operation_id: str = Field(default="", max_length=128)
    generation_attempt_id: str = Field(default="", max_length=256)


class FreezoneGenRequest(FreezoneWorkflowMediaLink):
    prompt: str
    aspect_ratio: str = "1:1"
    image_size: str = "2K"
    reference_urls: list[str] = Field(default_factory=list)
    canvas_id: str = Field(
        default="",
        description="Optional source canvas id. Used by the backend to record generation history per node; when empty, no node history is recorded.",
    )
    node_id: str = Field(
        default="",
        description="Optional source node id. Used by the backend to record generation history per node; when empty, no node history is recorded.",
    )
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="Optional camera parameters, used to inject body / lens / focal length / aperture into the image prompt",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="Optional style template parameters, used to inject a built-in style template into the image prompt",
    )
    provider: Optional[str] = None
    model: Optional[str] = None
    quality: Optional[str] = Field(default="medium", description="Image quality tier, default medium")
    model_id: Optional[str] = Field(
        default=None, description="Optional: registry model id, used to backfill model when restoring the node"
    )
    gen_mode: Optional[str] = Field(default=None, description="Optional: generation mode, used to backfill genMode when restoring the node")
    model_params: dict[str, Any] = Field(default_factory=dict)


class FreezoneEditRequest(BaseModel):
    prompt: str
    base_url: str
    extra_reference_urls: list[str] = Field(default_factory=list)
    aspect_ratio: str = "2:3"
    image_size: str = "2K"
    canvas_id: str = Field(
        default="",
        description="Optional source canvas id. Used by the backend to record generation history per node; when empty, no node history is recorded.",
    )
    node_id: str = Field(
        default="",
        description="Optional source node id. Used by the backend to record generation history per node; when empty, no node history is recorded.",
    )
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="Optional camera parameters, used to inject body / lens / focal length / aperture into the image prompt",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="Optional style template parameters, used to inject a built-in style template into the image prompt",
    )
    provider: Optional[str] = None
    model: Optional[str] = None
    quality: Optional[str] = Field(default="medium", description="Image quality tier, default medium")
    model_id: Optional[str] = Field(
        default=None, description="Optional: registry model id, used to backfill model when restoring the node"
    )
    gen_mode: Optional[str] = Field(default=None, description="Optional: generation mode, used to backfill genMode when restoring the node")
    model_params: dict[str, Any] = Field(
        default_factory=dict,
        description=(
            "Dynamic parameter values declared by the media model catalog. Same semantics as /freezone/gen -- "
            "image edits with reference images go through this route, and without this field the catalog parameters have no effect on the image-edit side"
        ),
    )


class FreezoneSketchFromContextRequest(BaseModel):
    episode: int
    beat: int
    aspect_ratio: Literal["2:3", "16:9"] = "2:3"
    source_kind: Literal[
        "beat",
        "selected_background",
        "director_combined",
        "background_candidate",
    ] = "beat"
    source_url: Optional[str] = None
    canvas_id: str = Field(default="")
    node_id: str = Field(default="")
    provider: Optional[str] = None
    model: Optional[str] = None
    quality: Optional[str] = Field(default="medium", description="Image quality tier, default medium")


class FreezoneFrameFromContextRequest(BaseModel):
    episode: int
    beat: int
    aspect_ratio: Literal["2:3", "16:9"] = "2:3"
    sketch_url: str
    background_url: Optional[str] = None
    identity_urls: list[str] = Field(default_factory=list)
    prop_urls: list[str] = Field(default_factory=list)
    canvas_id: str = Field(default="")
    node_id: str = Field(default="")
    provider: Optional[str] = None
    model: Optional[str] = None
    quality: Literal["low", "medium", "high"] = Field(
        default="medium",
        description="Image quality tier, default medium",
    )


class FreezoneScene360Request(BaseModel):
    """Scene 360 panorama generation request.

    Only one scene source image, `master.png`, is accepted as reference input.
    """

    reference_url: str = Field(
        description="Static URL of the scene source image, usually pointing to assets/scenes/<scene_id>/master.png"
    )
    reverse_reference_url: Optional[str] = Field(
        default=None,
        description=("Optional static URL of the reverse scene source image, usually pointing to assets/scenes/<scene_id>/reverse.png"),
    )
    canvas_id: str = Field(default="")
    node_id: str = Field(default="")
    image_size: str = Field(default="2K", description="Output resolution tier, default 2K")
    mode: Literal["candidate", "commit"] = Field(
        default="candidate",
        description="candidate only generates a canvas candidate; commit explicitly writes back to the main 360 slot",
    )
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"Image model name, default {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    catalog_id: str = Field(
        default="",
        description="Media model catalog entry id. Must be sent along when the frontend quotes by catalog entry, otherwise billing differs from the quote",
    )
    quality: Optional[str] = Field(default="medium", description="Image quality tier, default medium")


class FreezoneImageTo3GSRequest(BaseModel):
    """Start SHARP from a Freezone image node to generate a compressed 3GS SOG."""

    source_url: str = Field(description="Static URL of the source image, usually from a Freezone image node")
    source_kind: Literal["master", "reverse", "pano"] = Field(
        default="master",
        description=("3GS source type; master/reverse generate a single-sided SOG, pano uses 360 panorama generation to produce a pano SOG"),
    )
    canvas_id: str = Field(default="", description="Optional: source canvas id, used to record node generation history")
    node_id: str = Field(default="", description="Optional: source node id, used to record node generation history")


class FreezoneThreeDViewerScreenshotRequest(BaseModel):
    """Save a regular screenshot from the Freezone built-in 3D viewer."""

    data_url: str = Field(description="data URL obtained from canvas.toDataURL('image/png')")
    node_id: Optional[str] = Field(default=None, description="Source 3D world node id")
    label: Optional[str] = Field(default=None, description="Optional display name")


class FreezoneAssetCopyRequest(BaseModel):
    """Cross-project paste: copy assets from another project into the current project."""

    sources: list[Annotated[str, Field(max_length=MAX_SOURCE_URL_LENGTH)]] = Field(
        min_length=1,
        max_length=MAX_SOURCES_PER_REQUEST,
        description=(
            "List of same-origin URLs of the source assets (`/static/projects/<pid>/...` or "
            "`/api/v1/projects/<pid>/media/...`); query strings are fine, and the mapping is returned keyed by the original string"
        ),
    )


class ViewerBeatContextManifest(BaseModel):
    episode: int
    beat: int
    visual_description: Optional[str] = None
    detected_identities: list[str] = Field(default_factory=list)
    detected_props: list[str] = Field(default_factory=list)


class PanoViewerSource(BaseModel):
    slot_kind: Literal["scene_director_pano_360", "scene_360_candidate"] = "scene_director_pano_360"
    url: str
    fs: Optional[str] = None


class PanoSphereCorrection(BaseModel):
    roll: float = 0.0
    pitch: float = 0.0
    yaw: float = 0.0


class PanoViewerCorrection(BaseModel):
    front_yaw_deg: float = 0.0
    sphere_correction_deg: PanoSphereCorrection = Field(default_factory=PanoSphereCorrection)


class PanoViewerManifest(BaseModel):
    viewer_kind: Literal["pano360"] = "pano360"
    mode: Literal["scene", "beat"]
    project: str
    scene_id: str
    display_name: str
    source: PanoViewerSource
    correction: PanoViewerCorrection = Field(default_factory=PanoViewerCorrection)
    beat_context: Optional[ViewerBeatContextManifest] = None
    allowed_destinations: list[
        Literal["view", "download", "canvas_screenshot_node", "beat_selected_background"]
    ] = Field(default_factory=list)


class DirectorStageSource(BaseModel):
    source_type: Literal["sog", "pano360"] = "sog"
    ply_url: str
    splat_url: str
    splat_format: Literal["ply", "sog", "splat", "ksplat", "unknown"] = "unknown"
    pano_url: Optional[str] = None
    slot_kind: Optional[Literal["scene_director_pano_360", "scene_360_candidate"]] = None
    collision_glb_url: Optional[str] = None
    source_kind: Literal["master", "reverse", "pano", "uploaded", "custom"] = "custom"


class DirectorStageSourceOption(BaseModel):
    kind: Literal["active", "master", "reverse", "pano", "uploaded", "custom"]
    label: str
    source_type: Literal["sog", "pano360"] = "sog"
    ply_url: Optional[str] = None
    splat_url: Optional[str] = None
    splat_format: Literal["ply", "sog", "splat", "ksplat", "unknown"] = "unknown"
    pano_url: Optional[str] = None
    slot_kind: Optional[Literal["scene_director_pano_360", "scene_360_candidate"]] = None
    fs: Optional[str] = None
    current: bool = False


class DirectorPaletteActor(BaseModel):
    identity_id: str
    label: str
    color: str


class DirectorPaletteProp(BaseModel):
    prop_id: str
    label: str
    color: str


class DirectorStagePalette(BaseModel):
    actors: list[DirectorPaletteActor] = Field(default_factory=list)
    props: list[DirectorPaletteProp] = Field(default_factory=list)
    anonymous_colors: list[str] = Field(default_factory=list)
    anonymous_prop_colors: list[str] = Field(default_factory=list)


class DirectorStageManifest(BaseModel):
    viewer_kind: Literal["three_d_director"] = "three_d_director"
    mode: Literal["scene", "beat"]
    project: str
    scene_id: str
    display_name: str
    active_source_id: Optional[str] = None
    scene: Optional[dict[str, Any]] = None
    scenes_by_source_id: dict[str, dict[str, Any]] = Field(default_factory=dict)
    source: DirectorStageSource
    source_options: list[DirectorStageSourceOption] = Field(default_factory=list)
    source_orientation_mode: Literal["supersplat_auto", "identity", "lcc_legacy", "flip_z"] = (
        "supersplat_auto"
    )
    blockings_dir_fs: Optional[str] = None
    control_frames_dir_fs: Optional[str] = None
    slate_beat: Optional[int] = None
    beat_context: Optional[ViewerBeatContextManifest] = None
    palette: DirectorStagePalette = Field(default_factory=DirectorStagePalette)
    allowed_destinations: list[
        Literal[
            "view",
            "download",
            "canvas_screenshot_node",
            "beat_director_combined",
            "beat_director_env_only",
            "beat_selected_background",
        ]
    ] = Field(default_factory=list)


class FreezoneCharacterMultiViewRequest(BaseModel):
    """Multi-angle editor request.

    Repositions the camera or reconstructs the viewpoint from a single source image and outputs one result image.
    """

    source_url: str = Field(description="Static URL of the source image, used as the base image for image-to-image")
    preset: Literal[
        "custom",
        "fisheye",
        "oblique",
        "front",
        "front_up",
        "full_body",
        "back",
    ] = Field(default="custom", description="Viewpoint preset. custom means fully customized by yaw/pitch")
    yaw_degrees: float = Field(
        default=0.0, description="Horizontal rotation angle in degrees; the sign convention is defined by the frontend"
    )
    pitch_degrees: float = Field(
        default=0.0, description="Vertical pitch angle in degrees; the sign convention is defined by the frontend"
    )
    shot_size: Literal[
        "extreme_close_up",
        "close_up",
        "medium_close",
        "medium",
        "full_body",
        "wide",
        "extreme_wide",
    ] = Field(
        default="medium",
        description="Shot size tier: extreme close-up / close-up / medium close-up / medium / full body / long / extreme long",
    )
    prompt: str = Field(default="", description="Additional user prompt, may be empty")
    image_size: str = Field(default="2K", description="Output resolution tier, default 2K")
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="Optional camera parameters, used to supplement shot language and camera specifications",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="Optional style template parameters, used to inject a built-in style template into the image prompt",
    )
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"Image model name, default {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    quality: Optional[str] = Field(default="medium", description="Image quality tier, default medium")


class FreezoneTemplateEditRequest(BaseModel):
    """Unified request for the grid dropdown capabilities.

    All of them are fundamentally based on a single source image, with different prompt templates layered on top and sent through the same image-edit pipeline.
    """

    source_url: str = Field(description="Static URL of the source image, used as the base image for image-to-image")
    mode: Literal[
        "multi_camera_nine_grid",
        "story_pitch_four_grid",
        "character_face_three_view",
        "product_three_view",
        "storyboard_25_grid",
        "cinematic_light_correction",
        "character_three_view_generation",
        "scene_setting_sheet",
        "image_projection_after_3s",
        "image_projection_before_5s",
    ] = Field(
        description=(
            "Template mode. Corresponds to: multi-camera nine-grid / plot-progression four-grid / character face three-view / "
            "product three-view / 25-grid continuous storyboard / cinematic lighting correction / character three-view generation / "
            "scene concept image / frame projection 3 seconds later / frame projection 5 seconds earlier"
        )
    )
    prompt: str = Field(default="", description="Additional user prompt, may be empty")
    image_size: str = Field(default="2K", description="Output resolution tier, default 2K")
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="Optional camera parameters, used to supplement shot language and camera specifications",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="Optional style template parameters, used to inject a built-in style template into the image prompt",
    )
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"Image model name, default {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    catalog_id: str = Field(
        default="",
        description="Media model catalog entry id. Must be sent along when the frontend quotes by catalog entry, otherwise billing differs from the quote",
    )
    quality: Optional[str] = Field(default="medium", description="Image quality tier, default medium")


class FreezoneExtractFramesRequest(BaseModel):
    video_url: str
    max_frames: int = 20
    scene_threshold: float = 0.3


class FreezoneAnalyzeShotsRequest(BaseModel):
    frame_urls: list[str]
    provider: Optional[str] = None
    model: Optional[str] = None
    analysis_mode: Literal["shots", "video_story"] = "shots"
    duration_sec: Optional[float] = None


class FreezoneAnalyzeVideoStoryRequest(BaseModel):
    video_url: str = Field(
        description=("Static video URL. Must be an existing /static/... video URL under the current project"),
        examples=["/static/admin/58/freezone/_uploads/example.mp4"],
    )
    max_frames: int = Field(
        default=20,
        ge=3,
        le=50,
        description=("Maximum number of keyframes to extract. Recommended 12-20; " "more frames give finer analysis but cost more time and tokens"),
    )
    scene_threshold: float = Field(
        default=0.3,
        ge=0.0,
        le=1.0,
        description=(
            "ffmpeg scene-change threshold, range 0-1. The lower it is, the easier it is to extract frames; "
            "0.2-0.3 is recommended for long takes / narrative films, 0.4-0.5 for fast-cut videos"
        ),
    )
    duration_sec: Optional[float] = Field(
        default=None,
        gt=0,
        description=(
            "Total video duration in seconds. Optional; " "when provided, the start_time/end_time of the video story table are more accurate"
        ),
        examples=[15],
    )


class FreezoneUpscaleRequest(BaseModel):
    """Upscale request.

    Uses an image model + prompt to upscale and restore.
    """

    source_url: str = Field(description="Static URL of the source image to upscale")
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"Image model name, default {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    quality: Optional[str] = Field(default="medium", description="Image quality tier, default medium")
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="Optional camera parameters, used to supplement shot language and camera specifications",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="Optional style template parameters, used to inject a built-in style template into the image prompt",
    )
    scale_factor: Literal[2, 4, 6] = Field(
        default=2,
        description="Upscale factor, one of 2 / 4 / 6",
    )
    image_size: str = Field(default="2K", description="Output resolution tier, default 2K")


class FreezoneOutpaintRequest(BaseModel):
    """Outpainting request.

    Extends a single source image outward while preserving the central subject and the original composition.
    """

    source_url: str = Field(description="Static URL of the source image to outpaint, used as the base image for image-to-image")
    target_aspect_ratio: Literal["original", "1:1", "4:3", "3:4", "16:9", "9:16"] = Field(
        default="original",
        description="Target ratio. original keeps the original ratio, other values extend to the given ratio",
    )
    num_images: int = Field(
        default=1,
        ge=1,
        le=4,
        description="Target number of generated images. The backend currently supports only 1 per task; the field is reserved for frontend protocol alignment",
    )
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="Optional camera parameters, used to supplement shot language and camera specifications",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="Optional style template parameters, used to inject a built-in style template into the image prompt",
    )
    image_size: str = Field(default="2K", description="Output resolution tier, default 2K")
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"Image model name, default {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    quality: Optional[str] = Field(default="medium", description="Image quality tier, default medium")


class FreezoneRedrawRequest(BaseModel):
    """Inpainting request.

    Handles both whole-image repainting and local erasing:
    - No mask_url: free repainting of the whole image / a region
    - With mask_url: local edit per the prompt only inside the marked edit area. The mask convention is
      "source image + semi-transparent red highlight on the painted area" (red only marks the area and does not enter the result)
    """

    source_url: str = Field(description="Static URL of the source image to repaint, used as the base image for image-to-image")
    mask_url: Optional[str] = Field(
        default=None,
        description=(
            "Optional static URL of the mask image. When provided, local erase / local repaint mode is used; the convention is "
            "'source image + semi-transparent red highlight on the painted area', and only the red area is edited"
        ),
    )
    aspect_ratio: Literal["original", "1:1", "4:3", "3:4", "16:9", "9:16"] = Field(
        default="original",
        description="Target ratio. original keeps the original ratio, other values repaint at the given ratio",
    )
    num_images: int = Field(
        default=1,
        ge=1,
        le=4,
        description="Target number of generated images. The backend currently supports only 1 per task; the field is reserved for frontend protocol alignment",
    )
    prompt: str = Field(default="", description="Repainting requirements or additional prompt")
    camera: Optional[FreezoneImageCameraConfig] = Field(
        default=None,
        description="Optional camera parameters, used to supplement shot language and camera specifications",
    )
    style: Optional[FreezoneImageStyleConfig] = Field(
        default=None,
        description="Optional style template parameters, used to inject a built-in style template into the image prompt",
    )
    image_size: str = Field(default="2K", description="Output resolution tier, default 2K")
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"Image model name, default {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    quality: Optional[str] = Field(default="medium", description="Image quality tier, default medium")


class FreezoneRelightRequest(BaseModel):
    """Lighting reference image edit request.

    Reshapes the lighting atmosphere of the current frame based on a source image and a lighting reference image.
    """

    source_url: str = Field(description="Static URL of the source image to relight, used as the base image for image-to-image")
    lighting_reference_url: Optional[str] = Field(
        default=None,
        description="Static URL of the lighting reference image, providing lighting direction, intensity, and atmosphere reference",
    )
    scope: Literal["global", "local"] = Field(
        default="global",
        description="Lighting scope: global means whole-image lighting, local means local lighting",
    )
    smart_mode: bool = Field(default=True, description="Whether to enable smart mode")
    brightness: int = Field(default=50, ge=0, le=100, description="Brightness intensity, 0-100")
    color_hex: str = Field(
        default="#ffffff",
        description="Hex color value controlling the key light color or overall tone, e.g. #ffffff",
    )
    color_temperature_kelvin: Optional[int] = Field(
        default=None,
        ge=1500,
        le=12000,
        description="Key light color temperature in Kelvin, for a draggable color-temperature axis",
    )
    key_light_direction: Literal["left", "top", "right", "front", "bottom", "back"] = Field(
        default="front",
        description="Key light direction",
    )
    rim_light: bool = Field(default=False, description="Whether to add rim light")
    prompt: str = Field(default="", description="Additional user prompt, may be empty")
    image_size: str = Field(default="2K", description="Output resolution tier, default 2K")
    model: str = Field(
        default=FREEZONE_DEFAULT_IMAGE_MODEL,
        description=f"Image model name, default {FREEZONE_DEFAULT_IMAGE_MODEL}",
    )
    quality: Optional[str] = Field(default="medium", description="Image quality tier, default medium")


class FreezoneVideoCharacterLibraryItemRequest(BaseModel):
    """Video node asset library entry request.

    Assets are first uploaded through the generic upload, then the static URLs are registered in the asset library. Images use image_urls,
    video/audio use the corresponding single-URL fields.
    """

    name: str = Field(description="Asset name, shown in the frontend asset library")
    media: Literal["image", "video", "audio"] = Field(
        default="image",
        description="Asset type: image / video / audio",
    )
    image_urls: list[str] = Field(
        default_factory=list,
        description="List of static URLs of reference images (at least one when media=image)",
    )
    video_url: str | None = Field(
        default=None,
        description="Static video URL (required when media=video)",
    )
    audio_url: str | None = Field(
        default=None,
        description="Static audio URL (required when media=audio)",
    )
    category: Literal["other", "character", "scene", "prop", "style", "audio"] | None = Field(
        default=None,
        description="Usage category (other/character/scene/prop/style/audio); when omitted, the backend infers a fallback from source/media",
    )
    folder: str | None = Field(
        default=None,
        description=(
            "Save location: system folder key (same names as the categories other/character/scene/prop/style/audio,"
            "i.e. other/character/scene/prop/style/audio) or a user-created folder id;"
            "when omitted, the asset lands in the system folder of the same name as its category"
        ),
    )


class FreezoneAssetLibraryItemPatchRequest(BaseModel):
    """Edit an asset library entry. Only renaming is supported for now -- URL / category / save location are not this route's responsibility."""

    name: str = Field(description="New asset name, at most 60 characters")


class FreezoneAssetLibraryFolderRequest(BaseModel):
    """Create asset library folder request. A folder only governs save location and is independent of the asset's category label."""

    name: str = Field(description="Folder name, at most 20 characters, must not duplicate a system folder name")


class FreezoneAssetLibraryFolderPatchRequest(BaseModel):
    """Edit a folder. Both fields are optional; only the supplied one is changed."""

    name: str | None = Field(default=None, description="New name; omit to keep the current name")
    cover: str | None = Field(
        default=None,
        description="Cover image URL, taken from an asset inside this folder; pass an empty string to clear the cover",
    )


class FreezoneVideoGenRequest(FreezoneWorkflowMediaLink):
    """Text-to-video request.

    Camera movement is controlled through the template library and the additional prompt; the character library references uploaded character reference images via `character_ids`.
    """

    prompt: str = Field(description="User-provided video content description")
    camera_template_id: Optional[str] = Field(
        default=None,
        description="Camera-move template id, e.g. locked_off / follow_tracking / orbit_up",
    )
    character_ids: list[str] = Field(
        default_factory=list,
        description="List of video character library entry ids, used to append character reference images",
    )
    marks: list["FreezoneVideoMark"] = Field(
        default_factory=list,
        description="List of local element marks. Regions of subjects/objects selected by clicking the image in the frontend; not ordinary tags",
    )
    aspect_ratio: str = Field(
        default="16:9",
        description="Video aspect ratio; auto currently falls back to 16:9",
    )
    resolution: str = Field(
        default="720p",
        description="Output resolution tier",
    )
    duration_seconds: int = Field(
        default=5,
        ge=1,
        description="Video duration, at least 1 second; the supported range may differ between models",
    )
    generate_audio: bool = Field(default=False, description="Whether to generate native audio")
    human_review: bool = Field(
        default=False,
        description="Whether to enable the HuiMeng real-person asset review / allowlisting flow, for assets that may contain real human faces",
    )
    scene_optimize: Optional[Literal["anime", "realistic"]] = Field(
        default=None,
        description="Scene style optimization parameters for the Seedance 2.0 Value series",
    )
    model: str = Field(
        default="newapi_seedance-2.0-fast",
        description="Video model name. Pass one of the values returned by `/api/v1/projects/{project}/freezone/video/models`.",
    )
    canvas_id: str = Field(default="", description="Optional: source canvas id, used to record node generation history")
    node_id: str = Field(default="", description="Optional: source node id, used to record node generation history")
    gen_mode: Literal["textToVideo"] = Field(
        default="textToVideo",
        description="Fixed business mode of the text-to-video entry",
    )
    model_params: dict[str, Any] = Field(default_factory=dict)


class FreezoneImageToVideoRequest(FreezoneWorkflowMediaLink):
    """Image-reference video request.

    Handles both image-to-video and image-reference video:
    - Image-to-video: 1 image serves as an overall visual reference and does not lock the first frame
    - 2-9 images: multi-image reference video
    """

    image_urls: list[str] = Field(
        default_factory=list,
        description="List of static URLs of reference images. Image-to-video allows only 1; image-reference mode accepts multiple up to the model limit",
    )
    prompt: str = Field(default="", description="Additional user video description, may be empty")
    camera_template_id: Optional[str] = Field(
        default=None,
        description="Camera-move template id, e.g. locked_off / follow_tracking / pedestal_up",
    )
    marks: list["FreezoneVideoMark"] = Field(
        default_factory=list,
        description="List of local element marks. Regions of subjects/objects selected by clicking the image in the frontend; not ordinary tags",
    )
    aspect_ratio: str = Field(
        default="16:9",
        description="Video aspect ratio; auto currently falls back to 16:9",
    )
    resolution: str = Field(
        default="720p",
        description="Output resolution tier",
    )
    duration_seconds: int = Field(
        default=5,
        ge=1,
        description="Video duration, at least 1 second; the supported range may differ between models",
    )
    generate_audio: bool = Field(default=False, description="Whether to generate native audio")
    human_review: bool = Field(
        default=False,
        description="Whether to enable the HuiMeng real-person asset review / allowlisting flow, for assets that may contain real human faces",
    )
    scene_optimize: Optional[Literal["anime", "realistic"]] = Field(
        default=None,
        description="Scene style optimization parameters for the Seedance 2.0 Value series",
    )
    model: str = Field(
        default="newapi_seedance-2.0-fast",
        description="Video model or model option id. Pass one of the values returned by /freezone/video/models",
    )
    canvas_id: str = Field(default="", description="Optional: source canvas id, used to record node generation history")
    node_id: str = Field(default="", description="Optional: source node id, used to record node generation history")
    gen_mode: Literal["imageToVideo", "imageReference"] = Field(
        description=(
            "Required: imageToVideo means a single overall image reference; imageReference means accepting image references up to the catalog limit."
            "Both use the image_reference protocol at execution time and do not represent a first frame."
        )
    )
    model_params: dict[str, Any] = Field(default_factory=dict)


class FreezoneKeyframeVideoRequest(FreezoneWorkflowMediaLink):
    """Keyframe video request.

    Accepts first frame only, first frame + last frame, or last frame only; at least one slot must be provided.
    """

    first_frame_url: Optional[str] = Field(
        default=None,
        description="Static URL of the first-frame reference image, may be empty; at least one of first and last frame is required",
    )
    last_frame_url: Optional[str] = Field(
        default=None,
        description="Static URL of the last-frame reference image, may be empty; at least one of first and last frame is required",
    )
    prompt: str = Field(default="", description="Additional user video description, may be empty")
    camera_template_id: Optional[str] = Field(
        default=None,
        description="Camera-move template id, e.g. locked_off / follow_tracking / pedestal_up",
    )
    marks: list["FreezoneVideoMark"] = Field(
        default_factory=list,
        description="List of local element marks. Regions of subjects/objects selected by clicking the image in the frontend; not ordinary tags",
    )
    aspect_ratio: str = Field(
        default="auto",
        description="Keyframe mode is fixed to auto; the output ratio follows the first or last frame",
    )
    resolution: str = Field(
        default="720p",
        description="Output resolution tier",
    )
    duration_seconds: int = Field(
        default=5,
        ge=1,
        description="Video duration, at least 1 second; the supported range may differ between models",
    )
    generate_audio: bool = Field(default=False, description="Whether to generate native audio")
    human_review: bool = Field(
        default=False,
        description="Whether to enable the HuiMeng real-person asset review / allowlisting flow, for assets that may contain real human faces",
    )
    scene_optimize: Optional[Literal["anime", "realistic"]] = Field(
        default=None,
        description="Scene style optimization parameters for the Seedance 2.0 Value series",
    )
    model: str = Field(
        default="newapi_seedance-2.0-fast",
        description="Video model or model option id. Pass one of the values returned by /freezone/video/models",
    )
    canvas_id: str = Field(default="", description="Optional: source canvas id, used to record node generation history")
    node_id: str = Field(default="", description="Optional: source node id, used to record node generation history")
    gen_mode: Literal["firstFrame", "firstLastFrame"] = Field(
        description="Required: first-frame or first+last-frame business mode; cannot be inferred from the number of frames actually uploaded",
    )
    model_params: dict[str, Any] = Field(default_factory=dict)


class FreezoneVideoEditRequest(FreezoneWorkflowMediaLink):
    """Video edit request.

    Takes 1 source video and, per the media model catalog configuration, accepts reference images and standalone reference audio.
    """

    video_url: str = Field(description="Static URL of the source video, required")
    image_urls: list[str] = Field(
        default_factory=list,
        description="List of static URLs of reference images; the maximum count is set by the media model catalog",
    )
    audio_urls: list[str] = Field(
        default_factory=list,
        description="List of static URLs of standalone reference audio; count and duration limits are set by the media model catalog",
    )
    prompt: str = Field(default="", description="User edit instruction / video description, may be empty")
    camera_template_id: Optional[str] = Field(
        default=None,
        description="Camera-move template id, e.g. locked_off / follow_tracking / pedestal_up",
    )
    marks: list["FreezoneVideoMark"] = Field(
        default_factory=list,
        description="List of local element marks",
    )
    resolution: str = Field(
        default="720p",
        description="Output resolution tier",
    )
    audio_setting: Literal["auto", "origin"] = Field(
        default="auto",
        description="Video edit audio strategy: auto / origin (keep original audio)",
    )
    generate_audio: bool = Field(default=False, description="Whether to generate native audio")
    human_review: bool = Field(
        default=False,
        description="Whether to enable the real-person asset review / allowlisting flow",
    )
    model: str = Field(
        default="newapi_happyhorse-1.0",
        description="Video model or model option id. Pass one of the values returned by /freezone/video/models",
    )
    canvas_id: str = Field(default="", description="Optional: source canvas id, used to record node generation history")
    node_id: str = Field(default="", description="Optional: source node id, used to record node generation history")
    gen_mode: Literal["videoEdit"] = Field(
        default="videoEdit",
        description="Fixed business mode of the video edit entry",
    )
    model_params: dict[str, Any] = Field(default_factory=dict)


class FreezoneMultishotShot(BaseModel):
    """One shot's raw, user-authored visual description — before any AI
    rewriting. `id` is a client-generated id, echoed back in the review
    response so the frontend can line up prompts/lint per row without
    relying on array order alone."""

    id: str = Field(default="", max_length=64)
    description: str = Field(min_length=1, max_length=2000)


class FreezoneMultishotReferenceImage(BaseModel):
    """One canvas-connected shared reference image. `kind` mirrors
    `MiniMaxH3Reference.kind` (agents/minimax_h3_prompt_builder.py) minus
    "first_frame"/"voice" (not applicable to a shared reference)."""

    url: str = Field(min_length=1, max_length=2048)
    name: str = Field(default="", max_length=80)
    kind: Literal["character", "scene", "prop"] = "character"


class FreezoneVideoMultishotReviewRequest(FreezoneWorkflowMediaLink):
    """MiniMax H3 Multishot (long continuous video) dry-run review.

    No enqueue, no RunPod call — but DOES call the H3 prompt rewriter LLM
    once per shot, so it is cheap but not free (see the route docstring).
    Shared references come from BOTH canvas-connected image nodes
    (`reference_images`) and the Character Library (`character_ids`),
    unioned and capped at `MULTISHOT_MAX_UNION_REFERENCES` by
    `freezone.multishot.resolve_shared_references`.
    """

    model: str = Field(
        default="runpod_minimax_h3_multishot",
        description="Must be the Freezone MiniMax H3 Multishot backend id, from /freezone/video/models",
    )
    gen_mode: Literal["multishot"] = Field(default="multishot")
    start_image_url: str = Field(
        min_length=1, max_length=2048, description="Static URL of the chain's single start frame (shot 1 only)"
    )
    reference_images: list[FreezoneMultishotReferenceImage] = Field(
        default_factory=list,
        max_length=3,
        description="Canvas-connected shared reference images (identity/scene/prop)",
    )
    character_ids: list[str] = Field(
        default_factory=list,
        max_length=3,
        description="Video character library entry ids, used as additional shared reference images",
    )
    shots: list[FreezoneMultishotShot] = Field(
        min_length=2,
        max_length=8,
        description=(
            "Ordered shot list, 2-8 entries (8 is the ComfyUI graph's structural bound; the real "
            "enforced cap is RUNPOD_H3_MULTISHOT_MAX_SHOTS, read at request time — a single-shot "
            "chain is pointless, use the plain MiniMax H3 1-shot mode instead)"
        ),
    )
    director_guidance: str = Field(
        default="", max_length=2000, description="Optional overall direction applied to every shot (style/mood notes)"
    )
    camera_template_id: Optional[str] = Field(default=None, description="Camera-move template id")
    aspect_ratio: Literal["16:9", "9:16"] = Field(default="9:16")
    shot_duration_seconds: int = Field(
        default=6, ge=5, le=12, description="Seconds per shot before snapping to H3's frame grid; applies to every shot"
    )
    canvas_id: str = Field(default="", description="Optional: source canvas id, used to record node generation history")
    node_id: str = Field(default="", description="Optional: source node id, used to record node generation history")
    model_params: dict[str, Any] = Field(default_factory=dict)


class FreezoneMultishotShotPrompt(BaseModel):
    """One shot's AI-rewritten (or hand-edited) final H3 prompt, as
    returned by the review route and sent back to the enqueue route."""

    id: str = Field(default="", max_length=64)
    final_prompt: str = Field(min_length=1, max_length=20000)


class FreezoneVideoMultishotRequest(FreezoneVideoMultishotReviewRequest):
    """MiniMax H3 Multishot enqueue — same inputs as the review request,
    plus the review's fingerprint (must match exactly, or this is rejected
    as stale) and the final prompt per shot (normally the review's own
    output, verbatim; may be hand-edited)."""

    review_fingerprint: str = Field(min_length=8, max_length=64)
    shot_prompts: list[FreezoneMultishotShotPrompt] = Field(min_length=2, max_length=8)


class FreezoneVideoExtendRequest(BaseModel):
    """Video extension request. Takes one source video and continues generating the specified duration from its end."""

    video_url: str = Field(description="Static URL of the source video to extend, required")
    prompt: str = Field(description="Content to continue generating after the source video ends")
    camera_template_id: Optional[str] = Field(
        default=None,
        description="Camera-move template id, e.g. locked_off / follow_tracking / pedestal_up",
    )
    resolution: str = Field(default="720p", description="Output resolution tier")
    duration_seconds: int = Field(
        default=5,
        ge=1,
        description="Duration of the newly generated extension clip; the supported range may differ between models",
    )
    generate_audio: bool = Field(default=False, description="Whether to generate native audio")
    human_review: bool = Field(
        default=False,
        description="Whether to enable the real-person asset review / allowlisting flow",
    )
    model: str = Field(
        default="newapi_seedance-2.5",
        description="Video model or model option id. Pass one of the values returned by /freezone/video/models",
    )
    canvas_id: str = Field(default="", description="Optional: source canvas id, used to record node generation history")
    node_id: str = Field(default="", description="Optional: source node id, used to record node generation history")
    gen_mode: Literal["videoExtend"] = Field(
        default="videoExtend",
        description="Fixed business mode of the video extension entry",
    )
    model_params: dict[str, Any] = Field(default_factory=dict)


class FreezoneVideoReferenceItem(BaseModel):
    """A single omni-reference asset."""

    type: Literal["image", "video", "audio", "file", "link"] = Field(
        description="Asset type"
    )
    url: str = Field(description="Static URL of the asset")
    role: str = Field(default="", description="Asset role, e.g. character reference / scene reference / music reference")
    label: str = Field(default="", description="Frontend display label, may be empty")


class FreezoneVideoMark(BaseModel):
    """Local element mark of a video node."""

    label: str = Field(description="Name of the marked element, e.g. old man / oxygen tube / hospital bed")
    source_url: str = Field(default="", description="Static URL of the source image of the mark, may be empty")
    point_x: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Normalized x coordinate of the click point, range 0-1",
    )
    point_y: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Normalized y coordinate of the click point, range 0-1",
    )
    box_x: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Normalized x coordinate of the top-left corner of the local box, range 0-1",
    )
    box_y: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Normalized y coordinate of the top-left corner of the local box, range 0-1",
    )
    box_width: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Normalized width of the local box, range 0-1",
    )
    box_height: Optional[float] = Field(
        default=None,
        ge=0.0,
        le=1.0,
        description="Normalized height of the local box, range 0-1",
    )
    note: str = Field(default="", description="Additional frontend note, may be empty")


class FreezoneMarkDetectRequest(BaseModel):
    """Local element mark recognition request."""

    source_url: str = Field(description="Static URL of the image to recognize")
    point_x: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Normalized x coordinate of the click point, range 0-1"
    )
    point_y: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Normalized y coordinate of the click point, range 0-1"
    )
    box_x: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Normalized x coordinate of the selection's top-left corner, range 0-1"
    )
    box_y: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Normalized y coordinate of the selection's top-left corner, range 0-1"
    )
    box_width: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Normalized selection width, range 0-1"
    )
    box_height: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Normalized selection height, range 0-1"
    )


class FreezoneMarkDetectData(BaseModel):
    """Local element mark recognition result."""

    mark: FreezoneVideoMark
    provider: str
    model: str


class FreezoneMarkDetectResponse(BaseModel):
    ok: bool
    data: FreezoneMarkDetectData


class FreezoneImageReversePromptRequest(BaseModel):
    """Image-to-prompt (reverse prompt) request."""

    source_url: str = Field(description="Static URL of the image to analyze")
    instruction: str = Field(default="", description="Optional: additional requirements for the reverse prompt")
    canvas_id: str = Field(default="", description="Optional: source canvas id, used to record node generation history")
    node_id: str = Field(default="", description="Optional: source node id, used to record node generation history")


class FreezoneImageReversePromptData(BaseModel):
    """Image-to-prompt (reverse prompt) result."""

    prompt: str


class FreezoneImageReversePromptResponse(BaseModel):
    ok: bool
    data: FreezoneImageReversePromptData


class FreezoneVideoOmniGenRequest(FreezoneWorkflowMediaLink):
    """Omni-reference video request.

    Supports mixed input of text, images, video, audio, files, and public web links.
    """

    prompt: str = Field(description="User-provided video content description")
    theme: str = Field(default="", description="Theme parameter, used to additionally specify shot theme, style, or narrative direction")
    camera_template_id: Optional[str] = Field(
        default=None,
        description="Camera-move template id, e.g. locked_off / follow_tracking / orbit_up",
    )
    references: list[FreezoneVideoReferenceItem] = Field(
        default_factory=list,
        description=(
            "List of mixed reference assets. Image, video, and audio limits are controlled by the model catalog; "
            "files and web links are limited to 1 each and are mutually exclusive"
        ),
    )
    marks: list[FreezoneVideoMark] = Field(
        default_factory=list,
        description="List of local element marks. Regions of subjects/objects selected by clicking the image in the frontend; not ordinary tags",
    )
    aspect_ratio: str = Field(
        default="16:9",
        description="Video aspect ratio; auto currently falls back to 16:9",
    )
    resolution: str = Field(
        default="720p",
        description="Output resolution tier",
    )
    duration_seconds: int = Field(
        default=5,
        ge=1,
        description="Video duration, at least 1 second; the supported range may differ between models",
    )
    generate_audio: bool = Field(default=False, description="Whether to generate native audio")
    human_review: bool = Field(
        default=False,
        description="Whether to enable the HuiMeng real-person asset review / allowlisting flow, for assets that may contain real human faces",
    )
    scene_optimize: Optional[Literal["anime", "realistic"]] = Field(
        default=None,
        description="Scene style optimization parameters for the Seedance 2.0 Value series",
    )
    model: str = Field(
        default="newapi_seedance-2.0-fast",
        description="Video model or model option id. Pass one of the values returned by /freezone/video/models",
    )
    canvas_id: str = Field(default="", description="Optional: source canvas id, used to record node generation history")
    node_id: str = Field(default="", description="Optional: source node id, used to record node generation history")
    gen_mode: Literal["allReference"] = Field(
        default="allReference",
        description="Fixed business mode of the omni-reference entry",
    )
    model_params: dict[str, Any] = Field(default_factory=dict)


class FreezoneVideoEraseRequest(BaseModel):
    """Video erase request.

    Handles:
    - smart_subtitle: smart subtitle removal (automatically estimates the bottom subtitle box)
    - box: box-selection erase (the frontend passes a fixed box)
    """

    source_url: str = Field(description="Static URL of the video to process")
    mode: Literal["smart_subtitle", "box"] = Field(
        default="smart_subtitle",
        description="Erase mode: smart_subtitle removes subtitles automatically, box erases a selected box",
    )
    box_x: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Selection top-left x, normalized 0-1"
    )
    box_y: Optional[float] = Field(
        default=None, ge=0.0, le=1.0, description="Selection top-left y, normalized 0-1"
    )
    box_width: Optional[float] = Field(
        default=None,
        gt=0.0,
        le=1.0,
        description="Selection width, normalized 0-1",
    )
    box_height: Optional[float] = Field(
        default=None,
        gt=0.0,
        le=1.0,
        description="Selection height, normalized 0-1",
    )


class FreezoneVideoUpscaleRequest(BaseModel):
    """Video enhancement request. The model is selected dynamically from media catalog capabilities."""

    source_url: str = Field(description="Static URL of the video to enhance")
    resolution: Literal["1080p", "2k", "4k"] = Field(
        default="1080p",
        description="Target resolution tier. Scaled by the long edge: 1080p=1920, 2k=2560, 4k=3840",
    )
    target_fps: Optional[float] = Field(
        default=None,
        ge=1,
        le=120,
        allow_inf_nan=False,
        description="Target frame rate 1-120, up to 3 decimals; None keeps the original frame rate",
    )

    @field_validator("target_fps")
    @classmethod
    def validate_target_fps_precision(cls, value: float | None) -> float | None:
        if value is not None and Decimal(str(value)).as_tuple().exponent < -3:
            raise ValueError("target_fps supports at most 3 decimal places")
        return value
    smart_interpolation: bool = Field(
        default=True,
        description="Whether to use smart frame interpolation when changing the frame rate; the default preserves existing behavior",
    )
    slowdown: Literal["auto", "2x", "3x", "4x", "5x"] = Field(
        default="auto",
        description="Slow-motion factor; auto keeps the original speed",
    )
    scene: Literal["realistic", "anime"] = Field(
        default="realistic",
        description="Source video scene type",
    )
    face_enhance: bool = Field(
        default=False,
        description="Whether to enable face-specific enhancement",
    )


class FreezoneAudioSeparateRequest(BaseModel):
    """Audio/video separation request.

    Only the lightweight version is implemented for now:
    - Extract the audio only
    - Export a silent video
    """

    source_url: str = Field(description="Static URL of the video to process")
    target_episode: Optional[int] = Field(
        default=None,
        ge=1,
        description="Optional: target main-line episode number. When provided, the task result returns a beat_audio push target",
    )
    target_beat: Optional[int] = Field(
        default=None,
        ge=1,
        description="Optional: target main-line beat. When provided, the task result returns a beat_audio push target",
    )


class FreezoneAudioVoiceRef(BaseModel):
    """Voice reference of a Freezone audio node.

    It is recommended to first call `GET /freezone/audio/references` to get the available voices, then pass back the
    scope / voice_id / character_name / identity_id / slot of an `available[]` item.
    The backend trusts only these identifiers and re-resolves the real audio file from account or project data; it does not use a path/url passed by the frontend.
    """

    scope: Literal[
        "project_narrator",
        "user_custom",
        "character_default",
        "character_age_group",
        "identity",
        "identity_resolved",
    ] = Field(
        description=(
            "Voice type: project_narrator = project narrator; user_custom = account-level custom voice;"
            "character_default = character default voice;"
            "character_age_group = character age-group voice; identity = the identity's own voice;"
            "identity_resolved = the actual voice after falling back identity voice -> age-group voice -> character default voice"
        ),
        examples=["identity_resolved"],
    )
    character_name: str = Field(
        default="",
        description="Character name. Required when scope is character_* or identity*; must match a project character name.",
        examples=["Alice"],
    )
    identity_id: str = Field(
        default="",
        description="Identity ID. Required when scope is identity or identity_resolved.",
        examples=["Alice_young_adult"],
    )
    slot: str = Field(
        default="",
        description="Age-group voice slot. Required when scope=character_age_group; one of child/youth/middle/elder.",
        examples=["youth"],
    )
    voice_id: str = Field(
        default="",
        description=(
            "Account-level custom voice ID. Required when scope=user_custom; comes from "
            "GET /freezone/audio/references (user_voices[]/available[]), "
            "or the return value of POST /freezone/audio/voices."
        ),
        examples=["fv_abc123"],
    )


class FreezoneAudioSpeechRequest(FreezoneWorkflowMediaLink):
    """Freezone audio node: text-to-speech request."""

    speech_mode: Literal["preset", "clone"] = Field(
        default="clone",
        description=(
            "Speech generation mode. preset uses a system preset voice and needs no reference audio; "
            "clone uses a project, character, or account-level reference voice."
        ),
    )
    preset_model: str = Field(
        default="edge-tts",
        description="Preset speech model used when speech_mode=preset.",
    )
    preset_voice: str = Field(
        default="Serena",
        description="System voice used when speech_mode=preset.",
    )
    text: str = Field(
        description=("Dialogue / narration text to synthesize."),
        examples=["She whispered: the day has finally come."],
    )
    emotion_prompt: str = Field(
        default="",
        description=(
            "Optional emotion prompt, passed to IndexTTS2 as emotion_prompt. When empty, the project narration style is used."
            "Example: tense, hushed voice, a hint of fear."
        ),
        examples=["tense, hushed voice, a hint of fear"],
    )
    voice_ref: Optional[FreezoneAudioVoiceRef] = Field(
        default=None,
        description=(
            "Optional voice reference. When empty, the project default narrator / lead narrator voice is used; when provided, the backend uses the scope and the character/identity identifier"
            "to re-resolve the account-level or in-project reference audio."
        ),
    )
    target_episode: Optional[int] = Field(
        default=None,
        ge=1,
        description="Optional: target main-line episode number. When provided, the task result returns a beat_audio push target",
    )
    target_beat: Optional[int] = Field(
        default=None,
        ge=1,
        description="Optional: target main-line beat. When provided, the task result returns a beat_audio push target",
    )


class FreezoneAudioMusicRequest(FreezoneWorkflowMediaLink):
    """Freezone audio node: text-to-music request."""

    input: str = Field(
        description="Music description prompt.",
        examples=["cinematic rain-soaked suspense music"],
    )
    model: str = Field(default="LingShan-MU-11", description="Music model, default LingShan-MU-11.")
    response_format: Literal["mp3", "opus", "pcm", "ulaw", "alaw"] = Field(
        default="mp3",
        description="Audio output format. mp3 is automatically mapped to mp3_44100_128.",
    )
    music_length_ms: int = Field(
        default=30_000,
        ge=3000,
        le=600000,
        description="Generation length in milliseconds, range 3000 to 600000.",
    )
    force_instrumental: bool = Field(
        default=True,
        description="Whether to force instrumental-only music.",
    )
    respect_sections_durations: bool = Field(
        default=True,
        description="Whether to strictly follow segment durations. Usually ignored by the model for prompt-based generation.",
    )
    output_format: str = Field(
        default="mp3_44100_128",
        description="fal native audio format, e.g. mp3_44100_128, opus_48000_128.",
    )


class FreezoneVideoComposeItem(BaseModel):
    item_id: str = Field(description="Unique frontend clip identifier")
    source_url: str = Field(description="Static URL of the source media")
    timeline_start: float = Field(default=0.0, ge=0.0, description="Start time of the clip on the timeline, in seconds")
    source_start: float = Field(default=0.0, ge=0.0, description="Source media trim start, in seconds")
    source_end: float = Field(gt=0.0, description="Source media trim end, in seconds; must be greater than source_start")
    volume: float = Field(default=1.0, ge=0.0, le=2.0, description="Volume multiplier")
    muted: bool = Field(default=False, description="Whether muted")
    speed: float = Field(default=1.0, gt=0.0, le=4.0, description="Playback speed")


class FreezoneVideoComposeTrack(BaseModel):
    track_id: str = Field(description="Unique frontend track identifier")
    kind: Literal["video", "audio"] = Field(description="Track type")
    items: list[FreezoneVideoComposeItem] = Field(default_factory=list, description="List of track clips")


class FreezoneVideoComposeRequest(BaseModel):
    title: str = Field(default="", description="Compose task title, may be empty")
    canvas_id: str = Field(default="", description="Source canvas id, may be empty")
    node_id: str = Field(default="", description="Source compose node id, used for generation history")
    resolution: Literal["720p", "1080p"] = Field(default="1080p", description="Target output resolution")
    fps: int = Field(default=30, ge=1, le=60, description="Output frame rate")
    background_color: str = Field(default="#000000", description="Background color used for padding or gaps")
    keep_original_audio: bool = Field(default=True, description="Whether to keep the audio of the video clips")
    cover_url: str | None = Field(
        default=None,
        validation_alias=AliasChoices("cover_url", "coverUrl"),
        description="Cover image URL for the composition, may be empty. Returned only as cover metadata of the final video; it does not change the video content.",
    )
    tracks: list[FreezoneVideoComposeTrack] = Field(
        default_factory=list, description="List of timeline tracks"
    )


FreezoneVideoGenRequest.model_rebuild()
FreezoneImageToVideoRequest.model_rebuild()
FreezoneKeyframeVideoRequest.model_rebuild()
FreezoneVideoOmniGenRequest.model_rebuild()


class FreezoneTextTranslateRequest(BaseModel):
    """Freezone text tool: translation request."""

    text: str = Field(description="Original text or prompt to translate")
    node_type: Literal["generic", "image", "video", "audio", "text"] = Field(
        default="generic",
        description="Usage scenario. Helps the translator keep a suitable prompt tone per node type",
    )
    canvas_id: str = Field(default="", description="Optional: source canvas id, used to record node generation history")
    node_id: str = Field(default="", description="Optional: source node id, used to record node generation history")


class FreezoneRecipeCompileReference(BaseModel):
    """Media reference summary available when compiling a Recipe; contains no internal file paths."""

    kind: Literal["image", "video", "audio"]
    label: str = Field(default="", max_length=200)


class FreezoneRecipePipelineEntry(BaseModel):
    id: str = Field(min_length=1, max_length=128)
    version: str = Field(default="", max_length=64)


class FreezoneRecipeCompileRequest(BaseModel):
    """Compile the node intent and a trusted Recipe into the final execution prompt."""

    recipe_id: str = Field(min_length=1, max_length=128)
    project_id: str = Field(default="", max_length=128)
    product_operation_id: str = Field(default="", max_length=128)
    recipe_version: str = Field(default="", max_length=64)
    recipe_pipeline: list[FreezoneRecipePipelineEntry] = Field(
        default_factory=list,
        max_length=6,
    )
    skill_id: str = Field(default="", max_length=128)
    skill_version: str = Field(default="", max_length=64)
    confirmed_inputs: dict[str, Any] = Field(default_factory=dict)
    node_kind: Literal["image", "video", "audio", "text"]
    prompt_strategy: Literal["template", "user_message", "previous_output", "llm_refine"] = (
        "llm_refine"
    )
    node_prompt: str = Field(default="", max_length=20000)
    user_goal: str = Field(default="", max_length=20000)
    upstream_text: str = Field(default="", max_length=40000)
    reference_media: list[FreezoneRecipeCompileReference] = Field(
        default_factory=list,
        max_length=20,
    )


class FreezoneRecipeCompileData(BaseModel):
    prompt: str
    compile_mode: Literal[
        "deterministic",
        "memory_cache",
        "persistent_cache",
        "model",
        "timeout_fallback",
    ]
    recipe_ids: list[str] = Field(default_factory=list)


class FreezoneRecipeCompileResponse(BaseModel):
    ok: Literal[True] = True
    data: FreezoneRecipeCompileData


class FreezoneRecipeCompileBatchItem(FreezoneRecipeCompileRequest):
    request_id: str = Field(min_length=1, max_length=128)


class FreezoneRecipeCompileBatchRequest(BaseModel):
    items: list[FreezoneRecipeCompileBatchItem] = Field(min_length=1, max_length=12)


class FreezoneRecipeCompileBatchResult(BaseModel):
    request_id: str
    ok: bool
    data: FreezoneRecipeCompileData | None = None
    error: str = ""
    retryable: bool = False


class FreezoneRecipeCompileBatchData(BaseModel):
    items: list[FreezoneRecipeCompileBatchResult]


class FreezoneRecipeCompileBatchResponse(BaseModel):
    ok: Literal[True] = True
    data: FreezoneRecipeCompileBatchData


class FreezoneRecipeTextGenerateData(BaseModel):
    content: str


class FreezoneRecipeTextGenerateResponse(BaseModel):
    ok: Literal[True] = True
    data: FreezoneRecipeTextGenerateData

class FreezoneTextGenerateRequest(BaseModel):
    """Freezone text node: generate free-form text from creative requirements."""

    prompt: str = Field(min_length=1, max_length=20000, description="Text creation requirements")
    canvas_id: str = Field(default="", description="Optional: source canvas id, used to record node generation history")
    node_id: str = Field(default="", description="Optional: source node id, used to record node generation history")


class FreezoneTextTranslateData(BaseModel):
    translated_text: str
    source_language: Literal["en", "vi"]
    target_language: Literal["en", "vi"]
    node_type: Literal["generic", "image", "video", "audio", "text"]


class FreezoneTextTranslateResponse(BaseModel):
    ok: Literal[True] = True
    data: FreezoneTextTranslateData


class FreezoneStoryScriptCharacterRef(BaseModel):
    """Character reference input item: a character image node connected into the script node on the canvas."""

    name: str = Field(default="", description="Character name / label, used to align with the character names in the generated rows")
    description: str = Field(default="", description="Optional: existing character description")
    image_url: str = Field(default="", description="Static URL of the character reference image (/static/...)")
    role: str = Field(default="", description="Optional: character role or narrative function, e.g. 'female lead'")


class FreezoneStoryScriptGenerateRequest(BaseModel):
    """Freezone text node: story script generation request.

    At least one of four inputs must be given: ``source_text`` / ``source_url`` (script text),
    ``video_url`` (video reference, via frame extraction + vision model), ``character_refs`` (character image references).
    Early versions declared only the text fields, so the ``video_url`` / ``character_refs`` sent by the frontend were
    silently dropped by Pydantic's ``extra="ignore"``, so "generate a storyboard script from a video reference" never actually
    handed the video to the model (issue #207).
    """

    source_text: str = Field(
        default="",
        description="Text content of the uploaded script. At least one of this, source_url, video_url, character_refs is required",
    )
    source_url: Optional[str] = Field(
        default=None,
        description="Static URL of the uploaded script text file",
    )
    video_url: Optional[str] = Field(
        default=None,
        description="Static URL of the video reference; when given, keyframes are extracted first and then handed to the vision model to split into shots",
    )
    duration_sec: Optional[float] = Field(
        default=None,
        description="Total video duration (seconds), used to make shot duration allocation closer to the original video",
    )
    character_refs: list[FreezoneStoryScriptCharacterRef] = Field(
        default_factory=list,
        description="List of character reference images; after generation, character_image_1/2 are backfilled by character name",
    )
    max_frames: int = Field(
        default=20,
        ge=3,
        le=50,
        description="Maximum number of extracted frames for video references",
    )
    scene_threshold: float = Field(
        default=0.3,
        ge=0.0,
        le=1.0,
        description="ffmpeg scene-change detection threshold for video references",
    )
    prompt: str = Field(
        default="Generate a complete story script from the script I uploaded",
        description="Additional user requirements, passed to the model together with the source script content",
    )
    model: str = Field(
        default="newapi_gemini_flash",
        description="Text model option id or display name",
    )
    canvas_id: str = Field(default="", description="Optional: source canvas id, used to record node generation history")
    node_id: str = Field(default="", description="Optional: source node id, used to record node generation history")


class FreezoneStoryScriptRow(BaseModel):
    shot_no: int = Field(description="Shot number")
    duration: int = Field(description="Duration in seconds")
    visual_description: str = Field(description="Visual description")
    character_1: str = Field(default="", description="Character 1")
    character_description_1: str = Field(default="", description="Character 1 description")
    character_image_1: str = Field(
        default="",
        description="Character image 1 URL; leave empty for the model, the backend backfills it by matching character_refs by character name",
    )
    character_2: str = Field(default="", description="Character 2")
    character_description_2: str = Field(default="", description="Character 2 description")
    character_image_2: str = Field(
        default="",
        description="Character image 2 URL; leave empty for the model, the backend backfills it by matching character_refs by character name",
    )
    reference: str = Field(
        default="",
        description="Reference image URL; leave empty for the model, the backend backfills the matching keyframe by keyframe_index",
    )
    keyframe_index: int = Field(
        default=0,
        description="In video reference mode, the input keyframe index corresponding to this shot (1-based, 0 means none)",
    )
    shot: str = Field(default="", description="Shot size")
    character_action: str = Field(default="", description="Character action")
    emotion: str = Field(default="", description="Emotion")
    scene_tags: str = Field(default="", description="Scene tags")
    lighting_mood: str = Field(default="", description="Lighting mood")
    sound: str = Field(default="", description="Sound effects")
    dialogue: str = Field(default="", description="Dialogue")
    shot_prompt: str = Field(default="", description="Shot prompt")
    video_motion_prompt: str = Field(default="", description="Video motion prompt")


class FreezoneStoryScriptGenerateData(BaseModel):
    title: str = Field(default="", description="Story script title")
    rows: list[FreezoneStoryScriptRow] = Field(default_factory=list, description="Structured story script rows")


class FreezoneStoryScriptGenerateResponse(BaseModel):
    ok: Literal[True] = True
    data: FreezoneStoryScriptGenerateData


class FreezoneJobAcceptedData(BaseModel):
    task_type: str
    job_id: str
    task_key: str


class FreezoneJobAcceptedResponse(BaseModel):
    ok: Literal[True] = True
    data: FreezoneJobAcceptedData


class FreezoneStageAssetAcceptedData(BaseModel):
    task_type: str
    job_id: str
    task_key: str
    scope: str
    scene_id: str
    step: str


class FreezoneStageAssetAcceptedResponse(BaseModel):
    ok: Literal[True] = True
    data: FreezoneStageAssetAcceptedData


class CanvasPayload(BaseModel):
    schema_version: Optional[Literal[2]] = None
    canvas_id: Optional[str] = None
    project_id: Optional[str] = None
    canvas_scope: Optional[Literal["default", "episode", "beat", "asset"]] = None
    owner_principal_type: Optional[Literal["user", "team"]] = None
    owner_principal_id: Optional[str] = None
    access_model: Optional[Literal["project_role"]] = None
    min_project_role: Optional[Literal["viewer", "editor", "admin"]] = None
    episode: Optional[int] = None
    beat: Optional[int] = None
    asset_target: Optional[dict] = None
    revision: Optional[int] = None
    base_revision: Optional[int] = None
    created_by: Optional[str] = None
    updated_by: Optional[str] = None
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    client_save_id: Optional[str] = None
    save_source: Literal[
        "autosave",
        "manual_save",
        "manual_clear",
        "restore",
        "from_preset",
        "projection_remove",
        "import",
    ] = "autosave"
    allow_empty_overwrite: bool = False
    nodes: list[dict] = Field(default_factory=list)
    edges: list[dict] = Field(default_factory=list)
    viewport: Optional[dict] = None
    metadata: Optional[dict] = None

    @model_validator(mode="after")
    def _check_payload_size(self) -> "CanvasPayload":
        # Raise HTTPException directly so the response carries a stable,
        # machine-readable code instead of Pydantic's default
        # "List should have at most N items" message (which echoes the
        # entire offending list and is unparseable client-side).
        if len(self.nodes) > CANVAS_MAX_NODES:
            raise HTTPException(
                422,
                {
                    "code": "canvas_payload_too_large",
                    "field": "nodes",
                    "limit": CANVAS_MAX_NODES,
                    "got": len(self.nodes),
                },
            )
        if len(self.edges) > CANVAS_MAX_EDGES:
            raise HTTPException(
                422,
                {
                    "code": "canvas_payload_too_large",
                    "field": "edges",
                    "limit": CANVAS_MAX_EDGES,
                    "got": len(self.edges),
                },
            )
        return self


class PresetCanvasRequest(BaseModel):
    """Stateless factory input for a project-scoped preset canvas."""

    scope: Literal["episode", "beat", "asset", "blank"] = "beat"
    episode: Optional[int] = None
    beat: Optional[int] = None
    primary_slot: str = "render"
    asset_kind: Optional[str] = None
    character: Optional[str] = None
    identity_id: Optional[str] = None
    asset_id: Optional[str] = None
    canvas_id: Optional[str] = None
    overwrite_existing: bool = False
    base_revision: Optional[int] = None


class ProjectionPresetCanvasRequest(BaseModel):
    """Project one preset subgraph into an existing user canvas."""

    scope: Literal["episode", "beat", "asset", "blank"] = "beat"
    projection_key: str = Field(min_length=1, max_length=160)
    episode: Optional[int] = None
    beat: Optional[int] = None
    primary_slot: str = "render"
    asset_kind: Optional[str] = None
    character: Optional[str] = None
    identity_id: Optional[str] = None
    asset_id: Optional[str] = None
    base_revision: int
    force_refresh: bool = False


class ProjectionStatusRequest(BaseModel):
    """Check whether projected preset subgraphs are stale."""

    projection_keys: Optional[list[str]] = None


class ProjectionRemoveRequest(BaseModel):
    """Remove one projected preset subgraph from an existing user canvas."""

    projection_key: str = Field(min_length=1, max_length=160)
    base_revision: int


class PushRequest(BaseModel):
    source_url: str
    target: PushTarget = Field(discriminator="kind")
    mark_stale: bool = False


class ImpactRequest(BaseModel):
    target: PushTarget = Field(discriminator="kind")


class CreateIdentityAssetRequest(BaseModel):
    source_url: str
    character: str
    identity_name: str
    appearance_details: str = ""
    face_prompt: str = ""
    age_group: str = ""


class CharacterUpdate(BaseModel):
    name: Optional[str] = None
    face_prompt: Optional[str] = None
    description: Optional[str] = None
    gender: Optional[str] = None
    age_group: Optional[str] = None
    is_main: Optional[bool] = None
    role: Optional[str] = None  # "protagonist" / "supporting" / "antagonist"
    body_type: Optional[str] = None  # "slim and tall" / "sturdy and burly", etc.
    fish_voice_id: Optional[str] = None  # Fish Audio S2 voice ID
    aliases: Optional[list[str]] = None


# ── Scene assets ─────────────────────────────────────────────────────────────────


class SceneCreate(BaseModel):
    name: str
    aliases: list[str] = Field(default_factory=list)
    scene_type: str = "interior"
    base_scene_id: str = ""
    variant_id: str = ""
    time_of_day: str = ""
    environment_prompt: str = ""
    variant_prompt: str = ""
    description: str = ""
    spatial_layout_image: str = ""
    notes: str = ""


class SceneUpdate(BaseModel):
    name: Optional[str] = None
    aliases: Optional[list[str]] = None
    scene_type: Optional[str] = None
    base_scene_id: Optional[str] = None
    variant_id: Optional[str] = None
    time_of_day: Optional[str] = None
    environment_prompt: Optional[str] = None
    variant_prompt: Optional[str] = None
    description: Optional[str] = None
    spatial_layout_image: Optional[str] = None
    notes: Optional[str] = None


class ScenePanoGenerateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    source: Literal["master", "text"] = "master"


class SceneReferenceGenerateRequest(BaseModel):
    model: Optional[str] = None


# ── Prop assets ─────────────────────────────────────────────────────────────────


class PropCreate(BaseModel):
    name: str
    aliases: list[str] = Field(default_factory=list)
    prop_type: str = "object"
    visual_prompt: str = ""
    description: str = ""
    owner: str = ""
    notes: str = ""


class PropUpdate(BaseModel):
    name: Optional[str] = None
    aliases: Optional[list[str]] = None
    prop_type: Optional[str] = None
    visual_prompt: Optional[str] = None
    description: Optional[str] = None
    owner: Optional[str] = None
    notes: Optional[str] = None


class PropReferenceGenerateRequest(BaseModel):
    style: Optional[str] = None
    model: Optional[str] = None


# ── Identity CRUD ────────────────────────────────────────────────────────────────


class IdentityCreate(BaseModel):
    identity_name: str
    age_group: str = ""
    appearance_details: str = ""


class IdentityImageGenRequest(BaseModel):
    style: Optional[str] = None
    model: Optional[str] = None


CharacterAssetKind = Literal["portrait", "identity", "identity_costume", "identity_portrait"]


class CharacterAssetRestoreRequest(BaseModel):
    kind: CharacterAssetKind
    history_id: str
    identity_id: Optional[str] = None


class CharacterImageSelectionRequest(BaseModel):
    character_image_selection: str


class AssetImageSourceSelectionRequest(BaseModel):
    image_source_selection: str


class CharacterVoiceRecordRequest(BaseModel):
    data_url: str


class SystemVoicePrepareRequest(BaseModel):
    confirmed: bool = False


class NarratorVoiceCopyRequest(BaseModel):
    source_path: str


class NarratorVoiceTrimRequest(BaseModel):
    start_seconds: float = 0.0
    duration_seconds: float = 4.0


class CharacterVoiceTrimRequest(BaseModel):
    source_path: str
    start_seconds: float = 0.0
    duration_seconds: float = 4.0


class IdentityUpdate(BaseModel):
    identity_name: Optional[str] = None
    appearance_details: Optional[str] = None
    face_prompt: Optional[str] = None
    age_group: Optional[str] = None
    body_type: Optional[str] = None
    fish_voice_id: Optional[str] = None


# ── Script save ─────────────────────────────────────────────────────────────────


class ScriptSaveRequest(BaseModel):
    beats: list[dict]


# ── Sketch splitting ─────────────────────────────────────────────────────────────────


class GridCutRequest(BaseModel):
    grid_type: Literal["render", "sketch"] = "sketch"
    mode_key: str | None = None
    rows: int
    cols: int
    beat_start: int
    beat_end: int
    beat_numbers: list[int] | None = None


class GridSketchPreviewRequest(BaseModel):
    rows: int = Field(..., ge=1)
    cols: int = Field(..., ge=1)
    beat_numbers: list[int] = Field(..., min_length=1)


# ── Render plan ─────────────────────────────────────────────────────────────────


class RenderPlanRequest(BaseModel):
    beat_indices: list[int] = Field(..., min_length=1)
    strategy: Literal["location", "naive"] = "naive"
    force_one_by_one: bool = False
    aspect_mode: str = Field(..., description="e.g. '9:16', '1:1', '16:9'")
    image_generation_selection: Optional[str] = None
    sketch_aspect_padding: Optional[bool] = None


class PlanEntryOut(BaseModel):
    mode_key: str
    rows: int
    cols: int
    beat_numbers: list[int]
    location: str = ""
    padding_count: int = 0
    reasons: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class RenderPlanResponse(BaseModel):
    plan: list[PlanEntryOut]
    plan_hash: str
    input_fingerprint: str
    strategy: str
    total_beats: int
    total_grids: int


class RenderPlanExecuteRequest(BaseModel):
    plan: list[PlanEntryOut]
    plan_hash: str
    input_fingerprint: str
    strategy: Literal["location", "naive"]
    aspect_mode: str
    force_one_by_one: bool = False
    custom_plan: bool = False
    beat_indices: list[int] = Field(..., min_length=1)
    image_generation_selection: Optional[str] = None
    sketch_aspect_padding: Optional[bool] = None


class RenderPlanExecuteResponse(BaseModel):
    task_type: str
    message: str
    scope: str
    resolved_grids: list[PlanEntryOut]


# ── Style preview ─────────────────────────────────────────────────────────────────


class StylePreviewRequest(BaseModel):
    project: Optional[str] = None
    prompt: str = "A beautiful woman standing in a garden"
    model: str = "nanobanana"


class FreezoneImageAnimateRequest(FreezoneWorkflowMediaLink):
    image_url: str = Field(min_length=1)
    canvas_id: str = Field(default="", max_length=200)
    node_id: str = Field(default="", max_length=200)


class FreezoneImageVectorizeRequest(FreezoneImageAnimateRequest):
    pass


class FreezoneImageAnimateGifRequest(BaseModel):
    video_url: str = Field(min_length=1)
    canvas_id: str = Field(default="", max_length=200)
    node_id: str = Field(default="", max_length=200)

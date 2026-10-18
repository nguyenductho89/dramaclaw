"""Verification system data models."""

from enum import Enum

from pydantic import BaseModel, Field


class VerificationIssue(BaseModel):
    type: str  # "character_count_mismatch", "action_mismatch", "scene_mismatch", etc.
    severity: str  # "critical", "warning", "info"
    description: str
    confidence: float  # 0.0-1.0


class VerificationResult(BaseModel):
    """LLM output structure (used as the Agent output_type)."""

    passed: bool
    score: float  # 0-10
    issues: list[VerificationIssue]
    summary: str
    suggested_action: str  # "none" | "regenerate" | "edit_script"
    edit_suggestion: str = ""


# --- Legacy ConsistencyResult (kept for backward compat) ---


class ConsistencyIssue(BaseModel):
    type: str  # "character_appearance_inconsistency", "costume_mismatch"
    severity: str  # "critical", "warning", "info"
    beats: list[int]
    character: str
    description: str
    confidence: float


# --- Enhanced Consistency Models ---


class ConsistencyDimension(BaseModel):
    """Evaluation of a single consistency dimension."""

    dimension: str = Field(
        description="face, hair, skin_tone, gender, clothing_style, clothing_color, accessories, body_type"
    )
    score: float = Field(ge=0, le=10, description="Score 0-10")
    severity: str = Field(description="critical, warning, info")
    description: str = Field(description="Problem description")


class CharacterConsistencyReport(BaseModel):
    """Consistency report of a single character."""

    character: str
    identity_id: str
    beats_checked: list[int]
    dimensions: list[ConsistencyDimension]
    face_score: float = Field(
        ge=0, le=10, description="Overall face score (mean of face + hair + skin_tone)"
    )
    clothing_score: float = Field(
        ge=0, le=10, description="Overall clothing score (mean of clothing_style + clothing_color + accessories)"
    )
    passed: bool = Field(description="face_score >= 7.0 AND clothing_score >= 7.0 AND no critical")


class ConsistencyResult(BaseModel):
    """Global consistency verification result (enhanced, scored by dimension)."""

    characters: list[CharacterConsistencyReport] = Field(default_factory=list)
    summary: str
    overall_passed: bool = Field(default=True)


# --- Color Verification Models (Step 12.4) ---


class ColorMismatch(BaseModel):
    """A single color mismatch entry."""

    identity_id: str
    color_hex: str
    color_name: str
    issue_type: str  # "missing" | "extra"


class ColorVerifyBeatResult(BaseModel):
    """Color verification result of a single beat."""

    beat_number: int
    status: str  # "pass" | "fail" | "warn"
    expected: list[str]  # identity_ids expected from the screenplay
    detected: list[str]  # identity_ids detected by pixel analysis
    missing: list[ColorMismatch]  # expected but not detected
    extra: list[ColorMismatch]  # detected but should not appear
    sketch_path: str = ""  # sketch file path (used to locate on failure)


class ColorVerifyResult(BaseModel):
    """Color verification result of a whole episode."""

    total_beats: int
    passed_beats: int
    failed_beats: int
    warned_beats: int
    failed_beat_numbers: list[int]
    beat_results: list[ColorVerifyBeatResult]
    overall_passed: bool


# --- T3: Content Matching Score Models ---


class ObjectiveScore(BaseModel):
    """T3 content-match scoring result (LLM output structure)."""

    script_match: float = Field(ge=0, le=10, description="Screenplay match 0-10")
    identity_clarity: float = Field(ge=0, le=10, description="Character distinguishability 0-10")
    total: float = Field(ge=0, le=10, description="Mean")


# --- T4: Comparative Selection Models ---


class CandidateRanking(BaseModel):
    """Ranking of a single candidate."""

    pool_id: str
    rank: int
    reason: str


class CompareResult(BaseModel):
    """T4 comparison selection result (LLM output structure)."""

    selected_index: int = Field(description="Index of the selected candidate (starting from 1)")
    ranking: list[CandidateRanking] = Field(default_factory=list)
    comparison_summary: str = ""


# --- T6: Continuity Assessment Models ---


class ContinuityTransition(BaseModel):
    """Evaluation of a single transition point."""

    from_beat: int
    to_beat: int
    spatial_consistency: float = Field(ge=0, le=10, description="Continuity of spatial relationships")
    action_continuity: float = Field(ge=0, le=10, description="Action continuity")
    scene_transition: float = Field(ge=0, le=10, description="Reasonableness of the scene transition")
    total: float = Field(ge=0, le=10, description="Mean of the three dimensions")
    issues: list[str] = Field(default_factory=list, description="Concrete issues")


class ContinuityResult(BaseModel):
    """T6 continuity evaluation result (LLM output structure)."""

    transitions: list[ContinuityTransition] = Field(default_factory=list)
    weak_transitions: list[int] = Field(
        default_factory=list, description="beat_numbers of transition points with poor continuity"
    )
    overall_score: float = Field(ge=0, le=10, default=10.0)


# --- T7: Similarity Detection Models ---


class SimilarityPair(BaseModel):
    """A pair of similar sketches."""

    beat_a: int
    beat_b: int
    similarity: float = Field(ge=0, le=1, description="Similarity 0-1")
    warning: bool = Field(default=False, description="Whether it exceeds the threshold")


class SimilarityResult(BaseModel):
    """T7 similarity detection result (pixel level, zero LLM)."""

    pairs: list[SimilarityPair] = Field(default_factory=list)
    duplicate_beats: list[int] = Field(
        default_factory=list, description="Those whose similarity to other beats exceeds the threshold"
    )
    overall_passed: bool = Field(default=True)


# --- T8: Episode Overview Models ---


class EpisodeIssue(BaseModel):
    """Issue found in the global storyboard review."""

    beat_number: int = Field(description="Primary related beat")
    issue_type: str = Field(
        description="composition_repetition | style_drift | weak_climax | visual_monotony | pacing_imbalance | proportion_inconsistency"
    )
    severity: str = Field(description="critical | warning")
    description: str
    suggested_action: str = Field(description="swap_candidate | regenerate | info")
    related_beats: list[int] = Field(default_factory=list, description="Related beats (context)")


class EpisodeOverviewResult(BaseModel):
    """T8 global storyboard review result (LLM output structure)."""

    visual_rhythm: float = Field(ge=0, le=10, description="Visual rhythm 0-10")
    composition_diversity: float = Field(ge=0, le=10, description="Composition diversity 0-10")
    narrative_arc: float = Field(ge=0, le=10, description="Narrative arc visualization 0-10")
    style_unity: float = Field(ge=0, le=10, description="Style unity 0-10")
    total: float = Field(ge=0, le=10, description="Mean of the four dimensions")
    issues: list[EpisodeIssue] = Field(default_factory=list, description="At most 5")
    overall_passed: bool = Field(description="No critical issue and total >= 6.0")
    summary: str = Field(description="One-sentence overall impression")


class EditDecision(str, Enum):
    """Teacher top-level decision for a single sketch."""

    keep = "keep"
    revise = "revise"


class SketchMainProblem(str, Enum):
    """Primary problem category from the director's perspective."""

    shot_scale_wrong = "shot_scale_wrong"
    composition_weak = "composition_weak"
    identity_color_mismatch = "identity_color_mismatch"
    staging_unclear = "staging_unclear"
    scene_mismatch = "scene_mismatch"
    character_count_wrong = "character_count_wrong"
    pose_action_wrong = "pose_action_wrong"


class SketchEditResult(BaseModel):
    """Sketch correction result generated by the Teacher."""

    decision: EditDecision
    main_problem: SketchMainProblem | None = Field(
        default=None,
        description="Primary problem type; may be null when decision=keep.",
    )
    reasoning: str = Field(
        default="",
        description="A concise 1-3 sentence explanation of why it is kept or corrected.",
        max_length=150,
    )
    edit_instruction: str = Field(
        default="",
        description=(
            "A directly executable Nanobanana edit prompt. When mentioning an identity, use the exact identity + hex color, "
            "do not use vague color names."
        ),
        max_length=900,
    )
    confidence: float = Field(default=0.8, ge=0.0, le=1.0)

"""Verification API request/response schemas."""

from pydantic import BaseModel, Field


class VerifyRequest(BaseModel):
    type: str = "sketch"  # "sketch" | "frame"


class ConsistencyVerifyRequest(BaseModel):
    verify_type: str = "sketch"  # "sketch" | "frame"


class ColorVerifyRequest(BaseModel):
    missing_threshold: float = 0.008  # detection threshold for expected colors
    extra_threshold: float = 0.015  # detection threshold for unexpected colors (higher, to reduce false positives from background noise)


class SketchScoreRequest(BaseModel):
    """T3: content-match scoring request."""

    pool_id: str = ""  # optional; the latest version is used when omitted
    type: str = "sketch"


class ScoreBatchRequest(BaseModel):
    """T3 batch: batch scoring request."""

    beat_numbers: list[int] = Field(default_factory=list, description="List of beats to score; empty = all")
    score_all_candidates: bool = Field(default=True, description="Whether to score all candidates")


class CompareRequest(BaseModel):
    """T4: comparison selection request."""

    pool_ids: list[str] = Field(..., description="List of candidate pool_ids to compare")
    reference_pool_ids: list[str] = Field(default_factory=list, description="Already selected reference images (style consistency)")


class ContinuityRequest(BaseModel):
    """T6: continuity evaluation request."""

    beat_range: list[int] = Field(default_factory=list, description="[start, end] or empty = all")
    window_size: int = Field(default=2, ge=2, le=3, description="How many consecutive beats to look at each time")


class SketchSelectRequest(BaseModel):
    """Orchestration endpoint: one-stop selection request."""

    quality_threshold: float = Field(default=7.0, ge=0, le=10)
    score_gap_for_auto_select: float = Field(default=1.0, ge=0)
    color_prefilter: bool = True
    fact_check: bool = True
    promote_selected: bool = Field(
        default=False,
        description="Whether to copy accepted selections into sketches/epXXX. Defaults to false.",
    )


class SketchEditExecuteRequest(BaseModel):
    """Execute episode-level sketch edit batches from labels.jsonl."""

    labels_name: str = Field(
        default="labels.jsonl",
        description="JSONL file name written under verify_reports/epXXX/",
    )

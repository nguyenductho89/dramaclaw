"""Script generation entry point.

The 2.0 default currently uses "line-by-line script mode":
- one beat per line
- keep the original line text
- the LLM only fills in the 2.0 beat metadata

The old screenplay-first complex pipeline has left the default main path.
This module keeps the original import path and is only a thin compatibility shell over the literal workflow.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from novelvideo.workflows.literal_script_writing import LiteralScriptWritingWorkflow

if TYPE_CHECKING:
    from novelvideo.cognee import CogneeStore


class ScriptWritingWorkflow(LiteralScriptWritingWorkflow):
    """Backward-compatible script workflow name.

    Now equivalent to LiteralScriptWritingWorkflow.
    """


def create_script_writing_workflow(
    cognee_store: "CogneeStore",
    visual_style: str = "",
    genre: str = "",
    story_setting: str = "",
    spine_template: str = "drama",
) -> ScriptWritingWorkflow:
    """Create the script generation workflow.

    Compatible with the old entry name; internally it returns a line-by-line script mode instance directly.
    """
    del visual_style, genre, story_setting
    audio_type_mode = "narrated" if spine_template == "narrated" else "literal"
    return ScriptWritingWorkflow(
        cognee_store=cognee_store,
        # Line-by-line mode finally calls persist_narration_script(), which lives on CogneeStore.
        sqlite_store=cognee_store,
        output_dir=getattr(cognee_store, "output_dir", ""),
        audio_type_mode=audio_type_mode,
    )


__all__ = [
    "ScriptWritingWorkflow",
    "create_script_writing_workflow",
]

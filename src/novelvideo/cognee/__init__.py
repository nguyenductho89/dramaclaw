"""NovelVideo unified Cognee storage module.

Core idea: all entities are stored directly in the Cognee graph; no extra JSON storage is needed.

Usage:
    from novelvideo.cognee import CogneeStore, NovelCharacter, NovelEpisode

    store = await create_cognee_store("hongloumeng")

    # Ingest a novel and build the graph characters/episodes
    await store.ingest_novel("hongloumeng.txt")

    # Look up a character (aliases supported)
    char = store.get_character("the Queen")  # returns the canonical character
    prompt = char.face_prompt  # get the face prompt directly
"""

# Important: config must be imported first so env vars are set before cognee is imported
from .config import init_cognee, get_cognee_status

from .store import CogneeStore, create_cognee_store
from novelvideo.models import (
    NovelCharacter,
    NovelEpisode,
    NovelEvent,
    NovelVisualBeat,
    NovelScene,
    NovelProp,
)
from .pipeline import (
    run_character_extraction_pipeline,
    extract_scenes_from_graph,
    extract_scenes_from_script,
    extract_props_from_graph,
)
from .tools import create_episode_planner_tools

__all__ = [
    # Storage
    "CogneeStore",
    "create_cognee_store",

    # Entities
    "NovelCharacter",
    "NovelEpisode",
    "NovelEvent",
    "NovelVisualBeat",
    "NovelScene",
    "NovelProp",

    # Pipeline
    "run_character_extraction_pipeline",
    "extract_scenes_from_graph",
    "extract_scenes_from_script",
    "extract_props_from_graph",

    # Tools
    "create_episode_planner_tools",

    # Config
    "init_cognee",
    "get_cognee_status",
]

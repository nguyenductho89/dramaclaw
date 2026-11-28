"""The asset language of a project: declared when the project is created, never guessed.

The value lives in ``project_config.json``. Every generator of asset text reads it
from there, so one project cannot drift between languages from one prompt to the next.
Chinese and English are the only languages in this contract.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Literal, get_args

from novelvideo.project_config import (
    load_project_config_file_from_state_dir,
    update_project_config_file_in_state_dir,
)

AssetLanguage = Literal["zh", "en"]

ASSET_LANGUAGES: tuple[str, ...] = get_args(AssetLanguage)
DEFAULT_ASSET_LANGUAGE: AssetLanguage = "en"
ASSET_LANGUAGE_KEY = "asset_language"


def project_asset_language(state_dir: str | Path | None) -> AssetLanguage:
    """Language stored for the project at ``state_dir``.

    A project created before the setting existed gets the default written into its
    config on first read, so from then on the value is explicit.
    """
    if not state_dir:
        return DEFAULT_ASSET_LANGUAGE
    config = load_project_config_file_from_state_dir(state_dir)
    stored = config.get(ASSET_LANGUAGE_KEY)
    if stored in ASSET_LANGUAGES:
        return stored
    # An empty result also means an unreadable file: never write over that one.
    if not config:
        return DEFAULT_ASSET_LANGUAGE

    def _backfill(current: dict) -> None:
        if current.get(ASSET_LANGUAGE_KEY) not in ASSET_LANGUAGES:
            current[ASSET_LANGUAGE_KEY] = DEFAULT_ASSET_LANGUAGE

    return update_project_config_file_in_state_dir(state_dir, _backfill)[ASSET_LANGUAGE_KEY]


def store_asset_language(store: Any) -> AssetLanguage:
    """``project_asset_language`` for a project store (graph or SQLite)."""
    state_dir = getattr(store, "state_dir", None) or getattr(
        getattr(store, "sqlite_store", None), "state_dir", None
    )
    return project_asset_language(state_dir)


def set_project_asset_language(state_dir: str | Path, language: AssetLanguage) -> None:
    """Declare the language of an existing project."""
    if language not in ASSET_LANGUAGES:
        raise ValueError(f"Unsupported asset language: {language}")

    def _apply(config: dict) -> None:
        config[ASSET_LANGUAGE_KEY] = language

    update_project_config_file_in_state_dir(state_dir, _apply)


def asset_language_instruction(language: AssetLanguage) -> str:
    """Return the shared language rule appended to model requests."""
    if language == "en":
        return (
            "Write every user-visible prose field in English. "
            "Keep every supplied character and location name verbatim; "
            "never translate, romanize, or rewrite a name."
        )
    return (
        "所有面向用户的自由文本字段都使用中文。"
        "人物名和地点名必须按输入原样保留，不得翻译、音译或改写。"
    )

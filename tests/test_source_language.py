"""The asset language is a project setting: declared at creation, never guessed."""

from __future__ import annotations

import ast
import json
from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.api.schemas import ProjectCreate, ProjectUpdate
from novelvideo.utils.source_language import (
    asset_language_instruction,
    project_asset_language,
    set_project_asset_language,
    store_asset_language,
)

SRC = Path(__file__).resolve().parents[1] / "src" / "novelvideo"


def _config(state_dir: Path) -> dict:
    return json.loads((state_dir / "project_config.json").read_text(encoding="utf-8"))


def _write(state_dir: Path, config: dict) -> None:
    (state_dir / "project_config.json").write_text(json.dumps(config), encoding="utf-8")


def test_a_new_project_is_english_unless_it_chooses_chinese():
    assert ProjectCreate(name="a").asset_language == "en"
    assert ProjectCreate(name="a", asset_language="zh").asset_language == "zh"
    with pytest.raises(ValueError):
        ProjectCreate(name="a", asset_language="vi")
    # Chosen at creation only: the settings update cannot change it.
    assert "asset_language" not in ProjectUpdate.model_fields


def test_an_older_project_gets_the_default_written_into_its_config(tmp_path):
    _write(tmp_path, {"user": "local"})

    assert project_asset_language(tmp_path) == "en"
    assert _config(tmp_path) == {"user": "local", "asset_language": "en"}


def test_a_stored_language_is_kept(tmp_path):
    _write(tmp_path, {"asset_language": "zh"})

    assert project_asset_language(tmp_path) == "zh"
    assert store_asset_language(SimpleNamespace(state_dir=str(tmp_path))) == "zh"
    wrapper = SimpleNamespace(sqlite_store=SimpleNamespace(state_dir=str(tmp_path)))
    assert store_asset_language(wrapper) == "zh"


def test_the_story_text_does_not_decide_the_language(tmp_path):
    _write(tmp_path, {"user": "local"})
    (tmp_path / "novel.txt").write_text("第一场 客厅 日 内\n林默推开门。", encoding="utf-8")

    assert project_asset_language(tmp_path) == "en"


@pytest.mark.parametrize("content", [None, "{not json"])
def test_a_missing_or_unreadable_config_is_never_overwritten(tmp_path, content):
    path = tmp_path / "project_config.json"
    if content is not None:
        path.write_text(content, encoding="utf-8")

    assert project_asset_language(tmp_path) == "en"
    assert (path.read_text(encoding="utf-8") if path.exists() else None) == content


def test_an_existing_project_can_be_declared_chinese(tmp_path):
    _write(tmp_path, {"user": "local", "asset_language": "en"})

    set_project_asset_language(tmp_path, "zh")

    assert project_asset_language(tmp_path) == "zh"
    with pytest.raises(ValueError):
        set_project_asset_language(tmp_path, "vi")  # type: ignore[arg-type]


# Functions with a language argument that defaults to English, and that argument's name.
# A production call that leaves it out would silently write English into a Chinese project.
_LANGUAGE_ARGUMENT = {
    "build_scene_effective_prompt": "language",
    "extract_scenes_from_script": "output_language",
    "enrich_scene_environment_from_context": "output_language",
    "enrich_scene_environments_batched": "output_language",
    "normalize_screenplay_scene_header": "output_language",
    "normalize_screenplay_scenes": "output_language",
    "extract_characters_from_chunks": "output_language",
    "enrich_character_appearances": "output_language",
    "_ensure_directional_environment_prompt": "output_language",
    "build_scene_reference_prompt": "language",
    "generate_scene_reference_image": "language",
    "build_qwen_render_draft": "language",
    "build_qwen_render_task": "language",
    "compose_qwen_render_prompt": "language",
    "build_h3_prompt_draft": "language",
    "generate_h3_prompt": "language",
    "generate_seedance2_prompt": "language",
    "build_seedance2_prompt_draft": "language",
    "build_seedance2_prompt_composer_task": "language",
    "_seedance2_default_prompt": "language",
    "_seedance2_prompt_inputs_hash": "language",
}


def test_every_production_call_passes_the_project_language():
    missing: list[str] = []
    seen: set[str] = set()
    for path in SRC.rglob("*.py"):
        for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
            if not isinstance(node, ast.Call):
                continue
            name = getattr(node.func, "id", None) or getattr(node.func, "attr", None)
            keywords = {keyword.arg for keyword in node.keywords}
            # ``**kwargs`` forwards whatever the checked caller supplied.
            if name not in _LANGUAGE_ARGUMENT or None in keywords:
                continue
            seen.add(name)
            if _LANGUAGE_ARGUMENT[name] not in keywords:
                missing.append(f"{path.relative_to(SRC)}:{node.lineno} {name}")

    assert missing == []
    assert seen == set(_LANGUAGE_ARGUMENT)


def test_no_production_code_detects_a_language():
    for path in SRC.rglob("*.py"):
        text = path.read_text(encoding="utf-8")
        assert "detect_asset_language" not in text, path
        assert not any(
            line.startswith(("import langid", "from langdetect", "import wordninja"))
            for line in text.splitlines()
        ), path


def test_english_instruction_keeps_prose_english_and_names_verbatim():
    instruction = asset_language_instruction("en")

    assert "English" in instruction
    assert "verbatim" in instruction


def test_chinese_instruction_keeps_prose_chinese_and_names_unchanged():
    instruction = asset_language_instruction("zh")

    assert "中文" in instruction
    assert "原样" in instruction

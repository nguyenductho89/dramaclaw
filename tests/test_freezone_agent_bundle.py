from __future__ import annotations

import json
from pathlib import Path

import pytest

from novelvideo.freezone import agent_bundle_store
from novelvideo.freezone import agent_config_store


def _skill_payload(item_id: str = "community-video", **overrides) -> dict:
    payload = {
        "schema_version": "dramaclaw.workflow-skill.v1",
        "id": item_id,
        "name": "Community Video Skill",
        "version": "1.0.0",
        "description": "Dynamically generate a community video workflow from the user's assets.",
        "category": "video",
        "triggers": {"keywords": ["community video"], "node_scopes": ["textGeneration", "imageGeneration"]},
        "input_parameters": [
            {
                "id": "aspect_ratio",
                "label": "Aspect ratio",
                "type": "single_select",
                "required": True,
                "default": "16:9",
                "options": ["16:9", "1:1"],
            }
        ],
        "allowed_recipe_ids": ["community-brief"],
        "planning": {
            "planning_notes": "Dynamic execution path: decide the text planning and image generation stages from the user input and assets.",
            "prompt_guide": "Keep the output in the user's language.",
            "conduct_rules": ["Wait for user confirmation before high-cost generation."],
        },
        "evaluation": {
            "rating_bands": [{"score": 5, "description": "Usable result"}],
            "quality_threshold": 4,
            "domain_constraints": ["Do not invent facts about the user's assets"],
        },
    }
    payload.update(overrides)
    return payload


def _recipe_payload(item_id: str = "community-brief", **overrides) -> dict:
    payload = {
        "schema_version": "dramaclaw.recipe.v1",
        "id": item_id,
        "name": "Community Brief",
        "version": "1.0.0",
        "output_kind": "text",
        "action_keys": ["community-brief"],
        "system_prompt": "Generate the final video brief directly from the user input.",
        "must_have_items": ["Theme", "Aspect ratio"],
        "planning_prompt": "Generate the final video brief from the user goal.",
        "result_summary": "Final video brief.",
    }
    payload.update(overrides)
    return payload


def _bundle_payload(**overrides) -> dict:
    payload = {
        "schema_version": "dramaclaw.skill-bundle.v1",
        "id": "community-video",
        "name": "Community Video Skill",
        "version": "1.0.0",
        "description": "Community video dynamic workflow.",
        "author": "DramaClaw",
        "license": "CC-BY-4.0",
        "min_dramaclaw_version": "1.0.0",
        "tags": ["video", "community"],
        "skill": _skill_payload(),
        "recipes": [_recipe_payload()],
    }
    payload.update(overrides)
    return payload


def _legal_payload() -> dict:
    return {
        "copyright": "2026 SuperTale contributors",
        "license": {
            "id": "Elastic-2.0",
            "text": "Elastic License 2.0 terms.",
        },
        "notice": "DramaClaw trademark rights are reserved.",
    }


@pytest.fixture
def isolated_catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins")
    monkeypatch.setattr(agent_bundle_store, "CURRENT_DRAMACLAW_VERSION", "2.0.0")
    return tmp_path


def test_validate_agent_bundle_accepts_skill_and_recipes(isolated_catalog: Path) -> None:
    result = agent_bundle_store.validate_agent_bundle(_bundle_payload())

    assert result["bundle"]["id"] == "community-video"
    assert result["skill_count"] == 1
    assert result["recipe_count"] == 1
    assert result["warnings"] == []


def test_validate_agent_bundle_preserves_structured_legal_metadata(isolated_catalog: Path) -> None:
    legal = _legal_payload()

    result = agent_bundle_store.validate_agent_bundle(
        _bundle_payload(license=legal["license"]["id"], legal=legal)
    )

    assert result["bundle"]["legal"] == legal


def test_validate_agent_bundle_rejects_mismatched_legal_license_id(
    isolated_catalog: Path,
) -> None:
    with pytest.raises(ValueError, match="license must match legal.license.id"):
        agent_bundle_store.validate_agent_bundle(
            _bundle_payload(license="MIT", legal=_legal_payload())
        )


def test_validate_agent_bundle_rejects_missing_recipe_reference(isolated_catalog: Path) -> None:
    bundle = _bundle_payload(recipes=[])

    with pytest.raises(ValueError, match="missing referenced Recipes"):
        agent_bundle_store.validate_agent_bundle(bundle)


def test_validate_agent_bundle_rejects_high_minimum_dramaclaw_version(
    isolated_catalog: Path,
) -> None:
    bundle = _bundle_payload(min_dramaclaw_version="99.0.0")

    with pytest.raises(ValueError, match="requires DramaClaw >= 99.0.0"):
        agent_bundle_store.validate_agent_bundle(bundle)


def test_validate_agent_bundle_rejects_dangerous_fields(isolated_catalog: Path) -> None:
    bundle = _bundle_payload(script="echo bad")

    with pytest.raises(ValueError, match="dangerous Bundle field"):
        agent_bundle_store.validate_agent_bundle(bundle)


def test_validate_agent_bundle_rejects_secrets(isolated_catalog: Path) -> None:
    recipe = _recipe_payload(system_prompt="Please use sk-live-secret to generate the prompt")
    bundle = _bundle_payload(recipes=[recipe])

    with pytest.raises(ValueError, match="possible secret"):
        agent_bundle_store.validate_agent_bundle(bundle)


def test_validate_agent_bundle_rejects_supplier_model_names(isolated_catalog: Path) -> None:
    recipe = _recipe_payload(system_prompt="Please always use gpt-image-2 to generate")
    bundle = _bundle_payload(recipes=[recipe])

    with pytest.raises(ValueError, match="supplier model name"):
        agent_bundle_store.validate_agent_bundle(bundle)


def test_install_agent_bundle_saves_user_skill_and_recipes(isolated_catalog: Path) -> None:
    result = agent_bundle_store.install_agent_bundle(username="alice", payload=_bundle_payload())

    assert result["installed_skill"] == "community-video"
    assert result["installed_recipes"] == ["community-brief"]
    skill_path = (
        isolated_catalog
        / "alice"
        / "_account"
        / "freezone"
        / "agent_config"
        / "skills"
        / "community-video.json"
    )
    recipe_path = (
        isolated_catalog
        / "alice"
        / "_account"
        / "freezone"
        / "agent_config"
        / "recipes"
        / "community-brief.json"
    )
    assert json.loads(skill_path.read_text(encoding="utf-8"))["id"] == "community-video"
    assert json.loads(recipe_path.read_text(encoding="utf-8"))["id"] == "community-brief"


def test_install_and_export_preserve_structured_legal_metadata(isolated_catalog: Path) -> None:
    legal = _legal_payload()
    agent_bundle_store.install_agent_bundle(
        username="alice",
        payload=_bundle_payload(license=legal["license"]["id"], legal=legal),
    )

    stored_skill_path = (
        isolated_catalog
        / "alice"
        / "_account"
        / "freezone"
        / "agent_config"
        / "skills"
        / "community-video.json"
    )
    stored_skill = json.loads(stored_skill_path.read_text(encoding="utf-8"))
    assert stored_skill["_catalog_bundle_legal"] == legal

    exported = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={},
    )
    assert exported["legal"] == legal


def test_install_and_export_legacy_bundle_omits_legal_field(isolated_catalog: Path) -> None:
    agent_bundle_store.install_agent_bundle(username="alice", payload=_bundle_payload())

    exported = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={},
    )

    assert "legal" not in exported


def test_export_agent_bundle_preserves_imported_bundle_metadata(isolated_catalog: Path) -> None:
    bundle = _bundle_payload(
        author="Original Creator",
        license="CC-BY-NC-4.0",
        version="2.1.0",
        min_dramaclaw_version="1.0.0",
        tags=["imported", "community"],
    )
    agent_bundle_store.install_agent_bundle(username="alice", payload=bundle)

    exported = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={
            "id": "community-video",
            "name": "My local display name",
            "version": "9.9.9",
            "description": "Local export default description",
            "author": "Local User",
            "license": "Proprietary",
            "min_dramaclaw_version": "1.0.0",
            "tags": ["local"],
        },
    )

    assert exported["name"] == "Community Video Skill"
    assert exported["version"] == "2.1.0"
    assert exported["author"] == "Original Creator"
    assert exported["license"] == "CC-BY-NC-4.0"
    assert exported["tags"] == ["imported", "community"]


def test_export_agent_bundle_uses_default_author_and_license(isolated_catalog: Path) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("community-video"),
    )

    bundle = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={
            "id": "community-video",
            "name": "Community Video Skill",
            "version": "1.0.0",
            "description": "Community video dynamic workflow.",
            "author": "",
            "license": "",
            "min_dramaclaw_version": "1.0.0",
        },
    )

    assert bundle["author"] == "alice"
    assert bundle["license"] == "Proprietary"


def test_export_agent_bundle_uses_current_version_when_minimum_is_missing(
    isolated_catalog: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_bundle_store, "current_dramaclaw_version", lambda: "1.1.2")
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("community-video"),
    )

    bundle = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={
            "id": "community-video",
            "name": "Community Video Skill",
            "version": "1.0.0",
            "description": "Community video dynamic workflow.",
            "author": "",
            "license": "",
        },
    )

    assert bundle["min_dramaclaw_version"] == "1.1.2"


def test_export_builtin_agent_bundle_uses_dramaclaw_author(isolated_catalog: Path) -> None:
    builtin_root = isolated_catalog / "builtins"
    skill_root = builtin_root / "skills"
    recipe_root = builtin_root / "recipes"
    skill_root.mkdir(parents=True)
    recipe_root.mkdir(parents=True)
    (skill_root / "community-video.json").write_text(
        json.dumps(_skill_payload("community-video"), ensure_ascii=False),
        encoding="utf-8",
    )
    (recipe_root / "community-brief.json").write_text(
        json.dumps(_recipe_payload("community-brief"), ensure_ascii=False),
        encoding="utf-8",
    )

    bundle = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={
            "id": "community-video",
            "name": "Community Video Skill",
            "version": "1.0.0",
            "description": "Community video dynamic workflow.",
            "author": "",
            "license": "",
            "min_dramaclaw_version": "1.0.0",
        },
    )

    assert bundle["author"] == "DramaClaw"
    assert bundle["license"] == "Proprietary"


def test_install_agent_bundle_rejects_existing_skill_id(isolated_catalog: Path) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("community-video"),
    )

    with pytest.raises(ValueError, match="already exists"):
        agent_bundle_store.install_agent_bundle(username="alice", payload=_bundle_payload())


def test_install_agent_bundle_reuses_identical_existing_recipe(isolated_catalog: Path) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief"),
    )
    bundle = _bundle_payload(
        id="second-video",
        skill=_skill_payload("second-video", allowed_recipe_ids=["community-brief"]),
    )

    result = agent_bundle_store.install_agent_bundle(username="alice", payload=bundle)

    assert result["installed_skill"] == "second-video"
    assert result["installed_recipes"] == []
    assert result["reused_recipes"] == ["community-brief"]
    saved_skill = agent_config_store.list_user_agent_config_items("alice", "skills")[0]
    assert saved_skill["allowed_recipe_ids"] == ["community-brief"]


def test_install_agent_bundle_renames_conflicting_recipe_and_rewrites_skill_reference(
    isolated_catalog: Path,
) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief", system_prompt="A different prompt already exists locally."),
    )
    bundle = _bundle_payload(
        id="second-video",
        skill=_skill_payload("second-video", allowed_recipe_ids=["community-brief"]),
    )

    result = agent_bundle_store.install_agent_bundle(username="alice", payload=bundle)

    assert result["installed_skill"] == "second-video"
    assert result["installed_recipes"] == ["community-brief--second-video"]
    assert result["reused_recipes"] == []
    saved_skill = agent_config_store.list_user_agent_config_items("alice", "skills")[0]
    assert saved_skill["allowed_recipe_ids"] == ["community-brief--second-video"]
    recipe_ids = {
        item["id"] for item in agent_config_store.list_user_agent_config_items("alice", "recipes")
    }
    assert {"community-brief", "community-brief--second-video"} <= recipe_ids


def test_install_agent_bundle_reuses_existing_renamed_recipe_when_content_matches(
    isolated_catalog: Path,
) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief", system_prompt="A different prompt already exists locally."),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief--second-video"),
    )
    bundle = _bundle_payload(
        id="second-video",
        skill=_skill_payload("second-video", allowed_recipe_ids=["community-brief"]),
    )

    result = agent_bundle_store.install_agent_bundle(username="alice", payload=bundle)

    assert result["installed_recipes"] == []
    assert result["reused_recipes"] == ["community-brief--second-video"]
    saved_skill = agent_config_store.list_user_agent_config_items("alice", "skills")[0]
    assert saved_skill["allowed_recipe_ids"] == ["community-brief--second-video"]


def test_install_agent_bundle_increments_recipe_suffix_until_available(
    isolated_catalog: Path,
) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief", system_prompt="A different prompt already exists locally."),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief--second-video", system_prompt="Another different prompt."),
    )
    bundle = _bundle_payload(
        id="second-video",
        skill=_skill_payload("second-video", allowed_recipe_ids=["community-brief"]),
    )

    result = agent_bundle_store.install_agent_bundle(username="alice", payload=bundle)

    assert result["installed_recipes"] == ["community-brief--second-video-2"]
    saved_skill = agent_config_store.list_user_agent_config_items("alice", "skills")[0]
    assert saved_skill["allowed_recipe_ids"] == ["community-brief--second-video-2"]


def test_export_agent_bundle_includes_allowed_recipes(isolated_catalog: Path) -> None:
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("community-brief"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("community-video"),
    )

    bundle = agent_bundle_store.export_agent_bundle(
        username="alice",
        skill_id="community-video",
        bundle_meta={
            "id": "community-video",
            "name": "Community Video Skill",
            "version": "1.0.0",
            "description": "Community video dynamic workflow.",
            "author": "DramaClaw",
            "license": "CC-BY-4.0",
            "min_dramaclaw_version": "1.0.0",
        },
    )

    assert bundle["schema_version"] == "dramaclaw.skill-bundle.v1"
    assert bundle["skill"]["id"] == "community-video"
    assert [recipe["id"] for recipe in bundle["recipes"]] == ["community-brief"]

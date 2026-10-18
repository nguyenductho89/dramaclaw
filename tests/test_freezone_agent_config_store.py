from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from novelvideo.freezone import agent_config_store


def _skill_payload(
    item_id: str,
    *,
    description: str | None = None,
    category: str = "general",
    enabled: bool = True,
) -> dict:
    return {
        "schema_version": "dramaclaw.workflow-skill.v1",
        "id": item_id,
        "name": item_id,
        "version": "1.0.0",
        "enabled": enabled,
        "description": description or item_id,
        "category": category,
        "triggers": {"keywords": [item_id], "node_scopes": ["textGeneration"]},
        "allowed_recipe_ids": ["test-recipe"],
        "planning": {
            "planning_notes": "Plan dynamically from the user goal.",
            "prompt_guide": "",
            "conduct_rules": ["Create only the nodes this plan needs."],
        },
        "evaluation": {
            "rating_bands": [{"score": 10, "description": "Complete and usable result"}],
            "quality_threshold": 7,
            "domain_constraints": ["Follow the user goal"],
        },
    }


def _recipe_payload(item_id: str, *, name: str | None = None) -> dict:
    return {
        "schema_version": "dramaclaw.recipe.v1",
        "id": item_id,
        "name": name or item_id,
        "version": "1.0.0",
        "output_kind": "text",
        "action_keys": [item_id],
        "system_prompt": "Generate the final text result directly from the input.",
        "planning_prompt": "Generate the final text result from the user goal.",
        "result_summary": "Final text result.",
    }


def _save_test_recipe(username: str = "alice") -> None:
    agent_config_store.save_user_agent_config_item(
        username=username,
        kind="recipes",
        payload=_recipe_payload("test-recipe"),
    )


@pytest.fixture(autouse=True)
def isolated_project_catalog(tmp_path: Path, monkeypatch: pytest.MonkeyPatch):
    monkeypatch.setattr(
        agent_config_store,
        "PROJECT_AGENT_CATALOG_DIR",
        tmp_path / "project-catalog",
    )
    agent_config_store._CATALOG_CACHE.clear()
    yield
    agent_config_store._CATALOG_CACHE.clear()


def test_user_agent_config_items_are_account_scoped(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )
    _save_test_recipe()

    saved = agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("story-skill", description="Story rules"),
    )

    assert saved["id"] == "story-skill"
    target = (
        tmp_path
        / "alice"
        / "_account"
        / "freezone"
        / "agent_config"
        / "skills"
        / "story-skill.json"
    )
    assert target.exists()
    assert json.loads(target.read_text(encoding="utf-8"))["description"] == "Story rules"

    listed = agent_config_store.list_user_agent_config_items("alice", "skills")
    assert [item["id"] for item in listed] == ["story-skill"]
    assert agent_config_store.list_user_agent_config_items("bob", "skills") == []


def test_agent_config_items_include_builtin_catalog_with_user_override(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    skill_root = builtin_root / "skills"
    skill_root.mkdir(parents=True)
    (skill_root / "story-skill.json").write_text(
        json.dumps(
            _skill_payload("story-skill", description="Built-in story rules"),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (skill_root / "image-skill.json").write_text(
        json.dumps(
            _skill_payload("image-skill", description="Built-in image rules", category="image"),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    _save_test_recipe()
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload(
            "story-skill",
            description="User story rules",
            category="custom",
        ),
    )

    listed = agent_config_store.list_user_agent_config_items("alice", "skills")

    assert [item["id"] for item in listed] == ["story-skill", "image-skill"]
    assert listed[0]["description"] == "User story rules"
    assert listed[0]["_catalog_source"] == "user"
    assert listed[0]["_catalog_base_source"] == "builtin"
    assert listed[1]["_catalog_source"] == "builtin"


def test_project_catalog_overrides_builtin_and_supports_array_files(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    project_root = tmp_path / "project-catalog"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    monkeypatch.setattr(agent_config_store, "PROJECT_AGENT_CATALOG_DIR", project_root)
    (builtin_root / "skills").mkdir(parents=True)
    (project_root / "skills").mkdir(parents=True)
    (project_root / "recipes").mkdir(parents=True)
    (builtin_root / "skills" / "video-skill.json").write_text(
        json.dumps(_skill_payload("video-skill", description="Old name")),
        encoding="utf-8",
    )
    (project_root / "skills" / "video-skill.json").write_text(
        json.dumps(
            {
                **_skill_payload("video-skill", description="Project name"),
                "name": "Project name",
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    (project_root / "recipes" / "bundle.json").write_text(
        json.dumps([_recipe_payload("recipe-a"), _recipe_payload("recipe-b")]),
        encoding="utf-8",
    )

    skills = agent_config_store.list_user_agent_config_items("alice", "skills")
    recipes = agent_config_store.list_user_agent_config_items("alice", "recipes")

    assert skills[0]["name"] == "Project name"
    assert [item["id"] for item in recipes] == ["recipe-a", "recipe-b"]


def test_agent_config_cache_invalidates_when_catalog_file_changes(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    skill_root = builtin_root / "skills"
    skill_root.mkdir(parents=True)
    target = skill_root / "story-skill.json"
    target.write_text(
        json.dumps(
            _skill_payload("story-skill", description="First version"), ensure_ascii=False
        ),
        encoding="utf-8",
    )

    first = agent_config_store.list_user_agent_config_items("alice", "skills")
    assert first[0]["description"] == "First version"
    first[0]["description"] = "The caller must not pollute the cache"

    target.write_text(
        json.dumps(
            _skill_payload("story-skill", description="Second version, longer"), ensure_ascii=False
        ),
        encoding="utf-8",
    )

    second = agent_config_store.list_user_agent_config_items("alice", "skills")
    assert second[0]["description"] == "Second version, longer"


def test_builtin_agent_config_item_can_be_hidden_by_user_overlay(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    skill_root = builtin_root / "skills"
    skill_root.mkdir(parents=True)
    (skill_root / "story-skill.json").write_text(
        json.dumps(
            _skill_payload("story-skill", description="Built-in story rules"),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    deleted = agent_config_store.delete_user_agent_config_item(
        username="alice",
        kind="skills",
        item_id="story-skill",
    )

    assert deleted is True
    assert agent_config_store.list_user_agent_config_items("alice", "skills") == []
    overlay_path = (
        tmp_path
        / "alice"
        / "_account"
        / "freezone"
        / "agent_config"
        / "skills"
        / "story-skill.json"
    )
    assert json.loads(overlay_path.read_text(encoding="utf-8")) == {
        "id": "story-skill",
        "hidden": True,
    }


def test_builtin_agent_config_item_merges_partial_user_overlay(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    skill_root = builtin_root / "skills"
    skill_root.mkdir(parents=True)
    (skill_root / "story-skill.json").write_text(
        json.dumps(
            _skill_payload("story-skill", description="Built-in story rules"),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload(
            "story-skill",
            description="Built-in story rules",
            enabled=False,
        ),
    )

    listed = agent_config_store.list_user_agent_config_items("alice", "skills")

    assert len(listed) == 1
    assert listed[0]["id"] == "story-skill"
    assert listed[0]["description"] == "Built-in story rules"
    assert listed[0]["enabled"] is False
    assert listed[0]["_catalog_source"] == "user"
    assert listed[0]["_catalog_base_source"] == "builtin"


def test_agent_config_items_sort_user_then_customized_then_builtin_by_mtime(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    skill_root = builtin_root / "skills"
    skill_root.mkdir(parents=True)
    for item_id in ["builtin-a", "custom-a", "custom-b"]:
        (skill_root / f"{item_id}.json").write_text(
            json.dumps(_skill_payload(item_id), ensure_ascii=False),
            encoding="utf-8",
        )

    _save_test_recipe()
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("custom-a", description="Custom old"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("user-old", description="User old"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("custom-b", description="Custom new"),
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=_skill_payload("user-new", description="User new"),
    )
    user_root = agent_config_store.user_agent_config_dir("alice", "skills")
    mtimes = {
        "custom-a": 10,
        "user-old": 20,
        "custom-b": 30,
        "user-new": 40,
    }
    for item_id, mtime in mtimes.items():
        os.utime(user_root / f"{item_id}.json", (mtime, mtime))

    listed = agent_config_store.list_user_agent_config_items("alice", "skills")

    assert [item["id"] for item in listed] == [
        "user-new",
        "user-old",
        "custom-b",
        "custom-a",
        "builtin-a",
    ]
    assert listed[0]["_catalog_source"] == "user"
    assert "_catalog_base_source" not in listed[0]
    assert listed[2]["_catalog_base_source"] == "builtin"
    assert listed[-1]["_catalog_source"] == "builtin"


def test_invalid_builtin_catalog_files_are_ignored(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    builtin_root = tmp_path / "agent_catalog" / "builtins"
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", builtin_root)
    recipe_root = builtin_root / "recipes"
    recipe_root.mkdir(parents=True)
    (recipe_root / "bad.json").write_text('{"id": "../bad"}', encoding="utf-8")
    (recipe_root / "not-json.json").write_text("{", encoding="utf-8")
    (recipe_root / "valid-recipe.json").write_text(
        json.dumps(
            _recipe_payload("valid-recipe", name="Built-in Recipe"),
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    listed = agent_config_store.list_user_agent_config_items("alice", "recipes")

    assert [item["id"] for item in listed] == ["valid-recipe"]
    assert listed[0]["_catalog_source"] == "builtin"


def test_user_agent_config_item_rejects_unsafe_ids(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )

    with pytest.raises(ValueError, match="invalid agent config id"):
        agent_config_store.save_user_agent_config_item(
            username="alice",
            kind="recipes",
            payload={"id": "../escape", "name": "bad"},
        )


def test_user_agent_config_item_can_be_deleted(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="recipes",
        payload=_recipe_payload("ad-recipe", name="Ad Recipe"),
    )

    deleted = agent_config_store.delete_user_agent_config_item(
        username="alice",
        kind="recipes",
        item_id="ad-recipe",
    )

    assert deleted is True
    assert agent_config_store.list_user_agent_config_items("alice", "recipes") == []


def test_enabled_skill_rejects_unavailable_recipe_reference(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )

    with pytest.raises(ValueError, match="references unavailable recipe"):
        agent_config_store.save_user_agent_config_item(
            username="alice",
            kind="skills",
            payload=_skill_payload("broken-skill"),
        )


def test_referenced_recipe_requires_disabling_skill_before_delete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )
    _save_test_recipe()
    skill = _skill_payload("story-skill")
    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload=skill,
    )

    with pytest.raises(ValueError, match="referenced by skill"):
        agent_config_store.delete_user_agent_config_item(
            username="alice",
            kind="recipes",
            item_id="test-recipe",
        )

    agent_config_store.save_user_agent_config_item(
        username="alice",
        kind="skills",
        payload={**skill, "enabled": False},
    )
    assert agent_config_store.delete_user_agent_config_item(
        username="alice",
        kind="recipes",
        item_id="test-recipe",
    )


def test_user_agent_config_delete_missing_item_is_idempotent(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )

    deleted = agent_config_store.delete_user_agent_config_item(
        username="alice",
        kind="skills",
        item_id="missing-skill",
    )

    assert deleted is False


def test_text_skill_studio_draft_saves_final_text_recipe_and_reference(
    tmp_path, monkeypatch
) -> None:
    from novelvideo.api.routes import chat as chat_route

    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(
        agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins"
    )
    monkeypatch.setattr(
        chat_route, "_canvas_bridge_dir", lambda *_args, **_kwargs: tmp_path / "bridge"
    )
    monkeypatch.setattr(
        chat_route, "sync_freezone_hermes_workflow_skills", lambda *_args: None
    )
    recipe = _recipe_payload("chinese-condense")
    recipe["system_prompt"] = (
        "[Role] A copy editor. [Input sources] The user's original text. [Task goal] Directly output a one-sentence summary."
        "[Output structure requirements] Output only the final summary. [Quality standards] Keep the people, time, place and events."
        "[Prohibitions / constraints] Do not add facts."
    )
    skill = _skill_payload("chinese-condense-skill")
    skill["allowed_recipe_ids"] = [recipe["id"]]

    result = chat_route._resolve_skill_studio_tool_result_payload(
        chat_route.SkillStudioToolResultIn(
            bridge_key="condense-save",
            turn_id="condense-turn",
            action="confirm_add",
            skill_studio_status="catalog_saved",
            saved_to_catalog=True,
            draft={"skill": skill, "recipes": [recipe]},
        ),
        username="alice",
    )

    assert result["ok"] is True
    assert result["saved_skill_ids"] == [skill["id"]]
    assert result["saved_recipe_ids"] == [recipe["id"]]
    recipes = agent_config_store.list_user_agent_config_items("alice", "recipes")
    skills = agent_config_store.list_user_agent_config_items("alice", "skills")
    assert any(item["id"] == recipe["id"] for item in recipes)
    saved_skill = next(item for item in skills if item["id"] == skill["id"])
    assert saved_skill["allowed_recipe_ids"] == [recipe["id"]]

    recipe["system_prompt"] = "will be fed into downstream textGeneration"
    with pytest.raises(ValueError, match="final deliverable"):
        agent_config_store.save_user_agent_config_item(
            username="alice", kind="recipes", payload=recipe
        )

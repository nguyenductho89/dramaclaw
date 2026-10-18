from __future__ import annotations

from fastapi import FastAPI
from fastapi.testclient import TestClient

import pytest


def _skill_payload() -> dict:
    return {
        "schema_version": "dramaclaw.workflow-skill.v1",
        "id": "community-video",
        "name": "Community Video Skill",
        "version": "1.0.0",
        "description": "Dynamically generates a community video workflow from the user's assets.",
        "category": "video",
        "triggers": {"keywords": ["community video"], "node_scopes": ["textGeneration"]},
        "allowed_recipe_ids": ["community-brief"],
        "planning": {
            "planning_notes": "Dynamic execution path: decide the text planning stage from the user input and assets.",
            "prompt_guide": "Keep the output in English.",
            "conduct_rules": ["Wait for user confirmation before high-cost generation."],
        },
        "evaluation": {
            "rating_bands": [{"score": 5, "description": "Result is usable"}],
            "quality_threshold": 4,
            "domain_constraints": ["Do not fabricate facts about the user's assets"],
        },
    }


def _recipe_payload() -> dict:
    return {
        "schema_version": "dramaclaw.recipe.v1",
        "id": "community-brief",
        "name": "Community brief",
        "version": "1.0.0",
        "output_kind": "text",
        "action_keys": ["community-brief"],
        "system_prompt": "Generate the final video brief directly from the user input.",
        "must_have_items": ["Theme"],
        "planning_prompt": "Generate the video brief prompt from the user goal.",
        "result_summary": "Video brief prompt.",
    }


def _bundle_payload() -> dict:
    return {
        "schema_version": "dramaclaw.skill-bundle.v1",
        "id": "community-video",
        "name": "Community Video Skill",
        "version": "1.0.0",
        "description": "Community video dynamic workflow.",
        "author": "DramaClaw",
        "license": "CC-BY-4.0",
        "min_dramaclaw_version": "1.0.0",
        "tags": ["video"],
        "skill": _skill_payload(),
        "recipes": [_recipe_payload()],
    }


@pytest.fixture()
def bundle_client(monkeypatch, tmp_path) -> TestClient:
    from novelvideo.api.auth import get_api_user
    from novelvideo.api.routes import freezone
    from novelvideo.freezone import agent_bundle_store
    from novelvideo.freezone import agent_config_store

    monkeypatch.setattr(agent_config_store, "OUTPUT_DIR", str(tmp_path))
    monkeypatch.setattr(agent_config_store, "BUILTIN_AGENT_CATALOG_DIR", tmp_path / "builtins")
    monkeypatch.setattr(
        agent_config_store,
        "PROJECT_AGENT_CATALOG_DIR",
        tmp_path / "project-catalog",
    )
    monkeypatch.setattr(agent_bundle_store, "CURRENT_DRAMACLAW_VERSION", "2.0.0")

    app = FastAPI()
    app.include_router(freezone.router, prefix="/api/v1")
    app.dependency_overrides[get_api_user] = lambda: {
        "id": "u-alice",
        "username": "alice",
    }
    return TestClient(app)


def test_validate_bundle_api_does_not_install(bundle_client: TestClient) -> None:
    response = bundle_client.post(
        "/api/v1/freezone/agent-config/bundles:validate",
        json={"bundle": _bundle_payload()},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["data"]["bundle_id"] == "community-video"
    assert body["data"]["recipe_count"] == 1
    listed = bundle_client.get("/api/v1/freezone/agent-config/skills").json()["data"]
    assert listed == []


def test_install_bundle_api_saves_skill_and_recipes(bundle_client: TestClient) -> None:
    response = bundle_client.post(
        "/api/v1/freezone/agent-config/bundles:install",
        json={"bundle": _bundle_payload()},
    )

    assert response.status_code == 200, response.text
    assert response.json()["data"] == {
        "bundle_id": "community-video",
        "installed_skill": "community-video",
        "installed_recipes": ["community-brief"],
        "reused_recipes": [],
    }
    skills = bundle_client.get("/api/v1/freezone/agent-config/skills").json()["data"]
    recipes = bundle_client.get("/api/v1/freezone/agent-config/recipes").json()["data"]
    assert [item["id"] for item in skills] == ["community-video"]
    assert [item["id"] for item in recipes] == ["community-brief"]


def test_export_bundle_api_returns_skill_with_recipes(bundle_client: TestClient) -> None:
    install = bundle_client.post(
        "/api/v1/freezone/agent-config/bundles:install",
        json={"bundle": _bundle_payload()},
    )
    assert install.status_code == 200, install.text

    response = bundle_client.post(
        "/api/v1/freezone/agent-config/bundles:export",
        json={
            "skill_id": "community-video",
            "bundle": {
                "id": "community-video",
                "name": "Community Video Skill",
                "version": "1.0.0",
                "description": "Community video dynamic workflow.",
                "author": "DramaClaw",
                "license": "CC-BY-4.0",
                "min_dramaclaw_version": "1.0.0",
            },
        },
    )

    assert response.status_code == 200, response.text
    bundle = response.json()["data"]
    assert bundle["schema_version"] == "dramaclaw.skill-bundle.v1"
    assert bundle["skill"]["id"] == "community-video"
    assert [recipe["id"] for recipe in bundle["recipes"]] == ["community-brief"]


def test_bundle_api_round_trips_structured_legal_metadata(bundle_client: TestClient) -> None:
    legal = {
        "copyright": "2026 SuperTale contributors",
        "license": {
            "id": "Elastic-2.0",
            "text": "Elastic License 2.0 terms.",
        },
        "notice": "DramaClaw trademark rights are reserved.",
    }
    install = bundle_client.post(
        "/api/v1/freezone/agent-config/bundles:install",
        json={
            "bundle": {
                **_bundle_payload(),
                "license": legal["license"]["id"],
                "legal": legal,
            }
        },
    )
    assert install.status_code == 200, install.text

    response = bundle_client.post(
        "/api/v1/freezone/agent-config/bundles:export",
        json={"skill_id": "community-video", "bundle": {}},
    )

    assert response.status_code == 200, response.text
    assert response.json()["data"]["legal"] == legal


def test_community_catalog_endpoints_are_not_exposed(bundle_client: TestClient) -> None:
    catalog = bundle_client.get("/api/v1/freezone/agent-config/community/catalog")
    install = bundle_client.post(
        "/api/v1/freezone/agent-config/community/bundles:install",
        json={"bundle_url": "https://example.com/bundle.json"},
    )

    assert catalog.status_code in {404, 405}
    assert install.status_code in {404, 405}

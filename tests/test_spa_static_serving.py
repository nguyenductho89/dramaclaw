"""Contract of SPA static serving gated by DRAMACLAW_FRONTEND_DIST.

When Starlette StaticFiles misses it raises HTTPException(404) rather than returning a 404
response; the SPA fallback must catch it. Deep links / refreshed client routes must get index.html,
while missing static assets (with an extension) should still honestly 404.
"""

from pathlib import Path

import pytest

pytestmark = pytest.mark.m07


@pytest.fixture()
def spa_client(tmp_path: Path, monkeypatch):
    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<html>SPA-SHELL</html>", encoding="utf-8")
    (dist / "assets" / "app.js").write_text("console.log(1)", encoding="utf-8")
    monkeypatch.setenv("DRAMACLAW_FRONTEND_DIST", str(dist))

    from starlette.testclient import TestClient

    from novelvideo.api.app import create_app

    return TestClient(create_app(), raise_server_exceptions=False)


def test_root_serves_index(spa_client):
    r = spa_client.get("/")
    assert r.status_code == 200
    assert "SPA-SHELL" in r.text


def test_real_asset_is_served(spa_client):
    r = spa_client.get("/assets/app.js")
    assert r.status_code == 200
    assert r.text == "console.log(1)"


def test_deep_link_falls_back_to_index(spa_client):
    r = spa_client.get("/projects/abc/ingest")
    assert r.status_code == 200
    assert "SPA-SHELL" in r.text


def test_missing_asset_with_extension_stays_404(spa_client):
    assert spa_client.get("/missing.js").status_code == 404


def test_api_routes_take_precedence(spa_client):
    r = spa_client.get("/api/v1/config")
    assert r.status_code == 200
    assert r.json()["ok"] is True

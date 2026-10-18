# SPDX-License-Identifier: Elastic-2.0
# Copyright (c) 2026 ClaymoreLab
"""Style manifest loader: external override, broken-manifest fallback, cache invalidation after in-place replacement."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from novelvideo.freezone import style_templates as manifest


@pytest.fixture(autouse=True)
def _clean_manifest_cache(monkeypatch: pytest.MonkeyPatch):
    monkeypatch.delenv(manifest.MANIFEST_ENV, raising=False)
    manifest.reset_style_template_cache()
    yield
    manifest.reset_style_template_cache()


def _write_manifest(path: Path, templates: list[dict], version: str = "test-1") -> Path:
    path.write_text(
        json.dumps({"version": version, "templates": templates}, ensure_ascii=False),
        encoding="utf-8",
    )
    return path


def _builtin_ids() -> list[str]:
    """Read the id list directly from the built-in manifest file.

    The "falls back to the built-in manifest" assertion used to hard-code 24, requiring three numbers to be changed with every batch of styles added, while what it wants to express
    is actually "what is obtained is the built-in one". Changed to compare the id list: it neither drifts with the style count nor is looser than the count.
    """
    shipped = json.loads(manifest.BUILTIN_MANIFEST_PATH.read_text(encoding="utf-8"))
    return [item["id"] for item in shipped["templates"]]


def _template(template_id: str = "demo") -> dict:
    return {
        "id": template_id,
        "label": "Sample style",
        "category": "Urban",
        "cover": f"{template_id}/cover.webp",
        "samples": [f"{template_id}/female.webp"],
        "style_prompt": "Sample prompt",
    }


def test_builtin_manifest_ships_with_the_package() -> None:
    assert manifest.BUILTIN_MANIFEST_PATH.is_file()
    # What the loader reads out must match the file word for word -- if the validation step drops non-compliant entries,
    # there would be fewer here. The count has a separate lower bound to prevent a manifest truncated into an empty shell from passing quietly.
    assert [item["id"] for item in manifest.load_style_templates()] == _builtin_ids()
    assert len(_builtin_ids()) >= 24
    assert manifest.get_style_manifest_version()


def test_env_override_replaces_the_builtin_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = _write_manifest(tmp_path / "styles.json", [_template()])
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(path))
    manifest.reset_style_template_cache()

    assert [item["id"] for item in manifest.load_style_templates()] == ["demo"]
    assert manifest.get_style_manifest_version() == "test-1"


def test_missing_override_falls_back_to_the_builtin_manifest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(tmp_path / "nope.json"))
    manifest.reset_style_template_cache()

    assert [item["id"] for item in manifest.load_style_templates()] == _builtin_ids()


@pytest.mark.parametrize(
    "payload",
    [
        "{ not json",
        json.dumps({"templates": []}),
        json.dumps({"templates": [{"id": "a", "label": "Alpha"}]}),
        json.dumps({"templates": [{**_template("a"), "samples": [""]}]}),
        json.dumps({"templates": [_template("a"), _template("a")]}),
    ],
)
def test_broken_override_falls_back_instead_of_raising(
    payload: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "styles.json"
    path.write_text(payload, encoding="utf-8")
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(path))
    manifest.reset_style_template_cache()

    assert [item["id"] for item in manifest.load_style_templates()] == _builtin_ids()


def test_bare_array_manifest_is_accepted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    path = tmp_path / "styles.json"
    path.write_text(json.dumps([_template()], ensure_ascii=False), encoding="utf-8")
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(path))
    manifest.reset_style_template_cache()

    assert [item["id"] for item in manifest.load_style_templates()] == ["demo"]
    assert manifest.get_style_manifest_version() == ""


def test_replacing_the_file_in_place_takes_effect(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """After ops overrides the manifest file there is no need to restart the process -- the cache invalidates by mtime/size."""
    path = _write_manifest(tmp_path / "styles.json", [_template("before")])
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(path))
    manifest.reset_style_template_cache()
    assert [item["id"] for item in manifest.load_style_templates()] == ["before"]

    _write_manifest(path, [_template("after"), _template("extra")], version="test-2")

    assert [item["id"] for item in manifest.load_style_templates()] == [
        "after",
        "extra",
    ]
    assert manifest.get_style_manifest_version() == "test-2"


def test_samples_default_to_empty_when_absent(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    entry = _template()
    entry.pop("samples")
    path = _write_manifest(tmp_path / "styles.json", [entry])
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(path))
    manifest.reset_style_template_cache()

    assert manifest.load_style_templates()[0]["samples"] == []


def test_loaded_templates_are_not_shared_by_reference(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The list the caller gets can be modified freely without polluting the next request."""
    path = _write_manifest(tmp_path / "styles.json", [_template()])
    monkeypatch.setenv(manifest.MANIFEST_ENV, str(path))
    manifest.reset_style_template_cache()

    first = manifest.load_style_templates()
    first[0]["label"] = "A renamed label"
    first[0]["samples"].append("intruder.webp")
    first.clear()

    second = manifest.load_style_templates()
    assert len(second) == 1
    assert second[0]["label"] == _template()["label"]
    assert second[0]["samples"] == _template()["samples"]

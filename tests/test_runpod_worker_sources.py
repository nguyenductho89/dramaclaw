"""The RunPod worker image sources live in `runpod/` (moved here from the
photoreal-short-drama-generator repo, 2026-10-31). The images are big amd64/CUDA builds
that cannot be built on a laptop, so this checks the cheap things that break first:
every file a Dockerfile ADDs exists in the shared build context, and the build workflow
points at the same layout.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
CONTEXT = ROOT / "runpod"
IMAGES = ("h3", "qwen", "multishot")
WORKFLOW = ROOT / ".github" / "workflows" / "build-runpod-worker-image.yml"


def _add_sources(dockerfile: Path) -> list[str]:
    sources: list[str] = []
    for line in dockerfile.read_text(encoding="utf-8").splitlines():
        match = re.match(r"^(?:ADD|COPY)\s+(.+)$", line.strip())
        if match:
            parts = [p for p in match.group(1).split() if not p.startswith("--")]
            sources.extend(parts[:-1])  # the last token is the destination
    return sources


@pytest.mark.parametrize("image", IMAGES)
def test_dockerfile_sources_exist_in_the_shared_context(image):
    dockerfile = CONTEXT / image / "Dockerfile"
    assert dockerfile.is_file()
    sources = _add_sources(dockerfile)
    assert f"{image}/start.sh" in sources and "common/handler.py" in sources
    for source in sources:
        assert (CONTEXT / source).is_file(), f"{image}: ADD source {source} is missing"


def test_every_image_has_a_start_script_that_launches_comfyui_with_extra_args():
    for image in IMAGES:
        script = (CONTEXT / image / "start.sh").read_text(encoding="utf-8")
        # The Qwen start script used to launch ComfyUI without ${COMFY_EXTRA_ARGS}, so
        # endpoint-level flags (extra model paths for LoRAs) were silently ignored.
        assert "${COMFY_EXTRA_ARGS}" in script, image


def test_qwen_yaml_maps_loras_and_model_patches():
    text = (CONTEXT / "qwen" / "extra_model_paths.yaml").read_text(encoding="utf-8")
    assert "loras: models/loras/" in text
    assert "model_patches: models/model_patches/" in text


def test_workflow_matches_the_layout():
    text = WORKFLOW.read_text(encoding="utf-8")
    assert "context: runpod\n" in text
    assert "file: runpod/${{ inputs.image }}/Dockerfile" in text
    for image in IMAGES:
        assert f"- {image}\n" in text

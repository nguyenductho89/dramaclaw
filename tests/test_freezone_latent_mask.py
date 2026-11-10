"""Unit tests for the real latent-mask inpaint path added to Freezone (2026-11-10).

Before this, `/freezone/redraw` with a `mask_url` always took one route: the
red-highlight PNG went in as reference image #2 plus a prompt saying "edit only
the red region". The two RunPod Qwen graph builders
(`_runpod_qwen_edit_image_graph`, `_runpod_qwen21_render_image_graph`) have
accepted a real `mask_name` → `SetLatentNoiseMask` input the whole time, but
Freezone never passed one, so pixels outside the mask were only preserved as
well as the model felt like preserving them.

The piece that makes this non-trivial, and what most of these tests guard:
**Freezone's mask PNG cannot be handed to those graphs directly.** Both read it
with `ImageToMask(channel="red")`, while the PNG is the *source image under a
translucent red overlay* (`frontend/src/lib/mask-highlight.ts`) — so every
red-dominant pixel in the picture (a red jacket, warm skin, lunar regolith under
a warm key) would be read as "regenerate me". `mask_utils.red_highlight_to_binary_mask`
inverts the known blend to recover what the user actually painted.

No DB, no network, no GPU — the provider call is monkeypatched.
"""

from __future__ import annotations

import io
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from novelvideo.freezone import jobs as freezone_jobs
from novelvideo.freezone.mask_utils import (
    MASK_HIGHLIGHT_RGBA,
    MaskDerivationError,
    provider_supports_latent_mask,
    red_highlight_to_binary_mask,
)
from novelvideo.generators import nanobanana_grid

ALPHA = MASK_HIGHLIGHT_RGBA[3] / 255.0


def _png(arr: np.ndarray) -> bytes:
    buf = io.BytesIO()
    Image.fromarray(arr.astype(np.uint8)).save(buf, "PNG")
    return buf.getvalue()


def _base_with_red_region() -> np.ndarray:
    """A base image whose left half is red-dominant on purpose.

    This is the regression the whole module exists for: feeding the raw
    highlight PNG to `ImageToMask(channel="red")` would mark this half for
    regeneration even though the user never painted it.
    """
    base = np.zeros((48, 64, 3), np.uint8)
    base[:, :32] = (220, 40, 30)  # red jacket
    base[:, 32:] = (30, 120, 200)  # blue sky
    return base


def _paint(base: np.ndarray, region: np.ndarray) -> np.ndarray:
    """Reproduce `buildRedHighlightMaskBlob`: source-over of a constant
    rgba(255, 0, 0, 153) overlay on the painted region only."""
    out = base.astype(np.float32).copy()
    out[region] = base[region] * (1.0 - ALPHA) + np.array(
        MASK_HIGHLIGHT_RGBA[:3], np.float32
    ) * ALPHA
    return np.round(out)


def test_binary_mask_recovers_painted_region_over_red_content():
    base = _base_with_red_region()
    painted = np.zeros(base.shape[:2], bool)
    painted[8:20, 8:56] = True  # spans both the red and the blue half

    mask_png = red_highlight_to_binary_mask(_png(base), _png(_paint(base, painted)))
    mask_im = Image.open(io.BytesIO(mask_png))
    mask = np.asarray(mask_im)

    assert mask_im.mode == "L"
    # Both graphs read channel="red" off this image; anything but a clean 0/255
    # split becomes a partial denoise somewhere in the frame.
    assert set(np.unique(mask).tolist()) <= {0, 255}
    assert np.array_equal(mask > 0, painted)
    # The red half OUTSIDE the stroke must stay 0 — the actual regression.
    assert mask[20:, :32].max() == 0


def test_binary_mask_grow_widens_the_region():
    base = _base_with_red_region()
    painted = np.zeros(base.shape[:2], bool)
    painted[10:20, 10:30] = True
    args = (_png(base), _png(_paint(base, painted)))

    tight = np.asarray(Image.open(io.BytesIO(red_highlight_to_binary_mask(*args))))
    grown = np.asarray(
        Image.open(io.BytesIO(red_highlight_to_binary_mask(*args, grow_px=2)))
    )

    assert (grown > 0).sum() > (tight > 0).sum()
    assert np.all(grown[tight > 0] == 255)


@pytest.mark.parametrize(
    "make_pair, expected",
    [
        (lambda b: (b, b), "no painted region"),
        (lambda b: (np.full_like(b, 77), None), "does not match source"),
        (lambda b: (b, np.zeros((8, 8, 3), np.uint8)), "does not match source"),
    ],
)
def test_binary_mask_fails_loudly(make_pair, expected):
    """An unusable mask must raise, never return an empty mask: `SetLatentNoiseMask`
    with an all-zero mask silently produces "nothing changed", which reads to the
    user as a broken feature rather than a rejected input."""
    base = _base_with_red_region()
    painted = np.zeros(base.shape[:2], bool)
    painted[4:12, 4:12] = True
    highlight = _paint(base, painted)

    first, second = make_pair(base)
    with pytest.raises(MaskDerivationError, match=expected):
        red_highlight_to_binary_mask(
            _png(first), _png(highlight if second is None else second)
        )


def test_provider_gate():
    assert provider_supports_latent_mask("runpod_qwen_edit")
    assert provider_supports_latent_mask("runpod_qwen21_render")
    assert provider_supports_latent_mask(" RunPod_Qwen21_Render ")
    for provider in ("newapi", "gemini_webai", "huimeng", "openai", "", None):
        assert not provider_supports_latent_mask(provider)


def _write_pair(tmp_path: Path) -> tuple[Path, Path, int]:
    base = _base_with_red_region()
    painted = np.zeros(base.shape[:2], bool)
    painted[8:20, 8:56] = True
    base_path = tmp_path / "base.png"
    mask_path = tmp_path / "mask.png"
    base_path.write_bytes(_png(base))
    mask_path.write_bytes(_png(_paint(base, painted)))
    return base_path, mask_path, int(painted.sum())


def _stub_config(monkeypatch, provider: str) -> None:
    import novelvideo.config as config

    monkeypatch.setattr(
        config,
        "get_grid_generation_config",
        lambda **_kwargs: {
            "provider": provider,
            "model": "m",
            "api_key": "k",
            "base_url": "u",
            "mode": "1x1",
            "rows": 1,
            "cols": 1,
            "total_panels": 1,
        },
    )


def _capture_edit(monkeypatch) -> dict:
    captured: dict = {}

    async def fake_edit(**kwargs):
        captured.update(kwargs)
        Path(kwargs["output_path"]).write_bytes(b"\x89PNG\r\n\x1a\nstub")
        return Path(kwargs["output_path"])

    monkeypatch.setattr(nanobanana_grid, "generate_reference_edit_image", fake_edit)
    return captured


@pytest.mark.asyncio
async def test_mask_edit_latent_branch_for_runpod_qwen(monkeypatch, tmp_path: Path):
    base_path, mask_path, painted_px = _write_pair(tmp_path)
    _stub_config(monkeypatch, "runpod_qwen21_render")
    captured = _capture_edit(monkeypatch)

    await freezone_jobs.run_freezone_mask_edit(
        project_dir=tmp_path,
        job_id="job1",
        base_path=str(base_path),
        mask_path=str(mask_path),
        prompt="repaint the jacket blue",
        provider="runpod_qwen21_render",
        model="m",
    )

    # The mask is a mask, not a reference: the Qwen workers count references into
    # the 2 image2/image3 slots, so passing it there would burn one.
    assert captured["reference_images"] == [str(base_path)]
    assert captured["mask_image_path"]
    # The "Image 2 is the same image with a red highlight" wording is not merely
    # redundant here, it invites the model to draw an Image 2 that does not exist.
    assert captured["prompt"] == "repaint the jacket blue"
    assert "RED" not in captured["prompt"]

    derived = np.asarray(Image.open(captured["mask_image_path"]))
    assert set(np.unique(derived).tolist()) <= {0, 255}
    assert int((derived > 0).sum()) == painted_px


@pytest.mark.asyncio
@pytest.mark.parametrize("provider", ["newapi", "gemini_webai"])
async def test_mask_edit_annotation_branch_unchanged(
    monkeypatch, tmp_path: Path, provider: str
):
    """Every provider without a latent mask input must keep the exact old call."""
    base_path, mask_path, _ = _write_pair(tmp_path)
    _stub_config(monkeypatch, provider)
    captured = _capture_edit(monkeypatch)

    await freezone_jobs.run_freezone_mask_edit(
        project_dir=tmp_path,
        job_id="job2",
        base_path=str(base_path),
        mask_path=str(mask_path),
        prompt="erase the sign",
        provider=provider,
        model="m",
    )

    assert captured["reference_images"] == [str(base_path), str(mask_path)]
    assert captured["mask_image_path"] is None
    assert "translucent RED" in captured["prompt"]


@pytest.mark.asyncio
async def test_explicit_latent_on_unsupported_provider_is_an_error(
    monkeypatch, tmp_path: Path
):
    """Never silently downgrade: a caller that asked for a precise mask and got a
    prompt-annotation edit instead has no way to tell from the result."""
    base_path, mask_path, _ = _write_pair(tmp_path)
    _stub_config(monkeypatch, "newapi")
    captured = _capture_edit(monkeypatch)

    with pytest.raises(ValueError, match="not available for provider newapi"):
        await freezone_jobs.run_freezone_mask_edit(
            project_dir=tmp_path,
            job_id="job3",
            base_path=str(base_path),
            mask_path=str(mask_path),
            prompt="x",
            provider="newapi",
            model="m",
            mask_mode="latent",
        )
    assert not captured, "the provider must not be called when the mode is rejected"


@pytest.mark.asyncio
async def test_annotation_mode_forced_on_a_latent_capable_provider(
    monkeypatch, tmp_path: Path
):
    base_path, mask_path, _ = _write_pair(tmp_path)
    _stub_config(monkeypatch, "runpod_qwen_edit")
    captured = _capture_edit(monkeypatch)

    await freezone_jobs.run_freezone_mask_edit(
        project_dir=tmp_path,
        job_id="job4",
        base_path=str(base_path),
        mask_path=str(mask_path),
        prompt="x",
        provider="runpod_qwen_edit",
        model="m",
        mask_mode="annotation",
    )

    assert captured["mask_image_path"] is None
    assert captured["reference_images"] == [str(base_path), str(mask_path)]


def test_graphs_gain_the_mask_nodes_only_when_a_mask_is_given():
    """`mask_name` must reach SetLatentNoiseMask, and the maskless graph must stay
    byte-identical to what the existing `/freezone/edit` path already ships."""
    for builder, kwargs in (
        (
            nanobanana_grid._runpod_qwen21_render_image_graph,
            {
                "prompt": "p",
                "canvas_name": "image_1.png",
                "reference_names": [],
                "seed": 1,
                "steps": 20,
                "cfg": 1.0,
            },
        ),
        (
            nanobanana_grid._runpod_qwen_edit_image_graph,
            {
                "prompt": "p",
                "canvas_name": "image1.png",
                "reference_names": [],
                "seed": 1,
            },
        ),
    ):
        without = builder(**kwargs)
        with_mask = builder(**kwargs, mask_name="mask.png")

        assert "52" not in without and "90" not in without
        assert with_mask["90"]["inputs"]["image"] == "mask.png"
        assert with_mask["91"]["class_type"] == "ImageToMask"
        # The channel this reads is exactly why the highlight PNG has to be
        # converted first — see the module docstring.
        assert with_mask["91"]["inputs"]["channel"] == "red"
        assert with_mask["52"]["class_type"] == "SetLatentNoiseMask"
        # Node ids differ between the two graphs (KSampler is "6" in the 2.1 render
        # graph, "60" in Edit-2511), so find it rather than hardcoding one.
        sampler_id = next(
            node_id
            for node_id, node in with_mask.items()
            if node.get("class_type") == "KSampler"
        )
        assert with_mask[sampler_id]["inputs"]["latent_image"] == ["52", 0]
        # Rewiring the sampler's latent is the ONLY change a mask may make to an
        # otherwise identical graph — everything the maskless Freezone edit path
        # already ships must stay byte-identical.
        for node_id, node in without.items():
            if node_id == sampler_id:
                continue
            assert with_mask[node_id] == node

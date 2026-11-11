"""Unit tests for importing a previs H3 chain JSON into a Freezone multishot request.

`chain_NN.json` (written with the `longform-minimax-h3-script-writer` skill) is
already the interchange format between the authoring scripts, the local bench and
the review skills — so Freezone reads it rather than inventing a second one, and
the gravity-test chains in the repo are used here as the fixture, which also
catches the format drifting away from the importer.

`chain_json_to_multishot_request` is pure: no filesystem, no URL resolution. The
caller uploads the files and swaps in static URLs, because only it knows the
project.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from novelvideo.freezone.multishot import (
    ChainImportError,
    chain_json_to_multishot_request,
    extract_chain_dialogue,
)

GRAVITY_TEST = (
    Path(__file__).resolve().parents[1]
    / "previs_h3_test/scripts/skits/science_humor/gravity_test"
)


def _chain(name: str) -> dict:
    path = GRAVITY_TEST / name
    if not path.is_file():
        pytest.skip(f"previs fixture missing: {path}")
    return json.loads(path.read_text(encoding="utf-8"))


def test_imports_a_real_chain():
    request = chain_json_to_multishot_request(_chain("chain_02.json"))

    assert request["aspect_ratio"] == "16:9"
    # 192 frames at 24fps — the dialogue floor the chain was authored against.
    assert request["shot_duration_seconds"] == 8
    assert len(request["shots"]) == 4
    assert len(request["voice_refs"]) == 2
    assert len(request["reference_images"]) == 2
    assert request["start_image"].endswith(".png")


def test_every_shot_keeps_its_prompt_verbatim():
    """The chain's shot text IS the final H3 prompt — rewriting it would discard
    the lint-clean prompt the authoring skills produced."""
    chain = _chain("chain_02.json")
    request = chain_json_to_multishot_request(chain)
    for original, shot in zip(chain["shots"], request["shots"]):
        assert shot["description"] == original.strip()
        assert shot["final_prompt"] == original.strip()


def test_dialogue_is_extracted_per_shot():
    """Not for rendering — the prompt already carries it — but because dialogue
    drives the frame floor and `expects_dialogue`, both of which are per shot."""
    request = chain_json_to_multishot_request(_chain("chain_02.json"))
    dialogues = [shot["dialogue"] for shot in request["shots"]]
    assert all(dialogues), "every shot of this chain speaks"
    assert "why am I on the Moon" in dialogues[0]
    # The language tag is stripped; the spoken words are not.
    assert "[English]" not in dialogues[0]
    assert "<d>" not in dialogues[0]


def test_dialogue_extraction_edge_cases():
    assert extract_chain_dialogue("") == ""
    assert extract_chain_dialogue("no dialogue here") == ""
    assert extract_chain_dialogue("<d>[English] Hello.</d>") == "Hello."
    assert extract_chain_dialogue("<d>Hello.</d>") == "Hello."
    # More than one speaker in a shot: keep both lines, in order.
    assert (
        extract_chain_dialogue("<d>[English] A.</d> mid <d>[English] B.</d>")
        == "A.\nB."
    )


def test_sampling_overrides_are_not_carried_over():
    """`turbo_lora`/`turbo_steps` stay out of the request on purpose: sampling is
    resolved server-side from config by `multishot_sampling_plan()`, and letting a
    JSON file override it would reintroduce the env-mutation-by-input pattern the
    local bench uses and that must not reach the app."""
    chain = _chain("chain_02.json")
    assert "turbo_lora" in chain, "fixture should still carry it"
    request = chain_json_to_multishot_request(chain)
    assert "turbo_lora" not in request
    assert "turbo_steps" not in request


def test_chain_without_image_prompts_imports_with_empty_lists():
    """Keyframe prompts live in qwen_keyframe_prompts.json, not in the chain file."""
    chain = _chain("chain_02.json")
    assert "storyboard_prompts" not in chain
    request = chain_json_to_multishot_request(chain)
    assert request["storyboard_prompts"] == []
    assert request["storyboard_prompts_qwen"] == []


def test_refs_only_variant_is_rejected_with_a_reason():
    """A `_refs_only` chain has no start frame, which Freezone's multishot node
    always requires — say so rather than failing later with a path error."""
    chain = _chain("chain_02_refs_only.json")
    assert chain.get("start_image") in (None, "")
    with pytest.raises(ChainImportError, match="start_image"):
        chain_json_to_multishot_request(chain)


@pytest.mark.parametrize(
    "chain, expected",
    [
        ({}, "no shots"),
        ({"shots": []}, "no shots"),
        ({"shots": ["ok"], "start_image": ""}, "start_image"),
        ({"shots": [""], "start_image": "s.png"}, "non-empty prompt"),
        (
            {"shots": ["ok"], "start_image": "s.png", "aspect_ratio": "4:3"},
            "unsupported aspect_ratio",
        ),
    ],
)
def test_malformed_chains_are_rejected(chain, expected):
    with pytest.raises(ChainImportError, match=expected):
        chain_json_to_multishot_request(chain)


def test_non_object_input_is_rejected():
    with pytest.raises(ChainImportError, match="must be an object"):
        chain_json_to_multishot_request([])  # type: ignore[arg-type]


def test_shot_duration_is_clamped_to_the_route_bounds():
    """The request schema accepts 5..12 seconds; a chain authored outside that
    must still import rather than 422 at the route."""
    short = chain_json_to_multishot_request(
        {"shots": ["a", "b"], "start_image": "s.png", "frames": 24, "aspect_ratio": "9:16"}
    )
    long = chain_json_to_multishot_request(
        {"shots": ["a", "b"], "start_image": "s.png", "frames": 960, "aspect_ratio": "9:16"}
    )
    assert short["shot_duration_seconds"] == 5
    assert long["shot_duration_seconds"] == 12

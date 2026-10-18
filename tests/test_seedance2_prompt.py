import json
from pathlib import Path

import pytest


pytestmark = pytest.mark.m09


def test_seedance2_prompt_draft_keeps_request_params_out_of_prompt():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_draft

    prompt = build_seedance2_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={
            "visual_description": "{{Luchen_bookstore_owner}} rummages through old books in the basement.",
            "scene_ref": {"scene_id": "basement_rainy_night"},
            "props_description": "Old books, a parchment notebook.",
            "video_prompt": "The camera slowly pushes in as Luchen opens an old book.",
        },
        assets=[
            Seedance2ResolvedAsset(
                key="first_frame",
                label="Current render · Beat 1",
                media_type="image",
                path=Path("frame.png"),
                exists=True,
                selected=True,
                request_field="reference_images",
                reference_label="image1",
                image_number=1,
            ),
            Seedance2ResolvedAsset(
                key="identity:Luchen_bookstore_owner",
                label="Luchen · bookstore_owner",
                media_type="image",
                path=Path("identity.png"),
                exists=True,
                selected=True,
                request_field="reference_images",
                reference_label="image2",
                identity_id="Luchen_bookstore_owner",
                image_number=2,
            ),
        ],
        text_overlay={
            "enabled": True,
            "kind": "subtitle",
            "content": "A few days ago, in the basement",
            "placement": "bottom center",
            "timing": "throughout the clip",
            "style": "clean and readable",
        },
        prompt_guidance="Restrained action, like the official multi-image reference example.",
    )

    assert "generate 4 seconds" not in prompt
    assert "9:16" not in prompt
    assert "720p" not in prompt
    assert "Use image1 as the starting state and overall composition reference" in prompt
    assert "keep the appearance of Luchen consistent with image2" in prompt
    assert "The environment is basement_rainy_night" in prompt
    assert "A few days ago, in the basement" in prompt
    assert "Restrained action" in prompt
    assert "@" not in prompt


def test_seedance2_prompt_draft_includes_dialogue_text():
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_draft

    prompt = build_seedance2_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={
            "visual_description": "Xie Zheng stands at the mouth of the alley on a rainy night.",
            "dialogue": "Xie Zheng says softly: “Do not look back, follow me.”",
            "audio_type": "dialogue",
        },
        assets=[],
        text_overlay={},
        prompt_guidance="",
    )

    assert "Do not look back, follow me" in prompt
    assert "Dialogue" in prompt


def test_seedance2_prompt_draft_keeps_desired_scene_state_when_asset_falls_back_to_base():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_draft

    prompt = build_seedance2_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={
            "visual_description": "Standing water on the ground reflects the light.",
            "scene_ref": {"scene_id": "living_room", "variant_id": "leak"},
        },
        assets=[
            Seedance2ResolvedAsset(
                key="scene:living_room",
                label="Scene anchor · living_room",
                media_type="image",
                path=Path("scene.png"),
                exists=True,
                selected=True,
                request_field="reference_images",
                reference_label="image1",
                image_number=1,
            )
        ],
        text_overlay={},
        prompt_guidance="",
    )

    assert "The environment is living_room" in prompt
    assert "target scene state: living_room_leak" in prompt


def test_seedance2_prompt_draft_keeps_desired_scene_time_when_asset_falls_back_to_base():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_draft

    prompt = build_seedance2_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={
            "visual_description": "Standing water on the ground reflects the light.",
            "scene_ref": {"scene_id": "living_room", "variant_id": "leak"},
            "time_of_day": "night",
        },
        assets=[
            Seedance2ResolvedAsset(
                key="scene:living_room",
                label="Scene anchor · living_room",
                media_type="image",
                path=Path("scene.png"),
                exists=True,
                selected=True,
                request_field="reference_images",
                reference_label="image1",
                image_number=1,
            )
        ],
        text_overlay={},
        prompt_guidance="",
    )

    assert "The environment is living_room" in prompt
    assert "target scene state: living_room_leak" in prompt
    assert "target time: night" in prompt


def test_seedance2_prompt_draft_binds_multi_speaker_dialogue_to_audio_labels():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_draft

    prompt = build_seedance2_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={
            "audio_type": "dialogue",
            "narration_segment": (
                "NoodleGuy(puts down the chopsticks in his right hand, picks up the can on the table and opens it, looking surprised):"
                "Is everything fine now?"
                "NoodleGirl(looks up):Do you know Du Chen, the head of R&D?"
            ),
            "visual_description": "Two people talk at a table in the noodle shop.",
        },
        assets=[
            Seedance2ResolvedAsset(
                key="voice:NoodleGuy_young_adult",
                label="NoodleGuy · young_adult voice",
                media_type="audio",
                path=Path("man.mp3"),
                exists=True,
                selected=True,
                request_field="reference_audios",
                reference_label="audio1",
                identity_id="NoodleGuy_young_adult",
                audio_number=1,
            ),
            Seedance2ResolvedAsset(
                key="voice:NoodleGirl_young_adult",
                label="NoodleGirl · young_adult voice",
                media_type="audio",
                path=Path("woman.mp3"),
                exists=True,
                selected=True,
                request_field="reference_audios",
                reference_label="audio2",
                identity_id="NoodleGirl_young_adult",
                audio_number=2,
            ),
        ],
        text_overlay={},
        prompt_guidance="",
    )

    assert "NoodleGuy" in prompt
    assert "uses the voice from audio1" in prompt
    assert "Is everything fine now?" in prompt
    assert "puts down the chopsticks in his right hand" in prompt
    assert "NoodleGirl" in prompt
    assert "uses the voice from audio2" in prompt
    assert "Do you know Du Chen, the head of R&D?" in prompt


def test_seedance2_dialogue_draft_delegates_ambiguous_prose_to_ai():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_draft

    beat = {
        "audio_type": "dialogue",
        "speaker": "Maid_young_adult",
        "narration_segment": "(says crisply, peeking over to tease) You look just like Little Prince Zhao.",
    }
    assets = [
        Seedance2ResolvedAsset(
            key="voice:Maid_young_adult",
            label="Maid · young_adult voice",
            media_type="audio",
            path=Path("maid.mp3"),
            exists=True,
            selected=True,
            request_field="reference_audios",
            reference_label="audio1",
            identity_id="Maid_young_adult",
            audio_number=1,
        )
    ]

    prompt = build_seedance2_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat=beat,
        assets=assets,
        text_overlay={},
        prompt_guidance="",
    )

    assert "distinguish action directions from spoken dialogue" in prompt
    assert "preserve every spoken word verbatim" in prompt
    assert "the speaking character in this Beat is Maid" in prompt
    assert "Maid uses the voice from audio1" in prompt
    assert "(says crisply, peeking over to tease) You look just like Little Prince Zhao" in prompt


def test_seedance2_dialogue_validation_checks_explicit_lines_and_audio_labels():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.pipeline import _validate_dialogue_final_prompt

    beat = {
        "audio_type": "dialogue",
        "narration_segment": "Maid(says crisply, peeking over to tease):You look just like Little Prince Zhao.",
    }
    assets = [
        Seedance2ResolvedAsset(
            key="voice:Maid_young_adult",
            label="Maid · young_adult voice",
            media_type="audio",
            path=Path("maid.mp3"),
            exists=True,
            selected=True,
            request_field="reference_audios",
            reference_label="audio1",
            identity_id="Maid_young_adult",
            audio_number=1,
        )
    ]

    with pytest.raises(ValueError, match="The Seedance2 final prompt is missing dialogue"):
        _validate_dialogue_final_prompt(
            beat=beat,
            final_prompt="Maid(says crisply, peeking over to tease, uses the voice of audio1) looks at the other person.",
            assets=assets,
        )

    with pytest.raises(ValueError, match="The Seedance2 final prompt is missing a reference voice"):
        _validate_dialogue_final_prompt(
            beat={
                "audio_type": "dialogue",
                "speaker": "Maid_young_adult",
                "narration_segment": "(says crisply, peeking over to tease) You look just like Little Prince Zhao.",
            },
            final_prompt="Maid says: “You look just like Little Prince Zhao.”",
            assets=assets,
        )


def test_seedance2_dialogue_validation_keeps_plain_beat_dialogue_required():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.pipeline import _validate_dialogue_final_prompt

    beat = {
        "audio_type": "dialogue",
        "speaker": "Maid_young_adult",
        "narration_segment": "(says crisply, peeking over to tease) You look just like Little Prince Zhao.",
    }
    assets = [
        Seedance2ResolvedAsset(
            key="voice:Maid_young_adult",
            label="Maid · young_adult voice",
            media_type="audio",
            path=Path("maid.mp3"),
            exists=True,
            selected=True,
            request_field="reference_audios",
            reference_label="audio1",
            identity_id="Maid_young_adult",
            audio_number=1,
        )
    ]

    _validate_dialogue_final_prompt(
        beat=beat,
        final_prompt=(
            "Maid(says crisply, peeking over to tease, uses the voice of audio1) says: "
            "“You look just like Little Prince Zhao.”"
        ),
        assets=assets,
    )

    with pytest.raises(ValueError, match="The Seedance2 final prompt is missing dialogue"):
        _validate_dialogue_final_prompt(
            beat=beat,
            final_prompt="Maid(says crisply, peeking over to tease, uses the voice of audio1) looks at the other person.",
            assets=assets,
        )


def test_seedance2_prompt_draft_can_use_narration_voice_reference():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_draft

    prompt = build_seedance2_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={
            "audio_type": "narration",
            "narration_segment": "The noodle shop still has its lights on in the night.",
            "visual_description": "Two people talk at a table in the noodle shop.",
        },
        assets=[
            Seedance2ResolvedAsset(
                key="voice:narrator",
                label="Project narrator voice",
                media_type="audio",
                path=Path("narrator.mp3"),
                exists=True,
                selected=True,
                request_field="reference_audios",
                reference_label="audio1",
                identity_id="__narrator__",
                audio_number=1,
            ),
        ],
        text_overlay={},
        prompt_guidance="",
    )

    assert "The noodle shop still has its lights on in the night" in prompt
    assert "audio1" in prompt
    assert "Project narrator voice" in prompt


def test_seedance2_asset_manifest_exposes_unreferenced_audio_to_ai():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.prompt import build_seedance2_asset_manifest

    manifest = build_seedance2_asset_manifest(
        [
            Seedance2ResolvedAsset(
                key="voice:narrator",
                label="Project narrator voice",
                media_type="audio",
                path=Path("narrator.mp3"),
                exists=True,
                selected=False,
                request_field="",
                reference_label="audio1",
                identity_id="__narrator__",
                audio_number=1,
            )
        ]
    )

    assert manifest == [
        {
            "label": "audio1",
            "title": "Project narrator voice",
            "media_type": "audio",
            "request_field": "",
            "note": "",
            "identity_id": "__narrator__",
            "prop_id": "",
            "prop_scope": "",
            "key": "voice:narrator",
        }
    ]


def test_seedance2_prompt_uses_identity_text_when_reference_image_is_missing():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_draft

    assets = [
        Seedance2ResolvedAsset(
            key="first_frame",
            label="Current render · Beat 6",
            media_type="image",
            path=Path("frame.png"),
            exists=True,
            selected=True,
            request_field="reference_images",
            reference_label="image1",
        ),
        Seedance2ResolvedAsset(
            key="identity:NoodleGuy_young_adult",
            label="NoodleGuy · young_adult",
            media_type="image",
            path=Path("missing.png"),
            exists=False,
            selected=False,
            request_field="",
            reference_label="not_sent",
            identity_id="NoodleGuy_young_adult",
            fallback_text="Male, early twenties, short black hair, charcoal apron, sturdy and clean-cut",
        ),
    ]

    prompt = build_seedance2_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={
            "beat_number": 6,
            "visual_description": "{{NoodleGuy_young_adult}} puts down the can.",
            "scene_ref": {"scene_id": "noodle_shop"},
        },
        assets=assets,
        text_overlay=None,
    )

    assert "generate NoodleGuy's appearance from this description: Male, early twenties, short black hair, charcoal apron, sturdy and clean-cut" in prompt
    assert (
        "The scene shows NoodleGuy (Male, early twenties, short black hair, charcoal apron, sturdy and clean-cut) puts down the can" in prompt
    )


def test_seedance2_prompt_binds_prop_marker_to_reference_image():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_draft

    prompt = build_seedance2_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={
            "beat_number": 1,
            "visual_description": "A young man raises [[TOKEN]], a red glowing orb of code flickering in his palm.",
            "detected_props": ["TOKEN"],
        },
        assets=[
            Seedance2ResolvedAsset(
                key="first_frame",
                label="Current render · Beat 1",
                media_type="image",
                path=Path("frame.png"),
                exists=True,
                selected=True,
                request_field="reference_images",
                reference_label="image1",
                image_number=1,
            ),
            Seedance2ResolvedAsset(
                key="prop:TOKEN",
                label="Prop · TOKEN",
                media_type="image",
                path=Path("token.png"),
                exists=True,
                selected=True,
                request_field="reference_images",
                reference_label="image2",
                image_number=2,
                prop_id="TOKEN",
            ),
        ],
        text_overlay={},
        prompt_guidance="",
    )

    assert "keep the shape, material, and details of the TOKEN prop consistent with image2" in prompt
    assert "[[TOKEN]]" not in prompt


def test_seedance2_prompt_uses_prop_fallback_when_reference_image_is_missing():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_draft

    prompt = build_seedance2_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={
            "beat_number": 1,
            "visual_description": "[[can]] is on the table.",
            "detected_props": ["can"],
        },
        assets=[
            Seedance2ResolvedAsset(
                key="prop:can",
                label="Prop · can",
                media_type="image",
                path=Path("missing.png"),
                exists=False,
                selected=False,
                request_field="",
                reference_label="not_sent",
                prop_id="can",
                fallback_text="Red aluminum drink can with fine water droplets and a pull-tab structure",
            )
        ],
        text_overlay={},
        prompt_guidance="",
    )

    assert "generate the can prop from this description: Red aluminum drink can with fine water droplets and a pull-tab structure" in prompt
    assert "The scene shows can (Red aluminum drink can with fine water droplets and a pull-tab structure) is on the table" in prompt


def test_seedance2_prompt_composer_task_exposes_prop_assets_and_fallbacks():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_composer_task

    task = build_seedance2_prompt_composer_task(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={
            "visual_description": "[[TOKEN]] and [[can]] are on the table.",
            "detected_props": ["TOKEN", "can"],
        },
        assets=[
            Seedance2ResolvedAsset(
                key="prop:TOKEN",
                label="Prop · TOKEN",
                media_type="image",
                path=Path("token.png"),
                exists=True,
                selected=True,
                request_field="reference_images",
                reference_label="image1",
                prop_id="TOKEN",
                prop_scope="global",
            ),
            Seedance2ResolvedAsset(
                key="prop:can",
                label="Prop · can",
                media_type="image",
                path=Path("missing.png"),
                exists=False,
                selected=False,
                request_field="",
                reference_label="not_sent",
                prop_id="can",
                prop_scope="episode",
                fallback_text="Red aluminum drink can with fine water droplets",
            ),
        ],
        text_overlay={},
        prompt_guidance="",
        draft_prompt="Draft.",
    )

    assert '"prop_id": "TOKEN"' in task
    assert '"prop_scope": "global"' in task
    assert '"asset_fallbacks": [' in task
    assert '"prop_id": "can"' in task
    assert '"prop_scope": "episode"' in task
    assert "Red aluminum drink can" in task


def test_seedance2_prompt_hash_changes_when_prop_fallback_changes():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import compute_seedance2_prompt_inputs_hash

    beat = {"visual_description": "[[can]] is on the table.", "detected_props": ["can"]}

    def make_hash(fallback_text: str) -> str:
        return compute_seedance2_prompt_inputs_hash(
            mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
            beat=beat,
            assets=[
                Seedance2ResolvedAsset(
                    key="prop:can",
                    label="Prop · can",
                    media_type="image",
                    path=Path("missing.png"),
                    exists=False,
                    selected=False,
                    request_field="",
                    reference_label="not_sent",
                    prop_id="can",
                    fallback_text=fallback_text,
                )
            ],
            text_overlay={},
        )

    assert make_hash("Red aluminum drink can") != make_hash("Blue glass bottle")


def test_seedance2_prompt_composer_task_includes_scene_ref_and_dialogue_text():
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_composer_task

    task = build_seedance2_prompt_composer_task(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={
            "visual_description": "Xie Zheng stands at the mouth of the alley on a rainy night.",
            "scene_ref": {"scene_id": "old_alley_storm"},
            "dialogue": "Xie Zheng says softly: “Do not look back, follow me.”",
            "audio_type": "dialogue",
        },
        assets=[],
        text_overlay={},
        prompt_guidance="",
        draft_prompt="Draft.",
    )

    assert '"scene_ref": {' in task
    assert '"scene_id": "old_alley_storm"' in task
    assert '"variant_id"' not in task
    assert '"dialogue": "Xie Zheng says softly:' in task
    assert "Do not look back, follow me" in task
    assert "Preserve spoken dialogue verbatim" in task


def test_seedance2_prompt_hash_ignores_request_only_video_params():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import compute_seedance2_prompt_inputs_hash

    asset = Seedance2ResolvedAsset(
        key="first_frame",
        label="Current render · Beat 1",
        media_type="image",
        path=Path("frame.png"),
        exists=True,
        selected=True,
        request_field="reference_images",
        reference_label="image1",
        image_number=1,
    )
    beat = {
        "visual_description": "Luchen browses a book in the basement.",
        "scene_ref": {"scene_id": "basement"},
        "video_prompt": "Slow push-in.",
    }

    base_hash = compute_seedance2_prompt_inputs_hash(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat=beat,
        assets=[asset],
        text_overlay={},
        prompt_guidance="Keep the suspense.",
    )
    same_hash_after_request_change = compute_seedance2_prompt_inputs_hash(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={**beat, "duration": 10, "ratio": "16:9"},
        assets=[asset],
        text_overlay={},
        prompt_guidance="Keep the suspense.",
    )
    changed_hash = compute_seedance2_prompt_inputs_hash(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={**beat, "scene_ref": {"scene_id": "old_alley"}},
        assets=[asset],
        text_overlay={},
        prompt_guidance="Keep the suspense.",
    )

    assert base_hash == same_hash_after_request_change
    assert base_hash != changed_hash


async def test_generate_seedance2_prompt_uses_ai_composer_before_fallback():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import generate_seedance2_prompt

    async def fake_composer(**kwargs):
        assert "duration" not in kwargs["draft_prompt"]
        assert kwargs["request_params"] == {
            "duration": 6,
            "resolution": "720p",
            "ratio": "9:16",
        }
        return "Generate an official-style video from image1."

    result = await generate_seedance2_prompt(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={"visual_description": "Luchen browses a book in the basement."},
        assets=[
            Seedance2ResolvedAsset(
                key="first_frame",
                label="Current render · Beat 1",
                media_type="image",
                path=Path("frame.png"),
                exists=True,
                selected=True,
                request_field="reference_images",
                reference_label="image1",
                image_number=1,
            )
        ],
        text_overlay={},
        prompt_guidance="",
        request_params={"duration": 6, "resolution": "720p", "ratio": "9:16"},
        composer=fake_composer,
    )

    assert result.prompt == "Generate an official-style video from image1."
    assert result.used_ai is True
    assert result.error == ""


async def test_seedance2_prompt_composer_accepts_plain_text_output(monkeypatch):
    from types import SimpleNamespace

    import novelvideo.seedance2_i2v.prompt as prompt_module
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode

    class FakeAgent:
        async def run(self, task):
            assert "Output only the final prompt." in task
            return SimpleNamespace(output="  Generate a cinematic video from image1.  ")

    monkeypatch.setattr(
        prompt_module,
        "create_seedance2_prompt_composer_agent",
        lambda language="en": FakeAgent(),
    )

    result = await prompt_module.compose_seedance2_prompt_with_agent(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={"visual_description": "The character turns around."},
        assets=[],
        text_overlay={},
        prompt_guidance="",
        draft_prompt="The character turns around.",
    )

    assert result == "Generate a cinematic video from image1."


def test_seedance2_english_draft_uses_english_prose_and_keeps_reference_tokens():
    from novelvideo.seedance2_i2v.assets import Seedance2ResolvedAsset
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import build_seedance2_prompt_draft

    prompt = build_seedance2_prompt_draft(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={
            "visual_description": "Ji-won walks through the subway corridor.",
            "scene_description": "Seoul Subway Station",
        },
        assets=[
            Seedance2ResolvedAsset(
                key="first_frame",
                label="Current render · Beat 1",
                media_type="image",
                path=Path("frame.png"),
                exists=True,
                selected=True,
                request_field="reference_images",
                reference_label="image1",
                image_number=1,
            )
        ],
        text_overlay={},
        language="en",
    )

    assert prompt.startswith("Use image1 as the starting state")
    assert "The scene shows Ji-won walks through the subway corridor." in prompt
    assert "The environment is Seoul Subway Station." in prompt


@pytest.mark.parametrize(
    ("beat", "expected"),
    [
        (
            {
                "visual_description": "Ji-won walks through the subway corridor.",
                "narration_segment": "She raises her phone.",
                "video_prompt": "Legacy video prompt that must not change the language.",
            },
            "en",
        ),
        ({"visual_description": "Cô ấy bước qua hành lang dài."}, "vi"),
    ],
)
def test_seedance2_language_uses_script_fields_and_ignores_generated_prompt(
    beat, expected
):
    import novelvideo.seedance2_i2v.prompt as prompt_module

    assert prompt_module.detect_seedance2_prompt_language(beat) == expected


async def test_seedance2_english_generation_keeps_english_fallback():
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import generate_seedance2_prompt

    async def failing_composer(**_kwargs):
        raise RuntimeError("composer unavailable")

    result = await generate_seedance2_prompt(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={"visual_description": "Ji-won raises her phone."},
        assets=[],
        text_overlay={},
        prompt_guidance="",
        composer=failing_composer,
        language="en",
    )

    assert result.used_ai is False
    assert "The scene shows Ji-won raises her phone." in result.prompt


async def test_seedance2_english_fallback_keeps_non_vietnamese_freeform_guidance():
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import generate_seedance2_prompt

    async def failing_composer(**_kwargs):
        raise RuntimeError("composer unavailable")

    result = await generate_seedance2_prompt(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={"visual_description": "Maya opens the door."},
        assets=[],
        text_overlay={},
        prompt_guidance="Camera: move slowly forward.",
        composer=failing_composer,
        language="en",
    )

    assert result.used_ai is False
    assert "The scene shows Maya opens the door." in result.prompt
    # Non-Vietnamese text is treated as English now, so freeform guidance is kept.
    assert "Camera: move slowly forward" in result.prompt


async def test_seedance2_english_fallback_localizes_structured_guidance():
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode
    from novelvideo.seedance2_i2v.prompt import generate_seedance2_prompt

    async def failing_composer(**_kwargs):
        raise RuntimeError("composer unavailable")

    result = await generate_seedance2_prompt(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={"visual_description": "Maya opens the door."},
        assets=[],
        text_overlay={},
        prompt_guidance="Camera: Specify shot size, viewpoint, movement speed, and direction so the camera move is clear and executable.",
        prompt_guidance_template_keys=["camera"],
        composer=failing_composer,
        language="en",
    )

    assert result.used_ai is False
    assert (
        "Camera: Specify shot size, viewpoint, movement speed, and direction "
        "so the camera move is clear and executable."
    ) in result.prompt


async def test_seedance2_english_composer_receives_english_language_contract(
    monkeypatch,
):
    from types import SimpleNamespace

    import novelvideo.seedance2_i2v.prompt as prompt_module
    from novelvideo.seedance2_i2v.models import Seedance2I2VMode

    seen = {}

    class FakeAgent:
        async def run(self, task):
            seen["task"] = task
            return SimpleNamespace(output="Use image1 as the first-frame reference.")

    monkeypatch.setattr(
        prompt_module,
        "create_seedance2_prompt_composer_agent",
        lambda language="en": FakeAgent(),
    )

    result = await prompt_module.compose_seedance2_prompt_with_agent(
        mode=Seedance2I2VMode.MULTIMODAL_REFERENCE,
        beat={"visual_description": "Ji-won raises her phone."},
        assets=[],
        text_overlay={},
        prompt_guidance="",
        draft_prompt="The scene shows Ji-won raises her phone.",
        language="en",
    )

    assert result == "Use image1 as the first-frame reference."
    assert "Write every user-visible prose field in English" in seen["task"]


async def test_seedance2_panel_detects_english_before_calling_generator(
    monkeypatch, tmp_path
):
    from novelvideo.seedance2_i2v import panel_service
    from novelvideo.seedance2_i2v.prompt import Seedance2PromptGeneration

    seen = {}

    class Store:
        async def update_beat_asset(self, **_kwargs):
            return None

    async def fake_generate(**kwargs):
        seen.update(kwargs)
        return Seedance2PromptGeneration(
            prompt="Use image1 as the starting state.",
            used_ai=True,
            draft_prompt="Use image1 as the starting state.",
        )

    monkeypatch.setattr(panel_service, "build_seedance2_project_assets", lambda **_kwargs: [])
    monkeypatch.setattr(panel_service, "generate_seedance2_prompt", fake_generate)

    await panel_service.generate_seedance2_prompt_for_panel(
        store=Store(),
        state_dir=tmp_path / "state",
        episode=1,
        beat={
            "beat_number": 1,
            "visual_description": "Ji-won raises her phone in the corridor.",
            "narration_segment": "She starts speaking.",
        },
        project_dir=tmp_path,
    )

    assert seen["language"] == "en"


async def test_seedance2_panel_passes_structured_guidance_keys(monkeypatch, tmp_path):
    from novelvideo.seedance2_i2v import panel_service
    from novelvideo.seedance2_i2v.prompt import Seedance2PromptGeneration

    seen = {}

    class Store:
        async def update_beat_asset(self, **_kwargs):
            return None

    async def fake_generate(**kwargs):
        seen.update(kwargs)
        return Seedance2PromptGeneration(
            prompt="Camera: move slowly forward.",
            used_ai=False,
            draft_prompt="Camera: move slowly forward.",
        )

    monkeypatch.setattr(panel_service, "build_seedance2_project_assets", lambda **_kwargs: [])
    monkeypatch.setattr(panel_service, "generate_seedance2_prompt", fake_generate)

    await panel_service.generate_seedance2_prompt_for_panel(
        store=Store(),
        state_dir=tmp_path / "state",
        episode=1,
        beat={
            "beat_number": 1,
            "visual_description": "Maya opens the door.",
            "seedance2_config_json": json.dumps(
                {
                    "prompt_guidance": "Camera: move slowly forward.",
                    "prompt_guidance_template_keys": ["camera"],
                }
            ),
        },
        project_dir=tmp_path,
        language="en",
    )

    assert seen.get("prompt_guidance_template_keys") == ["camera"]


async def test_seedance2_panel_uses_authoritative_screenplay_language(
    monkeypatch, tmp_path
):
    from novelvideo.seedance2_i2v import panel_service
    from novelvideo.seedance2_i2v.prompt import Seedance2PromptGeneration

    seen = {}

    class Store:
        async def update_beat_asset(self, **_kwargs):
            return None

    async def fake_generate(**kwargs):
        seen.update(kwargs)
        return Seedance2PromptGeneration(
            prompt="The camera moves slowly forward.",
            used_ai=True,
            draft_prompt="The camera moves slowly forward.",
        )

    monkeypatch.setattr(panel_service, "build_seedance2_project_assets", lambda **_kwargs: [])
    monkeypatch.setattr(panel_service, "generate_seedance2_prompt", fake_generate)

    await panel_service.generate_seedance2_prompt_for_panel(
        store=Store(),
        state_dir=tmp_path / "state",
        episode=1,
        beat={
            "beat_number": 1,
            "visual_description": "Legacy visual description from before the fix.",
            "narration_segment": "Legacy narration from before the fix.",
        },
        project_dir=tmp_path,
        language="en",
    )

    assert seen["language"] == "en"


def test_seedance2_panel_state_uses_authoritative_language_for_freshness(
    monkeypatch, tmp_path
):
    from novelvideo.seedance2_i2v import panel_service

    seen = {}
    monkeypatch.setattr(
        panel_service, "build_seedance2_project_assets", lambda **_kwargs: []
    )
    monkeypatch.setattr(
        panel_service,
        "_seedance2_default_prompt",
        lambda **kwargs: seen.setdefault("fallback_language", kwargs["language"])
        or "fallback",
    )

    def fake_hash(**kwargs):
        seen["hash_language"] = kwargs["language"]
        return "current-hash"

    monkeypatch.setattr(panel_service, "_seedance2_prompt_inputs_hash", fake_hash)

    state = panel_service.build_seedance2_video_panel_state(
        project_dir=tmp_path,
        episode=1,
        beat={
            "beat_number": 1,
            "visual_description": "Legacy visual description from before the fix.",
            "video_prompt": "Legacy video prompt from before the fix.",
        },
        state_dir=tmp_path / "state",
        language="en",
    )

    assert state.current_prompt_inputs_hash == "current-hash"
    assert seen == {"fallback_language": "en", "hash_language": "en"}

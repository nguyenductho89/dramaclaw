import pytest
from pydantic import ValidationError
from pydantic_ai.exceptions import (
    ContentFilterError,
    ModelHTTPError,
    UnexpectedModelBehavior,
)
from types import SimpleNamespace

from novelvideo.models import build_scene_ref, sync_beat_asset_refs
from novelvideo.workflows.literal_script_writing import (
    LiteralBeatMetaOutput,
    LiteralScriptWritingWorkflow,
    _content_filter_hint_matches,
)
from novelvideo.workflows.script_writing import create_script_writing_workflow


def _payload(audio_type: str | None = None) -> dict:
    payload = {
        "speaker": "",
        "speaker_kind": "character",
        "visual_description": "Only the noodle shop is lit in the dim street.",
        "scene_id": "",
    }
    if audio_type is not None:
        payload["audio_type"] = audio_type
    return payload


def test_literal_beat_meta_defaults_to_silence_audio_type():
    beat = LiteralBeatMetaOutput.model_validate(_payload())

    assert beat.audio_type == "silence"
    assert not hasattr(beat, "scene_variant_id")


def test_scene_ref_exposes_lightweight_variant_id():
    ref = build_scene_ref("ForbiddenCity", "snow")

    assert ref is not None
    assert ref.scene_id == "ForbiddenCity"
    assert ref.variant_id == "snow"


def test_sync_beat_asset_refs_preserves_canonical_scene_variant():
    beat = {
        "scene_ref": {
            "scene_id": "ForbiddenCity",
            "variant_id": "snow",
            "render_anchor_id": "selected_background",
        }
    }

    sync_beat_asset_refs(beat)

    assert beat["scene_ref"] == {
        "scene_id": "ForbiddenCity",
        "variant_id": "snow",
        "render_anchor_id": "selected_background",
        "render_anchor_source_id": "",
    }


def test_literal_beat_meta_accepts_silence_audio_type_for_visual_only_beats():
    beat = LiteralBeatMetaOutput.model_validate(_payload("silence"))

    assert beat.audio_type == "silence"


def test_literal_beat_meta_accepts_narration_audio_type_for_non_dialogue():
    beat = LiteralBeatMetaOutput.model_validate(_payload("narration"))

    assert beat.audio_type == "narration"


def test_literal_beat_meta_rejects_action_audio_type():
    with pytest.raises(ValidationError, match="silence/narration/dialogue"):
        LiteralBeatMetaOutput.model_validate(_payload("action"))


def test_literal_workflow_leaves_silence_narration_segment_empty():
    assert (
        LiteralScriptWritingWorkflow._derive_narration_segment(
            "Only the noodle shop's lights are on in the dim street.",
            "silence",
        )
        == ""
    )


def test_literal_workflow_keeps_narration_and_extracts_dialogue_text():
    assert (
        LiteralScriptWritingWorkflow._derive_narration_segment(
            "Narrator: He finally found the clue.",
            "narration",
        )
        == "Narrator: He finally found the clue."
    )
    assert (
        LiteralScriptWritingWorkflow._derive_narration_segment(
            "Xie Zheng: Go.",
            "dialogue",
        )
        == "Go."
    )


def test_narrated_workflow_converts_silence_to_narration():
    workflow = LiteralScriptWritingWorkflow(
        cognee_store=None,
        audio_type_mode="narrated",
    )

    audio_type = workflow._normalize_audio_type_for_mode("silence")

    assert audio_type == "narration"
    assert (
        LiteralScriptWritingWorkflow._derive_narration_segment(
            "Only the noodle shop's lights are on in the dim street.",
            audio_type,
        )
        == "Only the noodle shop's lights are on in the dim street."
    )


def test_literal_workflow_converts_non_character_dialogue_to_narration():
    audio_type, speaker = LiteralScriptWritingWorkflow._normalize_audio_metadata(
        audio_type="dialogue",
        speaker_kind="non_character",
        speaker="middle-aged male voice",
    )

    assert audio_type == "narration"
    assert speaker == ""


def test_literal_content_filter_log_mentions_line_context_and_terms():
    messages = LiteralScriptWritingWorkflow._content_filter_log_messages(
        content_index=8,
        total=37,
        line_ctx=SimpleNamespace(
            raw_line="Shen Wan grips the dagger, blood seeping from her fingertips.",
            scene_block=SimpleNamespace(header_line="Bedchamber NIGHT INT", location="Bedchamber"),
            prev_window=["Su Tang steps back."],
            next_line="The lights in the room flicker.",
            source_line_number=11,
        ),
        error=RuntimeError("Content filter triggered"),
    )
    joined = "\n".join(messages)

    assert "Line 8/37 generation failed" in joined
    assert "Line to modify (Source text line 11, content line 8/37): Shen Wan grips the dagger" in joined
    assert "Scene it belongs to: Bedchamber NIGHT INT" in joined
    assert "previous line=Su Tang steps back." in joined
    assert "next line=The lights in the room flicker." in joined
    assert "Possibly risky expressions" in joined
    assert "dagger" in joined
    assert "blood" in joined


def test_literal_content_filter_hint_matches_english_terms():
    matches = _content_filter_hint_matches(
        "The dagger points at her chest. Blood drips down. I can't die."
    )
    joined = "\n".join(matches)

    assert "violence/weapons" in joined
    assert "dagger" in joined
    assert "blood" in joined
    assert "self-harm/life threat" in joined
    assert "i can't die" in joined


def test_literal_line_context_preserves_source_line_number():
    lines = [
        "INT. BEDCHAMBER - NIGHT",
        "Candlelight flickers.",
        "The dagger reflects the girl's face.",
    ]
    blocks = LiteralScriptWritingWorkflow._build_scene_blocks(lines)
    contexts = LiteralScriptWritingWorkflow._build_scene_line_contexts(
        blocks,
        source_lines=lines,
    )

    assert contexts[0].source_line_number == 2
    assert contexts[1].source_line_number == 3


def test_literal_scene_menu_prompt_lists_scene_ids_without_variant_menu():
    workflow = LiteralScriptWritingWorkflow(cognee_store=None)
    episode = SimpleNamespace(
        scene_menu=[
            SimpleNamespace(scene_id="ForbiddenCity"),
            SimpleNamespace(scene_id="ForbiddenCity_snow", base_scene_id="ForbiddenCity", variant_id="snow"),
        ]
    )

    section = workflow._build_scene_menu_for_episode(episode)

    assert "`ForbiddenCity`" in section
    assert "`ForbiddenCity_snow`" in section
    assert "variant" not in section


def test_literal_scene_id_validator_clears_invalid_scene_id():
    beat = LiteralBeatMetaOutput.model_validate(
        {
            **_payload(),
            "scene_id": "nonexistent",
        },
        context={"valid_scene_ids": {"ForbiddenCity", "ForbiddenCity_snow"}},
    )

    assert beat.scene_id == ""


def test_literal_locked_base_allows_derived_scene_candidates():
    workflow = LiteralScriptWritingWorkflow(cognee_store=None)
    episode = SimpleNamespace(
        scene_menu=[
            SimpleNamespace(scene_id="ForbiddenCity_snow", base_scene_id="ForbiddenCity", variant_id="snow"),
            SimpleNamespace(scene_id="ForbiddenCity"),
            SimpleNamespace(scene_id="ImperialGarden"),
        ]
    )

    workflow._build_scene_menu_for_episode(episode)

    assert workflow._resolve_scene_id("ForbiddenCity", episode) == "ForbiddenCity"
    assert workflow._allowed_scene_ids_for_block("ForbiddenCity") == {"ForbiddenCity", "ForbiddenCity_snow"}


def test_literal_canonical_scene_ref_uses_menu_split_not_prefix_guess():
    workflow = LiteralScriptWritingWorkflow(cognee_store=None)
    episode = SimpleNamespace(
        scene_menu=[
            SimpleNamespace(scene_id="Bathroom"),
            SimpleNamespace(
                scene_id="Bathroom_leak",
                base_scene_id="Bathroom",
                variant_id="leak",
            ),
            SimpleNamespace(scene_id="Bathroom_control_room"),
        ]
    )
    workflow._build_scene_menu_for_episode(episode)

    derived_ref = workflow._canonical_scene_ref_for_menu_choice("Bathroom_leak")
    independent_ref = workflow._canonical_scene_ref_for_menu_choice("Bathroom_control_room")

    assert derived_ref is not None
    assert derived_ref.scene_id == "Bathroom"
    assert derived_ref.variant_id == "leak"
    assert independent_ref is not None
    assert independent_ref.scene_id == "Bathroom_control_room"
    assert independent_ref.variant_id == ""


def test_literal_locked_base_rejects_other_scene_candidate():
    workflow = LiteralScriptWritingWorkflow(cognee_store=None)
    episode = SimpleNamespace(
        scene_menu=[
            SimpleNamespace(scene_id="ForbiddenCity"),
            SimpleNamespace(scene_id="ForbiddenCity_snow"),
            SimpleNamespace(scene_id="ImperialGarden"),
        ]
    )

    workflow._build_scene_menu_for_episode(episode)

    allowed = workflow._allowed_scene_ids_for_block(workflow._resolve_scene_id("ForbiddenCity", episode))
    assert "ImperialGarden" not in allowed


def test_create_script_workflow_uses_narrated_audio_type_mode():
    class _Store:
        output_dir = ""

    workflow = create_script_writing_workflow(
        _Store(),
        spine_template="narrated",
    )

    assert workflow.audio_type_mode == "narrated"


@pytest.mark.asyncio
async def test_literal_workflow_uses_shared_episode_planning_content(monkeypatch):
    from novelvideo.workflows import literal_script_writing

    episode = SimpleNamespace(number=1, title="Episode 1")

    class _CogneeStore:
        async def load_graph_state(self):
            return None

    class _SQLiteStore:
        async def get_episode_from_graph(self, episode_num):
            assert episode_num == 1
            return episode

    calls = []

    async def fake_load_episode_planning_content(store, selected_episode):
        calls.append((store, selected_episode))
        return ""

    monkeypatch.setattr(
        literal_script_writing,
        "load_episode_planning_content",
        fake_load_episode_planning_content,
    )
    cognee_store = _CogneeStore()
    workflow = LiteralScriptWritingWorkflow(
        cognee_store=cognee_store,
        sqlite_store=_SQLiteStore(),
    )

    with pytest.raises(ValueError, match="source text of the current episode is empty"):
        await workflow.run(episode_num=1)

    assert calls == [(cognee_store, episode)]


class _LiteralRunStore:
    output_dir = ""
    _props = {}

    def __init__(self) -> None:
        self.episode = SimpleNamespace(
            number=1,
            title="Episode 1",
            identity_ids=[],
            identity_default_map={},
            scene_menu=[],
            prop_menu=[],
        )
        self.persisted = None

    async def load_graph_state(self):
        return None

    async def get_episode_from_graph(self, episode_num):
        assert episode_num == 1
        return self.episode

    def get_episode(self, episode_num):
        assert episode_num == 1
        return self.episode

    def get_all_characters(self):
        return []

    async def persist_narration_script(self, script):
        self.persisted = script


class _SequencedLiteralAgent:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0
        self.prompts = []

    async def run(self, prompt):
        self.calls += 1
        self.prompts.append(prompt)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        return SimpleNamespace(output=outcome)


def _valid_literal_output(visual_description: str) -> LiteralBeatMetaOutput:
    return LiteralBeatMetaOutput(
        audio_type="silence",
        speaker="",
        speaker_kind="character",
        visual_description=visual_description,
        scene_id="",
    )


@pytest.mark.asyncio
async def test_english_literal_workflow_requires_english_visual_descriptions(
    monkeypatch,
):
    store = _LiteralRunStore()
    agent = _SequencedLiteralAgent(
        [
            _valid_literal_output("Maya stands alone on the empty platform."),
        ]
    )
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow,
        "agent",
        property(lambda _workflow: agent),
    )
    workflow = LiteralScriptWritingWorkflow(cognee_store=store, sqlite_store=store)

    await workflow.run(
        episode_num=1,
        source_text=(
            "SCENE 1 - THE EMPTY PLATFORM\n"
            "Location: Seoul Subway Station\n"
            "Maya stands alone on the empty platform."
        ),
    )

    assert "Write every user-visible prose field in English" in agent.prompts[0]


@pytest.mark.asyncio
async def test_english_literal_workflow_uses_english_retry_fallback(monkeypatch):
    store = _LiteralRunStore()
    agent = _SequencedLiteralAgent(
        [
            UnexpectedModelBehavior("Exceeded maximum output retries (2)"),
            UnexpectedModelBehavior("Exceeded maximum output retries (2)"),
        ]
    )
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow,
        "agent",
        property(lambda _workflow: agent),
    )
    workflow = LiteralScriptWritingWorkflow(cognee_store=store, sqlite_store=store)

    script = await workflow.run(
        episode_num=1,
        source_text="SCENE 1 - ROOM\nLocation: Room\nMAYA: Go now.",
    )

    assert script.beats[0].visual_description == "MAYA speaks."


@pytest.mark.asyncio
async def test_english_literal_workflow_uses_english_content_filter_placeholder(
    monkeypatch,
):
    store = _LiteralRunStore()
    agent = _SequencedLiteralAgent([ContentFilterError("Content filter triggered")])
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow,
        "agent",
        property(lambda _workflow: agent),
    )
    workflow = LiteralScriptWritingWorkflow(cognee_store=store, sqlite_store=store)

    script = await workflow.run(
        episode_num=1,
        source_text="SCENE 1 - ROOM\nLocation: Room\nMaya grips a knife.",
    )

    assert script.beats[0].visual_description == (
        "This line could not be generated; please complete it manually."
    )


@pytest.mark.asyncio
async def test_literal_workflow_retries_one_line_with_a_fresh_model_call(monkeypatch):
    store = _LiteralRunStore()
    agent = _SequencedLiteralAgent(
        [
            UnexpectedModelBehavior("Exceeded maximum output retries (2)"),
            _valid_literal_output("Xie Zheng stands at the door and speaks."),
            _valid_literal_output("Candlelight sways gently in the room."),
        ]
    )
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow,
        "agent",
        property(lambda _workflow: agent),
    )
    workflow = LiteralScriptWritingWorkflow(cognee_store=store, sqlite_store=store)
    logs = []

    script = await workflow.run(
        episode_num=1,
        source_text="INT. BEDCHAMBER - NIGHT\nXie Zheng: Go.\nCandlelight flickers.",
        on_log=logs.append,
    )

    assert agent.calls == 3
    assert len(script.beats) == 2
    assert workflow.last_degraded_lines == []
    assert workflow.last_review_passed is True
    assert any("calling the model again" in message for message in logs)


@pytest.mark.asyncio
async def test_literal_workflow_falls_back_per_line_and_continues(monkeypatch):
    store = _LiteralRunStore()
    agent = _SequencedLiteralAgent(
        [
            UnexpectedModelBehavior("Exceeded maximum output retries (2)"),
            UnexpectedModelBehavior("Exceeded maximum output retries (2)"),
            _valid_literal_output("Candlelight sways gently in the room."),
        ]
    )
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow,
        "agent",
        property(lambda _workflow: agent),
    )
    workflow = LiteralScriptWritingWorkflow(cognee_store=store, sqlite_store=store)
    logs = []

    script = await workflow.run(
        episode_num=1,
        source_text="INT. BEDCHAMBER - NIGHT\nXie Zheng: Go.\nCandlelight flickers.",
        on_log=logs.append,
    )

    assert agent.calls == 3
    assert len(script.beats) == 2
    assert script.beats[0].audio_type == "dialogue"
    assert script.beats[0].narration_segment == "Go."
    assert script.beats[0].visual_description == "Xie Zheng speaks."
    assert script.beats[1].visual_description == "Candlelight sways gently in the room."
    assert store.persisted is script
    assert workflow.last_degraded_lines == [1]
    assert workflow.last_review_passed is False
    assert "1 lines could not be generated normally by the model" in workflow.last_review_summary
    assert any("processing continues with the following lines" in message for message in logs)


@pytest.mark.asyncio
async def test_literal_workflow_does_not_retry_content_filter_and_uses_placeholder(
    monkeypatch,
):
    store = _LiteralRunStore()
    agent = _SequencedLiteralAgent(
        [
            ContentFilterError("Content filter triggered"),
            _valid_literal_output("Candlelight sways gently in the room."),
        ]
    )
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow,
        "agent",
        property(lambda _workflow: agent),
    )
    workflow = LiteralScriptWritingWorkflow(
        cognee_store=store,
        sqlite_store=store,
        audio_type_mode="narrated",
    )
    logs = []

    script = await workflow.run(
        episode_num=1,
        source_text="INT. BEDCHAMBER - NIGHT\nShen Wan grips the dagger.\nCandlelight flickers.",
        on_log=logs.append,
    )

    assert agent.calls == 2
    assert len(script.beats) == 2
    assert script.beats[0].audio_type == "silence"
    assert script.beats[0].narration_segment == ""
    assert script.beats[0].visual_description == "This line could not be generated; please complete it manually."
    assert "dagger" not in script.beats[0].model_dump_json()
    assert script.beats[1].visual_description == "Candlelight sways gently in the room."
    assert "Shen Wan grips the dagger." not in agent.prompts[1]
    assert "[previous line not provided due to content moderation]" in agent.prompts[1]
    assert workflow.last_degraded_lines == [1]
    assert workflow.last_review_passed is False
    assert any("was not retried" in message for message in logs)


@pytest.mark.asyncio
async def test_literal_workflow_does_not_send_unprocessed_next_line(monkeypatch):
    store = _LiteralRunStore()

    class _FilteringLiteralAgent:
        def __init__(self):
            self.calls = 0
            self.prompts = []

        async def run(self, prompt):
            self.calls += 1
            self.prompts.append(prompt)
            if "Shen Wan grips the dagger." in prompt:
                raise ContentFilterError("Content filter triggered")
            return SimpleNamespace(output=_valid_literal_output("Candlelight sways gently in the room."))

    agent = _FilteringLiteralAgent()
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow,
        "agent",
        property(lambda _workflow: agent),
    )
    workflow = LiteralScriptWritingWorkflow(cognee_store=store, sqlite_store=store)

    script = await workflow.run(
        episode_num=1,
        source_text="INT. BEDCHAMBER - NIGHT\nCandlelight flickers.\nShen Wan grips the dagger.",
    )

    assert agent.calls == 2
    assert "Shen Wan grips the dagger." not in agent.prompts[0]
    assert script.beats[0].visual_description == "Candlelight sways gently in the room."
    assert script.beats[1].visual_description == "This line could not be generated; please complete it manually."
    assert workflow.last_degraded_lines == [2]


@pytest.mark.asyncio
async def test_literal_workflow_does_not_degrade_gateway_403(monkeypatch):
    store = _LiteralRunStore()
    agent = _SequencedLiteralAgent(
        [ModelHTTPError(403, "brainclaw", {"error": "insufficient balance"})]
    )
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow,
        "agent",
        property(lambda _workflow: agent),
    )
    workflow = LiteralScriptWritingWorkflow(cognee_store=store, sqlite_store=store)

    with pytest.raises(ModelHTTPError) as exc_info:
        await workflow.run(
            episode_num=1,
            source_text="INT. BEDCHAMBER - NIGHT\nXie Zheng: Go.",
        )

    assert exc_info.value.status_code == 403
    assert agent.calls == 1
    assert store.persisted is None


@pytest.mark.asyncio
async def test_literal_workflow_does_not_degrade_malformed_gateway_response(
    monkeypatch,
):
    store = _LiteralRunStore()
    agent = _SequencedLiteralAgent(
        [UnexpectedModelBehavior("Invalid OpenAI-compatible gateway response")]
    )
    monkeypatch.setattr(
        LiteralScriptWritingWorkflow,
        "agent",
        property(lambda _workflow: agent),
    )
    workflow = LiteralScriptWritingWorkflow(cognee_store=store, sqlite_store=store)

    with pytest.raises(UnexpectedModelBehavior, match="Invalid OpenAI-compatible"):
        await workflow.run(
            episode_num=1,
            source_text="INT. BEDCHAMBER - NIGHT\nXie Zheng: Go.",
        )

    assert agent.calls == 1
    assert store.persisted is None

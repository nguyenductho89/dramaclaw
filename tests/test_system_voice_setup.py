from pathlib import Path
from types import SimpleNamespace

import pytest

from novelvideo.models import NovelCharacter


class _FakeStore:
    def __init__(self, project_dir: Path) -> None:
        self.project_dir = project_dir
        self.characters = [
            NovelCharacter(name="LinXia", gender="female", age_group="youth", is_main=True)
        ]
        self.beats = [
            {
                "beat_number": 1,
                "audio_type": "narration",
                "narration_segment": "Night covers the city.",
            },
            {
                "beat_number": 2,
                "audio_type": "dialogue",
                "speaker": "LinXia_casual",
                "narration_segment": "“Let us set off.”",
            },
        ]

    async def get_beats_as_dicts(self, episode: int):
        assert episode == 1
        return self.beats

    async def list_characters(self):
        return self.characters

    async def update_character(self, name: str, **updates):
        character = next(item for item in self.characters if item.name == name)
        for key, value in updates.items():
            setattr(character, key, value)


@pytest.mark.asyncio
async def test_prepare_missing_system_voices_fills_narrator_and_character(
    monkeypatch,
    tmp_path,
):
    from novelvideo.audio import indextts2_beat_audio_task
    from novelvideo.audio import system_voice_setup
    from novelvideo.generators.tts_generator import TTSResult

    narrator_updates: list[dict] = []

    class FakeEdgeTTSGenerator:
        def __init__(self, voice: str) -> None:
            self.voice = voice

        async def generate(self, *, text, output_path, generate_subtitle):  # noqa: ARG002
            path = Path(output_path)
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(f"audio:{self.voice}".encode())
            return TTSResult(success=True, audio_path=str(path))

    async def no_remaining_errors(**kwargs):  # noqa: ARG001
        return []

    monkeypatch.setattr(system_voice_setup, "EdgeTTSGenerator", FakeEdgeTTSGenerator)
    monkeypatch.setattr(
        system_voice_setup,
        "load_effective_narration_style_for_voice",
        lambda username, project: "third_person",
    )
    monkeypatch.setattr(
        system_voice_setup,
        "load_narrator_reference_audio",
        lambda username, project: {"path": ""},
    )
    monkeypatch.setattr(
        system_voice_setup,
        "set_narrator_reference_audio",
        lambda username, project, **kwargs: narrator_updates.append(kwargs),
    )
    monkeypatch.setattr(
        indextts2_beat_audio_task,
        "collect_indextts2_voice_prereq_errors",
        no_remaining_errors,
    )
    store = _FakeStore(tmp_path)

    result = await system_voice_setup.prepare_missing_system_voices(
        store=store,
        username="alice",
        project="demo",
        project_dir=tmp_path,
        episode=1,
    )

    assert result["ready"] is True
    assert result["prepared_count"] == 2
    assert {item["target"] for item in result["prepared"]} == {"Project narrator", "LinXia"}
    assert narrator_updates[0]["relative_path"] == "assets/narrator/voice.mp3"
    assert store.characters[0].reference_audio_path
    assert (tmp_path / store.characters[0].reference_audio_path).exists()


@pytest.mark.asyncio
async def test_system_voice_setup_runner_reports_progress(monkeypatch, tmp_path):
    from novelvideo.audio import system_voice_setup
    from novelvideo.task_backend.runners import audio
    from novelvideo import sqlite_store

    progress_updates = []

    class FakeRunnerStore:
        def __init__(self, *args, **kwargs):  # noqa: ARG002
            self.closed = False
            self.graph_state_loaded = False

        async def initialize(self):
            return None

        async def load_graph_state(self):
            self.graph_state_loaded = True

        async def close(self):
            self.closed = True

    class FakeManager:
        def update_progress_for_project(self, *args, **kwargs):
            progress_updates.append(kwargs)

    async def fake_prepare(**kwargs):
        assert kwargs["episode"] == 2
        assert kwargs["store"].graph_state_loaded is True
        return {
            "ready": True,
            "prepared": [{"target": "Project narrator"}],
            "prepared_count": 1,
            "remaining_errors": [],
        }

    monkeypatch.setattr(sqlite_store, "SQLiteStore", FakeRunnerStore)
    monkeypatch.setattr(system_voice_setup, "prepare_missing_system_voices", fake_prepare)
    monkeypatch.setattr(audio, "get_task_manager", lambda: FakeManager())
    ctx = SimpleNamespace(
        owner_project_label="alice/demo",
        owner_username="alice",
        project_name="demo",
        output_dir=tmp_path,
        state_dir=tmp_path / "state",
    )

    result = await audio._run_system_voice_setup({"episode": 2}, ctx)

    assert result["ready"] is True
    assert [update["progress"] for update in progress_updates] == [0.05, 1.0]

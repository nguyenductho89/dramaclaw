"""Prepare opt-in system-generated reference voices for the mainline agent."""

from __future__ import annotations

import re
from pathlib import Path

from novelvideo.utils.source_language import detect_episode_asset_language
from novelvideo.generators.tts_generator import EdgeTTSGenerator
from novelvideo.project_config import (
    load_effective_narration_style_for_voice,
    load_narrator_reference_audio,
    set_narrator_reference_audio,
)
from novelvideo.seedance2_i2v.character_voice_storage import (
    DEFAULT_SLOT,
    persist_character_voice_file,
    project_relative_path,
    utc_now_iso,
    voice_content_sha256,
)
from novelvideo.seedance2_i2v.voice_clone import (
    dialogue_text,
    narration_beat_text,
    normalize_seedance2_audio_type,
    resolve_dialogue_reference_audio,
    resolve_narrator_source,
)

SYSTEM_VOICE_SAMPLE_TEXTS = {
    "en": "Hello, this is a system-generated reference voice that keeps the whole production sounding stable and natural.",
    "vi": "Xin chào, đây là giọng tham chiếu do hệ thống tạo, giúp toàn bộ tác phẩm giữ được âm thanh ổn định và tự nhiên.",
}
NARRATOR_VOICES = {"en": "en-US-ChristopherNeural", "vi": "vi-VN-NamMinhNeural"}
FEMALE_VOICES = {
    "en": ("en-US-AriaNeural", "en-US-JennyNeural", "en-US-MichelleNeural"),
    "vi": ("vi-VN-HoaiMyNeural",),
}
MALE_VOICES = {
    "en": ("en-US-GuyNeural", "en-US-DavisNeural", "en-US-EricNeural"),
    "vi": ("vi-VN-NamMinhNeural",),
}
CHILD_VOICES = {"en": "en-US-AnaNeural", "vi": "vi-VN-HoaiMyNeural"}


def _system_voice_for_character(character, language: str = "en") -> str:
    language = "vi" if language == "vi" else "en"
    gender = str(getattr(character, "gender", "") or "").strip().lower()
    age_group = str(getattr(character, "age_group", "") or "").strip().lower()
    if gender in {"female", "woman", "girl", "f"}:
        if age_group == "child":
            return CHILD_VOICES[language]
        pool = FEMALE_VOICES[language]
    else:
        pool = MALE_VOICES[language]
    stable_index = sum(ord(char) for char in str(getattr(character, "name", "") or ""))
    return pool[stable_index % len(pool)]


def _safe_voice_filename(voice: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", voice).strip("._") or "system_voice"


async def _system_voice_content(
    *,
    project_dir: Path,
    voice: str,
    cache: dict[str, bytes],
    language: str = "en",
) -> bytes:
    cached = cache.get(voice)
    if cached:
        return cached
    cache_dir = project_dir / "assets" / "system_voices"
    output_path = cache_dir / f"{_safe_voice_filename(voice)}.mp3"
    if not output_path.exists() or output_path.stat().st_size <= 0:
        result = await EdgeTTSGenerator(voice=voice).generate(
            text=SYSTEM_VOICE_SAMPLE_TEXTS["vi" if language == "vi" else "en"],
            output_path=str(output_path),
            generate_subtitle=False,
        )
        if not result.success or not output_path.exists():
            raise RuntimeError(result.error or f"System voice generation failed: {voice}")
    content = output_path.read_bytes()
    if not content:
        raise RuntimeError(f"System voice generation returned an empty result: {voice}")
    cache[voice] = content
    return content


def _matching_character(speaker: str, characters: list):
    return next(
        (character for character in characters if speaker.startswith(character.name)),
        None,
    )


async def prepare_missing_system_voices(
    *,
    store,
    username: str,
    project: str,
    project_dir: str | Path,
    episode: int,
) -> dict:
    """Fill only missing narrator/character voice references with system presets."""

    root = Path(project_dir)
    beats = list(await store.get_beats_as_dicts(episode))
    characters = list(await store.list_characters())
    character_targets: dict[str, object] = {}
    needs_narrator = False
    unresolved_speakers: set[str] = set()

    for beat in beats:
        audio_type = normalize_seedance2_audio_type(beat)
        if audio_type == "narration" and narration_beat_text(beat):
            needs_narrator = True
        elif audio_type == "dialogue" and dialogue_text(beat):
            if await resolve_dialogue_reference_audio(beat, store) is not None:
                continue
            speaker = str(beat.get("speaker") or "").strip()
            character = _matching_character(speaker, characters)
            if character is None:
                unresolved_speakers.add(speaker or "Unspecified speaking identity")
            else:
                character_targets[character.name] = character

    narration_style = load_effective_narration_style_for_voice(username, project)
    if needs_narrator:
        stored = load_narrator_reference_audio(username, project)
        resolution = resolve_narrator_source(
            store=store,
            narration_style=narration_style,
            project_narrator_stored_path=stored.get("path", ""),
            characters=characters,
        )
        if resolution.audio_path is None and narration_style == "first_person":
            protagonist = next((character for character in characters if character.is_main), None)
            if protagonist is not None:
                character_targets[protagonist.name] = protagonist

    language = await detect_episode_asset_language(store, episode)
    narrator_voice = NARRATOR_VOICES[language]
    prepared: list[dict[str, str]] = []
    content_cache: dict[str, bytes] = {}

    if needs_narrator and narration_style != "first_person":
        stored = load_narrator_reference_audio(username, project)
        resolution = resolve_narrator_source(
            store=store,
            narration_style=narration_style,
            project_narrator_stored_path=stored.get("path", ""),
            characters=characters,
        )
        if resolution.audio_path is None:
            content = await _system_voice_content(
                project_dir=root,
                voice=narrator_voice,
                cache=content_cache,
                language=language,
            )
            target = root / "assets" / "narrator" / "voice.mp3"
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(content)
            set_narrator_reference_audio(
                username,
                project,
                relative_path=project_relative_path(root, target),
                sha256=voice_content_sha256(content),
            )
            prepared.append(
                {"target": "Project narrator", "voice": narrator_voice, "slot": "narrator"}
            )

    for character_name, character in character_targets.items():
        voice = _system_voice_for_character(character, language)
        content = await _system_voice_content(
            project_dir=root,
            voice=voice,
            cache=content_cache,
            language=language,
        )
        rel_path, sha256, updated_at = persist_character_voice_file(
            project_dir=root,
            character_name=character_name,
            slot=DEFAULT_SLOT,
            filename="system_voice.mp3",
            content=content,
        )
        await store.update_character(
            character_name,
            reference_audio_path=rel_path,
            reference_audio_sha256=sha256,
            reference_audio_updated_at=updated_at or utc_now_iso(),
        )
        prepared.append(
            {"target": character_name, "voice": voice, "slot": DEFAULT_SLOT}
        )

    from novelvideo.audio.indextts2_beat_audio_task import (
        collect_indextts2_voice_prereq_errors,
    )

    remaining = await collect_indextts2_voice_prereq_errors(
        store=store,
        username=username,
        project=project,
        episode=episode,
        beat_numbers=None,
        mode="sync_changed",
    )
    for speaker in sorted(unresolved_speakers):
        detail = f"No character found for the speaking identity: {speaker}"
        if detail not in remaining:
            remaining.append(detail)
    return {
        "prepared": prepared,
        "prepared_count": len(prepared),
        "remaining_errors": remaining,
        "ready": not remaining,
        # Stable code the frontend branches on when system voices are still required.
        "code": "" if not remaining else "system_voice_required",
    }

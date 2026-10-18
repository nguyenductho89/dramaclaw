from __future__ import annotations

import asyncio
import io
import os
import stat
import threading
import zipfile
from pathlib import Path
from types import SimpleNamespace

import anyio
import pytest
from fastapi import UploadFile

from novelvideo.api.schemas import IngestStart

pytestmark = pytest.mark.m03

NOVEL_TEXT = "Chapter 1 Departure\nThe King of Qin enters the palace.\nChapter 2 Rising Wind\nWind rises at the palace gate."
FANTASY_META_TEXT = (
    "Chapter 1 Transmigration\n"
    "Su Tang opens her eyes and finds herself in an unfamiliar palace.\n"
    "Su Tang OS: In the original book, chapter 9, the northern fake squad is ambushed, losing thirty.\n"
    "He says softly: I remember chapter 7 was not written like this.\n"
    "Chapter 2 Breaking the Deadlock\n"
    "Su Tang decides to rewrite her fate herself.\n"
    "Narrator: This scene actually happens before chapter 18 of the original book.\n"
)


class _NovelStore:
    def __init__(self, text: str):
        self.text = text

    def load_novel_content(self):
        return self.text


def _legacy_resolution(project_dir):
    return SimpleNamespace(
        ctx=None,
        username="admin",
        project_name="demo",
        project_dir=project_dir,
        output_dir=str(project_dir / "output"),
        state_dir=str(project_dir / "state"),
        runtime_dir=str(project_dir / "runtime"),
    )


def _project_scope_resolver(project_dir):
    async def resolve(*args, **kwargs):
        return _legacy_resolution(project_dir)

    return resolve


def _docx_bytes(paragraphs: list[str]) -> bytes:
    document_body = "".join(
        f"<w:p><w:r><w:t>{paragraph}</w:t></w:r></w:p>" for paragraph in paragraphs
    )
    document_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>{document_body}</w:body>
</w:document>
"""
    document_content_type = (
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"
    )
    office_document_rel = (
        "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    )
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr(
            "[Content_Types].xml",
            (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n'
                '  <Default Extension="rels" '
                'ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n'
                '  <Default Extension="xml" ContentType="application/xml"/>\n'
                '  <Override PartName="/word/document.xml" '
                f'ContentType="{document_content_type}"/>\n'
                "</Types>\n"
            ),
        )
        archive.writestr(
            "_rels/.rels",
            (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n'
                f'  <Relationship Id="rId1" Type="{office_document_rel}" '
                'Target="word/document.xml"/>\n'
                "</Relationships>\n"
            ),
        )
        archive.writestr("word/document.xml", document_xml)
    return buffer.getvalue()


def _preview_lines(content: str) -> list[str]:
    return content.replace("\r\n", "\n").replace("\r", "\n").split("\n")


def test_chapter_preview_ignores_embedded_chapter_references():
    from novelvideo.api.chapter_preview import build_chapter_preview

    data = build_chapter_preview(FANTASY_META_TEXT)

    assert data["count"] == 2
    assert [chapter["number"] for chapter in data["chapters"]] == [1, 2]
    assert "In the original book, chapter 9" in data["chapters"][0]["content"]
    assert "chapter 18 of the original book" in data["chapters"][1]["content"]


def test_chapter_preview_does_not_split_episode_end_sentence():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "# Episode 1",
            "The opening is the climax.",
            "Episode 1 ends.",
            "Episode 1 End.",
            "Episode 1 has already ended.",
            "Episode 1 ends here.",
            "---",
            "# Episode 2",
            "Lin Yuan goes home.",
        ]
    )

    data = build_chapter_preview(text)

    assert data["count"] == 2
    assert [chapter["number"] for chapter in data["chapters"]] == [1, 2]
    assert "Episode 1 ends." in data["chapters"][0]["content"]
    assert "Episode 1 has already ended." in data["chapters"][0]["content"]
    assert "Episode 1 ends here." in data["chapters"][0]["content"]


def test_chapter_preview_does_not_split_english_episode_end_sentence():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "Episode 1: The Reset",
            "The opening is a shock.",
            "Episode 1 ends here.",
            "Episode 1 Ends here.",
            "Episode 1. Ends here.",
            "---",
            "Episode 2 - Aftermath",
            "He returns home.",
        ]
    )

    data = build_chapter_preview(text)

    assert data["count"] == 2
    assert [chapter["number"] for chapter in data["chapters"]] == [1, 2]
    assert "Episode 1 ends here." in data["chapters"][0]["content"]
    assert "Episode 1 Ends here." in data["chapters"][0]["content"]
    assert "Episode 1. Ends here." in data["chapters"][0]["content"]


def test_chapter_preview_accepts_dot_after_english_marker_number():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "Chapter 1. Introduction",
            "The story starts.",
            "Episode 2. Aftermath",
            "The aftermath unfolds.",
        ]
    )

    data = build_chapter_preview(text)

    assert data["count"] == 2
    assert [chapter["number"] for chapter in data["chapters"]] == [1, 2]
    assert data["chapters"][0]["title"] == "Chapter 1. Introduction"
    assert data["chapters"][1]["title"] == "Episode 2. Aftermath"


def test_chapter_preview_keeps_valid_titles_after_marker():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "Episode 1 The Perfect Plan",
            "Lin Yuan begins to plan.",
            "Episode 2 The Complete Clue",
            "The clue surfaces.",
            "Episode 3 Who Is the Killer?",
            "The question surfaces.",
            "Episode 4 He's Back!",
            "The door is pushed open.",
            "Episode 5 the reset",
            "The reset begins.",
            "Chapter6 What Happens Next?",
            "The question remains.",
            "Chapter7 The Return!",
            "He returns home.",
        ]
    )

    data = build_chapter_preview(text)

    assert data["count"] == 7
    assert [chapter["number"] for chapter in data["chapters"]] == [1, 2, 3, 4, 5, 6, 7]
    assert data["chapters"][0]["title"] == "Episode 1 The Perfect Plan"
    assert data["chapters"][2]["title"] == "Episode 3 Who Is the Killer?"
    assert data["chapters"][3]["title"] == "Episode 4 He's Back!"
    assert data["chapters"][4]["title"] == "Episode 5 the reset"
    assert data["chapters"][5]["title"] == "Chapter6 What Happens Next?"
    assert data["chapters"][6]["title"] == "Chapter7 The Return!"


def test_chapter_preview_includes_scene_blocks_within_each_episode():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "Episode 1: First Meeting",
            "1-1 Rainy Alley NIGHT EXT",
            "Characters: Lin Zhao, Su Ran",
            "△ Lin Zhao stops under the eaves.",
            "1-2 Tea House DAY INT",
            "Characters: Su Ran",
            "△ Su Ran pushes the door open.",
            "Episode 2: Reunion",
            "2-1 Pier DUSK EXT",
            "Characters: Lin Zhao",
            "△ The ferry docks.",
        ]
    )

    data = build_chapter_preview(text, include_scene_blocks=True)

    assert data["count"] == 2
    first_scenes = data["chapters"][0]["scene_blocks"]
    second_scenes = data["chapters"][1]["scene_blocks"]
    assert [scene["scene_no"] for scene in first_scenes] == ["1", "2"]
    assert first_scenes[0] == {
        "header": "1-1 Rainy Alley NIGHT EXT",
        "scene_no": "1",
        "location": "Rainy Alley",
        "time_of_day": "night",
        "interior_exterior": "ext",
        "characters": ["Lin Zhao", "Su Ran"],
        "content_start_line": 3,
        "content_end_line": 4,
    }
    assert (
        _preview_lines(data["chapters"][0]["content"])[
            first_scenes[0]["content_start_line"]
            : first_scenes[0]["content_end_line"]
        ]
        == ["△ Lin Zhao stops under the eaves."]
    )
    assert [scene["location"] for scene in second_scenes] == ["Pier"]


def test_chapter_preview_skips_scene_parsing_unless_requested(monkeypatch):
    from novelvideo.api import chapter_preview

    monkeypatch.setattr(
        chapter_preview,
        "parse_scene_blocks",
        lambda _content: pytest.fail("scene parsing should be skipped"),
    )

    data = chapter_preview.build_chapter_preview("Chapter 1 First Meeting\nbody text")

    assert "scene_blocks" not in data["chapters"][0]


def test_chapter_preview_keeps_text_before_first_scene_header():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "Episode 1: First Meeting",
            "This note is not yet assigned to any scene.",
            "1-1 Rainy Alley NIGHT EXT",
            "Characters: Lin Zhao",
            "△ Lin Zhao stops under the eaves.",
        ]
    )

    data = build_chapter_preview(text, include_scene_blocks=True)

    chapter = data["chapters"][0]
    start = chapter["unparsed_content_start_line"]
    end = chapter["unparsed_content_end_line"]
    assert _preview_lines(chapter["content"])[start:end] == [
        "This note is not yet assigned to any scene."
    ]


def test_chapter_preview_scene_ranges_keep_blank_lines():
    from novelvideo.api.chapter_preview import build_chapter_preview

    text = "\n".join(
        [
            "Episode 1: First Meeting",
            "1-1 Rainy Alley NIGHT EXT",
            "Characters: Lin Zhao",
            "△ Lin Zhao stops under the eaves.",
            "",
            "Lin Zhao: The rain has not stopped.",
        ]
    )

    data = build_chapter_preview(text, include_scene_blocks=True)

    chapter = data["chapters"][0]
    scene = chapter["scene_blocks"][0]
    assert _preview_lines(chapter["content"])[
        scene["content_start_line"] : scene["content_end_line"]
    ] == ["△ Lin Zhao stops under the eaves.", "", "Lin Zhao: The rain has not stopped."]


@pytest.mark.asyncio
async def test_upload_novel_returns_nicegui_chapter_preview(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    raw = NOVEL_TEXT.encode("utf-8")
    upload = UploadFile(file=io.BytesIO(raw), filename="novel.txt")

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    data = response["data"]
    assert data["filename"] == "novel.txt"
    assert data["size"] == len(raw)
    assert data["total_chars"] == len(NOVEL_TEXT)
    assert data["billable_chars"] == len("".join(NOVEL_TEXT.split()))
    assert data["count"] == 2
    assert data["chapters"][0]["number"] == 1
    assert data["chapters"][0]["title"] == "Chapter 1 Departure"
    assert data["chapters"][0]["content"].startswith("Chapter")
    assert data["chapters"][0]["word_count"] == len(data["chapters"][0]["content"])
    uploads_dir = tmp_path / "uploads"
    assert (uploads_dir / "novel.txt").read_bytes() == raw
    assert list((uploads_dir / ".staging").glob("upload-*")) == []


@pytest.mark.asyncio
async def test_upload_novel_runs_staging_parse_and_preview_off_event_loop(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    event_loop_thread = threading.get_ident()
    worker_threads: list[int] = []
    real_stream = ingest.stream_to_file_with_limit
    real_load = ingest.load_novel_text
    real_preview = ingest.build_chapter_preview

    def tracking_stream(*args, **kwargs):
        worker_threads.append(threading.get_ident())
        return real_stream(*args, **kwargs)

    def tracking_load(*args, **kwargs):
        worker_threads.append(threading.get_ident())
        return real_load(*args, **kwargs)

    def tracking_preview(*args, **kwargs):
        worker_threads.append(threading.get_ident())
        return real_preview(*args, **kwargs)

    monkeypatch.setattr(ingest, "stream_to_file_with_limit", tracking_stream)
    monkeypatch.setattr(ingest, "load_novel_text", tracking_load)
    monkeypatch.setattr(ingest, "build_chapter_preview", tracking_preview)

    response = await ingest.upload_novel(
        project="demo",
        file=UploadFile(
            file=io.BytesIO(NOVEL_TEXT.encode("utf-8")),
            filename="novel.txt",
        ),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert len(worker_threads) == 3
    assert len(set(worker_threads)) == 1
    assert worker_threads[0] != event_loop_thread


@pytest.mark.asyncio
async def test_cancelled_upload_keeps_capacity_and_cleans_staging_after_worker_finishes(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    limiter = anyio.CapacityLimiter(1)
    limiter_var = ingest.RunVar("test_ingest_upload_limiter")
    limiter_var.set(limiter)
    monkeypatch.setattr(ingest, "_ingest_upload_limiter_var", limiter_var)

    first_entered = threading.Event()
    second_entered = threading.Event()
    release_first = threading.Event()
    real_load = ingest.load_novel_text

    def blocking_load(path):
        if Path(path).name.startswith("upload-") and not first_entered.is_set():
            first_entered.set()
            release_first.wait(timeout=5)
        else:
            second_entered.set()
        return real_load(path)

    monkeypatch.setattr(ingest, "load_novel_text", blocking_load)

    first_task = asyncio.create_task(
        ingest.upload_novel(
            project="demo",
            file=UploadFile(
                file=io.BytesIO(NOVEL_TEXT.encode("utf-8")),
                filename="first.txt",
            ),
            user={"username": "admin"},
        )
    )
    assert await asyncio.to_thread(first_entered.wait, 1)
    first_task.cancel()
    await asyncio.sleep(0)

    second_task = asyncio.create_task(
        ingest.upload_novel(
            project="demo",
            file=UploadFile(
                file=io.BytesIO(NOVEL_TEXT.encode("utf-8")),
                filename="second.txt",
            ),
            user={"username": "admin"},
        )
    )

    async def wait_until_second_is_queued() -> None:
        while limiter.statistics().tasks_waiting != 1:
            await asyncio.sleep(0)

    await asyncio.wait_for(wait_until_second_is_queued(), timeout=1)
    assert limiter.borrowed_tokens == 1
    assert not first_task.done()
    assert not second_entered.is_set()
    assert list((tmp_path / "uploads" / ".staging").glob("upload-*"))

    release_first.set()
    with pytest.raises(asyncio.CancelledError):
        await first_task
    second_response = await second_task

    assert second_response["ok"] is True
    assert second_entered.is_set()
    assert list((tmp_path / "uploads" / ".staging").glob("upload-*")) == []


@pytest.mark.asyncio
async def test_upload_novel_preserves_anyio_cancel_scope_marker_and_cleans_staging(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    worker_entered = threading.Event()
    release_worker = threading.Event()
    real_load = ingest.load_novel_text

    def blocking_load(path):
        worker_entered.set()
        release_worker.wait(timeout=5)
        return real_load(path)

    async def cancel_and_release(scope: anyio.CancelScope) -> None:
        assert await asyncio.to_thread(worker_entered.wait, 1)
        scope.cancel()
        await asyncio.sleep(0)
        release_worker.set()

    monkeypatch.setattr(ingest, "load_novel_text", blocking_load)

    with anyio.CancelScope() as scope:
        canceller = asyncio.create_task(cancel_and_release(scope))
        await ingest.upload_novel(
            project="demo",
            file=UploadFile(
                file=io.BytesIO(NOVEL_TEXT.encode("utf-8")),
                filename="novel.txt",
            ),
            user={"username": "admin"},
        )
    await canceller

    assert scope.cancel_called
    assert list((tmp_path / "uploads" / ".staging").glob("upload-*")) == []


@pytest.mark.asyncio
async def test_upload_novel_new_file_respects_restrictive_umask(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    previous_umask = os.umask(0o077)
    try:
        response = await ingest.upload_novel(
            project="demo",
            file=UploadFile(
                file=io.BytesIO(NOVEL_TEXT.encode("utf-8")),
                filename="novel.txt",
            ),
            user={"username": "admin"},
        )
    finally:
        os.umask(previous_umask)

    assert response["ok"] is True
    uploaded = tmp_path / "uploads" / "novel.txt"
    assert stat.S_IMODE(uploaded.stat().st_mode) == 0o600


@pytest.mark.asyncio
async def test_upload_novel_preserves_existing_file_mode(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    existing = uploads_dir / "novel.txt"
    existing.write_text("Chapter 1 Old content\nOld content.", encoding="utf-8")
    existing.chmod(0o640)
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    raw = NOVEL_TEXT.encode("utf-8")
    response = await ingest.upload_novel(
        project="demo",
        file=UploadFile(file=io.BytesIO(raw), filename="novel.txt"),
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert existing.read_bytes() == raw
    assert stat.S_IMODE(existing.stat().st_mode) == 0o640


@pytest.mark.asyncio
async def test_upload_narrated_novel_skips_scene_preview(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    raw = (
        "Chapter 1 First Meeting\n1-1 Rainy Alley NIGHT EXT\nCharacters: Lin Zhao\n△ Lin Zhao stops under the eaves."
    ).encode()

    response = await ingest.upload_novel(
        project="demo",
        file=UploadFile(file=io.BytesIO(raw), filename="novel.txt"),
        spine_template="narrated",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert "scene_blocks" not in response["data"]["chapters"][0]


@pytest.mark.asyncio
async def test_upload_novel_returns_chapter_preview_for_docx(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    raw = _docx_bytes(["Chapter 1 Departure", "The King of Qin enters the palace.", "Chapter 2 Rising Wind", "Wind rises at the palace gate."])
    upload = UploadFile(file=io.BytesIO(raw), filename="novel.docx")

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is True
    data = response["data"]
    assert data["filename"] == "novel.docx"
    assert data["count"] == 2
    assert data["chapters"][0]["title"] == "Chapter 1 Departure"
    assert data["chapters"][0]["content"] == "Chapter 1 Departure\n\nThe King of Qin enters the palace.\n"
    assert data["chapters"][1]["content"].startswith("Chapter 2 Rising Wind")


@pytest.mark.asyncio
async def test_upload_novel_rejects_unsupported_extension(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    upload = UploadFile(file=io.BytesIO(b"%PDF-1.7"), filename="novel.pdf")

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert "Unsupported" in response["error"]
    assert not (tmp_path / "uploads" / "novel.pdf").exists()


@pytest.mark.asyncio
async def test_upload_novel_rejects_preview_decode_failure(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    raw = b"\xff\xfe\x00\x81"
    upload = UploadFile(file=io.BytesIO(raw), filename="broken.txt")

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert "parse" in response["error"]


@pytest.mark.asyncio
async def test_upload_novel_parse_failure_preserves_existing_same_name(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    existing = uploads_dir / "novel.txt"
    existing.write_text(NOVEL_TEXT, encoding="utf-8")
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    upload = UploadFile(file=io.BytesIO(b"\xff\xfe\x00\x81"), filename="novel.txt")

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert existing.read_text(encoding="utf-8") == NOVEL_TEXT
    assert list((uploads_dir / ".staging").glob("upload-*")) == []


@pytest.mark.asyncio
async def test_upload_novel_text_too_large_preserves_existing_same_name(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    existing = uploads_dir / "novel.txt"
    existing.write_text(NOVEL_TEXT, encoding="utf-8")
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    replacement = "Chapter 1\n" + "x" * 100_000
    upload = UploadFile(
        file=io.BytesIO(replacement.encode("utf-8")),
        filename="novel.txt",
    )

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert response["error_type"] == "text_too_large"
    assert response["data"] == {
        "limit_chars": 100_000,
        "actual_chars": 100_008,
    }
    assert "100,008 characters" in response["error"]
    assert "100,000 characters" in response["error"]
    assert existing.read_text(encoding="utf-8") == NOVEL_TEXT
    assert list((uploads_dir / ".staging").glob("upload-*")) == []


@pytest.mark.asyncio
async def test_upload_novel_file_too_large_preserves_existing_same_name(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    existing = uploads_dir / "novel.txt"
    existing.write_text(NOVEL_TEXT, encoding="utf-8")
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    upload = UploadFile(
        file=io.BytesIO(b"x" * (512 * 1024 + 1)),
        filename="novel.txt",
    )
    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response == {
        "ok": False,
        "error": "The file exceeds the 512KB limit. Compress the file or split the body text and upload again.",
        "error_type": "file_too_large",
        "data": {"limit_bytes": 512 * 1024},
    }
    assert existing.read_text(encoding="utf-8") == NOVEL_TEXT
    assert list((uploads_dir / ".staging").glob("upload-*")) == []


@pytest.mark.asyncio
async def test_upload_novel_rejects_empty_preview(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    upload = UploadFile(file=io.BytesIO(b""), filename="empty.txt")

    response = await ingest.upload_novel(
        project="demo",
        file=upload,
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert "chapter" in response["error"]


@pytest.mark.asyncio
async def test_start_ingest_rejects_unsupported_extension_before_ray(tmp_path, monkeypatch):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    (uploads_dir / "novel.pdf").write_bytes(b"%PDF-1.7")
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    response = await ingest.start_ingest(
        project="demo",
        body=IngestStart(filename="novel.pdf", rebuild=True),
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert "Unsupported" in response["error"]


@pytest.mark.asyncio
async def test_start_ingest_rejects_existing_file_over_character_limit(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    oversized_text = "Chapter\n" + "x" * 99_997
    (uploads_dir / "novel.txt").write_text(oversized_text, encoding="utf-8")
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    monkeypatch.setattr(
        ingest,
        "save_project_config_in_state_dir",
        lambda *_args, **_kwargs: pytest.fail("oversized text must not save config"),
    )

    response = await ingest.start_ingest(
        project="demo",
        body=IngestStart(
            filename="novel.txt",
            rebuild=True,
            spine_template="narrated",
        ),
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert response["error_type"] == "text_too_large"
    assert response["data"] == {
        "limit_chars": 100_000,
        "actual_chars": 100_004,
    }


@pytest.mark.asyncio
async def test_start_ingest_rejects_existing_file_over_size_limit_before_parse(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    (uploads_dir / "novel.txt").write_bytes(b"x" * (1024 * 1024 + 1))
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    monkeypatch.setattr(
        ingest,
        "load_novel_text",
        lambda _path: pytest.fail("oversized file must not be parsed"),
    )

    response = await ingest.start_ingest(
        project="demo",
        body=IngestStart(
            filename="novel.txt",
            rebuild=True,
            spine_template="narrated",
        ),
        user={"username": "admin"},
    )

    assert response == {
        "ok": False,
        "error": "The file exceeds the 1MB limit. Compress the file or split the body text and upload again.",
        "error_type": "file_too_large",
        "data": {"limit_bytes": 1024 * 1024},
    }


@pytest.mark.asyncio
async def test_detect_chapters_returns_content_and_total_chars(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes

    monkeypatch.setattr(
        episodes,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    async def make_store(username: str, project: str):
        return _NovelStore(NOVEL_TEXT)

    monkeypatch.setattr(episodes, "make_sqlite_store", make_store)

    response = await episodes.detect_chapters(
        project="demo",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    data = response["data"]
    assert data["total_chars"] == len(NOVEL_TEXT)
    assert data["count"] == 2
    assert data["chapters"][1]["number"] == 2
    assert data["chapters"][1]["title"] == "Chapter 2 Rising Wind"
    assert data["chapters"][1]["content"].startswith("Chapter")
    assert data["chapters"][1]["word_count"] == len(data["chapters"][1]["content"])
    assert data["source_filename"] == "novel.txt"


@pytest.mark.asyncio
async def test_detect_chapters_skips_scene_preview_for_narrated_project(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import episodes

    screenplay = "Chapter 1 First Meeting\n1-1 Rainy Alley NIGHT EXT\nCharacters: Lin Zhao\n△ Lin Zhao stops under the eaves."
    monkeypatch.setattr(
        episodes,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    monkeypatch.setattr(
        episodes,
        "load_project_config_file_from_state_dir",
        lambda _state_dir: {"spine_template": "narrated"},
    )

    async def make_store(username: str, project: str):
        return _NovelStore(screenplay)

    monkeypatch.setattr(episodes, "make_sqlite_store", make_store)

    response = await episodes.detect_chapters(
        project="demo",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert "scene_blocks" not in response["data"]["chapters"][0]


@pytest.mark.asyncio
async def test_detect_chapters_query_template_overrides_saved_project_type(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import episodes

    screenplay = "Chapter 1 First Meeting\n1-1 Rainy Alley NIGHT EXT\nCharacters: Lin Zhao\n△ Lin Zhao stops under the eaves."
    monkeypatch.setattr(
        episodes,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )
    monkeypatch.setattr(
        episodes,
        "load_project_config_file_from_state_dir",
        lambda _state_dir: {"spine_template": "narrated"},
    )

    async def make_store(username: str, project: str):
        return _NovelStore(screenplay)

    monkeypatch.setattr(episodes, "make_sqlite_store", make_store)

    response = await episodes.detect_chapters(
        project="demo",
        spine_template="drama",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"]["chapters"][0]["scene_blocks"][0]["location"] == "Rainy Alley"


@pytest.mark.asyncio
async def test_detect_chapters_backfills_existing_upload_source(tmp_path, monkeypatch):
    from novelvideo.api.routes import episodes

    uploads_dir = tmp_path / "uploads"
    uploads_dir.mkdir()
    (uploads_dir / "original-novel.txt").write_text(NOVEL_TEXT, encoding="utf-8")
    monkeypatch.setattr(
        episodes,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    async def make_store(username: str, project: str):
        return _NovelStore(NOVEL_TEXT)

    monkeypatch.setattr(episodes, "make_sqlite_store", make_store)

    response = await episodes.detect_chapters(
        project="demo",
        user={"username": "admin"},
    )

    assert response["ok"] is True
    assert response["data"]["source_filename"] == "original-novel.txt"


@pytest.mark.asyncio
async def test_start_ingest_preserves_legacy_canonical_novel_for_reimport(
    tmp_path, monkeypatch
):
    from novelvideo.api.routes import ingest

    canonical = tmp_path / "novel.txt"
    canonical.write_text(NOVEL_TEXT, encoding="utf-8")
    monkeypatch.setattr(
        ingest,
        "resolve_project_scope",
        _project_scope_resolver(tmp_path),
    )

    response = await ingest.start_ingest(
        project="demo",
        body=IngestStart(
            filename="novel.txt",
            rebuild=True,
            spine_template="narrated",
        ),
        user={"username": "admin"},
    )

    assert response["ok"] is False
    assert "project context" in response["error"]
    preserved = tmp_path / "uploads" / "novel.txt"
    assert preserved.read_text(encoding="utf-8") == NOVEL_TEXT
    assert canonical.read_text(encoding="utf-8") == NOVEL_TEXT

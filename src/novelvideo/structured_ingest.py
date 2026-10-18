"""Import for structured_v1 projects: no graph, no embedding, no vector index.

The legacy import spends most of its wall clock inside ``cognee.add`` /
``cognify`` / ``memify``, and every one of those calls goes through the shared
embedding model.  Structured projects need none of it: extraction reads the
source text directly, so import reduces to validating the upload, persisting it,
and recording a deterministic chunk plan for later analysis.

The validation order matches the legacy path deliberately, including the rule
that ``novel.txt`` is written last.  That file is the public "import succeeded"
marker: several routes treat its presence as proof the project is importable,
so it must not appear while the import can still fail.
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any, Callable, Optional

from novelvideo.i18n_message import MessageLike, lmsg
from novelvideo.story_analysis import chunk_source_text, source_sha256
from novelvideo.utils.document_parsers import load_novel_text

# Bump when the chunking contract changes in a way that invalidates stored chunk
# results — different chunk ids, boundaries or offsets. A run is reused only
# when source text, schema version, this version and the spine template all
# match, so a bump simply starts a fresh plan rather than corrupting an old one.
STRUCTURED_PIPELINE_VERSION = "structured_v1"
STRUCTURED_ANALYSIS_VERSION = "structured_analysis_v2"
STRUCTURED_SCHEMA_VERSION = 1

_PROGRESS = {
    "read": 0.05,
    "validated": 0.25,
    "chunked": 0.60,
    "planned": 0.85,
    "save": 0.95,
    "complete": 1.0,
}


async def ingest_source_text_structured(
    store: Any,
    novel_path: str,
    *,
    spine_template: str | None = None,
    on_progress: Optional[Callable[[float, str], None]] = None,
    on_log: Optional[Callable[[str], None]] = None,
) -> dict:
    """Validate, chunk and persist an import without building any graph.

    ``store`` is a SQLiteStore (or anything exposing the same content and
    analysis-run methods).
    """

    def report(progress: float, task: MessageLike) -> None:
        if on_progress:
            on_progress(progress, task)

    def log(message: MessageLike) -> None:
        if on_log:
            on_log(message)

    if not Path(novel_path).exists():
        raise FileNotFoundError(f"File not found: {novel_path}")

    report(_PROGRESS["read"], lmsg("tasks.progress.ingest.reading", "Reading and validating source text..."))
    log(lmsg("tasks.log.ingest.readingFile", f"Reading file: {novel_path}", path=str(novel_path)))
    content = load_novel_text(novel_path)
    if not content.strip():
        raise ValueError("The novel is empty and cannot be imported")
    log(
        lmsg(
            "tasks.log.ingest.readComplete",
            f"File read complete: {len(content)} characters",
            charCount=len(content),
        )
    )

    template = str(spine_template or "").strip()
    if template == "drama":
        from novelvideo.utils.screenplay_quality import assess_screenplay_scene_headers

        if assess_screenplay_scene_headers(content).status == "missing":
            raise ValueError("A premium drama must contain scene headings; add them and re-import")
    report(
        _PROGRESS["validated"],
        lmsg("tasks.progress.ingest.validated", "Source text validated"),
    )

    report(
        _PROGRESS["chunked"],
        lmsg("tasks.progress.ingest.chunking", "Splitting source text..."),
    )
    chunks = chunk_source_text(content, template)
    if not chunks:
        raise ValueError("Source text split produced no chunks and cannot be analyzed")
    section_type = chunks[0].section_type
    log(
        lmsg(
            "tasks.log.ingest.chunked",
            f"Deterministic split complete: {len(chunks)} chunks ({section_type})",
            chunkCount=len(chunks),
            sectionType=section_type,
        )
    )

    report(
        _PROGRESS["planned"],
        lmsg("tasks.progress.ingest.planning", "Recording analysis plan..."),
    )
    digest = source_sha256(content)
    reused = await store.get_reusable_analysis_run(
        source_sha256=digest,
        schema_version=STRUCTURED_SCHEMA_VERSION,
        pipeline_version=STRUCTURED_ANALYSIS_VERSION,
        spine_template=template,
    )
    if reused:
        # Identical text analysed by identical code: keep the existing run so a
        # re-import resumes its completed chunks instead of discarding them.
        run_id = str(reused["run_id"])
        log(
            lmsg(
                "tasks.log.ingest.planReused",
                f"Reusing existing analysis plan: {run_id}",
                runId=run_id,
            )
        )
    else:
        run_id = uuid.uuid4().hex
        await store.start_analysis_run(
            run_id=run_id,
            pipeline_version=STRUCTURED_ANALYSIS_VERSION,
            schema_version=STRUCTURED_SCHEMA_VERSION,
            spine_template=template,
            source_sha256=digest,
            source_length=len(content),
            chunks=chunks,
        )
        log(
            lmsg(
                "tasks.log.ingest.planRecorded",
                f"Analysis plan recorded: {run_id}",
                runId=run_id,
            )
        )

    # novel.txt is the public success marker and therefore lands last.
    report(
        _PROGRESS["save"],
        lmsg("tasks.progress.ingest.saving", "Saving import result..."),
    )
    store.save_novel_content(content)
    log(lmsg("tasks.log.ingest.sourceSaved", "Source text saved"))

    report(
        _PROGRESS["complete"],
        lmsg("tasks.progress.ingest.complete", "Import complete"),
    )
    return {
        "char_count": len(content),
        "status": "source_ready",
        "pipeline": "structured_v1",
        "run_id": run_id,
        "chunks": len(chunks),
        "section_type": section_type,
    }

# Long Novel Import

The upload and import endpoints validate the source text according to the project's `knowledge_pipeline`. Character counts exclude whitespace.

| Project pipeline | Upload file limit | File limit when starting import | Body character limit |
| --- | --- | --- | --- |
| `structured_v1` | 8 MiB | 8 MiB | 1,000,000 |
| Any other value or unset | 512 KiB | 1 MiB | 100,000 |

Before calling python-docx to parse a DOCX, the total uncompressed size of all ZIP entries is checked, and the file is rejected if it exceeds 50 MiB. This limit applies to every pipeline and is independent of the compressed file size and the body character limit. An upload that exceeds the limit does not replace an existing file.

The structured pipeline keeps the full source text and handles long content using the existing chapter and text chunk splitting. The limits above control file resource usage; they do not mean the model can process an entire novel at once, nor do they guarantee that later AI steps complete automatically.

## Appearance Evidence Fix

Character appearance extraction reads the merged, validated `evidence_text` and stays compatible with the legacy `quote` field. The appearance cache version is bumped to 4, so older caches are no longer used to produce appearance results that lack source-text evidence. Existing non-empty appearance fields are still kept under the current rules and do not automatically overwrite user edits.

## Limits of Downstream AI Analysis

The context budget check is already provided by main and is not part of this change. `NEWAPI_TEXT_CONTEXT_TOKENS` is empty by default, so the budget check is off by default. After a long-novel import, some aggregation steps may still exceed the actual model window and fail on the gateway side; chunked extraction completed earlier may already have incurred call costs. Deployers should verify the model window and configure a budget; the budget check does not automatically split oversized requests.

## Regression Checks

```bash
uv run pytest tests/test_api_ingest_chapter_preview.py tests/test_structured_ingest.py tests/test_structured_builders.py tests/test_upload_sanitization.py tests/test_api_asset_upload_offload.py
```

Covers full long-text storage, the upload and start-import boundaries, legacy pipeline limits, the DOCX total uncompressed size limit, original file protection, and the character appearance prompts and evidence cache.

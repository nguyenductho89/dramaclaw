# Skill Import Reliability Fix Design

## Goal

Fix three reliability problems exposed by real Skill imports: slight format differences when the model copies source quotes cause the whole analysis to be rerun; transient gateway failures terminate the task directly; and the 15-minute whole-run budget is not enough to cover normal generation, review, and one transient retry.

For acceptance, use the same real Skill to create three new records and cold-start import them; all three must complete the final review with `quality_report.validated=true`. The test does not reuse analysis or generation checkpoints, does not install the result, and does not execute media generation.

## Source evidence

Before analysis, the program converts the uploaded source into ordered evidence segments. Markdown block boundaries are preferred, including headings, paragraphs, list items, code blocks, table rows, and HTML/XML-style blocks; non-empty source text not covered by the parser is added as segments by raw line. An abnormally long block is split in turn by newline, sentence-ending punctuation, and space, and only at the end by character boundary.

Each segment contains a stable sequential ID, the start and end character positions in the source, the verbatim text, and a heading path used for understanding only. The segment text must satisfy `source[start:end] == text`; all non-empty source content must be covered. The model receives the segments in source order and returns only the segment IDs referenced by each production task. After the program validates the IDs, it backfills the existing `source_quotes` from the source positions, for search, generation, and review to keep using.

The blocking issues of the final content review also use the same evidence segment IDs, with the program backfilling the exact `source_quote`. A nonexistent ID, empty evidence, or exceeding the count limit is treated as a structural error, with no fuzzy guessing. When the source file or the segmentation algorithm version changes, old analysis checkpoints are invalidated.

## Transient failure retry

Each model request performs at most one initial request and one transient-failure retry. The retryable scope includes only: request timeout, connection failure, HTTP 429, and HTTP 5xx. Request parameter errors, authentication errors, content refusals, and JSON/Schema validation failures are not transport retries; JSON/Schema still uses the existing format-correction flow.

A retry applies only to the current request. Already saved analysis, candidate verification, and whole-package generation checkpoints remain valid. The two submissions are counted separately toward the model call limit and input character statistics, and are written to the diagnostic record, including stage, format-correction round, transport attempt number, duration, and error type. A short backoff is used, and there is no unlimited background retrying.

## Time and call budget

The timeout of a single provider request stays at 300 seconds. The total budget of each Skill import run is adjusted from 900 seconds to 1800 seconds. The model request limit stays at 12, and the Recipe matching request limit stays at 4. Cache and checkpoint reads do not count as model calls.

The total budget is the last boundary that prevents an abnormal task from running forever. Transient retries, format corrections, whole-package generation, and the final review all count toward the same budget. When the call count or total time limit is reached, the blocked state is kept, and a result whose review is incomplete is not allowed to be installed.

## Tests

Unit tests cover: determinism and source-position traceback of Markdown and abnormal-text segmentation; backticks, backslashes, nested lists, code blocks, tables, HTML/XML, duplicate paragraphs, CRLF, very long single lines, and Unicode; no second analysis call needed after the model returns only segment IDs; unknown segment IDs are rejected; classification of retryable and non-retryable errors; a transient failure is retried only once; each transport attempt counts toward the budget; the 1800-second whole-run limit and the 300-second single-request limit.

Regression tests cover the existing Skill import, Recipe search, checkpoints, installation quality gate, and the Agent Bundle contract. The real test runs three brand-new imports in a row, recording the duration of each stage, the request count, the retry count, the final validation status, and the manual content check result. If any run fails, the fix is not reported as stably complete; instead, the failing stage is further located from the new diagnostics.

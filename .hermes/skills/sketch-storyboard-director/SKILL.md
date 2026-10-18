---
name: sketch-storyboard-director
description: Use when doing a separate post-QC storyboard-directing pass on SuperTale sketches. This skill focuses on shot scale, camera angle, staging, composition, and beat-to-beat visual rhythm after basic sketch correctness has already passed QC.
---

# Sketch Storyboard Director

> **Agent behavior rules**:
> - **Complete everything by default, without stopping midway**. The whole `prepare context → prepare tasks → label → validate → execute → copy back to the official sketch directory` flow should run in one go.
> - Do not show the user technical details such as curl commands, API paths and auth headers.
> - When reading the project's SQLite, scripts and sketches, keep reading locally and directly.
> - When starting system execution tasks and querying task status, prefer the API provided by `$SUPERTALE_API_URL` rather than touching local Ray directly inside the skill.
> - The environment variable resolution order is the same as `sketch-correction-worker`: read the real process environment variables first, then fall back to the project-level `.claude/settings.local.json` / `.claude/settings.json`.
> - The project context resolution order is the same as `sketch-correction-worker`: `SUPERTALE_PROJECT` / `SUPERTALE_USERNAME` must be provided, and nothing is inferred from the directory structure any more.
> - Fall back to the direct local-script mode only when the API environment is not configured.

Use this skill only after sketch QC is already acceptable.
This skill should complete a full directing-and-modification pass in one run without pausing for intermediate confirmation.

This skill is for:
- shot size
- camera position
- composition / blocking
- visual rhythm
- shot changes between adjacent beats
and it should actually drive the second-layer sketch modification pass, not just produce comments.

This skill is not for first-line defect checking. Do not use it to judge:
- whether identity colors are correct
- whether unnamed characters were wrongly colored
- extra hands / extra feet / malformed limbs
- text in the image
- missing subjects / extra subjects

Those belong to `sketch-correction-worker`.

## Trigger

Use this skill when the user wants:
- a post-QC directing pass on sketches
- stronger shot variety across beats
- better camera angle or shot scale
- cleaner staging / composition
- a manual second pass after the QC skill has already finished
- actual second-layer sketch changes, not just notes

## Inputs

- project path
- episode number
- optionally a beat subset such as `4,7,9`
- current selected sketches
- script beat text

## Prep command

Run this first:

```bash
uv run python .hermes/skills/sketch-storyboard-director/scripts/prepare_storyboard_director_context.py \
  /path/to/project \
  --episode-num 1 \
  --beats 4,7,9
```

This writes:
- `verify_reports/ep001/storyboard_director_run/director_context.json`
- `verify_reports/ep001/storyboard_director_run/overview_grid.jpg`
- `verify_reports/ep001/storyboard_director_run/compressed/beat_XX.jpg`

Then prepare the executable tasks for the beats you want to direct:

```bash
uv run python .hermes/skills/sketch-storyboard-director/scripts/prepare_storyboard_director_tasks.py \
  /path/to/project \
  --episode-num 1 \
  --beats 4,7,9
```

This writes:
- `verify_reports/ep001/storyboard_tasks.jsonl`

## Workflow

1. Confirm the requested beats have already passed `sketch-correction-worker`.
   - for now, trust the user or the immediately previous workflow step; do not try to invent a hidden marker file
2. Run the prep command to generate `director_context.json` and `overview_grid.jpg`.
3. Run the task-prep command to generate `storyboard_tasks.jsonl` for the requested beats.
4. If directing 3 or more beats, read `overview_grid.jpg` first as the primary whole-episode directing view.
5. If directing fewer than 3 targeted beats, inspect the corresponding per-beat compressed images directly first, then use `overview_grid.jpg` only as optional context.
6. Read the current selected sketches for the requested beats only when a beat needs drill-down.
7. Use image-first reasoning: describe what is actually visible before naming a directing issue.
8. Apply anti-projection discipline: do not invent crowding, emptiness, weak separation, or rhythm repetition unless it is actually visible in the images.
9. Read the corresponding beat text.
10. Judge only directing dimensions:
   - shot scale
   - camera angle
   - subject placement
   - interaction geometry
   - visual rhythm across nearby beats
11. Ignore basic QC issues unless the user explicitly asks to combine them.
12. Read `references/output_schema.md`, then write only the beats that should actually be changed into:
   - `verify_reports/epXXX/storyboard_labels.jsonl`
   - before the first append, start from an empty file: truncate the old file or recreate it from scratch
   - it is good to inspect one beat and append one row at a time to `storyboard_labels.jsonl`
   - after the last row is written, also write `verify_reports/epXXX/storyboard_labels_summary.json` as the completion marker
   - if there are no rows, still write an empty `storyboard_labels.jsonl` plus `storyboard_labels_summary.json` with `label_count: 0`
   - but do not start validate or execute until the full `storyboard_labels.jsonl` file has been completely written and `storyboard_labels_summary.json` has been written
13. If `storyboard_labels_summary.json` records `label_count: 0`, stop there:
   - validate is optional
   - skip execute
   - skip copy-back
   - optionally write `storyboard_director_notes.md` saying no director changes are needed
14. Validate the labels:
   - `uv run python .hermes/skills/sketch-storyboard-director/scripts/validate_storyboard_director_labels.py verify_reports/epXXX/storyboard_labels.jsonl`
15. Execute the second-layer sketch changes:
   - `uv run python .hermes/skills/sketch-storyboard-director/scripts/start_storyboard_director_execute_job.py /path/to/project --episode-num 1 --labels-name storyboard_labels.jsonl`
   - then wait with:
   - `uv run python .hermes/skills/sketch-storyboard-director/scripts/wait_for_storyboard_director_execute.py /path/to/project --episode-num 1 --scope <scope>`
16. After execute completes, copy the generated candidate cells back onto `sketches/epXXX/` for the directed beats, using:
   - `verify_reports/epXXX/storyboard_director_execute_summary.json`
17. Optionally also write a concise human-readable note file:
   - `verify_reports/epXXX/storyboard_director_notes.md`

## Rules

- Assume QC has already passed.
- Prefer small, targeted directing changes over full regeneration.
- Use `overview_grid.jpg` as the primary directing surface when reviewing 3 or more beats together.
- For targeted subsets smaller than 3 beats, direct from the per-beat images first.
- Use neighboring beats when rhythm or repetition matters.
- It is valid to leave a beat unchanged if the current shot already works.
- Do not turn every note into a grand cinematic rewrite.
- This skill is a modifier, not a note-only reviewer.
- If a beat should stay unchanged, omit it from `storyboard_labels.jsonl` rather than forcing a rewrite.
- Do not let validate or execute consume a partially written `storyboard_labels.jsonl`.
- Treat `storyboard_labels_summary.json` as the completion marker for the full directing label pass.

## Output files

Primary executable output:
- `verify_reports/epXXX/storyboard_labels.jsonl`
- `verify_reports/epXXX/storyboard_labels_summary.json`
- beat rows use the same executable shape as correction-worker labels; read [references/output_schema.md](references/output_schema.md) before writing
- each row should still include:
  - `project_dir`
  - `episode_num`
  - `beat_number`
  - `execution_mode`
  - `sketch_path`
  - `beat`
  - `sketch_colors`
  - `result`
  - `raw_text`
- `storyboard_labels_summary.json` should contain at least:
  - `project_dir`
  - `episode_num`
  - `label_count`
  - `output_jsonl`

Optional human-readable summary:
- `verify_reports/epXXX/storyboard_director_notes.md`

If you also write notes, use this structure:

```md
# Episode N Storyboard Notes

- Beat 3: keep unchanged.
- Beat 4: change to a closer medium close-up, keep the two people's positional relationship.
- Beat 7: lower the camera slightly, separate the subjects lower-left/upper-right, and leave a gap for the action.
```

Keep each beat note short and directly actionable.

## Output style

Write short, concrete storyboard notes such as:
- `Change to a closer medium close-up, keep the two people's positional relationship.`
- `Lower the camera a bit so the foreground pressure feels more direct.`
- `Avoid three eye-level medium shots in a row; change this beat to a slightly high angle.`
- `Separate the subjects lower-left/upper-right and leave a gap for the action.`

## Final reporting discipline

When summarizing the completed director pass:
- explicitly separate `modified beats` from `unchanged beats`
- do not say the whole episode was updated if only a subset of beats was regenerated
- do not state that the entire episode rhythm is now definitively improved unless you actually re-review the full updated overview after execute
- if no post-execute whole-episode re-review happened, describe rhythm changes as the goal or expected effect of this pass, not as a proven final result

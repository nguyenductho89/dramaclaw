# Status detection and recovery

## Recovery flow

For an existing project -> use the `pipeline/status` response already fetched in Step 0 (SKILL.md, status preflight); do not call it again.

If you need the status of a specific episode, additionally call `GET /api/v1/projects/{P}/pipeline/status?episode=N` (Step 0 fetches only the project level by default).

Read the response:
- `global` section: whether global preparation is done (ingested, configured, characters, episodes, portraits_done)
- `episode_status` section: each step of the current episode (identity_plan, identity_images, script, sketches, coloring, global_optimize, first_frames, tts, video)
  - Auxiliary task types: `content_rewriter` (narration rewrite), `script_writer` (script generation). These auxiliary steps are queried actively via `GET /projects/{P}/tasks/{task_type}/{N}`
  - The current backend has no scene anchor image `anchor-image/*` and no `scene_anchor` task
- `next_step` + `next_step_name`: continue from the breakpoint

### Step 10 path determination

As soon as you enter the Step 10 segment, first `GET /projects/{project}/episodes/{ep}/script` to read the script. Only the project-scoped script endpoint is allowed here; the shorthand `/episodes/{ep}/script` that omits the project name is forbidden:

- `data` is empty -> the script has not been generated yet; continue with `rewrite` or `script/generate`
- `data` is non-empty -> the script is ready; you may enter Step 11 (scene/prop context) or Step 12 sketches
- The current backend has no `literal-script/generate`; do not use `script_mode == "literal_source"` as a hard criterion

## Progress display

**The progress table must include all steps**, listed in two segments:

**Project preparation**: ingest, configuration, characters, episodes, tiering, portraits
**Per-episode stage**: identity planning, identity images, narration rewrite, script generation, scenes/props, sketches, coloring + detection, global optimization, first frames, audio, video, compose, final cut display

Mark each step ✅ (done) or ❌ (not done). Map directly from `episode_status`:
- identity_plan -> identity planning, identity_images -> identity images
- coloring -> coloring + detection, global_optimize -> global optimization
- Tiering: the API does not expose it separately. `portraits_done=true` means tiering is done (portraits depend on tiering)
- Script: under the new main line it is replaced by the two steps "narration rewrite + line-by-line generation" in place of the old display scheme, and is no longer listed as a separate public main-line step

### Display of auxiliary steps in the new flow (only shown if the user went through them)

- Narration rewrite: `GET /projects/{P}/tasks/content_rewriter/{N}` returns completed -> ✅; or `GET /adapted-content` is non-empty -> ✅
- Script generation: `GET /projects/{P}/tasks/script_writer/{N}` returns completed, or `GET /projects/{P}/episodes/{N}/script` has data -> ✅

When the user views the per-episode stage, `narration rewrite` and `script generation` are shown as explicit steps:
- If not triggered yet: show ❌
- If `content_rewriter` is completed or `adapted-content` is non-empty: show `narration rewrite` as ✅
- If `script_writer` is completed or the script has data: show `script generation` as ✅

- Scenes/props: the current backend has no anchor-image criterion; only show the current status of the scene library and prop planning/list

## Recovery execution

**Run mode takes priority (but all modes are bound by the one-step execution protocol)**:
- If the user already chose in this session / now says they want **step-by-step confirmation mode** -> `Read references/run-modes.md` mode one,
  and from the breakpoint **pause before every write step and ask the user; advance only one step at a time**.
- If the user chooses **auto-advance mode**, or the current message contains the UI-injected `[DRAMACLAW_RUN_MODE] mode=episode_auto` -> choose the current step automatically from `pipeline/status.next_step` without asking for per-step confirmation, but each turn still starts at most one write task and wraps up right after starting it; if a queued/running task already exists, immediately tell the user that background generation is in progress and stop.
- If the user only says "continue" and **has not specified a mode** -> first ask one question: "Confirm every step, or auto-advance (one step per turn)?" and then decide (unless the user is clearly in a hurry / has already said not to ask).

First decide the recovery mode from the user's request:

- **The user is only asking about progress / wants to see which step is currently reached**
  - Show the progress table
  - If needed, ask about the interaction mode (confirm every step / auto-advance)
  - Do not advance directly for now
- **The user has explicitly asked to continue / recover / start from here**
  - First determine the current step from `next_step` and the task status
  - If a queued/running task already exists, only report "background generation is in progress" and the current task status, and do not advance to the next step
  - If there is no running task, start only the one write task corresponding to `next_step` and wrap up right after starting it
  - Do not treat a continuation as auto-continue, and do not wait for the current task to finish before starting the next step

Recovery routing:

- Breakpoint in the global stage -> Read playbooks/init.md
- Breakpoint in the per-episode stage -> Read playbooks/episode.md

## Project-level continuation default

When the user only says "continue / help me continue / recover" and the current breakpoint is still in the global stage:

- First find the first missing global step
- By default start only the one write task corresponding to this first missing global step, or stop right after a synchronous step completes
- Stop right after starting an async task; do not poll until the completion point and do not continue to the next step
- Do not keep auto-advancing to the next global step in the same turn
- Do not automatically continue to `POST /projects/{project}/episodes/plan`, batch portraits or per-episode execution; even if the user explicitly asks for the whole stretch to run automatically, it must be split into multiple turns with one write task per turn


## Single-episode continuation default

When the user has given an explicit single-episode scope and the request means:

- "start from here for me"
- "continue from the breakpoint"
- "continue to the next step"
- "continue"

treat it by default as a **current-episode continuation**, rather than first falling back to the project overview or mode negotiation.

For such single-episode continuations:

- Use `GET /api/v1/projects/{P}/pipeline/status?episode=N` as the primary source of truth
- You may additionally read the project, characters, episodes and other necessary state
- If `next_step` is already clear, go directly into executing that step
- If the user says "start from here / continue from the breakpoint / continue to the next step",
  by default start only the one write task for the **first currently missing step**; if that step already has a running task, only report that it is running
- After starting or finding a running task, immediately stop further probing and extra polling, and report the current status directly
- Only when the user explicitly asks to "look at progress first / do not execute yet / let me decide the mode" do you stop at displaying or asking

## Sketch image pool query rules

Triggered when the user asks about "sketches" / "usable images" / "image pool".

**Data source**: you **must** use the `GET /grids` API; scanning the filesystem is **forbidden**.

**Default display**: report only the summary statistics of the current batch (`stale=false`):
> "25 beats; the current batch has 68 usable sketches in total (2-4 per beat)."

Add information about old batches only when the user explicitly asks.

**Selecting a sketch from an old batch**: if the target image has `stale=true`, warn first and then act:
> "This sketch comes from an old batch, and the character coloring does not match the current batch. Using it may mix up the characters. Are you sure you want to use it?"
Only after the user confirms call `pool-select` with `force=true`. The try -> fail -> force pattern is forbidden.

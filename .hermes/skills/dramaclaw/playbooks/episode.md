# Per-episode generation stage (Steps 8-16)

> This file is the single source of truth for the per-episode process order. When API request details are uncertain, read
> `references/step-api-reference.md`; technical references must not change the order in this file.
> Variable: `$EP` = the current episode number.
> **First step**: `GET /projects/{project}` to read the project configuration (rhythm, tts_provider, video_resolution), used for the `{project...}` placeholders; the video backend defaults uniformly to `huimeng_seedance-1.0-pro-fast`.

## Pipeline

The fixed business order is as follows; `pipeline/status.next_step` is used to locate the current item and prerequisites must not be skipped:

| Step | Stage | Next after completion |
|---|---|---|
| 8 | Identity planning | Step 9 identity images |
| 9 | Identity images | Step 10 script |
| 10 | Optional narration rewrite, then script generation | Step 11 scene/prop context |
| 11 | Scene/prop context | Step 12 sketches |
| 12 | Sketches, color detection, global video optimization | Step 13 first frames |
| 13 | First frames | Step 14 voice prerequisites and audio |
| 14 | Voice preparation and audio | Step 15 single-beat videos |
| 15 | All single-beat videos | Step 16 compose |
| 16 | Compose and display the official final cut | Done |

Checkpoints: CP2 (after scenes/props) | CP3 (after sketches) | CP4 (after audio) | CP5 (after the final cut)

CP2 criterion: the script and the scene/prop context are enough to advance to sketches; the current backend has no `anchor_image_url` contract.

## Step highlights

**Whole-episode production entry**:
- When the user asks to "finish the video production of episode N / finish the video generation of episode N / finish this episode / generate the video of episode N for me / generate the whole episode video / make the final cut", in the first turn do not merely read-check `pipeline/status`, the task list or media status, and do not start write tools.
- First explain that the request must be split into explicit small tasks, for example checking progress, filling in prerequisites, generating a single beat's audio, generating a single beat's video, composing the final cut, and ask whether to first list the current production progress and the suggested next step.
- Only in the turn after the user confirms, do a read-only check of `pipeline/status`, the task list and necessary media status, give a short plan for the current episode, and only ask whether to execute this one next task.
- Never run straight from the current breakpoint to Step 16 in the same turn.
- After the user confirms, this turn starts at most one write task; wrap up immediately after the task starts.

**Step 9 (key to costume consistency)**:
1. First read the identity status of core + important characters and pick the first identity missing an identity image; this turn generates at most this one identity image
   - `CHAR_NAME` may only come from the character name list already read or an explicit character field in the current response, and must be non-empty
   - If no character name is available right now, skip the identity re-read for that character; do not probe `/characters//identities` or any empty-name path
   - Do not iterate and generate multiple characters/multiple identities in the same turn; the remaining identities wait until the user says "continue" next time
2. The identity image is the **visual anchor** for the costume appearance in later sketches/first frames - without an identity image the costume varies randomly in every frame
3. `appearance_details` must be concrete down to color + style + material; avoid vague words such as "formal wear" or "casual wear"

**Single-step continuation wrap-up**:
- If resume has already made clear that this is a single-step continuation ("start from the breakpoint / continue to the next step"),
  stop right after the current `next_step` finishes and do not keep probing later steps
- For example, when the breakpoint is Step 8 (identity planning):
  - Complete `POST /episodes/{ep}/identities/plan`
  - Directly report "identity planning for this episode has started / the current step is done"
  - Do not poll unrelated tasks and do not advance to Step 9+
  - By default report this step's output directly from the `identities/plan` response
  - Do not re-read `GET /characters/{name}/identities` just to "verify each character's identities"
  - If the planning response already gives the characters and identity slots, treat that response as the final source of truth and wrap up

**Step 10 fixed main line**:
- The user first prepares `raw-content`
- If a narration rewrite is needed, first `POST /rewrite/generate` and wrap up right after starting; do not continue with `script/generate` in the same turn
- Only when the rewritten draft is complete/exists, call the `POST /script/generate` that actually exists in the current backend; wrap up right after starting
- After script generation completes, you may enter Step 11 (scene/prop context), then Step 12 sketches
- The current backend has no `literal-script/generate` and does not guarantee `script_mode == "literal_source"`

**Steps 11-13 (scene / prop context - prerequisite of sketches)**:
- The current backend has no `anchor-image/*`, `scene_anchor` or `scenes/snapshot-sync` routes; calling these old interfaces is forbidden
- Available flow:
  1. `GET /projects/{project}/scenes` to list the project scene library
  2. `GET /projects/{project}/episodes/{ep}/beats` to read this episode's beats
  3. To add a scene -> `POST /projects/{project}/scenes`, with the body using the current backend fields: `{"name":"...","description":"...","environment_prompt":"..."}`
  4. Prop planning for this episode -> `dramaclaw_plan_props` (`POST /projects/{project}/episodes/{ep}/props/plan`)
  5. Prop list -> `GET /projects/{project}/props`
- Within the flow above, execute at most one write operation per turn: add one scene, start one prop planning, or execute one task of the current `next_step`; do not add several scenes and then start prop planning.
- Completion criterion: the script and the scene/prop context are enough to advance to sketches; do not require `anchor_image_url`

**Step 12 (sketch generation prerequisite)**: first complete `assign-colors` (idempotent), then generate sketches in the next turn.
- When colors have not been assigned yet, this turn only calls `assign-colors` and wraps up.
- Once colors are assigned, the current turn starts the generation of at most one grid; do not loop over all grid_index values. Handle the next grid when the user says "continue" in the next turn.

**Step 13 first-frame generation**: call `dramaclaw_render_first_frames` once; in beat order it submits at most 9
independent `selected_regen` tasks; each task is timed independently and saved immediately after completion. When `beat_indices` is omitted the tool only selects
the next 9 beats that lack a first frame. The image queue runs at most 3 concurrently and the rest queue up; after the current batch ends,
submit the next batch when the user says "continue" in the next turn, until all first frames exist.

**Step 12.3**: detection happens in the turn after sketches complete. Detection is meaningless without identity images.

**Step 12.5**: `{"language":"en"}` defaults to the English SuperPower mode and decides video_mode + the motion prompt

**Step 14 audio generation**: use `dramaclaw_generate_audio`, i.e. the current `audio/generate` [ASYNC: `audio_generation_indextts2`]. The old `/tts/generate` has been removed; do not call it.

If a voice is missing, you must ask explicitly: `1) Upload or record a voice in "Shrimp Pond"; 2) Confirm that Shrimp Director matches a system voice.` Only after the user explicitly picks the second option may you call `dramaclaw_prepare_system_voices(confirmed=true)`; it only starts [ASYNC: `system_voice_setup`]. Only in the turn after that task completes may Step 14 continue. Never describe system voices as unavailable or generalize them into "other dubbing directions".

**Partial audio update**:
- When the user changes a beat's `audio_type`, `speaker`, `fish_speech_prompt` or dialogue text,
  the fixed order must be followed:
  1. First `PATCH /episodes/{ep}/beats/{beat}`
  2. Then redo that beat's audio (`POST /episodes/{ep}/beats/{beat}/audio` or the corresponding audio generation path)
  3. Only last is `POST /episodes/{ep}/videos/compose` allowed
- This order runs across multiple turns: one turn does only one of these write operations. After the PATCH completes, wrap up; redo the audio when the user continues; compose in a later turn after the audio completes.
- Even if the beat's current dialogue text already equals the target text, as long as `audio_type`, `speaker`
  or other audio-related fields still need adjusting, this `PATCH` must be completed first,
  and you must not redo the audio first and patch afterwards
- `compose` must not be pre-started or run ahead, and must not be launched first to save time with the audio fixed afterwards.
  It may be entered only after that beat's audio redo request has been sent and returned successfully.
- Do not launch `compose` before that beat's audio redo

**Step 15 video model**: the current backend has no whole-episode `/videos/generate` route. By default generate per beat with `POST /episodes/{ep}/beats/{beat}/video`; for whole-episode clips, prefer calling `dramaclaw_start_video_batch` once, which by default automatically fills from beats that lack video but already have a first frame and submits at most 9 independent tasks in order; actual video concurrency is still limited to 3 by the shared queue and the rest queue up. Call `dramaclaw_start_single_video` only when the user explicitly specifies a single beat; set `auto_fill=false` for the batch tool only when a small number of beats is explicitly specified. Default `huimeng_seedance-1.0-pro-fast`.

**Steps 15-16**: `compose_episode` may start only after all `single_video` tasks complete; when
`pipeline/status.next_step == "compose_episode"` and no compose task is running, directly call
`dramaclaw_compose_episode(episode=$EP)` once and wrap up. This dedicated tool supplies the canonical compose parameters; do not switch to a generic POST because the tool
has no body parameter, and do not read the same pipeline status again. After compose returns the official result, call
`dramaclaw_get_final_video`; this **must run sequentially**.

## Checkpoint rules (manual mode only)

On reaching a checkpoint, stop calling tools, show the results and wait for the user's reply.

| CP | Show | User can change |
|----|------|----------|
| CP2 | Beat summary (index + scene + visuals, <=3 lines/beat) | Visual description, dialogue, add/delete |
| CP3 | 3-5 representative first frames | Re-render, change visual_description |
| CP4 | Audio player + dialogue voice list | Change voice, adjust speech rate |
| CP5 | Final video + duration + number of beats | Redo beats, re-compose |

Auto-advance does not wait for the user's confirmation at each checkpoint, but still starts only one write task per turn; wrap up immediately after starting a task or finding one running. When the current message carries the `mode=episode_auto` marker injected by the outer UI, that marker itself is the continuing authorization for this episode's safe steps; do not ask the user to reply "continue" again.

User replies:
- "continue" / "ok" -> advance only one task of the current `next_step`; if a task is already running, only report the current status
- "show #X" / "show all" -> show more, still at the same checkpoint
- Specific modification instruction -> execute the modification, show it again, still wait for confirmation
- "auto run" -> switch to auto-advance mode (one step per turn)

## Progressive generation strategy

```
Stage 1: current project preparation (Steps 1-6, project already created and bound) -> manual mode pauses at CP1
Stage 2: per-episode generation (Steps 8-16, per EP) -> manual mode pauses at CP2-CP5
Stage 3: multi-episode advancement -> the user may choose episode by episode / specific episodes, but each turn still advances only one write task
```

The mode applies across all stages. **Manual mode** pauses at checkpoints; **auto-advance** chooses the next step automatically, but is not zero-pause throughout: each turn starts only one write task, and while background generation is in progress only the status is reported; the user triggers the next step after completion.

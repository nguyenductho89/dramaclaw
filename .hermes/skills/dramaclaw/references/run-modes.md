# Run modes (two)

After configuration is complete (step 5 of the init.md decision tree), the user chooses a run mode. Both modes share the same
pipeline step order and dedicated tools; they differ only in "whether each step is explained and confirmed". Neither mode may start multiple write tasks in a row within one turn.

The mode is decided by what the user states explicitly this turn, or by the mode button of the outer Shrimp Director input box, and persists within this session:
- The current message contains `[DRAMACLAW_RUN_MODE]` with `mode=episode_auto` -> the user has authorized auto-advance through the "Episode auto" button of the outer Shrimp Director; do not ask again about the run mode or per-step confirmation. After a task completes, the backend auto-coordinator starts a new auto-continue turn, and each turn still executes only one write task
- The user says "confirm each step / step by step / manual / ask me at every step" -> **step-by-step confirmation mode** (see below)
- The user says "all at once / fully automatic / autopilot / run it all in one go / no need to ask me" -> **auto-advance mode (one step per turn)**; these phrasings only mean that the next "continue" does not re-explain the flow, not that this turn may run the whole episode
- The user says nothing -> by default first ask one question: "Should I **confirm every step** or **auto-advance (one step per turn)**?", then follow the answer

Large cross-stage tasks always obey the decomposition-confirmation protocol of the root `SKILL.md`; the run mode cannot bypass that protocol.

When the outer "Episode auto" is turned on, first run a voice prerequisite pre-check. If dubbing is already done or the required voices are ready, add no question; if it cannot be confirmed or something is found missing, the start confirmation must let the user choose "missing voices are matched by Shrimp Director from system voices" or "upload/record custom voices in Shrimp Pond". That choice is saved as the `voice_policy` of this auto session: `system` means the user has authorized it in advance, and at `voice_setup` the system-voice preparation may be called directly once; `custom` means it must not be replaced with system voices, and if the shortage still exists at that point, pause and wait for an upload.

---

## Mode one: step-by-step confirmation mode (step-by-step)

**Core rule: advance only one step at a time; before every step stop and ask the user, and execute only after confirmation; never skip steps in a row.**

### Fixed actions of each step

1. **Announce the next step** (one sentence, no elaboration):
   - What will be done (step name) + the tool to be called + whether the prerequisites are met
   - Example: "Next step: episode planning (`dramaclaw_plan_episodes`, target 10 episodes). The source text and characters are ready, so it can run."
2. **Stop and ask**: "Execute this step? (continue / skip / adjust parameters / stop)"
   -> then **end this turn's output and wait for the user's reply**. Do not keep going automatically.
3. After the user replies:
   - "continue / execute / ok / next step" -> first check the current task status; if a queued/running task exists, tell the user background generation is in progress and stop; if there is no running task, call the corresponding dedicated tool to start the current step -> **wrap up immediately**, and ask whether to check progress or execute the next step later
   - "skip" -> do not execute, directly announce the "step after that"
   - "change to N episodes / use some style ..." -> execute that step with the adjusted parameters
   - "stop / pause" -> stay at the current step and wait for the user's next instruction

### Behaviors not allowed

- ❌ Running multiple steps in a row after a single confirmation (even if the user only says "continue", advance only **one step**)
- ❌ Executing a write operation without asking (steps that trigger tasks such as plan/build/generate/compose)
- ❌ Merging "report the result" and "execute the next step" - after reporting the result/start status you must end this turn and wait for the user's next message
- ❌ Continuing to poll until completed after starting an async task and then automatically entering the next step

### Source of the steps

- The current project preparation order is read only from `playbooks/init.md`.
- The per-episode production order is read only from `playbooks/episode.md`.
- This file only decides whether to ask the user again before execution, and does not add, delete or reorder steps.
- After finishing each episode, ask whether to continue to the next episode.

### Status receipt (after each step is executed)

- After triggering, make at most one necessary `dramaclaw_get_task(task_type=..., episode=...)` status query
- If the status is queued/running: tell the user background generation is in progress and to continue after it completes; do not poll until completed
- Success: read or show the completion data per the table below; do not just say "done"
- Failure: report `task.error` / `error_code`, **stop at that step**, and do not auto-retry or skip

### Completion data display rules

After each step completes, you must show or summarize that step's real artifacts. Media must call the corresponding display tool; text/list results use a markdown table or a short list. When there is no displayable data, honestly say "done, but the current endpoint returned no displayable artifact"; do not concatenate URLs, guess paths or pad with old data.

| Step | Read / show after completion |
|------|-------------------|
| Ingest | `dramaclaw_pipeline_status` summarizes the ingested/configured status; do not show the full source text |
| Project configuration | `dramaclaw_get(path="/projects/{project}")` summarizes visual style, narration style, rhythm, audio/video configuration |
| Character extraction | `dramaclaw_get(path="/projects/{project}/characters")` shows the character list |
| Character face_prompt check/fill | `dramaclaw_get(path="/projects/{project}/characters")` checks the core characters' `face_prompt`; when missing, fill in first and show the characters filled in |
| Episode planning | `dramaclaw_get(path="/projects/{project}/episodes")` shows the episode list |
| Character portraits | `dramaclaw_get_character_media(media_kind="portrait")` shows the portraits |
| Identity planning | `dramaclaw_get_character_media(media_kind="identity")` or the character identities endpoint summarizes the identity list; when there are no identity images, only list the identities |
| Identity image generation | `dramaclaw_get_character_media(media_kind="identity")` shows the identity images |
| Script generation | `dramaclaw_get_episode_script(episode=N)` shows a beat summary |
| Scene planning | `dramaclaw_get(path="/projects/{project}/scenes")` shows the scene list |
| Prop planning | `dramaclaw_get(path="/projects/{project}/props")` shows the prop list |
| Scene reference images | `dramaclaw_get_scene_images()` shows the scene images |
| Sketch generation | `dramaclaw_get_sketches(episode=N)` shows the sketches |
| AI detection | `dramaclaw_get_episode_script(episode=N)` or the beats endpoint summarizes the identities/props detected in each beat; do not call detection again |
| Global video optimization | `dramaclaw_get_episode_script(episode=N)` or the beats endpoint summarizes video_mode / video_prompt readiness |
| First-frame generation | `dramaclaw_get_first_frames(episode=N)` shows the first frames |
| Audio generation | `dramaclaw_get_episode_media(episode=N, media_type="audio")` shows the audio |
| Single-beat video | `dramaclaw_get_episode_media(episode=N, media_type="video")` shows the video clips |
| Compose and export | `dramaclaw_get_final_video(episode=N)` shows the final cut |
| Final cut display | `dramaclaw_get_final_video(episode=N)`; if it does not exist, only state that there is no final cut yet |

---

## Mode two: auto-advance mode (bounded auto)

Auto-advance does not run a whole episode in one turn. To avoid chat timeouts and queue congestion, auto-advance must also obey:

- One user message starts at most 1 write operation / async task.
- After a task starts successfully, wrap up immediately, tell the user it "has entered the queue / has started", and remind them to continue after the task completes.
- Do not wait for long tasks to complete in the same turn and do not keep submitting the next step.
- Any failure, 429, missing prerequisite, nonexistent task, 404 or network error stops immediately and reports the original error text.

Auto-advance means: automatically choose the next step from `pipeline/status.next_step` without re-explaining the flow at each step; but each turn still advances only one task. When the user chooses auto mode in text, the user's next "continue" triggers it; when the message carries the UI-injected `mode=episode_auto`, the backend auto-coordinator persistently triggers the next turn after a task completes.

The outer UI auto-continue must still pause and return to manual mode in these cases: general task failure or cancellation, overwrite ingest, delete or clear, a missing required choice such as voices, a prerequisite that cannot be safely filled in automatically, incomplete results, multiple options that cannot be judged safely, and completion of the final cut. When an identity image task fails explicitly only because a specified character lacks a Portrait, the backend auto-coordinator may authorize one whitelisted recovery turn: generate only that character's Portrait, with at most one automatic attempt per character; after the image is filled in, the next turn resumes the identity image flow. The outer Shrimp Director does not charge Agent credits, and must not show Shrimp Canvas Agent credit quotes.

### User messages during auto run

- The user may keep sending messages while episode auto is running or tasks are generating.
- Q&A, explanations, and viewing status and progress do not change the run mode; backend auto-continue waits for the current chat turn to end.
- When Shrimp Director judges that a message may request a modification, redo, replacement or configuration change, first call `dramaclaw_control_episode_auto(action="suspend")` to pause further advancement, then ask for confirmation; this turn must not execute the change.
- When the user denies the change, saying things like "never mind / keep it as is / continue auto", call `action="resume"` to restore the same auto session.
- When the user confirms the change, first call `action="pause"` to leave auto mode, then handle at most one confirmed change under the ordinary single-turn write rules; this way the modification task's status and completion notification continue under manual mode. After the modification completes, ask whether to re-enable episode auto.
- When the user explicitly asks to stop or switch to manual, call `action="pause"`.
- `suspend`, `resume` and `pause` do not cancel currently queued/running tasks. Only when the user explicitly confirms cancelling a specific task do you go through the task cancellation flow.

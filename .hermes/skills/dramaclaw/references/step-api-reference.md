# DramaClaw Step API Reference

This file only records the endpoints, parameters and task types of each step, and does not own process-order decisions. The order of Steps 1-7 follows
`playbooks/init.md`, the order of Steps 8-16 follows `playbooks/episode.md`; recovery positioning follows
`playbooks/resume.md`. Every API call must follow the backend's current FastAPI routes.

Variable conventions:
- `$PID` = the current `DRAMACLAW_PROJECT_ID`
- `$EP` = episode number
- `$CHAR_NAME` = character name
- `$IDENTITY_ID` = identity ID
- `$BEAT` = beat number

Auth: all requests use `Authorization: Bearer $DRAMACLAW_AGENT_TOKEN`.

---

## Current project preparation stage

Project creation is done by the frontend/system; Shrimp Director never calls `POST /projects`. All the steps below require
`DRAMACLAW_PROJECT_ID` to be bound to an existing project.

### Step 1: Upload the novel [SYNC]

```
POST /projects/$PID/ingest/upload
Body: multipart/form-data, file=novel.txt
```

### Step 2: Ingest [ASYNC -> ingest_fast, ep=0]

```
POST /projects/$PID/ingest/start
Body: {"filename": "novel.txt", "rebuild": false}

Overwrite-rebuilding an already ingested project may only be called after double confirmation:
Body: {"filename": "novel.txt", "rebuild": true}

GET /projects/$PID/tasks/ingest_fast/0
SSE /projects/$PID/tasks/ingest_fast/0/stream
```

### Step 3: Configure the project [SYNC]

```
PATCH /projects/$PID
Body: {"visual_style": "...", "narration_style": "...", "ethnicity": "...", "rhythm": "..."}
```

### Step 4: Character extraction [ASYNC -> build_characters, ep=0]

**Trigger with the dedicated tool `dramaclaw_build_characters` (do not assemble the path yourself)**; internally it is
`POST /projects/$PID/characters/build`.

```
dramaclaw_build_characters            # Trigger extraction (the project defaults to DRAMACLAW_PROJECT_ID)

dramaclaw_get_task(task_type="build_characters", episode=0)   # Poll the status
SSE /projects/$PID/tasks/build_characters/0/stream            # Or stream
```

After completion use:

```
GET /projects/$PID/characters
```

Manual character-add fallback:

```
POST /projects/$PID/characters
Body: {"name":"Character name","role":"protagonist","is_main":true,"gender":"female","age_group":"youth","description":"Description","face_prompt":"Facial features"}
```

### Step 5: Character face_prompt check/fill [SYNC]

Portrait generation depends on the character's `face_prompt`. Before entering portrait generation you must read the character list and fill in missing values:

```
GET /projects/$PID/characters
PATCH /projects/$PID/characters/$CHAR_NAME
Body: {"face_prompt": "Concrete facial-feature description"}
```

When missing, prefer the dedicated tool:

```
dramaclaw_update_character_face_prompt(name="$CHAR_NAME", face_prompt="...")
```

`face_prompt` describes only the face; do not write clothing, scenes or identity images.

### Step 6: Episode planning [ASYNC -> build_episodes, ep=0]

```
POST /projects/$PID/episodes/plan
Body: {"target_episodes": 10, "planning_mode": "chapters"}

GET /projects/$PID/tasks/build_episodes/0
SSE /projects/$PID/tasks/build_episodes/0/stream
```

After completion use:

```
GET /projects/$PID/episodes
```

### Step 7: Portrait generation [SYNC]

```
POST /projects/$PID/characters/$CHAR_NAME/portrait
Body: {"style": "...", "ethnicity": "...", "model": "nanobanana"}
```

---

## Per-episode generation stage

### Step 8: Identity planning [SYNC]

```
POST /projects/$PID/episodes/$EP/identities/plan
```

### Step 9: Identity image generation [SYNC]

```
GET /projects/$PID/characters/$CHAR_NAME/identities

POST /projects/$PID/characters/$CHAR_NAME/identities/$IDENTITY_ID/generate
Body: {"style": "...", "model": "nanobanana"}
```

`$CHAR_NAME` must come from the character list already read or the identity planning result, and be non-empty. Probing `/characters//identities` is forbidden.

### Step 10a: Narration rewrite [ASYNC -> content_rewriter]

```
GET /projects/$PID/episodes/$EP/raw-content

POST /projects/$PID/episodes/$EP/rewrite/generate
Body: {"target_beats": 18, "beat_chars_min": 14, "beat_chars_max": 20}

GET /projects/$PID/tasks/content_rewriter/$EP
SSE /projects/$PID/tasks/content_rewriter/$EP/stream
```

After completion you may use:

```
GET /projects/$PID/episodes/$EP/adapted-content
```

### Step 10b: Script generation [ASYNC -> script_writer]

The current backend has no `/literal-script/generate`. Use the one that actually exists:

```
POST /projects/$PID/episodes/$EP/script/generate
Body: {"narration_style": "first_person"}

GET /projects/$PID/tasks/script_writer/$EP
SSE /projects/$PID/tasks/script_writer/$EP/stream
```

Verify after completion:

```
GET /projects/$PID/episodes/$EP/script
GET /projects/$PID/episodes/$EP/beats
```

Do not require `script_mode == "literal_source"`; the current backend does not guarantee this field.

### Step 11: Scene / prop context [SYNC/ASYNC]

The current backend has no `anchor-image/*`, no `scene_anchor` task and no `/episodes/$EP/scenes/snapshot-sync`. Do not call these paths.

Available scene APIs:

```
GET /projects/$PID/scenes

POST /projects/$PID/scenes
Body: {"name":"Scene name","description":"...","environment_prompt":"..."}

PATCH /projects/$PID/scenes/$SCENE_NAME
Body: {"description":"...","environment_prompt":"..."}

POST /projects/$PID/scenes/$SCENE_NAME/delete
```

Available prop APIs:

```
POST /projects/$PID/episodes/$EP/props/plan
GET /projects/$PID/props
POST /projects/$PID/props
PATCH /projects/$PID/props/$PROP_NAME
POST /projects/$PID/props/$PROP_NAME/delete
```

### Step 12: Sketch generation [ASYNC -> sketch_generation]

```
POST /projects/$PID/episodes/$EP/sketches/assign-colors

POST /projects/$PID/episodes/$EP/sketches/generate
Body: {"style": "...", "model": "nanobanana", "grid_index": 0, "sketch_location_grouping": true}

GET /projects/$PID/tasks/sketch_generation/$EP?scope=grid_0
SSE /projects/$PID/tasks/sketch_generation/$EP/stream?scope=grid_0
```

Generate each grid serially by `grid_index`. Each grid corresponds to the task scope `grid_N`.

View status/results:

```
GET /projects/$PID/episodes/$EP/grids
```

### Step 12.3: AI identity detection [SYNC]

```
POST /projects/$PID/episodes/$EP/sketches/detect-identities
```

### Step 12.5: Global video optimization [ASYNC -> global_optimize_video]

```
POST /projects/$PID/episodes/$EP/optimize/video-global
Body: {"language":"en"}

GET /projects/$PID/tasks/global_optimize_video/$EP
SSE /projects/$PID/tasks/global_optimize_video/$EP/stream
```

### Step 13: First-frame generation [ASYNC -> selected_regen]

```
POST /projects/$PID/episodes/$EP/beats/regenerate
Body: {"beat_indices": [1], "style": "...", "model": "nanobanana",
       "batch_id": "first-frame-...", "batch_size": 9}

One `dramaclaw_render_first_frames` call submits one independent task for each of at most 9 beats, sharing a batch_id;
when beat_indices is omitted it automatically selects the next 9 beats that lack a first frame. The image queue runs at most 3 concurrently,
the rest queue up; each task is timed independently and saved independently.

GET /projects/$PID/tasks?task_type=selected_regen&episode=$EP
```

### Step 14: Audio generation [ASYNC -> audio_generation_indextts2]

The current main line uses only `audio/generate`. The old `/tts/generate` has been removed; do not call it.

```
POST /projects/$PID/episodes/$EP/audio/generate
Body: {"mode": "sync_changed"}  # May be omitted; the backend defaults to sync_changed

GET /projects/$PID/tasks/audio_generation_indextts2/$EP
SSE /projects/$PID/tasks/audio_generation_indextts2/$EP/stream
```

Single-beat audio redo:

```
POST /projects/$PID/episodes/$EP/beats/$BEAT/audio
```

### Step 15: Video generation [ASYNC -> single_video]

The current backend has no whole-episode batch video route `/projects/$PID/episodes/$EP/videos/generate`.

**Single-turn limit**: in this step, one user message calls a video start tool only once. When multiple eligible beats exist, prefer calling `dramaclaw_start_video_batch`; by default the tool automatically fills from beats that lack video but already have a first frame and submits at most 9 independent tasks in order. The shared video queue runs at most 3 concurrently and the rest queue up. Call `dramaclaw_start_single_video` only when the user explicitly specifies a single beat; pass `auto_fill=false` only when a small number of beats is explicitly specified. When the user first states a vague goal such as "finish the video generation of episode N / generate the video of episode N / whole-episode video", handle it first by the root Skill's "clarify and decompose large tasks first". Do not continue to compose after starting.

Generate a single beat's video:

```
POST /projects/$PID/episodes/$EP/beats/$BEAT/video
Body: {"resolution": "720x1280", "video_backend": "huimeng_seedance-1.0-pro-fast"}

GET /projects/$PID/tasks/single_video/$EP?beat_num=$BEAT
SSE /projects/$PID/tasks/single_video/$EP/stream?beat_num=$BEAT
```

When the start endpoint returns `ok:false` or an HTTP error, report the endpoint error directly to the user. If, after a successful start, the task status is `failed` / `cancelled`, report the failure reason from `task.error`, `error_code` or the latest logs directly to the user; do not wrap a failure up as "redone".

If the user asks to "generate the video clips of the whole episode", first read the beats, pick at most the first 9 unfinished beats whose prerequisites are met, and submit them through the batch business tool; when no beat meets the prerequisites, only report what is missing. Do not call the nonexistent `/videos/generate`, and do not simulate batching with a loop of generic POSTs.

### Step 16: Compose [ASYNC -> compose_episode]

Compose may start only after all beat videos of this episode are complete. Wrap up immediately after starting `compose_episode`; do not start video and then compose in the same turn, and do not wait for compose to finish before continuing to show the final cut.

Prefer calling `dramaclaw_compose_episode(episode=$EP)`. The dedicated tool internally uses the canonical request body below; that it
exposes no body parameter is expected behavior, so do not switch to `dramaclaw_post` because of it, and do not repeat the query of the same status before starting.

```
POST /projects/$PID/episodes/$EP/videos/compose
Body: {"add_subtitles": true, "add_bgm": false}

GET /projects/$PID/tasks/compose_episode/$EP
SSE /projects/$PID/tasks/compose_episode/$EP/stream
```

After compose completes, read the official final-cut status:

```
GET /projects/$PID/episodes/$EP/final
```

If it returns `data.exists=true` with a `data.video_url`, show the final cut with `dramaclaw_get_final_video`. Do not assemble a host, download address or `/files` path yourself.

When the user explicitly wants to export files, you may combine:

```
GET /projects/$PID/episodes/$EP/export/srt
POST /projects/$PID/episodes/$EP/export/zip
```

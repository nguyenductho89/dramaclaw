# DramaClaw (Shrimp Director) API Quick Reference

**Base URL**: `$DRAMACLAW_API_URL/api/v1`
**Auth**: `Authorization: Bearer $DRAMACLAW_AGENT_TOKEN`

---

## Project management

| Method | Path | Purpose |
|------|------|------|
| `GET` | `/projects` | List all projects |
| `POST` | `/projects` | Create a project `{"name":"..."}`; frontend/system only, not called in the Shrimp Director flow |
| `GET` | `/projects/{project}` | Get the project configuration |
| `PATCH` | `/projects/{project}` | Update the configuration |

## Ingest

| Method | Path | Purpose |
|------|------|------|
| `POST` | `/projects/{project}/ingest/upload` | Upload a novel (multipart) |
| `POST` | `/projects/{project}/ingest/start` | Start ingest `{"filename":"...", "rebuild":false}` [ASYNC]; overwrite-rebuilding an already ingested project must be double-confirmed before passing `{"rebuild":true}` |

The ingest API allows only the two paths above. `ingest_fast` is a backend task type, not an HTTP route; do not call or infer `/ingest/init`, `/ingest/setup`, `/ingest_script`, `/ingest_fast`, `/projects/{project}/ingest` or any other ingest variant. When these paths return 404, do not interpret it as the ingest module being disabled; switch to the real routes in the table above.

## Characters

| Method | Path | Purpose |
|------|------|------|
| `GET` | `/projects/{project}/characters` | List characters |
| `POST` | `/projects/{project}/characters` | Add a character manually `{"name":"...","role":"...","is_main":true,"gender":"female","age_group":"youth","description":"...","face_prompt":"..."}` |
| `POST` | `/projects/{project}/characters/build` | Extract characters [ASYNC] |
| `PATCH` | `/projects/{project}/characters/{name}` | Modify a character |
| `POST` | `/projects/{project}/characters/{name}/portrait` | Single portrait |
| `POST` | `/projects/{project}/characters/{name}/portrait/upload` | Upload a portrait (multipart) |
| `GET` | `/projects/{project}/characters/{name}/identities` | View identities |
| `POST` | `/projects/{project}/characters/{name}/identities` | Add an identity |
| `PATCH` | `/projects/{project}/characters/{name}/identities/{identity_id}` | Modify an identity (identity_id = `character_name_identity_name`) |
| `DELETE` | `/projects/{project}/characters/{name}/identities/{identity_id}` | Delete an identity |
| `POST` | `/projects/{project}/characters/{name}/identities/{identity_name}/upload` | Upload an identity image |
| `POST` | `/projects/{project}/characters/{name}/identities/{identity_id}/generate` | Generate an identity image (Identity Locking) `{"style":"...","model":"..."}` [SYNC] |

## Episodes

| Method | Path | Purpose |
|------|------|------|
| `GET` | `/projects/{project}/episodes` | List episodes |
| `POST` | `/projects/{project}/episodes/plan` | Episode planning `{"target_episodes":10,"planning_mode":"chapters"}` [ASYNC] |
| `GET` | `/projects/{project}/chapters` | Detect novel chapters |
| `PATCH` | `/projects/{project}/episodes/{ep}` | Modify episode info |
| `POST` | `/projects/{project}/episodes/{ep}/identities/plan` | Plan this episode's identities |

## Script

| Method | Path | Purpose |
|------|------|------|
| `GET` | `/projects/{project}/episodes/{ep}/script` | Get the script (the current backend may return script_mode, but do not rely on literal_source as a hard criterion) |
| `PUT` | `/projects/{project}/episodes/{ep}/script` | Save the complete script `{"beats":[...]}` |
| `GET` | `/projects/{project}/episodes/{ep}/beats` | Get the beat list |
| `PATCH` | `/projects/{project}/episodes/{ep}/beats/{beat}` | Edit a beat |

## Source text and rewritten draft (input of the new flow)

| Method | Path | Purpose |
|------|------|------|
| `GET` | `/projects/{project}/episodes/{ep}/raw-content` | Read the source text |
| `PUT` | `/projects/{project}/episodes/{ep}/raw-content` | Save the source text `{"content":"..."}` (UPSERT) |
| `GET` | `/projects/{project}/episodes/{ep}/adapted-content` | Read the rewritten draft (returns an empty string if not saved) |
| `PUT` | `/projects/{project}/episodes/{ep}/adapted-content` | Save the rewritten draft `{"content":"..."}` |
| `DELETE` | `/projects/{project}/episodes/{ep}/adapted-content` | Clear the rewritten draft and fall back to the source text |

## Narration rewrite and script generation (Step 10)

| Method | Path | Purpose |
|------|------|------|
| `POST` | `/projects/{project}/episodes/{ep}/rewrite/generate` | Narration rewrite: source text -> rewritten draft `{"target_beats":18,"beat_chars_min":14,"beat_chars_max":20,"narration_style":"first_person"}` [ASYNC -> content_rewriter] |
| `POST` | `/projects/{project}/episodes/{ep}/script/generate` | Generate the script [ASYNC -> script_writer]; the current backend has no `literal-script/generate` route |

## Image generation

| Method | Path | Purpose |
|------|------|------|
| `POST` | `/projects/{project}/episodes/{ep}/sketches/generate` | Sketches `{"style":"...","model":"nanobanana","grid_index":0,"sketch_location_grouping":true}` [ASYNC]. The backend automatically splits the beats into N grids (starting at 2x4, degrading by capacity 8/6/4/2/1; 18 beats -> `2x4+2x4+1x2`, 3 grids in total). Start only one `grid_index` at a time; the SSE result of the first call returns `total_grids`. If more grids follow, wait for the user's "continue" in the next turn to start the next one; do not loop over all grids in the same turn. See Step 12 in `step-api-reference.md` for details. |
| `POST` | `/projects/{project}/episodes/{ep}/grids/generate` | Nine-grid [ASYNC] |
| `POST` | `/projects/{project}/episodes/{ep}/grids/{idx}/regenerate` | Regenerate a single grid [ASYNC] |
| `POST` | `/projects/{project}/episodes/{ep}/grids/{idx}/cut` | Cut into the pool |
| `GET` | `/projects/{project}/episodes/{ep}/grids` | View the nine-grids and image pool (returns a boolean `images[].stale` field, true = generated from an old script version) |
| `POST` | `/projects/{project}/episodes/{ep}/beats/{beat}/pool-select` | Select an image from the pool `{"pool_id":"...","force":false}`; old batches need `force:true` |
| `POST` | `/projects/{project}/episodes/{ep}/sketches/assign-colors` | Sketch coloring (assigns a unique color to each identity) [SYNC] |
| `POST` | `/projects/{project}/episodes/{ep}/sketches/detect-identities` | AI identity detection (recognizes the characters appearing in the sketch) [SYNC] |

## TTS and audio

| Method | Path | Purpose |
|------|------|------|
| `POST` | `/projects/{project}/episodes/{ep}/audio/generate` | Batch speech generation [ASYNC: audio_generation_indextts2]; the current main line uses this |
| `POST` | `/projects/{project}/episodes/{ep}/audio/system-voices/prepare` | Prepare system voices after user confirmation [ASYNC: system_voice_setup]; used only by Shrimp Director, does not start TTS |
| `POST` | `/projects/{project}/episodes/{ep}/beats/{beat}/audio` | Redo a single beat's audio (SYNC) |

The old `/tts/generate`, `/tts/preview` and `/tts/voices` have been removed; do not call them.

## Video

| Method | Path | Purpose |
|------|------|------|
| `POST` | `/projects/{project}/episodes/{ep}/optimize/video-global` | Global video optimization (SuperPower⚡️) `{"language":"en"}` en = English (default), zh = Chinese [ASYNC] |
| `POST` | `/projects/{project}/episodes/{ep}/beats/{beat}/video` | Redo a single beat's video [ASYNC: single_video]. Default `{"video_backend": "huimeng_seedance-1.0-pro-fast"}`; pass `{"video_backend": "huimeng_seedance-1.5-pro"}` only when the user explicitly specifies 1.5 Pro / audio 1.5 / Huimeng 1.5. POST the same beat only once per user request; when the start endpoint returns `ok:false` or an HTTP error, you must report the endpoint's `error` directly. After POST returns 2xx and `ok`/`generated: true`, query `GET /projects/{project}/tasks/single_video/{ep}?beat_num={beat}`; if the status is `failed` / `cancelled`, you must report `task.error`/`error_code` and not say it is done. Do not POST repeatedly because of `Task not found`, a missing task status or no `result.video_path`. When there is no `result.video_path`, do not probe `/files` and do not probe `/api/v1/projects/{project}/files`; wrap up only according to started / current status; `generated: true` does not mean a new video path was returned, do not deliver the old `video_url` in the beat record, and do not concatenate a host. **Do not trigger whole-episode compose/generate/optimize** |
| `POST` | `/projects/{project}/episodes/{ep}/videos/compose` | Compose `{"add_subtitles":true,"add_bgm":false}` [ASYNC] |

## Export and files

| Method | Path | Purpose |
|------|------|------|
| `POST` | `/projects/{project}/episodes/{ep}/export/zip` | Export ZIP |
| `GET` | `/projects/{project}/episodes/{ep}/export/srt` | Export SRT subtitles |
| `GET` | `/projects/{project}/episodes/{ep}/final` | Read the final-cut status and displayable `video_url` |
| `GET` | `/projects/{project}/files/{path}` | Download a file |

## Regeneration

| Method | Path | Purpose |
|------|------|------|
| `POST` | `/projects/{project}/episodes/{ep}/sketches/regenerate` | Redo specified sketches `{"beat_indices":[...],"style":"..."}` [ASYNC: sketch_regen] |
| `POST` | `/projects/{project}/episodes/{ep}/beats/regenerate` | Redo specified first frames `{"beat_indices":[...],"style":"..."}` [ASYNC: selected_regen] |
| `POST` | `/projects/{project}/episodes/{ep}/grids/{idx}/regenerate` | Redo a single grid `{"style":"...","model":"nanobanana"}` [ASYNC: grid_regenerate] |

## Scenes and anchor images

| Method | Path | Purpose |
|------|------|------|
| `GET` | `/projects/{project}/scenes` | List the project scene library; to show scene images use `master_url` / `reverse_master_url` / `pano_url` / `custom_scene_url`, not the local `*_path` |
| `POST` | `/projects/{project}/scenes` | Add a scene `{"name":"...","description":"...","environment_prompt":"..."}`; returns an error if it already exists |
| `PATCH` | `/projects/{project}/scenes/{name}` | Modify a scene; the current backend supports renaming and updating the description/prompt fields |
| `POST` | `/projects/{project}/scenes/{name}/delete` | Delete a scene |
| `POST` | `/projects/{project}/scenes/{name}/master/generate-async` | Generate a scene master image [ASYNC: scene_reference_asset] |
| `POST` | `/projects/{project}/scenes/{name}/reverse/generate-async` | Generate a scene reverse master image [ASYNC: scene_reference_asset] |

## Props (read-only)

| Method | Path | Purpose |
|------|------|------|
| `GET` | `/projects/{project}/props` | List project props |
| `POST` | `/projects/{project}/episodes/{ep}/props/plan` | Plan this episode's props |

The current backend also provides project-level prop write endpoints: `POST /projects/{project}/props`, `PATCH /projects/{project}/props/{name}` and `POST /projects/{project}/props/{name}/delete`.

## Styles

| Method | Path | Purpose |
|------|------|------|
| `GET` | `/styles` | List styles |
| `GET` | `/styles/{id}` | Style details |
| `POST` | `/styles` | Create a custom style |
| `DELETE` | `/styles/{id}` | Delete a custom style |
| `GET` | `/styles/{id}/preview` | Style preview image (returns an image file). **A 200 response means done; directly tell the user "the preview image has been obtained", do not expose the URL, and do not probe other paths** |
| `POST` | `/projects/{project}/styles/analyze` | Style analysis (upload a reference image to extract style parameters) multipart/form-data [SYNC] |

## Pipeline status

| Method | Path | Purpose |
|------|------|------|
| `GET` | `/projects/{project}/pipeline/status` | Aggregated pipeline progress (supports `?episode=N`) |

## Task management

| Method | Path | Purpose |
|------|------|------|
| `GET` | `/projects/{project}/tasks` | List project tasks |
| `GET` | `/projects/{project}/tasks/{task_type}/{episode}` | Query project task status; single-beat tasks carry `?beat_num=N` |
| `GET` | `/projects/{project}/tasks/{task_type}/{episode}/stream` | Project task SSE; single-beat tasks carry `?beat_num=N` |
| `GET` | `/projects/{project}/tasks/stream` | Aggregated project task SSE |
| `DELETE` | `/projects/{project}/tasks/{task_type}/{episode}` | Cancel a project task |
| `DELETE` | `/projects/{project}/tasks/completed` | Clean up completed project tasks |

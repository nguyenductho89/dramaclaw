# DramaClaw (Shrimp Director) Editable Fields Reference

When the Agent handles a user edit request, consult this document for concrete field names, types and allowed values. See [update-behavior.md](update-behavior.md) for the response boundaries of update requests and how users phrase them.

---

## Project configuration

**API**: `PATCH /projects/{project}`

| Field | Type | Allowed values | Default |
|------|------|--------|------|
| `visual_style` | string | `chinese_period_drama`, `anime`, `realistic`, `post_apocalyptic` | `chinese_period_drama` |
| `narration_style` | string | `first_person`, `third_person` | `first_person` |
| `ethnicity` | string | `Chinese`, `Japanese`, `Korean`, `Western` | `Chinese` |
| `rhythm` | string | `fast`, `medium`, `slow` | `medium` |
| `tts_provider` | string | `cosyvoice`, `edge` | `cosyvoice` |
| `tts_model` | string | `cosyvoice-v3-flash` etc. | `cosyvoice-v3-flash` |
| `tts_voice` | string | `longanling_v3`, `zh-CN-XiaoxiaoNeural` etc. | `longanling_v3` |
| `grid_mode` | string | `3x3` etc. | `3x3` |
| `grid_model` | string | `nanobanana` | `nanobanana` |
| `video_backend` | string | `huimeng_seedance-1.0-pro-fast`, `huimeng_seedance-1.5-pro`, `seedance_fast`, `seedance_pro`, `seedance_pro_silent`, `comfyui`, `wan26`, `ltx23` | `huimeng_seedance-1.0-pro-fast` |
| `video_resolution` | string | `720x1280`, `1080x1920` | `720x1280` |

`video_backend` selection rules:
- `huimeng_seedance-1.0-pro-fast`: the default; unless the user explicitly specifies another backend, use it for per-beat video generation and single-beat redo.
- `huimeng_seedance-1.5-pro`: pass only when the user explicitly specifies 1.5 Pro / audio 1.5 / Huimeng 1.5; not the default.
- Known limitation: the current main line has no whole-episode batch video generation route; do not split a whole episode into multiple single-beat requests to simulate in-batch dispatch. Start the `single_video` of at most one eligible beat per turn.
- `seedance_fast`, `seedance_pro` and `seedance_pro_silent` are legacy compatibility values; do not recommend legacy values by default.

## Characters

**API**: `PATCH /projects/{project}/characters/{name}`

| Field | Type | Description | Downstream impact |
|------|------|------|----------|
| `face_prompt` | string | Facial description (hairstyle, eye shape, skin tone) | -> redo the portrait |
| `description` | string | Character bio | No direct rerun |
| `gender` | string | Gender | No direct rerun |
| `is_main` | bool | Whether protagonist | Affects character tiering |
| `role` | string | Character type (protagonist / supporting / antagonist) | Affects character tiering |
| `body_type` | string | Body type description (slim and tall / sturdy and muscular) | Affects image generation |
| `fish_voice_id` | string | Fish Audio S2 voice ID (for dialogue beats only) | -> redo voiceover for all of this character's dialogue beats |
| `aliases` | string[] | Alias list | Affects character recognition |

## Character identities

**Add**: `POST /projects/{project}/characters/{name}/identities`
**Modify**: `PATCH /projects/{project}/characters/{name}/identities/{identity_id}` (identity_id = `character_name_identity_name`)
**Delete**: `DELETE /projects/{project}/characters/{name}/identities/{identity_id}`
**Generate an identity image**: `POST /projects/{project}/characters/{name}/identities/{identity_id}/generate`
**Upload an identity image**: `POST /projects/{project}/characters/{name}/identities/{identity_name}/upload` (multipart)

| Field | Type | Description |
|------|------|------|
| `identity_name` | string | Identity name (such as "casual wear", "court robe", "battle armor") |
| `appearance_details` | string | Appearance description (**must** be concrete down to clothing color + style + material; avoid vague words such as "formal wear", "casual wear", "leisure wear"). Excludes the face. -> redo the identity image -> affects costume consistency in sketches/first frames |

## Episodes

**API**: `PATCH /projects/{project}/episodes/{ep}`

| Field | Type | Description |
|------|------|------|
| `title` | string | Episode title |
| `content_summary` | string | Content summary |
| `character_names` | string[] | Names of appearing characters |
| `key_events` | string[] | Key events |
| `cliffhanger` | string | Suspense / hook |
| `identity_ids` | string[] | Identity IDs used in this episode |

## Episode content (source text and rewritten draft)

The source text and the rewritten draft are not in `PATCH /episodes/{ep}`; each has its own endpoint.

| Field | API | Description | Downstream impact |
|------|-----|------|----------|
| `raw_content` | `GET/PUT /projects/{project}/episodes/{ep}/raw-content` | Source text (the original copy in the episode workbench) | After a change: the rewritten draft (if it exists) becomes stale -> needs rewriting again; when generating the script directly -> beats need regenerating |
| `adapted_content` | `GET/PUT/DELETE /projects/{project}/episodes/{ep}/adapted-content` | Working copy after the narration rewrite | -> regenerate the script -> sketches/first frames/video/compose |

**DELETE semantics**: after the rewritten draft is cleared, script generation falls back to the source text.

**Note**: changing `raw_content` does not automatically clear `adapted_content`; if you want the skill to rewrite again, call `DELETE /adapted-content` or explicitly overwrite with `PUT /adapted-content`.

## Beat

**API**: `PATCH /projects/{project}/episodes/{ep}/beats/{beat}`

| Field | Type | Description | Downstream impact |
|------|------|------|----------|
| `narration_segment` | string | Narration / dialogue text | -> redo voiceover |
| `visual_description` | string | Visual description | -> redo sketch -> first frame -> video |
| `location` | string | Scene location | -> may affect the sketch |
| `location_description` | string | Detailed scene description | -> may affect the sketch |
| `time_of_day` | string | Time (day/night/...) | -> affects lighting and atmosphere |
| `video_prompt` | string | i2v video prompt | -> redo video |
| `keyframe_prompt` | string | k2v keyframe prompt | -> redo video |
| `video_mode` | string | `"first_frame"` / `"keyframe"` | -> affects the video generation mode |
| `audio_type` | string | `"narration"` (narration) / `"dialogue"` (character lines) | -> redo voiceover |
| `speaker` | string | Speaker identity ID (required for dialogue, such as `"JiangShangning_empress"`) | -> redo voiceover |
| `fish_speech_prompt` | string? | Fish Audio S2 emotion-tagged lines (such as `[angry]line content`) | -> redo voiceover |

## Styles

**View**: `GET /styles` (list), `GET /styles/{id}` (details)
**Create**: `POST /styles`
**Delete**: `DELETE /styles/{id}` (custom styles only)
**Preview**: output `/static/style-examples/{style_id}.jpg` directly (on OSS, signed automatically by the frontend when loaded)

```json
// Create
{"id": "my_style", "name": "My Style", "label": "Custom", "config": {...}}
```

## Scenes

**List**: `GET /projects/{project}/scenes`
**Add**: `POST /projects/{project}/scenes`  body `{"name":"...","description":"...","environment_prompt":"..."}`
**Modify**: `PATCH /projects/{project}/scenes/{name}`
**Delete**: `POST /projects/{project}/scenes/{name}/delete`

| Field | Type | Description | Downstream impact |
|------|------|------|----------|
| `name` | string | Scene name | Affects scene library matching |
| `description` | string | Scene description | Affects later generation prompts |
| `environment_prompt` | string | Environment prompt | Affects later generation prompts |

The current backend has no `anchor-image/*`, `snapshot-sync` or `scene_anchor` task; do not call these old routes.

## Props

| Operation | API |
|------|-----|
| List | `GET /projects/{project}/props` |
| Plan this episode's props | `POST /projects/{project}/episodes/{ep}/props/plan` |
| Add | `POST /projects/{project}/props` |
| Modify | `PATCH /projects/{project}/props/{name}` |
| Delete | `POST /projects/{project}/props/{name}/delete` |

## File uploads

| Operation | API | Format |
|------|-----|------|
| Upload a novel | `POST /projects/{project}/ingest/upload` | multipart `file=novel.txt` |
| Upload a portrait | `POST /projects/{project}/characters/{name}/portrait/upload` | multipart `file=portrait.png` |
| Upload an identity image | `POST /projects/{project}/characters/{name}/identities/{identity_name}/upload` | multipart `file=identity.png` |

## Image pool selection

**Workflow**: browse the image pool -> pick an image -> update the beat's first frame

```
1. GET /projects/{project}/episodes/{ep}/grids -> get the image pool data (including cell_url and stale fields)
2. When showing the image pool to the user, see delivery-boundaries.md for the delivery boundaries and read-behavior.md for the default summary-reading policy
3. After the user picks an image, first check that image's stale field:
   - stale=false -> normal selection: POST pool-select {"pool_id": "..."}
   - stale=true -> warn that the old batch's colors are incompatible, and after user confirmation pass {"pool_id": "...", "force": true}
   - The try -> fail -> force pattern is forbidden (first without force -> rejected -> retry with force)
```

## Audio operations

| Operation | API | Description |
|------|-----|------|
| Whole-episode audio | `POST /projects/{project}/episodes/{ep}/audio/generate` | [ASYNC: audio_generation_indextts2], used by the current main line |
| Redo a single beat | `POST /projects/{project}/episodes/{ep}/beats/{beat}/audio` | Synchronous, returns directly |

The old `/tts/generate`, `/tts/preview` and `/tts/voices` have been removed; do not call them.

## Export

| Operation | API | Description |
|------|-----|------|
| Export ZIP | `POST /projects/{project}/episodes/{ep}/export/zip` | Package all of the episode's assets |
| Export SRT subtitles | `GET /projects/{project}/episodes/{ep}/export/srt` | SubRip format |
| Download a file | `GET /projects/{project}/files/{path}` | Path relative to `output/{username}/{project}/` |

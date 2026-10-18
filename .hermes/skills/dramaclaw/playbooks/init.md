# Current project initialization stage (Steps 1-7)

> This file is the single source of truth for the process order of Steps 1-7. When API request details are uncertain, read
> `references/step-api-reference.md`; technical references must not change the order in this file.

## Precondition: project existence check

The `/pipeline/status` response from Step 0 (SKILL.md, status preflight) decides which step to start from:
- **404**: the project bound to the current session does not exist or is not accessible -> stop and tell the user to create/open the project in the frontend first; Shrimp Director does not call `POST /projects`
- **200 + all stages false**: the project exists but has not been ingested -> start from Step 1 (get the source file)
- **200 + partially complete**: this should actually go through resume.md; if routed here by mistake, fall back to locating by `next_step`

## Entry decision tree

> The precondition for entering this playbook is that the current message already carries a screenplay document attachment, or the frontend has injected `[DRAMACLAW_INGEST_AUTOMATION]` / an explicit ingest context. If the user only asks in chat text to "create/generate/write a screenplay", do not enter the flow below; tell them directly that screenplay documents can only be uploaded through "Shrimp Feed".

```
1. Get the source file
   The current message must already have a screenplay document attachment or a Shrimp Feed ingest context
   ├─ Present → use the upload/ingest context provided by the frontend
   └─ Absent → stop and tell the user to upload a screenplay document through "Shrimp Feed"

2. Execute one action according to the current state (do not re-confirm the same step)
   - The frontend has injected `[DRAMACLAW_INGEST_AUTOMATION]`: upload and ingest start were already handled by the frontend; do not call write tools again, only report the current status.
   - The current attachment has not been uploaded yet: only perform the upload (Step 1) and wrap up; start ingest the next time the user continues.
   - The file is uploaded but ingest has not started: only start ingest (Step 2) and wrap up immediately.
   - Ingest is queued/running: only tell the user that ingest is running in the background; do not wait for completion and continue configuring.

3. Smart recommended configuration (decision-point rules in §5)
   After ingest completes, analyze the novel content before recommending:
   - Era / keywords -> visual style
   - Character names / background -> ethnicity
   - Point of view -> narration style
   - Plot pace -> rhythm

4. Present the recommended plan in one go and let the user confirm/modify

5. After confirmation -> configure the project (3); after configuration, ask for the run mode and do not continue to start character extraction
```

**Run mode**: after configuration you **must** first ask one question: "Should I **confirm every step**, or **advance automatically (one step per turn)**?",
then `Read references/run-modes.md` and execute according to the chosen mode:
- **Step-by-step confirmation mode** -> pause before every write step and ask the user; advance only one step at a time
- **Auto-advance mode** -> the next time the user says "continue", advance from the breakpoint; each turn still starts at most one write task and wraps up after starting it

**Key point**: do not ask the user to choose configuration items one by one; recommend them all at once after analysis; but the **run mode must be asked explicitly**.

## Step details

**API details**: see Steps 1-7 in `references/step-api-reference.md`. Project creation is done by the frontend/system and is not a Shrimp Director step.

**Step 4 failure handling**: if `build_characters` returns an empty result, analyze the characters from the novel content and add them one by one through `POST /projects/{project}/characters`.

**Step 5 face_prompt precondition**: before generating portraits you must read `GET /projects/{project}/characters` and check the `face_prompt` of core/important characters.
- If it is empty, first generate one concrete facial-feature description from the character name, gender, age range and description, and write it with `dramaclaw_update_character_face_prompt`.
- `face_prompt` covers facial features only: hairstyle, face shape, facial features, skin tone, apparent age, temperament; do not write clothing, identity or scene.
- Only after all missing characters are filled in may portrait generation begin.
- If a portrait task reports "set the facial features (face_prompt) first", stay on the current character, fill in that character's `face_prompt` and retry; do not skip it or continue generating other dependencies.

**Step 6.5 character tiering standard**:

| Tier | Condition | Handling |
|------|------|------|
| Core character | `is_main=true`, or appears repeatedly across episodes | Portrait + identity image |
| Important supporting character | Named, appears in 2+ episodes | Portrait + identity image |
| One-off supporting character | Appears in only 1 episode, no key plot | Skip |

### Decision-point reference

**Smart recommendation** (recommend all at once after analyzing the novel content):
- `visual_style`: ancient/wuxia -> `chinese_period_drama` | modern urban -> `realistic` | apocalypse -> `post_apocalyptic` | anime -> `anime`
- `narration_style`: point of view of the source text -> `first_person`/`third_person` (default first_person)
- `ethnicity`: names/geography -> `Chinese`/`Japanese`/`Korean`/`Western` (default Chinese)
- `rhythm`: plot density -> `fast`(3s)/`medium`(4s)/`slow`(5s) (default medium)

**User must choose** (show on the first time or when the user asks):
- Voice: `tts_provider`+`tts_voice` (default cosyvoice + longanling_v3)
- Video backend: `video_backend` (default `huimeng_seedance-1.0-pro-fast`; `huimeng_seedance-1.5-pro` only when the user explicitly specifies it; old values are only kept for historical tasks)
- Resolution: `video_resolution` (720x1280/1080x1920, default 720x1280)

## Step 7 complete -> stage transition

**In either manual or auto mode**, output a stage summary (for example: "Global preparation complete: project X, 5 characters (2 core, 3 important), 10 episodes, portraits generated").

**Step-by-step confirmation mode**: see mode one in `references/run-modes.md` - from Step 3 on, pause before every write step and ask the user,
advancing only one step at a time. At CP1 show the core characters' Portraits + tiers + episode titles; the user may change character tiers/appearance/the number of episodes,
and after confirmation ask "Execute the next step?".

**Auto-advance mode**: see mode two in `references/run-modes.md` - choose the next step automatically, but start at most one write task per turn;
wrap up immediately after starting it. At CP1 (showing core characters + episode titles) you must also pause and wait for the user to continue.

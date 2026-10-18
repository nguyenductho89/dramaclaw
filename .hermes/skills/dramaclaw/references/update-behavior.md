# Update Behavior

The goal of an update request: **change the right object the user wants changed, and keep the response scope to the user's request itself.**

## Applicable scenarios

- Changing a character's appearance, portrait or identity image
- Changing a beat's visual description, dialogue, audio type or speaker
- Changing voices, redoing audio, redoing sketches / first frames / videos
- Changing the project configuration or some editable field

## Default handling principles

- First make clear which object and field the user wants to change.
- Return "what was changed + the necessary impact scope + current status".
- Do not widen the necessary impact chain into an unrelated delivery scope.
- Default closing template: `Updated <object/field>` + `Current status` + `Next you can handle <the next item of the necessary impact chain>`

## Response boundaries

- If the user wants an object itself, return that object's result or status.
- If the user wants a field updated, return that the field was updated plus the necessary downstream impact.
- When the user has not explicitly asked for the final cut / download / an open path, do not proactively add final-cut delivery.
- If it is merely "after the change, keep generating up to the final cut", the default meaning is to advance step by step along the necessary impact chain; this turn executes at most one write operation and reports the status, without additionally probing a final-cut link.

## Expressing the impact chain

- Express only the necessary impact chain; do not exaggerate it into "redo the entire episode".
- If you are merely advancing to the compose/export stage, start one necessary task or report the current status according to the current `next_step`; that is not the same as having obtained a final-cut link.
- If the endpoint returns no official result path, you can only describe the status and must not fabricate a business-result link.

## Typical update semantics

- Character appearance change: only update one current target field of the modified character or start one portrait/identity image task; do not redo other characters' identity images along with it. By default return "appearance updated / current task started / affected shots can be handled next".
- Beat audio or speaker change: this turn updates only the target beat by default; the next turn redoes the necessary audio, and after the audio completes a later turn composes.
- Beat visual description change: by default only update the target beat's `visual_description`; the sketch, first frame, video and compose chain continue step by step in later turns.
- Only when the user explicitly asks for the character settings to be changed as well do you extend to `face_prompt`, `appearance_details`, portraits or identity images.

## Fixed order

- When changing `audio_type`, `speaker`, `fish_speech_prompt` or a beat's dialogue text, the default order is:
  1. First update the beat
  2. Then redo that beat's audio
  3. Finally trigger compose
- The order above is a cross-turn order, not continuous execution in the same turn. One user message executes at most one of these write operations.
- Even if the beat's current dialogue text already matches the target text, as long as `audio_type`, `speaker`
  or audio-related fields have not yet been updated to the target values, you must still update the beat first and then redo the audio
- `compose` must not be pre-started or run ahead, and must not be launched first to save time with the audio fixed afterwards.
  It may be entered only after that beat's audio redo request has been sent and returned successfully.

Do not launch `compose` before the audio redo.

## Common update types

- Character appearance update: return the current status of the character's appearance/portrait, and the affected shots that can be handled next.
- Beat visual description update: by default only change the target beat's `visual_description`, and hint that the next step can continue redoing the sketch / first frame / video.
- After identity planning returns, only follow up on identities that have an explicit character name that can be matched in the current project's character table; skip empty or invalid character names and do not probe `/characters//identities`.
- If `selected_regen` is hit in such an ordinary continuation, it still belongs to the normal first-frame generation chain.
- When describing the necessary impact chain to the user, do not use wording like "redo the entire episode" or "full redo", even in a negative sentence.
- Beat audio/speaker update: first change the target beat, then redo the necessary audio, and finally update the compose status.
- Field modification: use [editable-fields.md](editable-fields.md) to judge whether it is changeable and what the impact chain is.

## Prohibited

- Do not describe a partial update as a full redo of the entire episode
- Do not write internal compensation steps, endpoint retries or probing processes to the user
- Do not proactively widen into delivering the final cut, download instructions or unrelated artifacts when the user did not ask
- Do not promise "the video can now be downloaded / opened" when there is no official result path
- Do not claim to have written fields that were not actually sent (for example, if POST only passed name/role, do not say "persona and appearance written")
- Do not narrate the execution process (such as "first locate... then execute along the chain", "look up the identity ID", "watch the compose status"); only state the final result
- Do not interpret the "necessary impact chain" as automatically completing sketch -> first frame -> video -> compose in the same turn

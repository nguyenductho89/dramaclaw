# Output Schema

When this skill is used with the current Claude Code model as the teacher, it should write:

- one JSON object per line to `labels.jsonl`
- one completion marker file at `labels_summary.json`

`labels.jsonl` is the execute input for edited beats only, not a full-dataset export.

Each row should look like:

```json
{
  "project_dir": "/abs/path/to/project",
  "episode_num": 1,
  "beat_number": 4,
  "execution_mode": "polish",
  "sketch_path": "/abs/path/to/sketch.png",
  "beat": {
    "beat_number": 4,
    "narration_segment": "...",
    "visual_description": "...",
    "location": "...",
    "time_of_day": "...",
    "audio_type": "...",
    "speaker": "...",
    "set_description": "..."
  },
  "sketch_colors": [
    {
      "identity": "Su Changming_official",
      "color_name": "BURNT SIENNA",
      "color_value": "#C95B3E",
      "raw": "#C95B3E BURNT SIENNA"
    }
  ],
  "result": {
    "decision": "revise",
    "main_problem": "character_count_wrong",
    "reasoning": "1-3 concise sentences.",
    "edit_instruction": "Remove... Change to... Keep... Do not...",
    "confidence": 0.92
  },
  "raw_text": ""
}
```

After the final row has been written, also write `labels_summary.json`:

```json
{
  "project_dir": "/abs/path/to/project",
  "episode_num": 1,
  "label_count": 3,
  "output_jsonl": "/abs/path/to/project/verify_reports/ep001/labels.jsonl"
}
```

## Constraints

- `execution_mode` must be `polish`
- copy `execution_mode` forward from the task row unchanged
- every row in `labels.jsonl` must be a revise row for an actually edited beat
- before the first append, truncate the old file or start from an empty new file
- it is valid to append one row at a time while reviewing tasks
- `labels_summary.json` must only be written after the full `labels.jsonl` file is complete
- if no edits are needed, still write an empty `labels.jsonl` and `labels_summary.json` with `label_count: 0`
- downstream `validate / execute` treat `labels_summary.json` as the completion marker
- `result.decision` must be `revise`
- `result.main_problem` must be one of:
  - `identity_color_mismatch`
  - `staging_unclear`
  - `scene_mismatch`
  - `character_count_wrong`
  - `pose_action_wrong`
- `edit_instruction` must be directly executable
- `edit_instruction` should read like a short image-edit execution instruction, not a review paragraph
- `edit_instruction` should stay within about 60-120 words
- infer visible identities mainly from the sketch itself, beat text, and visible color-coded relationships
- `sketch_colors` is for verifying visible identity-color alignment; absent identities are not errors
- when `decision=revise` and the revision involves identity color correction, `edit_instruction` should include at least one `#RRGGBB` color reference
- if identities are mentioned in `edit_instruction`, use exact `identity + hex color`
- each edited panel should involve at most 2 named identities; repeated appearances of the same identity still count as 1
- unnamed extras may remain, but they must stay neutral / gray and should not become a third named identity target
- do not use vague color phrases such as `the pink figure` or `the orange figure`

## `edit_instruction` writing rule

Treat every `revise` case as a directed re-generation with constraints.
Do not write vague feedback like:
- `strengthen the emotion`
- `more tension`
- `optimize the composition`
- `improve the atmosphere`

Instead, write a concrete instruction that tells the image model:
- what to keep
- what to change
- what to remove
- what identity colors must be preserved or corrected
- what should not appear
- whether subject count / occlusion / malformed body parts must be fixed

Preferred structure:
- `Remove...`
- `Change to...`
- `Keep...`
- `Do not...`

When old wrong content is still visible, put `Remove...` first so the model does not over-preserve outdated figures, actions, or staging.
Inside `Change to...`, focus on the real defect:
- `identity color...`
- `remove extra subjects/limbs/fingers...`
- `restore missing subjects...`
- `fix the subject count/relationships/occlusion...`
- `remove text in the image...`
- only mention `shot size / angle / composition` when the defect itself is a staging or readability problem

Good `edit_instruction` dimensions:
- removal / cardinality: which subject to remove, what not to keep, how many subjects to keep
- identity color: exact `identity + #RRGGBB`
- image correctness: remove extra hands/fingers/limbs, fix malformed bodies, restore missing subjects
- readability: fix occlusion, subject relationships, wrong subject counts, and text in the image
- staging / shot terms: only when needed to fix a real readability defect, not to upgrade the shot aesthetically

When the panel contains 2 named identities, the instruction should also make the relationship layout explicit:
- state who is on the left / right or front / back
- state who may not block whom
- state that both main figures must stay readable
- if an object or gesture crosses between them, say it crosses the gap rather than merging the bodies

When the defect is a non-symmetric two-person action, do not stop at a verb like `grip` or `hand toward`.
Make the action geometry explicit:
- who is the active actor and who is passive
- exactly how many arms / hands are visibly involved on each side
- whether one side is wrapped / covered / pinned / held from above or below
- whether the passive side must not respond, mirror, or form a symmetric gesture
- if needed, explicitly say `do not draw it as a symmetric handshake` / `do not make it a two-way response`

When the correction is about duplicate or leftover figures, be explicit:
- say `Remove the original second figure`
- say `Keep only one past-life figure in the background`
- say `Do not keep the old duplicated subject`
- do not assume the image model will infer removals from composition changes alone

Bad example:
- `Not oppressive enough; strengthen the emotion and atmosphere.`

Good example:
- `Remove the extra gray servants and duplicated hands. Change to keep only two subjects, Su Qingrou_empress_wedding #FF6B00 and Su Qingyan_before_rebirth #FF00FF, with Su Qingyan_before_rebirth #FF00FF's body fully readable. Keep the top-down pressing relationship. No extra colored supporting characters, no extra fingers, no text in the image.`
- `Remove the current symmetric clasped-hands gesture. Change to Su Qingyan_after_rebirth #CCFF00 wrapping both hands around one hand of Wancui_maid #FF00FF from above and below; Su Qingyan is the active gripper and Wancui is the passive receiver. Keep Su Qingyan leaning forward. Do not draw Wancui as actively gripping back, and do not have both people stretch out both arms symmetrically.`

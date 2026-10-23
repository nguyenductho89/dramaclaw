# Scene staging planner rules

Used by `agents/scene_staging_planner.py` to write a short "staging
bible" for each scene in an episode — camera framing, where each
character stands, and where persistent set-dressing sits — so every beat
of the same scene renders with consistent blocking instead of each first
frame being composed independently (see `.claude/CLAUDE.md`'s "Parkun"
entry for the real renders that motivated this: the same scene's toy
wall appeared at a different spot or vanished entirely from one beat's
render to the next, and characters swapped left/right).

Every field you propose is re-validated and, where needed,
deterministically repaired or dropped by Python afterward — focus on
making *good* judgment calls, not on getting ids letter-perfect (though
getting them right means less of your plan gets discarded).

**Critical rule — each beat only ever gets the ONE sentence for the
identity it actually tags, never the whole scene's staging at once.** A
single beat may include only one of this scene's several characters.
Because of that:

- A `blocking` sentence for character X must describe ONLY X's own
  position — never name another character (e.g. never write "...facing
  Y" or "...toward Y"), and never assume Y is also in frame. Describe X
  relative to the LOCATION ("stands on the left side of frame, beside
  the toy wall") not relative to another person.
- `camera` must never assert how many people are visible or name a
  specific character — no "both children", "the two kids", "facing each
  other", etc. Describe only the angle, shot size and background; it
  must stay literally true whether 1 or all of the cast is present in a
  given beat.
- A `set_dressing.placement_note` must never say "the other child" or
  imply a second, unnamed person. Naming the specific character a prop
  belongs to (e.g. "sits beside Little Trump") is fine; vague
  cross-references to someone unnamed are not.

A sentence that breaks this rule gets silently discarded/replaced by
Python — you will do a better job than the generic fallback by writing
clean, self-contained sentences in the first place.

## What you're given, per scene

- The scene's own establishing description (its master reference image's
  own prompt, if any).
- Every beat in this episode that belongs to this scene, in script
  order, each beat's own visual description and which characters/props
  it tags.
- The full cast of characters that appear anywhere in this scene, with
  their body-type/age hint if known.
- The full list of props that appear anywhere in this scene, with their
  own visual description if known.

## What to produce, per scene

1. **`camera`**: one or two sentences fixing the camera's framing for the
   WHOLE scene, SPECIFIC AND NUMERIC enough that two independently
   generated beats come out at the same zoom/distance — a vague sentence
   like "medium-wide shot" left different beats of the same real scene
   rendering at visibly different distances (one beat a medium shot
   filling ~40% of frame height, another a wide shot with tiny figures,
   another a tight close-up) even though every beat used the same vague
   wording (real failure, `Parkun` project — see `.claude/CLAUDE.md`).
   Always state ALL of:
   - Shot type AND the approximate fraction of frame height a standing
     character occupies (e.g. "medium shot, each character framed from
     roughly head to mid-thigh, occupying about 35-45% of the frame's
     height" — not just "medium shot").
   - Camera angle/height (e.g. "at a small child's eye level").
   - Where the scene's own persistent background elements (building
     facade, play equipment, etc.) sit relative to the frame, so the
     background composition also stays the same across beats.
   Keep it consistent with what the scene's own master image already
   shows; don't invent a different location or framing.
2. **`blocking`**: for every character that appears in this scene, one
   short sentence fixing where they stand relative to the frame (left /
   right / center) — pick an arrangement that stays sensible across
   EVERY beat of the scene (a character shouldn't jump from left to
   right between consecutive beats unless the beats' own text clearly
   describes them moving). Base the arrangement on how the beats'
   dialogue/action actually plays out (who speaks to whom, who hands
   something to whom), not an arbitrary assignment.
3. **`set_dressing`**: for every prop that appears in MORE THAN ONE beat
   of this scene, or whose own description implies it stays in frame
   once introduced (anything built, placed down, or left somewhere,
   rather than picked up and immediately put away) — one entry with:
   - `placement_note`: one short sentence fixing where it sits in frame.
   - `persistent`: `true` if it should still be mentioned/visible in
     every later beat of the scene even when that beat's own text
     doesn't re-tag it (e.g. a wall a character built earlier and never
     tears down) — `false` if it only matters for the specific beat(s)
     that mention it (e.g. something picked up, held briefly, then put
     away or handed off).
   - `from_beat`: the first beat number (within this scene) where it
     should start appearing.
   Do NOT invent a `set_dressing` entry for a prop that is only ever
   briefly held in one beat and never referenced again — that's normal
   per-beat prop handling, not persistent staging.
4. **`scale_note`**: one short sentence on relative scale that should
   hold across the whole scene — e.g. the characters' ages/heights
   relative to the environment's own adult-scale architecture (doors,
   furniture, fences). Only needed if the scene's own cast has an
   unusual scale relationship (children, giants, etc.) that's easy for
   an image model to get wrong without being told explicitly.

Keep every sentence short and literal — these are fed directly into an
image-generation prompt, not read by a person.

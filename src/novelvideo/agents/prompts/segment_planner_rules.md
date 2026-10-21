# Segment planner rules

Used by `agents/segment_planner.py` to group an episode's beats into
short "segments" (10-15s each) that will each become ONE MiniMax H3
Multishot job — one shot per beat, continuous within the segment. Every
number you propose is re-validated and, if needed, deterministically
repaired by Python afterward (see `validate_and_repair_segment_plan`), so
focus on making a *good* grouping, not on getting the arithmetic exactly
right.

## Hard constraints (the code enforces these; try to satisfy them anyway
so your plan needs the least repair)

1. A segment is a **contiguous run of beats** in script order — never
   skip a beat or reorder.
2. Every beat must end up in exactly one segment (none left out, none
   duplicated).
3. A segment has **1 to 3 beats** (1 to 3 shots).
4. Each shot's assigned `seconds` is **5 to 12**.
5. A segment's total duration should be **roughly 10-15 seconds** — not a
   hard ceiling, but avoid going much over.
6. A segment's beats should use **at most 3 distinct characters in
   total** (counting the union across its beats) — more than that makes
   too many reference images for one job.
7. Never split a single line of dialogue across two segments — if two
   consecutive beats are the same uninterrupted dialogue exchange,
   consider keeping them together (but this still counts toward the
   3-beat/3-character limits above).

## Grouping judgment (use these to decide WHERE to cut)

- Prefer cutting at a scene change (`scene_ref`/`scene_id` changes)
  over cutting in the middle of a scene.
- Prefer cutting between a narration beat and the next dialogue
  exchange, not in the middle of a back-and-forth conversation.
- A beat whose own natural length (from its narration/dialogue) is
  already close to 12 seconds is a reasonable segment by itself (1
  shot) — don't force it together with a neighbor just to fill a quota.
- When a beat is clearly long-form narration (a paragraph, not a single
  short line) that would need far more than 12 seconds to read aloud,
  it must stand alone as a 1-shot, 12-second segment — note this in
  `reason` so the caller knows that beat's audio will likely run over
  and get cut off.
- A short reaction/beat (e.g. a single gesture, a one-word line) pairs
  well with its neighbor rather than standing alone at the 5-second
  floor.

## What to write in `reason`

One short sentence per segment: why these beats belong together (same
scene, continuous exchange, standalone long beat, etc). This is shown to
the user reviewing the plan, not used by any code.

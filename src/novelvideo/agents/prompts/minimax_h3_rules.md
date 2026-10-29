# MiniMax H3 prompt rules — content only

Used by `agents/minimax_h3_prompt_builder.py` to decide what a drama beat's
`MiniMaxH3Content` fields should say. Sources: the official HF guides
(`MiniMaxAI/MiniMax-H3/docs/VIDEO_PROMPT_WRITING_GUIDE_{base,ref}_en.md`),
the `photoreal-short-drama-generator` project's production convention
(`references/core-rules.md`, `3-prompts.md`), and the community skills in
`github.com/gordonlu/awesome-minimax-h3-skills/community-skills`
(`h3-performance-director`, `h3-micro-cinematic-director`,
`cinematic-key-art-animator`, `reference-motion-transfer`,
`h3-keyframe-film`, `h3-shot-pattern-library`). Edit this file to tune the
rewriter's content without touching code.

**You do not write the final prompt text, section headers, or any
`<Picture N>`/`<Subject N>`/`[Shot N]`/`<d>` tag — `assemble_minimax_h3_prompt`
in code handles all of that deterministically, including inserting the
beat's real dialogue line verbatim.** The rules below are about what you
put in your structured answer's fields.

## Content rules

00. **Stay faithful to the beat's visual description.** Every concrete
   element it names must survive into your `timeline`/`summary_action`:
   the era or period and who fills the space (e.g. Edo-period townspeople
   and samurai), each prop and how it is held, the direction of movement
   (walks INTO frame from the edge), and who is where. Do not invent a
   camera position the description never gives ("from behind", "facing away
   from the camera"), do not empty a place the description says is crowded,
   and do not drop a prop the description mentions. Without a first frame,
   keep the camera `static` unless the description itself asks for a move.
   **A Scene reference image is routinely an empty establishing plate** —
   crowds/extras are usually added later and will not be visible in it. If
   the plate looks empty but the beat text says the place is crowded,
   that's expected, not a contradiction: still describe the crowd the text
   names. Rule 7's "trust the image over the text" is about a *character*
   reference's own appearance only — it never licenses dropping a crowd,
   era detail, or action that the Scene reference simply doesn't depict.

0. **Reference kinds and a missing first frame.** A reference of kind
   `scene` is the *location*: describe its architecture/lighting in its
   `subjects` entry and keep the action inside it. A reference of kind `prop`
   is an object the character handles: say how it is held/used. A reference
   of kind `character` is a person. When the beat has NO first frame (the
   user is generating from references only, or from text only), do not
   assume anyone is already in frame: the action must show how the
   character enters or appears in the location, and `first_frame_description`
   should describe the opening composition you want, not an existing image.
   Use the reference's real name (including its identity label) when you
   mention it.

1. **One beat = one continuous event.** Describe one shot's worth of
   action — a hook, a development, a resolution — never a cut, reverse
   shot, or a second distinct scene folded into the same `timeline`. A
   multi-shot story belongs in separate clips, not sections inside one.
   [micro-cinematic §1; keyframe-film]

2. **Build on the first frame; don't re-stage it.** `camera.movement`
   should almost always be `static` — a locked frame. Only choose
   `push_in` or `lateral_track` when the action clearly calls for it
   (never for "cinematic"/"dynamic" reasons on their own), and never when
   the beat has 2+ on-screen characters (identity-tracking risk — code
   downgrades this to static automatically, but don't rely on that; pick
   static yourself in that case too). [shot-pattern-library §5/§32;
   micro-cinematic Rules 3-4]

3. **Budget `timeline` by the beat's duration** (roughly 2-3 spoken
   syllables per second of dialogue window):
   - 5s: 2-3 timeline entries, one action + one recovery.
   - 6-9s: 3-5 entries, one action chain + one performance turn.
   - 10-12s: two phases — a main chain, then a secondary response.
   - A visible change should occur every 1-2 seconds; the first visible
     change (the "hook") lands within 0.5-0.8s; the peak lands at 60-80%
     of the duration, never on the very last timestamp — `end_state`
     covers the final 0.5-1.0s hold on a stable pose, don't duplicate it
     as a `timeline` entry. [micro-cinematic §4/§13; performance-director
     §29; key-art-animator §7]

4. **Emotion → objective → tactic → one visible gesture.** Every
   `timeline[].action` must be an observable behavior (a half-step
   retreat, a tightened jaw, hands clasped) — never a bare emotion
   adjective ("she looks nervous"). For subtext, pair the surface action
   with exactly one contradictory body cue. At most one performance turn
   per beat — don't chain fear → anger → sadness → confidence into one
   beat's `timeline`. [performance-director §2-5]

5. **A speaking beat is "planted action":** feet stay put, but there is
   at least one multi-joint upper-body change (a lean, a turn, a hand that
   reaches then pauses) somewhere in `timeline`. A blink, breathing, or a
   camera push-in alone does not count as motion. Non-speaking characters
   in the same shot get micro-motion only (a breath, a blink, a small gaze
   shift) in their own description — never described as a frozen
   background figure. [cinematic-key-art-animator §9-10; performance-
   director §30-31]

6. **Dialogue (`voices` only — never write the line itself).** The
   module tells you, in the "Dialogue" section of the user prompt, whether
   this beat has dialogue and who speaks. Your only job for dialogue is:
   - Add one `MiniMaxH3VoiceContent` entry per speaker, with
     `subject_index` matching that speaker's position in the `subjects`
     list (1-based; 0 if they have no reference image / are off-screen).
   - `delivery` describes voice only: gender, age, timbre, accent,
     tone/pace (e.g. "a warm medium-pitched woman, anxious, tense and
     quiet, at a normal pace"). Never the words being said, never a quote.
   - Leave room in `timeline`/`summary_action` for the line to land, but
     do not transcribe, translate, paraphrase, or invent it anywhere.
   [anthology §1.3; reference-motion-transfer §8.6; photoreal core rules]

7. **Identity.**
   - **Describe what you actually see in the attached images — not what a
     text hint says.** You have been shown the real first frame and every
     reference image. A character's recorded `appearance_details` text,
     when given, is only ever a supplementary hint — the image is
     authoritative. Never let a text hint override, contradict, or fill
     in a detail the image itself doesn't show; if the two disagree,
     trust the image. When there is no text hint at all, describe the
     subject from the image alone.
   - **Keep `subjects[].anchor` brief — an identity anchor, not a full
     description.** The attached image already carries every visual
     detail; this text only needs enough to lock onto the right identity.
     One short clause, **2-3 visual anchors maximum** (e.g. hair + one
     outfit color/item), under ~15 words. Never personality, backstory, or
     plot information.
   [reference-motion-transfer; verify-recurring-identity-board; h3-keyframe-film]

8. **Ending and continuity.** `end_state` must be an explicit stable pose,
   gaze and prop state — never phrased as an ongoing action ("continues
   ..." / "keeps ..."). Props must not switch hands or location without an
   explained action in `timeline`; keep one consistent light direction
   throughout (mention it in `style_line` if relevant).
   [performance-director Rule 5; h3-reality-physics-guard §4.7-4.8]

9. **Sound.**
   - `soundscape`: 1-4 sentences of diegetic sound tied to the visible
     action (room tone, footsteps, cloth, a door).
   - `music`: 1-3 sentences describing genre/tempo/mood through
     instrumentation and pacing (not bare mood words), or exactly `N/A` if
     there is none. Never ask for music while also implying "no BGM" —
     pick one. [anthology]

10. **9:16 short-drama framing.** `framing` should favor medium shot /
    medium close-up / close-up; keep faces, eyes and the pressure of the
    relationship central to the frame. Describe realistic short-drama
    acting, not theatrical/stage delivery.

11. **Never let text render on screen; never write a bare quote mark**
    anywhere in any field — the assembler strips stray quotes defensively,
    but don't rely on that; write plainly instead (e.g. "he says" rather
    than wrapping anything in quotation marks).

## Self-check before returning

- `subjects` has exactly one entry per reference, in the same order, each
  with a short, image-grounded anchor.
- No bare emotion adjective with no accompanying behavior in `timeline`.
- `camera.movement` is `static` unless the action clearly needs
  `push_in`/`lateral_track`, and never a move with 2+ on-screen characters.
- `voices` describes delivery only — never the spoken words.
- `end_state` is a stable final pose, not "continues"/"keeps".
- `music` is present (a description or exactly `N/A`).

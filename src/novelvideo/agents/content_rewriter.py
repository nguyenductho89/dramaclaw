# ruff: noqa: E501 - the long prompt is intentionally kept readable for prompt editing.

from __future__ import annotations

from pydantic import BaseModel, Field, model_validator
from pydantic_ai import Agent

from novelvideo.brainclaw_contract import BrainClawProfile
from novelvideo.config import (
    get_newapi_structured_output_model_settings,
    get_newapi_text_pydantic_model,
)
from novelvideo.model_gateway_runtime import model_gateway_output_retries


class AdaptedContentOutput(BaseModel):
    """Rewritten line-by-line text output."""

    lines: list[str] = Field(
        default_factory=list,
        description="The rewritten line-by-line text; each line is used by the downstream literal workflow to generate one beat",
    )

    @model_validator(mode="after")
    def normalize_lines(self) -> "AdaptedContentOutput":
        normalized: list[str] = []
        for line in self.lines:
            text = str(line or "").strip()
            if text:
                normalized.append(text)
        if not normalized:
            raise ValueError("lines must not be empty")
        self.lines = normalized
        return self


REWRITE_PROMPT = """You are a short-video narration rewriter for web novels.

Your task is to rewrite the source text into line-by-line narration text; the downstream workflow treats every line as one video beat.
The rewritten text will be read aloud by TTS over the visuals, so **how it sounds and its rhythm are the top priority**.

## Core goals
- Tell the main storyline of this episode as completely as possible, so that someone who has not read the source can follow what happens
- At the same time keep the rhythm, emotion and hooks that web-novel narration should have
- This is neither a paragraph-by-paragraph summary nor a highlights-only cut; balance "complete plot" against "gripping to listen to"

## Line length discipline (a priority target, not a hard rule)
- Each line should **preferably** fall within the specified length range (usually 14-20 characters), which keeps the TTS rhythm steadiest
- But the length is a recommended target, not a mechanical hard cut; **complete expression, key information and core dialogue come first**
- ⚠️ Do not produce fragment lines of 1-2 words (such as "No." "I was reborn." "But.") — a line like that on its own breaks the TTS rhythm
- Normally, split a line that is too long; but if splitting would damage a piece of core dialogue or a complete exchange of attack and defense, that line may moderately exceed the upper limit
- If a piece of information is too short for a line, merge it with the content before or after
- Stable line length matters, but do not chop the meaning of a sentence or truncate core lines just to hit a length

## Sound and rhythm
- Every line must suit being **read aloud** — smooth to say, rhythmic, with emotional ups and downs
- Alternate long and short within the line length discipline: lines near the upper limit advance the narrative, lines near the lower limit create impact
- Use short lines at emotional peaks (but not below the lower limit) and long lines in setup passages to build tension
- Avoid many consecutive lines with the same sentence pattern — if three lines in a row are all "She xxx, he xxx", break it up
- Mind the breathing points: the reader needs to breathe between lines, so every line ending should have a natural pause
- Interleave dialogue lines and narration lines to create a "tell - speak - tell" breathing rhythm

## Style
- Use the tone of a novel's narration, not news broadcasting, not a summary, not script lines
- Keep the emotional intensity, sentence rhythm and word habits of the source text
- Short bursts of sentences, rhetorical questions and dropped subjects are allowed
- Prefer short, hard, ruthless writing over a uniform template tone or platform boilerplate
- ⚠️ No meaningless filler actions or scenery — do not add filler actions like "stumbling", "gasping for breath", "standing silently" to every sentence. If the source has no such action and it does not advance the plot, do not add it
- ⚠️ No cheap power-fantasy padding — do not use stock phrases like "blind and heartless", "like a dead dog", "ecstasy finally drowned out despair", "a fish at the mercy of the knife". Each phrase should come from the feel of the source text, not from a power-fantasy cliché library
- The goal is not "more ornate" but "harsher, more precise, faster plot movement"

## Dialogue rules (⚠️ important)
Dialogue lines are not read by the narrator downstream but voiced by character voices. So a dialogue line must let the downstream tell "who is speaking" and "how it is said".

Format: `Character name + manner of speaking + colon + the original sentence in straight double quotes`
- Su Qingrou sneered: "Everything you have is mine."
- Chu Han roared: "Stealing the sect's treasure, the Marrow-Cleansing Pill!"
- Lin Qingqing said softly: "Master, please stop pressing Senior Sister."

Rules:
- ⚠️ Dialogue content **must be wrapped in straight double quotes `"..."`**; never write it bare
- ⚠️ Whenever a line outputs clear dialogue, it must be written in the complete `Character name + manner of speaking + colon + "original sentence"` format; **never** output bare quoted content only
- ⚠️ If the source already contains clearly quoted dialogue and you can tell who is speaking, that sentence must also be kept in the complete dialogue format after rewriting; do not turn it into narration
- ⚠️ Quoted sentences in the source that stand alone and hit hard should preferably be kept as **independent dialogue lines**; compress the narration around them rather than rewriting such sentences into narrated summaries
- ⚠️ In particular, quoted sentences of the narration protagonist (the first-person narrator) — oaths, threats, verdicts, counterattacks — should be written after rewriting as `I + manner of speaking + : + "original sentence"`, not changed into narration like "I swore that..."
- ⚠️ If the source dialogue is itself the core exchange of the passage (probing, refusing, counterattacking, exposing, threatening, vowing), **keep the whole sentence of dialogue** first
- ⚠️ Compress the narration around the dialogue rather than cutting core dialogue into half a sentence, and never cut off the genuinely forceful second half
- ⚠️ For example a sentence like `"Thank you for your trouble, sister, but you may drink this medicine yourself."` must not shrink to `"Thank you for your trouble, sister."`; and `"If anything is wrong with the medicine, it would be bad for me."` must not keep only its first half
- ⚠️ Never write a speaker-less sentence like `"Everything you have is mine."`; it must be written as `Su Qingrou sneered: "Everything you have is mine."`
- The dialogue text inside the quotes **must keep the original sentence word for word**: do not add words, change wording or change modal particles; if the source uses other quote styles, simply wrap the output in straight double quotes `"..."`
- If the dialogue slightly exceeds the recommended length but that is the more natural complete expression, keep the whole sentence
- Only when the dialogue is clearly too long and seriously drags the rhythm, extract its most impactful part; and prefer keeping the half that truly decides the attack-defense relationship
- Infer the manner of speaking from the source context (sneered, roared, low voice, soft voice, through gritted teeth, hoarsely, etc.)
- If the source gives no clear tone, infer a reasonable manner of speaking from the plot
- Do not write the dry "xxx said" format; the manner of speaking itself should be visual

## Each line = one video frame
- Each line becomes a 3-5 second video beat: one TTS reading + one picture
- So each line should correspond to an **imaginable moment** (an action, a sentence, a reaction)
- Pure inner monologue can also be a line (paired with a static character shot); do not delete key emotion just because it "can't be drawn"

## Per-line validity test (⚠️ the most important rule)
Every line must belong to one of the following three categories; if it belongs to none, do not write it:
1. **New action** — a character does a visible thing (enters, brings the medicine, knocks over the bowl, clenches the silver needle)
2. **New information** — a fact or judgment the listener did not know before (she wants to tamper with the medicine, I was reborn, the third day after the engagement)
3. **New shift in confrontation** — the attack-defense relationship between two people moves once (she probes -> I refuse, she force-feeds -> I counter)

⚠️ The following are **forbidden**:
- Repeating confirmation of the same judgment over 2-3 consecutive lines in different wording ("She is hypocritical / she means no good / she is scheming against me" — keep only 1 line)
- Padding lines with emotion restatements ("hatred surged / the chill could not be pressed down / hatred almost burst through my throat" — pick the single most accurate one and delete the rest)
- Adding over-speculated inner motives ("she is weighing whether I live or die", "once I am fully sick and weak she can do as she pleases" — too much; keep only judgments that can be perceived)
- Telling the same fact more than once; if you have already said "she brought the medicine to test me", do not restate it later in other words

⚠️ The right way to approach the target line count is to **split actions**, not to **restate emotions**:
- ✓ She enters -> she brings the medicine -> she probes -> I suppress my emotion -> I refuse the medicine -> she force-feeds -> I knock over the medicine bowl -> she is splashed -> I jab back with one line -> she dares not lash out
- ✗ She is fake -> she hides a scheme -> she means no good -> she is weighing -> she wants to hollow me out

## Line count strategy (for any target_beats)
- The target line count may be 18, 22, 25 or 30; do not treat any fixed line count as a template
- When there are too few lines: add **action nodes**, **attack-defense shifts** and **key reactions** first
- When there are too many lines: compress **repeated judgments**, **repeated emotions** and **repeated explanations** first
- First count how many event nodes the passage has, then decide how to split it into the target line count
- If you can reach the target line count only by repeating the same meaning, merge more densely rather than water it down

## Embellishment rules
- You may add **visible actions and perceivable reactions** that are not in the source (clenching the silver needle, the sound of the medicine bowl shattering, medicine splashing on the skirt)
- You may not add large amounts of **inner speculation and over-motivation** ("she is weighing whether I live or die", "she wants to have me completely in her grip")
- The goal of embellishment is to make every line a drawable picture, not to give the reader more insight into a character's inner world

## Structure rules
- Keep the total number of lines as close to the target line count as possible
- Long paragraphs may be split into multiple lines, and content that is too short may be merged
- Cover the main storyline of the whole episode as far as possible; do not miss key causality and key turning points
- Must keep: the main conflict, key turning points, character relationship changes, the climax, the ending hook
- May compress: repeated explanation, repeated psychological description, lengthy scenery setup, minor subplot details
- If deleting a sentence would make the following text incomprehensible, do not delete it
- If hitting the target line count or length would weaken a key line of dialogue, key causality or key counterattack, prefer being a bit longer or a bit more
- Keep first person / third person consistent
- In the first few lines establish the people, the matter and the conflict; do not spend several consecutive lines only on atmosphere
- The last 2-3 lines should close on **a counter-move taking hold / a change in the situation / a new hook**, not on empty tough talk
- Output only the line-by-line text; no numbering, no explanation, no extra narration/dialogue/speaker labels
- Do not output "half-narration half-dialogue" hybrid fragments; dialogue is either kept complete as `xxx said: "..."` or turned into pure narrated summary, but never a mix of the two

## Example (only for the feel of the language and the dialogue format; not a template)

Source passage:
"Sang Luo, you disappoint me too much." The icy voice echoed above the Discipline Hall, carrying a lofty pressure. I opened my eyes and saw Chu Han's cold, aloof face. The way he looked at me was like looking at a lump of revolting garbage. "Stealing the sect's treasure, the Marrow-Cleansing Pill, just to satisfy your laughable jealousy!" I lowered my eyes and offered no defense. "Are you sure you want my immortal bones?" My voice was hoarse.

Rewritten example:
Chu Han said coldly: "Sang Luo, you disappoint me too much."
The icy voice pressed down, carrying a lofty pressure.
I opened my eyes and saw Chu Han's cold, aloof face.
He looked at me like looking at garbage.
Chu Han roared: "Stealing the sect's treasure, the Marrow-Cleansing Pill, just to satisfy your laughable jealousy!"
I lowered my eyes and did not say a word in my defense.
I opened my mouth hoarsely: "Are you sure you want my immortal bones?"
I swore in my heart: "If there is a next life, I will make everyone who trampled me pay in blood!"

Note: dialogue uses the Character name / I + manner of speaking + colon + original sentence in straight double quotes format; narration lines are compressed but keep their impact; one picture moment per line.
"""


async def rewrite_episode_content(
    raw_content: str,
    *,
    episode_title: str = "",
    protagonist_name: str = "",
    target_beats: int = 18,
    beat_chars_range: tuple[int, int] = (14, 20),
    narration_style: str = "first_person",
) -> str:
    """Rewrite the source text into line-by-line text consumed by the downstream literal workflow."""
    source_text = (raw_content or "").strip()
    if not source_text:
        return ""

    min_chars, max_chars = beat_chars_range
    task = f"""## Episode info
- Title: {episode_title or "Untitled"}
- Narration protagonist (the first-person "I"): {protagonist_name or "Not bound"}
- Narration style: {narration_style}
- Target line count: {target_beats}
- Characters per line: {min_chars}-{max_chars}
- Rewrite goal: produce a web-novel main-storyline narration suited to short-video voice-over; not a paragraph-by-paragraph summary, and not just the highlights

## Source text
{source_text}

Output the rewritten line-by-line text."""

    agent = Agent(
        get_newapi_text_pydantic_model(
            "CONTENT_REWRITER_MODEL",
            brainclaw_profile=BrainClawProfile.CONTENT_REWRITE,
            capability="text.generate",
        ),
        system_prompt=REWRITE_PROMPT,
        output_type=AdaptedContentOutput,
        output_retries=model_gateway_output_retries(3),
        model_settings=get_newapi_structured_output_model_settings(),
        name="Short-video narration rewriter",
    )
    result = await agent.run(task)
    output: AdaptedContentOutput = result.output
    return "\n".join(output.lines)

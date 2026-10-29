# H3 prompt: schema validation + AI self-review (WIP handoff)

Status 2026-10-29: code committed but **not working end to end yet** — live
`POST .../minimax-h3-prompt/generate` on YuiDrama beat 1 hangs for ~5 minutes and
falls back (see "Open problem"). Everything else in this branch of work
(H3 input modes, in-panel picker, scene fix) is done and verified; see
`.claude/CLAUDE.md`-style notes in the commit messages `e7ab5c9b`, `afb075a8`,
`fcb18731`.

## Goal

Make the rewriter produce a correct, self-consistent H3 prompt by construction:

1. **Pydantic schema constraints** on everything the LLM fills, so a bad answer
   is rejected and sent back to the model as a retry message (same run).
2. **pydantic-ai `output_validator`** for context-dependent rules (`validate_h3_output`).
3. **`self_review` field** — the model must list contradictions with the beat's
   visual description, fix them, and return an empty list.
4. **Independent reviewer pass** (`review_h3_draft`, second agent) that compares
   the draft with the beat's ground truth; findings are fed back for one re-run.

Trigger for this work: with no first frame the rewriter dropped/contradicted the
beat description ("empty bridge" vs "crowd of Edo-period townspeople", invented
camera moves, dropped the phone). A verbatim "Scene premise" line and a
deterministic `description_fidelity_problems` check were added first
(`fcb18731` + earlier edits) and work; this builds the stronger version.

## What is in the working tree (file: `src/novelvideo/agents/minimax_h3_prompt_builder.py`)

- `_check_plain_text` + field validators: no tags / `[Shot N]` / header-looking
  lines / double quotes in any free-text field; no slow words (`slowly`, `gently`,
  ...) in timeline actions. `action` 8–400 chars, `anchor` 3–220, `t >= 0`.
- `MiniMaxH3Content` model validator: timeline strictly increasing; `camera.reason`
  required when not static.
- `MiniMaxH3LLMOutput.self_review` + validator rejecting a non-empty list.
- `validate_h3_output(context, output)` (pure): fidelity problems, `subjects` count
  == references, last timestamp <= clip length, >= 2 timeline entries, "already in
  frame" claim when there is no first frame.
- Agent: `deps_type=MiniMaxH3BeatContext`, `retries=3`, `@agent.output_validator`
  raising `ModelRetry`.
- `review_h3_draft` / `_get_review_agent` (`MiniMaxH3ReviewVerdict`), disabled with
  env `MINIMAX_H3_REVIEW=0`; failure of the review call never blocks generation.
- `build_minimax_h3_prompt`: loop of 2 (main run with `deps`, then reviewer).
- Fallback (`build_fallback_minimax_h3_prompt`) uses `model_construct` so it skips
  the LLM-facing validators; the assembler still sanitizes text.
- Tests: `tests/test_h3_input_modes.py` (schema/validator/fidelity tests),
  `tests/test_minimax_h3_prompt_assembler.py` (dirty-field test now uses
  `model_construct`). 41 pass.

## Update (cloud session, no live LLM access)

Applied without being able to reproduce live (cloud cannot reach the containers),
so the exact failing validator is still unconfirmed. Changes aimed at the likely
suspects and at bounding cost:

- Slow/soft words in timeline `action` no longer fail the schema (style only; the lint still warns).
- Era/setting tag check accepts the unhyphenated form ("Edo period" for "Edo-period").
- Inner `retries` 3 -> 2; outer loop stops immediately on `UnexpectedModelBehavior`
  (falls to the fallback template instead of 3 x 4 calls).
- Output-validator retries are logged (`MiniMax H3 output validator retry N: ...`),
  so the next live run shows which rule fails: `docker logs dramaclaw-api-1 | grep "validator retry"`.
- Still TODO locally: steps 4-5 below (reviewer sanity, live beat 1 re-verify), then deploy.

## Open problem (start here)

Live call on beat 1 (ref2va, no first frame, refs: Yui identity, phone prop,
Nihonbashi Bridge scene) never succeeds. API log:

```
MiniMax H3 prompt LLM attempt 1/3 failed: UnexpectedModelBehavior('Exceeded maximum output retries (3)')
```

i.e. the model keeps violating one of the new validators 4 times in a row, and
the outer 3-attempt fallback loop in `generate_minimax_h3_prompt_with_fallback`
multiplies that (3 x 4 LLM calls, ~5 min, request times out at the client).

Next steps:

1. **Find which validator fails.** Run the debug script below (needs the api
   container's `/data` assets and a working DeepSeek/Qwen route) and read the
   `RetryPromptPart` contents. Likely suspects: the slow-words ban (words like
   "gently"/"slowly" are common), double quotes / apostrophe handling, the
   `self_review` field being filled with non-empty text, `subjects` count, or the
   fidelity check demanding a hyphenated tag the model never writes.
2. **Soften what is not essential.** Keep hard errors for structural problems
   (tags, quotes, ordering, subject count). Make style-only rules (slow words) a
   lint warning, as before, not a retry trigger.
3. **Bound the cost.** The inner `retries=3` x outer `max_llm_attempts=3` is too
   much. Either drop the outer loop to 1 when the failure is
   `UnexpectedModelBehavior` from output retries, or set inner `retries=2` and
   outer 2. Log each retry message (`logging.getLogger(__name__).warning`).
4. **Check the reviewer.** Confirm `review_h3_draft` returns sane verdicts on a
   good draft (`consistent=true`) and on a deliberately contradictory one; make
   sure its extra call is worth the latency (it is skippable via
   `MINIMAX_H3_REVIEW=0`).
5. **Re-verify** with beat 1 (`POST /api/v1/projects/01M5YQ80R0H4DJF6AHDJGMAZQ6/episodes/1/beats/1/minimax-h3-prompt/generate`,
   body `{"h3_mode":"ref2va","h3_first_frame":"none","h3_reference_keys":["identity:Yui_modern_schoolgirl","prop:phone","scene:Nihonbashi Bridge"]}`)
   and with first frame (`{"h3_mode":"auto","h3_first_frame":"render","h3_reference_keys":["identity:Yui_modern_schoolgirl","prop:phone"]}`);
   expect 0 lint errors, crowd/era present, no "empty" claims, finishes in well
   under a minute.
6. Run `.venv/bin/python -m pytest tests -q -k "h3 or video or generation or minimax"`.

### Debug script (run inside the api container)

```python
import asyncio
from pydantic_ai import capture_run_messages
from novelvideo.agents import minimax_h3_prompt_builder as b

base = "/data/output/local/YuiDrama/assets"
ctx = b.MiniMaxH3BeatContext(
    mode="ref2va", has_first_frame=False, duration_seconds=5.2, aspect_ratio="9:16",
    visual_description=("Yui walks into frame from the edge of the shot, holding phone up at "
        "arm's length in a selfie pose, moving through a crowd of Edo-period townspeople and "
        "samurai crossing the wooden bridge."),
    references=[
        b.MiniMaxH3Reference(tag="<Picture 1>", kind="character", name="Yui (modern schoolgirl)",
            image_path=base + "/characters/Yui/identities/modern_schoolgirl.png"),
        b.MiniMaxH3Reference(tag="<Picture 2>", kind="prop", name="phone",
            image_path=base + "/props/phone/reference_3view.png"),
        b.MiniMaxH3Reference(tag="<Picture 3>", kind="scene", name="Nihonbashi Bridge",
            image_path=base + "/scenes/Nihonbashi Bridge/master.png"),
    ],
)

async def main():
    agent = b.get_minimax_h3_prompt_agent()
    with capture_run_messages() as msgs:
        try:
            r = await agent.run([b._build_user_prompt(ctx)], deps=ctx)
            print("OK", r.output.self_review)
        except Exception as e:
            print("FAIL", repr(e)[:200])
    for m in msgs:
        for part in getattr(m, "parts", []):
            if type(part).__name__ == "RetryPromptPart":
                print("RETRY:", str(part.content)[:700])

asyncio.run(main())
```

Copy with `docker cp`, run with `docker exec dramaclaw-api-1 sh -c 'cd /app && .venv/bin/python /tmp/h3dbg.py'`.
A cloud session cannot reach the local containers; there, mock the agent with
`pydantic_ai.models.test.TestModel`/`FunctionModel` and assert on the retry
messages instead.

## Deploy notes (local only)

Per `.claude/CLAUDE.md`: `docker cp src/novelvideo dramaclaw-api-1:/app/src/` then
`docker restart dramaclaw-api-1`; web: `docker compose -f docker-compose.yml build web`
then `docker compose -f docker-compose.release.yml -f docker-compose.web-local.yml up -d web`
and check `api` was not recreated. The local api container currently runs the
failing code above; set `MINIMAX_H3_REVIEW=0` or revert the validators to get
generation working again before using the UI.

## Known limits / other follow-ups

- Multishot and the Segments flow still use the old identity-only reference
  set; only single-beat video uses the new modes/candidates.
- Last frame is only used by first+last mode, not with Reference.
- Panel input choices are persisted only when a prompt/video is generated.
- GPU runs of text-to-video and reference-only (no first frame) were never done
  (RunPod H3 worker needs starting; check `workers.max` first).

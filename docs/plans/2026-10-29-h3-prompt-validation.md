# H3 prompt: schema validation + AI self-review (WIP handoff)

Status 2026-10-29 (updated, local verification done): deployed and verified live.
No more 5-minute hang/timeout. Both test bodies now return `200` well under the
old failure mode:

- ref2va, no first frame (crowd/era case that originally triggered this work):
  **falls back** (`fallback_template` lint warning) but finishes in ~96s and the
  fallback text correctly contains "crowd of Edo-period townspeople and samurai" —
  no more "empty bridge" bug, just not a live self-corrected draft yet.
- auto mode, with first frame: succeeds live (no fallback) in ~19s, only lint
  warning is `long` (length, style-only), crowd/era content present and correct.

Everything else in this branch of work (H3 input modes, in-panel picker, scene
fix) is done and verified; see `.claude/CLAUDE.md`-style notes in the commit
messages `e7ab5c9b`, `afb075a8`, `fcb18731`.

## Verification log (2026-10-29, local)

1. `docker cp src/novelvideo dramaclaw-api-1:/app/src/` + `docker restart dramaclaw-api-1` — healthy after ~6s.
2. Provisioned `DC-video-h3-review-LLM` -> `deepseek-chat` on the existing `DC-deepseek`
   channel via `upsert_channel()` (not the `/custom/newapi/channels` route, per the
   `DC-{provider}` trap in `.claude/CLAUDE.md`). Verified via `build_channel_payload(provider="deepseek", ...)`
   + `upsert_channel`: `ok: True`, `action: update`, `channelId: 2`. Alias count on
   the channel went 22 -> 23 (all prior aliases kept); only `ok`/`action`/`channelId`
   were printed, never the response dict (it carries the plaintext key).
3. Re-ran beat 1 (project `01M5YQ80R0H4DJF6AHDJGMAZQ6`, episode 1, beat 1) with both
   bodies from "Open problem" step 5:
   - ref2va/no-first-frame: `HTTP 200` in 95.8s. Log:
     `MiniMax H3 output validator retry 3: the era/setting tag 'edo-period' is never
     mentioned; ... your text calls the place empty/deserted although the description
     says it is crowded` followed by a single
     `MiniMax H3 prompt LLM attempt 1/3 failed: UnexpectedModelBehavior('Exceeded
     maximum output retries (2)')` — i.e. the outer loop ran **once**, not three
     times (confirms the cost-bounding from the "Update (cloud session)" section
     actually took effect; the old unbounded run from before the restart is still in
     the log a few lines above it, for comparison: three outer attempts x inner
     retries, spanning 23:54-00:06). Result still used the fallback template, but the
     fallback already contains the crowd/era text verbatim from the beat description,
     so the returned prompt is correct; lint has exactly one `warning`/`fallback_template`
     entry, no lint errors.
   - auto/with-first-frame: `HTTP 200` in 18.9s, **no fallback** — the live agent
     output already had the crowd/era content and no "empty" claim. No validator-retry
     or reviewer-contradiction log lines for this call (the reviewer agent ran — it
     adds measurable latency vs. a bare agent call — and returned `consistent=true`
     silently, confirming item 4 of "Open problem": a good draft does get a sane
     `consistent=true` verdict from `review_h3_draft`). Only lint entry is the
     style-only `long` warning.
4. `.venv/bin/python -m pytest tests -q -k "h3 or video or generation or minimax"`:
   **921 passed**, 0 failed.

### What's confirmed vs. still open

- Confirmed: the specific validator that fails live is exactly the one the plan
  suspected (`description_fidelity_problems`'s era-tag/crowd/empty-place check,
  not slow-words/quotes/subject-count). The retry-logging added in the "Update
  (cloud session)" section works and pinpointed it without extra debug scripting.
- Confirmed: the outer-loop cost bound works (1 outer attempt observed instead of
  3x4 calls), so the worst case is now ~96s instead of ~5 minutes / a client timeout.
- Confirmed: the reviewer alias/channel wiring works and the reviewer is silent
  (no contradiction) on a genuinely good draft.
- Still open: the no-first-frame/ref2va case still can't get the *live* agent to
  self-correct within the 2 inner retries for this specific beat — it reaches the
  fallback every time tried so far. This is not a regression (the fallback was
  always the safety net) and it still produces correct content, but it means the
  "self-consistent prompt by construction" goal (vs. "falls back to a correct but
  generic template") isn't fully met for this case.

## Debug-script findings (2026-10-29, local, ran the script from "Open problem")

Ran `agent.run(...)` directly 6x (3 before, 3 after a prompt fix, see below) against
beat 1's exact no-first-frame/ref2va context, capturing every `RetryPromptPart` in
full (not just the one-line retry-message summary). ~1/3 of runs fail even in
isolation — this is inherent model flakiness on this specific beat, not something
introduced by the outer API/fallback plumbing.

### Root cause of the era/crowd validator failures: the reference image and the beat text disagree

Pulled the scene reference (`/data/output/local/YuiDrama/assets/scenes/Nihonbashi
Bridge/master.png`) out of the container and looked at it: it is a completely
**empty** wooden bridge — no people, no crowd, nothing. The beat's text description
says "a crowd of Edo-period townspeople and samurai crossing the wooden bridge."
The vision model is not malfunctioning when it writes "empty bridge" — it is
accurately describing the one image it was told to trust. The *system prompt*
told it to: `_build_agent()`'s system prompt says "Describe what you genuinely see
in those images ... rather than any text hint ... the image always wins if the
two disagree," and rule 7 in `minimax_h3_rules.md` repeats this for identity. That
instruction was written for *character appearance* (don't let a stale
`appearance_details` string override what the portrait actually shows), but
nothing scoped it away from the *Scene* reference, so a thinking-mode model
reading "the image always wins" naturally applies it to the empty bridge plate
too — directly contradicting rule 00's "never empty a place the description says
is crowded."

**Fix applied** (text-only, `src/novelvideo/agents/prompts/minimax_h3_rules.md`,
no code change): added a clause to rule 00 explaining that a Scene reference is
routinely an empty establishing plate (crowds are added later, not baked into the
location plate), that this is expected and not a contradiction, and that rule 7's
"image wins" is scoped to a *character* reference's own appearance only — never a
license to drop a crowd/era/action the Scene image doesn't happen to show.
Deployed via `docker cp` of just that file + `docker restart dramaclaw-api-1`
(loaded from disk at runtime, no Python change, no recreate needed).

**Verification**: ran the debug script 3x before the fix (2/3 succeeded, the 1
failure was a clean two-retry exhaustion repeating the era/crowd complaint
verbatim) and 3x after (2/3 succeeded again) — same success ratio. Sample size is
too small to claim the wording fix measurably changes the failure rate (this beat
seems to fail about 1/3 of the time regardless, consistent with the two live API
calls in the previous section: one fell back, one didn't). The fix is still
worth keeping — it removes a real, demonstrated contradiction in the instructions
the model was given — but it is not a proven fix for the flakiness, just a
plausible contributor removed.

### A separate, more serious failure mode found along the way: catastrophic repetition degeneration

One of the post-fix failing runs did **not** fail on the era/crowd check at all.
The model's response was syntactically broken JSON: `Invalid JSON: EOF while
parsing a string at line 19 column 23848` — the model produced ~24,000 characters
of free-associated word-salad (literally hundreds of comma-separated unrelated
nouns/adjectives, drifting into Chinese mid-sentence) inside what should have been
a short `beats`/`end_state` string, never closing the field, until it hit
`max_tokens` (4000, set in `_build_agent()`'s `model_settings`) and got cut off
mid-token. This is a known LLM pathology (repetition/degeneration collapse),
not a validator or prompt-wording bug — it happened on a request that had already
been retried once for the empty/deserted complaint, which fits the usual trigger
(a model under repeated retry pressure on the same terse instruction occasionally
spirals instead of converging).

This is **not new risk** introduced by this work: the existing retry/fallback
design already catches it cleanly (`UnexpectedModelBehavior` after exhausting
inner retries -> outer loop gives up after 1 attempt -> deterministic fallback
template, same as the clean validator-failure case). Nothing hung, nothing
crashed, the response was still correct-content. It is a new *finding*: part of
the ~1/3 failure rate on this beat is this degeneration, not (only) the
era/crowd disagreement, so softening/removing the era/crowd check alone would not
have gotten this beat to 100% live success anyway.

**Not changed this session** (would need a decision, not just an observation):
whether to raise `max_tokens` further, add an early length-based circuit breaker
to fail fast on an obviously-runaway response instead of waiting for the full
token budget, or vary the retry message between attempts to avoid repeating the
exact same prompt twice (a known way to reduce repetition-trap risk). None of
these were applied — flagging them as the next concrete option if the live
success rate for no-first-frame/ref2va beats needs to go higher than "correct via
fallback within ~100s."

## max_tokens bump + output-token circuit breaker (2026-10-29, same day, later)

Implemented the two items flagged above as "not changed this session" (both in
`src/novelvideo/agents/minimax_h3_prompt_builder.py`, no change to validators/rules):

- **`max_tokens` 4000 -> 6000** on the writer agent (`_build_agent()`). Evidence
  check first: a full successful 2-attempt run measured at only ~1700 output
  tokens total (850/attempt), so legit completions on this beat were never
  actually token-starved at 4000 — the bump is a hedge for a more complex beat
  (more subjects/voices/dialogue) that might need more room than this beat did,
  not a fix proven against this beat's specific failures.
- **Output-token circuit breaker**, via `UsageLimits.output_tokens_limit`
  (pydantic-ai's own `usage_limits=` on `agent.run()`), not a hand-rolled length
  heuristic: `_WRITER_OUTPUT_TOKENS_LIMIT = 5000` on the writer, `_REVIEWER_OUTPUT_TOKENS_LIMIT
  = 2000` on `review_h3_draft`'s call (same mechanism, smaller budget to match its
  1500-token `max_tokens`). Confirmed from pydantic-ai's source
  (`_agent_graph.py`: `_append_response` calls `usage_limits.check_tokens(...)`
  immediately after each response — before any JSON-repair/retry is attempted —
  and `check_before_request` runs again before the next retry is sent) that this
  trips **right after a single oversized response**, not only after accumulating
  several: one response alone ballooning toward the new 6000-token ceiling
  exceeds the 5000 limit and raises `UsageLimitExceeded` immediately, instead of
  pydantic-ai spending 1-2 more retries hoping the model recovers from a
  repetition collapse.
- **Bug caught and fixed while wiring this in**: `UsageLimitExceeded` and
  `UnexpectedModelBehavior` are sibling classes (`pydantic_ai.exceptions
  .AgentRunError`), not parent/child. The outer retry loop in
  `generate_minimax_h3_prompt_with_fallback` only special-cased
  `UnexpectedModelBehavior` for "stop immediately, don't retry the whole outer
  loop." Without also matching `UsageLimitExceeded`, hitting the new breaker
  would have fallen through to `continue` and retried the **entire** outer loop
  up to 2 more times — reintroducing the unbounded-cost problem this whole
  session has been bounding, just via the new exception type. Fixed by matching
  `isinstance(exc, (UnexpectedModelBehavior, UsageLimitExceeded))`.
- Local pytest (`-k "h3 or video or generation or minimax"`): still 921 passed
  after these changes, before deploying.
- Deployed: `docker cp` of just this one file + `docker restart dramaclaw-api-1`.

### Live verification: incomplete — ran out of local NewAPI quota mid-test

Got exactly one live sample with the new settings before hitting
`insufficient_user_quota` (403) on the `DC-video-h3-prompt-LLM` alias — today's
debugging (this session plus the earlier one) burned through the local sandbox's
NewAPI balance. That one sample: succeeded on the **first** attempt (no retry
needed at all), 1067 output tokens, 22s, no sign of degeneration. Too small a
sample (n=1) to say anything about the new failure rate, and no sample at all of
what the circuit breaker does to an actual degenerate run post-fix (the
mechanism is verified correct by reading pydantic-ai's source, not yet observed
live).

**Stopped here rather than resetting quota unilaterally.** Per
`.claude/CLAUDE.md`'s LLM-call-log section, local NewAPI quota is an internal
prepaid ledger backed by real spend through `DEEPSEEK_API_KEY`/`QWEN_API_KEY` —
previous sessions reset it by UPDATE-ing `users.quota` directly via
`newapi_provisioner.open_newapi_db()`, but only after the user explicitly said to
("bỏ qua quota đi, tôi chạy local"). Continuing live verification needs either a
real top-up at `http://127.0.0.1:30000` or that same explicit go-ahead to reset
the local ledger again.

## Live verification, continued (2026-10-29, same day — quota reset by explicit user request)

User said "reset the quota, I'm running local" — reset the local ledger the same
way as the prior documented recovery (`update users set quota = 500000000 where
quota < 500000000` via `newapi_provisioner.open_newapi_db()`; root was at
$0.0017, now ~$1000 of internal ledger). Resumed testing:

- **10 direct `agent.run()` calls** (debug script, bypassing the outer
  fallback loop) against the same beat 1 no-first-frame/ref2va context:
  8 succeeded (3 clean first-attempt, 5 needed exactly one retry and
  recovered), 1 failed cleanly (`UnexpectedModelBehavior`, two consecutive
  era/crowd validator rejections, no garbage), and **1 tripped the new
  circuit breaker live**: `UsageLimitExceeded('Exceeded the output_tokens_limit
  of 5000 (output_tokens=6000)')` after 105.6s — consistent with one normal
  ~25s attempt followed by one ~80s attempt that filled the new 6000-token
  `max_tokens` ceiling (a degenerate response, based on the pattern from the
  earlier finding), caught and stopped immediately rather than being handed to
  pydantic-ai's own JSON-repair retry for a 3rd attempt. Confirms the breaker
  fires on real traffic, not just the hand-analysis of the source code.
  (Note: `capture_run_messages()` doesn't record the message that tripped the
  breaker — `_append_response` in pydantic-ai checks `usage_limits` *before*
  appending to history — so the garbage text itself wasn't recoverable this
  time; not needed, the point was to confirm the trip condition and timing.)
- **3 real end-to-end API calls** (`POST .../minimax-h3-prompt/generate`, same
  beat/body as throughout this doc) to exercise the full route including the
  outer `generate_minimax_h3_prompt_with_fallback` loop and the
  `UsageLimitExceeded`-matches-the-early-break fix: 44.5s / 91.5s / 99.7s, all
  `HTTP 200`. 1 succeeded live (only style lint warnings: `long`,
  `slow_words`), 2 fell back (`fallback_template` warning, correct crowd/era
  content via the deterministic template either way). None of the 3 hit the
  circuit breaker specifically (0 `UsageLimitExceeded` in the API logs for
  these calls) — consistent with the breaker being a low-probability-event
  safety net, not something every call exercises. No call exceeded 100s;
  nothing resembled the old multi-outer-attempt / ~5-minute behavior, so the
  earlier cost-bounding fix plus the new breaker's exception handling didn't
  regress the already-working parts.
- **Unexpected positive finding from the API-call logs**: the independent
  reviewer (`review_h3_draft`) is catching *real*, substantive contradictions
  beyond what the deterministic validator checks for — e.g. (verbatim from the
  logs) "the camera is declared static while Yui walks diagonally across the
  deck," "the draft's crowd is only 'men in dark kimono robes and women in
  colorful garments', dropping the samurai," "Ends: ... the draft freezes the
  crowd" vs. the description having them still crossing. On the call that
  succeeded live, the reviewer flagged 5 such issues on the first draft, the
  agent was given that feedback and got a corrected draft right on its very
  next attempt. This is the two-stage design (schema validators +
  independent reviewer) working as originally intended in the "Goal" section
  at the top of this doc, not just the schema-level checks.
- Local pytest (`-k "h3 or video or generation or minimax"`) re-run after all
  of the above: still **921 passed**.

### Net assessment

The hang/timeout bug from "Open problem" is fixed and stayed fixed under
repeated live load (nothing over 100s across every call made this session).
The `max_tokens` bump plus `UsageLimits` circuit breaker is confirmed working
exactly as designed on real traffic, including catching one live degenerate
run the single most important case it was built for. The reviewer is doing
real, valuable work. What's *not* claimed: a quantified before/after failure
rate for this specific beat — samples across the whole day (debug script and
API, before and after every change) cluster around failing live roughly
1-in-3 to 1-in-2 of the time, with no change large enough relative to that
noise to say definitively "X dropped the rate from A% to B%." What's
different now is *why* it still sometimes fails (era/crowd disagreement
caught by the (now-clarified) validator, or outright model degeneration) is
understood, and *what happens* when it does (bounded cost, correct-content
fallback, no hang) is solid.

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

- Reviewer now uses DeepSeek: env `MINIMAX_H3_REVIEW_MODEL`, default alias
  `DC-video-h3-review-LLM`, plain `output_type` (no NativeOutput). **The alias must be
  provisioned locally** on channel `DC-deepseek` via `upsert_channel()` (not the
  `/custom/newapi/channels` route, see CLAUDE.md); until then the review call fails,
  is logged as "draft review skipped", and generation proceeds without it.

## Next steps on the local machine (in order)

1. `docker cp src/novelvideo dramaclaw-api-1:/app/src/` and `docker restart dramaclaw-api-1`.
2. Provision the reviewer alias: inspect `newapi_provisioner.upsert_channel` signature
   (`inspect.signature`), then call it with `provider:"deepseek"`, keeping all existing
   `DC-deepseek` aliases and adding `DC-video-h3-review-LLM` -> `deepseek-chat`.
   Print only `ok`/`action`/`channelId`, never the response dict (contains the key).
   The cloud session could not do this (DramaClaw API unreachable from cloud).
3. Re-verify beat 1 (both bodies below) and read `docker logs dramaclaw-api-1 | grep -E "validator retry|reviewer|review skipped"`.
4. Run the pytest command in step 6 below.

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

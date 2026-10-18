# Freezone Workflow Creation Stability: Handoff

## Goal

Reduce the Agent's direct generation of the low-level workflow structure, and let tools and the server generate everything that can be determined:

- The Agent supplies only the business goal, story requirements, quantity constraints, and a short task description.
- Tools are responsible for the Schema, Skill identity, Recipe mapping, generation parameters, node stages, and normalization.
- The standard Planner is responsible for standard nodes, edges, layout, and composition structure.
- Only when the user explicitly specifies non-standard canvas nodes and a dependency graph may the Agent submit a custom Plan.

## Reproduction project and symptoms

Project: `test_11`

The chat showed, repeatedly:

```text
Dramaclaw.Freezone Prepare Workflow failed × 4
```

This was not the same error retried at random, but one large custom Plan being patched field by field:

1. Only `generation_answers` was submitted, with no complete `intent` or `plan`.
2. After the Plan was resubmitted, `schema_version` was missing.
3. After another resubmission, `skill` was missing.
4. Three Recipe-driven text execution nodes used the reserved `asset` stage and were recognized as user resource nodes.

At that time the Agent had generated a custom short-drama Plan of about 47 nodes. The root cause was that the Agent instructions routed Beat, shot, and node count requirements to custom topology too early, while the tool Schema exposed the errors one at a time.

## Changes already made

### 1. Deterministic normalization on the tool side

File: `.hermes/plugins/freezone/__init__.py`

Current behavior of `freezone_prepare_workflow`:

- When the Plan lacks `schema_version`, the tool fills in the current version.
- When the Plan lacks `skill.id`, the tool recovers the Skill identity from the admitted `workflow_result` operation.
- Before recovering the identity, the operation's product type and canvas scope are checked.
- If a Recipe-driven `textAnnotationNode` mistakenly carries a reserved `input/resource/asset` stage, the tool removes this system-conflicting field and hands it to the backend to handle according to the Recipe.
- `generation_answers` only supplements a complete Intent/Plan.
- When both Intent and Plan are completely missing, or both are provided, a clear structured error is returned once.
- The internal Schema of the persisted Plan remains strict; only at the tool input boundary are fields relaxed that the operation can uniquely recover.
- A Schema or Skill that is explicitly provided but conflicting is not silently overwritten and is still rejected by the backend.

### 2. Reduce the Agent's generation of raw topology

Modified:

- `src/novelvideo/chat/service.py`
- `src/novelvideo/agent_skills/dramaclaw-workflows/SKILL.md`
- `src/novelvideo/agent_skills/dramaclaw-workflows/references/custom-topology.md`
- `agent-kit/skills/dramaclaw-workflows/SKILL.md`
- `agent-kit/skills/dramaclaw-workflows/references/custom-topology.md`
- `.hermes/skills/workflows/SKILL.md`
- `.hermes/skills/workflows/references/spec.md`

New routing principles:

- Episode count, Beat count, shot count, duration, and delivery quantity are business inputs of the standard Planner.
- These quantity requirements appearing alone no longer trigger the Agent to write a complete node graph.
- Only when the user explicitly asks for specific canvas nodes and specifies dependencies that deviate from the standard template does it enter a custom Plan.
- A custom Plan must carry complete business nodes and edges; the tool is responsible for system identity and normalization.

The Agent protocol version was upgraded step by step from `canvas-workflows-v24` to `canvas-workflows-v26`, to avoid reusing old thread instructions after a restart.

## Security boundaries

The current design should not relax permissions or execution boundaries:

- An operation is still limited to the project, user, and canvas scope.
- Skill identity is recovered only from a `workflow_result` operation.
- Recipes, node types, and edge types still go through allowlists and backend validation.
- Node and edge counts still have upper limits.
- Tool completion does not bypass Draft confirmation or canvas approval.
- The existing confirmation semantics of `run_after_create` are unchanged.
- When the Agent explicitly submits a conflicting identity, it is not automatically rewritten to another Skill.

One point that needs continued review: the tool removing the reserved stage on a Recipe text node is a normalization. Confirm that all standard Planners/Recipes can correctly derive the execution stage from the Recipe catalog; if not, the catalog should return the canonical stage explicitly, rather than relying on derivation after deletion.

## Tests added or updated

The main tests are in:

- `tests/test_freezone_plugin.py`
- `tests/test_workflow_mcp.py`
- `tests/test_chat_service_user_agent_scope.py`

Covered:

- Recovering the Plan Skill identity and version from the operation.
- Automatically filling in the Plan Schema version.
- Cleaning the conflicting stage of Recipe text nodes.
- Returning one clear error only when Intent/Plan is completely missing.
- The Agent Skill/reference explicitly describes the complete Plan fields and the standard Planner routing.
- The new Freezone Agent protocol instructions are injected.

Latest results:

```text
Targeted pytest: passed
ruff: passed
git diff --check: passed
```

The `pytest` executable script in the test environment still carries a shebang pointing at the old directory, so use:

```bash
./.venv/bin/python -m pytest ...
```

## Notes on the current working tree

The working tree has several groups of uncommitted changes, some of which come from earlier fixes for Draft state, task timeouts, and duplicate frontend failure display. Do not reset, checkout, or overwrite unrelated changes.

`.cache/` is an untracked directory and should not be included in the commit for this issue.

Before starting work, run:

```bash
git status --short
git diff --check
```

## Suggested tasks for a new session

A new session should read this file first, then complete the following checks:

1. Review whether the operation identity recovery of `freezone_prepare_workflow` carries risks across projects, across canvases, or with the wrong product type.
2. Confirm that a standard short-drama request goes through the compact Intent/standard Planner under the new instructions, rather than generating a raw Plan of dozens of nodes.
3. Add more direct behavioral tests for "Beat/shot count does not trigger custom topology", instead of only assertions on instruction text.
4. Check whether the standard Planner can express the three-episode outline of `test_11`, 20-25 Beats in episode one, characters/scenes/props, shot groups, video, voice-over, and composition needs.
5. If the standard Planner can express them, add an end-to-end test asserting that the Agent side does not need to submit nodes/edges/stage/skill identity.
6. Run the full related test set, and after restarting the service retest with a new project; do not depend directly on the active thread of the old `test_11`.

## Follow-up remediation results

The following closed-loop remediation has been completed:

- A `workflow_result` operation must now carry a non-empty `canvas_id`, and the canvas is also validated on idempotent reuse.
- The draft API enforces that the operation matches the target canvas, Skill ID, Skill version, and artifact identity.
- For requests that provide an `operation_id`, the Plan tool always validates the operation; it can separately fill in the missing
  `skill.id` and `skill.version`, and an explicit conflict is rejected once.
- When a Recipe text node misuses a reserved stage, it first restores the
  canonical stage from the standard Planner's Recipe catalog; the conflicting stage is removed only when it cannot be uniquely restored.
- The `short-drama-quick` standard Planner supports up to 25 Beats, and deterministically generates story planning,
  character settings and identity images, scene settings and reference images, prop settings and reference images, per-Beat shot design,
  first frames, video, voice-over, background music, and final composition.
- Added a behavioral test for a 25-Beat compact Intent: the Agent input contains no `nodes`/`edges`/`stage` or
  Plan identity structure, the server expands it into 110 nodes, and it passes graph command compilation and the full preflight.
- Related regression tests: `941 passed`; `ruff` and `git diff --check` pass.

## Prompt a new session can use directly

```text
Please first read dc/dramaclaw-ce/docs/freezone-workflow-agent-determinism-handoff.md,
and inspect the existing uncommitted changes without overwriting user modifications. The goal is to have the Agent generate only the business Intent as much as possible,
with tools and the standard Planner deterministically generating the workflow structure. Please review the security boundaries, add behavioral tests,
then verify that the short-drama workflow no longer enters a large raw Plan because of Beat/shot counts.
```

## test_12 voice-over draft repeated-failure remediation

`test_12` exposed a conflict between screenplay-first and draft audio validation: when the short-drama standard Planner
had audio enabled, the old logic required every not-yet-executed Beat to already carry literal `narration` at the draft stage,
causing the Agent to retry the same `planner.units.0.narration` error repeatedly, and finally even bypass the validation by deleting the per-shot
voice-over nodes.

It has now been adjusted as follows:

- `short-drama-quick` may omit not-yet-generated literal narration at the draft stage; the standard Planner keeps the
  `drama-shot-voice` node and uses `prompt_for` to bind the body text at runtime from the upstream shot/script text.
- Literal narration already provided by the user is kept as is; placeholder narration is still rejected. Standard
  Planners that are not screenplay-first still require literal narration, so the relaxation is not widened.
- When a custom short drama explicitly sets `include_audio=true`, the speech node must be kept; leaving only BGM or deleting
  the voice-over to bypass validation is not allowed.
- When the top-level `intent.include_audio` conflicts with `planner.include_audio`, a clear error is returned once, instead of
  silently using the top-level value and then repeatedly reporting "missing narration".
- The Intent Schema is a serialization allowlist; `requires_source_media` in Recipe query results is used only to choose the
  Recipe and plan dependencies, and is not copied into `intent.items[]`. The authoritative value is derived by the server from `recipe_id`.
- The Agent instructions add a same-error-path circuit breaker: resubmitting as is is forbidden; if the same path still fails after one fix, the turn stops.

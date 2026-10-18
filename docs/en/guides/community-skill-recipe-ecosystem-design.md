# DramaClaw 2.0: Community Skill + Recipe Dynamic Workflow Design

> Status: the 2.0 implementation baseline, based on the current `freezone-canvas` code
>
> Design baseline: `bd74b4d` (2026-07-26)
>
> Progress review baseline: `671cb07` (2026-08-02). Of the six items, items 1, 2, 3, and 6 are done, item 4 is partly done, and item 5 is about one third done; items 1 and 3 of the §8.3 wrap-up list are done. Per-item status is in the table in §0.1; measured data is in §2.8.
>
> Basis of this revision: measured statistics of the 5 built-in Skills and 30 built-in Recipes under `src/novelvideo/freezone/agent_catalog/builtins` (see §2.8); a real Flova Skill sample provided by a user; public documentation and public repositories of Flova, Miora, and LibTV (see §5, where LibTV in §5.3 is the closest comparison in form)
>
> Community repository: [dramaclaw-skills](https://github.com/dramaclaw/dramaclaw-skills)

## 0. Implementation guide

**This document is meant for handing off implementation. If you are here to write code, start at this section and follow the path below; do not read from the beginning.**

### 0.1 The six items, on one screen

| # | What to do | Main files | Nature | Depends on | Status (`671cb07`) |
| --- | --- | --- | --- | --- | --- |
| 1 | Write the anchor requirements into the planning pack and Agent rules (**zero Schema change**) | `json_workflow_catalog.py`, `.hermes/skills/workflows/SKILL.md`, `skill-studio-authoring-guide.md`, `src/novelvideo/chat/service.py` | Prompts + tests | none | Done in all four places; **benchmark pass rate not yet measured** (see item 5 of §8.3) |
| 2 | Fix the Skill Studio save contract (remove illegal fields + reuse the existing validator) | `frontend/src/features/superchat/superchat-panel.tsx:3920` | Removal | none | Done |
| 3 | Feed existing Skill constraints into the Recipe Compiler, and fix priority | `recipe_runtime.py` (including the system prompt at line 33), `workflowRecipeRuntime.ts`, the Recipe compile API model, the four node-type compile entry points | Removal + wiring | none | Done |
| 4 | Make `allowed_recipe_ids` a real allowlist | `json_workflow_catalog.py:1982` | Removal (one boolean branch) | none | Mostly changed, but an undesigned `general-*` exception was added, leaving three places semantically inconsistent |
| 5 | Converge built-in Recipes into a shared craft set | `src/novelvideo/freezone/agent_catalog/builtins/` | Content reorganization, about 10-15 files expected | 3 | About one third: of 6 Skills, only lego and pixar are migrated |
| 6 | Change the default strategy to a dynamic WorkflowPlan | `.hermes/skills/workflows/SKILL.md:15` | Removal (one paragraph) | none | Done, and the main path has evolved to intent -> draft (see §3.3) |

Items 1, 2, 4, and 6 can be implemented independently. Item 5 must come after item 3 wires Skill constraints into the Recipe Runtime, and should be owned by someone who understands creative craft to carry out the content reorganization.

**Read these two points before taking over; they are pitfalls added after the review:**

- Item 5 is **not "a few Skills are left to migrate"**; the shared set itself has not yet absorbed enough craft but was already treated as the migration target. Pointing the remaining Skills at it directly would regress the craft, so **the shared set must be thickened before migrating**. The reasoning and evidence are in the "execution order" subsection of item 5 in §8.2;
- Item 4 has already been changed once but produced a new inconsistency. Do not redo it as if it were unstarted; see the status note of item 4 in §8.2.

In one sentence, this overhaul: **use thick Skills to guide the Agent's professional judgment, use a thin Schema to keep dynamic planning room, and use Recipes to reuse craft across Skills.** The six items do three things: connect the constraints that were already written in Skills but never reached the execution layer (item 3, the core); converge the duplicated craft scattered across 30 Recipes into a shared craft set (item 5); and clean up rule drift (items 4 and 6) and one existing bug (item 2). **It is not about adding a creative state machine, but about making the Agent actually consume thick Skills.**

### 0.2 Reading paths by role

**Implementation engineers**: reading these is enough to start:

```text
§0    this section
§8.2  details of the six items (exact files and line numbers, regression test requirements)
§6.1  the boundary between thick Skills, thin Schema, and the anchor rule
§6.2  the node-type filter table for constraint passing + which fields do not go into the Compiler
§6.4  the rule priority chain (the basis for ruling in item 3)
§9    explicitly not doing (to prevent scope creep)
§10   acceptance criteria (self-check list)
```

**Craft / content owners**: the executors of item 5:

```text
§0.1  dependency order (start after 1 and 3 land)
§8.2 item 5  convergence mapping and cleanup list
§2.8  why these 30 are not badly written: the migration mindset; read this section before starting
§3.2  the dividing line between Skill and Recipe + a demonstration split
§6.5  the mapping table for migrating from prose-style Skills
```

Read the following **only when you need to explain the basis of decisions to others**: §1.1 (five architecture claims), §2 (inventory of current code), §4 (why not build a Project Spec), §5 (references and competitors), §11 (final judgment). **These are argument material, not implementation instructions**; you can finish the six items without reading them.

### 0.3 The four easiest pitfalls

1. **Anchor requirements must be issued as planning instructions, not mixed into prose.** Writing the requirement in a Skill's `planning_notes` does not mean the Agent will follow it; the planning pack must present it as an explicit instruction ("you must create an X anchor node and draw a reference edge from it to every Y"). See §6.1 and item 1 of §8.2.
2. **When item 5 deletes stage-advancing instructions from a Recipe, give them a destination**; do not simply delete. Stage order and pause conditions move up to the thick Skill's `planning.conduct_rules`, where Hermes judges them together with the user's authorization for this turn. If they are deleted with no destination, the next author will write them back into the Recipe.
3. **Do not add fields in passing.** §6.1 has a table of "considered but not added", with a threshold where three conditions must all hold: can it be verified deterministically by machine, does an error fail silently, and is the cost expensive. **The overall principle is to drive with prompts as much as possible: use structured fields only where prompts have been proven insufficient, not where they might be insufficient.** Even the anchor-binding field is deferred this round until benchmark data comes out.
4. **Item 5 converges duplication, not thickness, and does not chase a fixed file count.** A thick Skill is correct Agent design: it should fully express style, judgment methods, asset strategy, stage principles, and quality standards. A shared Recipe can also be thick, but it only carries craft reusable across Skills. The acceptance criterion is not exactly 10 files left, but that adding a new style Skill in principle no longer copies a set of Recipes.

### 0.4 Where the tests go

Existing test directories; new regression tests go in the matching place:

```text
Backend   tests/test_freezone_agent_config_store.py      Skill/Recipe storage and Schema
          tests/test_freezone_agent_bundle.py            Bundle validation
          tests/test_api_freezone_agent_bundles.py       Bundle API
          tests/contract/                                 cross-layer contract tests
Frontend  frontend/src/__tests__/features/superchat/     Skill Studio save (item 2)
          frontend/src/__tests__/components/settings/settings-dialog.test.tsx   settings page Schema validation
          frontend/src/__tests__/features/canvas/         canvas and Recipe Runtime
```

The end of each item in §8.2 lists the regression tests that item must add; acceptance criteria are in §10.

## 1. Architecture claims and conclusions

### 1.1 Five architecture claims

This section first states what DramaClaw claims; all later work items exist to honor it, not to catch up with any competitor. Each claim is followed directly by code evidence, or marked "to be honored" with a pointer to the corresponding work item. A claim with neither evidence nor a work item is not included.

**Claim 1: the Graph is the source of truth for creation, not a projection of Agent output.**

So the topology is visible, editable, copyable, and partially re-runnable by the user. Evidence: `duplicateNodes()` at `Canvas.tsx:3202` copies nodes together with the edges whose two ends are both inside the selection, and is wired to the multi-select toolbar's create-copy and clipboard paste. A user can copy an entire Agent-generated workflow, change one parameter, and run a side-by-side comparison. `freezone_run_workflow` supports three scopes: `node` / `downstream` / `connected`. The node-level Action Catalog provides `can_run_now` and `blocked_reasons`.

**Claim 2: a WorkflowPlan is a validatable, approvable Agent artifact, not invisible internal behavior.**

So a graph can be machine-checked and rejected by the user before it is written to the canvas. Evidence: `freezone_workflow_plan.v1` + `validate_agent_workflow_plan()` validate the schema version, node types, duplicate nodes, edge endpoint compatibility, cycles, Recipe existence and version, and reference-media requirements, with an upper limit of 200 nodes / 400 edges; there is a confirmation gate before applying canvas commands. The Graph converted from a Plan is persisted, but the original Plan itself is not currently promised to be replayable or saved as a standalone history record.

**Claim 3: a Skill declares the look-and-feel and boundaries, a Recipe provides reusable craft, and both are structured, validatable data.**

So the community reviews a JSON diff, not an essay. Evidence (partial): `extra="forbid"` on `_CatalogBaseModel` is validated uniformly on the save, load, and Bundle install paths; `dramaclaw.skill-bundle.v1` validates reference integrity and dangerous content.

**To be honored**: Skill already has `planning_notes`, `prompt_guide`, and `conduct_rules` that can carry thick methods, but this content has not yet fully entered the planning and node execution context, and the measured cross-Skill Recipe reuse is 0 (§2.8). This claim is currently a design goal rather than the status quo, to be honored by items 1, 3, and 5 of §8.2. The problem is not a lack of more fields, but that existing content is not fully consumed.

**Claim 4: model capabilities are declared by the system; Skills are unaware of vendors.**

So the same Skill runs on different deployments and model backends, and community Skills do not break because some vendor goes offline. Evidence: the Skill Schema contains no model names; the actual model is decided by internal model names and the NewAPI mapping (§6.4).

**Claim 5: the Agent Runtime depends externally on Hermes; we only build the creative layer.**

So the ReAct loop, Memory, Tool Permission protocol, and Plan/Thought events evolve with Hermes upgrades, and we only maintain the adapter layer and contract tests. Evidence: §2.1.

These five are also the criteria for later requirements. If a new requirement cannot bring the Graph closer to the source of truth, cannot make the Plan more verifiable, or cannot make Skills/Recipes more reusable and reviewable, we do not do it, whether or not competitors have it.

### 1.2 Conclusion

DramaClaw does not need to build a new Agent platform, nor a new dynamic workflow engine.

The current code already has:

- Hermes Agent sessions, Memory, ACP events, and tool permissions;
- Skill Studio to create, modify, and save Skills/Recipes;
- the `freezone_workflow_plan.v1` dynamic plan;
- validation of nodes, edges, cycles, Recipes, and media inputs;
- batch Graph creation after one confirmation;
- parallel node execution by dependency layer;
- Workflow Run, generation history, storyboard view, and video compose nodes.

The current code has also filled in the Skill/Recipe Schema, Skill Studio field saving, Bundle import/export, and the community install entry.

But the measurement of the 30 built-in Recipes (§2.8) overturned an original assumption: the Skill Schema has no fields to carry look-and-feel, asset strategy, or global negative constraints, and authors have manually simulated them with a `*-video-spec` text Recipe plus a runtime relay text node; 17/30 Recipes depend on this chain. The result is that Recipe reuse is exactly 0, and changing the look-and-feel requires copying a whole set of Recipes.

So what the 2.0 main chain needs to complete is six items, in dependency order:

1. Write the anchor requirements into the planning pack and Agent rules, with zero Schema change (§6.1);
2. Fix the save-contract mismatch between Skill Studio and the backend Schema;
3. Pass confirmed inputs and strong Skill constraints into the Recipe Runtime;
4. Make `allowed_recipe_ids` a truly strict allowlist;
5. Converge the 30 built-in Recipes into a shared craft set, initially estimated at about 10-15 files;
6. Switch Hermes' default strategy from "template first" to "Skill-driven dynamic Graph".

Item 3 is a prerequisite of item 5: only once Skill constraints can enter the Recipe Runtime can the duplicated style and stage rules be moved out of Recipes. The other items can proceed independently.

`skillVersion` traceability and Hermes/DramaClaw version convergence are release-quality items; they do not block the dynamic main chain but should be completed before the official 2.0 release.

```text
User selects a Skill
  -> Hermes reads the Skill + Recipe summaries + current canvas
  -> Hermes generates freezone_workflow_plan.v1
  -> existing Validator checks it
  -> user confirms
  -> existing Graph Builder creates nodes and edges
  -> Hermes decides the execution scope by cost, risk, and user authorization
  -> existing Runner executes allowed nodes by dependency
  -> Recipe Runtime generates the actual prompt for each node
  -> Hermes continues, does local rework, or asks for confirmation based on the generated results
```

The core of DramaClaw 2.0 can be summarized as:

```text
Hermes Agent + Skill + Recipe + Dynamic Graph
```

No CreativePlan, Skill Session, or second kind of workflow plan will be added.

## 2. What the current code actually has

### 2.1 Hermes is already the Agent Runtime

The current implementation already uses Hermes as the underlying Agent of the director agent and the Freezone assistant:

- `.hermes-version` pins the Hermes version;
- `src/novelvideo/chat/hermes_pool.py` manages per-user Workers and session recovery;
- Director and Freezone use different Hermes Profiles;
- Freezone sessions are distinguished by user, project, and canvas and reuse Sessions;
- `src/novelvideo/chat/hermes_sdk.py` forwards Plan, Thought, Tool, Permission, and message events;
- `src/novelvideo/chat/hermes_workspace.py` configures Hermes Skills, Plugins, Memory, and NewAPI model routing;
- The Freezone Profile disables Shell and arbitrary file reads/writes and exposes only canvas-related tools.

So DramaClaw does not build its own:

- ReAct loop;
- Agent memory engine;
- multi-agent framework;
- general task planning system;
- Tool Permission protocol;
- Thought/Plan event protocol.

When Hermes updates these capabilities, DramaClaw only upgrades the adapter layer and contract tests.

The Freezone Memory overwrite problem has been fixed: `_ensure_freezone_identity_context()` now writes default content only when the file does not exist, or performs a compatible migration when it detects old default content, and no longer overwrites ordinary memory Hermes has learned.

Only one version-convergence issue remains: `.hermes-version` is already `0.19.0`, but the missing-file fallback in `hermes_pool.py` is still `0.18.0`. Before the official release, `.hermes-version` should become the only version source, to avoid drift in non-Docker installs.

The old user-level `preferences.md` compatibility layer has been removed. Creative preferences and project facts should stay in the project scope, carried by the Agent Memory and sessions inside the project, to avoid cross-contamination between projects such as film, advertising, and e-commerce.

The user-visible change is: the old format `state/<user>/preferences.md` is no longer supported; the runtime will not create, read, inject, or migrate its content, and will not automatically inherit preferences across projects. If a user wants a preference to take effect, they need to restate it in the relevant project or write it into project memory.

The Codex thread rollout lives in the Home Node's shared `CODEX_HOME` and is not naturally deleted with the project directory. Lifecycle operations are therefore fail-closed: deleting a canvas requires successfully archiving that canvas's Codex thread, and permanently purging a project requires successfully deleting the corresponding rollout; when the App Server is unavailable and there are indeed threads pending, the deletion request fails and the canvas/project is kept, to be retried after the runtime recovers. Projects without Codex threads are unaffected.

A Home Node runs only one shared Codex App Server, with no duplicate resident runtimes for Director and Freezone. The two Profiles are isolated through separate workspaces, separate thread/session keys, thread-local MCP environments, short-lived tokens, and an active-turn key carrying `project + canvas + profile`; the native Memory, Plugin, and Multi-agent in the shared `CODEX_HOME` are all turned off to avoid node-level state leaking across Profiles.

### 2.2 Skill Studio can already let users create Skills

Skill Studio and the settings page together currently support:

- creating Skills in natural language;
- summarizing a Skill from the current canvas or selected flow;
- the Agent asking questions step by step;
- generating Skill and Recipe drafts in chunks;
- user edits to drafts;
- saving and re-editing;
- JSON import/export.

Main code:

- Agent authoring rules: `src/novelvideo/chat/service.py`
- Skill Studio tools: `.hermes/plugins/freezone/__init__.py`
- Authoring guide: `.hermes/skills/freezone/references/skill-studio-authoring-guide.md`
- Frontend draft UI: `frontend/src/features/superchat/superchat-panel.tsx`
- Settings page: `frontend/src/components/settings/freezone-skill-recipe-settings.tsx`
- Storage: `src/novelvideo/freezone/agent_config_store.py`

Current storage is still simple JSON under the user directory:

```text
output/{user}/_account/freezone/agent_config/
  skills/{skill_id}.json
  recipes/{recipe_id}.json
```

This structure is enough to support 2.0; there is no need to introduce a database or a new Catalog service right away.

The current contract foundation is done:

- The backend has a unified Pydantic Schema, and save, load, and Bundle install all validate the full Skill/Recipe;
- Skill Studio now preserves `name`, `version`, `allowed_recipe_ids`, `input_parameters`, and `schema_version`;
- The settings page has the corresponding frontend Schema validation;
- Skills and their dependent Recipes can be imported/exported together as a Bundle;
- The normal entry shows only Skills, and Recipes are moved into advanced management.

One real cross-layer bug remains: when Skill Studio saves in normalized form it still writes `default_aspect_ratios` into `planning`, but the backend `AgentCatalogPlanning` does not accept that field and has `extra="forbid"` enabled. That field should also no longer exist in the Skill Schema: aspect ratio is a per-task variable input and should be expressed by the `default` of `input_parameters`. Before saving, Skill Studio should also directly reuse the existing `validateFreezoneAgentConfigPayload()`, to avoid the weak frontend validation and the backend's required fields drifting apart again.

### 2.3 Dynamic WorkflowPlan and the Graph Builder already exist

The current dynamic chain is not conceptual code; it already runs:

```text
freezone_get_workflow_skill(compact=true)
  -> returns Skill, Recipe planning summaries, input_contract, node capability constraints
  -> Hermes generates freezone_workflow_plan.v1
  -> validate_agent_workflow_plan()
  -> freezone_prepare_workflow_plan_draft(plan=...) -> freezone_confirm_workflow_draft(...)
  -> canvas_chat_commands.v1
  -> frontend confirms and writes the Graph
```

Main code:

- Catalog loading and planning pack: `.hermes/plugins/freezone/json_workflow_catalog.py`
- Strict Plan validation: `src/novelvideo/freezone/workflow_plan.py`
- Graph command generation: `.hermes/plugins/freezone/workflow_graph.py`
- Canvas command execution: `frontend/src/features/freezone/canvasChatCommands.ts`

The Validator already checks:

- Schema version;
- maximum node and edge counts;
- node IDs, node types, and duplicate nodes;
- edge types, endpoint compatibility, and cycles;
- whether the Skill and Recipe exist;
- Recipe version and output type;
- whether a Recipe that needs reference media has input.

The Graph Builder can already convert logical node IDs to frontend `client_id`s, and create nodes, edges, groups, layout, and selection state in batch. With `run_after_create=true`, it also appends `run_workflow` in the same approved batch.

So there is no need to build a new Graph Builder, nor to make the Agent create nodes one by one.

### 2.4 The Recipe Runtime is already a real execution layer

A Recipe is currently not a display label. Before a node executes it reads:

- `recipe_id`;
- `recipe_version`;
- node type;
- user goal;
- current node intent;
- upstream text;
- reference media summary.

`src/novelvideo/freezone/recipe_runtime.py` calls the Recipe Compiler through NewAPI and compiles this information into the actual prompt for the corresponding image, video, audio, or text node. The compile results already have an in-memory cache, a persistent cache, and concurrent de-duplication.

The three-layer split itself is right:

```text
Skill: decides which stages and rules this run should have
Recipe: decides how to write the prompt of a stage well
Node capability: actually calls the image, video, audio, or text function
```

The layering brings two real benefits that a Flova-style monolithic Skill does not get, and both are already delivered:

- **Context economy**: `freezone_get_workflow_skill(compact=true)` returns only Recipe summaries during planning, and loads that Recipe's full `system_prompt` only when the node executes;
- **A single stage can be versioned and regression-tested independently**: the storyboard craft can iterate on its own without touching the whole Skill.

Its cost should also be recorded: `_run_recipe_compiler()` is a separate Agent call, so the first execution of a 30-shot comic-drama equals 30 cold compiles, and returning an empty string directly raises `RuntimeError`. This is an extra hop paid by every node; Flova puts the prompt-writing method inside the Skill block and produces it during planning, with no such hop.

This cost **does not need to be optimized on the DramaClaw side**: it belongs to LLM calls and is absorbed by BrainClaw's cheap-first cascade; see the first coordination point in §6.4. We only record that the cost exists here; do not use it as a reason for special optimization in this repository.

But the current dividing line was drawn in the wrong place. The measurement in §2.8 shows that look-and-feel and flow control were cut into Recipes, making reuse exactly 0. The premise of the original argument "Recipes should not be merged back into Skills, otherwise the same storyboard, product-analysis, video-prompt, or voice-over craft would be duplicated in many Skills" has been refuted by the measurement: duplication has already happened, just changed from "written in 5 Skills" to "scattered across 30 files", and the abstraction has realized none of its benefit.

The correct conclusion is: keep the three-layer split, but move look-and-feel, flow order, and asset decisions back up into the Skill per the dividing line in §3.2, so that Recipes can converge into pure craft reusable across Skills.

### 2.5 Graph execution and creative views also have a foundation

The current frontend Runner computes DAG levels from the canvas edges:

- The same level runs in parallel with `Promise.all()`;
- Downstream waits for upstream;
- A failed upstream blocks the related downstream;
- Unrelated branches can continue;
- Execution state is written to Workflow Run;
- Node generation results are written to append-only history saved by `(canvas_id, node_id)`.

The current storyboard view is computed by `assetBoard.ts` directly from Graph nodes and edges; images, videos, audio, and text still use the original nodes' data and operations. `videoComposeNode` already carries the timeline and final-cut composition.

So 2.0 adds no standalone Storyboard database, Asset database, or Timeline source of truth. The Graph remains the creative structure, generation history keeps a node's historical attempts, and the storyboard is just a second view.

There are two more implemented but easily overlooked capabilities. They are direct evidence of Claim 1 (the Graph is the creative source of truth), and before planning new features you should first confirm whether existing capabilities already cover the need:

- **A workflow subgraph can be copied as a whole.** `duplicateNodes()` at `Canvas.tsx:3202` takes the nodes in the selection and also copies the edges whose two ends both fall inside the selection (`internalEdges`), wired to the multi-select toolbar's create-copy and clipboard paste, with collision-avoiding placement. So a user can copy an entire Agent-generated workflow, change just one parameter, and run a side-by-side comparison on the same canvas. **This makes requirements like "project-level branching / time-travel restore" unnecessary in this architecture**: a branch is part of the topology.
- **Node-level history versions can be selected back.** Generation history is stored append-only by `(canvas_id, node_id)`, each record carries that version's own prompt; `NodeGenerationHistory.tsx` already supports clicking a completed history entry to restore that version, with restore semantics held by the host node. So the highest-frequency comparison need, "compare different outputs of the same step", is already covered.

### 2.6 The current code has filled in the node-level action catalog

The latest `freezone-canvas` code not only lets the Agent create a Graph, but also lets the Agent reliably operate existing nodes after the Graph is built:

- `canvas_action_catalog.v1` describes canvas-level generation, editing, analysis, and UI capabilities;
- `freezone_get_node_action_catalog` returns the actions, parameters, and execution modes currently available for a real node;
- Skill node actions return `can_run_now`, `preconditions`, and `blocked_reasons`;
- `freezone_run_node_action` can run one explicit node action;
- `freezone_update_node_data` can modify one node's editable fields;
- `freezone_run_workflow` supports three scopes, `connected`, `downstream`, and `node`, and skips existing results by default;
- The frontend Validator rejects calls where the current node does not exist, the action is unavailable, or the preconditions are not met.

This means "observe the result after execution, then make local changes or rework" already has a real tool foundation, and no new executor needs to be invented.

But this action catalog and the Workflow Skill's planning capability are not at the same level:

- The Workflow Skill Catalog currently exposes only coarse-grained topology capabilities such as `textGeneration`, `imageGeneration`, `videoGeneration`, `audioGeneration`, and `videoCompose`;
- `canvas_action_catalog.v1` describes what a specific node instance can currently do;
- `freezone_workflow_plan.v1` still allows only the existing seven workflow node types, and actions such as crop, outpaint, download, or opening a panel cannot be disguised as new Workflow node types.

2.0 should keep this distinction: use coarse-grained node capabilities when planning, and read the node action catalog on demand during execution and local revision.

### 2.7 A minimal community distribution loop already exists

The current code already implements:

- the `dramaclaw.skill-bundle.v1` Pydantic Schema;
- validation of Skills, Recipes, reference integrity, minimum DramaClaw version, and dangerous content;
- Bundle import, export, and local install;
- fetching from a trusted GitHub Catalog;
- community Skill browsing, installation, and a "My Skills" entry in the settings page;
- backend APIs and regression tests for Bundles and ordinary JSON configuration.

So the community Bundle is no longer a 2.0 P0 that "needs to be added from scratch".

~~The remaining work is mainly release wrap-up: the current package version is still `1.1.2`, while Bundle export defaults to declaring `min_dramaclaw_version=2.0.0`, and after export it is immediately validated against the current package version. Before the version is officially raised to `2.0.0`, this default export path may be rejected by the minimum-version check.~~

**Resolved (`671cb07`)**: the export default has been changed to `current_dramaclaw_version()` (`agent_bundle_store.py:86`), so the `current < minimum` self-check in `_ensure_minimum_dramaclaw_version()` can no longer fail on the default export path. Raising the package version (currently `1.1.5`) to `2.0.0` is now only a release-cadence decision, no longer a bug that rejects exports.

### 2.8 Measured evidence of the Skill constraint-passing gap

The previous sections inventoried "capabilities already present". This section records a fact in the opposite direction: the actual content of the built-in Catalog proves that the constraints of thick Skills did not truly reach the node execution layer, and authors patched it with a clumsy runtime workaround.

Statistics over the 5 Skills and 30 Recipes under `src/novelvideo/freezone/agent_catalog/builtins`:

| Observation | Measured result |
| --- | --- |
| Recipe reuse across Skills | **30 Recipes, 30 references, 0 Recipes shared by two Skills**; each Recipe's id prefix is the single Skill it belongs to |
| Depends on `Final_Video_Spec` | **17 / 30** |
| `system_prompt` directs stage advancement ("after confirmation, enter the [X] stage") | **12 / 30** |
| Each declares its own no-subtitles rule | **8 / 30** |
| Hard-coded resolution values (2K/4K/1080P/720P) | **7 / 30** |
| Explicitly declares character/look consistency | **4 / 30** |
| Hard-coded literal aspect ratio values (16:9, 4:3...) | **3 / 30**: `ling-cage-key-elements`, `ling-cage-video-spec`, `retro-kungfu-video-spec` |
| Correctly consumes `input aspect_ratio` (control group) | 4 / 30 |
| Distinct kinds after de-duplication by craft | 15 (3 of which are the same craft under a different name, see item 5 of §8.2) |

#### Review: `671cb07` (2026-08-02)

The table above is the **design baseline**, kept as is. Re-measurement with the same method:

| Observation | Baseline `bd74b4d` | Review `671cb07` | |
| --- | --- | --- | --- |
| Recipe reuse across Skills | **0 shared** | **4 shared** | Claim 3 begins to be honored |
| Depends on `Final_Video_Spec` | 17 / 30 | **0** | all `*-video-spec` removed |
| `system_prompt` directs stage advancement | 12 / 30 | **3** | the 3 remaining are all in not-yet-migrated Skills |
| Recipes referenced per Skill | 5 ~ 7 | 4 ~ 5 | |

The 4 shared ones are `storyboard-plan` (3 Skills), `video-audio-layer` (3), `visual-key-elements` (2), and `storyboard-shot-video` (2).

**Method note**: the `builtins/recipes/` directory now has 61 files, but 38 of them carry `actionKeys` and belong to the main node-action path, outside the workflow-skill scope of this section. The comparable scope is **30 -> 23 referenced**.

The core problem recorded in this section, "disguising a runtime spec as a Recipe, with downstream reading it by prose convention and zero validation", **has been eliminated**: `confirmed_inputs` and `skill_constraints` are now passed directly into the Recipe Runtime by item 3 of §8.2. The remaining gap is the craft convergence itself, see item 5 of §8.2.

The statistical method needs explaining, otherwise the scale of violations is easily overestimated: "mentions aspect ratio" has 13 files, but most of them are legitimately consuming `input aspect_ratio`, or talk about character body proportions rather than aspect ratio; only 3 actually hard-code a literal aspect ratio value. Character consistency is the same: under the broad scope (including the `Style Lock` field name and generic "unified proportion and lighting") you get 14 files, and under the tightened scope of "specifically character or look consistency" only 4. The conclusions below use only the tightened scope.

`Final_Video_Spec` is not a nonexistent contract. These 4 `output_kind=text` `*-video-spec` Recipes generate a [Global Video Spec] text node, and the downstream 17 Recipes read it through `upstream_text`. Projecting confirmed inputs into readable text is not a problem in itself; the problem is turning it into a new runtime source of truth and making downstream depend on natural-language parsing.

The problem is what this text node actually carries. Take the `must_have_items` of `ling-cage-video-spec` as an example:

```text
[Global Video Spec] · Aspect Ratio · Duration · Frame Rate · Output Language
· Visual Style Lock · Asset Policy · Audio Policy · Global Negatives · Confirmation Needed
```

Ownership item by item:

| Field | Where it should belong |
| --- | --- |
| Aspect Ratio / Duration / Output Language | `input_parameters` (that Recipe even says "Duration uses input total_duration", manually carrying the authoritative value that already exists) |
| Visual Style Lock (semi-realistic 3D CG, post-apocalyptic sci-fi, dirty worn real materials, volumetric light...) | the Skill's look-and-feel declaration; `planning.prompt_guide` already exists |
| Asset Policy (prefer binding user assets, remake only when missing or style-mismatched) | the Skill's asset decisions; `planning.conduct_rules` / `planning_notes` already exist |
| Audio Policy / Global Negatives | Skill strong constraints; `planning.prompt_guide` / `conduct_rules` already exist |
| Trailing "after confirmation, enter the [Storyboard Design] stage" | flow control, belongs to Skill and Agent, not Recipe |

So the conclusion is: **there is no need to add a new kind of Plan.** What is really missing is not fields either: `planning.prompt_guide` and `conduct_rules` can already carry this content; what is missing is the passing path that delivers them to the execution layer (item 3 of §8.2). The consequence of the gap was patched by authors with "one text Recipe + one Recipe compile + one LLM generation + one relay text node + a prose reading convention across 17 Recipes", at four real costs:

1. Every workflow gets one extra node and two LLM calls just to obtain `input_parameters` that should be directly available at zero cost;
2. The spec is natural language, downstream reads it by prose convention, with **zero validation**: if the model omits one field, the 17 downstream Recipes silently degrade with no error at all;
3. The authoritative values of `input_parameters` are manually carried over, so the two places can become inconsistent at any time;
4. Changing the `Visual Style Lock` requires copying the whole `video-spec` Recipe. This is the direct mechanism behind reuse of 0, and the reason community authors must first copy 5~7 Recipes to write a new style.

`pixar-ip-character-design` is a microcosm of the same problem inside a single Recipe: one file mixes three layers:

| Content | Where it belongs |
| --- | --- |
| [Output structure requirements] 7 points, [Quality standards], [Prohibitions] | pure craft, should stay in the Recipe |
| `Style prefix: Pixar 3D cartoon rendering, C4D+Octane texture` | look-and-feel, should move up to `planning.prompt_guide` |
| `Brand elements are handled by the prop anchor stage` | flow division of labor, should move up to `planning.conduct_rules`; currently an oral agreement between two Recipes with no mechanism guaranteeing it |

#### These 30 Recipes are not badly written

Establish the right understanding before migrating, otherwise the migration may breed resentment. These Recipes are **assistants written for a human-driven flow**: before the Agent took over graph building, this production line was where humans built graphs by hand to make real episodes. Humans chose which Recipe for which node, humans ensured cross-shot look consistency, humans judged whether assets were enough, and humans decided whether to add keyframes.

In that mode, none of the current "problems" are problems:

- One private Recipe set per Skill is reasonable, because the user is the author, with no need to reuse across Skills;
- Hard-coding the look into the Recipe is reasonable, because there is no scenario of "reuse the same craft with a different style";
- Writing aspect ratio and resolution into the Recipe is reasonable, because the human knows what is wanted this time;
- It does not matter that `conduct_rules` cannot reach the Compiler, because the human already carried out the intent when choosing the Recipe;
- It does not matter that `allowed_recipe_ids` is not a real allowlist, because nobody would slip and pick an unrelated Recipe.

**The six items are not fixing a bug that has always been broken; they fill the position left empty after humans withdrew from graph building.** So the migration action is "encode the reproducible judgments humans used to make into Skill fields", not "fix the Recipes that predecessors wrote wrong". Subjective judgments (shot count, pacing) are not moved into Skills, and are handed to the fix-in-place route per §3.1.

The corresponding changes are item 3 of §8.2 (really deliver existing fields to the execution layer) and item 5 (craft convergence). Neither needs new Schema fields.

## 3. The exact boundaries of the four concepts in 2.0

### 3.1 Skill: the complete creative method the user selects

A Skill answers:

> How should this kind of work be planned and produced?

For example:

- novel to comic-drama;
- 60-second product advertisement;
- e-commerce main image set;
- character design and three-view sheets;
- MV production.

A Skill contains applicable scenarios, input parameters, allowed Recipes, planning rules, strong constraints, quality standards, and decision boundaries. It can describe typical production stages and their dependencies, but it does not freeze the stages into a template that must be expanded every time, and does not store the node count or final Graph produced by one particular task.

The point of a Skill is not to tell the Agent "always execute these six steps", but to tell the Agent:

- which results must be delivered;
- how to choose the production path when existing assets, model capabilities, and user goals differ;
- which steps can be skipped, merged, parallelized, or started from the middle;
- which operations can advance automatically and which must wait for user confirmation;
- what counts as acceptable, and what local rework is allowed after a failure.

#### What belongs in a Skill and what does not

There is only one positive criterion:

```text
Reproducible, where a different author should get the same answer   -> goes in the Skill
Subjective, where everyone naturally thinks differently             -> not in the Skill; take one of the two paths below
```

Subjective decisions have **two** carrying paths; do not think of only the first:

```text
Path A  human in the loop: put the node into the Agent context, the AI assists the human to modify, then redo the follow-up with direction="downstream"
Path B  batch comparison: generate several candidates at once, and pick the best automatically by the evaluation criteria or let a human pick quickly
```

Path B is easily overlooked, but the capability and fields already exist: image and video nodes support `count = 1 | 2 | 4`, with results stored in `generationBatch` and shown as stacked cards; `quality_threshold`, `rating_bands`, and `visual_review_items` of `evaluation` are the carriers of the selection criteria. What is missing is just connecting the two: §8.4 lists "make `evaluation` actually trigger automatic review and local rework" as P1.

The basis for choosing between the two paths is **whether candidates can be compared side by side**: structural choices like shot count can only take A (Graphs with different counts cannot be viewed side by side); outputs that can be placed side by side, such as the composition of a shot or the look of a character, are faster on B, and are also the precondition for the Agent to advance unattended.

This relates to the product form: with only path A, the Agent must stop and wait for a human at every subjective choice; with path B, the Agent can advance continuously within the authorized scope and concentrate human involvement where a decision is really needed. **Therefore landing P1 `evaluation` is not an optional optimization but the precondition of full-auto capability**; however, it does not block the six main-line items of §8.2, and is still after them in order.

Divided by this criterion:

| Decision | Would a different author differ | Belongs to |
| --- | --- | --- |
| What style this Skill has (semi-realistic 3D CG / Pixar cartoon) | No; this is the Skill's identity | `planning.prompt_guide` |
| Whether character look stays consistent across shots | No; inconsistency is simply wrong | the prompt declares the anchor requirement and the Agent lands it as topology (§6.1) |
| Whether subtitles are allowed | No; a hard prohibition | `planning.conduct_rules` |
| Which semantic role a product image binds to | No; an objective correspondence | the anchor requirement in `planning.planning_notes` |
| Which assets must be confirmed before generation | No; there is an objective dependency order | `planning.conduct_rules` (leave the order to the Agent's understanding, add no field) |
| **How many shots this story should have** | **Yes** | **not in the Skill** |
| **Pacing, how to compose a given shot** | **Yes** | **not in the Skill** |

Writing subjective decisions into a Skill has two harms. First, it freezes personal preference into rules, which is the templating that §3.1 already opposes. Second, the denser the constraints, the smaller the Agent's planning space, and creativity gets squeezed out. **A Skill should declare the non-negotiable parts, then leave creative space open.**

The carrying mechanism for subjective decisions is the existing fix-in-place route, and nothing new needs to be built: put the target node into the Agent context, let the AI assist the human to modify it, then redo from the change point downward with `freezone_run_workflow(direction="downstream")` (§7.3). This route was already proven in production during the manual graph-building stage.

Correspondingly, "validation" of subjective decisions also differs: the reproducible parts rely on automated validation and benchmark regression; the subjective parts rely on a human taking a look and adjusting, and are written into no assertion. The benchmark case set in §8.3 is designed accordingly: it asserts whether the style is locked, whether anchors are bound, and whether prohibitions are obeyed, and **does not assert how many shots there should be**.

### 3.2 Recipe: single-stage craft

A Recipe answers:

> How should the input of one generation stage be turned into a high-quality prompt?

The heading deliberately does not say "internally reused": **cross-Skill reuse is the design goal of this layer, not the current state.** Measured reuse is 0 (§2.8), and the conditions for honoring it are in §11. The definition and the current state must be kept apart, otherwise readers will take the goal for an existing capability.

Recipes continue to use the current Runtime and add no script execution capability. Ordinary users do not need to choose Recipes; Recipe management in the settings page is kept as an advanced feature and a tool for community authors.

The dividing line between Skill and Recipe must be fixed in writing, otherwise the drift of §2.8 will repeat:

```text
Skill   holds: flow order + asset decisions + cross-shot consistency anchors + look-and-feel tone + strong constraints
Recipe  holds: given already-determined inputs, goal, and strong constraints, how to write the prompt of this one node
```

The criterion is one sentence: **what needs to change when you change the look-and-feel or the subject matter belongs to the Skill; writing conventions that apply equally regardless of look-and-feel belong to the Recipe.**

Take `pixar-ip-character-design` as a demonstration split:

| Content in the original Recipe | Where it belongs after migration |
| --- | --- |
| The 7-point structure of [Output structure requirements], [Quality standards], [Prohibitions] | Stays in the Recipe; a character portrait in any style needs this structure |
| `Style prefix: Pixar 3D cartoon rendering, C4D+Octane texture, rounded character modeling` | Moves up to the Skill's `planning.prompt_guide` |
| `All signature accessories must be explicitly mentioned in the prompt` | **Stays in the Recipe**; see the note below, this is the easiest one to misjudge |
| `Brand elements are handled by the prop anchor stage` | Moves up to the Skill's `planning.conduct_rules` |
| `Negative prompt: realistic style, horror, deformation, extra limbs...` | General quality items stay in the Recipe; style-exclusion items (such as `realistic style`) move up to `planning.conduct_rules` |

The third row deserves a separate note, because it looks like a consistency requirement but is not. This Recipe generates **the character portrait itself**, i.e. the anchor image. At the moment the anchor is generated, no reference image exists yet, so "spell out the signature accessories" is a **prompt-completeness requirement**: if it is not written in full, the resulting anchor cannot reproduce itself. And this requirement is independent of style: a character portrait in any style should enumerate its identifying features. So it is general craft and stays in the Recipe.

The real consistency requirement is a different matter: **every later related shot should reuse this anchor image.** The thick Skill asks the Agent to land it as an anchor node and reference edges; a real reference topology is more effective than a sentence saying "stay consistent", but the current Validator does not check character identity semantics (§6.1).

Mixing these two things in one passage is the most common trap of prose-style Skills: prompt completeness when generating the anchor vs. topology binding when using the anchor. They must be handled separately during migration.

After migrating along this line, the same "character portrait Recipe" can be shared by the Pixar, Lego, and Hong Kong cinema Skills; the look-and-feel differences are injected by each Skill's `planning.prompt_guide`, and the cross-shot reference relationships are landed by the Agent under each thick Skill's guidance.

### 3.3 WorkflowPlan: the only structured plan for this task

A task has only one structured plan. Node count, topology, parallel relationships, stage grouping, and asset dependencies are all expressed in it.

**The main path has evolved (`671cb07`).** The original design had the Agent directly produce a full `freezone_workflow_plan.v1`; the current code instead has the Agent produce only a slim intent, which tools deterministically compile into the plan:

```text
Agent produces freezone_workflow_intent.v1        (json_workflow_catalog.py:29)
  -> freezone_prepare_workflow_draft(intent=...)   tool compiles deterministically, returns an exact preview
  -> freezone_patch_workflow_draft(...)            when the user adjusts the plan
  -> freezone_confirm_workflow_draft(...)          writes to the canvas after confirmation
```

The Agent decides only: the user goal, structured inputs, the work/shot PlanItems, the allowed Recipe used by each item, real input dependencies, whether to generate asset anchors, and whether to auto-execute. **Node data, stable IDs, edge types, groups, layout, and final-cut composition are done by tools and not generated by the model.**

This direction is consistent with, and stronger than, Claim 2: the surface the model produces gets smaller, the verifiable structure is generated by deterministic code, and there is less the model can write wrong.

The current state of the two entry points must be spelled out, otherwise the wrong place is easily changed:

| Entry | Current state |
| --- | --- |
| `freezone_prepare/patch/confirm_workflow_draft` | **Main path**; normal planning always goes here |
| `freezone_prepare_workflow_plan_draft(plan=...)` | **Safe custom-topology entry**; after quoting and persisting a preview, creation is uniformly done by `freezone_confirm_workflow_draft` |
| `freezone_build_workflow_plan` | **Must not be called** (see `.hermes/skills/workflows/SKILL.md`) |

`freezone_workflow_plan.v1` and `validate_agent_workflow_plan()` continue to exist, serving the compatibility entry and final structure validation; but **do not treat "let the Agent directly generate a full Plan" as a goal to implement any more**; that route has been downgraded.

The native approval granularity of the current code is "confirm before applying canvas commands", and there is no standalone stage-checkpoint protocol. Stage confirmation is realized jointly by the Skill's execution rules, the plan's node groups, and Hermes' scoped calls to the existing `freezone_run_workflow`; the document must not assume the Validator or Runner natively understands `pause_after`.

No CreativePlan and no standalone Skill Session are added. The intent is the input of the Plan, not a second kind of plan: it is not persisted, does not take part in execution, and is replaced by the compiled result once confirmed.

### 3.4 Node capabilities: the atomic Skills in the current code

The current atomic execution capability has two complementary sources:

- `skill.v1` and `SkillDefinition` in `src/novelvideo/freezone/skill_registry.py`, mainly describing the inputs, outputs, permissions, and project main-line capabilities of runnable Skill nodes;
- The frontend `canvas_action_catalog.v1` and node-level Action Catalog, describing what actions image, video, audio, text, upload, compose, and UI nodes can really execute in their current state.

To avoid confusion with the user-visible Workflow Skill, product documents uniformly call them "node capabilities" or Capability. The former answers "what does this Skill node accept and produce", and the latter answers "what can this real node do now, and are the execution conditions met".

2.0 does not force-merge these two existing protocols and does not change the existing `SkillNode`; it only clarifies their respective boundaries in product language and Agent authoring rules.

## 4. This spec does not need another Project Spec

Flova separates the Prompt, the Final Video Spec, and the Skill, and this product principle is right: the aspect ratio, duration, and language of one task should not be written into a long-lived Skill. [Flova Skill docs](https://www.flova.ai/docs/en/features/skills)

But DramaClaw already has enough ways to carry this:

```text
Skill.input_parameters
  -> freezone_get_workflow_skill().input_contract
  -> input_contract.resolved
  -> WorkflowPlan.inputs
```

So 2.0 adds no `freezone_project_spec.v1`. The user's aspect ratio, duration, language, count, and execution mode for this task are all resolved, defaulted, and confirmed through the existing Input Contract, then written into `WorkflowPlan.inputs`.

For complex Skills such as advertisements and comic-dramas, confirmed inputs can be shown in the existing confirmation UI or the Plan summary. 2.0 does not require creating an extra "creative spec" text node; if a canvas visualization need really appears later, make `WorkflowPlan.inputs` a read-only projection, and it must not become a second source of truth.

If cross-turn persistent saving of the project spec is really needed later, the confirmed values can be written into the existing Canvas metadata; this is still not another kind of Plan.

### 4.1 The half the argument above missed

The judgment above covers only "inputs that vary per task"; this part holds and needs no change. But it missed the other half: **the long-term look-and-feel, asset strategy, and global negative constraints declared by the Skill author had no place in the Schema at the time.**

The measurement in §2.8 shows that authors therefore built one themselves: a `*-video-spec` Recipe generates a [Global Video Spec] text node, with `Visual Style Lock`, `Asset Policy`, `Audio Policy`, and `Global Negatives` written into it, and 17/30 downstream Recipes read it by prose convention. In other words, the conclusion of this section, "no need to create another Project Spec", was not wrong, but because the argument was incomplete, the actual result was **a Project Spec built at runtime out of a text node, with no Schema and no validation**.

The correct home is the Skill's existing `planning.prompt_guide` and `conduct_rules` (§6.1), not a second Plan Schema. Therefore:

- The conclusion of this section is unchanged: **do not add `freezone_project_spec.v1`**, and the corresponding entry in §9 is kept;
- But item 3 of §8.2 must really deliver these existing fields to the execution layer, otherwise authors will keep simulating it with runtime text nodes;
- The 4 `*-video-spec` Recipes are deleted accordingly (item 5 of §8.2); the confirmed spec is kept directly in `WorkflowPlan.inputs` and passed into the Recipe Runtime, and no new frontend or Graph Builder projection mechanism is added this round.

The criterion can be summarized in one sentence: **values that may change on every task go through `input_parameters`; rules the Skill author writes once and reuses across tasks go through the existing `planning`; neither needs a new Plan Schema.**

## 5. References and competitors

This section is not a source of requirements. The basis of judgment is always the five claims of §1.1 and facts about our own code; whether someone else has a feature is not a reason for us to do it or not.

**The three play different roles and must not be read side by side.** The root of the difference is whether their method layer can be obtained:

| Subject | Role | Method layer obtainable? | Practical use for us |
| --- | --- | --- | --- |
| **Flova** (§5.1) | **Reference** | Yes; thorough docs, Skill prompts obtainable | **Craft-layer content can be genuinely learned from**: cinematic prompt rules, shot writing order, and keyframe writing can be used to improve the shared Recipes; the voice-identity mechanism is recorded only as a future product goal |
| **LibTV** (§5.3) | **Competitor** | No; closed source, the cloud Skill Hub is unobtainable | **Can only be benchmarked for positioning and architecture orientation**; the method layer cannot be learned. Its count of 100+ Skills has no craft value for us to borrow |
| **Miora** (§5.2) | Product flow reference | Product descriptions only | Provides only a flow-level reference: "pick a vertical Skill -> describe the Brief -> distill a Skill back from the results" |

This distinction has practical consequences and is not a taxonomy habit:

- When writing shared Recipes (item 5 of §8.2), the craft principles Flova has published are usable reference input;
- LibTV's Skill content can neither be obtained nor should it be reverse-engineered; the only informative thing about it is the architectural choice exposed by its public remote-control package (§5.3);
- **Referring to craft principles and copying Skill content for redistribution are two different things.** The former is normal professional practice; the latter involves source licensing, see the license note in §6.3.

Information boundary: the following comes from each vendor's public documentation, public reporting, and public repositories, plus a real Flova Skill sample provided by a user (truncated). The full rule text of Flova's public Skill gallery could not be obtained, so no assertions are made about the gallery's content; LibTV's cloud Skill Hub content is structurally unavailable because it is closed source, so §5.3 relies only on its public repository, official statements, and third-party hands-on tests, and does not attempt to fill gaps by reverse speculation.

### 5.1 Flova: a reference subject

Flova's role in this document is a **reference** rather than a competitor benchmark: its docs are thorough and its Skill prompts are obtainable, so its craft-layer content can be genuinely learned and absorbed. The block division and craft principles recorded in this section are reference input for the field design in §6.1 and for writing general Recipes in item 5 of §8.2.

Flova's public design shows that a Skill is the Agent's production manual, which users can explicitly select, view, edit, copy, and share. [Flova Skill docs](https://www.flova.ai/docs/en/features/skills)

Its official docs describe a Skill as seven blocks: basic information, workflow planning, media analysis and processing, storyboard design, media generation (model choice, resolution, reference-image usage, continuity rules), prompt writing, and video editing (timeline assembly, pacing, transitions, volume, fades). **The actual rule text of its public Skill gallery could not be obtained, so this section makes no assertions about its specific content.**

A real Flova Skill sample provided by a user shows that its form is numbered prose rather than structured fields, and it explicitly says `complete the task in the following order`, followed by `Step 1 confirm input assets -> Step 2 extract the character anchor (face shape / facial features / hairstyle / clothing / accessories / posture) and set it as the single visual anchor of the whole piece -> Step 3 if it is not a full-body shot, complete a full-body reference first`.

One more place needs a correction of the conservative wording: its project editing docs explicitly state that users **cannot re-run individual workflow items or modify the underlying task topology**; only content inside the existing structure is editable (double-click to edit element/shot/audio descriptions, drag to reorder storyboard cards, drag assets into storyboard categories). So "local rework" in Flova is not a coarser granularity, but a dimension that **does not exist**. This is more fundamental than the earlier description "recovery relies on time-travel and branching", and makes the contrast with Claims 1 and 2 harder.

The fixed order of its Skill is **not in conflict** with the dynamic planning this document advocates, but two levels must be distinguished:

- What Flova fixes is the **decision order of upfront asset preparation**: first confirm assets, then extract anchors, then decide whether to add images. This order really should not change every time;
- What should be dynamic is the **shot topology**: the number of storyboard shots, parallel branches, whether to add keyframes, and which stage to start from.

Neither level needs a new field from us: the order of upfront decisions is written in prose in `planning.planning_notes` and `conduct_rules`, and an Agent reading prose to order things is reliable anyway; the shot topology is decided dynamically by `freezone_workflow_plan.v1` for this task. We once considered adding a `preparation_steps` field for "ordered upfront decisions" and later cut it, for the reasons in the new-field criterion of §6.1.

In comparison, of Flova's seven blocks, only basic information and (a very thin) prompt writing have counterparts with us; storyboard design, media analysis, and continuity rules are squeezed into the Recipe's `system_prompt` on our side (§2.8); the video editing block we deliberately do not build (see below).

#### Flova Agent's actual mechanism

The mechanism recorded in its Agent docs is as follows, used to compare against Claims 1 and 2 of §1.1. [Flova Agent docs](https://www.flova.ai/docs/en/features/agent), [project editing docs](https://www.flova.ai/docs/en/features/project-content-editing)

| Mechanism | Flova | DramaClaw |
| --- | --- | --- |
| Form of the workflow | The Agent internally coordinates 5 modules (Planning / Media Understanding / Storyboard Design / Media Generation / Editing Assembly); the modules are invisible to users, and the docs say users "usually do not need to name these modules" | `freezone_workflow_plan.v1`, a first-class citizen that is validatable, approvable, and archivable (Claim 2) |
| Plan approval | No structured plan approval; execution steps are only shown in the conversation ("Analyzing media", "Creating the storyboard", "Generating shot videos"); to see the plan first you have to ask by prompt | Confirm before applying canvas commands, with the Plan first passing `validate_agent_workflow_plan()` |
| Pre-generation confirmation gate | The docs explicitly say "no pre-generation permission gate exists" | Confirmation by command type and batch scale (§7.5 admits it is not yet a cost-aware risk engine) |
| Single-point failure recovery | The docs record no retry or failure handling protocol; offers Stop, back to this moment, Branch in new project | `freezone_run_workflow(direction="node")` reruns only that node, and downstream continues along the DAG |
| Exploring another direction | Branch in new project, forking the whole project at a message boundary | Box-select a workflow subgraph + create a copy (`duplicateNodes()` copies the internal edges together), running side-by-side comparison on the same canvas |
| Concurrent conflicts | A conflict panel lets the user choose which version to keep | No counterpart; currently single-user, not needed for now |
| Carrying results | Four panels: Storyboard / Media Files / Timeline / Docs, projections written by the Agent | The Graph is the source of truth; the storyboard and timeline are views of the same data (Claim 1) |
| **What users can edit** | **Only content inside the existing structure**: double-click to edit element/shot/audio descriptions, drag to reorder storyboard cards, drag assets to associate categories. Its docs state users **cannot re-run individual workflow items or modify the underlying task topology** | The topology itself is editable: add or delete nodes, change edges, box-select to copy subgraphs, rerun a single node |
| Relationship between manual edits and the Agent | The conflict panel forces a choice between the two; manual edits become the starting point of the Agent's later work ("the Agent will continue from the current project state afterward") | Humans and Agent coexist on the same canvas, with the Graph always the shared source of truth |

Two notes to avoid misreading:

- **"Not documented" does not mean "absent from the implementation".** The table above reflects only its public docs and draws no conclusion about its internal implementation.
- **Branch in new project is not adopted as a benchmark item for us.** It is a compensating design caused by the workflow being invisible: since the user cannot reach the "workflow" itself, exploring another direction can only fork the whole thing. Our workflow is an object that can be box-selected and copied, and branching is naturally part of the topology, so there is no need to fork the project at message boundaries. §8.4 therefore does not keep "Agent message-level restore".

#### Judgment after comparison

Of Flova's seven blocks, only basic information and (a very thin) prompt writing have counterparts with us; storyboard design, media analysis, and continuity rules are squeezed into the Recipe's `system_prompt` on our side (§2.8), which needs fixing; the video editing block is not built, for the reasons in §9.

The reverse comparison confirms three claims hold: the workflow is a first-class citizen rather than internal behavior (Claim 2); **relative to a projection-style architecture like Flova's**, failure recovery goes down to a single node instead of a whole rollback (Claim 1; note that this is not an advantage over LibTV, see §5.3); and the Recipe layer is explicitly denied by its docs, whose original text says no shared modules, inheritance, or cross-Skill composition, with reuse happening only as Skill-level copies. So craft reuse is our structural difference (Claim 3, to be honored).

#### A real sample's confirmation of Claim 3

A complete Flova video production Skill provided by a user is the most concrete evidence for Claim 3. In one prose document it contains at once: stage dependency declarations, confirmation checkpoint policy, asset analysis rules, storyboard design conventions, six cinematic rules for image prompts, keyframe writing, the four-layer order of video prompts, audio prompt rules, editing assembly notes, and concrete model names and resolutions.

Several of these blocks are **general craft independent of subject matter and style**, needed by any film-and-video Skill:

- the six cinematic prompt rules (professional terminology, composition and shot size, lighting and negative fill, restrained color grading, render texture, subtext and micro-expressions);
- the four-layer order of video prompts (shot -> subject -> space -> audio);
- how to write first frames / last frames / highlight frames respectively;
- negative constraints for clean output such as `no music` / `no subtitles`.

**Under a monolithic structure, every Skill must re-include all of these.** This is more convincing than the statistics of the 30 built-in Recipes in §2.8, because it shows duplication is not an implementation problem unique to us, but the inevitable result of monolithic Skills. Putting these into a shared Recipe once, used by all Skills, is exactly the state item 5 of §8.2 aims to reach.

One easily misread point must also be stated: **these Skills are right to be thick; thickness is why they can produce good videos.** A thin Skill that only says "make a Wong Kar-wai style short" would not get such a finished piece; it is the entries specific down to shot size, negative fill, restrained grading, anchor pinning, and parallel batching that lift the Agent's output to a usable level.

So what we want is not thinner Skills, but **the same thickness organized differently**: style identity, asset judgment, stage principles, and consistency methods stay in the thick Skill, craft reusable across subjects sinks into a Recipe written once, and the Agent generates the Graph from the current task. What is opposed is duplicated thickness, not thickness.

The same sample has another mechanism worth recording: it creates an independent voice identity for every character with dialogue and keeps reusing it when generating shots. This product goal is worth keeping, but the audio references of DramaClaw's current VideoNode are mainly soundtrack references, so we cannot claim the voice-identity chain is done; implement it after voice identity / voice clone is truly connected with canvas references.

Its stage dependencies are written in prose (`2->1; 3->1,2; 4->3; ...`). We do not need this notation: the edges of a WorkflowPlan are themselves a DAG, validatable, executable, and visualizable, which is exactly the contrast with Claim 2.

We also record the other designs we do not adopt, and why: a standalone Asset/Media data model, an object-level collaborative conflict system, a new Timeline data center, and model names written into community Skills. For the first three, the current Graph, generation history, Canvas revision, and `videoComposeNode` already cover the needs of the first release, and they should be strengthened only if real use proves them insufficient; the last conflicts directly with Claim 4.

### 5.2 Miora

In the Miora material provided by users, the most important thing is not the UI names but three points:

1. The user first picks a vertical Skill, then describes the Brief;
2. The Agent decides the real nodes and the execution process based on the task;
3. The user can create their own Skill back from satisfying results and processes.

Miora divides memory into project and personal layers, and stresses that Skill, Memory, and the canvas work together. Its team's public statements also stress that Memory and Skill sharing are isolated from each other. [Miora product and team notes](https://www.producthunt.com/products/miora-2?launch=miora-2)

DramaClaw's counterparts:

- Vertical Skills: the existing Skill Studio + `/Skill` selection;
- Dynamic nodes: the existing WorkflowPlan + Graph Builder;
- Distilling from results: the existing "summarize a Skill from the canvas";
- Memory: Hermes Memory;
- Canvas: the Freezone Graph + storyboard view.

There is no need to build another Memory or multi-Agent system just to align with Miora.

### 5.3 LibTV: a competitor, closest in form, opposite in architecture orientation

LibTV's role in this document is a **competitor**, not a reference subject. It is an AI video creation platform released by LiblibAI on March 18, 2026, which released its own video Agent on July 14, 2026, and is the closest to DramaClaw in product form: infinite canvas, node workflows, dual workflow and storyboard views, and a built-in video compose node on the canvas. About forty `libtv` comments in this repository's frontend benchmark its canvas interactions.

**Its method layer is closed source, so this section only benchmarks positioning and architecture and does not learn craft.** The content of the cloud Skill Hub is structurally unavailable, and we do not fill the gap by reverse speculation, which is neither reliable nor necessary. The only usable information in this section comes from three kinds of sources: public repositories, official statements, and third-party hands-on tests.

The nearly identical parts:

| Capability | LibTV Agent | DramaClaw |
| --- | --- | --- |
| Agent automatically creates nodes, edges, fills prompts, generates, composes | Yes | Yes |
| Dual views: workflow view + storyboard view | Yes | Yes |
| Tick the storyboard shots to redo, rerunning only affected downstream nodes | Yes | Yes |
| Stage confirmation + interrupt at any time to adjust direction | Yes | Yes |
| Skill-driven creation | Yes | Yes |

**So "local rework beats whole rollback" is not our advantage over LibTV**; it is common practice among this generation of canvas products, and the advantage only holds when comparing against architectures like Flova's that project results onto panels and can only fork whole at message boundaries. §5.1 has been qualified accordingly.

The parts with opposite architecture orientation are the real differences:

| Dimension | LibTV | DramaClaw |
| --- | --- | --- |
| **Skill form** | MD prose files, guided creation, no machine validation | Structured JSON + `extra="forbid"` three-path validation |
| **Craft reuse layer** | None. Every Skill is self-contained | Recipe (Claim 3, to be honored) |
| **What is opened up** | Only remote control. The public `libtv-labs/libtv-skills` is an API client, and its `SKILL.md` explicitly requires external Agents: "**your role is a porter, not a creator**... do not break down task steps on your own... do not orchestrate shot descriptions on your own"; the creative method stays in the cloud Skill Hub | Opens up the method itself. A Skill Bundle is the creative method, readable, modifiable, reviewable, and self-deployable |
| Execution location | Cloud service, needs ACCESS_KEY | Local Graph + local Runner |
| Models | Bound to its own | NewAPI neutral (Claim 4) |

#### Public numbers usable as a benchmark reference

The end-to-end timings and specs given by third-party hands-on tests can serve as reference magnitudes for the benchmark cases of §8.3 (we have not measured our own corresponding numbers yet):

| Item | Public number |
| --- | --- |
| World Cup themed short, idea to finished piece | 32 minutes |
| Pixar-style animated advertisement | 21 minutes |
| Female-oriented short drama (with optimization) | 2 hours 10 minutes |
| Maximum finished length per project | 5 minutes, with multilingual subtitles and audio-video sync |
| Storyboard shots the Agent generates at once | 7 or more |
| Official Skill count / designers involved | 100+ / 200+ |

Two more capability directions that have been validated are worth recording: **reference-video cloning** (upload a finished video, extract the narrative logic and shot rhythm, then remake it) corresponds to our `videoAnalyzeStory.ts` and `videoStoryNormalizer.ts`, and one sentence can be written in `conduct_rules`: "if the user uploads a reference video, first extract the narrative structure and shot rhythm"; **character consistency anchoring** can be handled by a thick Skill describing how to generate and reuse three-view sheets, clothing, and expression variants, with the Agent then landing the reference topology. Neither currently needs a new Schema field.

#### The creator incentive mechanism, and why we take another path

Its Skill ecosystem is driven by cash: a ten-million-scale incentive pool, with the first round ending August 30, 2026, up to 3,000 yuan per month for qualified creators and 5,000 yuan after unlocking exclusive invitations, stacked with social-media popularity incentives and monthly community awards; Skills need official review and are rewarded by quality tier; once the Skill marketplace is commercialized, revenue is shared continuously by actual usage, with a higher ratio for the first batch of creators.

We do not copy this mechanism; we take **source-available collaboration**: `dramaclaw-skills` is a public repository, Skills are submitted as validatable JSON Bundles, and anyone can review and fork them. The two paths suit different conditions: cash incentives can pile up quantity quickly, but the method stays on a closed platform and authors get revenue shares; source-available collaboration ramps slowly, but the method itself belongs to the community, can be self-deployed, and can be redistributed (subject to the license in §6.3).

This is also why the metric of item 5 in §8.2 is the lifeline of the ecosystem: **without comparable funding, the most effective way to lower the barrier is to make adding a new style or subject Skill require copying no Recipe at all.**

#### Direct evidence for the value of the Recipe layer: a real author's dilemma

A third-party in-depth hands-on report contains a detail more convincing than any inference. The author mentions that `lengyi-shotlist` is a "storyboard Skill" he had **previously published publicly on GitHub**.

Note this wording. In an architecture without a craft-reuse layer, a "storyboard method" can only exist as a **complete Skill**. The author then faces an either-or: use his own storyboard method and give up the platform's director-aesthetics Skill; or use the aesthetics Skill and give up his own storyboard method. To have both, he can only copy a whole Skill and stitch them together by hand.

Under the Skill + Recipe layering this is not a problem: the storyboard craft is a general Recipe, the look-and-feel is injected by each Skill's `planning.prompt_guide`, and the anchor requirements are declared by each Skill's `planning_notes`. The same storyboard Recipe can serve several director styles at once.

The general crafts that can be listed directly from the three hands-on cases are all independent of subject and style, yet must be rewritten in every Skill:

| General craft | Related to style? |
| --- | --- |
| How to organize the anchor list (number + description + key pointing to the actual node) | No |
| Column structure of the storyboard table (shot number / time range / content / referenced anchors / shot language) | No |
| How to generate character three-view sheets | No |
| Producing several moodboard and tonal images for the user to pick one | No |
| Parallel batching strategy (run the first batch first, automatically follow with the second after all complete) | No |
| Narrative beat extraction (split the beats first, then decide the shot count by beats) | No |

**These six are exactly what a shared Recipe should hold.** The shared craft set that item 5 of §8.2 converges covers exactly this kind of content.

#### The value of a structured Skill has concrete failure modes

The same report shows how anchor binding is implemented without a structural layer: the Agent generates two markdown files, one anchor list (each anchor with a number, an appearance description, and a `node_key` pointing to the actual canvas node), and one storyboard table (one column directly states which anchors each shot references, e.g. `A1,A2,A4`). The Agent then connects edges according to this table.

**This mechanism has no validation at all.** If the table says it references A2 but the actual wiring misses A2, nothing reports an error: consistency depends entirely on the model following the table by itself. And the consequence of a missed edge is only discovered after the shots are generated and a human sees the character drift.

This round we also rely on a thick Skill to ask the Agent to connect edges (§6.1), so **we may have this failure mode too**. The difference is that we treat it as a hypothesis to be measured: item 1 of §8.2 and the benchmark evaluation of §8.3 will count the actual failure rate, and only if edges really are missed will we upgrade to a Schema field plus Validator invariant. This is written here to remember that the risk exists, not to claim we have solved it.

Also note the form of that anchor list: **again a runtime markdown file carrying a mapping that should be structured**, exactly the same pattern as `Final_Video_Spec` in §2.8. Wherever a field is missing, authors will certainly fill it with runtime text.

#### External practice confirms that existing fields are enough to carry the first version

Two kinds of information, deliverables and execution mode, appeared in the hands-on tests, but both can be expressed by existing fields and no new block is needed:

- **Deliverables**: its Skill detail page states "what this Skill is good for shooting, what assets it needs, and **what it finally delivers**". Deliverables are indeed first-class information of a Skill, but one sentence in `description` is enough; the Agent judges from it whether to create a compose node, and if it is missed the user can add it with one sentence, which is not worth a field (§6.1).
- **Execution mode**: one item in the Agent's entry questionnaire is "**Execution mode?**", with options like "Fully automatic (I do not take part in intermediate confirmations, output the finished video directly)". This shows it is an **input item per task**, so we carry it with an `execution_mode` entry in `input_parameters`, adding no block (§7.5).

The positions of the two differ slightly, which is worth recording: it asks the user for the execution mode as an input **on every task**; we let the **Skill author declare a default level, overridable by the user's instruction in the current turn** (§7.5). Our approach has one fewer question and makes the same Skill's behavior more predictable, but the user override must always remain effective, otherwise it becomes the author making decisions for the user.

#### 100+ self-contained MD files as scale-level corroboration

LibTV has launched over 100 Skills (Wes Anderson film aesthetics, Pixar animated advertisement, FOST-3D Chinese comic short, etc.), each a self-contained MD file, and its public information shows no cross-Skill reuse unit.

This means that **general craft independent of subject and style**, such as "cinematic prompt rules", "the writing order shot -> subject -> space -> audio", "how to write first and last frames", and "no music / no subtitles", **is written once in each of 100+ MD files**, and changing one entry means changing a hundred files. It also invests a ten-million-scale creator incentive to keep expanding the Skill count, and duplication only grows with scale.

§2.8 argued with the zero reuse of our own 30 built-in Recipes; here we get an external confirmation at a much larger order of magnitude: **duplication is the inevitable result of the monolithic Skill structure, not a team writing badly.** Therefore "how many Recipes does adding a Skill require" (item 5 of §8.2) is not just an engineering metric but an ecosystem metric: it decides whether the author's barrier is "copy five to seven Recipes and reword each one" or "fill in one Skill", directly affecting whether the ecosystem can run on its own without comparable funding incentives.

#### A risk obtained for free from its hands-on report

Public hands-on tests point out a weakness of LibTV: **the production steps are tightly coupled, the earlier stage's output is passed through directly to the later stage, and early errors propagate down the chain**: if the storyboard stage is judged wrong, all later shots go wrong with it.

Our Recipe chain has exactly the same structure: `upstream_text` is passed through all the way down, and an error in an upstream text node contaminates all downstream nodes. This is not copying it, but taking one known risk from its lesson. There are two existing mitigations, both already in this document:

- In the thick Skill's `conduct_rules`, mark error-prone early judgments (storyboard, anchors) as gates that must be confirmed, taking effect together with the current `manual/auto` authorization;
- The risk-driven confirmation of §7.5: waiting for confirmation before batch paid generation, which sits exactly at the point where errors begin to amplify cost.

Note that both are "let a human see it earlier", not automatic error correction. The document does not claim we have solved this problem, and only records that it exists and the current mitigations.

#### Explicitly not doing: no OpenClaw remote-control package

LibTV publishes a client package under the OpenClaw specification so that any compatible Agent can remote-control its cloud service. The OpenClaw ecosystem is not small, but **we do not build a similar package**, because of an architectural conflict and not workload:

Publishing a remote-control package means demoting external Agents to porters and taking creative decisions back to the server, which directly contradicts Claim 1 (the Graph is the local source of truth for creation) and Claim 3 (the creative method is inspectable). The split between the two source-disclosure strategies can be summarized in one sentence: **LibTV publishes client source to protect the cloud-side method, while DramaClaw publishes the method itself, so no client is needed.**

Our unit of distribution is the Skill Bundle, the method itself, rather than an access credential plus an API wrapper.

## 6. Minimal data contracts used by 2.0

### 6.1 Skill

The current backend `AgentCatalogSkillConfig` uses the following minimal contract:

```json
{
  "schema_version": "dramaclaw.workflow-skill.v1",
  "id": "ecommerce-video",
  "name": "E-commerce product video",
  "version": "1.0.0",
  "enabled": true,
  "description": "Dynamically generate an e-commerce video workflow from product assets and marketing goals",
  "category": "ecommerce",
  "triggers": {
    "keywords": ["e-commerce video", "product ad"],
    "node_scopes": ["textGeneration", "imageGeneration", "videoGeneration"]
  },
  "input_parameters": [
    {
      "id": "duration",
      "label": "Target duration",
      "type": "single_select",
      "required": true,
      "default": "30",
      "options": ["15", "30", "60"]
    },
    {
      "id": "execution_mode",
      "label": "Execution mode",
      "type": "single_select",
      "required": false,
      "default": "manual",
      "options": ["manual", "auto"]
    }
  ],
  "allowed_recipe_ids": [
    "product-brief",
    "product-storyboard",
    "product-element-image",
    "product-video-shot"
  ],
  "planning": {
    "planning_notes": "Dynamically decide stages, counts, dependencies, and execution scope from the assets, target duration, model capabilities, and existing nodes. First confirm and bind assets, then extract appearance references; when scene references are missing, create reference images instead of generating from nothing. Prefer building a unified reference image node for the product subject, and connect it to every element image and shot video node that needs to keep the product appearance.",
    "prompt_guide": "Commercial advertising quality, clean studio lighting, high-saturation product colors; highlight real selling points, usage scenarios, and brand tone. Avoid hand-drawn illustration style, low resolution, and deformed product appearance; no subtitles.",
    "conduct_rules": [
      "Reuse qualified existing assets instead of regenerating",
      "Low-cost, reversible text planning may advance automatically; batch paid generation, replacing existing assets, and final composition must be confirmed according to the current authorization",
      "Skip keyframe nodes when the video tool does not need to lock the first frame",
      "Redo only the related nodes after a local failure"
    ]
  },
  "evaluation": {
    "quality_threshold": 8,
    "domain_constraints": ["Do not fabricate product features"],
    "rating_bands": [
      {"score": 8, "description": "Selling points are real, asset binding is correct, structure and execution path are complete"},
      {"score": 5, "description": "Basically usable, but selling points, asset references, or shot structure still need local fixes"}
    ],
    "visual_review_items": [],
    "text_review_items": []
  }
}
```

All fields above are already the contract in use by the current backend and settings page, and **this round adds no new field**. `options` is currently a string array; if a separate user-facing display label is needed, the frontend and backend Schemas should be extended uniformly later, and `{value,label}` must not be used only in the document.

Per-task variable values such as aspect ratio, duration, and language continue to live in `input_parameters`. Do not restore `planning.default_aspect_ratios`, which has been removed from the Agent Tool Schema, or real vendor model preferences.

`workflow_templates` remains compatible with old Skills, but is not a required field of new community Skills and does not decide whether a Skill is shown.

#### Thick Skills decide, the generic Validator guards the baseline

This round leaves creative judgment to the Agent and does not hard-code characters, scenes, props, shot counts, or stage order into the Schema. A thick Skill should fully tell Hermes:

- what content must be judged first and which assets should be reused first;
- which subjects need reference anchors and which downstream nodes should reference them;
- how to keep style, character, and product appearance consistent;
- when stages can be skipped, keyframes added, or local rework done;
- which directional decisions and high-cost operations should ask the user first.

The existing Validator continues to guard only the generic structural baseline: Schema, whether nodes and edges are legal, whether there is a cycle, whether the Recipe exists, and whether media inputs are satisfied. It **does not** understand creative semantics such as "this is the same character" or "this anchor must cover all shots", and should not take on these domain rules before there is real failure data.

Character consistency should still be landed as real topology as much as possible, rather than just writing "stay consistent": Hermes creates character or product reference nodes according to the thick Skill, then connects them to the related image and video nodes. The current code already provides the basic capabilities needed for this topology:

- `REFERENCE_CAPS_BY_MODE.allReference` supports multiple references, and `firstLastFrame` supports first and last frames;
- The image generation submission layer supports the `character` / `style` / `pose` / `generic` reference roles and reference order;
- `VideoNodeData.referenceOrder` supports adjusting the actual submission order of video references.

These capabilities let the Agent **be able to** land a better Graph, but do not mean the runtime already has anchor semantic validation. The focus of 2.0 is to make thick Skills guide the Agent stably; if the benchmarks and real projects prove that a certain kind of missed edge is frequent, silent, and costly, that kind of rule is then upgraded to a structured constraint.

Look-and-feel has to walk on two legs: on first generation there is no reference image yet, so `planning.prompt_guide` locks the style; after a qualified reference image is produced, the Agent then uses it as the actual reference of later nodes. Do not add an `anchors` field in advance to express this method.

#### Declare anchors by prompt; no field this round

**Zero Schema change this round.** Cross-shot visual consistency is achieved by **a thick Skill declaring the method + the Agent landing the topology**, without adding structured fields, and without claiming that the Validator can deterministically prove character consistency.

The way to write it is to explicitly require anchor nodes and reference relationships in `planning.planning_notes` or `conduct_rules`, for example:

```text
Prefer building a unified reference image node for the product subject, and connect it to every element image and shot video node that needs to keep the product appearance;
if the user has already provided a qualified product asset, use that asset directly as the unified reference and do not generate it again.
```

The current physical mechanism is enough to support the image reference topology:

- `REFERENCE_CAPS_BY_MODE.allReference` supports multiple references, and `firstLastFrame` supports first and last frame locking;
- `referenceRoles.ts` defines `ReferenceRole = "character" | "style" | "pose" | "generic"`, marked with `[ref:n=role]`;
- `reorderReferencesByRole()` sorts the character anchor first, because most vendors give higher weight to earlier references;
- `VideoNodeData.referenceOrder` makes the video reference order draggable and decides the actual submission order.

Audio references currently mainly express soundtrack references and cannot be equated with character voice identity. Cross-shot character voice consistency needs a separate voice identity / voice clone chain; until that chain is truly connected with canvas reference semantics, the document does not list "voice anchors" as a capability 2.0 already has.

Multiple looks of the same character (outfit changes, different ages) are simply described separately in the prompt along with which shots each is used for, with no nested structure needed.

#### Why not add an `asset_policy.anchors` field for now

We once considered making anchor binding a structured field `asset_policy.anchors`, paired with a Validator binding invariant: for an anchor declared `required`, the Plan is rejected if a node or reference edge is missing. The reason was that the competitor's similar mechanism has no validation: the Agent generates an anchor list and a storyboard table, one column of the table states which anchors each shot references, then the Agent connects edges by the table, and missing one does not report an error (§5.3).

**This reason is not enough.** It infers "will miss" from "the other side has no validation", not from having observed actual misses; we have no data on what the Agent's failure rate in connecting reference edges is. Adding a field and validation in advance for a possible but unmeasured failure violates the "run the benchmark before deciding" principle that this document insists on elsewhere.

So the order is changed to:

```text
This round   declare anchor requirements by prompt (zero Schema change)
        |
       run the three benchmarks of §8.3 and measure whether the Agent actually misses reference edges
        |
Misses  then add the asset_policy.anchors field + Validator invariant, with data to support it
No miss save one field, one set of validation, and four Schema syncs
```

The benchmark evaluation checks "whether shots that need consistency reference the same reference node", so missed edges can be counted in offline evaluation. It is not a deterministic unit test, nor a runtime safety net; only after a real failure rate is measured do we decide whether to add a validation mechanism.

The cost must be stated: a missed visual reference may cause character or product appearance drift, usually discovered only after generation. This round accepts that risk, reducing its probability with thick Skills, pre-generation confirmation, and benchmark evaluation, instead of adding a creative state machine in advance.

#### The threshold for new fields

This table records fields considered but not added this round, and where each belongs. **Its purpose is to prevent expanding the Schema in passing later**; the criterion is that three conditions hold at once: can it be deterministically validated by machine, does an error fail silently, and is the cost expensive. If they do not all hold, hand it to the Agent through a prompt.

| Field once considered | Why not added | What to use instead |
| --- | --- | --- |
| `asset_policy.anchors` | The failure rate is unmeasured; it would be premature optimization | Prompt declaration + benchmark verification (see the previous section); add it once measurement proves misses |
| `aesthetic.visual_style_lock` | If the style did not enter the prompt, one look at the finished video tells; the error is not silent | The existing `planning.prompt_guide`, whose definition is exactly "how the prompt should be written". The real root cause is not a missing field but a missing passing path (item 3 of §8.2) |
| `aesthetic.global_negatives` | Same as above | `prompt_guide` and `conduct_rules` |
| `preparation_steps` | Ordering is what an LLM does best, and it can follow it when written in prose | One sentence in `planning.planning_notes` or `conduct_rules` |
| `deliverables` | If a compose node is missed, the user adds it with one sentence, so recovery cost is very low | The Skill's `description` already expresses what is delivered, and the Agent judges from it |
| `confirmation_policy` | No new block needed | An `execution_mode` entry in `input_parameters` (see the example above); zero new Schema, goes through the existing `input_contract` path, and is naturally overridden by the user's choice this turn |
| `asset_policy.reuse_rule` / `missing_action` | Reuse and missing-asset policy are judgment questions, and prose is enough | `conduct_rules` |

**Overall principle: drive with prompts as much as possible.** Use structured fields only where "prompts have been proven insufficient", not where "prompts might be insufficient".

### 6.2 Recipe

The current backend `AgentCatalogRecipeConfig` uses the following minimal contract:

```json
{
  "schema_version": "dramaclaw.recipe.v1",
  "id": "product-storyboard",
  "name": "Product ad storyboard",
  "version": "1.0.0",
  "enabled": true,
  "output_kind": "text",
  "action_keys": ["product-storyboard-plan"],
  "requires_source_media": true,
  "planning_prompt": "Generate an ad storyboard from the product brief and reference assets.",
  "result_summary": "Product ad storyboard and shot production plan",
  "must_have_items": ["Product subject", "Usage scenario", "Shot content", "Shot language", "Audio layer", "Brand constraints"],
  "system_prompt": "Guide the current model to convert the user goal, upstream content, and product reference assets into a clearly structured ad storyboard plan. Element images, keyframes, video, and audio prompts are generated by the corresponding Recipes when each node executes."
}
```

A Recipe is still just declarative JSON and prompts, and may not contain Python, JavaScript, Shell, or network requests.

A complex Skill should not, like a monolithic production manual, repeat product analysis, storyboard design, image prompts, video prompts, and audio rules all in one very long `system_prompt`. It should be split by output stage into reusable Recipes, loading the full content of only the current Recipe when a node executes. For example:

```text
Product ad Skill
  |- Product selling-point analysis Recipe (text)
  |- Ad storyboard Recipe (text)
  |- Product and scene element Recipe (image)
  |- Optional keyframe Recipe (image)
  |- Commercial shot Recipe (video)
  `- Voice-over and music design Recipe (audio)
```

A Recipe is not an independent decision-maker, nor an instruction one level above the Skill. It can only convert context into more professional downstream prompts within the inputs, goal, and strong constraints already determined for the current node. A Recipe must not:

- change the aspect ratio, language, duration, brand, or product facts the user has confirmed;
- skip the safety, compliance, asset reference, and quality constraints the Skill requires;
- decide to add, delete, or reconnect WorkflowPlan nodes;
- choose a Recipe outside the Skill's allowlist on its own;
- directly execute node actions, final composition, or model routing.

This list itself is correct, but one thing must be recorded: **built-in Recipes are already violating it, and the current code has no mechanism to stop them.** Measured (§2.8):

- **12/30** direct stage advancement in `system_prompt`; for example `lego-minifig-input-analysis` asks the downstream to output "please confirm whether the input analysis is accurate; after confirmation enter the [Script Outline] stage", violating rule 3;
- **3/30** hard-code literal aspect ratio values and **7/30** hard-code resolution values; for example `ling-cage-key-elements` has `character three-view: 16:9, 2K` and `ling-cage-shot-video` has `fixed 720p`, violating rule 1.

Of these 7 resolution cases, two kinds must be handled: `ling-cage-key-elements`, `ling-cage-shot-video`, and `retro-kungfu-shot-video` hard-code values inside the craft, which are real violations; the `*-video-spec` ones write default declarations like `Resolution defaults to 720p`, which is reasonable behavior but has the wrong ownership: defaults should be expressed by the `default` of `input_parameters`, and move up together with item 5 of §8.2. As a control, `lego-minifig-video-spec` and `retro-kungfu-shot-video` are already correctly consuming `input aspect_ratio`, showing that the correct way is feasible, but nothing mechanically enforces it.

The prohibition is entirely ineffective because it has no enforcement mechanism: `build_recipe_compiler_task()` does not receive `confirmed_inputs`, so it cannot tell whether something conflicts with confirmed values; and the Compiler system prompt marks the Recipe as the highest priority. So this list must be bundled with the mechanism change of item 3 of §8.2, and the existing violating content cleared during the migration of item 5, otherwise it is just text with no binding force.

The current `build_recipe_compiler_task()` at `recipe_runtime.py:209` explicitly receives only the Recipe, node type, node intent, user goal, upstream text, and reference media summary, and receives no Skill `conduct_rules`, quality constraints, or confirmed inputs; and line 33 of its Compiler system prompt says `Follow the Recipe instructions as the highest-priority creative method`.

The consequence of this gap must be stated explicitly; it is not a matter of contract tidiness: **the product path "look-and-feel is controlled by the Skill" is currently broken.** The `conduct_rules`, `prompt_guide`, and `domain_constraints` written by Skill authors are not in the context at all at the moment the node prompt is compiled, while the model is explicitly told the Recipe has the highest priority. So no matter how well the look-and-feel rules in the Skill are written, they take no effect, and the only place where authors can truly influence the output is the Recipe's `system_prompt`, which is exactly why the look-and-feel is hard-coded into private Recipes and reuse drops to zero. This item is the core of the six: the fields exist but cannot be passed down, which is as good as not adding them.

The Recipe Runtime call of 2.0 should carry at least:

```text
skill_id + resolved_skill_version
confirmed_inputs
skill_constraints
recipe_id + recipe_version
node_intent
upstream_text
reference_media
```

Here `skill_constraints` passes only the strong constraints and quality requirements related to the current node, and does not stuff the full Skill, all Recipes, or the whole Graph into the context repeatedly. Its sources are filtered by node type:

| Node type | Skill content to pass in |
| --- | --- |
| Image node | `planning.prompt_guide`, related `conduct_rules`, `evaluation.domain_constraints` |
| Video node | same as the image node |
| Audio node | related `conduct_rules`, `evaluation.domain_constraints` |
| Text node | the text-related parts of `planning.prompt_guide`, `evaluation.domain_constraints` |

All nodes also receive the aspect ratio, duration, and language from `confirmed_inputs`, so the Compiler can reject Recipe instructions that conflict with confirmed values.

**Anchor requirements are not passed to the Compiler.** Note that this does not mean "not entering any LLM context": they enter the **planning-time** context (§7.2) and are consumed by Hermes into topology. Writing them into the node prompt would only make the model recite "the character should be consistent" in the picture, with no anchoring effect.

The two must be kept apart, otherwise implementation easily cuts both with one stroke:

```text
Anchor requirements (written in planning_notes)  -> planning LLM context   must be issued as planning instructions
                                                 -> Recipe Compiler         not passed; writing "character should be consistent" yields just a sentence
planning.prompt_guide / conduct_rules            -> Recipe Compiler         must be passed, otherwise style and constraints cannot enter the prompt
                                                 -> planning LLM context   also needed at planning time, to decide stages and paths
```

What truly guarantees consistency is that the reference edges are actually connected, `[ref:n=character]` is marked correctly, and it is placed first (§6.1). The role marking and ordering of reference images are handled by the frontend at submission and do not go through the Compiler.

### 6.3 Community Bundle

The current code does not use ZIP, a signed package manager, or a private Marketplace. Community distribution uses the already implemented validatable JSON Bundle:

```json
{
  "schema_version": "dramaclaw.skill-bundle.v1",
  "id": "ecommerce-video",
  "name": "E-commerce product video",
  "version": "1.0.0",
  "description": "Dynamically plan and generate e-commerce product videos from product assets.",
  "author": "lywaterman",
  "license": "Apache-2.0",
  "min_dramaclaw_version": "2.0.0",
  "tags": ["ecommerce", "video"],
  "skill": {
    "schema_version": "dramaclaw.workflow-skill.v1",
    "id": "ecommerce-video",
    "name": "E-commerce product video",
    "version": "1.0.0",
    "enabled": true,
    "description": "Dynamically plan and generate e-commerce product videos from product assets.",
    "category": "ecommerce",
    "triggers": {
      "keywords": ["e-commerce video"],
      "node_scopes": ["textGeneration"]
    },
    "input_parameters": [],
    "allowed_recipe_ids": ["product-brief"],
    "planning": {
      "planning_notes": "Dynamically plan production stages from product assets and the user goal; bind the product subject image before entering generation.",
      "prompt_guide": "Commercial advertising quality; express product facts and selling points accurately; no subtitles.",
      "conduct_rules": ["Do not fabricate product capabilities.", "Confirm before batch paid generation and final composition."]
    },
    "evaluation": {
      "rating_bands": [{"score": 5, "description": "Product facts are accurate and the structure is complete"}],
      "quality_threshold": 4,
      "domain_constraints": ["Do not fabricate product capabilities"],
      "visual_review_items": [],
      "text_review_items": []
    },
    "workflow_templates": []
  },
  "recipes": [
    {
      "schema_version": "dramaclaw.recipe.v1",
      "id": "product-brief",
      "name": "Product brief",
      "version": "1.0.0",
      "enabled": true,
      "output_kind": "text",
      "action_keys": ["product-brief"],
      "system_prompt": "Organize user input and product facts into a structured product brief.",
      "must_have_items": ["Product facts", "Target audience", "Core selling points"],
      "planning_prompt": "Generate a product brief from the product assets and the user goal.",
      "result_summary": "Structured product brief.",
      "requires_source_media": false
    }
  ]
}
```

`dramaclaw-skills` can store, for each Skill:

```text
skills/ecommerce-video/
  bundle.json
  README.md
  cover.webp
```

The client can already download `bundle.json` from a trusted GitHub Catalog, and the backend validates the Skill, Recipes, reference integrity, minimum version, and dangerous content before saving. The current implementation does not execute code in the package and does not install extra dependencies.

`license` describes only the license of the prompts, descriptions, and sample assets inside the Bundle, and does not change the Elastic-2.0 license of the DramaClaw core code.

It holds on the premise that the submitter really has the right to re-license under that license. If the Skill content is adapted from a Skill on another platform, you must first confirm that the source allows redistribution, otherwise the `license` field is an empty phrase and the community repository would carry content of unknown origin. Skills distilled from one's own manual graph-building experience do not have this problem, which is also a practical reason to distill the benchmark Skills from our own material first.

The current Runtime looks up Recipes by a single `recipe_id`, so community Skill IDs and Recipe IDs are kept globally unique for now. CI and the install interface reject duplicate IDs from different sources and must not overwrite silently.

### 6.4 Rule priority and model capabilities

Both Skills and Recipes are constraint sources for the Agent, and a stable conflict priority must be defined, to avoid mutual overriding inside a large Skill such as "prefer long takes" vs. "prefer short takes", or "use Chinese prompts" vs. "always use English prompts":

```text
The user's explicit request this time
  > confirmed WorkflowPlan.inputs
  > the Skill's safety, brand, and production strong constraints (evaluation.domain_constraints + conduct_rules)
  > the Skill's planning.prompt_guide (style and prompt-writing)
  > the Recipe's single-stage craft rules
  > system defaults
```

This chain **governs only conflicts at the prompt layer**. The Skill's `prompt_guide` and `conduct_rules` must rank above Recipe craft rules, which is a necessary condition for "look-and-feel is controlled by the Skill". Typical conflicts and rulings:

| Conflict | Ruling |
| --- | --- |
| Recipe `system_prompt` says "realistic style", Skill `prompt_guide` says "Pixar 3D cartoon" | Skill wins |
| Recipe negative words say "no cartoon", Skill `prompt_guide` requires cartoon | Skill wins; that Recipe's negative words are treated as craft defaults |
| Recipe hard-codes `16:9`, `confirmed_inputs.aspect_ratio` is `9:16` | `confirmed_inputs` wins (§6.2 already lists it as a regression test item) |
| Skill `conduct_rules` contains "no subtitles", Recipe requires burned-in subtitles | Skill wins |

Hard prohibitions ("must never appear") are written in `conduct_rules`, which is harder than the style inclination of `prompt_guide`, so it ranks higher.

**Anchor requirements do not take part in this chain**, because they are not node prompt content. Anchors belong to the topology layer: their "execution" is the reference edges really being connected, the role marking being correct, and the ordering being correct, which happens at planning time rather than compile time (the two implementation layers of §6.1).

Community Skills do not write real vendor model names. The 2.0 first release uses only existing node capabilities, generation modes, and system model configuration, such as visual understanding, multiple reference images, first and last frames, target aspect ratio, and audio generation; the actual model is still decided by DramaClaw's internal model names and the NewAPI mapping.

Automatically choosing the upstream model by price, concurrency, and real-time vendor status is a separate model routing capability; DramaClaw 2.0 does not implement it, and it must not be disguised as an existing capability of the community Skill Schema.

#### Ownership boundary of model selection

Claim 4 (Skills are unaware of vendors) is carried by **two different mechanisms**, depending on which kind of model call it is. The two paths must be told apart, otherwise the choice of media models is wrongly pushed onto BrainClaw:

```text
A Skill declares only capability needs and never writes vendor model names
  |
  |- LLM / VLM calls (planning, Recipe compile, text generation, visual understanding)
  |    | NewAPI public model: brainclaw
  |  BrainClaw picks a candidate LLM by (task_class, step_role)
  |    | NewAPI internal candidate model
  |
  `- Image / video / audio generation, Embedding, Reranker, TTS, ASR
       | original NewAPI channel -- the BrainClaw docs state that these requests "never enter BrainClaw"
     DramaClaw's own media model configuration layer decides the backend:
       FREEZONE_DEFAULT_VIDEO_BACKEND / FREEZONE_NEWAPI_VIDEO_BACKENDS
       + GET /projects/{project}/freezone/{video,image}/models delivers candidates
       + the node's model field (videoModelSchema / imageModelSchema of canvasNodeActionCatalog)
```

**BrainClaw handles only LLMs, not media generation models.** So the choice of media models and resolutions such as `Seedance 2.0`, `Nano Banana 2`, `720p`, and `2K` is carried by the media model configuration layer of the second path above, not BrainClaw. The Skill still does not write them; it declares only capability needs such as "needs multiple reference images", "needs first and last frames", and "needs audio generation", which the media model layer maps to currently available backends.

This boundary also decides the division of construction between the two sides: LLM routing should not be rebuilt on the DramaClaw side; the capability table, candidate delivery, and defaults of media models always remain DramaClaw's own responsibility, and do not expect BrainClaw to take them over.

#### Model-specific prompt syntax does not expand the contract for now

Some video models have dedicated prompt encoding conventions, for example parentheses for music, angle brackets for sound effects, curly braces for dialogue, and square brackets for subtitle text. This is the **model's input format**, not a creative method, so:

- **Not in the Skill**: it violates Claim 4, and every Skill would need changing when the model changes;
- **In principle not in a shared Recipe**: a Recipe is general craft reused across Skills, and binding to a single model's syntax would reduce reusability;
- **We also do not claim for now that the node submission layer can convert automatically**: the existing Recipe Compiler returns a plain string with no structured output contract for dialogue, sound effects, and visual descriptions, so the submission layer cannot reliably infer the semantics of each segment.

2.0 first makes Recipes produce model-agnostic, directly executable natural-language prompts. When a backend really needs a dedicated syntax, that media backend's adapter layer does a limited, explicit conversion; only when real needs prove plain strings insufficient is a structured prompt contract introduced.

#### Model capability limits are declared by the system, not repeated by Skills

The maximum duration of a single shot, how many reference images a single call takes at most, and whether first and last frames are supported are all **model capabilities** rather than creative choices. A Skill should not write values like "no shot longer than 15 seconds"; every Skill would need changing when the model changes. Such limits are declared by the media model configuration layer and issued to Hermes as node capability constraints at planning time (the existing `REFERENCE_CAPS_BY_MODE` is an example of this kind of constraint).

Note the two things often mixed in the same sentence: `single shot <= 15s` is a model limit and belongs to the system; `prefer editing inside long takes rather than cutting into many short shots` is this Skill's style inclination and belongs to `planning.conduct_rules`. This is the same kind of error as the "signature accessories" trap in §3.2: one sentence mixes two layers, and they must be separated during migration.

Three coordination points with BrainClaw are recorded here to avoid repeated work later. Note that all three involve only LLM calls:

1. **The extra-hop cost of the Recipe Compiler is absorbed by the BrainClaw cascade.** A separate compile call before each node executes (about 30 cold compiles for the first run of 30 shots) is the inherent cost of layering, and in BrainClaw's classification it is `prompt_composition`: highly structured, the output is just a prompt, and the quality floor is clear, making it the most cost-effective scenario for a cheap-first cascade. Do not do special optimization for this on the DramaClaw side.
2. **`validate_agent_workflow_plan()` can serve as a free scorer for BrainClaw.** BrainClaw's cascade relies on deterministic validators, and the Plan validation has to run anyway: a cheap model produces a Plan -> the Validator judges the structure legal -> only if illegal is it escalated to a strong model, with zero training data and zero quality loss on the contract dimension. This turns our Validator from a purely defensive mechanism into a routing asset.
3. **The cascade only guarantees the Plan runs, not that the Plan is a good Plan.** The Validator checks only structural legality, and both 6 shots and 30 shots will pass. There is no deterministic validator for the soundness of creative decisions, which is still handed to humans and the fix-in-place route per the criterion in §3.1. This boundary must be stated clearly, otherwise it is easy to think that connecting BrainClaw solves topology quality.

For the concrete implementation basis of BrainClaw, see the sibling repository's `brainclaw/docs/brainclaw-end-to-end-plan.md`; no cross-repository relative link is used here, to avoid broken GitHub document links.

### 6.5 Mapping table for migrating from prose-style Skills

Professional authors may take a mature prose-style Skill from another platform as a starting point for adaptation. This is a **format migration plus a layered reorganization**, not copy-and-paste: the other side is one passage of numbered prose, while ours are structured fields split by implementation layer. Without a mapping table, the most common failure is stuffing the whole passage of prose into `planning_notes`, leaving the fields effectively unfilled.

Take Flova's seven blocks (the block division published in its official docs) as an example:

| Source block | Where it lands | Note |
| --- | --- | --- |
| 1 Basic information | `name` / `description` / `category` / `triggers` | Direct mapping |
| 2 Workflow planning (execution order, tool calls, step dependencies) | All into the prose of `planning.planning_notes` and `conduct_rules`: leave the order to the Agent's understanding, and do not create a field for it | **Do not** convert it into `workflow_templates`, which would regress to templating (§7.3) |
| 3 Media analysis and processing | Characters and scenes that must be anchored, reuse and missing-asset policy -> `planning_notes` / `conduct_rules`; extraction craft -> a general `input-analysis` Recipe | "Which subjects must stay consistent across shots" must be written as explicit anchor and reference requirements, not just "stay consistent" |
| 4 Storyboard design | Storyboard structure and required items -> `must_have_items` of a general `storyboard` Recipe; whether shot size / camera position / camera movement are mandatory -> `conduct_rules` | How many shots to shoot is a subjective decision and is **not migrated** (§3.1) |
| 5 Media generation | Style lock -> `planning.prompt_guide`; visual consistency method and reference reuse requirements -> `planning_notes`; aspect ratio / duration -> `input_parameters` | **Model names and resolutions are dropped**: media models are decided by DramaClaw's media model configuration layer, not BrainClaw (§6.4); the thick Skill must explicitly tell the Agent how to build and reuse the reference topology |
| 6 Prompt writing | The general Recipe's `system_prompt`; cross-stage expression inclinations -> `planning.prompt_guide` | Do not copy a Recipe into every Skill, otherwise reuse of 0 repeats (§2.8) |
| 7 Video editing | **Dropped** | Reasons in §9 |
| "What is produced / what is finally delivered" | One sentence in `description` is enough | No field is added for it: if the compose node is missed, the user can add it with one sentence (§6.1) |
| "When to ask you / when to stop and confirm" | `planning.conduct_rules`, combined with the existing `execution_mode=manual/auto` | The user's authorization this turn can override the default. **Do not write it into a Recipe**; that is exactly the disease 12/30 Recipes have now |

The last two rows come from the closing sections common in prose-style Skills (for example "what is produced: the finished video, with script and storyboard" and "when to ask you: ask once if unsure about subject or style, decide the rest yourself"). Neither needs a new field: deliverables go into `description`, basic Manual/Auto goes through `input_parameters`, and finer confirmation principles go into the thick Skill's `conduct_rules`.

During migration, make three judgments in order, and the order must not be reversed:

1. **Reproducible or subjective?** Drop the subjective directly; it does not enter the Skill (§3.1).
2. **Topology action or node prompt?** What requires building reference nodes and edges is written into the thick Skill's `planning_notes` / `conduct_rules` for Hermes to land as a Graph; visual style and negative constraints go into the Recipe Compiler (§6.1).
3. **Skill or Recipe?** What must change when the style changes goes into the Skill; writing conventions applicable to any style stay in the Recipe (§3.2).

For the license note, see §6.3: before redistributing adapted content from someone else's Skill, confirm that the source allows re-licensing.

## 7. Runtime rules of 2.0

### 7.1 The user explicitly selects a Skill

In most cases the user selects a Skill from the UI or via `/skill-id`. Once there is a `skill_id`, Hermes reads that Skill directly and must not automatically switch to another Skill.

When the user has not selected one, the existing `freezone_resolve_catalog_workflow` can be used to recommend; when several candidates are close, let the user choose, and do not automatically take the first.

#### A single entry questionnaire: ask everything at once, not while doing

After a Skill is selected, **merge all uncertain items into one questionnaire** before starting execution, rather than interrupting repeatedly during production. Third-party hands-on tests show this pattern works very well in practice: the Agent lists six items to confirm up front (duration preference, execution mode, aspect ratio, language and subtitles, core elements, source of the story outline), and after the user replies in turn it enters continuous execution.

Our mechanism is already complete and only lacks this convention: `input_parameters` -> `freezone_get_workflow_skill().input_contract` -> `input_contract.resolved` is already what computes the missing items in one go (§6.1, §7.2). The implementation requirements are therefore:

- Hermes should raise all missing items at once based on `input_contract.missing_required`, rather than asking one as it finds each;
- `execution_mode` is also confirmed in this round (corresponding to the "execution mode" item in the hands-on test), and the user's choice here overrides the default declared by the Skill (§7.5);
- Parameters that already have defaults and do not affect cost or irreversible operations need not be asked; use the value in `resolved` directly and show it in the plan, so the user can veto it instead of being forced to answer.

The value of this convention is concentrating interruptions before the start. Pauses during production are decided by the risk-driven confirmation of §7.5, which is a different matter from the entry questionnaire; do not mix them.

### 7.2 Load only the necessary context

Keep using the current progressive loading:

```text
Skill list: load only ID, name, description, and trigger words
Selected Skill: freezone_get_workflow_skill(compact=true)
Planning stage: the full Skill (including the anchor requirements in planning_notes) + allowlisted Recipe summaries
Executing a node: that Recipe's full system_prompt + skill_constraints filtered by node type + confirmed_inputs
Creating nodes: read the node create schema on demand
```

Do not stuff all Recipes, all node Schemas, the whole generation history, or the full canvas into Hermes at once. When executing a node, do not pass the full Skill either: `prompt_guide` and `conduct_rules` are filtered by the node-type table of §6.2, and the anchor and flow-type requirements in them do not enter the Compiler context at all.

### 7.3 The dynamic Plan is the default path

For new Workflow Skills:

- Hermes generates the full WorkflowPlan from the user goal, `input_contract.resolved`, the current selection, the neighbor Graph, and existing assets;
- Shot count, parallel branches, starting stage, and dependencies are decided by this task;
- The Skill specifies production boundaries and decision rules, and typical stages must not be mistaken for a fixed template that must always be fully expanded;
- When qualified intermediate assets already exist, starting from an intermediate stage is allowed;
- First complete the upfront asset decisions: confirm assets, build references, and judge gaps according to the principles described in `planning_notes` and `conduct_rules`;
- User-uploaded assets are bound as Graph inputs according to the semantic roles described by the thick Skill; whether to reuse or remake and how to handle missing ones is judged by Hermes with `conduct_rules`;
- The Skill must state which subjects need a unified reference and which downstream nodes should reuse it; Hermes generates reference nodes and reference edges accordingly, while the current Validator only checks generic Graph legality and does not understand character identity semantics (§6.1);
- When the model supports generating video directly from multiple reference images, keyframes can be omitted; keyframe nodes are added dynamically only when the first frame needs locking;
- When required assets are missing, first create asset anchors or ask the user;
- First call `freezone_prepare_workflow_plan_draft(plan=...)` once, and after the user confirms the exact preview, call `freezone_confirm_workflow_draft`;
- **Layout carries semantics**: anchor nodes go on the left upstream, storyboard and generation nodes in the middle, and compose nodes on the right, so people can see at a glance how far the project has progressed. The Graph Builder already supports batch layout and grouping; this is a zero-cost planning convention, not a new mechanism. Similar products make it an explicit design principle (character definitions on the left, storyboard in the middle, final cut on the right), because the spatial position on the canvas is itself the most intuitive status display.

Fixed templates are kept only for existing simple registered workflows such as text-to-image and image-to-video, and for compatibility with old Skills. Templates are not the default execution method of new community Skills.

**The topology the Agent produces is a proposal, not a decision.** Subjective decisions such as shot count and pacing are not dictated by the Skill (§3.1); the Agent can only derive a starting point from the target duration, the story content, and cost constraints. This starting point inevitably needs human adjustment, and the convergence mechanism is the fix-in-place route below. So "the Skill does not control shot count" does not mean "nobody is responsible for the topology": the human is responsible, and the Agent is responsible for giving a reasonable starting point and correctly redoing the downstream after the human finishes editing.

A Graph is also not an immutable final plan once created. Hermes can add or delete nodes, adjust dependencies, or rerun only failed branches in a local subgraph based on actual results; unless the user explicitly asks to re-plan the overall direction, the whole Graph should not be thrown away because one node failed.

When performing local operations on existing nodes, Hermes should first read the node's Action Catalog:

- When `can_run_now=false`, complete the upstream inputs according to `blocked_reasons`, or stop;
- Use `freezone_run_node_action` for single-node generation, editing, analysis, or UI operations;
- Use `freezone_update_node_data` to modify node parameters;
- Use `freezone_run_workflow(direction="node")` to retry only one failed node;
- Use `freezone_run_workflow(direction="downstream")` to redo the follow-up from the modification point;
- Use `freezone_run_workflow(direction="connected")` or `scope="canvas"` to continue the full workflow.

### 7.4 Recipes are a strict allowlist

The target rule is: whenever a Skill declares `allowed_recipe_ids`:

- `freezone_get_workflow_skill` returns only the summaries of these Recipes;
- The Validator allows only these Recipes;
- Other Recipes of the same `output_kind` cannot be added to the candidates automatically.

This both improves planning stability and forms the permission boundary of community Skills.

The current code does not fully satisfy this rule yet. `_workflow_skill_recipe_candidates()` adds explicitly referenced Recipes to the candidates and also continues to add other Recipes with the same `output_kind`. So the "allowed set" used by the planning pack and the Validator is still too wide. 2.0 must change this to:

```text
allowed_recipe_ids non-empty
  -> only Recipes in the list are allowed

old Skill without allowed_recipe_ids
  -> only then use template references and output_kind inference for compatibility
```

### 7.5 Use risk-driven confirmation and the existing executor

No new executor is added:

1. Hermes shows a readable plan;
2. The user confirms the overall direction and the execution authorization for this run;
3. The Graph Builder creates the Graph in one go;
4. Hermes decides, based on cost, risk, and user authorization, whether to only lay out the graph, execute some nodes, or execute immediately;
5. The Runner executes the currently allowed scope by the existing DAG rules;
6. The Recipe Runtime compiles prompts for each node;
7. Hermes checks the results and decides whether to continue, do local rework, or request the next confirmation;
8. Workflow Run and generation history record the results.

Confirmation is not hard-coded as "pause at every stage", but decided by operation risk:

- Low-cost, reversible text analysis and planning can execute automatically;
- After the user explicitly turns on Auto, low-risk nodes within the authorized scope can advance automatically;
- Batch image or video generation, replacing existing assets, changing brand or product appearance, and final composition and export should wait for confirmation;
- Local failures can be handled by the thick Skill's rework principles; anything involving new paid generation still follows the current authorization and confirmation rules.

Manual/Auto does not need to be designed as a new Agent state machine; directly reuse the `execution_mode` and `recommended_run_after_create` that the current code really supports: `manual` by default only creates and waits for confirmation, and only `auto` recommends running after creation. Auto only represents the execution scope the user pre-authorized, and does not mean the Agent can unconditionally execute all high-cost or irreversible operations.

The default is declared by an `execution_mode` entry in the Skill's `input_parameters` (§6.1), adding no block. Currently only the two values the code already recognizes are used:

| `execution_mode` | Default execution behavior |
| --- | --- |
| `manual` | After creating the Graph, wait for user confirmation, then advance by node or scope |
| `auto` | Recommend running after creation, but still must not bypass existing confirmation for high-risk operations |

Finer behaviors such as "ask only on direction choices" and "advance automatically by budget" are written first in the thick Skill's `conduct_rules` for Hermes to judge, and a budget engine and checkpoint protocol that do not yet exist are not disguised as enum capabilities. The user's explicit choice this turn always outranks the Skill default.

The current `run_after_create=true` runs the full selection and cannot express stage checkpoints. Complex Skills create the full Graph with `run_after_create=false` by default; after user confirmation Hermes calls the existing `freezone_run_workflow` and advances by scope through `node_ids` and `direction=node`. Only when real use proves this approach insufficient in the future would a native checkpoint field be considered for WorkflowPlan.

The current approval rules are still essentially judged by command type and batch scale: `run_workflow`, deletion, batch commands, and some external MCP node actions trigger confirmation. It is not yet a general risk engine that understands actual credit cost, asset overwrite risk, and brand impact. So "risk-driven confirmation" is a goal that 2.0 must land in Skill execution rules and Agent behavior, and should not be described in the "currently available" list as done.

## 8. Minimal change list based on the current code

### 8.1 Foundations already completed

- The Skill/Recipe backend Pydantic Schema;
- Frontend Schema validation for the settings page and Skill entry;
- Skill Studio preserves `schema_version`, `name`, `version`, `allowed_recipe_ids`, and `input_parameters`;
- The authoring guide for new Skills and the Agent creation rules default to `input_parameters + allowed_recipe_ids + planning`;
- `freezone_workflow_plan.v1`, the Validator, the Graph Builder, and the DAG Runner;
- The Recipe Compiler, the node-level Action Catalog, and local rerun tools;
- Freezone Memory does not overwrite content Hermes has already learned;
- Bundle Schema, dangerous-content checks, import, export, local install, and the community Catalog install entry;
- The ordinary user entry shows only Skills, with Recipes in advanced management.

Do not keep listing these as P0 to be developed.

The first item above, "Skill/Recipe backend Pydantic Schema", means the structure validation mechanism has been built. The problem exposed in §2.8 is not that new fields must be added, but that the existing `planning_notes`, `prompt_guide`, and `conduct_rules` in thick Skills did not fully enter the planning and node execution context; this round prioritizes connecting the passing path.

### 8.2 The six items the dynamic main chain must complete

Numbered in dependency order. Item 5 depends on item 3 connecting Skill constraints first; the other items can proceed independently.

| # | Content | Depends on | Status (`671cb07`) |
| --- | --- | --- | --- |
| 1 | Write anchor requirements into the planning pack and Agent rules (zero Schema change) | none | Code landed, benchmark not measured |
| 2 | Fix the Skill Studio save contract | none | Done |
| 3 | Fix Skill -> Recipe Runtime constraint passing | none | Done |
| 4 | Change Recipe candidates to a strict allowlist | none | A new inconsistency was introduced |
| 5 | Converge built-in Recipes into a shared craft set | 3 | About one third, and the execution order needs correcting |
| 6 | Change the default strategy to a dynamic WorkflowPlan | none | Done, and has evolved to intent -> draft |

#### 1. Write anchor requirements into the planning pack and Agent rules (zero Schema change)

This item **does not change the Schema and adds no Validator check**; the reasons and the later upgrade conditions are in §6.1, "Why not add an `asset_policy.anchors` field for now". What to do is make the Agent land anchors as topology stably:

- `.hermes/plugins/freezone/json_workflow_catalog.py`: the planning pack explicitly issues the anchor requirements. The Skill's `planning_notes` / `conduct_rules` already state the requirement, and the planning pack must present it to Hermes as a **planning instruction** rather than mixed into a large block of prose for the model to pick out;
- `.hermes/skills/workflows/SKILL.md`: state that when generating a Plan the Agent should proactively build anchor nodes and draw reference edges to downstream nodes, and that the same subject references the same anchor node in all related shots;
- `.hermes/skills/freezone/references/skill-studio-authoring-guide.md`: when Skill Studio creates a Skill, have it write the method of building, reusing, and connecting visual references into `planning_notes`;
- `src/novelvideo/chat/service.py`: sync the Agent authoring rules, to avoid rule drift among the three places.

Benchmark evaluations that must be added (they involve Hermes planning behavior and are not deterministic unit tests):

- Given a Skill that declares a character anchor requirement, the generated Plan contains an anchor node, and every shot video node has a reference edge from it;
- The same subject references **the same** anchor node in multiple shots, rather than each shot generating its own.

The purpose of these evaluations is to **measure**: their pass rate on the three benchmark Skills is the data awaited in §6.1, namely whether the Agent will actually miss reference edges. Decide after running them whether to upgrade this into a Schema field plus a Validator invariant.

##### Status: code landed, benchmark pass rate not yet measured (`671cb07`)

The rules have been written in all four places: the planning pack of `json_workflow_catalog.py` already issues `asset_anchor_policy` (including `strategy: generate_anchor_then_continue` and `source_anchor_recipe_ids`); `.hermes/skills/workflows/SKILL.md` states that the anchor is the first PlanItem, later items reference the same semantic item id through `depends_on`, and the anchor node connects to all nodes depending on it through `media_input_for`; `skill-studio-authoring-guide.md` and `chat/service.py` are synced.

**But the two benchmark evaluations above have not been run.** Writing instructions into the planning pack does not mean the Agent will follow them, and that is exactly what this item is meant to measure. Until the pass rate is obtained:

- The "Skill Schema zero change" acceptance criterion of §10 is **in an unverified state**: whether the `asset_policy.anchors` field and Validator invariant need to be added depends entirely on this data;
- Do not treat this item as fully closed just because "the code has landed".

This is the only place currently where "the mechanism exists but its effectiveness is unknown"; static checks cannot give a conclusion, and Hermes must really be run.

#### 2. Fix the Skill Studio save contract

Modify `frontend/src/features/superchat/superchat-panel.tsx`:

- Stop writing the backend-unsupported `default_aspect_ratios` into `planning` (currently at `superchat-panel.tsx:3920`, while `AgentCatalogPlanning` accepts only `planning_notes` / `prompt_guide` / `conduct_rules` and has `extra="forbid"` enabled, so Skills saved by Skill Studio are rejected outright by the backend);
- Express default aspect ratios through `input_parameters`;
- `buildSkillStudioCatalogSaveItems()` reuses `validateFreezoneAgentConfigPayload()` before saving, instead of checking only a few fields;
- Add a cross-layer regression test that "the output of Skill Studio can be accepted directly by the backend `AgentCatalogSkillConfig`".

`default_aspect_ratios` is a bug in the current code and should be completed first as a standalone small fix.

##### Status: done (`671cb07`)

`default_aspect_ratios` no longer exists in either Skill Studio or the backend Schema; `superchat-panel.tsx:4748` now reuses `validateFreezoneAgentConfigPayload()`, going through the same frontend validation as the settings page (`freezone-skill-recipe-settings.tsx`).

#### 3. Fix Skill -> Recipe Runtime constraint passing

This item is the switch for whether "look-and-feel is controlled by the Skill" can hold; the cause and consequence of the gap are in §6.2. It consumes the existing `planning` fields and does not depend on new fields or item 1.

Modify:

- `frontend/src/features/canvas/application/workflowRecipeRuntime.ts`;
- the Recipe compile API request/response models;
- `src/novelvideo/freezone/recipe_runtime.py`;
- the Recipe compile entry points of image, video, audio, and text nodes.

The minimal runtime context is:

```text
skill_id + resolved_skill_version
confirmed_inputs
skill_constraints
recipe_id + recipe_version
node_intent
upstream_text
reference_media
```

Implementation rules:

- Graph nodes first save `skillId` and this run's `confirmedInputs`; after the traceability item of 8.3 is done, `skillVersion` is saved as well;
- The backend reads the effective Skill and its current version by `skillId`, extracts the relevant `prompt_guide`, `conduct_rules`, and `domain_constraints` per the node-type table of §6.2, and does not trust the client to submit a full Skill;
- Anchor and flow-type requirements do not enter the Compiler context; they are consumed by Hermes at planning time;
- Delete `Follow the Recipe instructions as the highest-priority creative method` from line 33 of the `recipe_runtime.py` system prompt, replacing it with "user request > confirmed inputs > Skill strong constraints > Recipe craft > defaults" (consistent with §6.4);
- Do not stuff the whole Graph, irrelevant Skill content, or the full prompts of other Recipes into the context;
- The cache key covers the Skill version, the confirmed inputs, and the constraints actually passed in, to avoid reusing old prompts after rules change;
- Add regression tests for conflicts between language, aspect ratio, brand facts, and Recipe instructions, which must include one: **when the Recipe's `system_prompt` conflicts with the aspect ratio of `confirmed_inputs`, `confirmed_inputs` prevails.**

##### Status: done (`671cb07`)

`recipe_runtime.py` already threads `confirmed_inputs` and `skill_constraints` through the compile entry (`_skill_constraints()` is extracted by the backend by `skillId`, not trusting a full Skill submitted by the client), each with a character limit.

The sentence `Follow the Recipe instructions as the highest-priority creative method` at line 33 has been deleted, replaced with a priority chain consistent with §6.4:

```text
1. Resolve conflicts in this order: explicit user goal, confirmed inputs, Skill hard constraints,
   Skill prompt guide, Recipe method, then defaults.
2. Recipe instructions are a reusable production method, not permission to override higher-priority
   user choices or Skill constraints.
```

**This item is the root cure of the "runtime pseudo Project Spec" problem in §2.8**: the `Final_Video_Spec` dependency dropped from 17/30 to 0, and authors no longer need to simulate constraint passing with text nodes by hand.

#### 4. Change Recipe candidates to a strict allowlist

Modify `.hermes/plugins/freezone/json_workflow_catalog.py`. The current admission condition of `_workflow_skill_recipe_candidates()` (about line 1639) is `explicitly_referenced or not output_kinds or output_kind in output_kinds`, so any Recipe whose `output_kind` matches enters the candidates, and `allowed_recipe_ids` is in fact not an allowlist. Change to:

- When `allowed_recipe_ids` is non-empty, the planning pack and the Validator allow only the explicitly listed Recipes;
- When a Recipe in the list is missing or disabled, return a clear error; it must not degrade to other Recipes of the same `output_kind`;
- Only when an old Skill has no `allowed_recipe_ids` are template references and `output_kind` inference kept;
- `freezone_get_workflow_skill()` and `validate_agent_workflow_plan()` must reuse the same candidate computation result;
- Add a regression test that "a Recipe of the same output type but not in the allowlist is rejected".

##### Status: changed once, but a new inconsistency was introduced (`671cb07`)

The `output_kind` fallback part is **now correct**: `_workflow_skill_recipe_candidates()` (now `json_workflow_catalog.py:1982`) added a `not references` precondition, so only old Skills degrade to inference, matching item 3 above.

But at the same time a branch that was **not designed above** was added, and it is unconditional:

```python
explicitly_referenced
or recipe_id in general_recipe_ids      # <- new, lets through even when references is non-empty
or (not references and (not output_kinds or output_kind in output_kinds))
```

The result is that the same "allowed" concept is now computed in three places with two semantics:

| Location | Semantics | Lets `general-*` through? |
| --- | --- | --- |
| `json_workflow_catalog.py:1982` `_workflow_skill_recipe_candidates()` | Candidate set | **Yes** |
| `json_workflow_catalog.py:951` `_compile_dynamic_recipe_items_intent()` | Raw `allowed_recipe_ids` | No |
| `workflow_plan.py:462` `_validate_node_catalog_refs()` | Raw `allowed_recipe_ids` | No |

The `allowed_recipe_ids` of the 6 built-in Skills **contain no `general-*` at all**. So the planning pack hands 4 Recipes such as `general-image` to the Agent as candidates, and once the Agent picks one, both downstream paths reject it:

```text
Recipe general-image is not allowed by Skill <skill_id>
```

This is exactly the situation item 4 above is meant to prevent.

**Suggested approach**: delete the `or recipe_id in general_recipe_ids` branch from the candidate function. Old Skills (without `allowed_recipe_ids`) can still get `general-*` by `output_kind` through the third branch and are unaffected; new Skills are strict again. If `general-*` is really meant to be always available, it must be written into each Skill's `allowed_recipe_ids` and this design added to this section; **an opening cannot be made only on the candidate side.**

Regression tests cover both: a Recipe of the same output type but not in the allowlist is rejected; and the candidate set and the two validations give consistent admission conclusions for the same Skill.

#### 5. Converge built-in Recipes into a shared craft set

Do this after item 3 is complete: Skill constraints must first be able to reach the node execution layer before duplicated rules can be moved out of Recipes.

**Set one premise first, otherwise this item is very easy to do backwards: what is converged is duplication, not thickness.**

Thick Skills are a proven, excellent Agent design pattern: the real Skills of competitors let the Agent make decent videos precisely because they are written thick enough, with multiple cinematic prompt rules, shot-writing order, how to write first and last frames, how to pin anchors, and parallel batching strategy, none missing. **Thickness itself is right; the only problem is that the same thickness is written once by each Skill.**

The converged shared Recipes **can and should be thick enough**: they should absorb the craft essence common to the five built-in styles, plus the publicly referenceable craft principles. The goal is not to become thin, but to give each craft a single place to maintain.

The correct form is:

```text
Before convergence  30 files x each rather thin and duplicating one another
After convergence   about 10-15 shared craft Recipes      the number is decided by real craft boundaries
```

The criterion is not a smaller byte count, but that **the same craft appears only once in the whole Catalog**.

By the statistics of §2.8, the 30 Recipes are 15 crafts after de-duplication, of which 3 are just the same craft under a different name. The convergence actions:

```text
Delete    *-video-spec x4        -> stop disguising a runtime spec as a kind of creative Recipe;
                                    confirmed_inputs enter the Plan and Recipe Runtime directly
Merge     script-outline / story-script / story-outline   -> script outline x1
Merge     storyboard / shot-list / storyboard-sketch      -> storyboard x1 (the image variant stays as a separate Recipe)
Merge     audio-layers / bgm                             -> audio layers x1
Generalize shot-video x5, key-elements x4, character-design, prop-anchor, compose-plan, input-analysis
                                    -> x1 each. Style differences move up to each Skill's prompt_guide;
                                    the craft essence of the five must be merged into the one that remains, not keep one and lose four
```

At the same time clean up the existing violating content (§6.2):

- **The stage-advancing instructions ("after confirmation, enter the [X] stage") in 12 Recipes need a destination; do not simply delete them.** Stage order and pause principles move up to the thick Skill's `planning.conduct_rules`, and basic automatic running uses only the existing `manual/auto`. If deleted with no destination, authors will write them back into Recipes next time;
- Remove the hard-coded resolution in 7 and the hard-coded aspect ratio in 3, changing them to consume `confirmed_inputs`;
- Remove the prose reading convention for `Final_Video_Spec`, changing it to consume the `skill_constraints` passed in by item 3;
- **Delete the empty phrase "character look must be consistent" in 4 files, and rewrite it as the Skill's anchor requirement.** Merely saying "stay consistent" in a Recipe has no effect; the effective way is to require, in the Skill's `planning_notes`, that an anchor node be built and connected to every related shot, with the Agent landing it as topology (§6.1).

The `allowed_recipe_ids` of the 5 built-in Skills are changed accordingly to point to the general Recipes.

When writing shared Recipes, **the craft principles Flova has published are usable reference input** (§5.1: a reference subject, not a competitor): several cinematic prompt rules, the shot -> subject -> space -> audio order of video prompts, how to write first/last/highlight frames, and clean-output constraints. These happen to be all general craft independent of subject and style.

Two boundaries must be held at once:

- **Referring to craft principles does not equal copying Skill text for redistribution.** The former is normal professional practice, the latter involves source licensing (§6.3). General Recipes should be craft specifications that we organize ourselves, not a transplant of someone else's Skill;
- **Do not write model-specific syntax in** (§6.4). Referring to its "write the shot first, then the subject" order principle is fine; do not let the shared Recipe be permanently bound to a vendor.

LibTV's Skill content is outside the reference scope: it is closed source, and its 100+ Skills have no craft value to borrow for this work (§5.3).

**The acceptance metric is not the file count, but how many Recipes adding a Skill requires. It is currently 5-7; when only a style or subject is added, the target is 0, and a Recipe is added only when a truly new craft appears.** The author's main work should be writing a good thick Skill, not copying a set of Recipes.

##### Status and correction of the execution order (`671cb07`): **read before starting**

The completed part is solid: `*-video-spec` has been cleanly removed from all Skills (`Final_Video_Spec` dependency 17 -> 0), stage-advancing instructions 12 -> 3, and cross-Skill reuse 0 -> 4.

But **convergence is only about one third done, and the way it was carried out went one step backwards**:

| Skill | Shared | Exclusive | What actually happened |
| --- | --- | --- | --- |
| `lego-minifigure-animation-video` | 4 | 1 | Migrated to the shared set (`97207105`) |
| `pixar-ip-ad-video` | 3 | 2 | Migrated to the shared set (`bc612bce`) |
| `retro-hong-kong-kungfu-comedy-video` | 2 | 3 | Partly migrated + renamed to remove IP branding (`18207244`) |
| `japanese-anime-drama-video` | 1 | 4 | **Only renamed** `jp-anime-drama-*` -> `dialogue-drama-*` (`0dbd2769`) |
| `outdoor-stage-duel-video` | 0 | 4 | Only `video-spec` deleted (`6fb6e2c4`) |
| `ling-cage-cinematic-video` | 0 | 5 | **Only renamed** `ling-cage-*` -> `sci-fi-survival-*` (`ce9f456d`) |

Removing IP branding is valuable in itself (a Catalog distributed to the community should not carry other people's IP names, see §6.3), but **renaming is not convergence**.

**The key problem: the shared set is "Lego-shaped".** What `97207105` did was "delete 7 `lego-minifig-*` -> 6 generalized renames", i.e. a single Skill shedding its style and taking generic names, and **never absorbing the craft of the other four**. The consequence is that the shared version is thinner than the unmigrated private versions:

| Recipe | `system_prompt` length |
| --- | --- |
| `storyboard-shot-video` (shared) | 811 |
| `sci-fi-survival-shot-video` (unmigrated) | 831 |
| `outdoor-stage-duel-shot-video` (unmigrated) | 1665 |

`sci-fi-survival-shot-video` contains the following, which are **style-independent, needed by any film-and-video Skill, and currently absent from the shared version** general craft:

- How to write a character seen from behind: `character seen from behind, back to camera, rear view, facing away from lens` + the back gear/hairstyle must be described + a `no turning around` lock;
- How to write combat: wind-up, follow-through, hit feedback, 0.1-0.3s micro-shake, damage continuity, environment interaction;
- How to write emotion: cause -> facial muscles -> body movement -> tone;
- `generate a single continuous scene, forbid grid/split-screen layouts`;
- The structure order `Camera -> Subject -> Space -> Audio -> Style -> Negatives`, **exactly the "shot -> subject -> space -> audio" order this section named above as worth absorbing from Flova**, whereas the shared version currently puts the subject first and camera movement fifth.

**So pointing the remaining Skills directly at the current shared set is a craft regression**, exactly the "keep one and lose four" this section repeatedly stresses.

**The execution order must be:**

```text
Step 1  first thicken the shared set: distill the general craft in the unmigrated Skills into it
Step 2  then point the Skills at it: their individual identities go into planning.prompt_guide
```

For the ownership judgment of step 2, follow the dividing line of §3.2, and note that two kinds of content are handled in opposite ways:

- The items above in `sci-fi-survival-shot-video` are **general craft and should be merged into the shared Recipe**;
- Most of the 1665 characters of `outdoor-stage-duel-shot-video` (`First-person audience POV from inside the crowd`, the five-beat structure, the whole Avoid block) are **that Skill's identity and should move up to `planning.prompt_guide`; they must never be merged into the shared Recipe**, otherwise the shared set is contaminated. It also hard-codes "each 15-second video corresponds to 1 shot", which is a violation this section is meant to clean up.

**Also check back**: whether `lego` and `pixar` also lost craft during migration, by comparing what `97207105` and `bc612bce` deleted. This has not yet been compared file by file.

#### 6. Change the default strategy to a dynamic WorkflowPlan

Mainly modify `.hermes/skills/workflows/SKILL.md`. Line 15 of that file currently still says "after reading the Skill planning pack, prefer having the Catalog tool expand the template. When the topology is unchanged, the Agent decides only the count and brief `items`", which is opposite to the dynamic-first direction. Change to:

- Delete "prefer expanding templates, plan dynamically only when the topology changes";
- When a new Skill chosen by the user has `allowed_recipe_ids`, generate a full `freezone_workflow_plan.v1` by default;
- Node count, stages, dependencies, parallel relationships, and whether to add keyframes are decided by this goal, the assets, and the inputs;
- The upfront asset decisions described in `conduct_rules` are consumed in order and **must not** be expanded into a fixed node sequence;
- Catalog template expansion is used only when the user explicitly chooses a fixed template, or an old Skill has only `workflow_templates`;
- ~~Keep using direct full-Plan writing, do not create nodes one by one, and add no Plan Schema.~~ See the status note below; this has been superseded by the persisted Plan draft scheme.

##### Status: done, and the main path has evolved (`671cb07`)

The "prefer expanding templates" passage at line 15 of `SKILL.md` has been deleted, and the default strategy is indeed Skill-driven dynamic planning.

But the implementation went further than this item originally envisioned: **the Agent no longer produces a full Plan directly**, but produces a slim `freezone_workflow_intent.v1`, which tools compile deterministically:

```text
freezone_prepare_workflow_draft(intent=...)  ->  patch  ->  confirm
```

The Agent decides only the user goal, structured inputs, PlanItems, each item's Recipe, input dependencies, whether to generate anchors, and whether to auto-execute; node data, stable IDs, edge types, groups, layout, and final-cut composition are done by tools. A full Plan enters the same quoting, preview, and confirmation state machine as ordinary workflows through `freezone_prepare_workflow_plan_draft(plan=...)`; the direct-create compatibility entry has been deleted; `freezone_build_workflow_plan` is explicitly forbidden to call.

**This direction is consistent with, and stronger than, Claim 2** (a smaller surface for the model to write wrong); see §3.3 for the full explanation. **When taking over, do not work on the `plan=` path again; it is no longer the main path.**

`.hermes/skills/freezone/references/skill-studio-authoring-guide.md` and `src/novelvideo/chat/service.py` already state that new Skills are dynamic by default and need no redo; only contract tests need to be added to prevent drift among the three places.

##### When distilling a Skill from the canvas, extract the method; do not snapshot the topology

`_handle_summarize_canvas()` (`.hermes/plugins/freezone/__init__.py:1512`) supports summarizing a Skill from the current canvas or selected flow. This path needs explicit extraction rules, otherwise the result of one task is easily saved as the method.

The criterion is consistent with §7.3: **the same Skill must be able to generate different Graphs for different inputs**. If the user chooses 15 seconds or 60 seconds, the shot count, parallel branches, and whether to add keyframes should all change accordingly. So a Skill distilled from a 6-shot canvas must not carry away the fact of "6 shots", otherwise it will expand into the same topology next time regardless of the target duration.

Extract by the following table when distilling:

| What is on the canvas | How to handle it when distilling |
| --- | --- |
| Node count, edges, groups, coordinates | **Discard.** They are the result of this one task, not the method |
| Recurring style descriptions | Distill into `planning.prompt_guide` |
| Global exclusions (such as no subtitles) | Distill into `planning.conduct_rules` |
| Anchor nodes referenced by multiple downstream nodes and their reference relationships | Distill into anchor requirements in `planning_notes`, stating which node types the anchor must connect to |
| The judgment order that must be in place before generation | Write into the prose of `planning.planning_notes` |
| Recipes actually used | Aggregate into `allowed_recipe_ids` |
| Specific shot count, single-shot duration, each shot's prompt | **Discard.** Subjective decisions (§3.1), not in the Skill |
| Model names and resolutions | **Discard** (Claim 4, §6.4) |

One-sentence criterion: **what is distilled is "how this kind of work should be done", not "what this one run turned out to be".** So when summarizing a canvas the Agent should proactively ask which features are long-term methods and which are only choices for this run, rather than serializing the canvas state as a whole. The corresponding rule must be synced into `skill-studio-authoring-guide.md`, with one more regression test added: a Skill distilled from the same canvas must not contain node counts or topology information.

### 8.3 Wrap-up items before the official 2.0 release

These do not block dynamic main-chain development, but should be completed before release:

1. Done (`671cb07`). Save `skillVersion` in the `workflowCatalog` of the new dynamic Plan, and have the Validator check it matches the current Skill; keep compatibility when an old Graph lacks it. See `workflow_plan.py:442-448`; the `if requested_skill_version` precondition is the old-Graph compatibility branch.
2. Not started. Make `.hermes-version` the single source of the Hermes version and remove the separate `0.18.0` fallback in `hermes_pool.py`. At review time `.hermes-version` was already `0.19.0`, while `DEFAULT_HERMES_VERSION = "0.18.0"` at `hermes_pool.py:50` is untouched, so the drift risk remains.
3. The bug part is solved; the version bump is pending. ~~Fix the export self-check failure when the Bundle default minimum version is `2.0.0` and the current package is still `1.1.2`~~: the export default has been changed to `current_dramaclaw_version()` (`agent_bundle_store.py:86`), so the self-check can no longer contradict itself (see §2.7). Raising the package version (now `1.1.5`) to `2.0.0` is now only a release-cadence decision.
4. Not started. Run a release contract test over ACP, Memory, Session recovery, the dynamic Plan, the Recipe Runtime, and Bundles.
5. Build a benchmark case set, with the verification scope strictly limited to the second paragraph below.

   **Already verified by production use of manual graph building and not re-tested this time**: node execution, DAG parallelism and upstream-failure blocking, local rerun, generation history, compose export, the Recipe Compiler producing usable prompts, and large-graph scale. This production line was already used to make real episodes before the Agent took over graph building, so re-testing these is a waste.

   **The only thing to verify this time is whether, after humans are moved out of graph building, the Agent can pick up the reproducible judgments.** In manual graph building the human was the Skill: the human chose the Recipe, the human ensured consistent look-and-feel, and the human judged whether assets were enough. The six items fill exactly the position left empty after humans withdrew, so the benchmark cases test only that position.

   Each benchmark Skill (comic-drama, product ad, e-commerce images) gets a fixed set of inputs (assets + goal + expected features), and is re-run and compared after the Skill changes. Assertion scope:

   - whether the style lock of `planning.prompt_guide` really enters the node prompts and takes effect;
   - when a thick Skill requires a unified visual reference, whether the Agent creates or reuses the same reference node and connects it to the related downstream;
   - whether the hard prohibitions in `conduct_rules` (such as no subtitles) are obeyed;
   - whether qualified existing assets are reused rather than regenerated;
   - whether the Plan is structurally legal and runs through completely, and whether local rework works after a single node fails;
   - whether the topology changes when the same Skill is fed three different sets of assets and goals (instead of expanding into the same graph every time).

   **Do not assert how many shots there should be or how fast the pacing should be.** Those are subjective decisions, belonging neither to the Skill nor to regression tests (§3.1); the way to verify them is a human taking a look and then taking the fix-in-place route. Writing subjective judgments into assertions would turn this case set into an aesthetic vote and lose its regression value.

   **The part of this case set that involves LLM calls** (Plan generation, Recipe compile) can also serve as the DramaClaw vertical offline evaluation asset that BrainClaw needs (§6.4), one investment serving two projects. The media generation part is outside BrainClaw's scope. The real episode assets and finished videos produced in the manual graph-building stage are the ready-made baseline.

   Voice identity is not included in this round's benchmark assertions; canvas audio references are currently used mainly for soundtrack references, and acceptance will be designed separately once the voice identity / voice clone chain is complete.
6. Not started. Deal with the two fake features of video composition. `buildComposePayload()` sends `speed` and `coverUrl` (`timelineModel.ts` already marks them with a warning comment), but these two fields cannot be found in the backend compose chain: `_render_video_clip()` does not accept a speed parameter, and `run_freezone_video_compose()` does not handle covers. So speed changes on the timeline are silently dropped at export, and the cover is not burned into the MP4. Before release choose one of two: complete the backend, or remove the two entries from the UI. A state of "set but ineffective" is not allowed to remain.

   Review (`671cb07`): the file has moved from `domain/timelineModel.ts` to `frontend/src/features/canvas/compose/timelineModel.ts:241` with unchanged content, both warning comments are still there, and the backend still has no `cover_url`.

   **This is currently the only issue that users can already touch and that clearly manifests as "set but ineffective", and it is completely unrelated to the Skill/Recipe main line.** It is easily masked by main-line progress; it is recommended not to leave it in the wrap-up list waiting for release, but to clear it early together with other small fixes.

### 8.4 P1: iterate on real needs after 2.0

- Render readable Skill documentation pages from the structured JSON;
- Generate a GitHub PR directly from Skill Studio;
- Generate Skill/Recipe improvement suggestions from the excellent versions the user selects;
- Make `evaluation` actually trigger automatic review and local rework;
- Add upgrade, rollback, and source display for Bundles;
- If historical version selection in generation history (`NodeGenerationHistory.tsx`) is not enough for side-by-side comparison of multiple versions, add `selected_version_id`.

None of these may block the dynamic Skill main chain in reverse.

#### Composition layer: to be filled in the next version

The 2.0 main line does not build the composition layer (§9 gives the reasons: transitions do not exist at the execution layer, and editing is a domain mature tools have already solved). But the comparison in §5.3 shows this is currently the clearest functional gap, so the targets are written down to keep "fill it in later" from becoming a goal-less promise:

1. **Let the composition layer support temporal overlap of video clips**, which is the precondition for transitions and picture-in-picture. Currently `run_freezone_video_compose()` directly rejects overlap (`overlapping video clips are not supported in MVP compose`), and the frontend blocks export accordingly;
2. **Transitions**, which only make sense once overlap is in place;
3. **Subtitle track and text layer**;
4. **Automatic subtitles + audio-video sync**, with the target covering finished videos of about 5 minutes;
5. **Complete or remove `speed` and `coverUrl`** (item 6 of §8.3 is already listed as a release wrap-up; do not drag it to this version).

Only after item 1 is done does the decision in §9, "do not declare transitions and editing rhythm in the Skill", need to be re-evaluated; until then that decision remains valid, because the fields would still take effect nowhere.

The "Agent message-level restore" that was previously listed here has been removed and is no longer a to-do. The reason is that the need itself is already covered by existing capabilities (§2.5): exploring another creative direction uses box-selecting a subgraph + creating a copy, comparing side by side on the same canvas with per-node consistency; comparing different outputs of the same step uses node-level history version selection. Project-level time-travel restore is a compensating measure needed only by products whose workflow is invisible (§5.1), and in an architecture where the Graph is the source of truth it is weaker than subgraph copying: it cannot compare side by side, and cannot change only one parameter while keeping everything else exactly the same.

## 9. Explicitly not doing

- Do not build our own Agent Runtime; keep depending on Hermes;
- Do not build our own Memory system; keep depending on Hermes Memory;
- Do not spin up multiple Agents by default for an "expert panel";
- Do not add a CreativePlan, Skill Session, or second WorkflowPlan;
- Do not add a standalone Project Spec Schema: the Skill Schema has zero changes this round, the related content is carried by existing `planning` fields and `input_parameters`, and the criterion is in §4.1 and §6.1;
- Do not declare transitions, editing rhythm, or fades in the Skill, for two reasons of our own: the composition layer `run_freezone_video_compose()` rejects temporally overlapping video clips, so transitions do not exist at the execution layer and the field would take effect nowhere; and editing and composition is a domain mature tools have already solved and is not this project's differentiating direction (Claim 1: the Graph is the source of truth for creation, and the composition layer is its downstream consumer). Re-evaluate once the composition layer has overlap capability;
- Do not do "director-level evaluation" in the engine: look-and-feel is Skill content, declared by `planning.prompt_guide` and conveyed to every node via item 3 of §8.2; the engine is responsible for making constraints arrive reliably, not for scoring works;
- Do not hard-code stage pause points in the Skill. Competitor samples write "stop and confirm at every key stage" into the Skill; we decide when to pause by the risk-driven confirmation of §7.5: low-cost reversible text planning advances automatically, and only batch paid generation and irreversible operations wait for confirmation. Mechanically pausing at every stage is an experience burden when cost is controllable;
- Do not write model-specific prompt syntax into Skills or Recipes (§6.4), and do not write model capability limits into Skills;
- Do not copy the competitor's card-style interaction protocol (multi-round cards collecting requirements, fixed confirmation options); that is its UI-layer design, and we have our own confirmation mechanism and Skill Studio questioning flow;
- Do not publish an OpenClaw-style remote-control client package that lets external Agents drive our service (§5.3); it would demote external Agents to porters and take creative decisions back to the server, directly conflicting with Claims 1 and 3. Our unit of distribution is the Skill Bundle, the creative method itself;
- Do not rewrite the Graph Builder or Canvas Runner;
- Do not duplicate a set of Storyboard, Asset, or Timeline data;
- Do not require ordinary users to understand and choose Recipes;
- Do not treat the number of fixed workflow templates as an ecosystem moat;
- Do not let community Skills carry executable code;
- Do not fix real vendor API model names into community Skills.

## 10. Acceptance criteria of 2.0

> **Review note (`671cb07`)**: the items below have **so far only had a static walkthrough, and the benchmark evaluation has not been run**. What a walkthrough can confirm is "whether the mechanism exists and the code is connected"; it **cannot** confirm "whether the Agent really follows it".
>
> So the following are in an **unverified** state and may be ticked only after the benchmark case set of item 5 in §8.3 is run; all of them assert the Agent's actual behavior, not code structure:
>
> - The Agent can stably land the topology according to the visual reference method declared by the thick Skill (the reference node exists, and related shots reuse the same reference);
> - `execution_mode` really affects execution behavior, and the user's choice this turn is higher than the Skill default;
> - The same Skill can generate different Graphs for different shot counts / different assets and goals (the topology difference between choosing 15 seconds and 60 seconds);
> - When assets already exist, unnecessary stages can be skipped, and existing assets are not regenerated by default;
> - The constraints of `planning.prompt_guide` and `conduct_rules` really win by the §6.4 priority when in conflict.
>
> The first of these directly decides whether the "Skill Schema zero change" criterion can hold (see the status note of item 1 in §8.2). **Do not announce 2.0 acceptance as passed before obtaining the benchmark data.**

On completion the following must hold:

- Users can create a Skill without fixed templates in natural language;
- Users can summarize a Skill from the current canvas;
- A Skill appears in the selection entry immediately after being saved;
- The same Skill can generate different Graphs for different shot counts;
- When assets already exist, unnecessary stages can be skipped;
- User-uploaded assets can be bound to the corresponding nodes by semantic role, and existing assets are not regenerated by default;
- When model capabilities differ, the same Skill can dynamically add or omit optional stages such as keyframes;
- The Agent can use only Recipes in the Skill's allowlist;
- Skill inputs are resolved and confirmed through the existing Input Contract;
- Confirmed inputs can be viewed in the Graph as a creative-spec node or a confirmation card;
- After user confirmation the Graph is created in one go, not written node by node;
- A complex Graph can be executed by scope according to risk and user authorization, without being forced to run all at once and without mechanically pausing at every stage;
- The existing DAG Runner can execute a dynamically created Graph;
- Nodes can generate actual prompts through the current Recipe Runtime;
- The Recipe Runtime can receive the Skill strong constraints and confirmed inputs related to the current node, and a Recipe does not override higher-priority rules;
- After a single node fails, local rework is possible without rebuilding unrelated branches;
- Before executing an existing node action, the Agent reads that node's Action Catalog and refuses to bypass unmet preconditions;
- Community Skills declare only capability needs and do not fix real vendor model names;
- The Skill/Recipe version can be traced in the Graph;
- Hermes Memory is not overwritten by DramaClaw initialization logic;
- A Skill and its dependent Recipes can be imported and exported as one Bundle;
- An invalid, dependency-missing, or over-privileged Bundle is rejected as a whole before saving;
- Ordinary users only need to understand Skills and do not need to manage Recipes;
- **Skill Schema zero change**: this round adds no field at all, and creative method, deliverables, and basic execution choice are carried by `planning` / `description` / `input_parameters.execution_mode` respectively (§6.1);
- The Agent can stably land the topology according to the visual reference method declared by the thick Skill: the reference node exists and related shots reuse the same reference. The pass rate on the three benchmarks is used to decide whether Validator domain checks need to be added later (item 1 of §8.2);
- The `execution_mode` in `input_parameters` really affects execution behavior, and the user's choice this turn is higher than the default declared by the Skill;
- After migration, no stage-advancing instruction appears in any Recipe's `system_prompt` any more, and that responsibility returns to `conduct_rules` and `execution_mode`;
- **When only a style or subject is added, no Recipe needs to be added; a Recipe is added only when a new craft appears** (the core metric of item 5 in §8.2);
- **Prompt layer**: `planning.prompt_guide` and `conduct_rules` really enter the Recipe Compiler context when a node executes, and win by the §6.4 priority when in conflict with a Recipe's `system_prompt`;
- **Topology layer**: the visual reference method of the thick Skill is clearly presented by the planning pack, and the Agent can proactively create or reuse reference nodes and connect them to the related downstream; the Validator continues to check only generic Graph legality;
- Fields such as `preparation_steps` / `deliverables` / `confirmation_policy` have **not** been added to the Schema; the corresponding intent is carried by existing `planning` fields and `input_parameters` (§6.1);
- Confirmed specs are saved in `WorkflowPlan.inputs` and enter the Recipe Runtime, and no longer depend on `*-video-spec` Recipes or runtime spec text nodes;
- The same Skill generates different topologies when assets and goals differ: the shot count, parallel branches, and whether to add keyframes all change when choosing 15 seconds vs. 60 seconds.

## 11. Final judgment

Of the five claims in §1.1, four already have code evidence and one is to be honored. What 2.0 has to do is fill in that one.

**The four that hold**: the Graph is a copyable, locally re-runnable source of truth for creation; the WorkflowPlan is a validatable, approvable first-class citizen; model capabilities are declared by the system; and the Agent Runtime depends on Hermes. These four need no new engineering, only to not be broken in later development.

**The one to be honored is Claim 3**: the Skill declares look-and-feel and boundaries, and the Recipe provides reusable craft. The measurement in §2.8 shows it does not hold today, and for a very specific reason: **the direction of the layering is right, but the dividing line was drawn in the wrong place.** Look-and-feel, flow order, and asset decisions were cut into Recipes, so 30 Recipes had 0 shared, the same set of constraints was rewritten by 7-14 files each, and changing one entry means changing a dozen files. The Recipe layer is currently a maintenance liability rather than a reuse asset.

The condition for honoring it is two things completed together, neither optional: the constraint passing of item 3 in §8.2 (making the prompts already written in Skills really reach the execution layer), and the craft convergence of item 5 in §8.2 (swapping duplicated thickness for shared thickness). Without either, the Recipe layer merely moves duplication from 5 Skills into 30 files.

**Why this is worth investing in**: §5.3 recorded a real author's dilemma. He made his storyboard method public as a "storyboard Skill", so when using the platform's director-aesthetics Skill he could only pick one of the two. In an architecture without a craft-reuse layer, general craft and look-and-feel are forced into the same unit, and any combination requires copying a whole one and editing it. The column structure of the storyboard table, the organization of the anchor list, the three-view generation method, the parallel batching strategy, and narrative beat extraction: these crafts, completely unrelated to subject and style, must be rewritten in every Skill.

This is the problem the Recipe layer solves, and the most direct benefit once honored: **authors write their own thick Skill, and general craft comes from a shared library.** For the community ecosystem, this decides whether the barrier for a new Skill is "copy five to seven Recipes and reword each one" or "write down the style, asset strategy, judgment methods, and quality standards".

The causal chain this yields is the core judgment of 2.0:

```text
The Skill Schema lacks fields for look-and-feel / assets / negative constraints
  -> authors manually simulate them at runtime with a video-spec text node (17/30 depend on it)
  -> the look-and-feel is hard-coded into each Skill's private Recipes
  -> Recipe reuse is 0, and writing a new style means copying 5-7 Recipes
  -> the community ecosystem cannot take off
```

So what decides success for 2.0 is not implementing more concepts, nor filling in some competitor's feature list, but two things: put the mis-cut layer of fields back in place, then truly connect this chain: the user picks a Skill, Hermes dynamically plans a validatable Graph from the current task, the Skill's look-and-feel and strong constraints truly reach the prompt of every node, the existing executor reliably completes generation, a failure reruns only that node, and the user then distills and shares new Skills from excellent results.

Whether it is achieved is judged by only two verifiable numbers, not by architecture diagrams:

1. How many Recipes adding a Skill requires: currently 5-7, target 0;
2. Whether the three benchmark Skills (comic-drama, product ad, e-commerce images) can generate different Graphs when assets, counts, and goals differ, run through completely, and be locally reworked (item 5 of §8.3).

If these two pass, all five claims hold. If not, the six items were only a structural tidy-up.

### Review (`671cb07`, 2026-08-02)

The **first three links** of the causal chain above have been broken: the Skill's existing fields (`planning.prompt_guide` / `conduct_rules`) now really reach the node execution layer (item 3), all `*-video-spec` have been deleted, and the `Final_Video_Spec` dependency went from 17/30 to 0. Authors no longer need to manually simulate constraint passing with text nodes at runtime.

Current values of the two decision numbers:

| Decision | Target | Current |
| --- | --- | --- |
| 1. How many Recipes adding a Skill requires | 0 | **1 ~ 5** (`lego` has reached 1, `ling-cage` still needs 5) |
| 2. Behavior verification of the three benchmark Skills | Pass | **Not run** |

Item 1 has gone from "everyone 5-7" to "best 1, worst 5", showing the path works: `lego-minifigure-animation-video` is a ready qualifying sample (4 shared + 1 genuinely new craft). What remains is to extend this form to the other Skills, **but the shared set must be thickened first** (see the correction of the execution order in item 5 of §8.2; migrating directly would cause a craft regression).

Item 2 has not been touched at all, and it is the only evidence that can prove "the thick Skill is really commanding the Agent". **Until it is run, the completion of the six items can only be called "mechanism complete", not "Claim 3 honored".**

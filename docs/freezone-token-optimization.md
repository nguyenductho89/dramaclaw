# Freezone Token Optimization Analysis

## Conclusion

The Freezone side still has considerable room for token optimization, and the potential gain may be higher than for the outer director agent.

Layered optimization of the `dramaclaw` Skill in the outer director agent does not automatically reduce Freezone's Skill content, canvas context, or tool Schemas. Freezone already has a separate Hermes workspace, deterministic workflow tools, and repeated-read protection, but the following main sources of consumption remain:

1. Every non-empty message carries a canvas summary;
2. The same set of canvas rules is injected repeatedly in the frontend, backend, and Skill;
3. The Freezone plugin registers about 48 tools at once;
4. The context is too large when Skill Studio is triggered;
5. Old canvas snapshots and large tool results may accumulate in the session history.

Handle the canvas summary and rule de-duplication first, then consider a dynamic toolset. The first two are low risk with direct payoff; a dynamic toolset may bring the largest gain, but also has the largest change and test scope.

## Existing optimizations

- Freezone uses a separate Hermes workspace, so the outer DramaClaw tools are not exposed to the model together.
- The Freezone base workspace mounts only the two Skills `freezone` and `workflows` by default.
- The native Workflow Skill loads compact content with `freezone_get_workflow_skill(compact=true)`.
- The standard dynamic workflow already hands deterministic operations such as Recipe selection, node expansion, stable IDs, edges, layout, and composition to tools.
- Ordinary multi-node edits prefer batch commands and do not require the model to call tools node by node.
- When the same read tool is called repeatedly with identical arguments beyond the limit, the Hermes SDK intercepts it.
- Freezone has a total cap on tool calls per turn, to avoid infinite loops.

These mechanisms reduce repeated reasoning during execution, but do not address the fixed cost of the per-turn input context and the tool Schemas themselves.

## Problem 1: every message carries a canvas summary

The frontend `shouldIncludeCanvasSummary()` currently returns `true` directly for all non-empty messages:

```text
frontend/src/features/freezone/chatNodeReferences.ts
```

So the following requests also carry the whole-canvas summary:

- ordinary chat and creative consultation;
- user confirmation or cancellation;
- deleting selected nodes;
- clearing the canvas;
- running an existing workflow;
- single-node operations that already carry an explicit node reference;
- creating a brand-new workflow from text.

The canvas summary contains up to 30 nodes and 40 edges by default. The more nodes, the larger the per-turn input. If the Hermes session keeps the full user prompt, the history may also contain several already-stale canvas snapshots at the same time.

### Recommendation

By default inject only lightweight routing information and `canvas_id/revision`, and decide whether to carry the summary by request type:

| Request type | Whole-canvas summary needed? |
|---|---|
| Ordinary chat, creative consultation | No |
| Clear the canvas | No |
| Delete selected nodes | No, use node references |
| Run an existing workflow | No, the Runner reads it itself |
| Create a new workflow from text | Usually not |
| Operate on a single explicitly selected node | No, use node references |
| Whole-canvas summary, tidy-up, layout | Yes |
| Distill a Skill from the current canvas | Needs the ontology, plus key node details if necessary |
| Modify multi-node structure that depends on the existing topology | Needs the summary or on-demand reads |

When no summary is injected but the model really needs canvas facts, it then calls `freezone_get_canvas_ontology` or a more specific read tool.

### History handling

Canvas context is transient transport information and should not be kept long-term as an ordinary user message. The history should keep only:

- the user's real input;
- the assistant's final business reply;
- the current workflow `draft_id/revision`;
- key decisions confirmed by the user;
- the current canvas revision/hash.

Do not keep, long-term, the complete canvas summary, node Schemas, command catalog, and large tool results of every turn.

### Benefit and risk

High benefit, low to medium risk. The main risk is the model lacking enough context when it needs the global topology. This can be solved with intent detection, on-demand read tools, and canvas revision validation.

## Problem 2: the same rules are injected repeatedly

Similar rules currently exist in all of:

1. `.hermes/skills/freezone/SKILL.md`, about 22 KB;
2. the fixed Freezone instructions in `src/novelvideo/chat/service.py`, about 4.9 KB;
3. the `[SUPERTALE_CANVAS_CHAT_COMMANDS]` injected by the frontend;
4. the long descriptions of some tools themselves.

The duplicated content mainly includes:

- a tool must be called before writing to the canvas;
- multi-node operations use batch commands;
- dynamic fields read the Schema first;
- edges must have real input semantics;
- compose nodes can only consume video and audio;
- completion must not be claimed before a tool succeeds;
- internal IDs, Schemas, and tool names are not shown to the user.

### Recommended layering

```text
freezone/
├── SKILL.md
├── playbooks/
│   ├── canvas-edit.md
│   ├── workflow.md
│   ├── skill-studio.md
│   └── mainline-projection.md
├── references/
│   ├── canvas-modeling-guide.md
│   ├── canvas-command-guide.md
│   ├── error-handling.md
│   └── response-boundaries.md
└── evals/
    └── evals.json
```

Suggested responsibilities:

- `SKILL.md`: only triggers, request classification, global safety boundaries, and on-demand loading routes;
- `playbooks/`: respectively handle ordinary canvas editing, dynamic workflows, Skill Studio, and the mainline mapping flow;
- `references/`: handle node semantics, command fields, error classification, and user reply boundaries;
- Frontend injection: provides only facts such as the current surface, canvas, selection, and revision, and does not repeat business rules;
- Backend fixed prompt: keeps only the safety isolation rules that a Skill cannot cover.

The goal is to keep `freezone/SKILL.md` at about 6-10 KB and to guarantee that each rule has a single source of truth.

### Benefit and risk

High benefit, low risk. The main risk is losing hard rules during the split, which requires structural contract tests and real-request evals.

## Problem 3: about 48 Freezone tools are registered at once

The Freezone plugin currently registers several groups of capabilities at the same time:

- canvas summary and context reads;
- node creation, modification, deletion, layout, and edges;
- dynamic workflow preparation, modification, confirmation, and running;
- Skill Studio drafts and Catalog management;
- mainline resource mapping;
- node action and option queries.

Even if a turn only needs to run one workflow, the model may still see the Schemas of Skill Studio, mainline mapping, and all ordinary node tools. Tool Schemas occupy model input and also increase the probability of picking the wrong tool.

### Recommended tool groups

| Tool mode | Suggested exposed capabilities |
|---|---|
| `freezone-chat` | Ordinary replies, keeping only the clarification tool when necessary |
| `freezone-workflow` | Workflow Skill, draft prepare/patch/confirm, run workflow |
| `freezone-canvas-edit` | Canvas reads, batch editing, necessary single-step edits and validation |
| `freezone-skill-studio` | Catalog queries, draft chunks, save and partial modification |
| `freezone-mainline` | Mainline resource queries and mapping |

Before the user request enters the model, the backend does lightweight deterministic routing and gives only the tool group needed for this turn. When routing is unclear, a small classification step can be used first, or a controlled entry for "upgrading to a wider toolset" can be provided.

### Implementation options

Possible options include:

1. Split the Freezone plugin into multiple plugins or toolsets;
2. Create isolated Hermes profiles/sessions for different intents;
3. Filter tool registration by route before the session is created;
4. If Hermes' native Tool Search can stably support plugin tools, evaluate enabling on-demand tool search.

The Freezone profile currently explicitly turns Tool Search off, so changing only the Skill text cannot reduce tool Schemas. Tool registration or session construction must be adjusted.

### Benefit and risk

The benefit may be the highest, with medium to high risk. It must handle scenarios in the same chat session that switch from a workflow to node editing and then to Skill Studio, and verify that the toolset can be switched safely or the session recreated.

## Problem 4: Skill Studio context is too large

When Skill Studio is triggered, the backend injects about 24 KB of extra fixed instructions; the full authoring guide is about 48 KB. If the canvas ontology, Catalog summary, and all Skill Studio tool Schemas are stacked on top, the per-turn input grows noticeably.

### Recommended split

Load only one flow depending on the source mode:

```text
playbooks/skill-studio/
├── new-from-brief.md
├── distill-from-canvas.md
└── edit-existing.md
```

- `new-from-brief`: does not load the canvas ontology;
- `distill-from-canvas`: loads the ontology and adds only a few key node details;
- `edit-existing`: reads only the target Skill/Recipe and the current draft;
- Recipe authoring fields, reuse judgment, and quality rules stay in references, loaded on demand;
- Schema rules that tools can validate are not repeated in the prompt.

### Benefit and risk

No impact on ordinary Freezone operations; high benefit for Skill Studio requests. The main risk is a decline in draft quality, which needs evals across the three source modes.

## Problem 5: tool output and session history

Some read tools may return the full ontology, node details, command catalog, or Catalog. Even if the UI shows only a compact result, the model context may still receive the full tool result.

### Recommendation

- All large read tools return compact results by default;
- Detailed fields are read again via `detail=true`, pagination, or a specified node/section;
- The ontology returns by default only the summary, selection, key nodes, and revision;
- The command catalog is queried by command type rather than returning all commands at once;
- Node Schemas are queried by target node type;
- The Catalog uses pagination, keywords, and exact ID queries;
- Before tool results enter the chat history, only the business summary and stable references are kept.

### Benefit and risk

Medium to high benefit, medium risk. Over-compression may make the model read again, so the compact return must include the stable IDs and missing-field hints needed for the next read.

## Items not recommended as a priority

### Directly lowering the tool-call limit

The current per-turn tool-call limit of Freezone is mainly used to stop loops and cannot reduce the fixed per-turn prompt and tool Schema tokens. Lowering it directly from 12 may cut Skill Studio chunk submissions short.

A more reasonable approach is to set budgets per mode:

- Ordinary single-node operation: 2-4 calls;
- Dynamic workflow creation: 3-5 calls;
- Ordinary batch canvas editing: 3-6 calls;
- Skill Studio: computed dynamically from the number of new Recipes;
- Repeated reads of the same object: keep the strict limit.

### Merely shortening tool descriptions

Shortening tool descriptions helps, but if 48 tools are still registered at once, the overall improvement is limited. First reduce the number of tools exposed per turn, then compress each Schema.

## Recommended implementation order

### Phase 1: low risk, high benefit

1. Rework `shouldIncludeCanvasSummary()` so the summary is injected only when whole-canvas context is really needed;
2. When node references exist, prefer the references and no longer attach the whole canvas;
3. Deterministic operations such as clear, delete, and run workflow do not attach the summary;
4. Prevent transient context blocks from entering the long-term history;
5. Add frontend and backend tests for the above routing.

### Phase 2: Skill layering and rule de-duplication

1. Slim down `freezone/SKILL.md`;
2. Add the canvas-edit, workflow, skill-studio, and mainline playbooks;
3. Delete the duplicated instructions in the frontend, backend, and Skill;
4. Split Skill Studio by the three source modes;
5. Add evals for triggering, routing, tool selection, and reply boundaries.

### Phase 3: dynamic toolset

1. Measure the toolset actually used by each request type in production;
2. Split the Freezone toolset;
3. Add deterministic intent routing and controlled toolset upgrades;
4. Verify cross-mode switching in the same session;
5. Then adjust max turns and tool-call budgets per mode.

### Phase 4: tool output and history compression

1. Add compact output, pagination, and section queries to large tools;
2. Keep only business results and stable references in the history;
3. Use incremental context based on the canvas revision;
4. Add stress tests for long sessions, large canvases, and multiple projects.

## Acceptance metrics

It is recommended to record the following metrics before and after optimization:

- input tokens of ordinary Freezone chat;
- input tokens for an empty canvas and canvases of 30/60/100 nodes;
- total input/output tokens of dynamic workflow creation;
- tokens of the three Skill Studio flows: create, distill, and edit;
- number of tools exposed per turn and the byte size of tool Schemas;
- bytes of the canvas summary per turn;
- context growth at the 1st, 10th, and 30th messages of the same session;
- average number of tool calls, number of repeated reads, and guard-interruption rate;
- workflow creation success rate, node editing success rate, and Skill Studio draft pass rate.

After phase 1, input tokens should drop significantly first for ordinary chat, simple deletion, running workflows, and explicit node operations; after phases 2 and 3, tool selection stability for dynamic workflows and Skill Studio should also improve.

## Impact assessment

- Phase 1 mainly changes the context injection strategy and does not change the canvas API, node execution, dynamic workflows, or UI operation flows; overall risk is low.
- Phase 2 changes rule ownership without changing product capabilities; after passing contract tests the impact on existing functionality is small.
- Phase 3 changes the tools visible to the model on each turn, and cross-mode switching needs focused verification; it is a medium-scale change.
- Phase 4 changes tool return structures and history storage, and needs compatible fields kept or consumers modified in sync.

Overall judgment: Freezone token optimization is worth continuing, but should start with "on-demand canvas summary injection" and "a single source of truth for rules"; lowering the tool-call limit directly is not recommended, and neither is refactoring all tool registration at the start.

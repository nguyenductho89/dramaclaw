# Freezone Agent Workflow Technical Design

This document describes the design approach of Freezone canvas workflows, the boundaries of agent development, how to extend the configuration, and the strategies that keep output stable. The intended readers are engineers who need to add workflows, maintain the agent toolchain, or investigate canvas generation stability issues.

## 1. Design goals

The core goal of Freezone workflows is not to let a large model assemble the canvas freely, but to separate "variable creative understanding" from "stable canvas execution":

- The model understands the user's intent, picks the right workflow skill, and, when necessary, generates node prompts/content according to a recipe.
- The JSON catalog declares the workflow structure, node types, step order, models, input dependencies, generation strategy, and constraints.
- The tool layer expands the JSON workflow into canvas nodes, edges, groups, execution actions, and approvals.
- The frontend canvas actually executes node actions, schedules them in edge-topology order, and waits for upstream nodes to finish before running downstream nodes.

This keeps the model from reinventing the node structure every time, and makes adding a workflow mostly a configuration task instead of a change to the Hermes prompt or the frontend execution logic.

## 2. Overall architecture

```text
User message
  |
  v
Hermes / Agent
  |  1. Identify intent, search the Skill / Recipe catalog
  |  2. Pick a workflow skill, or let the user choose among several hits
  v
freezone_prepare_workflow_plan_draft / freezone_confirm_workflow_draft / freezone_run_node_action
  |
  v
Canvas command bridge
  |  Writes pending, waits for frontend approval / execution / result write-back
  v
Frontend canvas
  |  1. Create nodes, edges, groups
  |  2. Execute node actions
  |  3. run_workflow executes in edge-topology order
  v
Node generation service
  |
  v
Image / video / audio / text results are written back to the nodes
```

Key directories:

- Built-in Skills: `src/novelvideo/freezone/agent_catalog/builtins/skills/*.json`
- Built-in Recipes: `src/novelvideo/freezone/agent_catalog/builtins/recipes/*.json`
- User-defined configuration: `output/<username>/_account/freezone/agent_config/{skills,recipes}/*.json`
- Catalog reading and merging: `src/novelvideo/freezone/agent_config_store.py`
- Hermes tool allowlist: `src/novelvideo/chat/hermes_sdk.py`
- Agent catalog summary injection: `src/novelvideo/chat/service.py`
- Frontend slash workflow entry: `frontend/src/features/superchat/freezone-skill-suggestions.ts`
- Canvas command execution: `frontend/src/features/freezone/canvasChatCommands.ts`

## 3. Division of responsibility between Skill and Recipe

### 3.1 Skill: defines "what the workflow is"

A Skill is workflow-level configuration. It answers these questions:

- Which user intents is this workflow suited for?
- What are its trigger keywords, aliases, and category?
- Which templates does the workflow contain?
- How many steps does each template have?
- What are each step's node type, action type, input dependencies, and model?
- Which steps are single nodes, and which are expanded in batches according to a count?

Typical fields:

```json
{
  "id": "video-ad",
  "enabled": true,
  "description": "Product advertising video workflow",
  "category": "video",
  "aliases": ["ad_video", "advertising video"],
  "triggers": {
    "keywords": ["advertising video", "product ad", "brand video"]
  },
  "planning": {
    "planning_notes": "Workflow execution constraints",
    "prompt_guide": "Domain style guidance",
    "conduct_rules": ["Execute only the goal of the current step"]
  },
  "workflow_templates": [
    {
      "id": "video-ad-full",
      "steps": [
        {
          "id": "ad-outline",
          "step_number": 1,
          "node_type": "textGeneration",
          "action_key": "video-ad-creative-outline",
          "model": "gemini-3.5-flash",
          "prompt_strategy": "user_message",
          "input_strategy": { "type": "none" },
          "multiplicity": "single"
        }
      ]
    }
  ]
}
```

### 3.2 Recipe: defines "how a kind of node generates its prompt/content"

A Recipe is node-operation-level configuration. It answers these questions:

- What kind of content should a given `action_key` generate?
- Which fields are structure that must be included?
- Should the prompt be filled directly with the user input, or should the user input be reworked into a downstream generation instruction?
- Is source media required?
- Should the detail check be skipped?

Typical fields:

```json
{
  "id": "video-ad-creative-outline",
  "name": "Ad creative outline",
  "output_kind": "text",
  "action_keys": ["video-ad-creative-outline"],
  "system_prompt": "Convert the user's original idea into a generation instruction for an ad creative outline that textGeneration can execute",
  "must_have_items": ["[Brand/product positioning]", "[Target audience]"],
  "planning_prompt": "The prompt is filled with product/brand information and the ad goal",
  "result_summary": "Ad creative outline generation instruction",
  "requires_source_media": true,
  "skip_detail_check": true
}
```

Important principle: a Recipe does not simply stuff its raw JSON into the node. It should be split into two kinds of information:

- Execution settings: written directly into the node configuration, such as `model`, `output_kind`, `aspect_ratio`, `voice`, `makeInstrumental`, `videoSubtask`.
- Generation hints: handed to the agent or tool as constraints, used to produce the final `prompt/content` from the user's needs and upstream results.

## 4. Catalog sources and merge rules

The catalog has two sources:

- built-in: shipped with the project, released with the code.
- user: custom configuration under the user directory.

The reading logic is in `agent_config_store.py`:

```text
builtins/skills/*.json
builtins/recipes/*.json
        +
output/<username>/_account/freezone/agent_config/skills/*.json
output/<username>/_account/freezone/agent_config/recipes/*.json
        |
        v
list_user_agent_config_items(username, kind)
```

Merge rules:

- User configuration takes priority.
- When a user item has the same ID as a built-in item, the user item overrides the built-in fields and is marked `customized`.
- Users can hide a built-in item with `{ "id": "...", "hidden": true }`.
- Returned items carry `_catalog_source` to distinguish `builtin` / `user` / `customized`.

This mechanism ensures:

- Built-in workflows can be released stably.
- Users can extend or override workflows without changing code.
- Lists can label items as "built-in / user-defined / overrides built-in".

## 5. Workflow creation path

### 5.1 Recommended path

The recommended path is:

1. The agent searches the catalog based on the user's intent.
2. If several skills match, let the user choose first.
3. After a choice, call `freezone_prepare_workflow_plan_draft`, show the exact preview, and after the user confirms, call `freezone_confirm_workflow_draft`.
4. The tool reads the skill's `workflow_templates` and expands them into nodes, edges, and groups.
5. The frontend shows the canvas operation approval.
6. After the user confirms, the canvas creates the nodes and edges.

The agent should not hand-write large `create_node/create_edge/group_nodes` JSON, unless it is a temporary fix or a special operation the catalog cannot cover.

### 5.2 Slash entry

The frontend `/` entry only lists skills that have `workflow_templates`. This prevents generic skills such as `general` from being treated as directly creatable workflows, which would cause the "0 steps, cannot create" problem.

## 6. Workflow execution path

When executing an existing workflow, prefer `run_workflow` over having the agent call several `run_node_action` in a row.

The frontend execution logic will:

- Expand the workflow node set from the selected group or nodes.
- Exclude group nodes.
- Pick a default action for each generation node.
- Check whether a node already has output, and skip completed nodes by default.
- Execute in topological order of the canvas edges.
- Run nodes at the same level in parallel; downstream nodes must wait for upstream nodes to finish.
- When a final-cut composition node meets its input conditions, open the composition UI without forcing the upstream nodes to regenerate.

This solves two key stability problems:

- A model cannot guarantee strict edge-order execution through natural language.
- When the user says "finish it for me" once, the system must not regenerate already completed nodes after some node finishes.

## 7. Output stability strategy

### 7.1 Let the model choose, not build structure

The most stable approach is:

- The model chooses the skill/template/recipe.
- The tool expands the node structure.
- The tool decides edges, groups, and execution order.
- The model only generates prompt/content within the range the recipe allows.

Do not make the model responsible at the same time for "choosing the workflow, designing the node structure, generating the prompt, deciding execution order, and judging completion state". Too many responsibilities lead to duplicate generation, missing edges, and downstream nodes running too early.

### 7.2 Completed nodes are not rerun by default

Before executing a node, determine:

- Whether a text node already has content.
- Whether an image node already has an `imageUrl` or a generic output URL.
- Whether a video node already has a `videoUrl` or a generation task handle.
- Whether an audio node already has an `audioUrl`.

If output already exists:

- The user only says "continue / finish it for me": skip completed nodes.
- The user explicitly says "regenerate": only then rerun.
- When all nodes are complete, ask whether to regenerate everything.

### 7.3 Upstream dependencies must be guaranteed by the tool

Do not only remind the model in the prompt to "execute in edge order". The model may still call several nodes concurrently. `run_workflow` must schedule by the canvas edges:

```text
Text node finishes
  -> image node starts
      -> video node starts
```

If a node has several downstream nodes, they can start in parallel once that node finishes:

```text
Script finishes
  -> storyboard images
  -> narration
  -> background music
```

### 7.4 Classify Recipe fields explicitly

When adding a Recipe, fields must be distinguished as:

- Direct setting fields: model name, aspect ratio, node type, action type, voice, instrumental-only flag, auto-start flag.
- Prompt generation fields: `system_prompt`, `planning_prompt`, `must_have_items`, `result_summary`.
- Input dependency fields: whether user material is required, whether upstream nodes are read, whether inputLinks are forbidden.

Take special care: audio nodes are easily contaminated by upstream text. For nodes such as ad background music and narration, if the recipe explicitly requires independent generation, `inputLinks` should be forbidden, and the final narration text or music description should be written directly into the node prompt/config.

### 7.5 Do not fill explanatory text directly into nodes

A common mistake is writing planning notes like the following straight into a node:

```text
[User request]
[Workflow]
[Current node goal]
[Operation type]
[Planning hint]
[Expected output]
```

This kind of content is intermediate planning for the agent/tool, not the node's final prompt. The node should only keep the final instruction that the target model will execute.

## 8. Agent development notes

### 8.1 When to ask the user

Cases where the user should be asked:

- Several workflow skills match at once with no clear priority.
- The user chose a generic skill, but that skill has no workflow template.
- The workflow is already fully complete and the user asks to "generate / finish" again; confirm whether to regenerate.
- The user wants to overwrite an existing project or reset existing output.

Cases where the user should not be asked:

- An upstream node is not finished. The tool should automatically go back to run the upstream node and continue downstream after it finishes.
- A node has a clear action_catalog. Call the corresponding action directly.
- The user selected a workflow group and asked to continue. Execute according to the nodes and edges inside the group, and do not touch nodes outside the group.

### 8.2 Canvas writes must go through approval

Creating, deleting, updating, connecting, grouping, and running node actions are all canvas writes. They should go through the unified approval path:

- The agent issues a tool call.
- The frontend shows "Canvas operation pending confirmation".
- It executes after the user confirms.
- If the user cancels or the countdown times out, a cancellation result is written back.

Do not bypass approval to modify the canvas directly.

### 8.3 Tool results must be recoverable

Tool results need to be written to history or `ui_events`; otherwise, after a page refresh:

- Tool cards disappear.
- Approval state is lost.
- History messages and live messages display inconsistently.

However, read-only context reads should not be over-exposed to the user. Recommended:

- Validation, failures, and execution results are shown by default.
- Debug information such as node capability reads and node detail reads is hidden or de-emphasized by default.
- Full details are shown only when "Show tool calls" is turned on.

### 8.4 Error text must not expose internal placeholders

Internal problems such as the agent returning no content, bridge timeouts, and leftover pending files should be converted into text users can understand. For example:

- Do not show `(hermes returned no content)`.
- Change it to "This round did not receive a valid reply from the director agent. Please try again later."
- For a canvas bridge timeout, explain that "the frontend did not complete the operation within the time limit" instead of exposing pending/result file paths.

## 9. Process for adding a new workflow

Adding a workflow is recommended to follow these steps:

1. Add a Skill JSON:
   - Path: `src/novelvideo/freezone/agent_catalog/builtins/skills/<id>.json`
   - Define `id`, `description`, `category`, `triggers`, `workflow_templates`.

2. Add or reuse a Recipe JSON:
   - Path: `src/novelvideo/freezone/agent_catalog/builtins/recipes/<action_key>.json`
   - One node action corresponds to one or more `action_keys`.

3. Confirm each step:
   - Whether the `node_type` exists.
   - Whether the `action_key` matches a recipe.
   - Whether the `model` is available.
   - Whether the `input_strategy` is consistent with the edge direction.
   - Whether the `multiplicity` is controllable and has an upper limit.

4. Verify through the `/` entry:
   - Whether the workflow appears.
   - Skills without `workflow_templates` must not appear in the slash workflow list.

5. Verify after creation:
   - Whether the nodes are complete.
   - Whether the edge directions are correct.
   - Whether the group contains all nodes.
   - When the user selects a group, only the nodes inside the group are handled.

6. Verify after execution:
   - Whether execution follows the edge order.
   - Whether completed nodes are skipped.
   - Whether unfinished upstream nodes are automatically executed first.
   - Whether failure information lands in the tool card or the message.

## 10. Testing recommendations

Cover at least the following cases:

- Workflow creation: single node, two nodes, three nodes, multiple branches, with a final-cut composition node.
- Repeated creation: a new independent group can still be created when the canvas already has a workflow of the same type.
- Selected-group execution: only nodes inside the group run; nodes outside the group are not touched.
- Completed-skip: image/video/audio with existing output are not regenerated.
- Upstream completion: when a video node is selected but the image is not done, generate the image first and then the video.
- Multiple matching skills: prompt the user to choose instead of guessing.
- User-defined catalog: JSON under the user directory can be searched together with built-ins, and the source is shown.
- Refresh recovery: approvals, execution results, and failure states can be restored from history.
- Approval cancellation: after clicking cancel or the countdown cancels, the tool status updates.

## 11. Maintenance principles

- Prefer extending the JSON catalog over changing the large Hermes prompt.
- Prefer having tools guarantee structure and order over relying on the model to comply.
- Every workflow template needs a clear boundary; do not force several purposes into one template.
- Keep Recipes short and precise; avoid injecting long design notes directly into nodes.
- When adding a field, consider whether it is a "configuration field" or a "hint field".
- Every batch of nodes must have an upper limit.
- Every execution-type node must have a completion-state check to avoid duplicate generation.
- Any action that writes the canvas must be approvable, cancellable, and recoverable.

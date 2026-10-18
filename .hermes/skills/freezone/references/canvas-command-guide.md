# Shrimp Canvas Canvas Command Guide

## Execution flow (mandatory order, no skipping)

When operating the canvas you **must follow this order strictly, never reversed**:

1. **Call the tool** - call the tool first (`freezone_emit_canvas_command` or a single-step tool)
2. **Check the result** - read the result the tool returned
3. **Judge success or failure** - only a result with an explicit success marker (such as `"success": true`, `status: "ok"`) counts as success; an error message or an empty result is a failure
4. **Then reply to the user** - report the result to the user according to the judgment in step 3

The **first output of a canvas-operation request must be a Freezone write tool call**. Before the write tool call, **outputting any user-facing text reply is forbidden** (do not say "OK", "I will...", "I'm working on...", "done..."). Only call the tool, say nothing.

When a tool returns a failure, **pretending success is forbidden**. You must tell the user honestly.

If the failure can be clearly fixed from the returned content, fix it silently and call the tool again, without showing the user the failure details or the fixing strategy. Only reply to the user when it ultimately cannot be completed, and only explain in product-level language that it was not completed, without exposing fields, node ids, `client_id`, `source/target`, `link_type`, tool names or JSON.

Your responsibility is to operate the Freezone canvas along the safest frontend tool path. Unless the frontend has actually executed the command and returned success, do not claim that the canvas has changed.

Hard boundary: when the user asks to create, add, delete, update, connect, move, lay out, select, open, run, apply or execute any canvas object, you must call a Freezone write tool and wait for the result. The tool can be chosen flexibly: a single explicit operation may use the corresponding single-step write tool or `freezone_emit_canvas_command`; multiple canvas changes must use a single `freezone_emit_canvas_command`. But you may not skip the tool, and you may not describe a canvas operation as done in plain text.

Important boundary: create, delete, update, connect, layout, open tool and frontend node actions all go through the frontend command path. Ordinary canvas modifications default to one batch submission with `freezone_emit_canvas_command`. Use a specific single-step Freezone write tool only when the user explicitly asks for "exactly one operation". When the user explicitly asks to build a framework, build a workflow, put a storyboard structure / short-film plan on the canvas, or any request that creates multiple nodes/links/groups/layout, first gather the necessary catalog/schema and validate, then submit with one batch command; do not write several single-step operations in a row while thinking.

For a clear single canvas operation, you can call the corresponding single-step tool instead of hand-writing a generic command object: `freezone_create_node`, `freezone_add_next_node`, `freezone_update_node_data`, `freezone_create_edge`, `freezone_delete_nodes`, `freezone_delete_edges`, `freezone_move_nodes`, `freezone_layout_nodes`, `freezone_group_nodes`, `freezone_select_nodes` or `freezone_run_node_action`.

Explanation boundary: before entering a canvas write, first confirm that the user explicitly asked to operate the canvas (rather than consult, explain, look for ideas, or make an open creative request). "I want to make ... but have no ideas", "help me think", "give me some suggestions", "what directions are there" are by default conversational planning, not canvas writes. See the "Intent judgment" section in SKILL.md for the intent judgment rules.

For multiple nodes, multiple links, storyboards, prototypes, canvas building, or any request containing multiple canvas changes, do not call several single-step write tools in a row. If the batch command fields are unclear, first call `freezone_get_canvas_command_catalog`, then submit one `freezone_emit_canvas_command` batch command.

Canvas writes must have a basis. Before creating nodes or editing the graph structure, first use the current canvas summary/ontology; when command structure, node data or links are involved, query `freezone_get_canvas_command_catalog`, `freezone_get_node_create_schema` and `freezone_get_link_type_catalog` as needed. A multi-step command or one containing links must be validated before writing.

If validation returns `Allowed link_type values: none` for a source/target pair, do not keep trying other `link_type`s. You may fall back to visual grouping with `group_nodes`, or leave those nodes unconnected.

If, before editing, you need read-only canvas context, dynamic parameter options, command field rules or frontend pre-validation, use the specific Freezone tools: `freezone_get_canvas_ontology`, `freezone_summarize_canvas`, `freezone_get_canvas_action_catalog`, `freezone_get_canvas_command_catalog`, `freezone_get_link_type_catalog`, `freezone_get_selection`, `freezone_get_node_detail`, `freezone_get_neighbor_graph`, `freezone_get_node_action_catalog`, `freezone_get_node_create_schema`, `freezone_get_audio_voice_options` and `freezone_get_slot_candidates`. For non-trivial create, update, delete, connect and layout operations, call `freezone_validate_canvas_commands` before writing, passing only the `commands` array of the `canvas_chat_commands.v1` envelope; if validation returns problems, fix the `commands` and validate again. Do not put the full envelope or `canvas_context_request.v1` into any write tool, and do not use `run_node_action` to get options.

If available and read-only canvas context or dynamic parameter options are needed, you can use `freezone_request_canvas_context`. For example `neighbor_graph`, `node_create_schema`, `action_catalog` and `audio_voice_options`. Do not put `canvas_context_request.v1` into `freezone_emit_canvas_command.commands`, and do not use `run_node_action` to get options.

User-visible language must stay at the product level. Internal implementation details (protocol names, schema names, field names, internal ids, JSON and so on) may only be used for reasoning or tool calls. See the "User-visible replies" section in SKILL.md for the reply style.

## Conditions of use

Use this guide only when all of the following conditions are met:

- The current chat surface is Freezone/Shrimp Canvas/canvas, or the user message mentions canvas nodes.
- The prompt contains `[SUPERTALE_CANVAS_ONTOLOGY_CONTEXT]`, `[SUPERTALE_CANVAS_NODE_REFERENCES]` or `[SUPERTALE_CANVAS_CHAT_COMMANDS]`.
- The user asks to operate on referenced nodes, the current selection, a node group, or to create standalone nodes.

Typical requests:

- "Add a video node after this node"
- "Change the selected nodes to ..."
- "Upscale / redraw / crop this image"
- "Arrange these nodes neatly"
- "Delete these nodes"
- "Create a next-step node and connect it"

## Input

The frontend may inject a read-only canvas ontology overview:

```text
[SUPERTALE_CANVAS_ONTOLOGY_CONTEXT]
{ "schema_version": "canvas_ontology_context.v1", "objects": [...], "links": [...], "slots": [...] }
[/SUPERTALE_CANVAS_ONTOLOGY_CONTEXT]
```

Use this overview to understand the existing nodes, links, candidates, slots, actions and current selection. It is only read-only context and does not mean the operation the user requested has already been executed.

The frontend may also inject selected-node references:

```text
[SUPERTALE_CANVAS_NODE_REFERENCES]
reference_1_project: ...
reference_1_canvas_id: ...
reference_1_node_1_id: ...
reference_1_node_1_type: ...
reference_1_node_1_label: ...
reference_1_node_1_action_summary_json: {...}
reference_1_edge_1_id: ...
reference_1_edge_1_source: ...
reference_1_edge_1_target: ...
[/SUPERTALE_CANVAS_NODE_REFERENCES]
```

Unless the user explicitly says it is not these nodes, treat the `node_id`s in the current input block as this turn's target set. If multiple nodes are referenced and the user asks to operate on the current selection, the selected nodes, these nodes, a group, or asks to move, delete, lay out or select them together, put all referenced node ids into one command. Do not quietly operate only on `reference_1_node_1_id`.

If the ontology overview and node references both exist, treat the node references as this turn's explicit target set and the ontology overview as global background.

Ignore node ids from earlier chat turns. Canvas nodes may already have been deleted; only the current user text, the current `SUPERTALE_CANVAS_NODE_REFERENCES` block, and client ids just created in the same envelope are valid operation targets.

Treat `edge_*` in the references as known edges between the referenced nodes. Use edge references only in disconnect, unlink and delete-link requests; do not use edge references in delete-node requests.

The division of labor between each node's `node_detail` and the action tools is as follows:

- `downstream_spawn_types`: the node types that can be created downstream from this node.
- `parameters`: the data fields the node itself allows ordinary patching of, with current values and options.
- `action_summary.actions`: a lightweight list of the node's available actions.
- `freezone_get_node_action_catalog(node_id, action)`: the full parameters, execution mode and description of an action.

`parameters` are not the parameters of toolbar/panel actions. When the user asks "what parameters does this tool have", "how do I configure upscale/crop/cutout/lighting", first use `action_summary.actions` to find the corresponding action, then call `freezone_get_node_action_catalog(node_id, action)`; do not answer directly from the source node's `parameters`.

For actions with `execution="frontend_node"`, do not look for a backend `action_id` or `skill_id`. Use `run_node_action` and pass the listed `action` string. For example, if an `imageGenNode` has `action="generate_image"`, use:

```json
{
  "type": "run_node_action",
  "node_id": "image_node_id",
  "action": "generate_image"
}
```

Do not invent node ids. A newly created node that will be referenced later in the same envelope must explicitly declare a `client_id`, and later commands must reference those values. Outputting `node_0`, `node_1`, `new_node`, `auto:*` or any undeclared placeholder is forbidden; they are not valid references to "the Nth newly created node".

A Plan id is not a canvas node id. If a confirmed custom plan needs to become multiple canvas nodes, links, groups or layout changes, submit it in one batch with one `freezone_emit_canvas_command` and explicitly declare `client_id`s; do not split it into several single-step tool calls.

## Tool contract

When you need to perform a canvas operation, call a Freezone write tool. Do not output protocol JSON in chat messages. If no Freezone write tool is available, say the current canvas tools are unavailable and ask the user to retry once the tools recover.

Do not wrap the internal command payload in XML/HTML-style tags such as `<schema_version="canvas_chat_commands.v1">`. Protocol fields may only go in tool parameters and must not appear in user-visible replies.

The frontend supports the following command types in Freezone write tool parameters:

### create_node

Create a standalone node.

```json
{
  "type": "create_node",
  "client_id": "optional_local_alias",
  "node_type": "textAnnotationNode",
  "position": { "x": 0, "y": 0 },
  "data": { "displayName": "..." }
}
```

### add_next_node

Create a downstream node from an existing node, and optionally connect it.

```json
{
  "type": "add_next_node",
  "source_node_id": "existing_node_id_or_client_id",
  "client_id": "optional_local_alias",
  "node_type": "imageGenNode",
  "connect": true,
  "data": { "prompt": "..." }
}
```

When choosing the node type, prefer the source node's `downstream_spawn_types`.

`add_next_node` has no `position` field: the new node is automatically placed beside the source node. Passing a `position` is rejected by parameter validation; when you need to specify coordinates, use `create_node` + `create_edge` instead.

If later commands in the same envelope reference the newly created node, this `create_node` or `add_next_node` must declare a `client_id`. Every newly created node that will later be used by `create_edge`, `group_nodes`, `select_nodes` or a targeted `move_nodes` must have an explicit `client_id`.

For themed batch creation, put the set of nodes on the same theme into one ordinary group. Applicable scenarios include: a short-film plan, an ad creative pack, a storyboard framework, a workflow, a material preparation pack, planning/generation/compose nodes under the same goal. Do not wrap "adding a single node" or scattered modifications into a group.

When creating and connecting in the same batch, use semantic `client_id`s:

```json
{
  "commands": [
    {
      "type": "create_node",
      "client_id": "creative_brief",
      "node_type": "textAnnotationNode",
      "data": { "displayName": "Creative brief", "content": "..." }
    },
    {
      "type": "create_node",
      "client_id": "poster_image",
      "node_type": "imageGenNode",
      "data": { "displayName": "Key visual poster", "prompt": "..." }
    },
    {
      "type": "create_edge",
      "source": "creative_brief",
      "target": "poster_image",
      "link_type": "prompt_for"
    },
    {
      "type": "group_nodes",
      "node_ids": ["creative_brief", "poster_image"],
      "label": "Public-welfare short film visual direction"
    }
  ]
}
```

Do not write it like this:

```json
{
  "commands": [
    { "type": "create_node", "node_type": "textAnnotationNode", "data": { "displayName": "Creative brief" } },
    { "type": "create_node", "node_type": "imageGenNode", "data": { "displayName": "Key visual poster" } },
    { "type": "create_edge", "source": "node_0", "target": "node_1", "link_type": "prompt_for" }
  ]
}
```

When later extending an existing theme, if the node the user references is inside a group and the new node really is a downstream or derived result of that node, prefer `add_next_node`, so the frontend places the new node in the same group context. Do not fabricate `prompt_for`, `media_input_for` or other input links just to "join the group"; if you are only adding a piece of related material that is not an input relation, create it near the group and keep the layout consistent; do not assume a `group_id` field exists.

For video-related creation, choose the node type by stage:

- If the user asks to produce/generate a video, make an ad short, create a short film, or asks what to do next after image/text/audio material is ready, choose `videoNode` by default. `videoNode` generates video clips from upstream image, text, script or audio references.
- `videoComposeNode` is the final timeline/compose node, used to compose multiple video clips and audio tracks into the final video. Connect only video/audio artifacts into it as compose inputs; do not connect creative briefs, storyboard text or prompts directly to it.
- Do not choose `videoComposeNode` by default. Use `videoComposeNode` only when the user explicitly asks for timeline composition, final assembly or video composition, or is building a complete short-film workflow containing video/audio generation nodes and a final compose stage.
- If the only available upstreams are image, text, script and audio nodes and there is no video generation stage, first create/connect a `videoNode`; do not create a `videoComposeNode` on its own.

### update_node_data

Modify ordinary editable data on a node.

```json
{
  "type": "update_node_data",
  "node_id": "existing_node_id_or_client_id",
  "data": { "prompt": "...", "displayName": "..." }
}
```

Unless the user explicitly asks to modify an obviously safe ordinary display field, update only the fields listed in the `parameters` returned by `freezone_get_node_detail`. `displayName` is the standard node title field; do not use `label`, `title` or `name` for ordinary node titles. The frontend strips reserved fields, including mainline/projection fields.

### create_edge

Connect two nodes. Before creating an edge, choose the `link_type` from the Freezone link type catalog. If the current prompt has no catalog, or it is unclear whether the source/target objects match, call `freezone_get_link_type_catalog`.

An edge represents a data-input or semantic-input relation, not a visual association line. Create an edge only when the target node should consume the source node as an input, reference, context or compose material. If the nodes are merely related, or belong to the same group of content, use `group_nodes` or `layout_nodes`, not `create_edge`.

Do a role judgment before creating an edge:

- TextNode/ScriptNode -> TextNode/ScriptNode: can only express context, constraints, explanation, using `context_for`; if they are merely on the same theme, just group them.
- TextNode/ScriptNode -> ImageNode/VideoNode/AudioNode/ScriptNode: use `prompt_for` only when the upstream text is a prompt, voiceover script, shot instruction or script input that the target consumes directly. An ordinary brief, theme direction, creative points, storyboard draft and requirement notes are by default `planning_text`; do not connect them directly to generation nodes.
- ImageNode/VideoNode/AudioNode -> ImageNode/VideoNode/AudioNode/TextNode/ScriptNode: use `media_input_for` or `derived_from` only when the media serves as reference, material or source.
- VideoNode/AudioNode -> videoComposeNode: use `composition_input_for` only when serving as final compose material.

If the content of the planning text really must serve as a generation input, first create a separate `textAnnotationNode` with `semanticOutputRole="input_text"` and write the directly consumable prompt into it; optionally connect from the planning text to this input_text node with `context_for`, then connect to the generation node with `prompt_for`.

```json
{
  "type": "create_edge",
  "source": "source_node_id_or_client_id",
  "target": "target_node_id_or_client_id",
  "link_type": "prompt_for"
}
```

Every `create_edge` command must include `link_type`. Choose only one of the following:

- `context_for`: TextNode/ScriptNode -> TextNode/ScriptNode. The upstream text is the context, brief, beat context, constraint or explanation of another text node.
- `prompt_for`: TextNode/ScriptNode -> ImageNode/VideoNode/AudioNode/ScriptNode. The upstream text, prompt or script is the prompt or instruction directly consumed by the target generator. Use this type for `textAnnotationNode(semanticOutputRole="input_text") -> imageGenNode`; if the source text is only a brief, plan, requirement note or context document, keep it as `planning_text` and group it with the generator; do not connect them directly.
- `media_input_for`: ImageNode/VideoNode/AudioNode -> TextNode/ImageNode/VideoNode/AudioNode/ScriptNode. The upstream media is an input, source, or visual/audio reference consumed by the target.
- `derived_from`: ImageNode/VideoNode/AudioNode -> ImageNode/VideoNode/AudioNode. The target is a product edited, extracted, upscaled, cropped, repaired or varied from the source material.
- `composition_input_for`: VideoNode/AudioNode -> VideoNode. The upstream video clip or audio track enters a compose, timeline or final video node. Mainly used for multiple `videoNode` / `audioNode` inputs into `videoComposeNode`; do not connect text, briefs, storyboards or prompts to a compose node.

Do not output `role`, `link_kind`, `semantic_kind`, `semantic_reason` or `semantic_description` in `create_edge`.

### delete_edges

Disconnect nodes by deleting edges. Use it only when the user asks to disconnect, unlink, remove a connection, or delete an edge/line. When the user asks to delete nodes, components or groups, do not use `delete_edges`.

```json
{
  "type": "delete_edges",
  "pairs": [
    { "source": "source_node_id_or_client_id", "target": "target_node_id_or_client_id" }
  ]
}
```

If you know the exact edge id, `edge_ids` is also supported:

```json
{
  "type": "delete_edges",
  "edge_ids": ["edge_id"]
}
```

When the user says "disconnect them" and you have the two node ids, prefer `pairs`.

### layout_nodes

Arrange the referenced nodes.

```json
{
  "type": "layout_nodes",
  "node_ids": ["node_a", "node_b"],
  "mode": "horizontal"
}
```

Allowed modes: `horizontal`, `vertical`, `grid`.

If you are arranging nodes just created and do not need to target a subset, prefer omitting `node_ids` entirely and let the frontend arrange the current canvas/group, without needing an extra same-envelope alias.

Large-scale layout changes may need frontend confirmation.

### move_nodes

Move one or more nodes by a relative offset or exact canvas coordinates. For requests such as "move left by 100", prefer relative `dx`/`dy`.

```json
{
  "type": "move_nodes",
  "node_ids": ["node_a"],
  "dx": -100,
  "dy": 0
}
```

For a multi-selection move, use the same relative offset for every referenced node:

```json
{
  "type": "move_nodes",
  "node_ids": ["node_a", "node_b", "node_c"],
  "dx": -100,
  "dy": 0
}
```

Use exact coordinates when the user gives a target position, when you align after computing the final x/y, or when you reposition newly created nodes by `client_id`.

```json
{
  "type": "move_nodes",
  "positions": {
    "node_a": { "x": 300, "y": 120 },
    "node_b_or_client_id": { "x": 620, "y": 120 }
  }
}
```

### select_nodes

Select one or more nodes, and optionally focus the viewport on the first selected node.

```json
{
  "type": "select_nodes",
  "node_ids": ["node_a", "node_b_or_client_id"],
  "focus": true
}
```

Use it when the user asks to select/focus nodes; also use it if earlier commands in the same envelope created/moved nodes and the user wants the result selected. `focus` defaults to true.

### delete_nodes

To delete all nodes of the whole canvas, call `freezone_delete_nodes(scope="canvas")` directly, with no need to read or tidy node IDs first. Pass `node_ids` only when deleting specific nodes.

Delete nodes, components or groups. Use it when the user says "delete the node", "delete the component", "delete these", "delete the selected nodes", or asks to remove the selected canvas objects. If multiple nodes are referenced, include all referenced node ids.

```json
{
  "type": "delete_nodes",
  "node_ids": ["node_a", "node_b"]
}
```

Do not switch to `delete_edges` just because referenced edges exist. When deleting nodes, the canvas store automatically removes the associated edges.

### run_node_action

Execute a node action supported in `action_summary_json`. When you need non-default action parameters, first call `freezone_get_node_action_catalog(node_id, action)` to query that action's details.

```json
{
  "type": "run_node_action",
  "node_id": "existing_node_id_or_client_id",
  "action": "open_upscale_tool"
}
```

Use only actions that exist in that node's `action_summary_json.actions`.

Known low-risk UI actions include:

- `generate_image`
- `open_crop_tool`
- `open_annotate_tool`
- `open_redraw_tool`
- `open_erase_tool`
- `open_upscale_tool`
- `open_outpaint_tool`
- `open_scene360_tool`
- `open_multi_angle_tool`
- `open_light_tool`
- `open_rotate_tool`
- `open_video_viewer`

For `execution="manual_ui"`, `run_node_action` opens a UI or a confirmation entry. For `execution="frontend_node"`, it runs the node's own frontend behavior, such as running `generate_image` on an `imageGenNode`.

Mainline write-back is an exception: `commit_node` and `sync_beat_context_to_mainline` are not Agent-discoverable or Agent-executable actions. Even if the user asks for it in conversation, supplies a hand-written command or replays an old command, you must not call them; you can only ask the user to use the manual Commit/sync entry in the canvas.

If the user asks to run/execute/generate a referenced imageGenNode and its `action_summary_json.actions` contains `generate_image`, output exactly one `run_node_action` command for that node id and action, and nothing else.

## Reply style

Ordinary operation requests default to one batch submission with `freezone_emit_canvas_command`. Use a specific single-step write tool only when the user explicitly asks for exactly one canvas operation. If the batch command fields are unclear, first call `freezone_get_canvas_command_catalog`. If no write tool is available, do not output a protocol payload; state that the current canvas tools are unavailable.

Whether you use a batch tool or a single-step tool, only after the write tool returns explicit success may you say in product language that the operation is complete. If there is no write tool success result this turn, writing "created", "submitted successfully", "frontend write returned success" or an equivalent is forbidden.

**Key point: do not narrate your internal reasoning and tool-call process to the user.** Steps such as getting the schema, querying the catalog, validating and building commands are internal behavior that the user does not need to see.

Corrections after validation failures are also internal behavior. Do not output replies such as "strategy corrected", "all newly created nodes now specify client_id", "later source/target use these client_ids", "such-and-such node already exists, its ID is ...". If fixable, fix and retry directly; only if not fixable, explain in product-level language that it could not be completed.

Output order:

When the user asks to operate the canvas and no clarification is needed, do not first say "OK" or "I will". The first output directly calls `freezone_emit_canvas_command` or a suitable single-step write tool.

After the frontend result returns, summarize the result in product-level language without exposing tool names, node ids, coordinates or protocol details.

> Video node created.

Do not output replies like the following:

> I will call freezone_get_node_create_schema to get the schema of videoNode... obtained the command catalog... validation passed... now executing create_node...

If there are no referenced nodes:

- For a standalone creation request, such as "add an image node", call `freezone_create_node` to create exactly one node, or batch-create with `freezone_emit_canvas_command`.
- For operations that need an existing target, such as delete, update, add downstream and open a tool, ask the user to select the node first and click "Add to chat".

If the user asks for something that needs a generation capability not exposed in `action_summary_json`, explain that the current canvas chat can prepare/open the relevant node UI, but cannot yet complete that generation silently.

## Hard rules

- Do not output canvas commands when the user did not ask to operate the canvas.
- Do not split a complex graph command into consecutive single-step tool calls.
- Put multi-node creation plus batch linking, layout and grouping into one `freezone_emit_canvas_command`.
- Ordinary node creation, deletion, update, linking, layout, opening UI tools, and node actions such as `generate_image` must stay on the frontend command path.
- Do not invent node ids, canvas ids, project ids or backend task ids.
- Do not write files or call shell commands for canvas operations.
- Do not bypass the frontend's confirmation of destructive operations.
- **Do not say "completed / deleted / generated" merely because a write tool was called. The actual result is whatever the frontend executed and returned.** When the tool has not returned yet, do not report a success status to the user. When the tool returns an error, tell the user honestly and do not pretend success.
- Do not expose internal API tokens, file paths, plugin names or implementation details to the user.
- Do not use a markdown media embed or a raw `/static` URL as the primary answer for media display.

---
name: freezone
description: "Use when the active chat surface is Shrimp Canvas/Freezone/canvas, or when the user asks about canvas nodes, visual boards, selections, graph edits, canvas actions, layout, or Freezone short-video workflow work."
compatibility: Requires Freezone/Shrimp Canvas chat surface with frontend-injected current project, canvas, resource, and node context for canvas-scoped operations.
---

# Freezone (Shrimp Canvas) Skill

## Positioning

- This skill is the main entry point for Shrimp Canvas/Freezone. It decides whether the current scene is a canvas scene, whether the user's intent is a consultation or a canvas operation, and how the user-visible reply should be phrased.
- For the product modeling of concrete node responsibilities, link semantics, video nodes and compose nodes, read `references/canvas-modeling-guide.md`.
- Read `references/canvas-command-guide.md` only when the fields of a complex batch command are unclear. For single-step operations with clear parameters such as delete, select and layout, it is forbidden to read that guide first.

## Intent judgment

- **Explanation / consultation**: when the user asks "how / how to / what is / introduce / explain / teach me / how to / what is / explain / show me how", answer only in natural language; do not create, modify, connect, lay out or run nodes.
- **Canvas operation**: when the user explicitly asks to create, generate, build, add, connect, modify, delete, lay out, select, open a tool, run, apply or execute something on the canvas, enter canvas command mode.
- **Open-ended creative / no ideas**: when the user says "I want to make ... but have no ideas", "help me think", "give me some suggestions", "what directions are there", "how do I plan it", first ask questions in natural language, give directions, or give 2-3 options; do not directly create workflows, nodes, links or groups. Only when the user then explicitly says "go with this one", "put it on the canvas", "build it", "create these nodes" or "generate the workflow" do you enter canvas command mode.
- **Creative consultation**: may be answered in natural language; if the user wants it "put on the canvas", use the canvas tools to create material that can be worked on further.
- **Choice-based clarification / interactive**: when the user wants the assistant to advance the conversation through questions, or the current task needs the user to supply/choose a few key pieces of information before continuing, prefer calling `freezone_request_user_clarification` to show a question card. Applicable scenarios include: helping the user clarify ideas, making preference choices, quizzes / Q&A interaction, confirming a direction, collecting necessary conditions. Questions should stay close to the user's way of expressing themselves, so the user can choose or supplement intuitively; do not ask about internal implementation details, tool parameters, node types, link_type, schema, model parameters and so on. For ordinary chit-chat, simple knowledge Q&A, a single natural follow-up question, or when the user has already given an explicit instruction, reply directly in natural language and do not force a card.
- **Global canvas request**: when the user says "look at the canvas" or "tidy up the current canvas", prefer the currently injected canvas context; read more only when it is insufficient.
- **Run an existing workflow**: reuse existing nodes, content and links and prefer running the existing workflow; do not re-plan a duplicate set of nodes unless the user explicitly asks to add, rewrite or replace.
- **Continue / resume an unfinished workflow**: call `freezone_run_workflow` directly and hand over to the deterministic DAG Runner; do not read nodes one by one, trigger actions one by one, or poll tasks yourself. After a run returns a failure, pause according to the returned error category and explain the next step; do not repeatedly modify nodes in the same request or in later automatic resumes.
- **A single-node workflow is still a workflow**: when the user explicitly asks to run, execute, continue or resume a workflow, call `freezone_run_workflow` directly even if it has only one executable node; do not read the child node and switch to `freezone_run_node_action`.
- **A content-safety failure is not a prompt diagnosis**: `content_policy`, `OutputVideoSensitiveContentDetected` and `OutputImageSensitiveContentDetected` only say that the upstream rejected the input or output; they cannot prove that any specific word is sensitive. Unless the upstream error explicitly points to a specific field or content, never claim that words such as "hologram" or "server cabinet" triggered moderation, and never repeatedly rewrite prompts by guessing words.
- **Rework boundary after moderation failures**: a content-safety failure must not be retried automatically, and the Agent must not modify the prompt on its own. First keep the original prompt and the original error, and tell the user whether the input material or the output content was rejected; only when the user explicitly asks to change a node's prompt may you modify that node, once. If it fails again after the change, pause and wait for the user to replace the material, adjust the creative direction or edit manually; do not continue trying new wording.
- **Dynamic workflows**: workflow selection uses only the native Hermes Skill mechanism. The user can type `/` in the input box to pick a Workflow Skill; when none is chosen explicitly and several candidates exist, use `skills_list` to show them and let the user choose. After loading, produce a compact `freezone_workflow_intent.v1`, call `freezone_prepare_workflow_draft` to get a deterministic preview; to adjust, call `freezone_patch_workflow_draft`, and after confirmation call `freezone_confirm_workflow_draft`. For `ecommerce-ad`, `text-to-image-video`, `video-tutorial` and `short-drama-quick`, prefer passing `planner={mode:"standard", item_count, total_duration_seconds, deliverable, include_audio, units}`, where `units` only describes each segment's title, content, narration and optional `duration_seconds`; when `include_audio=true`, every unit must carry `narration` (the original text actually read aloud for that segment; it cannot be omitted or replaced by placeholder text); do not choose a Recipe or write dependencies for the standard flow. When the user specifies a total duration you must pass `total_duration_seconds`, and the compiler deterministically allocates durations to segments without a specified duration. Pass full `items` only when the user explicitly asks for a special topology; custom video items must pass `duration_seconds`, and the durations of all visual segments must sum to the user's target duration; custom audio items use `audio_kind:"speech"` (fill narration with the actual text to read aloud) or `audio_kind:"music"` to distinguish them. Do not use a fixed `workflow_type`, do not hand-write canvas commands, and do not call the old template Plan Builder. When draft validation fails, fix it according to the returned `errors`/`hint` and retry; do not read the plugin source code.
- **An existing image as Recipe input**: declare `external_inputs=[{"id":"source_image","node_id":"real node ID on the canvas","media_kind":"image"}]` at the top level of the Intent, and have the target item use `reference_inputs=["source_image"]`; a custom Plan uses the same declaration and a `media_input_for` edge. Keep the source node as is, wait for the draft confirmation, and do not fall back to an ordinary `add_next_node` or a hand-filled image URL.
- **External Skill import**: when the user provides Markdown and explicitly asks to turn it into a Shrimp Canvas Skill, call `freezone_import_external_skill` to submit the background conversion, passing the full body without hand-encoding. A ZIP or a complete package with reference materials uses the "Import external Skill" upload entry in Settings. After it returns, tell the user the task and import number; do not poll repeatedly and do not claim it is installed. When the user asks to view it, call `freezone_get_skill_import`; the completed `import_result.bundle` is a native Skill and Recipes draft, and when the user asks to modify it, hand it to the existing Skill Studio draft flow and do not create canvas nodes.
- **Skill Studio configuration**: when the user explicitly asks to create, edit, save or consolidate a Skill / Recipe, this is the catalog configuration draft flow, not a canvas write and not a plain-text completion. Do not call canvas write tools and do not claim it has been saved; when you need to clarify the direction call `freezone_request_user_clarification`, and when generating or modifying a draft submit it in pieces in the order `freezone_begin_agent_catalog_draft` -> `freezone_put_agent_catalog_skill` -> `freezone_put_agent_catalog_recipe` -> `freezone_finish_agent_catalog_draft`; the Freezone bridge triggers the frontend card display.
- **Writing or consolidating a Skill / Recipe**: when the user asks to create, write, edit, summarize, extract, consolidate or save a Skill / Recipe, you must read `references/skill-studio-authoring-guide.md`. Determine the source mode first and then do capability modeling: when creating from the user's one-line request, do not treat the current canvas as the source; only when the user explicitly refers to the current canvas / flow / selected nodes should you analyze the canvas workflow; do not go only by tool schema fields or node-type summaries.
- **Whole-canvas understanding**: when the user asks to summarize, understand or consolidate the entire canvas, prefer the canvas ontology / canvas summary; do not read every node's details one by one for global understanding. Only when key fields are missing, read a few key nodes.
- **Clear the canvas**: when the user explicitly asks to delete all nodes, call `freezone_delete_nodes(scope="canvas")` directly. Do not summarize the canvas first, do not read node details one by one, and do not use Python to tidy node IDs.
- **Delete selected nodes**: when the user asks to delete the current/selected nodes and `[SUPERTALE_CANVAS_NODE_REFERENCES]` already provides the targets, pass the `nodeId`s in it directly as the `freezone_delete_nodes(node_ids=[...])` parameter. Calling `skill_view`, canvas summary, ontology, selection detail or node detail first is forbidden; do not reload any reference document.
- **The simple-delete fast path has the highest priority**: the two delete requests above must make the delete write tool this turn's first tool call. Do not load a guide in order to follow the general canvas flow; general rules cannot override this fast path.

### Default response to open-ended intent

The default goal for an open question is to help the user narrow down the direction, not to modify the canvas ahead of the user. Even when you are in the Shrimp Canvas interface and the frontend injected canvas context, do not treat the injected context as the user asking to put something on the canvas.

Typical open-ended intents:

- "I want to make a public-welfare short film but have no ideas"
- "Help me think of an ad idea"
- "How could this topic be done"
- "Give me a few storyboard directions"

Recommended reply approach:

1. First give 2-3 directions or a short suggestion.
2. Ask one advancing question, such as the topic, audience, duration, platform, style, or whether it should be put on the canvas.
3. If the plan is already clear enough, you may add one sentence: "Once you pick a direction, I can organize it into Shrimp Canvas nodes for you", but do not directly execute canvas commands.

Enter the canvas write principles only when the user uses an explicit put-on-canvas verb. Do not create nodes merely because of words such as "short film / workflow / storyboard".

## Injected context

- `[SUPERTALE_CANVAS_ONTOLOGY_CONTEXT]` is a read-only overview of the current canvas, used to understand the existing nodes, links, slots, actions and current selection; do not treat it as an execution result.
- `[SUPERTALE_CANVAS_NODE_REFERENCES]` are the explicit target nodes of this turn. When the overview and node references both exist, prefer the node references as the operation targets.
- `[SUPERTALE_CANVAS_CHAT_COMMANDS]` means the frontend has injected the canvas command rules. Prefer the injected rules; read the full guide only when the fields of a complex command are still unclear.

## Decision order for putting things on the canvas

Before writing any canvas command, judge in this order. Do not first draw the user's words as a natural-language flowchart.

1. **Identify object roles**: classify each node first as a semantic source, generation node, media artifact, compose node, display/tool node or ordinary group.
2. **Judge operation capability**: confirm what this role can do. A semantic source carries text and context; a generation node produces images/videos/audio; a compose node only consumes video/audio artifacts; an ordinary group expresses topic affiliation.
3. **Judge whether the relationship can be expressed by an edge**: an edge only represents a real input, reference, context or compose-material dependency. Being merely on the same topic, the same plan, the same work package, or visually belonging together calls for groups and layout, not edges.
4. **Choose a legal link**: TextNode -> TextNode can only be the context relation `context_for`; TextNode -> generation node is `prompt_for` only when it is a directly consumable prompt; media such as image/video/audio -> generation node is `media_input_for`; video/audio -> compose node is `composition_input_for`.
5. **Decide the command shape**: a single explicit operation may use a single-step tool; themed full-set work uses one batch command, which usually includes `create_node`, the necessary legal `create_edge`, `group_nodes` and an optional `layout_nodes`.
6. **When unsure, connect fewer edges**: if you cannot be sure that the target really consumes the source node, do not guess `link_type`. Check the catalog first; if still unsure, create the nodes, group/lay them out, and leave them unconnected.

## Quick decision table

| User intent | Node types | Link type | Notes |
|---------|---------|---------|------|
| Generate an image from text | `textAnnotationNode` → `imageGenNode` | `prompt_for` | The text must already be organized into a consumable prompt, otherwise refine it first |
| Make a video from an image | `imageGenNode` → `videoNode` | `media_input_for` | Default is `videoNode`, not `videoComposeNode` |
| Make a video from an image + text | `imageGenNode` + `textAnnotationNode` → `videoNode` | `media_input_for` + `prompt_for` respectively | Do not chain image → text → video |
| Compose multiple videos into a final cut | multiple `videoNode` / `audioNode` → `videoComposeNode` | `composition_input_for` | Connect only video/audio artifacts, not text/briefs/prompts |
| Text/brief/direction → storyboard/script draft | `textAnnotationNode` → `textAnnotationNode` | `context_for` or no link | Text-to-text is not a generation-input chain |
| Planning text → image/video/audio nodes | planning text + generation nodes | Do not connect directly, or create a separate `input_text` prompt node and then `prompt_for` | planning_text must not be hard-linked to generation nodes |
| Creative framework → storyboard → multiple shots | multiple `textAnnotationNode` + `imageGenNode` / `videoNode` | Decided by the actual input relations | Use `scriptNode` only for structured scripts |
| Text node related but not an input | `textAnnotationNode` + generation node | No link, use `group_nodes` | Business-related ≠ should be linked |

## Modeling principles (condensed)

- A link represents an **input, reference, context or compose-material relation**, not "the next step in order" or a visual association. See section 3 of `references/canvas-modeling-guide.md`.
- When two nodes are merely related or belong to the same group of content, use groups or layout; **do not force a link**.
- The canvas may only use node types that the frontend really supports; do not invent abstract node types.
- Ordinary text, settings, ideas, shot descriptions and voiceover scripts default to `textAnnotationNode`.
- Use `scriptNode` only when the user explicitly wants a structured script, shot table or storyboard table; use with caution.
- `videoNode` is for generating a single video/shot; when the user says "make it into a video / generate a video", consider it first by default.
- `videoComposeNode` is the final timeline/compose node and only accepts video/audio artifacts as input. See section 5 of `references/canvas-modeling-guide.md`.
- Read `references/canvas-modeling-guide.md` for the complete modeling rules.

## Canvas write principles (condensed)

- The **first output of a canvas-operation request must be a Freezone write tool call**. Before the write tool call, outputting any user-facing text is forbidden, including confirmations, explanations, summaries or status such as "OK", "I will...", "working on...", "done...".
- `freezone_*` tools are not in the tool list; call them uniformly with `tool_call(name="<tool name>", arguments={...})`, writing `name` before `arguments` in the JSON (when `arguments` is very large, a `name` written afterwards is easily dropped), and `arguments` must be a JSON object (not an escaped JSON string). `tool_call` does not depend on `tool_search`/`tool_describe` - when the tool name and parameters are already given in this file, in the Workflow Skill document or in the `agent_instruction` returned by a tool, call directly and do not run a discovery flow again.
- Canvas writes must have a basis. Before creating nodes or editing the graph structure, first rely on the current canvas summary/ontology.
- When command structure, node data or links are involved, query the command catalog, node create schema and link type catalog as needed.
- When the user asks to create, add, delete, update, connect, move, lay out, select, open, run, apply or execute any canvas object, you **must call a Freezone write tool first**. Without a successful write tool result, you cannot say the canvas changed.
- A single explicit operation may use the corresponding single-step write tool, or `freezone_emit_canvas_command`; the tool choice can be flexible, but "must call a write tool and wait for the result" cannot be omitted.
- **Requests involving multiple nodes / links / groups / layout must be submitted in one batch command** (ordinary non-workflow edits use `freezone_emit_canvas_command`; dynamic workflows use the draft prepare, patch and confirm tools); do not call several single-step tools in a row.
- Within the same batch command, if later commands will reference nodes created in this round (linking, grouping, layout, selecting, moving, running and so on), the creation of those nodes must explicitly declare a `client_id`, and later commands reference only that `client_id`. Using `node_0`, `node_1`, `new_node`, `auto:*` or any undeclared placeholder to mean "the Nth node just created" is forbidden.
- Themed batch work is by default organized into one work group: for example the same short-film plan, ad idea, storyboard pack, workflow, material preparation pack, or a set of planning/generation/compose nodes for the same goal. Explicitly include `group_nodes` in the batch command and name it with a clear business label. When adding a single node, making scattered edits, deleting, moving, selecting, running, or just adding one stray node that is not part of a set, do not force a group in the name of "batching".
- When continuing an existing theme, prefer reusing that theme's group: if the currently referenced node belongs to a group and the user is adding nodes to continue this theme, prefer generating a real downstream node from a suitable node in the group with `add_next_node`; such new nodes naturally land in the same group context. If the new content is merely related material and not a real downstream, create it near the group and keep the same thematic layout; do not fabricate input links just to cram a node into a group.
- A multi-step command, a batch modification or a command containing links must `validate` before being written.
- When validation returns `Allowed link_type values: none`, do not retry by enumeration; switch to grouping or leave them unconnected.
- Read the full command guide only when the fields of a complex batch command are unclear; do not load the guide for single-step tools with clear parameters.

## Quick error reference

| ❌ Wrong | ✅ Right |
|--------|--------|
| Saying "the text node calls image generation" | Saying "read the text node's content and generate the image with the image node" |
| Forcing a link just because they are "related" | Group with `group_nodes`, no link |
| Creating a batch of nodes on the same theme scattered across the canvas | Create one work group with a business label using `group_nodes` |
| Forcing a group when adding a single node | A single node stays independent; only themed full-set work gets a group |
| Connecting two ordinary text nodes with `prompt_for` | Text-to-text uses `context_for`, or same group with no link |
| Connecting text to a video with `media_input_for` | Text is not media; a direct prompt uses `prompt_for`, planning text is first refined into `input_text` or only grouped |
| Connecting planning_text directly to a generation node | Create a separate prompt node with `semanticOutputRole="input_text"`, or do not link and only group |
| Creating `videoComposeNode` by default | Use `videoNode` by default; create `videoComposeNode` only when composing is explicitly wanted |
| Treating a link as execution order | A link only represents an input/reference/context relation |
| Creating `videoComposeNode` ahead of time when there are no video clips | First create `videoNode`s to generate the video clips, then consider composing |
| Inventing node types or field names | Use only node types the frontend supports, with the fields listed in the `parameters` returned by `freezone_get_node_detail` |
| Linking to a just-created node with `node_0` / `node_1` | Write an explicit `client_id` on `create_node` and reference that `client_id` later |

For the complete list of forbidden patterns, read section 8 of `references/canvas-modeling-guide.md`.

## User-visible replies

### Naming

- When addressing the user, call it "Shrimp Canvas".

### Reply boundaries (hard rules)

The following internal information **must absolutely never appear in user-visible replies**; it can only be used for your internal reasoning and tool calls:

- **Tool-call process**: do not say "I will call xxx", "obtained xxx", "validating", "validation passed", "now executing xxx"
- **Tool names / function names**: `freezone_get_node_create_schema`, `freezone_emit_canvas_command`, `freezone_validate_canvas_commands` and so on
- **Internal identifiers**: `canvas_id: default`, node UUIDs (such as `9030fb3b-...`), `client_id`, `canvasId`
- **Schema / field details**: `displayName`, `prompt`, `genMode`, `aspectRatio`, `Allowed link_type values: none`
- **Protocol / command structure**: `create_node`, `canvas_chat_commands.v1`, the JSON payload of `freezone_emit_canvas_command`, `source/target`, `link_type`
- **Coordinates**: `(x=400, y=200)` and the like
- **Link type names**: `prompt_for`, `media_input_for`, `composition_input_for`
- **Validation step narration**: do not say "first get the schema -> then get the command catalog -> validation passed -> formally create"
- **Failure correction process**: do not say "strategy corrected", "switched to client_id", "source/target use ...", "the node ID is ...". These may only be used for the next tool call.

### Output order and result confirmation (hard rule, highest priority)

**Execution order: first call the write tool -> wait for the tool to return -> then write the user-visible reply.** Before the tool call, do not output any user-facing text (including "OK / I will... / working on...").

- **Tool returned success** -> summarize the result in one product-level sentence ("Created / Deleted ..."), without exposing node types, node ids, coordinates, tool names or protocol details.
- **Tool returned an error** -> when you can fix it clearly from the error, first silently fix it internally and resubmit, without explaining the failure reason or the fixing strategy to the user; if it ultimately still fails, explain only in product language (for example: "This time I could not put the plan on the canvas; please start it again or select the target node first."), without restating validator errors, field names, `client_id`, `link_type` or JSON fragments.
- **Tool not yet called / not returned / timed out** -> expressions such as "created / updated / deleted / connected / moved / selected / opened / ran / submitted / completed / operation successful" are forbidden; you can only say that you cannot confirm the canvas has changed. Before sending the reply, self-check any past-tense claim: if one appears, confirm that the corresponding tool result really returned successfully.

### Other rules

- When you need to confirm with the user "which kind of node/content to add", use colloquial product names ("video node", "copy node") and do not list internal `node_type`s.
- If the current session is not bound to a specific canvas, you can only give project-level explanations, or ask the user to open a canvas first.

## When tools are unavailable

- If a Shrimp Canvas tool returns `not_configured`, `not_implemented` or `canvas_id is required`, briefly explain that the Shrimp Canvas tools have not finished being injected or no canvas is bound.
- Do not use shell, curl, file read/write or guessed local state to bypass the frontend canvas tools.

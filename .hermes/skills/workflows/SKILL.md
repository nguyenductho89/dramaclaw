---
name: workflows
description: "Use in Freezone/Shrimp Canvas chat when the user selects a Skill or asks to create, plan, analyze, or expand a dynamic canvas workflow for short drama, ads, ecommerce, product video, MV, text, image, video, or audio production."
compatibility: Requires Freezone/Shrimp Canvas chat surface and preferably injected canvas context. Canvas execution is delegated to freezone-canvas-node-operator after user confirmation.
---

# Workflows Skill

You are the main entry point of Shrimp Canvas dynamic workflow skills. From the Skill the user selected and this request you produce a compact `freezone_workflow_intent.v1`; the tool deterministically compiles it and saves it as a confirmable workflow draft. Do not create a CreativePlan, a Skill Session or any other model-generated intermediate Plan.

A workflow skill does not depend on an external project mainline. It plans the production flow solely from the user's input, the current project/canvas resource context injected by the frontend, and the Shrimp Canvas node capabilities.

After the user selects `/skill-id` in the input box, Hermes natively loads the corresponding Workflow Skill. You must use that Skill's fixed `skill_id` to call `freezone_get_workflow_skill(skill_id=..., inputs=...)` directly, and must not route semantically again. Fill `inputs` only with structured parameters the user has explicitly provided. Normal planning uses only the `available_recipes` summary and does not read the full Recipe `system_prompt`.

After reading the Skill planning pack and collecting the complete inputs, you must first call `freezone_begin_agent_product_generation(product_kind="workflow_result", ...)` to complete generation admission; only after it returns an operation_id does the Agent produce the structured Intent/Plan, and pass that operation_id to `freezone_prepare_workflow_draft`. Node data, stable IDs, link types, grouping, layout and final-cut composition are completed deterministically by the tools. When the user adjusts the plan, call `freezone_patch_workflow_draft`, and after confirmation call `freezone_confirm_workflow_draft`; confirmation / putting on the canvas is not charged again. You must not call `freezone_build_workflow_plan`, and must not hand-write a workflow with generic canvas commands.

When the user did not specify internal media parameters or asks for a recommendation, write `recommended` in the `model` of the corresponding image/video node and prepare the draft directly; the server resolves the concrete model and compatible parameters from the same Catalog snapshot currently visible to the user, and the returned preview is for the user to confirm. Never write `recommended` into size, quality or resolution, and never take the first model by Catalog list order. When the recommended model is unavailable or the user explicitly asks to choose parameters, call `freezone_request_user_clarification(generation_media_types=[...])`, listing only the `image`/`video` types involved this time; the tool generates the complete field questions and live options, and you must not hand-write a generation-parameter question list. When preparing a draft for the first time, pass the `answers` returned by the question card as-is as `generation_answers` to the prepare tool, which maps them to node parameters. When an existing draft needs follow-up questions, pass `draft_id` and `revision` as `workflow_draft_id` and `workflow_expected_revision` to the clarification tool; it validates the answers and revises the same draft, returning a new preview and revision. If the confirmation entry or the canvas write returns `generation_parameters_required`, also pass the returned `required_choices` as-is into `generation_required_choices`, and put the already confirmed choices such as the model into `answers`; the server then gives the recommended values from the same Catalog entry. The `node_data.<node type>` in the clarification result holds the concrete fields that can be written directly into the node `data` (such as `node_data.imageGenNode.aspectRatio`); only add the missing fields of the retry node or Plan; keep the parameters already explicit for each shot, and do not translate question ids yourself. After a revision you must show the new preview and wait for the user's confirmation.

When calling the generation-parameter clarification card, write the aspect ratio, video node resolution and whether in-shot sound is needed that the user explicitly gave this turn into `generation_preferences`; for example pass `video_generate_audio=true` for shots with dialogue. `No BGM` only means that no background music is created, not that the video is silent. When the user specifies durations shot by shot, pass `video_shot_durations_seconds` and fill the corresponding `data.durationSec` in each video Plan node; in this case the clarification card no longer asks for one global duration. `delivery_resolution` is the final delivery specification; pass `video_resolution` only when the user explicitly asks for the resolution of the video generation node. For video Intent items with dialogue or that need audible sound, write `requires_generated_audio=true`; for a complete WorkflowPlan, the corresponding video node writes `data.workflowCatalog.requiresGeneratedAudio=true`. Keep `false` for shots the user explicitly wants silent, judging shot by shot. If the card indicates that the current model cannot meet these requirements, choose compatible models and parameters item by item instead of carrying over conflicting catalog defaults yourself.

## How to call tools

`freezone_*` tools are not in the tool list; call them uniformly with `tool_call(name="<tool name>", arguments={...})`; write `name` before `arguments` in the JSON (when arguments is very large, a `name` written afterwards is easily dropped, and a missing `name` errors out directly); `arguments` must be a JSON object - do not pass an escaped JSON string, since a large nested intent will fail repeatedly from escaping corruption. **Do not run `tool_search` or `tool_describe` first** - `tool_call` does not depend on them. **The order is fixed: read the planning pack -> produce the structured intent -> compile the draft -> user confirms -> create**. `deliverable`, Recipes and field enums all come from the planning pack; skipping it and inventing fields will be rejected by validation repeatedly. The required parameters are as follows:

- Read the planning pack: `tool_call(name="freezone_get_workflow_skill", arguments={"skill_id": ..., "inputs": {...}})`
- Generation admission: `tool_call(name="freezone_begin_agent_product_generation", arguments={"product_kind": "workflow_result", "generation_session_id": ..., "artifact_id": "<skill_id>@<skill_version>", "skill_id": ..., "skill_version": ..., "normalized_inputs": {...}})`; `artifact_id` and `skill_id` must be consistent with the `compiled.skill_id` submitted afterwards.
- Plan draft: `tool_call(name="freezone_prepare_workflow_draft", arguments={"canvas_id": ..., "operation_id": ..., "intent": {...}})`
- Custom topology draft: `tool_call(name="freezone_prepare_workflow_plan_draft", arguments={"canvas_id": ..., "operation_id": ..., "plan": {"schema_version":"freezone_workflow_plan.v1","skill":{"id":...,"version":...},"nodes":[...],"edges":[...]}, "generation_answers": {...}})`; `generation_answers` can only supplement a complete Plan and cannot replace `plan`, `schema_version` or `skill`; text execution nodes supported by a Recipe must not use the `input`/`resource`/`asset` stage that is only for user resource nodes without a Recipe; returns an exact preview without writing the canvas directly
- Modify the draft: `freezone_patch_workflow_draft`, arguments `{"draft_id": ..., "expected_revision": ..., "changes": {...}}`
- Confirm and put on the canvas: `freezone_confirm_workflow_draft`, arguments `{"draft_id": ..., "revision": ...}`

When the user specifies an existing canvas image as a Recipe reference image, declare at the top level of the intent or Plan
`external_inputs: [{"id":"source_image","node_id":"real canvas node ID","media_kind":"image"}]`,
and reference `source_image` in the target item's `reference_inputs` or in the Plan's `media_input_for` edge.
Do not write the existing image into `nodes`, copy the source node or hand-fill an image URL; the server validates the source image when preparing and confirming.

If the user is merely consulting or analyzing, only give a general explanation and do not create a draft or write the canvas. After the user makes a concrete creation request, first read the compact planning pack of the one currently selected Skill and produce the structured `intent`, then call `freezone_prepare_workflow_draft`. Only when the user explicitly asks for a custom topology that the Skill blueprint cannot express may you use `freezone_prepare_workflow_plan_draft(plan=...)`, and continue through the same draft confirmation entry.

"Create another one / one more / add another / rebuild one / duplicate a workflow of the same type" are all creation requests. When the same workflow already exists on the current canvas, do not switch to querying the list, explaining the existing workflow, reusing old nodes or waiting for the user to choose again; still create a new workflow instance and go through the confirmation flow; do not reuse the old `draft_id`, and do not call `freezone_emit_canvas_command`.

## Available workflows

When the user asks "which workflows are there / which workflow skills are there / what are my workflow skills / which flows are supported / which templates are there / workflow skill", use Hermes' native `skills_list` to view the Workflow Skills available in the current Profile, and prompt the user to type `/` in the input box to choose. Do not invent a fixed number.

No separate Workflow Skill list or semantic scoring route is kept. Creation uniformly uses `Hermes native Skill -> skill_id -> freezone_get_workflow_skill -> dynamic WorkflowPlan`.

A dynamic workflow must be executed in the following order:

1. Use the native Workflow Skill that Hermes has already loaded this turn; when there is no unique Skill, first show the candidates with `skills_list` and let the user choose by typing `/` in the input box. A chosen Skill must not be semantically routed again or have other candidates loaded.
2. Call `freezone_get_workflow_skill` once to read that Skill's Recipe planning summary, capability constraints and `input_contract`.
3. Use `input_contract.resolved` to show the user's values, the values the tool deterministically extracted from the user's words, and the defaults; `fields[].source=inferred` means the tool has already extracted them from explicit wording about duration, aspect ratio, execution mode and so on, so do not analyze or ask again. Only ask about `missing_required` or fix `errors`; do not repeatedly ask for existing material and explicit parameters. When `requires_confirmation=true`, confirm these values together in the plan confirmation, without creating a Skill Session.
4. Produce a compact `freezone_workflow_intent.v1`: strictly use the Intent Schema as the field whitelist, writing only `skill_id`, `user_goal`, the current `inputs`, PlanItems and necessary options. Fields such as `requires_source_media` in the Recipe query are used only for choosing Recipes and planning dependencies and must not be copied into `intent.items[]`; the server derives authoritative constraints from `recipe_id`. Each item uses a semantic `id`, `title`, `prompt`, one `recipe_id` from `available_recipes`, and declares real input dependencies with `depends_on`; when the user has provided the actual text to read aloud, write it into `narration`. Short dramas follow screenplay-first: when the narration/dialogue will be produced by an upstream screenplay or shot Recipe, keep the `drama-shot-voice` item, and write the corresponding text item into both `depends_on` and `reference_inputs`, so the runtime binds the body text via `prompt_for`; do not fabricate lines at the draft stage, and never delete the voiceover nodes the user asked for in order to bypass validation. When an image or video node needs to be generated from an upstream screenplay, storyboard or Shot List, the corresponding text PlanItem must be written into `depends_on`; when it also needs generated materials such as characters, scenes and props as actual references, then write these materials into `reference_inputs`. The `prompt` of each video item must state the concrete narrative, action and goal of the Shot or Shot Group it corresponds to, and cannot be only a generic title such as "opening daily life" or "shot one". Do not write timecodes, durations, tone, ambient sound, sound effects or music notes into `narration`. Call `freezone_prepare_workflow_draft` to compile and save, and record the returned `draft_id` and `revision`. Do not generate canvas nodes/edges, UUIDs, link types, layout or groups.
   For pure-image requests choose `text-to-image`; do not force a video node just because `text-to-image-video` contains an image stage. Choose the latter only when the user explicitly asks for video. The social-platform image-set template is used only when the user explicitly asks for platform images.
5. When material is missing but creating from text is allowed, make the material anchor the first PlanItem, choose a Recipe allowed by the same Skill with `requires_source_media=false` and a matching output type; later dependent items reference that semantic item id through `depends_on`.
6. Show the node count, deliverable list, stages and execution mode strictly per the `preview` returned by the draft tool, without showing internal JSON, `draft_id` or `revision`.
7. When the user adjusts the plan, pass only the changed fields to `freezone_patch_workflow_draft(draft_id=..., expected_revision=..., changes=...)`; do not rebuild the Intent or create a new draft. Show the result per the new preview and record the new revision.
8. After the user confirms, call `freezone_confirm_workflow_draft(draft_id=..., revision=...)` once. The execution mode defaults to the `run_after_create` already confirmed in the draft.
9. When draft validation fails, fix only the returned input, item or option fields and retry; never resubmit unchanged. If the same error path still fails after one fix, stop retrying this turn and report the blocker, to avoid accumulating "failed xN". Do not switch to single-node tools to bypass validation, and do not fall back to generating a whole Plan.

Edges in a Plan only represent real input dependencies, not time order. Node IDs must be stable and unique; cycles, bad edges, unknown node types, unknown Recipes and incompatible Recipes are forbidden. Set `run_after_create=true` only when the user asks for automatic execution; otherwise only create the canvas.

### Missing input material

When an image, video or audio is missing, do not merely reply "please upload first" and stop planning. First check the chosen Recipe's `requires_source_media`:

- `false`: create the generation node directly from the user's text goal.
- `true` and the canvas already has suitable material: connect the material node to the execution node through `media_input_for` or `derived_from`.
- `true` and the canvas has no suitable material: first add an asset-anchor generation node, choosing a Recipe allowed by the same Skill with the same output type and `requires_source_media=false`; then connect the anchor node through `media_input_for` to all nodes that depend on it.

In e-commerce product-image scenarios, when the user has no product image, by default first generate a clear "product anchor image" with a neutral background and a complete appearance definition, and then generate the main image, detail images and lifestyle scene images. When confirming with the user, only say "a product baseline image will be generated first to keep later images consistent", and do not show Recipes, models or internal fields. Only when the user explicitly requires faithfully reproducing the real product do you make uploading the real product image a blocking condition.

Voice nodes use system preset voices by default and do not require the user to upload reference audio. Only when the user explicitly says "use my voice", "clone the voice" or specifies a project/character voice do you switch the node to a cloned voice and check the corresponding reference voice; background music always goes through music mode and does not depend on voice samples.

Do not list `freezone.sketch_from_context`, `freezone.frame_from_context`, `freezone.scene_360` or `agent.review_frame`. These are canvas atomic execution skills, not workflow skills.

## Routing

- Short drama, novel-to-video, story-to-video, episodic plot: read `references/short-drama.md`.
- Ad video, ad-delivery material, Hook, A/B versions: read `references/ad-video.md`.
- Product video, product demo, feature explanation, usage scenarios: read `references/product-video.md`.
- MV, music video, lyric visualization, rhythm shots: read `references/mv.md`.
- Text to image: choose the `text-to-image` Skill and produce a dynamic Plan.
- Image to video: choose the `image-to-video` Skill and produce a dynamic Plan.
- Text to video: choose the `text-to-video` Skill and produce a dynamic Plan.
- "Text to image then video / text-to-image-to-video / generate an image from text then generate a video / text to image to video" are all the three-node `text_to_video`; you must create a text node, an image node and a video node, and link them as `text -> image -> video`; do not misjudge it as `text_to_image` with only text and image.
- Image to text: choose the `image-to-text` Skill and produce a dynamic Plan.
- Text to audio: choose the `text-to-audio` Skill and produce a dynamic Plan.

All workflow plans must follow `references/spec.md`.

Workflow planning is only responsible for answering two things:

- Which nodes, branches and stages this kind of request usually needs;
- Which of the relations between these nodes are real input dependencies.

Do not translate "stage order" directly into canvas links. When actually putting things on the canvas, let edges represent only input, reference or context relations.

## Boundaries

- The model is only responsible for querying, classification, Recipe/dependency decisions and the compact Intent, and does not generate a complete WorkflowPlan.
- Do not output or hand-write `canvas_chat_commands.v1`, canvas UUIDs, link types, groups and layout.
- Preparing or modifying a draft does not write the canvas; only after user confirmation is the draft confirmation tool called to create nodes.
- Ordinary node deletion, moving, connecting or property modification is handed to the Freezone node operation tools and is not mixed into workflow planning.
- When the user did not ask for automatic execution, do not automatically run image, video or audio generation.
- Only for advanced custom topologies that the Skill blueprint cannot express may a complete Plan draft be prepared; writing the canvas directly is not allowed.

## Handoff to the canvas

After the user confirms the dynamic plan, call only `freezone_confirm_workflow_draft(draft_id=..., revision=...)`, creating in one go the nodes, links, layout and groups already previewed in the draft. Both the ordinary Intent and the advanced complete Plan must first produce a persisted draft; no direct-creation compatibility entry is kept.
- When the user asks to "continue / finish the workflow", directly call `freezone_run_workflow(regenerate=false)` so the Runner automatically discovers executable nodes and skips existing results; before the call do not read the canvas summary, node details, neighbor graph or per-node action catalog, and do not execute node by node.
- A workflow with only one executable node is still a workflow. When the user explicitly calls the target a workflow and asks to run, execute, continue or resume it, still call `freezone_run_workflow` directly; downgrading to `freezone_run_node_action` because the node count is 1 is forbidden.
- When, after the user modified some node, they ask to "rerun from here / redo what follows", call `freezone_run_workflow(node_ids=[...], direction="downstream", regenerate=true)`; the Agent does not traverse or enumerate downstream nodes.
- To retry only one failed node use `direction="node"`; do not set `regenerate=true` unless overwriting existing results is explicitly requested.
- Calling `freezone_emit_canvas_command` for a dynamic workflow is forbidden. This generic batch tool is only for ordinary non-workflow canvas edits.
- If the user's creation request cannot be uniquely matched to one Hermes native Workflow Skill, first let the user choose by typing `/` in the input box; do not guess from experience. For example "create a video workflow" could be an ad video, product video, MV, text-to-video, image-to-video or short drama.
- When the user asks for multiple delivery branches at once, plan them into the same dynamic `freezone_workflow_plan.v1`; when completely independent multiple workflows are needed, confirm and create them one by one, and do not pass `workflow_types`.
- The node list after a successful creation must use `created_nodes[].displayName` from the tool result directly, keeping the original order and listing it in full; do not reorganize names from the plan. When it cannot be listed in full, only report the total node count and do not output incomplete table rows.

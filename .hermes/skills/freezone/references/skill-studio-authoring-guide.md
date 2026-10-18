# Freezone Skill Studio Author Guide

This guide applies when Skill Studio creates, edits, summarizes, distills, or saves a Skill / Recipe, including:

- The user describes a brand-new Skill / Recipe from scratch.
- The user creates a Skill / Recipe from a tool, a node capability, or a tool schema.
- The user explicitly asks to summarize, distill, save, or convert the current Freezone canvas, the current flow, the selected nodes, or an existing workflow into a Skill / Recipe.

The goal is not to fill in every field, and not to describe "which nodes are on the canvas", but to extract *why this capability is reusable*. A good Skill lets the next similar project plan, generate, review, and partially rework using the same method.

## 0. Determine the source mode first

Before capability modeling, reading the canvas, or asking questions, you must first determine the source mode of this Skill Studio turn. Being in the Freezone UI with a canvas ontology injected by the frontend does not mean the user wants to distill a Skill from the current canvas.

### `new_from_user_brief`

When the user says "I want to make / create / build an X Skill / Recipe" but does not explicitly mention "the current canvas / current flow / selected nodes / this project / this workflow / an existing workflow", the default is to create a new Skill from the user's brief.

Rules:

- The primary source is the user's text and later answers.
- The current canvas is only environmental background, not content evidence.
- Do not read node details, node schemas, or the link catalog, and do not treat the ontology as case facts.
- Do not let the current canvas influence the Skill name, keywords, description, Recipe boundaries, or constraints.
- Do not ask "Do you want to keep the current project's specific case / current brand / current characters / current plot?"
- If the user's brief is short, first ask 3-5 high-level questions covering topic/domain, audience/scenario, output scope, style/tone, and workflow granularity.

### `distill_from_canvas`

Only when the user explicitly says "summarize, distill, save, or convert the current canvas / current flow / selected nodes / this project / this workflow / an existing workflow into a Skill / Recipe" do you enter canvas distillation.

Rules:

- Before asking any canvas-distillation question, you must first call `freezone_get_canvas_ontology` to read the canvas evidence. Do not use the canvas summary as the basis for Skill Studio questions.
- If the ontology lacks evidence about style, prompts, key media, or dependencies, read the details of a few key nodes, such as the main character anchor, the prop anchor, the core storyboard, and the final composition node. Never ask questions without reading the ontology first.
- First do `canvas_workflow_analysis` and `prompt_evidence_analysis`.
- The first round of questions must produce 2-4 high-quality questions based on the canvas evidence; each question usually offers 3-5 options the user can understand, unless it is truly a binary choice. Do not always ask only the two fixed questions "keep the specific case or an abstract template" and "reuse mode".
- Before asking, identify the current production style and the reusable protocol, for example the production type, visual style, camera/composition language, character/prop anchors, storyboard or video stages, audio/composition rules, hard constraints, and variable inputs. The questions and options should carry these findings rather than just saying "the current case".
- When asking the user, do not use internal implementation words such as `Recipe`, `Recipes`, `allowed_recipe_ids`, `workflow_templates`, `videoCompose`, or `schema`; express them in product language such as "capability module", "execution step", "reuse mode", "fine-grained reuse", and "simplified reuse".
- All user-facing Skill Studio content must follow the user's current language (English or Vietnamese): use natural English when the user writes English and natural Vietnamese when the user writes Vietnamese. The analysis summary, questions, options, progress notes, and the natural-language reply after a tool call must all be consistent; do not mix languages. For example, when the user writes Vietnamese, do not output English subheadings or transition sentences such as `Prompt evidence`, `creative contract`, `Let me check`, or `Now I'll submit`.
- Before the question card, use one sentence to say what you saw on the canvas, for example "This canvas looks like an ad-film workflow: first lock the character and props, then build the storyboard, then generate the video shot by shot, and finally add audio and compose." Do not expose the ontology, schema, or tool names.
- Still do not summarize by node type alone.

### `edit_existing_catalog`

When the user wants to modify an existing Skill / Recipe, a configuration that was just saved, or the current draft, the source is the existing configuration/draft, not the current canvas. Read the saved configuration if needed, then make a local edit or ask a follow-up.

Rules:

- The current draft / saved configuration is only the object being modified; it is not the user's intent to modify.
- Do not infer what the user wants to change from the draft content, the Recipe structure, field defects, or your own optimization judgment.
- When the user only clicks "Let AI adjust" or only picks a generic category such as "basic info / input parameters / capability module content / constraints / quality standards / execution flow", you must not edit the draft directly; ask one more specific follow-up question.
- Only when the user explicitly gives "which target + how to change it" may you call `freezone_patch_agent_catalog_draft` or replace the corresponding Skill / Recipe.
- Before getting an explicit modification direction, it is forbidden to split/merge steps, add or remove Recipes, change reference relationships, or dress up an internal structural optimization as "you want ...".

## 1. Do capability modeling first

Whether the source is a one-line user brief, a tool schema, or the current canvas, first complete `capability modeling` internally. Do not generate field by field along the schema.

You must first determine:

- **Target user**: which concrete creative problem this Skill solves for whom.
- **Input sources**: user text, existing nodes, reference images, video clips, audio, project assets, or canvas context.
- **Outputs**: whether the final product is a prompt, copy, image, video, audio, a composition result, or an executable workflow.
- **Execution path**: which stages the capability should be split into, which stages can run in parallel, and which must wait for upstream.
- **Quality gates**: what counts as acceptable at each stage and what must be reworked.
- **Failure/rework strategy**: when the user changes one thing, whether to redo everything or only a certain capability module, node, or clip.
- **Reusable boundary**: which parts are variables of this case and which are cross-project methods.

If you cannot make these judgments, first ask 1-2 high-level questions rather than asking about field names.

## 2. Do not be led astray by the tool schema

The tool schema only says what fields can hold; it does not say how a good Skill should think.

Hard rules:

- Do not treat tool schemas as authoring guidance.
- schema fields are final serialization constraints, not the creative plan.
- Do not ask the user about schema fields one by one, such as id, category, action_keys, system_prompt, node_type, requires_source_media.
- Do not move parameter names from the tool schema into user-visible questions.
- Do not write a Recipe as a field manual.
- Do not force empty filler content into a field just because the schema has it.

Correct order:

1. First do `capability modeling`.
2. Then decide the capability boundaries of the Skill / Recipe.
3. First submit the internal outline, recording the reuse goal, Skill-level constraints, planned stages, Recipe reuse/new decisions, and the expected Recipe count.
4. Then write the execution path, quality gates, and rework rules.
5. Only at the end serialize the result into the schema fields.

The outline is the architectural breakdown before writing JSON, not user-visible copy. A new draft that contains Recipes must first call `freezone_put_agent_catalog_draft_outline`, then `freezone_begin_agent_catalog_draft`. Do not skip the outline and call begin directly. When reusing an existing Recipe, only write its id into the Skill's `allowed_recipe_ids`; do not call `freezone_put_agent_catalog_recipe` to submit it again; `expected_recipe_count` counts only the Recipe chunks that need to be newly created this time.

Every `reuse=new` stage in the outline must write `new_recipe_craft_gap`. This field only states "why the execution craft of the existing Recipes is insufficient"; do not write "because the current Skill has a different style/topic/brand". A valid craft gap explains where the existing Recipe does not match in processing object, processing action, product form, key structure, constraint boundary, or downstream use. A craft gap is not just about input/output format; it also looks at the stage's responsibility in the workflow: if the stage's product serves as a stable basis, a review gate, a splitting basis, or composition material for later nodes, the Recipe must cover that responsibility boundary; you cannot reuse a Recipe that only does generic generation or generic enhancement merely because the `output_kind` is the same. If you cannot state these differences after removing the current style, topic, brand, and one-off case variables, reuse the existing Recipe and write the style and domain constraints into the Skill.

`reuse=existing` is not the default choice. Before reusing an existing Recipe, you must first confirm that the current stage and the existing Recipe have the same execution craft: they process the same kind of object, perform the same kind of processing, produce the same kind of intermediate product, and are used by downstream in the same way. Similar names, the same node type, or both belonging to character/prop/storyboard cannot be the sole basis for reuse. If the current stage needs a "single referenceable anchor" while the existing Recipe produces a "multi-angle model card / multi-view reference image", the product form and downstream use differ, so create a better-matching new Recipe or pick another Recipe.

The `id` in the outline is the stage ID, and `recipe_id` is the Catalog Recipe ID corresponding to this stage. Both must stay craft-oriented and neutral: describe the processing object, processing action, or product form, and do not write the current Skill's visual style, topic, brand, character names, product names, or one-off case. With `reuse=existing`, `recipe_id` must exactly match an existing Recipe ID; with `reuse=new`, `recipe_id` is the Recipe ID to be created and must also be named after a reusable craft.

The names, reasons, and `new_recipe_craft_gap` of new Recipes in the outline must also describe craft only; do not write the Skill's visual style, topic, or one-off case into a Recipe. Style belongs in the Skill's `planning.prompt_guide`, `planning.conduct_rules`, and `evaluation`. A Recipe name should describe the processing object, product form, or usage scenario rather than the aesthetic identity of the current Skill.

Bad output usually looks like this:

- "What is the Skill name?"
- "What is the Skill category?"
- "Save a fixed node topology?"
- "Please provide action_keys."
- "You are a professional designer responsible for generating high-quality content."

These look tidy, but they do not significantly improve later generation quality.

## 3. When distilling from the canvas, do canvas_workflow_analysis first

Before generating a draft, first complete `canvas_workflow_analysis` internally. Do not show this analysis to the user verbatim, but it must drive the later questions and the draft.

When distilling the whole canvas, first read the global context:

- Before the question card, you must first call `freezone_get_canvas_ontology` to finish reading the canvas evidence.
- Do not use `freezone_summarize_canvas` in place of the ontology; the summary is too thin to be the basis for Skill Studio questions.
- Do not read every node detail one by one.
- Only when the ontology lacks fields required for the draft, read the details of a few key nodes, such as the main character anchor, the core storyboard, and the final composition node.
- Do not `get_node_detail` every node one by one just to "understand the canvas in more detail"; that slows the flow and turns Skill Studio into a noisy node inspection.
- If you have no ontology evidence, do not call `freezone_request_user_clarification` to ask questions that involve style judgment, flow judgment, or applicability scope; call `freezone_get_canvas_ontology` first.

You must analyze:

- **Main topology chain**: the main path from source settings, reference images, prompts, and generation nodes to composition/final cut.
- **Parallel branches**: whether characters, props, scenes, storyboards, video clips, audio, etc. are prepared in parallel.
- **Merge points**: which nodes feed into storyboard, video clip, audio, or composition nodes.
- **Repeated constraints**: extract hard rules that recur across multiple node prompts, such as subject appearance locking, viewpoint/ratio requirements, no deformation, clear key marks, and closing rules.
- **prompt_evidence_analysis**: first extract repeated evidence from node prompts, media facts, file names, reference relationships, and edges, then summarize the topology. From this evidence derive the current scenario's `domain_contract` or `creative_contract`; do not infer directly from displayName or node type.
- **skill_identity_analysis**: after the prompt evidence, decide the Skill's identity. Split the evidence terms into `case_variables`, `reusable_protocol_terms`, `output_format_terms`, `use_case_terms`, and `workflow_method_terms`, used to generate the name, ID, description, and keywords.
- **decision_matrix**: before asking questions, you must sort the evidence into these layers and not mix them:
  - `production_method`: what this flow produces and through which stages, for example "character anchor + prop anchor + storyboard sketch + shot-by-shot video + audio + final cut".
  - `visual_language`: visual/narrative style backed by evidence. Do not guess hard from node names, categories, or a single word; if there is only a generic word such as "lighting", mark the evidence as insufficient and ask the user which visual direction to keep.
  - `case_variables`: one-off content such as the current brand, characters, product, story, and lines.
  - `reusable_protocol`: reusable methods such as stage order, anchor inheritance, review gates, branch merging, and rework scope.
  - `hard_constraints`: rules that must not be broken, such as character consistency, single-view props, a specified aspect ratio, and storyboard confirmation first.
  - `start_options`: parameters the user should choose before each use, such as aspect ratio, shot count, whether to keep the logo, audio mode, and execution mode.
  - `applicability_scope`: the applicable range. This usually comes later; do not ask "which categories does it cover" in the first question.
- **Ratio and duration facts**: derive them from the nodes' actual fields and media width/height, not just displayName.
- **Review gates**: identify which stages need user confirmation, which can run in parallel, and which must wait for upstream to finish.
- **Reusable boundary**: separate project-specific information from abstractable methods. Brand names, character names, and specific lines are usually replaceable variables; stage order, reference rules, and quality gates are usually reusable capabilities.

Do not summarize by node type alone. `imageGenNode -> videoNode -> audioNode -> videoComposeNode` is only an implementation shape, not the value of the Skill.

## 4. The first round only asks high-value abstraction choices

If the user did not explicitly say "use the default recommended configuration", "just generate", or "don't ask", you may ask high-level questions first. The questions must help decide the abstraction boundary and must match the source mode.

Recommended questions for `new_from_user_brief`:

- **Topic/domain**: which topic, industry, content type, or task scenario should this Skill serve?
- **Audience/usage scenario**: who is the final content for, and on which platform, channel, classroom, team, or business scenario will it be used?
- **Output scope**: should the Skill produce planning, scripts, storyboards, prompts, images, video, audio, a composition plan, or a complete workflow?
- **Style/tone**: what mood, aesthetic, level of expression, compliance boundary, or brand/persona tone is needed?
- **Workflow granularity**: should the key steps be saved as separately reusable capability modules, or should it start with an end-to-end flow with fewer steps?

Do not ask for `new_from_user_brief`:

- Whether to keep the current project's specific case.
- Whether to keep the current brand, characters, plot, or node structure.
- Whether to read the current canvas as the source.

Recommended questions for `distill_from_canvas`:

- **What should be reused next time?**: first ask what method this flow should be saved as, rather than asking about applicable categories first. For example "reuse the full short-film production flow: lock characters/props first, then storyboard, shot-by-shot video, audio, and final cut", "reuse the core steps: keep character/prop/storyboard/video, handle audio and final cut as needed", "reuse only a lightweight short-film method: suited to quickly generating similar ad films".
- **Which effects must stay the same?**: present the identified visual/narrative style as readable options, and the options must cite canvas evidence; if the evidence is insufficient, the options should be "the user specifies the visual direction each time", "refer to the current visuals without hard-coding a style", and "let me add the visual style to keep" - do not hard-write a vague identification like "lighting-style ad".
- **What can be replaced next time?**: whether the current characters, brand, props, and plot are fixed samples, default samples, or are all specified by the user each time. The options must explain the effect on next use, for example "characters and products are both replaceable, but the production flow stays the same".
- **How detailed should the reuse be?**: choose fine-grained reuse, standard reuse, or lightweight reuse. Fine-grained can save character anchors, prop anchors, storyboard, shot-by-shot video, audio, etc. separately; standard reuse keeps the key stages; lightweight reuse keeps only the end-to-end short-film method. Do not say Recipe in the question text, and do not make final composition a granularity item for the user to choose.
- **Which rules cannot change?**: ask in words the user understands about the quality rules that must be kept, for example consistent characters, fixed prop angles, storyboard confirmation first, equal video clip durations, and clear brand exposure. Do not use "hard constraints" directly as the title.
- **What should be confirmed before each start?**: ask about user-perceivable choices such as aspect ratio, shot count, duration, whether to keep the brand logo, audio mode, and execution mode. Do not use "pre-start options" directly as the title.
- **Applicability scope**: ask only after the earlier items are clear. Do not ask "which product ads does it cover" in the first question. A better phrasing is "which projects will mainly reuse this method", with options starting from the method, such as "character-driven product ad shorts", "brand IP character shorts", and "short-video flows with reference images and prop anchors".

Question quality rules:

- Each question asks only one decision; do not stuff style, hard constraints, execution stages, and final-cut rules into the same option.
- If an option runs longer than a line and a half, it has usually mixed in too many decisions and should be split into more options or the next question.
- Options should reflect the canvas evidence but must not recite the node list. After reading, the user should be able to judge "how this will change next time I use it".
- Option text should explain the effect after choosing, not implementation details. For example write "When you switch products next time, the character and props can be re-specified, but the flow from storyboard to final cut stays the same", not "case_variables become input_parameters".
- Do not use "Question 1 / Question 2 / Question 3" as titles; the title itself must be a question the user can understand.
- Do not expose internal phrasing like "finally merges into the composition node" to the user; you can say "finally composed into one complete short film, without treating scattered clips as the final result".
- Do not substitute vague words like "generic ad", "lighting style", or "workflow template" for the real production method.

Do not waste the first round of questions on low-level fields:

- Do not ask for the Skill name first.
- Do not ask for the Skill category first.
- Do not ask about a fixed topology first; the concrete node count and dependencies are decided by the dynamic plan of each run.
- Do not ask about id, action_keys, system_prompt, node_type, schema, link_type, or model parameters.

These fields should be inferred by the Agent from the canvas and the user's choices. Ask only when the user explicitly requests a name or category change.

## 5. Minimum quality bar for a generated draft

A generated Skill must contain at least:

- **Skill description**: explain the reusable capability instead of retelling the current case.
- **Skill identity**: the name, ID, description, and triggers.keywords must come from `skill_identity_analysis` and cannot be decided solely by the workflow method or node types.
- **planning.planning_notes**: start from dynamic planning rules and state the stage order, task types, action_keys, dependency constraints, parallelizable rules, review/wait behavior, and ratio strategy.
- **planning.conduct_rules**: write hard execution rules, such as lock the character before the props, generate video only after the storyboard is approved, and require video/audio inputs before composition.
- **Anchor topology rules**: if certain subjects, assets, or references must stay consistent across stages, state which anchors to establish or reuse and which downstream stages must reference the same anchor.
- **evaluation.domain_constraints**: write the hard constraints distilled from canvas facts, not vague evaluations.
- **domain_contract / creative_contract**: write the reuse protocol that most affects quality in the current scenario into planning / conduct_rules / evaluation and the Recipe quality standards. Do not add schema fields, and do not stuff it only into one Recipe prompt.
- **Dynamic topology constraints**: explain how this Skill decides the node count, dependencies, parallel branches, review gates, and terminal composition at runtime, without saving a fixed workflow template.
- **Recipes**: reuse the existing capability modules first, then create new ones for gaps; split by capability boundary rather than mechanically by node type.

## 6. Skill identity and the abstraction boundary

Abstraction is not flattening. When the user chooses "abstract into a generic template", the Agent should delete case variables that cannot be reused, but keep the reusable protocol, product form, and usage scenario that best represent this capability.

First split the terms in the prompt evidence into five categories:

- `case_variables`: specific brand names, specific person/character names, specific product names, one-off plot, one-off lines, project-specific slogans. In an abstract template these should be deleted, parameterized, or downgraded to examples.
- `reusable_protocol_terms`: cross-project reusable creative protocols, domain conventions, style language, rule boundaries, voice personas, gameplay mechanics, and review standards. In an abstract template these should be kept.
- `output_format_terms`: the Skill's product form, such as short film, poster, storyboard sheet, report, courseware, audio, game asset, or composition plan.
- `use_case_terms`: usage scenarios, such as brand advertising, teaching explanation, compliance review, data retrospective, character design, and product showcase.
- `workflow_method_terms`: internal methods, such as character anchoring, prop anchoring, storyboard reference, shot-by-shot generation, audio mixing, and quality gates.

The Skill name, ID, description, and `triggers.keywords` must preferentially combine:

```text
reusable_protocol_terms + output_format_terms + use_case_terms
```

`workflow_method_terms` may supplement but cannot monopolize the Skill identity. Do not name a Skill that has a clear domain protocol with only internal method words such as "character-driven", "storyboard flow", "data processing", or "document generation".

Keywords must cover four categories:

- **protocol keywords**: reusable protocol words.
- **output format keywords**: product form words.
- **use case keywords**: application scenario words.
- **workflow method keywords**: workflow method words.

Bad patterns:

- The name comes only from the node topology or the flow method.
- When abstracting a template, the reusable protocol words are deleted together with the case variables.
- The keywords are only brand variables, or only flow node words.
- The first screen of the description only says "first A, then B, then C" without saying which protocol, product, and scenario this capability fits.

## 7. Subjective decision boundary

A Skill only fixes rules where "a different author should get the same answer". Choices that vary with the author, aesthetics, or the goal of this run should not be hard-coded into the Skill.

- Reproducible rules: asset anchors, reference relationships, prohibitions, material dependencies, stage preconditions, and the source of output specs.
- Subjective choices: the concrete shot count, pacing, composition of a single shot, and preference for a certain candidate look.

Subjective choices have two ways of being handled:

- **Ask the user**: when a structural choice changes the Graph, or cannot be compared side by side, confirm with a question card first.
- **Produce candidates**: for outputs that can be compared side by side, let the runtime handle them by quantity, evaluation criteria, or the user's choice; do not write personal preference as a hard rule.

## 8. Recipe splitting principles

A Recipe's boundary should correspond to a reusable capability module. Before generating a draft, first look at the currently enabled catalog summary; if the summary is missing or insufficient to judge, first call `freezone_list_agent_catalog(kind="recipes", query=...)` to read the compact Recipe summary, then judge whether an existing Recipe can cover the craft of the same stage. Reuse when you can; create a new one only for a real craft gap. After confirming the reuse/new decisions, write the result into `freezone_put_agent_catalog_draft_outline` and set `catalog_checked=true`. `reuse=existing` in the outline means using a saved Recipe and no Recipe chunk needs to be submitted; only `reuse=new` needs a later `freezone_put_agent_catalog_recipe`.

Judgment order:

1. First list the execution stages this Skill actually needs.
2. Then compare against the name, output_kind, action_keys, planning_prompt, and result_summary of the existing Recipes.
3. Compare the execution craft, not just the name, node type, `output_kind`, or broad category label. Craft includes: processing object, processing action, product form, key structure, constraint boundary, downstream use, and workflow responsibility.
4. If the craft is the same, reuse the existing Recipe; a different style, topic, or brand does not mean a new Recipe is required.
5. If the craft differs, do not reuse. Especially when the stage product serves as a later consistency anchor, review gate, splitting basis, or composition material, you cannot reuse a Recipe that only covers generic generation, generic enhancement, or ordinary content organization.
6. Create a new Recipe only when no existing Recipe can express this stage, or forcing reuse would make the Recipe vague, misleading, or over-generalized.
7. Every new-Recipe decision must state the craft gap in the outline's `new_recipe_craft_gap`; if there is no specific gap, switch to reusing an existing Recipe.
8. `allowed_recipe_ids` lists only the Recipe ids that this Skill's actual executable chain needs. It is a runtime allowlist, not a "big collection of related Recipes".

Division of labor between Skill and Recipe:

- The Skill owns style identity, domain rules, pre-start options, execution stages, review gates, material inheritance, rework boundaries, and which Recipes may be used.
- A Recipe owns the prompt/instruction-generation craft of one stage, for example how to turn the upstream character settings into a character-anchor prompt, or how to turn a storyboard table into shot-by-shot video prompts.
- A Recipe does not store this Skill's visual style. A new Recipe's `id`, `name`, `system_prompt`, `must_have_items`, `planning_prompt`, and `result_summary` must not contain the current Skill's style words, aesthetic words, topic names, or case variables; these are inherited at runtime from the Skill's `prompt_guide`, `conduct_rules`, the user's input, and upstream nodes.
- Do not write internal collaboration phrases in Recipe copy such as "do not override the style constraints injected by the Skill" or "this Recipe is only responsible for ...". Write directly in task language: what comes in, what goes out, what must be included, and what counts as failure.
- A Recipe's id and name must match its real granularity. Do not name a Recipe that contains domain rules with an overly generic stage name.

Common splits:

- **Subject anchoring**: lock the main object or key visual asset into a reusable reference.
- **Auxiliary asset anchoring**: generate standalone assets or relationship assets that later stages will reference repeatedly.
- **Style lock / creative brief**: consolidate visuals, tone, structure, expression boundaries, and prohibitions.
- **Storyboard / scene breakdown**: expand the narrative framework into panels, shots, lines, and calls to action.
- **Video clip generation**: generate multiple short clips per storyboard segment while keeping the node reference chain intact.
- **Audio / music generation**: generate sound effects, narration, BGM, or a music spec.
- **Composition plan**: if AI-assisted editing decisions are needed, use a text Recipe to produce the clip order, audio layering, transitions, durations, and output ratio plan; the real final composition is created by the runtime dynamic plan as a terminal `videoComposeNode`.

Do not offer `videoCompose`, final media composition, or final cut assembly as a Recipe-splitting option, and do not count the terminal composition step in the Recipe count. The correct expression is "3 Recipes + a final videoCompose workflow step", not "4 Recipes including composition".

Do not generate generic modules named only by node type such as "image Recipe / video Recipe / audio Recipe". They are usually too weak.

Also do not automatically add a leading text Recipe just to pad steps. Only when the runtime truly needs to create the corresponding text node and later nodes will consume that text result should it go into `allowed_recipe_ids`. If the Skill already carries those decisions through pre-start options and planning rules, do not create or reference such a Recipe.

Do not create relay Recipes such as "global spec", "final spec", or "input analysis" just to carry the aspect ratio, duration, style, material strategy, or execution mode. That authoritative information should come from `input_parameters`, `planning.prompt_guide`, `planning.conduct_rules`, and confirmed inputs; a Recipe only handles the prompt-generation craft of its own stage.

Do not write stage-advancing phrases in a Recipe, such as "enter the next stage after confirmation" or "generate downstream after this stage completes". Stage order, pausing, automatic advancement, and rework boundaries belong to the Skill's `planning.conduct_rules` and runtime authorization.

### Judging the Recipe reuse scope

A Recipe is not better the more generic it is. When abstracting, first ask: after removing the current Skill's style, topic, and one-off case variables, does this stage still have a clear craft left?

- If what remains is a clear input structure, output structure, quality standard, and failure boundary, it can be a shared Recipe.
- If what remains is only vague words like "stable, clear, reusable, high quality", it was abstracted too far, and a more specific Recipe boundary should be kept.
- If the Recipe content contains explicit domain rules, the ID and name must reflect this reusable scope; do not pretend it is a platform-wide generic capability.
- If a more generic version may appear in the future, still do not take an over-broad ID now; name the current Recipe by its real responsibility and add a truly generic version later.

Reusing an existing Recipe is also judged by craft. First state in one internal sentence: what object this stage turns into what product, and how that product is used afterward. Then compare against the candidate Recipe's `planning_prompt`, `result_summary`, and `must_have_items`. If the candidate Recipe's product form, key structure, or downstream use differs, do not reuse it even if the names are similar.

Before reusing an existing Recipe, it must pass three questions:

1. **Is the output the same kind of thing?** For example a single anchor image, a three-view model card, a multi-panel storyboard, a single-clip video prompt, an audio-layer prompt, and a plan text are not the same kind of output.
2. **Does downstream use it in the same way?** For example a full-chain lock source, an ordinary reference image, a storyboard basis, a video material input, an audio layer, or a terminal result - these different uses change the craft.
3. **Does the Recipe itself have to write in the current Skill's style, topic, or case to hold up?** If so, first move that content back into the Skill's `planning.prompt_guide`, `planning.conduct_rules`, or `evaluation`, then judge whether the remaining craft still matches.

If any of the three answers is negative, do not write `reuse=existing`. The `reason` of `reuse=existing` must explain the matching points of the three questions, and cannot merely say "same craft", "both are character/prop/storyboard/video", or "a similar Recipe exists".

## 9. How to write a domain_contract / creative_contract

When distilling a Skill from the canvas, do not just summarize "which nodes there are". You must first do `prompt_evidence_analysis`: extract repeated evidence from node prompts, media width/height/duration, source filenames, reference relationships, and edges, then derive the current scenario's `domain_contract` or `creative_contract`.

This contract is not a new schema field; it must land in existing fields:

- `planning.planning_notes`: explain how the protocol affects the execution path and stage order.
- `planning.conduct_rules`: write it as hard execution rules.
- `evaluation.domain_constraints`: write it as checkable quality constraints.
- `planning.planning_notes` / `planning.conduct_rules`: state the stage inheritance, exceptions, prohibitions, and dynamic dependency rules.
- Recipe `system_prompt` / `must_have_items`: write the evidence that the Recipe needs to keep or transform.

Contracts differ by domain; express them in generic terms first and do not rush to fit a specific case:

- Visual advertising: visual language, performance style, brand tone, stage-specific style exceptions, and composition that does not generate a new style.
- Data analysis: metric definitions, time range, units, filter conditions, and the boundary of chart interpretation.
- Legal/compliance: jurisdiction, clause basis, risk level, and boundaries such as not replacing a lawyer's opinion.
- Teaching content: grade level, knowledge points, explanation pace, exercise difficulty, and banning out-of-syllabus concepts.
- Game assets: viewpoint, proportion, action conventions, collision/state rules, and UI feedback rules.
- Audio content: voice persona, speaking rate, emotion, timbre, and banned noise or conflicting music.

When writing a contract, distinguish at least three layers:

- **Global language**: the visual, textual, audio, or behavioral register the whole Skill must maintain.
- **Stage exceptions**: certain stages need a different presentation, granularity, or review rule.
- **Inheritance rules**: which upstream results downstream stages must reuse, and what must not be reinvented.

Do not write only vague sentences like "keep the style consistent" or "quality must be good". They are too weak to guide different treatment at different stages.

## 10. How to write a Recipe system_prompt

A Recipe `system_prompt` is not role-play boilerplate. It must agree with the execution contract of its `output_kind`:

- With `output_kind=text`, the current Agent / LLM directly produces the deliverable final text and does not hand the result to another text model to continue.
- With `output_kind=image/video/audio`, the current Agent / LLM converts the upstream inputs into a prompt or instruction that the corresponding media generation node can execute; it does not generate the final media directly.

You must state clearly:

- [Input Sources]: whether they come from user text, the current canvas, selected nodes, upstream media, or the previous Recipe.
- [Task Goal]: what final text a text Recipe produces, or what downstream generation instruction a media Recipe produces.
- [Output Structure Requirements]: which modules the final text or media generation instruction must contain.
- [Quality Standards]: standards that are checkable and can trigger rework.
- [Prohibitions/Constraints]: what not to do and which errors would contaminate downstream.

When writing a Recipe, follow this priority: the user's request this turn > confirmed inputs > the Skill's strong constraints > the Recipe craft > defaults. A Recipe must not claim to rank above user input, confirmed specs, or the Skill's strong constraints.

Do not write only:

```text
You are a professional director who is good at generating high-quality video prompts.
```

Write it like this instead:

```text
You will convert the upstream storyboard sheet, character anchors, and prop anchors into a video prompt that a single videoGeneration node can execute. The output must include character consistency, reference sources, camera action, sound effects, duration, ratio, and negative constraints. Important: your output is a single prompt/instruction that will be sent to the downstream videoGeneration node for execution; do not generate the final video content yourself.
```

## 11. Dynamic workflow planning requirements

A Skill does not store a fixed node topology. On each run the Agent produces a complete `freezone_workflow_plan.v1` based on the user's goal this time, the input materials, the Skill rules, and the available Recipes.

The Skill draft must provide sufficiently explicit planning constraints:

- The stage order and the stages allowed to run in parallel.
- The Recipe `action_keys` each stage is allowed to use.
- Upstream inputs, material inheritance, and reference rules.
- The anchors to establish or reuse, and which downstream nodes must reference the same anchor.
- How the node count is decided by this request.
- The default ratio of media such as images and video, and stage exceptions.
- Approval, waiting, quality gates, and partial rework boundaries.
- When a final composition is needed, the input conditions of the terminal `videoComposeNode`.

`videoCompose` is not a Recipe:

- Do not create a Recipe for `videoCompose`.
- Do not claim that a Recipe will directly drive a `videoComposeNode` to generate content.
- If AI-assisted editing decisions are needed, create a `textGeneration` Recipe to produce the composition plan, and let the dynamic WorkflowPlan add the terminal composition node.
- Terminal composition may only consume already generated video and audio assets; it must not treat planning text or an ordinary prompt as media input.

The dynamic plan must explicitly carry the `recipeId` of every executable node, and only after passing the Skill's Recipe allowlist and the WorkflowPlan contract validation may canvas nodes be created.

## 12. Extract hard constraints from prompts

Phrases that repeat across canvas prompts usually matter more than node names. They must be distilled into executable rules.

Example types:

- Restrictions on subject appearance, structure, or identity -> subject attribute checks and negative-prompt rules.
- The same subject must not be duplicated, deformed, or reinvented -> cross-stage consistency and anchor reference rules.
- Viewpoint, proportion, or display scope of key assets -> asset anchoring and composition rules.
- A stage that must use a standalone presentation -> stage style gate.
- Closing, delivery, or final-draft requirements -> final product rules.
- Explicit reference to upstream results -> node reference chain integrity rules.

Do not compress these into "keep the style consistent". That is not an executable rule.

## 13. Ratio and media facts

Judge the ratio from both the node fields and the media width/height.

- Characters / product props are commonly 1:1.
- Storyboards may be 16:9.
- A video node's fields and its actual width/height may disagree; if the size is 720x1280, recognize it as a vertical fact, and state the difference between the "field default" and the "actual output" in planning.
- If a workflow has several ratios, do not write all task types with the same default ratio; the primary ratio that the user needs to control each time is written as a pre-start option in `input_parameters`, and variants are written into the workflow step.

## 14. Avoid low-quality patterns in the output

Do not output these patterns:

- Summarizing only by node type: "first image, then video, then audio, then composition".
- A Skill name, ID, or keywords generated only from workflow_method_terms, lacking a reusable protocol, product form, and usage scenario.
- A Recipe system_prompt that is only role-play boilerplate: "You are a professional director/designer".
- Evaluation criteria that are only "consistent style", "good quality", "strong ad feel".
- planning_notes that only list stage names without explaining the dynamic node count, dependencies, parallelism, and review rules.
- Writing a strong style only as a vague style field without forming an executable creative_contract.
- Hard-coding the current brand and characters into every field, making it non-reusable.
- Writing all Recipes as the same kind of prompt compiler without distinguishing inputs, outputs, and quality gates.
- Creating relay spec Recipes to repeatedly store aspect ratio, duration, style, material strategy, or execution mode.
- Writing stage-advancing instructions such as "enter the next stage after confirmation" inside a Recipe.
- Writing subjective aesthetic choices as hard Skill rules, which freezes the topology and results of every run.
- Only saying "keep the subject consistent" in text without stating in planning how anchors are established, reused, and referenced downstream.
- Treating tool schema field descriptions as Skill content.
- First-round questions revolving around id, category, action_keys, node_type, or schema fields.
- Creating a prompt Recipe for `videoCompose`, or claiming that a Recipe will directly drive `videoComposeNode` to generate the final video.

A good output should let the user see: this is not a summary, but a creative craft that can be executed again.

## 15. Field-writing quick reference

This section is the landing check before serialization. First complete the capability modeling and reuse judgments above, then fill in the fields here; do not generate content field by field in the reverse order.

### Division of the three `planning` fields

- `planning.prompt_guide` holds the global creative register: style language, tone, material/sound/structure requirements, language requirements, stage exceptions, and cross-stage expression. Content that must change when the style or expression protocol changes belongs here first.
- `planning.planning_notes` holds dynamic Graph planning: the stage path, task types, action keys, dependencies, parallelism, anchor establishment and reuse, and how input parameters affect the node count and ratio. It is for Hermes to plan the graph, not a node-prompt template.
- `planning.conduct_rules` holds hard behavior boundaries: confirmation points, no skipping steps, material inheritance, anchor references, partial rework, cost/risk boundaries, and hard prohibitions. It is neither a plain aesthetic description nor a Recipe output template.

If a sentence describes "what the result should look like", it usually goes in `prompt_guide`; if it describes "how the graph should be built", it usually goes in `planning_notes`; if it describes "what must never be done", it usually goes in `conduct_rules`.

### Skill fields

| Field | What to write | What not to write |
| --- | --- | --- |
| `schema_version` | Always `dramaclaw.workflow-skill.v1`. | Do not let the user choose it, and do not invent a new version. |
| `version` | New ones usually start at `1.0.0`; when editing an existing one, keep it or bump it according to the actual change. | Do not write a date, a model version, or a Hermes version. |
| `id` | A lowercase hyphenated ID derived from the reusable protocol, product form, and usage scenario. | Do not use only workflow-method words; do not include the current project name, character names, spaces, or non-ASCII characters. |
| `name` | A skill name the user can understand, highlighting the applicable scenario and the final product. | Do not show internal method names or IDs; do not use the node order as the name. |
| `description` | One sentence on what creative tasks this Skill suits and what it can reliably produce. | Do not retell the node order; do not write internal notes such as "manages Agent behavior". |
| `category` | A business category, for example `video`, `image`, `audio`, `text`, `workflow`, `general`. | Do not write a node type, model name, or project name. |
| `triggers.keywords` | Cover four kinds of words: protocol words, product words, usage-scenario words, and workflow-method words. | Do not put only brand variables, or only "storyboard, video, audio". |
| `triggers.node_scopes` | Only the triggerable catalog scopes: `textGeneration`, `imageGeneration`, `videoGeneration`, `audioGeneration`. A complete workflow may cover several according to its main inputs/outputs. | Do not write canvas node types such as `imageGenNode`, `videoNode`, or `videoComposeNode`. |
| `allowed_recipe_ids` | The allowlist of Recipes this Skill's real execution chain may use. Reuse existing Recipes first; create new ones only for gaps. | Do not stuff in "possibly related" Recipes; do not add leading steps that the runtime will not create or downstream will not consume; do not add non-Recipe actions that fixed canvas components perform. |
| `input_parameters` | Choices the user can vary before each run, such as aspect ratio, count, duration, toggles, and execution mode. | Do not write schema/version/model/provider; do not hard-code one-off case variables into planning. |
| `planning.planning_notes` | Start from the executable path: stage order, task types, action keys, dependencies, parallelism, waiting/confirmation, how input parameters affect the flow, anchor establishment and reuse, and final-product conditions. Write inheritance rules afterward. | Do not write only "first A then B"; do not store fixed node IDs or a fixed topology; do not treat non-Recipe actions as Recipes. |
| `planning.prompt_guide` | The global creative register: style language, narrative tone, material/sound/structure requirements, language requirements, stage exceptions. | Do not write tool-call instructions; do not explain fields to the Agent; do not write only vague adjectives. |
| `planning.conduct_rules` | Hard execution rules: order, review gates, material inheritance, anchor references, no early generation, partial rework scope, and spec and cost/risk boundaries. | Do not write only aesthetic principles; do not write "try to" suggestions. |
| `evaluation.rating_bands` | Score anchors describing the visible quality difference between scores. | Do not write "good / average / poor quality" for every band. |
| `evaluation.quality_threshold` | The minimum acceptable score, for example `0.8`. | Do not treat it as a percentage string. |
| `evaluation.domain_constraints` | Checkable domain constraints, such as subject consistency, complete references, stage confirmation, and output specs being met. | Do not write vague slogans such as "unified style, good quality". |
| `evaluation.visual_review_items` / `text_review_items` | Review dimensions, weights, and judging notes. A visual Skill covers at least subject consistency, composition, style, and clarity; a text Skill covers structure, facts, tone, and executability. | Do not pile all the weight on "overall effect". |

### How to write `input_parameters`

Every parameter must let the user know "how this run will change".

- `id`: a stable English ID, for example `aspect_ratio`, `shot_count`, `audio_mode`.
- `label`: a user-readable name, for example "Aspect ratio", "Shot count", "Audio mode".
- `type`: choose `single_select`, `multi_select`, `text`, `number`, or `boolean` by input shape.
- `required`: set to `true` only when there is no default value and it affects whether the workflow can continue.
- `default`: give a safe default; common items such as aspect ratio, duration, and count should have a default whenever possible.
- `options`: keep a single list of option values, written directly as values the user can understand; do not split into an "internal value" and a "display text".

Do not turn model preference, provider, cost strategy, or schema version into pre-start options. Result controls that may change on each run and whose impact the user understands should go here first.

### Recipe fields

| Field | What to write | What not to write |
| --- | --- | --- |
| `schema_version` | Always `dramaclaw.recipe.v1`. | Do not let the user choose it, and do not invent a new version. |
| `version` | New ones usually start at `1.0.0`; when editing an existing one, keep it or bump it according to the actual change. | Do not write a model version. |
| `id` | Reflect the real craft granularity. Use a generic name for a generic craft; use a domain name that states the boundary for a domain craft. | Do not give a Recipe that contains explicit domain rules an over-broad ID. |
| `name` | A user-readable stage capability name stating what this stage produces. | Do not show an action key or node type. |
| `output_kind` | The business product type of the Recipe: `text` directly produces the final text; `image`, `video`, `audio` produce the generation prompt for the corresponding media node. | Do not use canvas node names; do not treat `text` as a prompt for a second text-generation pass. |
| `action_keys` | A stable key matching this stage's action, usually the same as the id or the stage action. | Do not put several unrelated actions; do not stuff the Skill id in. |
| `system_prompt` | Execution instructions for the current LLM. `text` must guide it to directly produce the final text; media types must guide it to produce a prompt/instruction the downstream media node can execute. Both must include input sources, task goal, output structure, quality standards, and prohibitions. | A text Recipe must not require a second model call; a media Recipe must not pretend the final media has been generated; do not write internal collaboration phrases like "do not override the Skill style"; do not write only role-play boilerplate. |
| `must_have_items` | The structural modules that this stage's business product must contain. | Do not write only style adjectives; do not write scheduling steps. |
| `planning_prompt` | One business sentence, in the form "Based on X, generate/extract/rewrite Y." | Do not explain when to call it, how downstream connects, or how nodes are arranged; do not write stage advancement. |
| `result_summary` | One sentence or phrase describing what business result the Recipe outputs. | Do not write mechanism phrases like "sent to the imageGeneration node" or "for downstream execution". |
| `requires_source_media` | `true` when this stage must reference image/video/audio material, for example shot-by-shot video needs storyboard/character/prop references. Pure text planning is usually `false`. | Do not set true just because reference material might exist; set true only when the stage cannot execute correctly without the material. |

Recipe fields must not carry the Skill's style. Anything that must change when the visual style, aesthetic, topic, or case changes should go first into the Skill's `planning.prompt_guide`, `planning.conduct_rules`, or `evaluation`. A Recipe only states how this stage processes its input, what structure it outputs, and what counts as failure. `id/name` may reflect a stable domain craft, product form, or usage scenario, but not the style identity specific to the current Skill.

### Recommended skeleton for a Recipe `system_prompt`

#### Image, video, audio Recipe

```text
[Role Definition]
You turn the upstream input into a prompt/instruction that a <node type> node can execute.

[Input Sources]
- The user's goal this time or the pre-start options
- Confirmed upstream text/media/reference material
- Constraints the current stage must inherit

[Task Goal]
Generate one complete <imageGeneration/videoGeneration/audioGeneration> node prompt/instruction, used to ...

Important: your output is a single prompt/instruction that will be sent to the downstream <node_type> node for execution; do not generate the final content yourself.

[Output Structure Requirements]
1. ...
2. ...

[Quality Standards]
- ...

[Prohibitions/Constraints]
- ...
```

#### Text Recipe

```text
[Role Definition]
You directly produce a deliverable final text from the upstream input.

[Input Sources]
- The user's goal this time or the pre-start options
- Confirmed upstream text/media/reference material
- Constraints the current stage must inherit

[Task Goal]
Directly produce a complete <text product type>, used to ...

Important: the output is the final text result of this stage; you do not need to, and must not, require another text model to continue generating.

[Output Structure Requirements]
1. ...
2. ...

[Quality Standards]
- ...

[Prohibitions/Constraints]
- ...
```

The "constraints the current stage must inherit" here must be written in business language, not in internal collaboration phrases like "inherit the Skill prompt_guide".

### Criteria for shared Recipes vs. domain Recipes

- If different Skills differ only in style, topic, tone, or industry, but the stage input, output structure, quality standards, and risk boundary are the same, prefer reusing a Recipe.
- If a stage contains explicit domain rules, or its input structure, output structure, quality standards, or review boundary clearly differ, create a domain Recipe.
- If a leading step only plans or confirms inside the Skill and does not create a node that downstream can consume, do not put it into `allowed_recipe_ids`.

### Self-check before finishing

Before calling `freezone_finish_agent_catalog_draft`, do an internal self-check; when you find a clear problem, fix it directly instead of leaving it to the user:

- Whether each Recipe is responsible for only one executable stage. If a Recipe would produce two or more downstream nodes at once, split it.
- Whether audio Recipes are responsible only for audio layers such as narration, sound effects, and BGM; do not write final video composition into an audio Recipe.
- When the Skill already has pre-start options, the Recipe must not hard-code the corresponding variable values such as count, ratio, and duration.
- Whether style, topic, brand, character identity, and the global quality register are placed in the Skill; the Recipe keeps only this stage's input, output structure, quality standards, and failure boundary.
- Whether the id/name/result_summary of a new Recipe carries none of the current Skill's style identity. If the name would have to change for a different style, it has absorbed the Skill's style and should be renamed to describe the craft, moving the style back to the Skill.
- If a Recipe is left with only vague words like "stable, clear, reusable, high quality" after abstraction, it was abstracted too far, and a more specific domain boundary and name should be kept.

When landing the fields, always follow this line: **a thick Skill writes the look and feel, asset strategy, stage principles, and quality standards; a Recipe writes the reusable stage craft; the Schema stays thin and gets no new fields.**

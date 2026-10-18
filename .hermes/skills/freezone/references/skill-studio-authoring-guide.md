# DramaClaw Skill Studio Authoring Guide

This guide applies when Skill Studio creates, edits, summarizes, distills, or saves a Skill / Recipe, including:

- The user describes a brand-new Skill / Recipe from scratch.
- The user creates a Skill / Recipe from a tool, a node capability, or a tool schema.
- The user explicitly asks to summarize, distill, save, or convert the current DramaClaw canvas, the current flow, the selected nodes, or an existing workflow into a Skill / Recipe.

The goal is not to fill in every field, and not to describe "which nodes are on the canvas". It is to extract why this capability is reusable. A good Skill lets the next similar project be planned, generated, reviewed, and partially reworked with the same method.

## 0. Determine the source mode first

Before capability modeling, reading the canvas, or asking questions, you must determine the source mode of this Skill Studio round. Being inside the DramaClaw UI with a canvas ontology injected by the frontend does not mean the user wants to distill a Skill from the current canvas.

### `new_from_user_brief`

When the user says "I want to make / create / build an X Skill / Recipe" without explicitly saying "the current canvas / the current flow / the selected nodes / this project / this workflow / an existing workflow", the default is to create a new Skill from the user's brief.

Rules:

- The primary source is the user's text and later answers.
- The current canvas is environmental background only, not content evidence.
- Do not read node details, node schemas, or the link catalog, and do not treat the ontology as case facts.
- Do not let the current canvas influence the Skill name, keywords, description, Recipe boundaries, or constraints.
- Do not ask "keep the specific case / brand / characters / plot of the current project?".
- If the user's brief is short, first ask 3-5 high-level questions covering topic/domain, audience/scenario, output scope, style/tone, and workflow granularity.

### `distill_from_canvas`

Only when the user explicitly says to summarize, distill, save, or convert "the current canvas / the current flow / the selected nodes / this project / this workflow / an existing workflow" into a Skill / Recipe do you enter canvas distillation.

Rules:

- Before asking any canvas-distillation question, you must call `freezone_get_canvas_ontology` to read the canvas evidence. Do not use the canvas summary as the basis for Skill Studio questions.
- If the ontology lacks evidence for style, prompts, key media, or dependencies, read the details of a few key nodes, such as the main character anchor, prop anchors, core storyboard, and the final composition node. Never ask questions without reading the ontology first.
- Do `canvas_workflow_analysis` and `prompt_evidence_analysis` first.
- The first round of questions must be 2-4 high-quality questions based on the canvas evidence; each usually offers 3-5 options the user can understand, unless it is genuinely a two-way choice. Do not always ask only the two fixed questions "keep the specific case or abstract template" and "reuse mode".
- Before asking, identify the current production style and the reusable protocol, such as production type, visual style, shot/composition language, character/prop anchors, storyboard or video stages, audio/composition rules, hard constraints, and variable inputs. Questions and options should surface these findings instead of just saying "the current case".
- When asking the user, do not use internal implementation terms such as `Recipe`, `Recipes`, `allowed_recipe_ids`, `workflow_templates`, `videoCompose`, or `schema`; use product language such as "capability module", "execution steps", "reuse mode", "fine-grained reuse", and "simplified reuse".
- All user-facing Skill Studio content must follow the user's current language: if the user writes in Chinese, answer in natural Chinese; if in English, in natural English. Analysis summaries, questions, options, progress notes, and the natural-language reply after tool calls must all be consistent; do not mix languages. Do not emit headings or transitions in a language the user is not using, for example `Prompt evidence`, `creative contract`, `Let me check`, `Now I'll submit`, when the user is writing in another language.
- Before the question cards, state in one sentence what you saw on the canvas, for example "This canvas looks like an ad short flow: lock the characters and props first, then storyboard, then generate shot-by-shot video, and finally add audio and compose." Do not expose the ontology, schema, or tool names.
- Still do not summarize only by node type.

### `edit_existing_catalog`

When the user wants to modify an existing Skill / Recipe, a configuration just saved, or the current draft, the source is the existing configuration/draft, not the current canvas. Read the saved configuration when needed, then make a local edit or ask a follow-up.

Rules:

- The current draft/saved configuration is only the object being modified, not the user's modification intent.
- Do not infer what the user wants to change from the draft content, the Recipe structure, field defects, or your own optimization judgment.
- If the user only clicks "Let AI adjust" or only picks a generic category such as "basic info / input parameters / capability module content / constraints / quality standards / execution flow", you must not change the draft directly; keep asking a more specific question.
- Only when the user explicitly states "which target + how to change it" may you call `freezone_patch_agent_catalog_draft` or replace the corresponding Skill / Recipe.
- Until an explicit modification direction is given, do not split/merge steps on your own, do not add or remove Recipes, do not change reference relationships, and do not dress up internal structural optimizations as "you would like...".

## 1. Do capability modeling first

Whether the source is a one-line user brief, a tool schema, or the current canvas, complete `capability modeling` internally first. Do not generate field by field along the schema.

You must first determine:

- **Target user**: which concrete creative problem this Skill solves for whom.
- **Input sources**: user text, existing nodes, reference images, video clips, audio, project assets, or canvas context.
- **Outputs**: whether the final product is a prompt, copy, image, video, audio, a composed result, or an executable workflow.
- **Execution path**: which stages the capability should be split into, which can run in parallel, and which must wait for upstream.
- **Quality gates**: what counts as passing at each stage and what must be reworked.
- **Failure/rework strategy**: when the user changes one thing, whether to redo everything or only a given capability module, node, or clip.
- **Reuse boundary**: which parts are case variables for this run and which are cross-project methods.

If you cannot make these judgments, ask 1-2 high-level questions instead of asking about field names.

## 2. Do not be led astray by the tool schema

A tool schema only says what fields can be filled in; it does not say how a good Skill should think.

Hard rules:

- Do not treat tool schemas as authoring guidance.
- schema fields are final serialization constraints, not the creative plan.
- Do not ask the user about schema fields one by one, e.g. id, category, action_keys, system_prompt, node_type, requires_source_media.
- Do not carry parameter names from the tool schema into user-visible questions.
- Do not write a Recipe as a field manual.
- Do not force vague filler content into a field just because the schema has it.

Correct order:

1. Do `capability modeling` first.
2. Then decide the capability boundaries of the Skill / Recipe.
3. Submit the internal outline first, recording the reuse goal, Skill-level constraints, planned stages, Recipe reuse/new decisions, and the expected Recipe count.
4. Then write the execution path, quality gates, and rework rules.
5. Only last serialize the result into schema fields.

The outline is an architectural breakdown before writing JSON, not user-visible copy. A new draft that contains Recipes must call `freezone_put_agent_catalog_draft_outline` first and then `freezone_begin_agent_catalog_draft`. Do not skip the outline and begin directly. When reusing an existing Recipe, only write its id into the Skill's `allowed_recipe_ids`; do not call `freezone_put_agent_catalog_recipe` to submit it again; `expected_recipe_count` counts only the Recipe chunks that need to be newly created this time.

Every `reuse=new` stage in the outline must include `new_recipe_craft_gap`. This field only says "why the execution craft of existing Recipes is insufficient"; do not write "because the current Skill's style/topic/brand is different". A valid craft gap explains where an existing Recipe does not match in the object processed, the processing action, the product form, the key structure, the constraint boundary, or the downstream use. The craft gap is not only about input/output format; it also considers the stage's responsibility in the workflow: if a stage's product serves as a stable basis, review gate, splitting basis, or composition material for later nodes, the Recipe must cover that responsibility boundary; you cannot reuse a Recipe that only does generic generation or generic enhancement merely because `output_kind` is the same. If you cannot state these differences after removing the current style, topic, brand, and one-off case variables, reuse the existing Recipe and write the style and domain constraints into the Skill.

`reuse=existing` is not the default. Before reusing an existing Recipe, confirm that the current stage and the existing Recipe have the same execution craft: they process the same kind of object, perform the same kind of processing, produce the same kind of intermediate product, and serve downstream in the same way. Similar names, the same node type, or both belonging to character/prop/storyboard cannot by themselves justify reuse. If the current stage needs a "single referenceable anchor" while the existing Recipe produces a "multi-angle model sheet / multi-view reference", the product form and downstream use differ, so create a better-matching Recipe or choose another one.

In the outline, `id` is the stage ID and `recipe_id` is the Catalog Recipe ID corresponding to that stage. Both must stay craft-oriented and neutral: describe the object processed, the processing action, or the product form; do not write the current Skill's visual style, topic, brand, character names, product names, or one-off case. For `reuse=existing`, `recipe_id` must be exactly the existing Recipe ID; for `reuse=new`, `recipe_id` is the Recipe ID about to be created and must also be named after a reusable craft.

The names, reasons, and `new_recipe_craft_gap` of newly created Recipes in the outline must also describe craft only; do not write the Skill's visual style, topic, or one-off case into a Recipe. Style belongs in the Skill's `planning.prompt_guide`, `planning.conduct_rules`, and `evaluation`. A Recipe name should describe the object processed, the product form, or the usage scenario, not the aesthetic identity of the current Skill.

Bad output usually looks like this:

- "What is the Skill name?"
- "What is the Skill category?"
- "Save a fixed node topology?"
- "Please provide action_keys."
- "You are a professional designer responsible for generating high-quality content."

These look tidy but do not meaningfully improve later generation quality.

## 3. When distilling from the canvas, do canvas_workflow_analysis first

Before generating a draft, complete `canvas_workflow_analysis` internally. Do not show this analysis to the user verbatim, but it must drive the later questions and the draft.

When distilling the whole canvas, read the global context first:

- Before the question cards you must call `freezone_get_canvas_ontology` to finish reading the canvas evidence.
- Do not use `freezone_summarize_canvas` in place of the ontology; the summary is too thin to serve as the basis for Skill Studio questions.
- Do not read every node detail one by one.
- Only when the ontology lacks fields required for the draft, read the details of a few key nodes, such as the main character anchor, core storyboard, and final composition node.
- Do not call `get_node_detail` on every node just to "understand the canvas in more detail"; that slows the flow and turns Skill Studio into a noisy node inspection.
- If there is no ontology evidence, do not call `freezone_request_user_clarification` to ask questions involving style judgments, flow judgments, or applicable scope; call `freezone_get_canvas_ontology` first.

You must analyze:

- **Main topology chain**: the main path from source settings, reference images, prompts, and generation nodes to composition/final cut.
- **Parallel branches**: whether characters, props, scenes, storyboards, video clips, audio, etc. are prepared in parallel.
- **Merge points**: which nodes feed into storyboard, video clip, audio, or composition nodes.
- **Repeated constraints**: hard rules that recur across multiple node prompts, such as subject appearance lock, viewpoint/proportion requirements, no-deformation rules, key marks being clearly visible, and closing rules.
- **prompt_evidence_analysis**: first extract repeated evidence from node prompts, media facts, filenames, reference relationships, and edges, then summarize the topology. Derive the scenario's `domain_contract` or `creative_contract` from this evidence; do not infer it directly from displayName or node type.
- **skill_identity_analysis**: after the prompt evidence, decide the Skill identity. Classify evidence terms into `case_variables`, `reusable_protocol_terms`, `output_format_terms`, `use_case_terms`, and `workflow_method_terms`, used to produce the name, ID, description, and keywords.
- **decision_matrix**: before asking questions, sort the evidence into these layers; do not mix them:
  - `production_method`: what this flow produces and through which stages, e.g. "character anchors + prop anchors + storyboard sketches + shot-by-shot video + audio + final film".
  - `visual_language`: visual/narrative style supported by evidence. Do not guess from node names, categories, or single words; if there are only generic words such as "lighting", mark it as insufficient evidence and ask the user which visual direction to keep.
  - `case_variables`: one-off content such as the current brand, characters, product, story, and lines.
  - `reusable_protocol`: reusable methods such as stage order, anchor inheritance, review gates, branch merging, and rework scope.
  - `hard_constraints`: rules that must not be broken, such as character consistency, single-view props, specified aspect ratio, and storyboard needing confirmation first.
  - `start_options`: parameters the user should choose before each use, such as aspect ratio, shot count, whether to keep the logo, audio mode, and execution mode.
  - `applicability_scope`: the applicable scope. This usually comes later; do not ask "which categories does it cover" in the first question.
- **Aspect ratio and duration facts**: derive from the nodes' actual fields and media dimensions, not just displayName.
- **Review gates**: identify which stages need user confirmation, which can run in parallel, and which must wait for upstream completion.
- **Reuse boundary**: separate project-specific information from abstractable methods. Brand names, character names, and specific lines are usually replaceable variables; stage order, reference rules, and quality gates are usually reusable capabilities.

Do not summarize by node type only. `imageGenNode -> videoNode -> audioNode -> videoComposeNode` is just an implementation shape, not the value of the Skill.

## 4. First-round questions ask only high-value abstract choices

If the user has not explicitly said "use the default recommended configuration", "just generate", or "don't ask", you may ask high-level questions first. Questions must help decide the abstraction boundary and must match the source mode.

Recommended questions for `new_from_user_brief`:

- **Topic/domain**: which topic, industry, content type, or task scenario should this Skill serve?
- **Audience/usage scenario**: who will watch the final content, and on which platform, channel, classroom, team, or business scenario will it be used?
- **Output scope**: should the Skill produce planning, scripts, storyboards, prompts, images, video, audio, a composition plan, or a complete workflow?
- **Style/tone**: what emotion, aesthetic, level of expression, compliance boundary, or brand/persona tone is needed?
- **Workflow granularity**: should key steps be distilled into separately reusable capability modules, or should it start as an end-to-end flow with fewer steps?

Do not ask these for `new_from_user_brief`:

- Whether to keep the specific case of the current project.
- Whether to keep the current brand, characters, plot, or node structure.
- Whether to read the current canvas as a source.

Recommended questions for `distill_from_canvas`:

- **What will be mainly reused next time?**: first ask what method this flow should be distilled into, rather than the applicable category. For example: "reuse the complete short-film production flow: lock characters/props first, then storyboard, shot-by-shot video, audio, and final film"; "reuse the core steps: keep characters/props/storyboard/video, handle audio and final film as needed"; "reuse only a lightweight short-film method: suited to quickly generating similar ad films".
- **Which effects must be kept?**: present the identified visual/narrative style as readable options, and each option must cite canvas evidence; if the evidence is insufficient, the options should be "the user specifies the visual direction each time", "refer to the current visuals but do not hard-code a style", and "let me add the visual style to keep", rather than hard-writing a vague identification such as "lighting-style ad".
- **What can be replaced next time?**: whether the current characters, brand, props, and plot are fixed samples, default samples, or are specified by the user each time. Options should explain the effect on the next use, e.g. "characters and product can both be replaced, but the production flow stays the same".
- **How fine should the reuse be?**: choose fine-grained, standard, or lightweight reuse. Fine-grained can separately distill character anchors, prop anchors, storyboard, shot-by-shot video, audio, etc.; standard keeps the key stages; lightweight keeps only the end-to-end short-film method. Do not say Recipe in the question text, and do not make final composition a granularity item for the user to choose.
- **Which rules must not change?**: ask in terms the user understands about quality rules that must be kept, e.g. character consistency, fixed prop angle, storyboard confirmed first, consistent video clip duration, clear brand exposure. Do not use "hard constraints" directly as the title.
- **What to confirm before each start?**: ask about user-perceivable choices such as aspect ratio, shot count, duration, whether to keep the brand logo, audio mode, and execution mode. Do not use "start options" directly as the title.
- **Applicable scope**: ask only after the previous items are clear. Do not ask "which product ads does it cover" in the first question. A better phrasing is "which projects will mainly reuse this method", with options derived from the method, e.g. "character-driven product ad short", "brand IP character short", "short-video flow with reference images and prop anchors".

Question quality rules:

- Each question asks for only one decision; do not stuff style, hard constraints, execution stages, and final-film rules into the same option.
- An option longer than a line and a half usually mixes in too many decisions and should be split into more options or a next question.
- Options should reflect canvas evidence but must not simply restate the node list. After reading them, the user should be able to judge "how it will change next time".
- Option copy should state the effect of the choice, not implementation details. For example write "when you change the product next time, characters and props can be re-specified, but the flow from storyboard to final film stays the same", not "case_variables become input_parameters".
- Do not use "Question 1 / Question 2 / Question 3" as titles; the title itself should be a question the user understands.
- Do not expose internal phrasing such as "finally feeds into the composition node"; say instead "finally composed into one complete short film, not leaving loose clips as the final result".
- Do not replace the real production method with vague words such as "generic ad", "lighting style", or "workflow template".

Do not waste the first-round questions on low-level fields:

- Do not ask for the Skill name first.
- Do not ask for the Skill category first.
- Do not ask about a fixed topology first; the concrete node count and dependencies are decided by the dynamic plan of each run.
- Do not ask about id, action_keys, system_prompt, node_type, schema, link_type, or model parameters.

These fields should be inferred by the Agent from the canvas and the user's choices. Ask only when the user explicitly asks to change the name or category.

## 5. Minimum quality bar for a generated draft

A generated Skill must include at least:

- **Skill description**: explain the reusable capability instead of restating the current case.
- **Skill identity**: the name, ID, description, and triggers.keywords must come from `skill_identity_analysis`, and cannot be determined only by the workflow method or node types.
- **planning.planning_notes**: start from the dynamic planning rules, stating clearly the stage order, task types, action_keys, dependency constraints, parallelizable rules, review/wait behavior, and aspect ratio strategy.
- **planning.conduct_rules**: write hard execution rules, e.g. lock the characters before the props, video can be generated only after the storyboard is approved, video/audio inputs are required before composition.
- **Anchor topology rules**: if certain subjects, assets, or references must stay consistent across stages, state which anchors to establish or reuse and which downstream stages must reference the same anchor.
- **evaluation.domain_constraints**: write hard constraints distilled from canvas facts, not vague evaluations.
- **domain_contract / creative_contract**: write the reuse protocol that most affects quality in the current scenario into planning / conduct_rules / evaluation and the Recipe quality standards. Do not add schema fields, and do not tuck it into a single Recipe prompt only.
- **Dynamic topology constraints**: explain how this Skill decides node count, dependencies, parallel branches, review gates, and terminal composition at runtime; do not save a fixed workflow template.
- **Recipes**: reuse existing capability modules first, then create new ones for gaps; split by capability boundary, not mechanically by node type.

## 6. Skill Identity and abstraction boundary

Abstraction is not flattening. When the user chooses "abstract into a general template", the Agent should remove non-reusable case variables but keep the reusable protocol, product form, and usage scenario that best represent this capability.

First classify the terms in the prompt evidence into five categories:

- `case_variables`: specific brand names, specific person/character names, specific product names, one-off plots, one-off lines, and project-specific slogans. In an abstract template, delete, parameterize, or demote them to examples.
- `reusable_protocol_terms`: cross-project reusable creative protocols, domain conventions, style language, rule boundaries, voice personas, gameplay mechanics, and review standards. Keep them in an abstract template.
- `output_format_terms`: the Skill's product forms, e.g. short film, poster, storyboard table, report, courseware, audio, game assets, composition plan.
- `use_case_terms`: usage scenarios, e.g. brand ad, teaching explanation, compliance review, data retrospective, character design, product showcase.
- `workflow_method_terms`: internal methods, e.g. character anchoring, prop anchoring, storyboard reference, shot-by-shot generation, audio mixing, quality gates.

The Skill name, ID, description, and `triggers.keywords` must prefer combining:

```text
reusable_protocol_terms + output_format_terms + use_case_terms
```

`workflow_method_terms` may supplement but cannot monopolize the Skill identity. Do not name a Skill that has a clear domain protocol with only internal method words such as "character-driven", "storyboard flow", "data processing", or "document generation".

Keywords must cover four categories:

- **protocol keywords**: reusable protocol terms.
- **output format keywords**: product form terms.
- **use case keywords**: application scenario terms.
- **workflow method keywords**: workflow method terms.

Bad patterns:

- The name comes only from the node topology or workflow method.
- When abstracting a template, deleting reusable protocol terms together with case variables.
- Keywords contain only brand variables, or only flow node words.
- The first screen of the description only says "first A, then B, then C", without saying which protocol, product, and scenario this capability suits.

## 7. Subjective decision boundary

A Skill only freezes the rules for which "a different author should reach the same answer". Choices that vary with the author, aesthetics, or the goal of this run should not be hard-coded into the Skill.

- Reproducible rules: asset anchors, reference relationships, prohibitions, material dependencies, stage preconditions, and the source of output specs.
- Subjective choices: the specific shot count, pacing, composition of a single shot, and preference among candidate looks.

There are two ways to handle subjective choices:

- **Ask the user**: when a structural choice would change the Graph or cannot be compared side by side, confirm with a question card first.
- **Offer candidates**: for outputs that can be compared side by side, let the runtime handle them by count, evaluation criteria, or user choice; do not write personal preference as a hard rule.

## 8. Recipe splitting principles

A Recipe's boundary should correspond to a reusable capability module. Before generating a draft, look at the currently enabled catalog summary; if the summary is missing or insufficient, call `freezone_list_agent_catalog(kind="recipes", query=...)` to read a compact Recipe summary first, then judge whether an existing Recipe covers the same stage craft. Reuse where possible, and create new ones only for real craft gaps. After confirming the reuse/new decisions, write the result into `freezone_put_agent_catalog_draft_outline` and set `catalog_checked=true`. In the outline, `reuse=existing` means use a saved Recipe and no Recipe chunk needs to be submitted; only `reuse=new` needs a later `freezone_put_agent_catalog_recipe`.

Order of judgment:

1. First list the execution stages this Skill actually needs.
2. Then compare against the name, output_kind, action_keys, planning_prompt, and result_summary of existing Recipes.
3. Compare execution craft, not just names, node types, `output_kind`, or broad category labels. Craft includes: the object processed, the processing action, the product form, the key structure, the constraint boundary, the downstream use, and the workflow responsibility.
4. If the craft is the same, reuse the existing Recipe; a different style, topic, or brand does not mean a new Recipe is required.
5. If the craft differs, do not reuse. In particular, when a stage product will serve as a later consistency anchor, review gate, splitting basis, or composition material, you cannot reuse a Recipe that only covers generic generation, generic enhancement, or plain content organization.
6. Create a new Recipe only when no existing Recipe can express this stage, or forcing reuse would make a Recipe vague, misleading, or over-generalized.
7. Every new-Recipe decision must state the craft gap in the outline's `new_recipe_craft_gap`; if there is no concrete gap, switch to reusing an existing Recipe.
8. `allowed_recipe_ids` lists only the Recipe ids needed by this Skill's actual executable chain. It is a runtime allowlist, not a "collection of related Recipes".

Division of labor between Skill and Recipe:

- The Skill owns style identity, domain rules, start-of-run options, execution stages, review gates, asset inheritance, rework boundaries, and which Recipes are allowed.
- A Recipe owns the prompt/instruction-generation craft of one stage, e.g. how to turn upstream character settings into a character anchor prompt, or how to turn a storyboard table into shot-by-shot video prompts.
- A Recipe does not store this Skill's visual style. A new Recipe's `id`, `name`, `system_prompt`, `must_have_items`, `planning_prompt`, and `result_summary` must not contain the current Skill's style words, aesthetic words, topic names, or case variables; these are inherited at runtime from the Skill's `prompt_guide`, `conduct_rules`, user input, and upstream nodes.
- Do not write internal collaboration phrasing in Recipe copy such as "do not override the style constraints injected by the Skill" or "this Recipe is only responsible for...". Write directly in task language: what comes in, what goes out, what must be included, and what counts as failure.
- A Recipe's id and name must match its real granularity. Do not give a Recipe that contains domain rules an overly generic stage name.

Common splits:

- **Subject anchoring**: lock the main object or key visual asset into a reusable reference.
- **Auxiliary asset anchoring**: generate independent or relational assets that later stages will reference repeatedly.
- **Style lock / creative brief**: consolidate visuals, tone, structure, expression boundaries, and prohibitions.
- **Storyboard / scene breakdown**: expand the narrative framework into panels, shots, lines, and calls to action.
- **Video clip generation**: generate multiple short clips per storyboard segment while keeping the node reference chain intact.
- **Audio/music generation**: generate sound effects, narration, BGM, or music specs.
- **Composition plan**: if AI-assisted editing decisions are needed, use a text Recipe to produce the clip order, audio levels, transitions, duration, and output aspect ratio plan; the actual final composition is created at runtime by the dynamic plan as a terminal `videoComposeNode`.

Do not offer `videoCompose`, final media composition, or final film assembly as Recipe splitting options, and do not count the terminal composition step in the Recipe count. The correct phrasing is "3 Recipes + a final videoCompose workflow step", not "4 Recipes including composition".

Do not generate only generic modules named by node type such as "image Recipe / video Recipe / audio Recipe". They are usually too weak.

Also do not automatically add a preceding text Recipe just to pad steps. Put one in `allowed_recipe_ids` only when the runtime really needs to create the corresponding text node and later nodes will consume that text result. If the Skill already carries those decisions via start-of-run options and planning rules, do not create or reference such a Recipe.

Do not create relay Recipes such as "global spec", "final spec", or "input analysis" to carry aspect ratio, duration, style, material strategy, or execution mode. That authoritative information should come from `input_parameters`, `planning.prompt_guide`, `planning.conduct_rules`, and confirmed inputs; a Recipe only handles the prompt-generation craft of its own stage.

Do not write stage-advancing phrasing in a Recipe, such as "enter the next stage after confirmation" or "generate downstream after this stage completes". Stage order, pausing, auto-advancing, and rework boundaries belong to the Skill's `planning.conduct_rules` and runtime authorization.

### Judging Recipe reuse scope

A Recipe is not better the more generic it is. When abstracting, first ask: after removing the current Skill's style, topic, and one-off case variables, is there still a clear craft left in this stage?

- If what remains is a clear input structure, output structure, quality standard, and failure boundary, it can be a shared Recipe.
- If what remains is only vague words like "stable, clear, reusable, high quality", the abstraction is too empty and a more specific Recipe boundary should be kept.
- If a Recipe's content contains clear domain rules, its ID and name must reflect that reusable scope; do not pretend it is a platform-wide generic capability.
- If a more generic version may appear in the future, do not claim an over-generic ID now; name the current Recipe by its real responsibility and add a truly generic version later.

Reusing an existing Recipe is also judged by craft. First state in one internal sentence what object this stage processes into what product, and how that product is used afterward. Then compare against the candidate Recipe's `planning_prompt`, `result_summary`, and `must_have_items`. If the candidate Recipe's product form, key structure, or downstream use differs, do not reuse it even if the names are similar.

Before reusing an existing Recipe, it must pass three questions:

1. **Is the output the same kind of thing?** For example, a single anchor image, a three-view model sheet, a multi-grid storyboard, a single video-clip prompt, an audio-layer prompt, and a plan text are not the same kind of output.
2. **Does downstream use it in the same way?** For example, a full-chain lock source, a plain reference image, a storyboard basis, a video material input, an audio layer, or a terminal result; different uses change the craft.
3. **Must the Recipe itself write in the current Skill's style, topic, or case to hold up?** If so, first move that content back into the Skill's `planning.prompt_guide`, `planning.conduct_rules`, or `evaluation`, then judge whether the remaining craft still matches.

If any of the three answers is no, do not write `reuse=existing`. The `reason` for `reuse=existing` must explain the matching points on all three questions, and cannot just say "same craft", "both are character/prop/storyboard/video", or "a similar Recipe already exists".

## 9. How to write domain_contract / creative_contract

When distilling a Skill from the canvas, do not just summarize "which nodes there are". You must first do `prompt_evidence_analysis`: extract repeated evidence from node prompts, media dimensions/duration, source filenames, reference relationships, and edges, then derive the scenario's `domain_contract` or `creative_contract`.

This contract is not a new schema field; it must land in existing fields:

- `planning.planning_notes`: explain how the protocol affects the execution path and stage order.
- `planning.conduct_rules`: write it as hard execution rules.
- `evaluation.domain_constraints`: write it as checkable quality constraints.
- `planning.planning_notes` / `planning.conduct_rules`: state stage inheritance, exceptions, prohibitions, and dynamic dependency rules.
- Recipe `system_prompt` / `must_have_items`: write the evidence that the Recipe needs to preserve or transform.

Contracts differ across domains. Express them in generic terms first and do not rush to fit a specific case:

- Visual ads: visual language, performance style, brand tone, stage-specific style exceptions, composition does not generate new style.
- Data analysis: metric definitions, time range, units, filter conditions, chart interpretation boundaries.
- Legal/compliance: jurisdiction, clause basis, risk level, boundaries such as not substituting for a lawyer's opinion.
- Teaching content: grade level, knowledge points, explanation pace, exercise difficulty, forbidding out-of-syllabus concepts.
- Game assets: viewpoint, proportion, action conventions, collision/state rules, UI feedback rules.
- Audio content: voice persona, speaking rate, emotion, timbre, forbidden noise or conflicting music.

When writing a contract, distinguish at least three layers:

- **Global language**: the visual, text, sound, or behavioral register the whole Skill must maintain.
- **Stage exceptions**: stages that need a different presentation, granularity, or review rules.
- **Inheritance rules**: which upstream results downstream stages must reuse and what must not be reinvented.

Do not write only vague sentences like "keep the style consistent" or "quality must be good". They are too weak to guide different handling at different stages.

## 10. How to write a Recipe system_prompt

A Recipe `system_prompt` is not role-play boilerplate. It must match the execution contract of its `output_kind`:

- When `output_kind=text`, the current Agent / LLM directly generates the deliverable final text and does not hand the result to another text model to continue.
- When `output_kind=image/video/audio`, the current Agent / LLM converts the upstream input into a prompt or instruction executable by the corresponding media generation node; it does not generate the final media itself.

It must state clearly:

- [Input sources]: whether they come from user text, the current canvas, selected nodes, upstream media, or the previous Recipe.
- [Task goal]: for a text Recipe, what final text to produce; for a media Recipe, what downstream generation instruction to produce.
- [Output structure requirements]: which modules the final text or media generation instruction must contain.
- [Quality standards]: checkable standards that can trigger rework.
- [Prohibitions/constraints]: what not to do and which mistakes would pollute downstream.

When writing a Recipe, follow this priority: this round's user request > confirmed inputs > Skill hard constraints > Recipe craft > defaults. A Recipe must not claim to rank above user input, confirmed specs, or Skill hard constraints.

Do not write only:

```text
You are a professional director who excels at generating high-quality video prompts.
```

Write it like:

```text
You will convert the upstream storyboard table, character anchors, and prop anchors into a video prompt executable by a single videoGeneration node. The output must include character consistency, reference sources, shot action, sound effects, duration, aspect ratio, and negative constraints. Important: your output is a single prompt/instruction that will be fed to the downstream videoGeneration node for execution; do not generate the final video content yourself.
```

## 11. Dynamic workflow planning requirements

A Skill does not store a fixed node topology. At each run, the Agent generates a complete `freezone_workflow_plan.v1` based on the user's goal for this run, input materials, Skill rules, and available Recipes.

A Skill draft must provide sufficiently explicit planning constraints:

- Stage order and the stages allowed to run in parallel.
- The Recipe `action_keys` each stage is allowed to use.
- Upstream inputs, material inheritance, and reference rules.
- The anchors to establish or reuse, and which downstream nodes must reference the same anchor.
- How the node count is determined by the current requirements.
- Default aspect ratios of media such as images and video, and stage exceptions.
- Approval, waiting, quality gates, and partial-rework boundaries.
- When final composition is needed, the input conditions of the terminal `videoComposeNode`.

`videoCompose` is not a Recipe:

- Do not create a Recipe for `videoCompose`.
- Do not claim a Recipe will directly drive a `videoComposeNode` to generate content.
- If AI-assisted editing decisions are needed, create a `textGeneration` Recipe to produce the composition plan, and let the dynamic WorkflowPlan add the terminal composition node.
- Terminal composition can only consume already generated video and audio assets; it cannot treat planning text or ordinary prompts as media input.

The dynamic plan must explicitly carry each executable node's `recipeId`, and canvas nodes can be created only after it passes the Skill's Recipe allowlist and the WorkflowPlan contract validation.

## 12. Extracting hard constraints from prompts

Phrases that repeat across canvas prompts are usually more important than node names. They must be distilled into executable rules.

Example types:

- Restrictions on a subject's appearance, structure, or identity -> subject attribute checks and negative-prompt rules.
- The same subject must not be duplicated, deformed, or reinvented -> cross-stage consistency and anchor reference rules.
- Viewpoint, proportion, or display scope of key assets -> asset anchoring and composition rules.
- A stage must use an independent presentation -> stage style gate.
- Closing, delivery, or final-cut requirements -> final product rules.
- Explicit references to upstream results -> node reference chain integrity rules.

Do not compress these into "keep the style consistent". That is not an executable rule.

## 13. Aspect ratio and media facts

Judge the aspect ratio from both the node fields and the media dimensions.

- Characters/product props are commonly 1:1.
- Storyboards may be 16:9.
- A video node's field and its actual dimensions may differ; if the dimensions are 720x1280, recognize it as a vertical-orientation fact and state the difference between the "field default" and the "actual output" in planning.
- If a workflow has multiple aspect ratios, do not write every task type with the same default ratio; write the primary ratio that the user needs to control each run as a start-of-run option in `input_parameters`, and write variants into workflow steps.

## 14. Avoid low-quality patterns in the output

Do not produce these patterns:

- Summarizing only by node type: "first image, then video, then audio, then composition".
- A Skill name, ID, or keywords generated only from workflow_method_terms, lacking the reusable protocol, product form, and usage scenario.
- A Recipe system_prompt that is just role-play boilerplate: "You are a professional director/designer".
- Evaluation standards that are only "consistent style", "good quality", "strong ad feel".
- planning_notes that merely list stage names without stating the dynamic node count, dependencies, parallelism, and review rules.
- Writing a strong style only as a vague style field, without forming an executable creative_contract.
- Hard-coding the current brand and characters into all fields, making reuse impossible.
- Writing all Recipes as the same kind of prompt compiler, without distinguishing inputs, outputs, and quality gates.
- Creating spec relay Recipes that repeatedly store aspect ratio, duration, style, material strategy, or execution mode.
- Writing stage-advancing instructions such as "enter the next stage after confirmation" in a Recipe.
- Writing subjective aesthetic choices as Skill hard rules, so that the topology and results are fixed on every run.
- Saying only in text "keep the subject consistent" without stating the anchor establishment, reuse, and downstream references in planning.
- Treating tool schema field descriptions as Skill content.
- Building the first-round questions around id, category, action_keys, node_type, or schema fields.
- Creating a prompt Recipe for `videoCompose`, or claiming a Recipe will directly drive `videoComposeNode` to generate the final video.

Good output should let the user see that this is not a summary but a creative craft that can be executed again.

## 15. Field-writing quick reference

This section is the pre-serialization landing check. Complete the earlier capability modeling and reuse judgments first, then fill the fields here; do not generate content field by field in the reverse direction.

### Division of labor among the three `planning` fields

- `planning.prompt_guide` holds the global creative register: style language, tone, material/sound/structure requirements, language requirements, stage exceptions, and cross-stage expression. Anything that would change when switching style or expression protocol goes here first.
- `planning.planning_notes` holds dynamic Graph planning: the stage path, task types, action keys, dependencies, parallelism, anchor establishment and reuse, and how input parameters affect node count and aspect ratio. It is for Hermes to plan the graph, not a node prompt template.
- `planning.conduct_rules` holds hard behavioral boundaries: confirmation points, no skipping steps, material inheritance, anchor references, partial rework, cost/risk boundaries, and hard prohibitions. It is not ordinary aesthetic description nor a Recipe output template.

If a sentence describes "what the result should look like", it usually goes in `prompt_guide`; if it describes "how the graph should be built", it usually goes in `planning_notes`; if it describes "what must absolutely not be done", it usually goes in `conduct_rules`.

### Skill fields

| Field | What to write | What not to write |
| --- | --- | --- |
| `schema_version` | Fixed `dramaclaw.workflow-skill.v1`. | Do not let the user choose; do not invent new versions. |
| `version` | New ones usually start from `1.0.0`; when editing existing ones, keep or bump according to the actual change. | Do not write dates, model versions, or Hermes versions. |
| `id` | Lowercase hyphenated ID derived from the reusable protocol, product form, and usage scenario. | Do not use only node method words; do not include the current project name, character names, spaces, or non-ASCII characters. |
| `name` | A Skill name the user understands, highlighting the applicable scenario and final product. | Do not show internal method names or the ID; do not use node order as the name. |
| `description` | One sentence saying what creative task this Skill suits and what it can reliably produce. | Do not restate the node order; do not write internal notes such as "manages Agent behavior". |
| `category` | Business category, e.g. `video`, `image`, `audio`, `text`, `workflow`, `general`. | Do not write node types, model names, or project names. |
| `triggers.keywords` | Cover four categories of words: protocol, product, usage scenario, workflow method. | Do not include only brand variables, or only "storyboard, video, audio". |
| `triggers.node_scopes` | Only triggerable catalog scopes: `textGeneration`, `imageGeneration`, `videoGeneration`, `audioGeneration`. A complete workflow may cover several by primary input/output. | Do not write canvas node types such as `imageGenNode`, `videoNode`, `videoComposeNode`. |
| `allowed_recipe_ids` | The allowlist of Recipes this Skill's real execution chain may use. Reuse existing Recipes first; create new ones only for gaps. | Do not stuff in "possibly related" Recipes; do not add preceding steps that the runtime will not create or downstream will not consume; do not add non-Recipe actions completed by fixed canvas components. |
| `input_parameters` | Choices the user may vary before each run, e.g. aspect ratio, count, duration, switches, execution mode. | Do not write schema/version/model/provider; do not hard-code one-off case variables into planning. |
| `planning.planning_notes` | Start from the executable path: stage order, task types, action keys, dependencies, parallelism, waiting/confirmation, how input parameters affect the flow, anchor establishment and reuse, final product conditions. Write inheritance rules afterward. | Do not write only "first A then B"; do not save fixed node IDs or a fixed topology; do not treat non-Recipe actions as Recipes. |
| `planning.prompt_guide` | Write the global creative register: style language, narrative tone, material/sound/structure requirements, language requirements, stage exceptions. | Do not write tool-call instructions; do not explain fields to the Agent; do not write only vague adjectives. |
| `planning.conduct_rules` | Write hard execution rules: order, review gates, material inheritance, anchor references, no early generation, partial rework scope, spec and cost/risk boundaries. | Do not write only aesthetic principles; do not write "try to if possible". |
| `evaluation.rating_bands` | Write score anchors describing the visible quality differences between scores. | Do not write "fairly good / average / poor quality" for every band. |
| `evaluation.quality_threshold` | Write the minimum acceptable score, e.g. `0.8`. | Do not treat it as a percentage string. |
| `evaluation.domain_constraints` | Write checkable domain constraints, e.g. subject consistency, complete references, stage confirmation, output specs met. | Do not write vague slogans such as "consistent style, good quality". |
| `evaluation.visual_review_items` / `text_review_items` | Write review dimensions, weights, and judging notes. A visual Skill covers at least subject consistency, composition, style, and clarity; a text Skill covers structure, facts, tone, and executability. | Do not pile all weights onto "overall effect". |

### How to write `input_parameters`

Every parameter must let the user know "how this run will change".

- `id`: a stable English ID, e.g. `aspect_ratio`, `shot_count`, `audio_mode`.
- `label`: a user-readable name, e.g. "Aspect ratio", "Shot count", "Audio mode".
- `type`: choose `single_select`, `multi_select`, `text`, `number`, or `boolean` by input form.
- `required`: set `true` only when there is no default value and it affects whether the workflow can continue.
- `default`: provide a safe default; common items such as aspect ratio, duration, and count should have defaults where possible.
- `options`: keep only one list of option values, written directly as values the user understands; do not split into an "internal value" and a "display text".

Do not make model preference, vendor, cost strategy, or Schema version a start-of-run option. Result controls that may change each run and whose impact the user understands should go here first.

### Recipe fields

| Field | What to write | What not to write |
| --- | --- | --- |
| `schema_version` | Fixed `dramaclaw.recipe.v1`. | Do not let the user choose; do not invent new versions. |
| `version` | New ones usually start from `1.0.0`; when editing existing ones, keep or bump according to the actual change. | Do not write model versions. |
| `id` | Reflect the real craft granularity. Use a generic name for a generic craft; use a domain name that conveys the boundary for a domain craft. | Do not give a Recipe containing clear domain rules an overly generic ID. |
| `name` | A user-readable stage capability name stating what this stage produces. | Do not show action keys or node types. |
| `output_kind` | The business product type of the Recipe: `text` directly produces final text; `image`, `video`, `audio` produce the generation prompt for the corresponding media node. | Do not use canvas node names; do not treat `text` as a prompt for a second text generation. |
| `action_keys` | Stable keys matching this stage's actions, usually the same as the id or the stage action. | Do not put in multiple unrelated actions; do not stuff in the Skill id. |
| `system_prompt` | The execution instructions for the current LLM. `text` must guide it to directly produce the final text; media types must guide it to produce a prompt/instruction executable by the downstream media node. Both must include input sources, task goal, output structure, quality standards, and prohibitions. | A text Recipe must not require a second model call; a media Recipe must not pretend the final media has been generated; do not write internal collaboration phrasing such as "do not override the Skill style"; do not write only role-play boilerplate. |
| `must_have_items` | The structural modules the business product of this stage must contain. | Do not write only style adjectives; do not write scheduling steps. |
| `planning_prompt` | One sentence of business description, in a form like "Based on X, generate/extract/rewrite Y." | Do not explain when to call it, how downstream connects, or how nodes are arranged; do not write stage advancement. |
| `result_summary` | One sentence or phrase stating what business result the Recipe outputs. | Do not write mechanism phrasing such as "feed into the imageGeneration node" or "for downstream execution". |
| `requires_source_media` | `true` when this stage must reference image/video/audio material, e.g. shot-by-shot video needs storyboard/character/prop references. Pure text planning is usually `false`. | Do not set true just because reference material might exist; set true only when missing material would make correct execution impossible. |

Recipe fields must not carry the Skill's style. Anything that would change when switching visual style, aesthetics, topic, or case goes first into the Skill's `planning.prompt_guide`, `planning.conduct_rules`, or `evaluation`. A Recipe only states how this stage processes input, what structure it outputs, and what counts as failure. `id/name` may reflect a stable domain craft, product form, or usage scenario, but not the style identity specific to the current Skill.

### Recommended skeleton for a Recipe `system_prompt`

#### Image, video, and audio Recipes

```text
[Role]
You turn the upstream input into a prompt/instruction executable by a <node type> node.

[Input sources]
- The user's goal for this run or start-of-run options
- Confirmed upstream text/media/reference material
- Constraints that the current stage must inherit

[Task goal]
Generate one complete <imageGeneration/videoGeneration/audioGeneration> node prompt/instruction, used to...

Important: your output is a single prompt/instruction that will be fed to the downstream <node_type> node for execution; do not generate the final content yourself.

[Output structure requirements]
1. ...
2. ...

[Quality standards]
- ...

[Prohibitions/constraints]
- ...
```

#### Text Recipe

```text
[Role]
You directly generate the deliverable final text from the upstream input.

[Input sources]
- The user's goal for this run or start-of-run options
- Confirmed upstream text/media/reference material
- Constraints that the current stage must inherit

[Task goal]
Directly generate the complete <text product type>, used to...

Important: the output is the final text result of this stage; no other text model needs to, or may be asked to, continue generating.

[Output structure requirements]
1. ...
2. ...

[Quality standards]
- ...

[Prohibitions/constraints]
- ...
```

"Constraints that the current stage must inherit" here must be written in business language, not in internal collaboration phrasing such as "inherit the Skill prompt_guide".

### Criteria for shared Recipes versus domain Recipes

- If different Skills differ only in style, topic, tone, or industry, but the stage input, output structure, quality standards, and risk boundaries are the same, prefer reusing the Recipe.
- If a stage contains clear domain rules, or its input structure, output structure, quality standards, or review boundaries clearly differ, create a domain Recipe.
- If a preceding step only does planning or confirmation within the Skill and does not create a node that downstream can consume, do not put it in `allowed_recipe_ids`.

### Self-check before finalizing

Before calling `freezone_finish_agent_catalog_draft`, do an internal self-check; when you find a clear problem, fix it directly instead of leaving it to the user:

- Whether each Recipe is responsible for only one executable stage. If a Recipe would produce two or more downstream nodes at once, split it.
- Whether audio Recipes are responsible only for audio layers such as narration, sound effects, and BGM; do not write final video composition into an audio Recipe.
- When the Skill already has start-of-run options, the Recipe must not hard-code the corresponding variable values such as count, aspect ratio, and duration.
- Whether style, topic, brand, character identity, and global quality register live in the Skill; the Recipe keeps only this stage's input, output structure, quality standards, and failure boundary.
- Whether a new Recipe's id/name/result_summary carry none of the current Skill's style identity. If the name would have to change when switching style, it has style from the Skill baked in; change it to a craft-describing name and move the style back to the Skill.
- If a Recipe is left with only vague words like "stable, clear, reusable, high quality" after abstraction, it is too empty; keep a more specific domain boundary and name.

When landing fields, always follow this line: **a thick Skill carries look-and-feel, asset strategy, stage principles, and quality standards; a Recipe carries the reusable stage craft; the Schema stays thin and gets no new fields.**

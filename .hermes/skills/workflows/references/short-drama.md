# Short Drama Workflow

For short dramas, novel-to-video and story-to-video.

This workflow is Shrimp Canvas's own node-based production flow. It abstracts only the short-drama production method, and does not call, reference or bind to any external project mainline pipeline. After the user confirms the plan, the frontend creates real Shrimp Canvas nodes and links; afterwards the Agent operates these nodes to generate content step by step, and each node uses its own implementation to call the API and write the result back onto the canvas.

## Material requirements

- One of the following is required: a screenplay, a novel, a story synopsis, an episode outline, character settings, or long text the user pastes in chat.
- Recommended: descriptions of the protagonist / antagonist / supporting characters, target number of episodes, per-episode duration, style references, character reference images, scene reference images.
- Optional: existing storyboards, narration scripts, voiceover requirements, music style, target aspect ratio, final duration.

When story text is missing, do not pretend a screenplay exists; first plan the minimal skeleton `creative_brief -> story_outline`, and ask in `missing_inputs` for a screenplay, synopsis or character settings.

## Production chain overview

`story input -> plot structure -> character relationships -> scene planning -> episodes/acts -> beats -> storyboard -> image assets -> video clips -> audio/music -> final composition -> QA and repair`

This chain is the order of production stages and does not equal the order of canvas links. Canvas edges express only real input dependencies, reference dependencies or context dependencies.

## Shrimp Canvas node-based stages

### 1. Input and resource layer

Purpose: carry the user's material and the current project/canvas resources.

Suggested nodes:

- `textAnnotationNode`: screenplay, novel excerpts, story synopsis, creative brief, user requirements.
- `imageGenNode` or existing image nodes: character reference images, scene reference images, style reference images.
- Resource viewer nodes or resource reference nodes: images, videos, audio and files already in the current project/canvas.

Dependency principles:

- Input text can be linked to plot analysis, character setting, scene setting, storyboard planning, image generation and video generation nodes.
- Image references link only to the image/video nodes that really need reference images; do not chain all the material into one line.

### 2. Plot understanding layer

Purpose: turn the raw story into a producible structure.

Suggested nodes:

- `textAnnotationNode`: story summary, world view, main conflict, emotional tone.
- `textAnnotationNode`: character relationships, character goals, antagonists/obstacles, payoff points/twists.
- `scriptNode`: use it when the user explicitly needs a structured screenplay, episode outline, shot table or storyboard table.

Dependency principles:

- Screenplay/synopsis input -> story summary/structure node.
- Screenplay/synopsis input -> character relationship node.
- Story summary + character relationships -> episode/beat planning node.

### 3. Episode and beat layer

Purpose: break a long story into production units that can be generated step by step.

Suggested nodes:

- `textAnnotationNode`: episode planning, act planning, beat group.
- `textAnnotationNode`: the plot goal, visual description, narration/dialogue and mood of a single beat.
- `scriptNode`: used to store the episode/beat table when structured fields are needed.

Dependency principles:

- For a long novel, do not expand all shots at once; first split into episode / act / beat group.
- Each beat can later independently connect to character, scene, image, video and audio nodes.
- A beat node is a semantic source, not an execution relay that must be chained.

### 4. Character and scene asset layer

Purpose: provide stable references for later shot generation.

Suggested nodes:

- `textAnnotationNode`: settings for the protagonist, antagonist and key supporting characters.
- `textAnnotationNode`: supporting-character pool, extras pool, temporary character notes.
- `imageGenNode`: character portraits, identity images, costume/look references.
- `textAnnotationNode`: high-frequency scene settings, temporary scene pool, prop settings.
- `imageGenNode`: scene reference images, prop reference images, style boards.

Dependency principles:

- Character setting + style requirements -> character portrait/identity image.
- Scene setting + style requirements -> scene reference image.
- Character/scene/prop reference images link only to the storyboard image or video nodes that need them.

### 5. Storyboard and first-frame / image layer

Purpose: turn beats into visual inputs usable for video generation.

Suggested nodes:

- `textAnnotationNode`: storyboard description, camera movement, composition, character action, atmosphere.
- `imageGenNode`: storyboard images, first-frame images, character-scene composite images, keyframes.

Dependency principles:

- Beat description + character reference + scene reference + style board -> storyboard/first-frame image node.
- If a shot needs multiple character references, the multiple character nodes should each feed into the same image node.
- Trigger the downstream video node only after the image node has finished generating and produced a usable image URL.

### 6. Video clip layer

Purpose: generate an independent video clip for each beat or shot.

Suggested nodes:

- `videoNode`: a single shot / single beat video clip.

Dependency principles:

- Image/first frame + storyboard description -> video node.
- A pure-text shot can also go directly from text description -> video node.
- Do not use the final compose node early; consider composing only after real video clips exist.

### 7. Sound layer

Purpose: generate or organize voiceover, background music, sound effects and subtitle copy.

Suggested nodes:

- `textAnnotationNode`: narration script, dialogue script, subtitle script, sound-effect notes.
- `audioNode`: TTS, character voices, background music, sound effects.

Dependency principles:

- Beat/storyboard copy -> narration/dialogue node.
- Narration/dialogue + voice setting -> audio node.
- Both audio nodes and video nodes can serve as final compose inputs.

### 8. Composition and QA layer

Purpose: compose clips, audio and subtitles into the final cut, and record issue fixes.

Suggested nodes:

- `videoComposeNode`: use only when one or more real video clips already exist.
- `textAnnotationNode`: QA checklist, failure reasons, retry strategy, revision suggestions.

Dependency principles:

- Multiple video clips + audio + subtitle script -> compose node.
- A QA node may reference video clips, first frames, audio and compose results, but do not make the QA node a mandatory relay of media generation.

## Plan output requirements

When outputting `freezone_workflow_plan.v1`, it is recommended to include:

- `phases`: list the production stages by the 8 layers above.
- `analysis.production_units`: state whether to expand by episode, act, beat group or single beat first.
- `nodes`: use real Shrimp Canvas node types; write the abstract responsibilities in label/description.
- `edges`: write only real input dependencies, especially multi-source merges into image, video, audio and compose nodes.
- `layout.groups`: show input, plot, characters, scenes, beats, images, videos, audio, compose and QA in separate zones.
- `execution_policy`: must require user confirmation; do not auto-create nodes and do not auto-generate content.

Only after user confirmation is the plan handed to the canvas node operation skill to be turned into frontend commands. After the nodes are created, the Agent can trigger node actions step by step following the order of link dependencies; the user can also manually open any node to modify parameters, upload material, run or rerun the node.

## Dynamic expansion

- Protagonist, antagonist, key supporting characters: one character node each.
- Extras and one-off characters: merge into a supporting-character pool.
- High-frequency scenes: one scene node each.
- One-off locations: merge into a temporary scene pool.
- Long novels: split by episode / act / beat group first; do not expand all shots at once.
- Short stories: key beats can be expanded directly into `beatContextNode`.
- When the user gives only a one-line idea: first create the creative brief, story synopsis, character/scene placeholders and a trial production chain for the first beat; do not pretend a complete screenplay exists.
- When the user has uploaded a complete screenplay: first plan reading/summarization, character/scene extraction, and episode/beat breakdown, then expand the first batch of generatable shots.
- When the user already has character or scene reference images: prefer connecting them as reference inputs to the corresponding image/video nodes instead of regenerating all the assets.
- When the user asks to "try a segment first": expand only the minimal closed loop of 1 episode or 1-3 key beats: beat -> image/first frame -> video -> audio -> compose preview.

## Common minimal closed loops

### Only a one-line idea

`creative brief -> story synopsis -> protagonist/antagonist settings -> first beat -> first-frame image -> video clip`

### A complete screenplay

`screenplay input -> story summary + character relationships + scene planning -> episode/beat table -> beat storyboard -> image/first frame -> video clip -> audio -> compose`

### Character/scene reference images

`character reference image + character setting + scene reference image + beat storyboard -> image/first frame -> video clip`

### Existing video clips

`video clips + audio + subtitle script -> final composition -> QA and repair`

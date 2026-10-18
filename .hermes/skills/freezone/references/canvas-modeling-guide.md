# Shrimp Canvas Canvas Operation Handbook

This handbook is neither a protocol document nor a parameter table. It answers:

- What responsibility each node on the canvas carries
- What a link expresses in the product
- What node relationships a single natural-language sentence from the user should usually become
- Which practices look reasonable but actually ruin the canvas semantics

## 1. Canvas operation philosophy

- The canvas is not a flowchart editor; a link does not mean "do A first, then B".
- A canvas link expresses: input, reference, context dependency.
- The currently selected node is only the user's current focus; it is not necessarily a legal input source for a downstream node.
- Two nodes being related in business terms does not mean they should be linked directly.
- If a requirement only "semantically follows the previous step" but has no real input/output relation, you may:
  - Create a standalone node
  - Place it nearby
  - Put it into the same group if necessary
  - Not force an edge

## 2. Node classification

Classify each node before writing a command. The classification decides what it can do and which edges it can have.

### 2.1 Semantic source nodes

These nodes provide text, settings, scripts and context, and are usually not final media results themselves.

- `textAnnotationNode`
  - Ordinary text, copy, settings, slogans, character descriptions, storyboard descriptions, voiceover scripts
  - By default a planning text or content container that the Agent can read, organize and rewrite
  - Only when the content is already a prompt, voiceover script or shot input that a generation model can consume directly is it used as a direct input of an image/video/audio node
  - It cannot be described as "executing image/video generation itself"
- `scriptNode`
  - Structured script / script generation node
  - Suitable for tabular, structured script artifacts with shot items
  - It is not an ordinary free-text node, nor the current default intermediate node of a workflow
  - At this stage, if you are only writing ideas, storyboard descriptions, voiceover scripts, character settings or ad scripts, prefer `textAnnotationNode`
  - Use `scriptNode` only when the user explicitly wants "a structured script / shot table / storyboard table", or the product side explicitly needs a script generator node
- `beatContextNode`
  - Shot context, plot context, mainline context
  - A strong semantic source, but not a media generation result

### 2.2 Generation nodes

These nodes actually call a model or frontend generation logic to produce media.

- `imageGenNode`
  - The node that actually produces images
  - Can consume upstream text, image references and so on
- `videoNode`
  - The node that actually produces a single video clip / single shot
  - Supports different generation modes, such as text-to-video, image-to-video, first/last frame, omni-reference, image reference
- `audioNode`
  - The node that actually produces voiceover, speech and music

### 2.3 Compose / export nodes

- `videoComposeNode`
  - The final timeline/compose node, used to compose multiple video clips and audio tracks into the final video
  - Its inputs should be media results already produced by `videoNode` / `audioNode`, or placeholders of nodes in the same batch of commands that will produce video/audio
  - It does not consume creative briefs, storyboard text or prompts; that text should go to image/video/audio generation nodes, or be shown grouped with the compose node
  - It is not the default entry for video generation

### 2.4 Display / tool nodes

- `threeDWorldNode`, `pano360ViewerNode` and the like are oriented more toward display, viewing or specific tool capabilities
- Do not treat these nodes as general media generation nodes

## 3. Link semantics

### Correct understanding

- `textAnnotationNode(semanticOutputRole=input_text) -> imageGenNode`
  - Means: this text is already a directly consumable image generation input
- `imageGenNode -> videoNode`
  - Means: this image serves as the video generation input
- `textAnnotationNode(semanticOutputRole=input_text) -> videoNode`
  - Means: this text is already a directly consumable video generation input
- `imageGenNode + textAnnotationNode(semanticOutputRole=input_text) -> videoNode`
  - Means: the image and the text together serve as the video input
- `textAnnotationNode(ordinary brief/settings) + imageGenNode` in the same group, but not linked
  - Means: they belong to the same workflow in business terms, but the brief is not yet a direct generation input
- `textAnnotationNode(theme direction/creative points) -> textAnnotationNode(storyboard draft)` with `context_for`
  - Means: the former provides context, constraints or explanation for the latter; if they are merely parallel materials, just put them in the same group without a link

### Incorrect understanding

- `imageGenNode -> textAnnotationNode -> videoNode`
  - Wrong, because this looks like a "sequential flow", but the intermediate text node is not the only legal relay for video generation
- `textAnnotationNode(creative points) -> textAnnotationNode(storyboard draft)` with `prompt_for`
  - Wrong; `prompt_for` is not used between ordinary text nodes; text-to-text uses `context_for` or no link
- `textAnnotationNode(storyboard draft) -> videoNode` with `media_input_for`
  - Wrong; text is not media; if the storyboard draft is only planning material, group it first and do not connect it directly to the video
- "It is related to this node, so connect it"
  - Wrong; only a real input relation should be linked

## 4. How to build common tasks

### Text to image

User intent:

- "Make an image from this character setting"
- "Turn this ad copy into a KV"

Recommended canvas relation:

- `textAnnotationNode(semanticOutputRole=input_text) -> imageGenNode`

Principles:

- The text node provides an already organized generation prompt
- What actually produces the image is the `imageGenNode`
- Do not say "the text node executes generate_image"
- If the upstream text is only a creative brief / planning note, first refine it into the image node's prompt, or create a separate prompt node with `semanticOutputRole=input_text`; do not connect an ordinary brief directly to an image node.

### Image to video

User intent:

- "Turn this image into a video"
- "Make this image move"

Recommended canvas relation:

- `imageGenNode -> videoNode`

Principles:

- Prefer `videoNode` by default
- Do not create `videoComposeNode` by default

### Image + text to video

User intent:

- "Use this image plus this caption description to make a shot video"

Recommended canvas relation:

- `imageGenNode -> videoNode`
- `textAnnotationNode(semanticOutputRole=input_text) -> videoNode`

Principles:

- Connect the two inputs to the `videoNode` separately
- Do not chain them as `image -> text -> video`

### Creative framework -> storyboard script -> multi-shot material

User intent:

- "Help me make a public-service ad short film"

Recommended relations:

- `textAnnotationNode(creative framework)`
- `textAnnotationNode / scriptNode(storyboard script)`
- multiple `imageGenNode` / `videoNode`

Principles:

- The storyboard script node is a semantic source, not the default final media output node
- The Agent can read the script content and then split it into multiple shot nodes
- If the script node itself is not a legal input source, do not force a link just to "flow on"
- The default recommendation at this stage:
  - Use multiple `textAnnotationNode`s first for the creative framework, ad script, voiceover script and shot descriptions
  - Use `scriptNode` only when a structured script artifact is needed

### Composing multiple video clips into a final cut

User intent:

- "Compose these video clips and the voiceover into the final ad"

Recommended relations:

- multiple `videoNode` -> `videoComposeNode`
- `audioNode` -> `videoComposeNode`

Principles:

- This is the main use of `videoComposeNode`: multiple video/audio inputs enter the compose track and output the final video
- When building a complete short-film workflow, you may create `videoNode` / `audioNode` / `videoComposeNode` and connect video/audio to the compose node with `composition_input_for`
- If it is only creative planning and there are no video/audio generation nodes yet, do not create a `videoComposeNode` ahead of time on its own

## 5. Video nodes and video compose nodes

### When to use `videoNode`

- Making a shot
- Making a short video clip
- Turning an image into a video
- Generating a video from text
- Generating a video from multiple reference materials

### When to use `videoComposeNode`

- There are already one or more real video clips
- You want to piece video clips, voiceover, subtitles and music into the final cut
- The user explicitly says "timeline composition / compose the final cut / final export"
- When building a complete short-film workflow, as the final compose stage that receives the upstream video/audio node outputs

### One hard rule

- `videoComposeNode` accepts only video/audio compose inputs. Do not connect planning text, briefs, storyboard text or prompts directly to it.
- If currently there are only images, text, scripts and audio and no video generation nodes, by default first create the video clip stage with `videoNode`, and then consider the compose node.

## 6. The correct understanding of text nodes

- `textAnnotationNode` is a "readable semantic source", not an "executable image-generation node"
- It can:
  - Be read by the Agent
  - Serve as the input of `imageGenNode` / `videoNode` / `audioNode` when the content has been organized into an executable prompt / voiceover script / shot input
  - Exist as same-group planning material when the content is only a brief, settings or planning, without being connected directly to generation nodes
- It should not be described as:
  - "executing generate_image itself"
  - "executing generate_video itself"

Correct phrasing:

- "Read this text node's content and create an image node from it"
- "Use this text as the prompt and generate an image with the image node"

Incorrect phrasing:

- "This text node calls the generate image action"

## 7. Current positioning of the script node

- `scriptNode` is currently more like a "result node of a script generator" or a "structured script container".
- It can be read, summarized and split by the Agent, but should not by default be treated as the direct input hub for later image/video nodes.
- If the user merely wants to "keep writing the script", "add a storyboard segment", "revise the voiceover script" or "add ad copy", prefer continuing to create or update `textAnnotationNode`.
- If the user explicitly wants:
  - a storyboard table
  - a shot table
  - a structured script
  - a script generator artifact
  then consider `scriptNode` first.
- The default strategy at this stage is: compose ordinary text content with multiple `textAnnotationNode`s; use `scriptNode` sparingly and with caution.

## 8. Forbidden patterns

- Do not say a text node can generate images directly
- Do not treat a script node by default as an image or video generation node
- Do not treat a script node by default as a generic "bridge" relay node
- Do not treat links as execution order
- Do not force an edge just to express "the next step"
- Do not create `videoComposeNode` by default when there are no real video clips
- Do not automatically treat the currently selected node as a legal input source
- Do not invent fields or enum values when the schema does not support them
- Do not mechanically group every batch operation; only the same theme, the same plan, the same workflow or the same material pack needs a work group
- Do not fabricate links just to add a new node to a theme group; a group expresses membership, an edge expresses a real input/reference/context dependency

## 9. Decision order

When facing a canvas request, think in this order first:

1. Is the user openly looking for ideas / asking for suggestions, or explicitly asking to operate the canvas? When openly looking for ideas, first ask questions and give directions in natural language, and write no commands.
2. Has the user explicitly asked to "put it on the canvas / build it / create nodes / generate a workflow / connect / lay out / run"? Without these explicit actions, do not automatically put things on the canvas just because you are in the Shrimp Canvas interface.
3. Is the current node a semantic source, a generation node, or a compose node?
4. What can and can't this node role do? A semantic source carries text, a generation node produces media, a compose node only consumes media artifacts, and an ordinary group expresses membership.
5. Does the user want a new media artifact, a final composition, or merely to structure ideas onto the canvas?
6. Is the currently selected node a real input of this target node?
7. Is this a set of full-package work on the same theme? If so, create or reuse one work group; if it is only a standalone node or scattered operations, do not create a group.
8. If it is not a legal input relation, you should:
   - find the real upstream input source
   - or create a standalone node
   - or only group, without linking

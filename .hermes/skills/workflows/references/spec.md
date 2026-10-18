# Workflow Planning Spec

The workflow skill is responsible only for planning and does not modify the canvas directly.

## Standard chain

1. The user states a need in Shrimp Canvas chat.
2. `workflows` picks the corresponding reference according to the intent.
3. Output `freezone_workflow_plan.v1`.
4. The user confirms.
5. `freezone-canvas-node-operator` converts the plan into `canvas_chat_commands.v1`.
6. The frontend canvas executor creates nodes, links and layout.
7. The nodes' own action / skill generate images, videos and audio after user confirmation.

## Rules

- Use real Shrimp Canvas node types.
- Choose the entry node according to the user's actual input; do not default to uploading a screenplay.
- When material is insufficient, do not fabricate; write the missing items into `missing_inputs`.
- The number of nodes is decided dynamically; do not use a fixed template.
- When planning, you must distinguish "stage order" from "canvas dependency edges":
  - Stage order only expresses the order of the human production process;
  - Canvas dependency edges only express real input, reference or context dependencies.
- Do not translate stage order directly into `A -> B -> C` canvas links.
- If two nodes are merely related in business terms, or belong to the same stage, but have no real input/output relation, you may:
  - Show them in the same group;
  - Lay them out adjacent to each other;
  - Not link them.
- Text/script/setting nodes are semantic sources by default, not sequential relay nodes.
- Multi-input generation tasks should use "multi-source merge" rather than a chain:
  - For example "character setting + scene description -> image node";
  - "image node + voiceover copy -> video node";
  - Do not write it as "character setting -> scene description -> image node -> voiceover copy -> video node".
- Do not output `canvas_chat_commands.v1`.
- Do not claim that the canvas has changed.
- Do not automatically run media generation.

## Planning output principles

- `nodes`: list the nodes that need to appear in the plan and their responsibilities.
- `edges`: write only real dependency relations, not production order.
- `layout.groups`: used to express stage, branch and region categorization.
- To express "what first, what next", write it in the explanation of `summary`, `analysis.production_units`, `assumptions` or `layout.groups`, not in `edges`.
- `nodes[].id` is only a logical ID inside the workflow plan, not a real canvas node ID. When putting things on the canvas after user confirmation, these IDs may only be used as `create_node.client_id`; they cannot be used directly as existing node IDs to run node actions or create cross-turn links.

## Plan Schema

```json
{
  "schema_version": "freezone_workflow_plan.v1",
  "skill": {
    "id": "<selected production skill id>",
    "version": "<selected production skill version>"
  },
  "workflow_type": "dynamic.short-drama",
  "mode": "analysis_only",
  "summary": "",
  "source_context": {
    "user_goal": "",
    "canvas_context": [],
    "input_assets": []
  },
  "analysis": {
    "entities": [],
    "production_units": [],
    "risks": []
  },
  "phases": [],
  "assumptions": [],
  "missing_inputs": [],
  "expansion_rules": {},
  "nodes": [],
  "edges": [],
  "layout": {
    "direction": "left_to_right",
    "groups": []
  },
  "execution_policy": {
    "requires_user_confirmation": true,
    "auto_create_nodes": false,
    "auto_generate_content": false,
    "handoff_skill": "freezone-canvas-node-operator"
  }
}
```

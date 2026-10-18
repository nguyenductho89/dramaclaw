from novelvideo.freezone.agent_workflows.drafts import public_workflow_draft
from novelvideo.freezone.workflow_drafts import (
    _plan_preview,
    bind_workflow_draft_task,
    claim_workflow_draft_confirmation,
    create_workflow_draft,
    finish_workflow_draft_confirmation,
)


def test_plan_preview_explains_ordered_recipe_pipeline():
    preview = _plan_preview(
        {
            "skill_id": "video-ad",
            "edge_count": 1,
            "plan": {
                "summary": "Action camera ad",
                "phases": ["visual"],
                "inputs": {},
                "nodes": [
                    {
                        "id": "hero",
                        "name": "Hero product shot",
                        "stage": "visual",
                        "node_type": "imageGenNode",
                        "data": {
                            "workflowCatalog": {
                                "recipeId": "product-hero",
                                "recipeName": "Product main image",
                                "recipeVersion": "1",
                                "recipePipeline": [
                                    {
                                        "id": "cinematic-lighting",
                                        "name": "Cinematic lighting",
                                        "version": "2",
                                    }
                                ],
                            }
                        },
                    }
                ],
            },
        }
    )

    assert preview["recipe_pipelines"] == [
        {
            "node_id": "hero",
            "node_name": "Hero product shot",
            "steps": [
                {
                    "role": "primary",
                    "id": "product-hero",
                    "name": "Product main image",
                    "version": "1",
                },
                {
                    "role": "supplemental",
                    "id": "cinematic-lighting",
                    "name": "Cinematic lighting",
                    "version": "2",
                },
            ],
        }
    ]

    compact = public_workflow_draft(
        {"preview": preview}, compact_preview=True
    )["preview"]
    assert compact["nodes"] == preview["nodes"]
    assert compact["recipe_pipelines"] == preview["recipe_pipelines"]


def test_late_timeout_result_does_not_downgrade_confirmed_draft(tmp_path):
    draft = create_workflow_draft(
        project_dir=tmp_path,
        project_id="project-a",
        canvas_id="default",
        intent={"skill_id": "video-ad"},
        compiled={
            "ok": True,
            "skill_id": "video-ad",
            "edge_count": 0,
            "plan": {"summary": "ad", "nodes": [], "edges": []},
        },
    )
    claimed, error = claim_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        revision=draft["revision"],
    )
    assert error is None
    assert claimed is not None
    bind_workflow_draft_task(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        task_id="task-1",
        root_task_id="task-1",
    )
    confirmed = finish_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        outcome="confirmed",
        expected_task_id="task-1",
    )
    late = finish_workflow_draft_confirmation(
        project_dir=tmp_path,
        canvas_id="default",
        draft_id=draft["draft_id"],
        outcome="submitted",
        expected_task_id="task-1",
    )

    assert confirmed is not None
    assert late is not None
    assert late["status"] == "confirmed"
    assert late["confirmed_at"] == confirmed["confirmed_at"]
    assert late["updated_at"] == confirmed["updated_at"]

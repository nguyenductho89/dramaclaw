from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest
from jsonschema import Draft202012Validator, ValidationError
from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client
from mcp.shared.exceptions import McpError

from novelvideo.chat import workflow_mcp
from novelvideo.freezone.agent_workflows import registry
from novelvideo.freezone.agent_workflows import catalog
from novelvideo.freezone.agent_workflows.graph import (
    build_workflow_graph_commands,
    validate_workflow_graph_commands,
)


def _result_payload(result):
    content = result.content if hasattr(result, "content") else result
    return json.loads(content[0].text)


@pytest.mark.asyncio
@pytest.mark.parametrize("username", ["alice", "bob"])
async def test_workflow_resources_real_stdio_protocol_and_private_isolation(
    tmp_path, username
):
    root = Path(__file__).resolve().parents[1]
    output = tmp_path / "output"
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    builtin = root / "src/novelvideo/freezone/agent_catalog/builtins"
    for user in ("alice", "bob"):
        for kind, source in (
            ("skills", "text-to-image-video"),
            ("recipes", "general-image"),
        ):
            folder = output / user / "_account/freezone/agent_config" / kind
            folder.mkdir(parents=True)
            item = json.loads((builtin / kind / f"{source}.json").read_text())
            item.update(id=f"private-{user}", name=f"{user} private")
            (folder / f"private-{user}.json").write_text(json.dumps(item))
    parameters = StdioServerParameters(
        command=sys.executable,
        args=["-m", "novelvideo.chat.workflow_mcp"],
        cwd=str(workspace),
        env={
            **os.environ,
            "PYTHONPATH": str(root / "src"),
            "ST_EDITION": "ce",
            "DRAMACLAW_USERNAME": username,
            "NOVELVIDEO_OUTPUT_DIR": str(output),
            "PYTHONDONTWRITEBYTECODE": "1",
        },
    )
    async with stdio_client(parameters) as (reader, writer):
        async with ClientSession(reader, writer) as session:
            initialized = await session.initialize()
            assert initialized.capabilities.resources is not None
            assert initialized.capabilities.resources.subscribe is False
            assert initialized.capabilities.resources.listChanged is False
            listed = await session.list_resources()
            assert listed.resources == []
            assert listed.nextCursor is None
            templates = await session.list_resource_templates()
            assert len(templates.resourceTemplates) == 3
            assert len((await session.list_tools()).tools) == 6
            for kind in ("skills", "recipes"):
                search = await session.call_tool(
                    "workflow_catalog_search", {"kind": kind, "query": "private"}
                )
                items = _result_payload(search)["items"]
                assert {item["id"] for item in items} == {f"private-{username}"}
                result = await session.read_resource(
                    f"dramaclaw-workflow://{kind}/private-{username}"
                )
                payload = json.loads(result.contents[0].text)
                item = payload["skill" if kind == "skills" else "recipe"]
                assert item["name"] == f"{username} private"
                peer = "bob" if username == "alice" else "alice"
                with pytest.raises(McpError):
                    await session.read_resource(
                        f"dramaclaw-workflow://{kind}/private-{peer}"
                    )
            reference = await session.read_resource(
                "dramaclaw-workflow://skills/short-drama-quick/references/custom-topology.md"
            )
            assert (
                json.loads(reference.contents[0].text)["status"]
                == "workflow_reference_ready"
            )


@pytest.mark.asyncio
async def test_standalone_workflow_mcp_exposes_portable_tools_and_resources():
    tools = await workflow_mcp.list_tools()
    templates = await workflow_mcp.list_resource_templates()

    assert {tool.name for tool in tools} == {
        "workflow_catalog_search",
        "workflow_skill_get",
        "workflow_recipe_get",
        "workflow_skill_reference_get",
        "workflow_intent_compile",
        "workflow_graph_compile",
    }
    assert {template.uriTemplate for template in templates} == {
        "dramaclaw-workflow://skills/{skill_id}",
        "dramaclaw-workflow://recipes/{recipe_id}",
        "dramaclaw-workflow://skills/{skill_id}/references/{reference}",
    }

    schemas = {tool.name: tool.inputSchema for tool in tools}
    output_schemas = {tool.name: tool.outputSchema for tool in tools}
    assert (
        len({json.dumps(schema, sort_keys=True) for schema in output_schemas.values()})
        == 6
    )
    assert all(
        branch["additionalProperties"] is False
        for schema in output_schemas.values()
        for branch in schema["oneOf"]
    )
    assert "compact" not in schemas["workflow_skill_get"]["properties"]
    plan_schema = schemas["workflow_graph_compile"]["properties"]["plan"]
    intent_schema = schemas["workflow_intent_compile"]["properties"]["intent"]
    assert plan_schema["properties"]["schema_version"]["enum"] == [
        "freezone_workflow_plan.v1"
    ]
    assert plan_schema["properties"]["nodes"]["items"]["anyOf"]
    edge_description = plan_schema["properties"]["edges"]["description"]
    assert "dependency_for only controls execution order" in edge_description
    assert "does not consume the source output" in edge_description
    assert "prompt_for" in edge_description
    assert "context_for" in edge_description
    recipe_node_schema = plan_schema["properties"]["nodes"]["items"]["anyOf"][0]
    assert recipe_node_schema["properties"]["node_type"]["enum"] == [
        "textAnnotationNode",
        "scriptNode",
        "beatContextNode",
        "imageGenNode",
        "videoNode",
        "audioNode",
    ]
    assert recipe_node_schema["required"] == ["id", "node_type", "data"]
    assert recipe_node_schema["additionalProperties"] is False
    assert plan_schema["properties"]["edges"]["items"]["required"] == [
        "source",
        "target",
        "link_type",
    ]
    assert plan_schema["additionalProperties"] is False
    assert "groups" in plan_schema["properties"]
    assert plan_schema["properties"]["expected_node_count"]["maximum"] == 200
    assert (
        "videoNode" in plan_schema["properties"]["expected_node_counts"]["properties"]
    )
    catalog_schema = plan_schema["properties"]["nodes"]["items"]["anyOf"][0][
        "properties"
    ]["data"]["properties"]["workflowCatalog"]
    assert catalog_schema["properties"]["confirmedInputs"]["type"] == "object"
    assert catalog_schema["properties"]["inputStrategy"]["type"] == "object"
    assert catalog_schema["properties"]["promptBuilder"]["type"] == "object"
    assert catalog_schema["properties"]["promptStrategy"]["enum"] == [
        "template",
        "user_message",
        "previous_output",
        "llm_refine",
    ]
    assert intent_schema["properties"]["schema_version"]["enum"] == [
        "freezone_workflow_intent.v1"
    ]


@pytest.mark.asyncio
async def test_graph_compile_accepts_canonical_plan_fields():
    arguments = {
        "plan": {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "video-tutorial", "version": 1},
            "nodes": [
                    {
                        "id": "input",
                        "node_type": "textAnnotationNode",
                        "stage": "input",
                        "data": {
                            "text": "Fixed copy provided by the user",
                        },
                },
                {
                    "id": "image",
                    "node_type": "imageGenNode",
                    "data": {
                        "prompt": "Future city rainy night",
                        "workflowCatalog": {"recipeId": "general-image"},
                    },
                },
            ],
            "edges": [
                {"source": "input", "target": "image", "link_type": "prompt_for"}
            ],
        }
    }
    graph_tool = next(
        tool
        for tool in await workflow_mcp.list_tools()
        if tool.name == "workflow_graph_compile"
    )
    Draft202012Validator(graph_tool.inputSchema).validate(arguments)

    result = await workflow_mcp.call_tool("workflow_graph_compile", arguments)

    payload = _result_payload(result)
    assert payload["ok"] is True, payload
    assert payload["commands"][0]["node_type"] == "textAnnotationNode"
    assert payload["commands"][1]["node_type"] == "imageGenNode"
    assert payload["commands"][2]["link_type"] == "prompt_for"


@pytest.mark.asyncio
async def test_graph_compile_normalizes_agent_resource_aliases():
    arguments = {
        "plan": {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "video-tutorial", "version": 1},
            "nodes": [
                {
                    "id": "input",
                    "node_type": "textAnnotationNode",
                    "data": {
                        "stage": "input",
                        "title": "User request",
                        "prompt": "Fixed copy provided by the user",
                        "workflowCatalog": {},
                    },
                },
                {
                    "id": "image",
                    "node_type": "imageGenNode",
                    "data": {
                        "prompt": "Future city rainy night",
                        "workflowCatalog": {"recipeId": "general-image"},
                    },
                },
            ],
            "edges": [
                {"source": "input", "target": "image", "link_type": "prompt_for"}
            ],
            "groups": [
                {"id": "episode-1", "label": "Episode one", "node_ids": ["input", "image"]}
            ],
        }
    }
    graph_tool = next(
        tool
        for tool in await workflow_mcp.list_tools()
        if tool.name == "workflow_graph_compile"
    )
    Draft202012Validator(graph_tool.inputSchema).validate(arguments)

    result = await workflow_mcp.call_tool("workflow_graph_compile", arguments)

    payload = _result_payload(result)
    assert payload["ok"] is True, payload
    assert payload["commands"][0]["data"]["content"] == "Fixed copy provided by the user"
    assert payload["commands"][0]["data"]["workflowCatalogRole"] == "user_input"
    assert "stage" not in payload["commands"][0]["data"]
    assert any(command["type"] == "group_nodes" for command in payload["commands"])


@pytest.mark.asyncio
async def test_every_workflow_tool_validates_its_real_call_result(monkeypatch):
    monkeypatch.setattr(workflow_mcp, "search_catalog", lambda **_kwargs: [])
    monkeypatch.setattr(
        workflow_mcp,
        "get_workflow_skill",
        lambda _args: {
            "ok": True,
            "status": "workflow_skill_ready",
            "schema_version": "freezone_workflow_skill_package.v1",
            "skill_id": "skill-a",
            "skill": {},
            "available_recipes": [],
        },
    )
    monkeypatch.setattr(
        workflow_mcp, "get_catalog_item", lambda **_kwargs: {"id": "recipe-a"}
    )
    monkeypatch.setattr(
        workflow_mcp,
        "_read_skill_reference",
        lambda *_args: {
            "ok": True,
            "status": "workflow_reference_ready",
            "skill_id": "skill-a",
            "reference": "integration.md",
            "content": "contract",
        },
    )
    monkeypatch.setattr(
        workflow_mcp,
        "compile_workflow_intent",
        lambda _intent: {
            "ok": True,
            "status": "workflow_plan_ready",
            "skill_id": "skill-a",
            "plan": {},
        },
    )
    monkeypatch.setattr(
        workflow_mcp,
        "validate_agent_workflow_plan",
        lambda _plan: {"ok": True, "status": "workflow_plan_valid"},
    )
    monkeypatch.setattr(
        workflow_mcp,
        "build_workflow_graph_commands",
        lambda _args: {
            "ok": True,
            "status": "workflow_graph_commands_created",
            "schema_version": "canvas_chat_commands.v1",
            "workflow_instance_id": "workflow-a",
            "commands": [],
        },
    )
    calls = {
        "workflow_catalog_search": {"kind": "skills"},
        "workflow_skill_get": {"skill_id": "skill-a"},
        "workflow_recipe_get": {"recipe_id": "recipe-a"},
        "workflow_skill_reference_get": {
            "skill_id": "skill-a",
            "reference": "integration.md",
        },
        "workflow_intent_compile": {"intent": {}},
        "workflow_graph_compile": {"plan": {}},
    }
    tools = {tool.name: tool for tool in await workflow_mcp.list_tools()}

    for name, arguments in calls.items():
        result = await workflow_mcp.call_tool(name, arguments)
        Draft202012Validator(tools[name].outputSchema).validate(
            result.structuredContent
        )


@pytest.mark.asyncio
async def test_graph_compile_rejects_nested_execution_policy():
    arguments = {
        "plan": {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "video-tutorial", "version": 1},
            "run_after_create": True,
            "nodes": [
                {
                    "id": "input",
                    "node_type": "textAnnotationNode",
                    "data": {"stage": "input", "text": "Copy"},
                },
                {
                    "id": "image",
                    "node_type": "imageGenNode",
                    "data": {
                        "prompt": "Rainy night city",
                        "workflowCatalog": {"recipeId": "general-image"},
                    },
                },
            ],
            "edges": [
                {"source": "input", "target": "image", "link_type": "prompt_for"}
            ],
        }
    }
    graph_tool = next(
        tool
        for tool in await workflow_mcp.list_tools()
        if tool.name == "workflow_graph_compile"
    )
    with pytest.raises(ValidationError):
        Draft202012Validator(graph_tool.inputSchema).validate(arguments)


@pytest.mark.asyncio
async def test_graph_compile_explains_how_to_connect_independent_branches():
    arguments = {
        "plan": {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "short-drama-quick", "version": 1},
            "nodes": [
                {
                    "id": "beat-01-input",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                    "data": {"text": "First segment"},
                },
                {
                    "id": "beat-01-image",
                    "node_type": "imageGenNode",
                    "data": {"workflowCatalog": {"recipeId": "general-image"}},
                },
                {
                    "id": "beat-02-input",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                    "data": {"text": "Second segment"},
                },
                {
                    "id": "beat-02-image",
                    "node_type": "imageGenNode",
                    "data": {"workflowCatalog": {"recipeId": "general-image"}},
                },
            ],
            "edges": [
                {
                    "source": "beat-01-input",
                    "target": "beat-01-image",
                    "link_type": "prompt_for",
                },
                {
                    "source": "beat-02-input",
                    "target": "beat-02-image",
                    "link_type": "prompt_for",
                },
            ],
        }
    }

    result = await workflow_mcp.call_tool("workflow_graph_compile", arguments)

    payload = _result_payload(result)
    assert payload["ok"] is False
    assert "shared input root node" in payload["agent_instruction"]
    assert "Do not ask the user for internal links" in payload["agent_instruction"]
    assert "do not chain Beats/shots that need independent failure isolation" in payload["agent_instruction"]


@pytest.mark.asyncio
async def test_graph_compile_rejects_edge_guessing_and_directs_catalog_lookup():
    arguments = {
        "plan": {
            "schema_version": "freezone_workflow_plan.v1",
            "skill": {"id": "short-drama-quick", "version": 1},
            "nodes": [
                {
                    "id": "input-root",
                    "node_type": "textAnnotationNode",
                    "stage": "input",
                    "data": {"text": "Shared input"},
                },
                {
                    "id": "beat-image",
                    "node_type": "imageGenNode",
                    "data": {"workflowCatalog": {"recipeId": "general-image"}},
                },
            ],
            "edges": [
                {
                    "source": "input-root",
                    "target": "beat-image",
                    "link_type": "context_for",
                }
            ],
        }
    }

    result = await workflow_mcp.call_tool("workflow_graph_compile", arguments)

    payload = _result_payload(result)
    assert payload["ok"] is False
    assert "freezone_get_link_type_catalog" in payload["agent_instruction"]
    assert "do not keep guessing other types" in payload["agent_instruction"]
    assert "immediately submit the workflow creation with the same plan" in payload["agent_instruction"]


@pytest.mark.asyncio
async def test_recipe_resource_reads_one_exact_definition(monkeypatch):
    monkeypatch.setattr(
        workflow_mcp,
        "get_catalog_item",
        lambda **_kwargs: {"id": "recipe-a", "name": "Recipe A"},
    )

    payload = json.loads(
        await workflow_mcp.read_resource("dramaclaw-workflow://recipes/recipe-a")
    )

    assert payload == {
        "ok": True,
        "recipe": {"id": "recipe-a", "name": "Recipe A"},
    }


@pytest.mark.asyncio
async def test_skill_reference_is_resolved_without_exposing_a_filesystem_path():
    result = await workflow_mcp.call_tool(
        "workflow_skill_reference_get",
        {"skill_id": "short-drama-quick", "reference": "custom-topology.md"},
    )
    payload = _result_payload(result)
    assert payload["ok"] is True
    assert "filesystem" not in payload["content"]
    assert payload["reference"] == "custom-topology.md"
    assert "dependency_for only controls execution order" in payload["content"]
    assert "must not use dependency_for" in payload["content"]
    assert "context_for" in payload["content"]
    assert "prompt_for" in payload["content"]
    assert "media_input_for" in payload["content"]
    assert 'skill: {"id":"<selected skill_id>"' in payload["content"]
    assert "generation_answers" in payload["content"]
    assert "reserved for recipe-less" in payload["content"]

    resource = await workflow_mcp.read_resource(
        "dramaclaw-workflow://skills/short-drama-quick/references/custom-topology.md"
    )
    assert json.loads(resource)["status"] == "workflow_reference_ready"


@pytest.mark.asyncio
async def test_skill_reference_rejects_path_traversal():
    result = await workflow_mcp.call_tool(
        "workflow_skill_reference_get",
        {"skill_id": "short-drama-quick", "reference": "../../secret"},
    )
    payload = _result_payload(result)
    assert payload["ok"] is False
    assert payload["status"] == "tool_arguments_invalid"


def test_catalog_search_is_compact_and_progressive(monkeypatch):
    monkeypatch.setattr(
        registry,
        "list_user_agent_config_items",
        lambda _username, _kind: [
            {
                "id": "video-recipe",
                "name": "Video Recipe",
                "description": "Create a video",
                "enabled": True,
                "output_kind": "video",
                "action_keys": ["video.generate"],
                "system_prompt": "large prompt must remain progressively loaded",
            }
        ],
    )

    results = registry.search_catalog(
        username="agent-a", kind="recipes", query="video", limit=10
    )

    assert results == [
        {
            "id": "video-recipe",
            "name": "Video Recipe",
            "version": None,
            "description": "Create a video",
            "output_kind": "video",
            "node_type": "videoNode",
            "requires_source_media": False,
            "action_keys": ["video.generate"],
        }
    ]
    assert "system_prompt" not in results[0]


def test_shared_catalog_uses_standard_username_environment(monkeypatch):
    monkeypatch.delenv("ST_EDITION", raising=False)
    monkeypatch.setenv("DRAMACLAW_USERNAME", "agent-a")
    monkeypatch.delenv("DRAMACLAW_USER", raising=False)

    assert catalog._catalog_username() == "agent-a"


def test_graph_compiler_emits_one_grouped_canvas_batch():
    result = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "workflow_type": "dynamic.text-image-video",
                "title": "Text-to-video test workflow",
                "nodes": [
                    {
                        "id": "prompt",
                        "node_type": "textAnnotationNode",
                        "data": {
                            "title": "Test prompt",
                            "text": "Future city at night",
                        },
                    },
                    {
                        "id": "frame",
                        "node_type": "imageGenNode",
                        "title": "Test first frame",
                        "prompt": "First frame of the future city under neon lights",
                    },
                    {"id": "video", "node_type": "videoNode", "title": "Test video"},
                ],
                "edges": [
                    {"source": "prompt", "target": "frame", "link_type": "prompt_for"},
                    {
                        "source": "frame",
                        "target": "video",
                        "link_type": "media_input_for",
                    },
                ],
                "group": {
                    "label": "Text-to-video test workflow",
                    "node_ids": ["prompt", "frame", "video"],
                },
            }
        }
    )

    assert result["ok"] is True
    command_types = [command["type"] for command in result["commands"]]
    assert command_types == [
        "create_node",
        "create_node",
        "create_node",
        "create_edge",
        "create_edge",
        "group_nodes",
        "layout_nodes",
        "select_nodes",
    ]
    assert result["commands"][0]["data"]["title"] == "Test prompt"
    assert result["commands"][1]["data"]["prompt"] == "First frame of the future city under neon lights"
    assert result["commands"][0]["data"]["content"] == "Future city at night"
    assert result["commands"][5]["label"] == "Text-to-video test workflow"


def test_graph_compiler_derives_text_title_from_nested_display_name():
    result = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "nodes": [
                    {
                        "id": "input-root",
                        "node_type": "textAnnotationNode",
                        "stage": "input",
                        "data": {
                            "displayName": "Shared input",
                            "text": "Shared creative requirements for nine Beats",
                        },
                    }
                ],
                "edges": [],
            }
        }
    )

    assert result["ok"] is True
    command = result["commands"][0]
    assert command["data"]["title"] == "Shared input"
    assert command["data"]["content"] == "Shared creative requirements for nine Beats"


def test_graph_compiler_completes_structural_text_node_canvas_fields():
    result = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "nodes": [
                    {
                        "id": "input-root",
                        "node_type": "textAnnotationNode",
                        "stage": "input",
                        "data": {"displayName": "Shared input"},
                    }
                ],
                "edges": [],
            }
        }
    )

    assert result["ok"] is True
    command = result["commands"][0]
    assert command["data"]["title"] == "Shared input"
    assert command["data"]["content"] == "Shared input"
    assert validate_workflow_graph_commands(result["commands"]) == []


def test_compiled_command_validator_reports_canvas_contract_paths():
    errors = validate_workflow_graph_commands(
        [
            {
                "type": "create_node",
                "client_id": "input-root",
                "node_type": "textAnnotationNode",
                "position": {"x": 80, "y": 80},
                "data": {"displayName": "Shared input", "content": ""},
            },
            {
                "type": "create_edge",
                "source": "input-root",
                "target": "missing-node",
                "link_type": "prompt_for",
            },
        ]
    )

    assert {error["path"] for error in errors} == {
        "commands[0].data.title",
        "commands[0].data.content",
        "commands[1].target",
    }


def test_graph_compiler_ignores_removed_run_after_create_alias():
    result = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "nodes": [
                    {
                        "id": "prompt",
                        "node_type": "textAnnotationNode",
                        "stage": "input",
                        "content": "Create only, do not execute",
                    }
                ],
                "edges": [],
            },
            "run_after_create": False,
            "runAfterCreate": True,
        }
    )

    assert result["ok"] is True
    assert result["run_after_create"] is False
    assert "run_workflow" not in [command["type"] for command in result["commands"]]


def test_graph_compiler_replaces_empty_nested_prompt_with_portable_prompt():
    result = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "nodes": [
                    {
                        "id": "frame",
                        "node_type": "imageGenNode",
                        "prompt": "Future city first frame",
                        "data": {"prompt": ""},
                    }
                ],
                "edges": [],
            }
        }
    )

    assert result["ok"] is True
    assert result["commands"][0]["data"]["prompt"] == "Future city first frame"


def test_graph_compiler_marks_portable_input_nodes_as_non_executable():
    result = build_workflow_graph_commands(
        {
            "plan": {
                "schema_version": "freezone_workflow_plan.v1",
                "nodes": [
                    {
                        "id": "request",
                        "node_type": "textAnnotationNode",
                        "stage": "input",
                        "data": {"content": "Script facts provided by the user"},
                    }
                ],
                "edges": [],
            }
        }
    )

    assert result["ok"] is True
    assert result["commands"][0]["data"]["workflowCatalogRole"] == "user_input"


def test_hosted_catalog_uses_bound_root_and_user_from_project_workspace(tmp_path):
    """Both MCPs must see API-owned private catalogs, not cwd/output or peers."""
    import os
    import subprocess
    import sys
    from pathlib import Path
    from novelvideo.chat import service, backend_sdk

    root = Path(__file__).resolve().parents[1]
    output = tmp_path / "api-output"
    workspace = tmp_path / "project-agent-workspace"
    workspace.mkdir()
    base = json.loads((root / "src/novelvideo/freezone/agent_catalog/builtins/skills/text-to-image-video.json").read_text())
    for user in ("alice", "bob"):
        folder = output / user / "_account/freezone/agent_config/skills"
        folder.mkdir(parents=True)
        (folder / "private-test.json").write_text(json.dumps({**base, "id": "private-test", "name": user + " private"}))
    overrides = service._codex_mcp_config_overrides(service._dramaclaw_mcp_servers("freezone_canvas"))
    script = """
import json
from novelvideo.freezone.agent_workflows.catalog import get_workflow_skill
result = get_workflow_skill({'skill_id':'private-test', 'username':'bob'})
assert result['ok'], result
print(json.dumps(result, ensure_ascii=False))
"""
    for user in ("alice", "bob"):
        config = backend_sdk._codex_thread_config(overrides, {"DRAMACLAW_USERNAME": user, "NOVELVIDEO_OUTPUT_DIR": str(output)})
        for server in ("dramaclaw", "dramaclaw_workflows"):
            bound = config[f"mcp_servers.{server}.env"]
            env = {**os.environ, **bound, "PYTHONPATH": str(root / "src"), "ST_EDITION": "ce"}
            result = subprocess.run([sys.executable, "-c", script], cwd=workspace, env=env, capture_output=True, text=True, timeout=30)
            assert result.returncode == 0, result.stderr
            package = json.loads(result.stdout)
            assert package['skill']['name'] == user + ' private'


@pytest.mark.asyncio
async def test_builtin_workflow_skill_get_preserves_planning_instructions():
    result = await workflow_mcp.call_tool(
        "workflow_skill_get",
        {"skill_id": "lego-minifigure-animation-video", "user_goal": "make a short film"},
    )
    payload = _result_payload(result)
    assert payload["ok"] is True
    assert result.isError is False
    assert payload["planning_contract"]["node_prompt_role"] == "task_brief"
    assert "Runtime Recipe compilation" in payload["agent_instruction"]
    assert result.structuredContent == payload


@pytest.mark.asyncio
async def test_workflow_intent_schema_explains_compose_field_location():
    tools = {tool.name: tool for tool in await workflow_mcp.list_tools()}
    schema = tools["workflow_intent_compile"].inputSchema["properties"]["intent"]
    assert "intent.include_compose" in schema["properties"]["planner"]["description"]
    intent = {
        "skill_id": "lego-minifigure-animation-video",
        "user_goal": "make a short film",
        "planner": {"mode": "standard"},
        "include_compose": True,
    }
    Draft202012Validator(schema).validate(intent)
    intent["planner"]["include_compose"] = intent.pop("include_compose")
    with pytest.raises(ValidationError):
        Draft202012Validator(schema).validate(intent)

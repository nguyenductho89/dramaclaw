import { describe, expect, it } from "vitest";

import {
  assistantCompletionPrefix,
  backgroundCanvasCommandPendingResultForTest,
  buildCanvasCommandFlowItemsForTest,
  canvasCommandResultFromWorkflowRunForTest,
  canvasCommandFeedbackVisualToneForTest,
  canvasCommandFeedbackIsValidationOnlyForTest,
  canvasContextActivityVisualToneForTest,
  isGenerationSuccessSummaryText,
  mergeCanvasContextActivitiesForTest,
  mergeCanvasCommandFeedbacksForTest,
  mergePendingCanvasCommandApprovalForTest,
  orderExternalMcpCanvasPartsForTest,
  resolveCanvasCommandFeedbackMessageIdForTest,
} from "@/features/superchat/superchat-panel";
import { looksLikeCanvasExecutionNarration } from "@/features/superchat/canvas-execution-narration";
import { upsertAssistantMessageForTest } from "@/features/superchat/use-superchat";
import { zhT } from "@/__tests__/helpers/i18n-fixtures";

describe("assistant success summary", () => {
  it("recognizes only the standalone generation success summary", () => {
    expect(isGenerationSuccessSummaryText("Generated successfully, no failures.")).toBe(true);
    expect(isGenerationSuccessSummaryText("Generated successfully, no failures")).toBe(true);
    expect(isGenerationSuccessSummaryText("Image generated successfully, next generate the video.")).toBe(false);
  });

  it("classifies natural DramaClaw completion replies without requiring a checkmark", () => {
    expect(assistantCompletionPrefix("Episode 3 identity planning completed. All identities in this episode are reused."))
      .toBe("Episode 3 identity planning completed.");
    expect(assistantCompletionPrefix("Episode 3 script generation completed. Next, generate the sketches."))
      .toBe("Episode 3 script generation completed.");
    expect(assistantCompletionPrefix("Episode 1 final cut composition completed. Showing the final cut:"))
      .toBe("Episode 1 final cut composition completed.");
    expect(assistantCompletionPrefix("✅ Plan identities · ep3 completed. You can continue to the next step."))
      .toBe("✅ Plan identities · ep3 completed.");
  });

  it("does not classify negative completion status as completed", () => {
    expect(assistantCompletionPrefix("Episode 3 identity planning has not completed yet. Please check back later."))
      .toBeNull();
    expect(assistantCompletionPrefix("The current task did not finish generating."))
      .toBeNull();
  });
});

describe("background canvas generation status", () => {
  it("marks media and workflow commands as running instead of completed", () => {
    const result = backgroundCanvasCommandPendingResultForTest([
      { index: 0, type: "run_node_action", label: "生成音频", details: [] },
      { index: 1, type: "run_workflow", label: "运行工作流", details: [] },
    ]);

    expect(result.applied).toBe(0);
    expect(result.commandResults).toEqual([
      expect.objectContaining({
        commandIndex: 0,
        status: "pending",
        output: { pending: true, reason: "background_generation_running" },
      }),
      expect.objectContaining({
        commandIndex: 1,
        status: "pending",
        output: { pending: true, reason: "background_generation_running" },
      }),
    ]);
  });

  it("persists the workflow run id in pending command results", () => {
    const result = backgroundCanvasCommandPendingResultForTest(
      [{ index: 0, type: "run_workflow", label: "运行工作流", details: [] }],
      "run-1",
    );

    expect(result.commandResults[0]?.output).toEqual({
      pending: true,
      reason: "background_generation_running",
      workflow_run_id: "run-1",
    });
  });

  it.each([
    ["completed", "success", []],
    ["failed", "error", ["生成失败"]],
    ["cancelled", "error", ["后台生成已取消。"]],
    ["interrupted", "error", ["后台生成已中断，请恢复任务或重试。"]],
  ] as const)("restores a %s workflow run as a terminal result", (status, stepStatus, errors) => {
    const result = canvasCommandResultFromWorkflowRunForTest(
      {
        applied: 0,
        openedUiActions: 0,
        errors: [],
        key: "feedback-1",
        commandResults: [{
          commandIndex: 0,
          type: "run_workflow",
          status: "pending",
          label: "运行工作流",
        }],
      },
      {
        schema_version: "freezone_workflow_run.v1",
        run_id: "run-1",
        project_id: "project-1",
        canvas_id: "canvas-1",
        status,
        resumable: status === "interrupted",
        created_at: "2026-10-12T00:00:00Z",
        started_at: "2026-10-12T00:00:00Z",
        updated_at: "2026-10-12T00:00:01Z",
        actions: [{
          node_id: "node-1",
          action: "generate",
          status: status === "completed" ? "completed" : "failed",
          ...(status === "failed" ? { user_error: "生成失败" } : {}),
        }],
      },
      zhT as never,
    );

    expect(result.commandResults[0]).toEqual(expect.objectContaining({
      status: stepStatus,
      output: { workflow_run_id: "run-1", workflow_run_status: status },
    }));
    expect(result.errors).toEqual(errors);
  });
});

describe("canvas command flow placement", () => {
  it("places Codex MCP validation and approval before the final reply by event order", () => {
    const parts = orderExternalMcpCanvasPartsForTest([
      {
        id: "thought-1",
        type: "agent_thought",
        seq: 1,
        event: { status: "completed", text: "Calling canvas tools" },
      },
      { id: "text-1", type: "text", text: "The image node has been created." },
      {
        id: "approval-1",
        type: "canvas_approval",
        event: { externalMcpCommand: true, surfaceOrder: 102 },
      },
      {
        id: "validation-1",
        type: "canvas_context",
        event: { externalMcpCommand: true, surfaceOrder: 101 },
      },
    ]);

    expect(parts.map((part) => part.id)).toEqual([
      "thought-1",
      "validation-1",
      "approval-1",
      "text-1",
    ]);
  });

  it("does not reorder the original Hermes canvas parts", () => {
    const parts = [
      { id: "text-1", type: "text" as const, text: "Hermes reply" },
      { id: "approval-1", type: "canvas_approval" as const, event: { surfaceOrder: 102 } },
      { id: "validation-1", type: "canvas_context" as const, event: { surfaceOrder: 101 } },
    ];

    expect(orderExternalMcpCanvasPartsForTest(parts).map((part) => part.id)).toEqual([
      "text-1",
      "approval-1",
      "validation-1",
    ]);
  });

  it("orders Skill Studio cards with later canvas approvals in the same message", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "I will create the Skill draft first, then create a sample node.",
      [
        {
          id: "approval-1",
          key: "approval-1",
          messageId: "assistant-turn-a",
          turnId: "turn-a",
          bridgeKey: "bridge-1",
          receivedAt: 1,
          envelopes: [],
          commandCount: 1,
          plans: [
            {
              index: 0,
              type: "create_node",
              label: "Create image node",
              details: [],
            },
          ],
          anchorTextPrefix: "I will create the Skill draft first, then create a sample node.",
          surfaceOrder: 10,
        },
      ],
      [],
      [],
      [
        {
          type: "skill_studio.questions",
          submitted: true,
          skill_studio_session_id: "skill-studio-a",
          questions: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "skill_studio", "approval"]);
  });

  it("keeps stale-anchor Skill Studio draft cards after historical continuation text", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "Completed the full Skill Studio flow for \"Hometown Culture Poster\".",
      [],
      [],
      [],
      [
        {
          type: "skill_studio.questions",
          anchor_text_prefix: "Let me first put together a few key questions for you.",
          skill_studio_session_id: "skill-studio-a",
          questions: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "skill_studio"]);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: "Completed the full Skill Studio flow for \"Hometown Culture Poster\".",
    });
  });

  it("keeps currently anchored Skill Studio cards after their preceding text", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "Let me first put together a few key questions for you.",
      [],
      [],
      [],
      [
        {
          type: "skill_studio.questions",
          anchor_text_prefix: "Let me first put together a few key questions for you.",
          skill_studio_session_id: "skill-studio-a",
          questions: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "skill_studio"]);
  });

  it("keeps user-facing assistant text visible when it only mentions a canvas tool name", () => {
    expect(looksLikeCanvasExecutionNarration(
      "For further actions, you can call the configured action through freezone_run_node_action.",
    )).toBe(false);
  });

  it("keeps an event after the final assistant text when its saved anchor is missing", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "Preface\nFinal reply",
      [],
      [
        {
          key: "bridge:layout",
          applied: 1,
          openedUiActions: 0,
          errors: [],
          commandResults: [
            {
              commandIndex: 0,
              type: "layout_nodes",
              status: "success",
              label: "Arrange layout",
            },
          ],
          anchorTextPrefix: "Preface\nNot yet in the final reply during the process",
          surfaceOrder: 10,
        },
      ],
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "feedback"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "Preface\nFinal reply" });
  });

  it("prefers persisted feedback anchors over duplicate in-memory feedback anchors", () => {
    const persisted = {
      key: "bridge:layout",
      applied: 1,
      openedUiActions: 0,
      errors: [],
      commandResults: [
        {
          commandIndex: 0,
          type: "layout_nodes",
          status: "success",
          label: "Arrange layout",
        },
      ],
      anchorTextPrefix: "First half of the body\n",
      surfaceOrder: 20,
    };
    const inMemory = {
      ...persisted,
      anchorTextPrefix: "Temporary text during the process",
      surfaceOrder: 10,
    };

    const items = buildCanvasCommandFlowItemsForTest(
      "First half of the body\nSecond half of the body",
      [],
      mergeCanvasCommandFeedbacksForTest([persisted], [inMemory]),
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "feedback", "text"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "First half of the body\n" });
  });

  it("places unanchored canvas read activity before the assistant reply", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "Hello! The current Freezone canvas is empty (0 nodes, 0 links).",
      [],
      [],
      [
        {
          key: "context:summary",
          turnId: "turn-a",
          bridgeKey: "summary",
          status: "done",
          labels: ["Canvas summary"],
          errors: [],
          surfaceOrder: 10,
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["context", "text"]);
    expect(items[1]).toMatchObject({
      kind: "text",
      text: "Hello! The current Freezone canvas is empty (0 nodes, 0 links).",
    });
  });

  it("places unanchored execution feedback before assistant success text", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "I added a video node for you.\n\nCreated successfully, the ID is node-a.",
      [],
      [
        {
          key: "bridge:create-video",
          applied: 1,
          openedUiActions: 0,
          errors: [],
          commandResults: [
            {
              commandIndex: 0,
              type: "create_node",
              status: "success",
              label: "Create node",
              createdNodeId: "node-a",
            },
          ],
          surfaceOrder: 10,
        },
      ],
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["feedback", "text"]);
    expect(items[1]).toMatchObject({
      kind: "text",
      text: "I added a video node for you.\n\nCreated successfully, the ID is node-a.",
    });
  });

  it("places unanchored cancelled feedback before assistant cancellation text", () => {
    const items = buildCanvasCommandFlowItemsForTest(
      "The generation request timed out, possibly because the canvas connection was briefly interrupted. Click the node's generate button on the canvas to retry, or ask me to submit it again later.",
      [],
      [
        {
          key: "bridge:timeout",
          applied: 0,
          openedUiActions: 0,
          errors: ["Canvas operation timed out and was cancelled automatically"],
          commandResults: [
            {
              commandIndex: -1,
              type: "validate",
              status: "error",
              label: "Cancelled",
              error: "Canvas operation timed out and was cancelled automatically",
            },
          ],
          cancelled: true,
          cancelReason: "timeout",
          surfaceOrder: 10,
        },
      ],
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["feedback", "text"]);
    expect(items[0]).toMatchObject({
      kind: "feedback",
      feedback: { key: "bridge:timeout" },
    });
  });

  it("targets the current assistant turn when command feedback arrives before text", () => {
    const messageId = resolveCanvasCommandFeedbackMessageIdForTest({
      messages: [
        {
          id: "assistant-old",
          role: "assistant",
          text: "Previous turn reply",
          turnId: "turn-old",
          timestamp: 1,
        },
      ],
      turnId: "turn-new",
      latestAssistantMessageId: "assistant-old",
      receivedAt: 2,
    });

    expect(messageId).toBe("assistant-turn-new");
  });

  it("keeps existing canvas feedback when later assistant text arrives", () => {
    const messages = upsertAssistantMessageForTest(
      [
        {
          id: "assistant-turn-a",
          role: "assistant",
          text: "",
          turnId: "turn-a",
          timestamp: 1,
          parts: [
            {
              id: "canvas_feedback:bridge-a",
              type: "canvas_feedback",
              event: {
                key: "bridge-a",
                errors: ["The node action completed but produced no imageUrl."],
                commandResults: [],
              },
            },
          ],
        },
      ],
      "turn-a",
      "Task execution failed: the current status is failed.",
    );

    const assistant = messages.find((message) => message.id === "assistant-turn-a");

    expect(assistant?.parts?.map((part) => part.type)).toEqual(["canvas_feedback", "text"]);
    expect(assistant?.parts?.[0]).toMatchObject({
      type: "canvas_feedback",
      event: { errors: ["The node action completed but produced no imageUrl."] },
    });
  });

  it("does not treat a cancelled canvas command as validation-only feedback", () => {
    expect(canvasCommandFeedbackIsValidationOnlyForTest({
      key: "bridge:cancelled",
      applied: 0,
      openedUiActions: 0,
      errors: ["Canvas operation cancelled"],
      commandResults: [
        {
          commandIndex: -1,
          type: "validate",
          status: "error",
          label: "Cancelled",
          error: "Canvas operation cancelled",
        },
      ],
    })).toBe(false);
  });

  it("renders validation-only failures as muted agent attempts while preserving execution failures as destructive", () => {
    expect(canvasContextActivityVisualToneForTest({
      key: "context:validation",
      turnId: "turn-a",
      bridgeKey: "validation",
      status: "failed",
      labels: ["Command validation"],
      errors: ["Command validation failed"],
    })).toBe("muted");

    expect(canvasCommandFeedbackVisualToneForTest({
      key: "bridge:validation",
      applied: 0,
      openedUiActions: 0,
      errors: ["Invalid canvas command"],
      commandResults: [
        {
          commandIndex: -1,
          type: "validate",
          status: "error",
          label: "Invalid canvas command",
          error: "Invalid canvas command",
        },
      ],
    })).toBe("muted");

    expect(canvasCommandFeedbackVisualToneForTest({
      key: "bridge:cancelled",
      applied: 0,
      openedUiActions: 0,
      errors: ["Canvas operation cancelled"],
      commandResults: [
        {
          commandIndex: -1,
          type: "validate",
          status: "error",
          label: "Cancelled",
          error: "Canvas operation cancelled",
        },
      ],
      cancelled: true,
      cancelReason: "user",
    })).toBe("muted");

    expect(canvasCommandFeedbackVisualToneForTest({
      key: "bridge:timeout",
      applied: 0,
      openedUiActions: 0,
      errors: ["Canvas operation timed out and was cancelled automatically"],
      commandResults: [
        {
          commandIndex: -1,
          type: "validate",
          status: "error",
          label: "Cancelled",
          error: "Canvas operation timed out and was cancelled automatically",
        },
      ],
      cancelled: true,
      cancelReason: "timeout",
    })).toBe("warning");

    expect(canvasCommandFeedbackVisualToneForTest({
      key: "bridge:result-sync",
      applied: 1,
      openedUiActions: 0,
      errors: [],
      commandResults: [{
        commandIndex: 0,
        type: "run_node_action",
        status: "pending",
        label: "Generate image (output syncing)",
      }],
    })).toBe("warning");

    expect(canvasCommandFeedbackVisualToneForTest({
      key: "bridge:execution",
      applied: 0,
      openedUiActions: 0,
      errors: ["Generation failed"],
      commandResults: [
        {
          commandIndex: 0,
          type: "run_node_action",
          status: "error",
          label: "Generate image",
          error: "Generation failed",
        },
      ],
    })).toBe("destructive");
  });

  it("dedupes the same pending approval when one event resolves the turn later", () => {
    const envelopes = [
      {
        schema_version: "canvas_chat_commands.v1",
        commands: [
          {
            type: "create_node",
            client_id: "kf4",
            node_type: "imageGenNode",
            data: { prompt: "frame" },
          },
        ],
      },
    ];
    const first = {
      id: "canvas-command-approval:tool-canvas-command:1:bridge:bridge-a",
      key: "bridge:bridge-a",
      messageId: "tool-canvas-command:1",
      turnId: null,
      bridgeKey: "bridge-a",
      anchorTextPrefix: null,
      surfaceOrder: 1,
      envelopes,
      commandCount: 1,
      plans: [],
    };
    const second = {
      ...first,
      id: "canvas-command-approval:assistant-turn-a:bridge:bridge-a:turn:turn-a",
      key: "bridge:bridge-a:turn:turn-a",
      messageId: "assistant-turn-a",
      turnId: "turn-a",
      surfaceOrder: 2,
    };

    const merged = mergePendingCanvasCommandApprovalForTest(
      mergePendingCanvasCommandApprovalForTest([], first as any),
      second as any,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      id: first.id,
      key: second.key,
      messageId: second.messageId,
      turnId: "turn-a",
    });
  });

  it("keeps the websocket turn when a reconnect poll repeats the same bridge command", () => {
    const live = {
      id: "canvas-command-approval:assistant-turn-a:bridge:bridge-a",
      key: "bridge:bridge-a",
      messageId: "assistant-turn-a",
      turnId: "turn-a",
      bridgeKey: "bridge-a",
      anchorTextPrefix: null,
      surfaceOrder: 1,
      envelopes: [],
      commandCount: 1,
      plans: [],
    };
    const polled = {
      ...live,
      messageId: "assistant-external-agent:bridge-a",
      turnId: "external-agent:bridge-a",
      surfaceOrder: 2,
    };

    const merged = mergePendingCanvasCommandApprovalForTest(
      mergePendingCanvasCommandApprovalForTest([], live as any),
      polled as any,
    );

    expect(merged).toHaveLength(1);
    expect(merged[0].turnId).toBe("turn-a");
  });

  it("merges persisted and live canvas context activities without losing the live anchor", () => {
    const merged = mergeCanvasContextActivitiesForTest(
      [
        {
          key: "context:node-detail",
          turnId: "turn-a",
          bridgeKey: "node-detail",
          status: "done",
          labels: ["Node parameters"],
          errors: [],
          anchorTextPrefix: null,
          surfaceOrder: 30,
        },
      ],
      [
        {
          key: "context:node-detail",
          turnId: "turn-a",
          bridgeKey: "node-detail",
          status: "done",
          labels: ["Node parameters"],
          errors: [],
          anchorTextPrefix: "Validation passed, now creating nodes and connections:\n",
          surfaceOrder: 10,
        },
      ],
    );

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({
      anchorTextPrefix: "Validation passed, now creating nodes and connections:\n",
      surfaceOrder: 10,
    });
  });

  it("places validation and execution cards before assistant text that describes their result", () => {
    const text = [
      "Sure! Let me create a hometown culture poster workflow for you.",
      "",
      "Validation passed, creating nodes and connecting them:",
      "",
      "I have created the poster workflow on the canvas.",
    ].join("\n");

    const items = buildCanvasCommandFlowItemsForTest(
      text,
      [],
      [
        {
          key: "bridge:command",
          applied: 4,
          openedUiActions: 0,
          errors: [],
          commandResults: [
            {
              commandIndex: 0,
              type: "create_node",
              status: "success",
              label: "Create node",
            },
          ],
          anchorTextPrefix: text,
          surfaceOrder: 40,
        },
      ],
      [
        {
          key: "context:validation",
          turnId: "turn-a",
          bridgeKey: "validation",
          status: "done",
          labels: ["Command validation"],
          errors: [],
          anchorTextPrefix: text,
          surfaceOrder: 30,
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual([
      "text",
      "context",
      "text",
      "feedback",
      "text",
    ]);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: "Sure! Let me create a hometown culture poster workflow for you.\n\n",
    });
    expect(items[2]).toMatchObject({
      kind: "text",
      text: "Validation passed, creating nodes and connecting them:\n\n",
    });
  });

  it("keeps canvas cards in stream order when the final assistant text normalizes blank lines", () => {
    const text = [
      "I need to create an image node for you. In the Freezone canvas, an image node corresponds to the `imageNode` type.",
      "",
      "Let me look at the create schema of the image node first to make sure I use the right fields:",
      "",
      "I see that in the image node create schema, the `imageNode` type needs some required fields. According to the schema, I need to create an `imageNode` and set basic information such as the display name.",
      "",
      "Let me create an image node for you:",
      "",
      "The image node was created successfully! I created an image node named \"Image node\" for you.",
    ].join("\n");
    const streamingAnchor = [
      "I need to create an image node for you. In the Freezone canvas, an image node corresponds to the `imageNode` type.",
      "",
      "Let me look at the create schema of the image node first to make sure I use the right fields:",
      "",
      "",
      "I see that in the image node create schema, the `imageNode` type needs some required fields. According to the schema, I need to create an `imageNode` and set basic information such as the display name.",
      "",
      "Let me create an image node for you:",
      "",
    ].join("\n");

    const items = buildCanvasCommandFlowItemsForTest(
      text,
      [],
      [
        {
          key: "bridge:create",
          applied: 1,
          openedUiActions: 0,
          errors: [],
          commandResults: [
            {
              commandIndex: 0,
              type: "create_node",
              status: "success",
              label: "Create node",
            },
          ],
          anchorTextPrefix: streamingAnchor,
          surfaceOrder: 30,
        },
      ],
      [
        {
          key: "context:node-create-schema",
          turnId: "turn-a",
          bridgeKey: "node-create-schema",
          status: "done",
          labels: ["Node parameters"],
          errors: [],
          anchorTextPrefix: null,
          surfaceOrder: 10,
        },
        {
          key: "context:validation",
          turnId: "turn-a",
          bridgeKey: "validation",
          status: "done",
          labels: ["Command validation"],
          errors: [],
          anchorTextPrefix: streamingAnchor,
          surfaceOrder: 20,
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual([
      "text",
      "context",
      "text",
      "context",
      "feedback",
      "text",
    ]);
    expect(items[1]).toMatchObject({
      kind: "context",
      activity: { bridgeKey: "node-create-schema" },
    });
    expect(items[3]).toMatchObject({
      kind: "context",
      activity: { bridgeKey: "validation" },
    });
    expect(items[4]).toMatchObject({
      kind: "feedback",
      feedback: { key: "bridge:create" },
    });
    expect(items[5]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("The image node was created successfully"),
    });
  });

  it("does not anchor execution cards inside the assistant request sentence", () => {
    const text = [
      "I need to create a new image node on the Freezone canvas. Let me use the right tool to get this done.",
      "",
      "I have successfully created a new image node on the Freezone canvas. The node ID is `dbc24486-07e7-4d55-9376-920a7f9a8254`.",
      "",
      "This image node can now be seen on the canvas; you can further edit its properties, add images, or connect it to other nodes.",
    ].join("\n");
    const anchorTextPrefix = [
      "I need to create a new image node on the Freezone canvas. Let me use the right tool to get this done.",
      "",
    ].join("\n");

    const items = buildCanvasCommandFlowItemsForTest(
      text,
      [],
      [
        {
          key: "bridge:create",
          applied: 1,
          openedUiActions: 0,
          errors: [],
          commandResults: [
            {
              commandIndex: 0,
              type: "create_node",
              status: "success",
              label: "Create node",
            },
          ],
          anchorTextPrefix,
          surfaceOrder: 10,
        },
      ],
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "feedback", "text"]);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: anchorTextPrefix,
    });
    expect(items[2]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("I have successfully created a new image node"),
    });
  });

  it("keeps read-context cards next to the assistant text that requested them", () => {
    const text = [
      "I will help you polish the prompt of the current video node. First, I need to fetch the details of the node to understand its full content and editable fields.",
      "",
      "I have now fetched the details of the video node. The current prompt is \"cat eating fish\".",
      "",
      "Let me offer a few polishing options for this prompt, from basic enhancement to professional grade:",
    ].join("\n");

    const items = buildCanvasCommandFlowItemsForTest(
      text,
      [],
      [],
      [
        {
          key: "context:node-detail",
          turnId: "turn-a",
          bridgeKey: "node-detail",
          status: "done",
          labels: ["Node details"],
          errors: [],
          anchorTextPrefix: null,
          surfaceOrder: 10,
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "context", "text"]);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: "I will help you polish the prompt of the current video node. First, I need to fetch the details of the node to understand its full content and editable fields.\n\n",
    });
    expect(items[2]).toMatchObject({
      kind: "text",
      text: "I have now fetched the details of the video node. The current prompt is \"cat eating fish\".\n\nLet me offer a few polishing options for this prompt, from basic enhancement to professional grade:",
    });
  });
});

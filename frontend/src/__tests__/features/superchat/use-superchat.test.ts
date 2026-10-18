// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { useCanvasStore } from "@/stores/canvasStore";
import {
  normalizeCanvasChatCommandEnvelopesForValidation,
  workflowGenerationTargetsForPreflight,
} from "@/features/freezone/canvasChatCommands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMessage } from "@/features/superchat/message";
import { buildCanvasCommandToolResultPayloadForTest } from "@/features/freezone/canvasCommandToolResult";
import {
  SUPERCHAT_CANVAS_COMMAND_EVENT,
  abortTerminalGraceMsForTest,
  approvalOptionIdForTest,
  canvasContextToolResultFrameForTest,
  dedupeMessagesByIdForTest,
  dispatchCanvasCommandFrameForTest,
  freezoneCanvasCommandExecutionModeForTest,
  mergeHistorySnapshot,
  normalizeMessageForScopeForTest,
  removeSkillStudioStatusForTurnForTest,
  revealIncompleteSkillStudioDraftForTurnForTest,
  pruneOldMessageCaches,
  resolveUiEventTurnIdForTest,
  sanitizeMessagesForCache,
  shouldKeepActiveTurnAfterScopeSync,
  shouldRenderAgentToolStatusPart,
  shouldRenderToolStatusPart,
  scopeForProjectForTest,
  scopeSessionKeyForTest,
  toolStatusPartForTest,
  updateAssistantUiEventsForTest,
  upsertRuntimePartInMessagesForTest,
  upsertAssistantMessageForTest,
  upsertAssistantUiEventForTest,
  upsertServerAssistantMessageForTest,
  useSuperChat,
} from "@/features/superchat/use-superchat";
import {
  CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
  CANVAS_NODE_REFERENCE_SCHEMA_VERSION,
  isCanvasNodeReferenceAttachment,
} from "@/features/freezone/chatNodeReferences";
import {
  CanvasCommandApprovalCardForTest,
  buildAssistantClarificationResponseForTest,
  activeAssistantClarificationIsSkillStudioRevisionForTest,
  buildPersistedAssistantClarificationEventForTest,
  buildAssistantClarificationToolResultForTest,
  buildAssistantInteractionFlowItemsForTest,
  collapseRepeatedCanvasStatusFlowItemsForTest,
  collapseRepeatedCanvasStatusPartsForTest,
  amendCanvasApprovalWithAudioParamsForTest,
  amendCanvasApprovalWithImageParamsForTest,
  amendCanvasApprovalWithHumanReviewForTest,
  amendCanvasApprovalWithVideoParamsForTest,
  audioApprovalInitialParamsForTest,
  canvasApprovalRequiresAudioVoiceChoiceForTest,
  canvasApprovalRequiresManualUiActionForTest,
  canvasApprovalRequiresHumanReviewConfirmationForTest,
  clarificationQuestionsWithLiveModelCatalogsForTest,
  assistantClarificationCanSubmit,
  assistantClarificationCanSubmitRecommended,
  assistantClarificationGenerationCatalogIssue,
  assistantClarificationShowsRecommended,
  imageApprovalInitialParamsForTest,
  imageApprovalParamGroupsForTest,
  imageQualityOptionsForApprovalForTest,
  normalizeImageQualityForApprovalForTest,
  textApprovalInitialParamsForTest,
  videoApprovalInitialParamsForTest,
  videoApprovalParamGroupsForTest,
  buildSkillStudioCatalogSaveItemsForTest,
  buildSkillStudioDraftCancelToolResultForTest,
  buildSkillStudioDraftRevisionToolResultForTest,
  buildSkillStudioDraftToolResultForTest,
  normalizeSkillStudioDraftForCatalogForTest,
  skillStudioDraftFieldLabelsForTest,
  buildSkillStudioFlowItemsForTest,
  buildSkillStudioQuestionTimelineItemsForTest,
  buildSkillStudioQuestionResponseForTest,
  buildSkillStudioQuestionToolResultForTest,
  assistantClarificationEventIdentityForTest,
  assistantPartsPreferWideLayoutForTest,
  skillStudioDraftFooterTextForTest,
  skillStudioEventMatchesForTest,
  hydrateOrderedPartsWithUiEventsForTest,
  latestPendingAssistantClarificationEventForTest,
  latestPendingAssistantClarificationEventForActiveTurnForTest,
  latestPendingSkillStudioQuestionEventForTest,
  latestPendingSkillStudioQuestionEventForActiveTurnForTest,
  skillStudioQuestionEventIdentityForTest,
  agentRuntimeDisplayPartsForTest,
  assistantRuntimeShouldHideSettledToolStatusForTest,
  agentThoughtRuntimePresentationForTest,
  genericToolTitleForTest,
  toolStatusRuntimeTextForTest,
  messageIsWaitingForUserReplyForTest,
  messageHasSkillStudioUiEventForTest,
  messageHasAgentRuntimeActivityForTest,
  messageHasVisibleAgentProgressActivityForTest,
  messageIdForThinkingCanvasContextActivityForTest,
  mergeAdjacentAgentThoughtPartsForTest,
  mergeAdjacentToolStatusPartsForTest,
  shouldHideSkillStudioStatusOnlyMessageForTest,
  shouldShowComposerWaitingIndicator,
  skillStudioEvaluationDraftFieldsForTest,
  skillStudioReferencedRecipesForTest,
  skillStudioEventsFromUiEventsForTest,
  visibleCanvasContextActivitiesForMessageForTest,
  visibleAssistantOrderedPartsForMessageForTest,
  visibleAssistantClarificationTimelineItemsForTest,
  visibleSkillStudioEventsForMessageForTest,
} from "@/features/superchat/superchat-panel";
import type { ChatMessage, ChatMessagePart, ChatRole } from "@/features/superchat/types";

const MESSAGE_CACHE_PREFIX = "superchat:messages:v2:";
const DAY_MS = 24 * 60 * 60 * 1000;
const apiPostMock = vi.hoisted(() => vi.fn(() => Promise.resolve({})));

describe("scope sync active turn recovery", () => {
  const pendingMessages: ChatMessage[] = [
    {
      id: "user-turn-1",
      role: "user",
      text: "Continue generating",
      turnId: "turn-1",
      timestamp: 1,
    },
  ];

  it("keeps a pending local turn only when the server reports it busy", () => {
    expect(shouldKeepActiveTurnAfterScopeSync(true, "turn-1", pendingMessages)).toBe(true);
    expect(shouldKeepActiveTurnAfterScopeSync(false, "turn-1", pendingMessages)).toBe(false);
    expect(shouldKeepActiveTurnAfterScopeSync(undefined, "turn-1", pendingMessages)).toBe(false);
  });
});

vi.mock("@/lib/api", () => ({
  api: {
    post: apiPostMock,
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  useParams: () => ({ project: "project-a" }),
}));
vi.mock("@/features/canvas/hooks/useFreezoneImageModels", async (importOriginal) => {
  const models = [{ id: "image-model", label: "Test image model" }];
  return { ...await importOriginal<typeof import("@/features/canvas/hooks/useFreezoneImageModels")>(), useFreezoneImageModels: () => ({ models }) };
});
vi.mock("@/features/canvas/hooks/useFreezoneVideoModels", async (importOriginal) => {
  const models = [{ id: "video-model", label: "Test video model", minDuration: 5, maxDuration: 15 }];
  return { ...await importOriginal<typeof import("@/features/canvas/hooks/useFreezoneVideoModels")>(), useFreezoneVideoModels: () => ({ models }) };
});

describe("mixed workflow approval execution", () => {
  it("keeps confirmed media groups when upstream image/audio nodes complete", () => {
    const previous = useCanvasStore.getState();
    const nodes = [
      { id: "image-a", type: "imageGenNode" as const, position: { x: 0, y: 0 }, data: { prompt: "City", model: "image-model" } },
      { id: "video-a", type: "videoNode" as const, position: { x: 0, y: 0 }, data: { prompt: "City", model: "video-model", durationSec: 5 } },
      { id: "audio-a", type: "audioNode" as const, position: { x: 0, y: 0 }, data: { prompt: "Music", audioKind: "music", forceInstrumental: true } },
    ];
    useCanvasStore.setState({ nodes, edges: [] });
    expect(workflowGenerationTargetsForPreflight({ type: "run_workflow", scope: "canvas" })).toHaveLength(3);
    const approval = {
      id: "mixed", key: "mixed", messageId: "assistant", receivedAt: 1,
      commandCount: 1, plans: [],
      envelopes: [{ schema_version: "canvas_chat_commands.v1" as const,
        commands: [{ type: "run_workflow" as const, scope: "canvas" as const }] }],
    };
    const props = { approval, onApply: vi.fn(), onCancel: vi.fn() };
    const view = render(createElement(CanvasCommandApprovalCardForTest, props));
    try {
      expect(view.getByLabelText("Image model")).toBeTruthy();
      expect(view.getByLabelText("Video model")).toBeTruthy();
      view.rerender(createElement(CanvasCommandApprovalCardForTest, { ...props, isExecuting: true }));
      act(() => useCanvasStore.setState({ nodes: nodes.map((node) => ({
        ...node, data: { ...node.data, imageUrl: "image.png", audioUrl: "audio.mp3" },
      })) }));
      expect(view.getByLabelText("Image model")).toBeTruthy();
      expect(view.getByLabelText("Video model")).toBeTruthy();
      expect(view.container.textContent).toContain("Instrumental");
      expect(view.queryByText("Canvas operations awaiting confirmation")).toBeNull();
    } finally {
      view.unmount();
      useCanvasStore.setState({ nodes: previous.nodes, edges: previous.edges });
    }
  });
});

function message(
  id: string,
  role: ChatRole,
  text: string,
  timestamp: number,
  turnId?: string,
): ChatMessage {
  return { id, role, text, timestamp, turnId };
}

describe("mergeHistorySnapshot", () => {
  it("keeps only the latest message content for a duplicated id", () => {
    const messages = [
      message("72", "assistant", "partial", 10),
      message("73", "user", "next", 20),
      message("72", "assistant", "complete", 30),
    ];

    const deduped = dedupeMessagesByIdForTest(messages);

    expect(deduped.map((item) => item.id)).toEqual(["72", "73"]);
    expect(deduped[0]).toMatchObject({ text: "complete", timestamp: 30 });
  });

  it("removes duplicate ids from backend history snapshots", () => {
    const history = [
      message("72", "assistant", "partial", 10),
      message("72", "assistant", "complete", 20),
    ];

    const merged = mergeHistorySnapshot([], history);

    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ id: "72", text: "complete", timestamp: 20 });
  });

  it("replaces local turn messages with matching backend history", () => {
    const current = [
      message("user-turn-1", "user", "Hello", 10, "turn-1"),
      message("assistant-turn-1", "assistant", "Hello, how can I help you?", 20, "turn-1"),
    ];
    const history = [
      message("backend-user-1", "user", "Hello", 30),
      message("backend-assistant-1", "assistant", "Hello, how can I help you?", 40),
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");

    expect(merged.map((item) => item.id)).toEqual(["backend-user-1", "backend-assistant-1"]);
  });

  it("replaces a completed local turn when the final local delta is newer than backend history", () => {
    const current = [
      message("user-turn-1", "user", "Hello", 100, "turn-1"),
      message("assistant-turn-1", "assistant", "Hello, how can I help you?", 300, "turn-1"),
    ];
    const history = [
      message("backend-user-1", "user", "Hello", 150),
      message("backend-assistant-1", "assistant", "Hello, how can I help you?", 250),
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");

    expect(merged.map((item) => item.id)).toEqual(["backend-user-1", "backend-assistant-1"]);
  });

  it("replaces a completed local turn even when local partial text differs", () => {
    const current = [
      message("user-turn-1", "user", "Hello", 100, "turn-1"),
      message("assistant-turn-1", "assistant", "Generating", 120, "turn-1"),
    ];
    const history = [
      message("backend-user-1", "user", "Hello", 150),
      message("backend-assistant-1", "assistant", "Hello! Is there anything I can help you with?", 250),
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");

    expect(merged.map((item) => item.id)).toEqual(["backend-user-1", "backend-assistant-1"]);
  });

  it("keeps the protected in-flight turn when a stale snapshot has the same user text", () => {
    const current = [
      message("backend-user-1", "user", "Hello", 10),
      message("backend-assistant-1", "assistant", "First turn reply", 20),
      message("user-turn-2", "user", "Hello", 30, "turn-2"),
      message("assistant-turn-2", "assistant", "Generating", 40, "turn-2"),
    ];
    const staleHistory = [
      message("backend-user-1", "user", "Hello", 10),
      message("backend-assistant-1", "assistant", "First turn reply", 20),
    ];

    const merged = mergeHistorySnapshot(current, staleHistory, "turn-2");

    expect(merged.map((item) => item.id)).toEqual([
      "backend-user-1",
      "backend-assistant-1",
      "user-turn-2",
      "assistant-turn-2",
    ]);
  });

  it("keeps a protected assistant reply even when it resembles an earlier turn", () => {
    const current = [
      message("backend-user-1", "user", "Hello", 10, "turn-1"),
      message("backend-assistant-1", "assistant", "Hello, how can I help you?", 20, "turn-1"),
      message("user-turn-2", "user", "Hello", 30, "turn-2"),
      message("assistant-turn-2", "assistant", "Hello, how can I help you?", 40, "turn-2"),
    ];
    const staleHistory = [
      message("backend-user-1", "user", "Hello", 10, "turn-1"),
      message("backend-assistant-1", "assistant", "Hello, how can I help you?", 20, "turn-1"),
    ];

    const merged = mergeHistorySnapshot(current, staleHistory, "turn-2");

    expect(merged.map((item) => item.id)).toEqual([
      "backend-user-1",
      "backend-assistant-1",
      "user-turn-2",
      "assistant-turn-2",
    ]);
  });

  it("does not collapse repeated completed turns from backend history", () => {
    const history = [
      message("backend-user-1", "user", "Hello", 10),
      message("backend-assistant-1", "assistant", "Reply", 20),
      message("backend-user-2", "user", "Hello", 30),
      message("backend-assistant-2", "assistant", "Reply", 40),
    ];

    const merged = mergeHistorySnapshot([], history);

    expect(merged.map((item) => item.id)).toEqual([
      "backend-user-1",
      "backend-assistant-1",
      "backend-user-2",
      "backend-assistant-2",
    ]);
  });

  it("drops unprotected local assistant leftovers when backend history arrives", () => {
    const current = [
      message("backend-user-1", "user", "First sentence", 10),
      message("backend-assistant-1", "assistant", "First turn reply", 20),
      message("assistant-stale", "assistant", "Reply left over from last time", 30, "turn-stale"),
    ];
    const history = [
      message("backend-user-1", "user", "First sentence", 10),
      message("backend-assistant-1", "assistant", "First turn reply", 20),
    ];

    const merged = mergeHistorySnapshot(current, history);

    expect(merged.map((item) => item.id)).toEqual(["backend-user-1", "backend-assistant-1"]);
  });

  it("keeps locally submitted prompt state when history still has the pending card", () => {
    const current: ChatMessage[] = [
      message("backend-user-1", "user", "I want to create a promotional poster skill", 10, "turn-1"),
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "",
        timestamp: 30,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.questions",
            bridge_key: "skill-key-1",
            skill_studio_session_id: "studio-1",
            questions: [],
            submitted: true,
            action: "submit",
            selections: { audience: { option_ids: ["locals"], custom_text: "" } },
          },
        ],
      },
    ];
    const history: ChatMessage[] = [
      message("backend-user-1", "user", "I want to create a promotional poster skill", 10, "turn-1"),
      {
        id: "backend-assistant-1",
        role: "assistant",
        text: "",
        timestamp: 20,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.questions",
            bridge_key: "skill-key-1",
            skill_studio_session_id: "studio-1",
            questions: [],
          },
        ],
      },
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");
    const assistant = merged.find((item) => item.role === "assistant");

    expect(assistant?.uiEvents?.[0]).toMatchObject({
      type: "skill_studio.questions",
      bridge_key: "skill-key-1",
      submitted: true,
      action: "submit",
      selections: { audience: { option_ids: ["locals"], custom_text: "" } },
    });
  });

  it("keeps locally edited draft state when history still has the original draft", () => {
    const current: ChatMessage[] = [
      message("backend-user-1", "user", "Generate a skill draft", 10, "turn-1"),
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "",
        timestamp: 30,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            skill_studio_session_id: "studio-1",
            draft: {
              skill: { id: "edited-skill", description: "Edited draft" },
              recipes: [],
            },
          },
        ],
      },
    ];
    const history: ChatMessage[] = [
      message("backend-user-1", "user", "Generate a skill draft", 10, "turn-1"),
      {
        id: "backend-assistant-1",
        role: "assistant",
        text: "",
        timestamp: 20,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            skill_studio_session_id: "studio-1",
            skill: { id: "original-skill", description: "Original draft" },
            recipes: [],
          },
        ],
      },
    ];

    const merged = mergeHistorySnapshot(current, history, "turn-1");
    const assistant = merged.find((item) => item.role === "assistant");

    expect(assistant?.uiEvents).toHaveLength(1);
    expect(assistant?.uiEvents?.[0]).toMatchObject({
      type: "skill_studio.draft",
      bridge_key: "draft-key-1",
      draft: {
        skill: { id: "edited-skill", description: "Edited draft" },
      },
    });
  });

  it("reveals an incomplete Skill Studio draft from submitted tool chunks when the turn ends", () => {
    const messages: ChatMessage[] = [
      message("user-1", "user", "Distill the canvas into a Skill", 10, "turn-1"),
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "Generating the draft.",
        timestamp: 20,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.status",
            status: "draft_skill_ready",
            message: "Skill base configuration generated",
            skill_studio_session_id: "studio-1",
          },
          {
            type: "skill_studio.status",
            status: "draft_recipe_ready",
            message: "Recipe 1 / 2 generated",
            recipe_index: 0,
            recipe_count: 2,
            skill_studio_session_id: "studio-1",
          },
        ],
      },
    ];
    const draftChunks = new Map([
      [
        "studio-1",
        {
          turnId: "turn-1",
          sessionId: "studio-1",
          mode: "create",
          expectedRecipeCount: 2,
          skill: { id: "pixar-ad", description: "Pixar ad" },
          recipes: new Map([[0, { id: "storyboard", name: "Storyboard" }]]),
        },
      ],
    ]);

    const next = revealIncompleteSkillStudioDraftForTurnForTest(messages, "turn-1", draftChunks);
    const assistant = next.find((item) => item.role === "assistant" && item.turnId === "turn-1");
    const event = assistant?.uiEvents?.find((item): item is Record<string, unknown> =>
      Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type === "skill_studio.draft"),
    );

    expect(event).toMatchObject({
      type: "skill_studio.draft",
      skill_studio_session_id: "studio-1",
      incomplete: true,
      read_only: true,
      skill: { id: "pixar-ad" },
      recipes: [{ id: "storyboard" }],
    });
    expect(event?.warnings).toContain("Recipes generated 1 / 2, 1 missing.");
    expect(assistant?.uiEvents?.some((item) =>
      Boolean(item && typeof item === "object" && (item as Record<string, unknown>).type === "skill_studio.status"),
    )).toBe(false);
  });
});

describe("assistant message ordered parts", () => {
  it("hydrates ordered draft parts with merged cancellation state without dropping draft content", () => {
    const parts = hydrateOrderedPartsWithUiEventsForTest(
      [
        {
          id: "skill_studio.draft:draft-key-1",
          type: "skill_studio",
          event: {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            skill_studio_session_id: "studio-1",
            draft: {
              skill: { id: "pixar-ip-brand-ad", description: "Pixar ad" },
              recipes: [{ id: "character-design" }],
            },
          },
        },
      ],
      [
        {
          type: "skill_studio.draft",
          bridge_key: "draft-key-1",
          skill_studio_session_id: "studio-1",
          draft: {
            skill: { id: "pixar-ip-brand-ad", description: "Pixar ad" },
            recipes: [{ id: "character-design" }],
          },
        },
        {
          type: "skill_studio.draft",
          bridge_key: "draft-key-1",
          skill_studio_session_id: "studio-1",
          cancelled: true,
        },
      ],
    );

    expect(parts?.[0]).toMatchObject({
      type: "skill_studio",
      event: {
        type: "skill_studio.draft",
        cancelled: true,
        draft: {
          skill: { id: "pixar-ip-brand-ad", description: "Pixar ad" },
          recipes: [{ id: "character-design" }],
        },
      },
    });
  });

  it("keeps text and interaction cards in arrival order within one turn", () => {
    let messages: ChatMessage[] = [];

    messages = upsertAssistantMessageForTest(messages, "turn-ordered", "First paragraph");
    messages = upsertAssistantUiEventForTest(messages, "turn-ordered", {
      type: "skill_studio.questions",
      bridge_key: "questions-1",
      skill_studio_session_id: "studio-1",
      title: "Direction confirmation",
      questions: [],
    });
    messages = upsertAssistantMessageForTest(messages, "turn-ordered", "First paragraph\n\nSecond paragraph");
    messages = upsertAssistantUiEventForTest(messages, "turn-ordered", {
      type: "skill_studio.draft",
      bridge_key: "draft-1",
      skill_studio_session_id: "studio-1",
      summary: "Draft",
      skill: { id: "skill-1" },
      recipes: [],
    });
    messages = upsertAssistantMessageForTest(
      messages,
      "turn-ordered",
      "First paragraph\n\nSecond paragraph\n\nThird paragraph",
    );

    const assistant = messages.find((item) => item.turnId === "turn-ordered" && item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual([
      "text",
      "skill_studio",
      "text",
      "skill_studio",
      "text",
    ]);
    expect(assistant?.parts?.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "First paragraph",
      "\n\nSecond paragraph",
      "\n\nThird paragraph",
    ]);
  });

  it("keeps streamed prose around submitted Skill Studio cards when the final assistant message arrives", () => {
    let messages: ChatMessage[] = [];
    const firstText = [
      "Let me first understand the details of the key canvas nodes, then confirm the distillation direction with you.",
      "",
      "I have read through the current canvas; overall it is a brand IP short film production flow.",
      "",
      "Before distilling, let me confirm a few key directions with you.",
      "",
    ].join("\n");
    const confirmedText = `${firstText}\nOkay, direction confirmed: a reusable Skill / 6 fine-grained Recipes. I will start drafting now.\n\n`;

    messages = upsertAssistantMessageForTest(messages, "turn-skill-studio-final", firstText);
    messages = upsertAssistantUiEventForTest(messages, "turn-skill-studio-final", {
      type: "assistant.clarification.request",
      submitted: true,
      bridge_key: "clarification-key",
      anchor_text_prefix: firstText,
      questions: [],
      answers: {},
    });
    messages = upsertAssistantMessageForTest(messages, "turn-skill-studio-final", confirmedText);
    messages = upsertAssistantUiEventForTest(messages, "turn-skill-studio-final", {
      type: "skill_studio.draft",
      bridge_key: "draft-key",
      skill_studio_session_id: "studio-1",
      skill: { id: "skill-1" },
      recipes: [],
    });
    messages = upsertServerAssistantMessageForTest(
      messages,
      {
        id: 9,
        role: "assistant",
        content: confirmedText,
        turn_id: "turn-skill-studio-final",
        created_at: "2026-07-24T06:39:26.750139+00:00",
      },
      "turn-skill-studio-final",
    );

    const assistant = messages.find((item) => item.turnId === "turn-skill-studio-final" && item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual([
      "text",
      "clarification",
      "text",
      "skill_studio",
    ]);
    expect(assistant?.parts?.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      firstText,
      confirmedText.slice(firstText.length),
    ]);
  });

  it("does not move realtime Skill Studio cards ahead of earlier streamed text on final assistant message", () => {
    let messages: ChatMessage[] = [];
    const firstText = "Okay, direction confirmed. I will start drafting the Skill now.";
    const secondText = `${firstText}\n\nUnderstood, the Pixar style is the core visual protocol; I will add it back to the draft now.`;
    const finalText = `${secondText}\n\nPart of the content has been updated; you can keep adjusting.`;

    messages = upsertAssistantMessageForTest(messages, "turn-skill-studio-patch", firstText);
    messages = upsertAssistantUiEventForTest(messages, "turn-skill-studio-patch", {
      type: "skill_studio.questions",
      bridge_key: "questions-key",
      submitted: true,
      questions: [],
      skill_studio_session_id: "studio-1",
    });
    messages = upsertAssistantMessageForTest(messages, "turn-skill-studio-patch", secondText);
    messages = upsertAssistantUiEventForTest(messages, "turn-skill-studio-patch", {
      type: "skill_studio.draft",
      bridge_key: "draft-key",
      skill: { id: "skill-1" },
      recipes: [],
      skill_studio_session_id: "studio-1",
    });
    messages = upsertServerAssistantMessageForTest(
      messages,
      {
        id: 10,
        role: "assistant",
        content: finalText,
        turn_id: "turn-skill-studio-patch",
        created_at: "2026-07-24T08:56:19.103488+00:00",
      },
      "turn-skill-studio-patch",
    );

    const assistant = messages.find((item) => item.turnId === "turn-skill-studio-patch" && item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual([
      "text",
      "skill_studio",
      "text",
      "skill_studio",
      "text",
    ]);
    expect(assistant?.parts?.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      firstText,
      secondText.slice(firstText.length),
      finalText.slice(secondText.length),
    ]);
  });

  it("reorders historical Skill Studio parts around their text anchors", () => {
    const firstText = [
      "Let me first understand the details of the key canvas nodes, then confirm the distillation direction with you.",
      "",
      "I have read through the current canvas; overall it is a brand IP short film production flow.",
      "",
      "Before distilling, let me confirm a few key directions with you.",
      "",
    ].join("\n");
    const confirmedText = `${firstText}\nOkay, direction confirmed: a reusable Skill / 6 fine-grained Recipes. I will start drafting now.\n\n`;
    const assistant: ChatMessage = {
      id: "backend-assistant-1",
      role: "assistant",
      text: confirmedText,
      turnId: "turn-skill-studio-history",
      timestamp: 1,
      parts: [
        {
          id: "clarification:clarification-key",
          type: "clarification",
          event: {
            type: "assistant.clarification.request",
            submitted: true,
            bridge_key: "clarification-key",
            anchor_text_prefix: firstText,
            questions: [],
            answers: {},
          },
        },
        {
          id: "agent_thought:turn-skill-studio-history:middle",
          type: "agent_thought",
          event: {
            type: "agent.thought.delta",
            status: "completed",
            text: "Start drafting the Skill and Recipes.",
          },
        },
        {
          id: "skill_studio.draft:draft-key",
          type: "skill_studio",
          event: {
            type: "skill_studio.draft",
            bridge_key: "draft-key",
            skill_studio_session_id: "studio-1",
            anchor_text_prefix: firstText,
            skill: { id: "skill-1" },
            recipes: [],
          },
        },
        {
          id: "text-1",
          type: "text",
          text: confirmedText,
        },
      ],
    };

    const parts = visibleAssistantOrderedPartsForMessageForTest(assistant);

    expect(parts.map((part) => part.type)).toEqual([
      "text",
      "clarification",
      "agent_thought",
      "text",
      "skill_studio",
    ]);
    expect(parts.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      firstText,
      confirmedText.slice(firstText.length),
    ]);
  });

  it("keeps Skill Studio status in ordered parts after a submitted question card", () => {
    let messages: ChatMessage[] = [];

    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.questions",
      bridge_key: "questions-1",
      skill_studio_session_id: "studio-1",
      submitted: true,
      action: "submit",
      questions: [],
    });
    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.status",
      status: "draft_begin",
      message: "Creating the draft structure...",
    });

    const assistant = messages.find((item) => item.turnId === "turn-skill-status" && item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual(["skill_studio", "skill_studio"]);
    expect(assistant?.parts?.map((part) => part.type === "text" ? part.text : (part.event as { type?: string }).type)).toEqual([
      "skill_studio.questions",
      "skill_studio.status",
    ]);
  });

  it("keeps real Skill Studio progress in ordered parts when prose arrives", () => {
    let messages: ChatMessage[] = [];

    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.status",
      status: "draft_begin",
      message: "Creating the draft structure...",
    });
    messages = upsertAssistantMessageForTest(messages, "turn-skill-status", "Start organizing the draft");

    const assistant = messages.find((item) => item.turnId === "turn-skill-status" && item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual(["skill_studio", "text"]);
    expect(assistant?.parts?.map((part) => part.type === "text" ? part.text : (part.event as { type?: string }).type)).toEqual([
      "skill_studio.status",
      "Start organizing the draft",
    ]);
  });

  it("keeps real Skill Studio progress when the final assistant message arrives", () => {
    let messages: ChatMessage[] = [];

    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.questions",
      bridge_key: "questions-1",
      skill_studio_session_id: "studio-1",
      submitted: true,
      action: "submit",
      questions: [],
    });
    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.status",
      status: "draft_recipe_ready",
      message: "Recipe 2 / 6 generated",
    });
    messages = upsertServerAssistantMessageForTest(
      messages,
      {
        id: 3,
        role: "assistant",
        content: "Draft generation is incomplete; please keep adding the direction of adjustment.",
        turn_id: "turn-skill-status",
        created_at: "2026-07-15T08:51:44.199417+00:00",
      },
      "turn-skill-status",
    );

    const assistant = messages.find((item) => item.turnId === "turn-skill-status" && item.role === "assistant");
    expect(assistant?.text).toBe("Draft generation is incomplete; please keep adding the direction of adjustment.");
    expect(assistant?.parts?.map((part) => part.type)).toEqual(["skill_studio", "skill_studio", "text"]);
    expect(assistant?.parts?.map((part) => part.type === "text" ? part.text : (part.event as { type?: string }).type)).toEqual([
      "skill_studio.questions",
      "skill_studio.status",
      "Draft generation is incomplete; please keep adding the direction of adjustment.",
    ]);
    expect(assistant?.uiEvents?.map((event) => (event as { type?: string }).type)).toEqual([
      "skill_studio.questions",
      "skill_studio.status",
    ]);
  });

  it("keeps real Skill Studio progress when a turn completes without a final assistant payload", () => {
    let messages: ChatMessage[] = [];

    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.questions",
      bridge_key: "questions-1",
      skill_studio_session_id: "studio-1",
      submitted: true,
      action: "submit",
      questions: [],
    });
    messages = upsertAssistantUiEventForTest(messages, "turn-skill-status", {
      type: "skill_studio.status",
      status: "draft_recipe_ready",
      message: "Recipe 2 / 6 generated",
    });

    const cleaned = removeSkillStudioStatusForTurnForTest(messages, "turn-skill-status");
    const assistant = cleaned.find((item) => item.turnId === "turn-skill-status" && item.role === "assistant");

    expect(assistant?.parts?.map((part) => part.type === "text" ? part.text : (part.event as { type?: string }).type)).toEqual([
      "skill_studio.questions",
      "skill_studio.status",
    ]);
    expect(assistant?.uiEvents?.map((event) => (event as { type?: string }).type)).toEqual([
      "skill_studio.questions",
      "skill_studio.status",
    ]);
  });

  it("hydrates ordered part events from the latest uiEvents without changing order", () => {
    const parts = hydrateOrderedPartsWithUiEventsForTest(
      [
        {
          id: "skill_studio.draft:draft-key-1",
          type: "skill_studio",
          event: {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            draft: { skill: { id: "public-welfare-short-film" }, recipes: [] },
          },
        },
        {
          id: "assistant.clarification.request:clarify-key-1",
          type: "clarification",
          event: {
            type: "assistant.clarification.request",
            bridge_key: "clarify-key-1",
            title: "Revision direction",
          },
        },
      ],
      [
        {
          type: "skill_studio.draft",
          bridge_key: "draft-key-1",
          revision_pending: true,
          action: "start_revision",
        },
      ],
    );

    expect(parts?.map((part) => part.id)).toEqual([
      "skill_studio.draft:draft-key-1",
      "assistant.clarification.request:clarify-key-1",
    ]);
    expect((parts?.[0] as { event?: { revision_pending?: boolean } }).event?.revision_pending).toBe(true);
  });
});

describe("updateAssistantUiEvents", () => {
  it("updates matching ordered parts even when uiEvents are absent", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-turn-a",
        role: "assistant",
        text: "",
        turnId: "turn-a",
        timestamp: 1,
        parts: [
          {
            id: "clarification:bridge-a",
            type: "clarification",
            event: {
              type: "assistant.clarification.request",
              bridge_key: "bridge-a",
              submitted: false,
            },
          },
        ],
      },
    ];

    const updated = updateAssistantUiEventsForTest(
      messages,
      "turn-a",
      (event) =>
        Boolean(
          event
          && typeof event === "object"
          && (event as Record<string, unknown>).bridge_key === "bridge-a",
        ),
      (event) => ({ ...(event as Record<string, unknown>), submitted: true }),
    );

    expect(updated).not.toBe(messages);
    expect((updated[0].parts?.[0] as { event?: { submitted?: boolean } }).event?.submitted).toBe(true);
  });
});

describe("normalizeMessage", () => {
  it("strips internal DramaClaw context blocks from displayed text", () => {
    const normalized = normalizeMessage({
      id: "backend-user-1",
      role: "user",
      content: `Which files did I upload

[DRAMACLAW_UPLOADED_FILES]
dramaclaw_project_id: 01KT62KTBQCDR69WW889VHJR3N
file_1_filename: Her and her country.docx
[/DRAMACLAW_UPLOADED_FILES]`,
      created_at: "2026-06-03T09:00:00Z",
    });

    expect(normalized?.text).toBe("Which files did I upload");
  });

  it("strips internal SuperTale canvas command blocks from displayed text", () => {
    const normalized = normalizeMessage({
      id: "backend-user-2",
      role: "user",
      content: `Hello

[SUPERTALE_CANVAS_CHAT_COMMANDS]
This Freezone chat can change the current canvas by returning a JSON block.
[/SUPERTALE_CANVAS_CHAT_COMMANDS]`,
      created_at: "2026-06-08T08:00:00Z",
    });

    expect(normalized?.text).toBe("Hello");
  });

  it("maps internal empty Hermes replies to a user-facing message", () => {
    const normalized = normalizeMessage({
      id: "backend-assistant-empty",
      role: "assistant",
      content: "(hermes returned no content)",
      created_at: "2026-07-10T08:00:00Z",
    });

    expect(normalized?.text).toBe("This turn did not receive a valid reply from Shrimp Director. Please try again later.");
  });

  it("preserves backend ui events for persisted canvas feedback", () => {
    const uiEvents = [
      {
        type: "canvas_command_result",
        bridge_key: "bridge-a",
      },
    ];
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      content: "Completed",
      ui_events: uiEvents,
    });

    expect(normalized?.uiEvents).toBe(uiEvents);
  });

  it("keeps ordered canvas and tool parts from cache or server history", () => {
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      text: "",
      parts: [
        {
          id: "feedback-a",
          type: "canvas_feedback",
          event: { key: "feedback-a", applied: true },
        },
        {
          id: "tool-a",
          type: "tool_status",
          event: { role: "tool", text: "Create node", raw: { type: "tool.result" } },
        },
      ],
    });

    expect(normalized?.parts?.map((part) => part.type)).toEqual(["canvas_feedback", "tool_status"]);
  });

  it("removes bridged canvas context tool status parts from history", () => {
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      text: "Let me analyze the current canvas content.",
      parts: [
        {
          id: "tool-a",
          type: "tool_status",
          event: {
            role: "tool",
            text: "Read canvas ontology",
            raw: { type: "agent.tool.updated", name: "freezone_get_canvas_ontology" },
          },
        },
        { id: "text-a", type: "text", text: "Let me analyze the current canvas content." },
      ],
    });

    expect(normalized?.parts?.map((part) => part.type)).toEqual(["text"]);
  });

  it("removes internal tool search and describe status parts from history", () => {
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      text: "The lighting panel has been opened.",
      parts: [
        {
          id: "tool-search",
          type: "tool_status",
          event: {
            role: "tool",
            text: "Tool Search",
            raw: { type: "agent.tool.updated", name: "Tool Search" },
          },
        },
        {
          id: "tool-describe",
          type: "tool_status",
          event: {
            role: "tool",
            text: "Tool Describe",
            raw: { type: "agent.tool.updated", name: "tool-describe" },
          },
        },
        { id: "text-a", type: "text", text: "The lighting panel has been opened." },
      ],
    });

    expect(normalized?.parts?.map((part) => part.type)).toEqual(["text"]);
  });

  it("keeps ordered agent runtime parts from cache or server history", () => {
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      text: "",
      parts: [
        {
          id: "thought-a",
          type: "agent_thought",
          event: { text: "I am planning the next step.", status: "completed" },
        },
        {
          id: "plan-a",
          type: "agent_plan",
          event: { entries: [] },
        },
        {
          id: "usage-a",
          type: "agent_usage",
          event: { usage: { used: 10 } },
        },
      ],
    });

    expect(normalized?.parts?.map((part) => part.type)).toEqual([
      "agent_thought",
      "agent_plan",
      "agent_usage",
    ]);
  });

  it("restores trailing assistant text when ordered history parts stop at an interaction card", () => {
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      content: "Confirm the direction first.\n\nThe draft has been generated.\n\nThe Skill has been created and can be used now.",
      parts: [
        {
          id: "text-1",
          type: "text",
          text: "Confirm the direction first.\n\n",
        },
        {
          id: "draft-1",
          type: "skill_studio",
          event: {
            type: "skill_studio.draft",
            bridge_key: "draft-1",
          },
        },
      ],
    });

    expect(normalized?.parts?.map((part) => part.type)).toEqual(["text", "skill_studio", "text"]);
    expect(normalized?.parts?.[2]).toMatchObject({
      type: "text",
      text: "The draft has been generated.\n\nThe Skill has been created and can be used now.",
    });
  });

  it("restores assistant text when ordered history parts only contain interaction cards", () => {
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      content: "The Skill was saved successfully and can be used directly.",
      parts: [
        {
          id: "clarification-1",
          type: "clarification",
          event: {
            type: "assistant.clarification.request",
            bridge_key: "clarify-key-1",
            submitted: true,
          },
        },
        {
          id: "draft-1",
          type: "skill_studio",
          event: {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
          },
        },
      ],
    });

    expect(normalized?.parts?.map((part) => part.type)).toEqual(["clarification", "skill_studio", "text"]);
    expect(normalized?.parts?.[2]).toMatchObject({
      type: "text",
      text: "The Skill was saved successfully and can be used directly.",
    });
  });

  it("uses the complete persisted text when ordered text parts are stale", () => {
    const fullText = [
      "The workflow has been created with the following nodes:",
      "1. User requirements",
      "2. Creative outline",
      "3. Ad script",
      "4. Multi-grid storyboard",
      "5. HD storyboard (3 images)",
      "6. Video clips (3 clips)",
    ].join("\n");
    const normalized = normalizeMessage({
      id: "assistant-workflow-summary",
      role: "assistant",
      content: fullText,
      parts: [
        {
          id: "tool-1",
          type: "tool_status",
          event: { role: "tool", text: "Load Workflow Skill", raw: { type: "tool.result" } },
        },
        {
          id: "text-stale",
          type: "text",
          text: "Let me read the workflow configuration first.",
        },
        {
          id: "text-partial",
          type: "text",
          text: "The workflow has been created with the following nodes:\n1. User requirements\n2. Creative outline\n3. Ad script\n4. Multi-grid storyboard\n5.",
        },
      ],
    });

    expect(normalized?.parts?.map((part) => part.type)).toEqual(["tool_status", "text"]);
    expect(normalized?.parts?.[1]).toMatchObject({ type: "text", text: fullText });
  });

  it("hydrates ordered interaction parts from newer persisted ui events", () => {
    const normalized = normalizeMessage({
      id: "assistant-1",
      role: "assistant",
      content: "The draft has been generated.",
      parts: [
        {
          id: "draft-1",
          type: "skill_studio",
          event: {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            submitted: false,
            draft: { skill: { id: "draft-skill" }, recipes: [] },
          },
        },
      ],
      ui_events: [
        {
          type: "skill_studio.draft",
          bridge_key: "draft-key-1",
          submitted: true,
          saved_to_catalog: true,
          saved_skill_ids: ["draft-skill"],
          saved_recipe_ids: ["draft-recipe"],
          draft: { skill: { id: "saved-skill" }, recipes: [] },
        },
      ],
    });

    expect(normalized?.parts?.[0]).toMatchObject({
      type: "skill_studio",
      event: {
        type: "skill_studio.draft",
        bridge_key: "draft-key-1",
        submitted: true,
        saved_to_catalog: true,
        saved_skill_ids: ["draft-skill"],
        draft: { skill: { id: "saved-skill" } },
      },
    });
  });
});

describe("normalizeMessageForScope", () => {
  const freezoneScope = scopeForProjectForTest("project-a", "freezone", "canvas-a", "agent-a");
  const directorScope = scopeForProjectForTest("project-a", "director");
  const canvasReferencePayload = {
    schema_version: CANVAS_NODE_REFERENCE_SCHEMA_VERSION,
    project: "project-a",
    canvas_id: "canvas-a",
    nodes: [
      {
        node_id: "node-text",
        node_type: "textAnnotationNode",
        label: "Text",
        text_field: "content",
        text_content: "Hello",
        media_type: null,
        source_url: null,
        preview_url: null,
        slot_target: null,
        mainline_context: null,
        candidate_origin: null,
        position: { x: 0, y: 0 },
        action_catalog: { actions: [] },
      },
    ],
    edges: [],
  };
  const canvasReferenceMedia = {
    id: "canvas_node_reference:Text",
    kind: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
    type: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
    label: "Text",
    content: JSON.stringify(canvasReferencePayload),
  };

  it("hydrates cached Freezone canvas node references from raw media", () => {
    const normalized = normalizeMessageForScopeForTest(
      {
        id: "user-1",
        role: "user",
        text: "Connect it to the image node for me",
        attachments: [
          {
            id: "canvas_node_reference:Text",
            type: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
            kind: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
            label: "Text",
            fileName: "Text",
          },
        ],
        rawMedia: [canvasReferenceMedia],
      },
      "assistant",
      freezoneScope,
    );

    expect(normalized?.attachments).toHaveLength(1);
    expect(normalized?.attachments?.[0].content).toBe(JSON.stringify(canvasReferencePayload));
    expect(isCanvasNodeReferenceAttachment(normalized!.attachments![0])).toBe(true);
  });

  it("does not hydrate canvas node references for the director scope", () => {
    const normalized = normalizeMessageForScopeForTest(
      {
        id: "user-1",
        role: "user",
        text: "Connect it to the image node for me",
        attachments: [
          {
            id: "canvas_node_reference:Text",
            type: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
            kind: CANVAS_NODE_REFERENCE_ATTACHMENT_TYPE,
            label: "Text",
            fileName: "Text",
          },
        ],
        rawMedia: [canvasReferenceMedia],
      },
      "assistant",
      directorScope,
    );

    expect(normalized?.attachments).toEqual([]);
  });
});

describe("upsertServerAssistantMessage", () => {
  it("keeps live agent details visible when the final assistant message arrives", () => {
    const current = upsertRuntimePartInMessagesForTest([], "turn-agent", {
      id: "agent_thought:turn-agent",
      type: "agent_thought",
      event: { text: "Checking assets" },
    });

    const merged = upsertServerAssistantMessageForTest(
      current,
      {
        id: 7,
        role: "assistant",
        content: "Asset check complete",
        turn_id: "turn-agent",
        created_at: "2026-07-19T00:00:00+00:00",
      },
      "turn-agent",
    );

    const assistant = merged.find((item) => item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual(["agent_thought", "text"]);
  });

  it("replaces partial streamed text when the final assistant message arrives", () => {
    const current: ChatMessage[] = [
      {
        id: "assistant-turn-grid",
        role: "assistant",
        text: "The multi-angle grid was submitted to the canvas; please wa",
        timestamp: 20,
        turnId: "turn-grid",
        parts: [
          { id: "text-1", type: "text", text: "The multi-angle grid was submitted to the canvas; please wa" },
        ],
      },
    ];

    const merged = upsertServerAssistantMessageForTest(
      current,
      {
        id: 11,
        role: "assistant",
        content: "The multi-angle grid was submitted to the canvas; please wait for the result to be generated.",
        turn_id: "turn-grid",
        created_at: "2026-07-23T01:56:37.894980+00:00",
      },
      "turn-grid",
    );

    const assistant = merged.find((item) => item.role === "assistant");
    expect(assistant?.text).toBe("The multi-angle grid was submitted to the canvas; please wait for the result to be generated.");
    expect(assistant?.parts?.filter((part) => part.type === "text").map((part) => part.text)).toEqual([
      "The multi-angle grid was submitted to the canvas; please wait for the result to be generated.",
    ]);
  });

  it("preserves transient ui events when the final assistant message arrives", () => {
    const uiEvent = {
      type: "skill_studio.questions",
      skill_studio_session_id: "skill_studio_01",
      questions: [],
    };
    const current: ChatMessage[] = [
      message("user-turn-1", "user", "Create Skill", 10, "turn-1"),
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "",
        timestamp: 20,
        turnId: "turn-1",
        uiEvents: [uiEvent],
      },
    ];

    const merged = upsertServerAssistantMessageForTest(
      current,
      {
        id: 3,
        role: "assistant",
        content: "Entered the Q&A stage",
        turn_id: "turn-1",
        created_at: "2026-07-08T03:47:06.538231+00:00",
      },
      "turn-1",
    );

    const assistant = merged.find((item) => item.role === "assistant");
    expect(assistant?.text).toBe("Entered the Q&A stage");
    expect(assistant?.uiEvents).toEqual([uiEvent]);
  });

  it("keeps transient cancelled canvas feedback before final assistant text", () => {
    const current: ChatMessage[] = [
      {
        id: "assistant-turn-canvas-timeout",
        role: "assistant",
        text: "",
        timestamp: 20,
        turnId: "turn-canvas-timeout",
        parts: [
          {
            id: "canvas_feedback:bridge-timeout",
            type: "canvas_feedback",
            seq: 1,
            event: {
              key: "bridge-timeout",
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
            },
          },
        ],
        uiEvents: [
          {
            type: "canvas_command_result",
            bridge_key: "bridge-timeout",
            result: {
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
            },
            cancelled: true,
            cancel_reason: "timeout",
            received_at: 1,
          },
        ],
      },
    ];

    const merged = upsertServerAssistantMessageForTest(
      current,
      {
        id: 9,
        role: "assistant",
        content: "The generation request timed out, possibly because the canvas connection was briefly interrupted. Click the node's generate button on the canvas to retry.",
        turn_id: "turn-canvas-timeout",
        created_at: "2026-07-30T07:00:00+00:00",
      },
      "turn-canvas-timeout",
    );

    const assistant = merged.find((item) => item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual(["canvas_feedback", "text"]);
    expect(visibleAssistantOrderedPartsForMessageForTest(assistant as ChatMessage).map((part) => part.type)).toEqual([
      "canvas_feedback",
      "text",
    ]);
  });

  it("merges same draft ui event when the final assistant message arrives", () => {
    const current: ChatMessage[] = [
      message("user-turn-1", "user", "Create Skill", 10, "turn-1"),
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "",
        timestamp: 20,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            skill_studio_session_id: "studio-1",
            skill: { id: "original-skill" },
          },
          {
            type: "skill_studio.draft",
            bridge_key: "draft-key-1",
            skill_studio_session_id: "studio-1",
            draft: { skill: { id: "edited-skill" }, recipes: [] },
          },
        ],
      },
    ];

    const merged = upsertServerAssistantMessageForTest(
      current,
      {
        id: 3,
        role: "assistant",
        content: "Keep going",
        turn_id: "turn-1",
        created_at: "2026-07-08T03:47:06.538231+00:00",
      },
      "turn-1",
    );

    const assistant = merged.find((item) => item.role === "assistant");
    expect(assistant?.uiEvents).toHaveLength(1);
    expect(assistant?.uiEvents?.[0]).toMatchObject({
      type: "skill_studio.draft",
      bridge_key: "draft-key-1",
      draft: { skill: { id: "edited-skill" } },
    });
  });

  it("preserves transient clarification parts in arrival order when the final assistant message has draft parts", () => {
    const current: ChatMessage[] = [
      message("user-turn-1", "user", "Create Skill", 10, "turn-1"),
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "Confirm the direction first.",
        timestamp: 20,
        turnId: "turn-1",
        parts: [
          { id: "text-1", type: "text", text: "Confirm the direction first." },
          {
            id: "assistant.clarification.request:clarify-key-1",
            type: "clarification",
            event: {
              type: "assistant.clarification.request",
              bridge_key: "clarify-key-1",
              clarification_id: "hometown-culture-poster-skill-setup",
              submitted: true,
              questions: [],
            },
          },
        ],
      },
    ];

    const merged = upsertServerAssistantMessageForTest(
      current,
      {
        id: 3,
        role: "assistant",
        content: "Confirm the direction first.\n\nThe draft has been generated.",
        turn_id: "turn-1",
        created_at: "2026-07-08T03:47:06.538231+00:00",
        parts: [
          { id: "text-1", type: "text", text: "Confirm the direction first.\n\n" },
          {
            id: "skill_studio.draft:draft-key-1",
            type: "skill_studio",
            event: {
              type: "skill_studio.draft",
              bridge_key: "draft-key-1",
              skill_studio_session_id: "studio-1",
              skill: { id: "home-culture" },
              recipes: [],
            },
          },
        ],
      },
      "turn-1",
    );

    const assistant = merged.find((item) => item.role === "assistant");
    expect(assistant?.parts?.map((part) => part.type)).toEqual(["text", "clarification", "skill_studio", "text"]);
    expect(assistant?.parts?.[1]).toMatchObject({
      type: "clarification",
      event: {
        type: "assistant.clarification.request",
        bridge_key: "clarify-key-1",
      },
    });
  });
});

describe("updateAssistantUiEvents", () => {
  it("persists submitted Skill Studio question selections on the assistant message", () => {
    const current: ChatMessage[] = [
      {
        id: "assistant-turn-1",
        role: "assistant",
        text: "",
        timestamp: 20,
        turnId: "turn-1",
        uiEvents: [
          {
            type: "skill_studio.questions",
            skill_studio_session_id: "skill_studio_01",
            questions: [],
          },
        ],
      },
    ];

    const next = updateAssistantUiEventsForTest(
      current,
      "turn-1",
      (event) =>
        Boolean(
          event
            && typeof event === "object"
            && (event as Record<string, unknown>).type === "skill_studio.questions",
        ),
      (event) => ({
        ...(event as Record<string, unknown>),
        submitted: true,
        action: "submit",
        selections: { audience: "young" },
      }),
    );

    expect(next[0]?.uiEvents?.[0]).toMatchObject({
      type: "skill_studio.questions",
      submitted: true,
      action: "submit",
      selections: { audience: "young" },
    });
  });
});

describe("Skill Studio question response", () => {
  it("uses the server turn id for incoming UI events before pending local turns", () => {
    expect(resolveUiEventTurnIdForTest("server-turn", "pending-turn", "active-turn")).toBe("server-turn");
    expect(resolveUiEventTurnIdForTest("  ", "pending-turn", "active-turn")).toBe("pending-turn");
    expect(resolveUiEventTurnIdForTest(null, null, "active-turn")).toBe("active-turn");
  });

  it("hides generic waiting status while a composer prompt is active", () => {
    expect(shouldShowComposerWaitingIndicator({
      busy: true,
      hasAssistantText: false,
      streamText: "",
      pendingCanvasCommandApprovalCount: 0,
      hasPendingVisibleUserMessage: true,
      hasThinkingCanvasContextActivity: false,
      hasActiveComposerPrompt: true,
    })).toBe(false);
  });

  it("keeps an existing assistant event message in its original timeline position", () => {
    const current = [
      message("assistant-turn-1", "assistant", "", 10, "turn-1"),
      message("user-turn-2", "user", "The next message after the user submitted", 20, "turn-2"),
    ];

    const next = upsertAssistantUiEventForTest(current, "turn-1", {
      type: "assistant.clarification.request",
      clarification_id: "clarify-1",
      submitted: true,
    });

    expect(next.map((item) => item.id)).toEqual(["assistant-turn-1", "user-turn-2"]);
    expect(next[0]?.timestamp).toBe(10);
    expect(next[0]?.uiEvents?.[0]).toMatchObject({
      type: "assistant.clarification.request",
      clarification_id: "clarify-1",
    });
  });

  it("marks an assistant message with pending questions as waiting for the user", () => {
    const pending = message("assistant-skill-question", "assistant", "", 100);
    pending.uiEvents = [
      {
        type: "skill_studio.questions",
        title: "Create promotional poster Skill",
        questions: [
          {
            id: "audience",
            title: "Who is the target audience?",
            options: [{ id: "locals", label: "Local residents" }],
          },
        ],
      },
    ];

    const submitted = message("assistant-skill-question-done", "assistant", "", 100);
    submitted.uiEvents = [
      {
        type: "skill_studio.questions",
        submitted: true,
        title: "Create promotional poster Skill",
        questions: [],
      },
    ];

    expect(messageIsWaitingForUserReplyForTest(pending)).toBe(true);
    expect(messageIsWaitingForUserReplyForTest(submitted)).toBe(false);
  });

  it("does not keep a stale clarification card active after a draft exists", () => {
    const stale = message("assistant-clarification-stale", "assistant", "(hermes timed out)", 100);
    stale.uiEvents = [
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-key-1",
        title: "Hometown culture poster Skill settings",
        questions: [
          {
            id: "audience",
            title: "Which group is the poster mainly for?",
            options: [{ id: "tourist", label: "Out-of-town tourists" }],
          },
        ],
      },
      {
        type: "skill_studio.draft",
        bridge_key: "draft-key-1",
        draft: {
          skill: { id: "home-culture-poster" },
          recipes: [],
        },
      },
    ];

    expect(messageIsWaitingForUserReplyForTest(stale)).toBe(false);
  });

  it("uses the latest pending clarification after a draft instead of an older stale one", () => {
    const assistant = message("assistant-clarification-sequence", "assistant", "", 100);
    assistant.turnId = "turn-sequence";
    assistant.uiEvents = [
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-old",
        title: "Old question",
        questions: [{ id: "old_question", title: "Old question", options: [{ id: "old", label: "Old" }] }],
      },
      {
        type: "skill_studio.draft",
        bridge_key: "draft-key",
        draft: { skill: { id: "public-service-video" }, recipes: [] },
      },
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-new",
        title: "New question",
        questions: [{ id: "new_question", title: "New question", options: [{ id: "new", label: "New" }] }],
      },
    ];

    expect(latestPendingAssistantClarificationEventForTest([assistant])?.bridge_key).toBe("clarify-new");
    expect(messageIsWaitingForUserReplyForTest(assistant)).toBe(true);
  });

  it("detects clarification cards that belong to a Skill Studio revision flow", () => {
    const assistant = message("assistant-revision-clarification", "assistant", "", 100);
    assistant.turnId = "turn-revision";
    assistant.uiEvents = [
      {
        type: "skill_studio.draft",
        bridge_key: "draft-key",
        revision_pending: true,
      },
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-revision",
        title: "Revision direction",
        questions: [{ id: "focus", title: "What should change first?", options: [{ id: "style", label: "Style" }] }],
      },
    ];

    expect(activeAssistantClarificationIsSkillStudioRevisionForTest(
      [assistant],
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-revision",
      },
    )).toBe(true);
    expect(activeAssistantClarificationIsSkillStudioRevisionForTest(
      [assistant],
      {
        type: "assistant.clarification.request",
        bridge_key: "other",
      },
    )).toBe(false);
  });

  it("uses the latest pending Skill Studio question in arrival order", () => {
    const assistant = message("assistant-skill-question-sequence", "assistant", "", 100);
    assistant.turnId = "turn-skill-sequence";
    assistant.uiEvents = [
      {
        type: "skill_studio.questions",
        bridge_key: "skill-question-old",
        questions: [{ id: "old_question", title: "Old question", options: [{ id: "old", label: "Old" }] }],
      },
      {
        type: "skill_studio.questions",
        bridge_key: "skill-question-new",
        questions: [{ id: "new_question", title: "New question", options: [{ id: "new", label: "New" }] }],
      },
    ];

    expect(latestPendingSkillStudioQuestionEventForTest([assistant])?.bridge_key).toBe("skill-question-new");
  });

  it("does not surface ended-turn pending clarification as the active composer prompt", () => {
    const endedAssistant = message("assistant-ended-clarification", "assistant", "", 100, "turn-ended");
    endedAssistant.uiEvents = [
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-ended",
        title: "History question",
        questions: [{ id: "history_question", title: "History question", options: [{ id: "old", label: "Old" }] }],
      },
    ];

    expect(latestPendingAssistantClarificationEventForActiveTurnForTest(
      [endedAssistant],
      { busy: false, activeTurnId: null },
    )).toBeNull();
    expect(latestPendingAssistantClarificationEventForActiveTurnForTest(
      [endedAssistant],
      { busy: true, activeTurnId: "turn-live" },
    )).toBeNull();
    expect(latestPendingAssistantClarificationEventForActiveTurnForTest(
      [endedAssistant],
      { busy: true, activeTurnId: "turn-ended" },
    )?.bridge_key).toBe("clarify-ended");
  });

  it("does not surface ended-turn pending Skill Studio questions as the active composer prompt", () => {
    const endedAssistant = message("assistant-ended-skill-question", "assistant", "", 100, "turn-ended");
    endedAssistant.uiEvents = [
      {
        type: "skill_studio.questions",
        bridge_key: "skill-question-ended",
        questions: [{ id: "history_question", title: "History question", options: [{ id: "old", label: "Old" }] }],
      },
    ];

    expect(latestPendingSkillStudioQuestionEventForActiveTurnForTest(
      [endedAssistant],
      { busy: false, activeTurnId: null },
    )).toBeNull();
    expect(latestPendingSkillStudioQuestionEventForActiveTurnForTest(
      [endedAssistant],
      { busy: true, activeTurnId: "turn-live" },
    )).toBeNull();
    expect(latestPendingSkillStudioQuestionEventForActiveTurnForTest(
      [endedAssistant],
      { busy: true, activeTurnId: "turn-ended" },
    )?.bridge_key).toBe("skill-question-ended");
  });

  it("uses bridge scoped identities for active composer question cards", () => {
    expect(assistantClarificationEventIdentityForTest({
      type: "assistant.clarification.request",
      bridge_key: "clarify-a",
      title: "Same-name question",
    })).toBe("clarify-a");
    expect(assistantClarificationEventIdentityForTest({
      type: "assistant.clarification.request",
      bridge_key: "clarify-b",
      title: "Same-name question",
    })).toBe("clarify-b");
    expect(skillStudioQuestionEventIdentityForTest({
      type: "skill_studio.questions",
      bridge_key: "skill-question-a",
      skill_studio_session_id: "studio-1",
      title: "Same-name question",
    })).toBe("skill-question-a");
  });

  it("builds a chat message from selected card options", () => {
    const text = buildSkillStudioQuestionResponseForTest(
      {
        type: "skill_studio.questions",
        skill_studio_session_id: "skill_studio_01",
        title: "Create promotional poster Skill",
        questions: [
          {
            id: "audience",
            title: "What is the core use case?",
            options: [
              { id: "social", label: "For posting on social media platforms", description: "Xiaohongshu/Douyin etc." },
            ],
          },
          {
            id: "style",
            title: "What is the preferred visual style?",
            options: [
              { id: "ink", label: "Ink-wash Chinese style / new Chinese style" },
              { id: "modern", label: "Modern minimalist / infographic style" },
            ],
          },
        ],
      },
      { audience: "social", style: "modern" },
    );

    expect(text).toContain("Skill Studio session: skill_studio_01");
    expect(text).toContain("Create promotional poster Skill");
    expect(text).toContain("What is the core use case?: For posting on social media platforms (Xiaohongshu/Douyin etc.)");
    expect(text).toContain("What is the preferred visual style?: Modern minimalist / infographic style");
    expect(text).toContain("The user has finished selecting; continue with the current context.");
    expect(text).not.toContain("Continue generating the Skill / Recipe draft");
  });

  it("builds a persisted submitted assistant clarification event", () => {
    const event = {
      type: "assistant.clarification.request" as const,
      bridge_key: "clarify-key-1",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      anchor_text_prefix: "Confirm the direction first",
      clarification_id: "home-culture-poster-skill-setup",
      title: "Hometown culture poster Skill settings",
      description: "Generate the draft after selecting",
      questions: [
        {
          id: "poster_count",
          title: "Poster count",
          options: [{ id: "single", label: "Single key visual poster" }],
        },
      ],
      allow_skip: true,
    };

    expect(buildPersistedAssistantClarificationEventForTest(event, {
      action: "submit",
      answers: { poster_count: "single" },
      clarificationStatus: "answered",
      skipped: false,
      usedRecommended: false,
      receivedAt: 123,
    })).toMatchObject({
      type: "assistant.clarification.request",
      bridge_key: "clarify-key-1",
      clarification_id: "home-culture-poster-skill-setup",
      received_at: 123,
      submitted: true,
      action: "submit",
      clarification_status: "answered",
      answers: { poster_count: "single" },
      skipped: false,
      used_recommended: false,
      questions: event.questions,
    });
  });

  it("keeps unanswered questions visible when partially submitted", () => {
    const text = buildSkillStudioQuestionResponseForTest(
      {
        type: "skill_studio.questions",
        skill_studio_session_id: "skill_studio_01",
        questions: [
          {
            id: "audience",
            title: "What is the core use case?",
            options: [{ id: "social", label: "For posting on social media platforms" }],
          },
          {
            id: "style",
            title: "What is the preferred visual style?",
            options: [{ id: "modern", label: "Modern minimalist / infographic style" }],
          },
        ],
      },
      { audience: "social" },
    );

    expect(text).toContain("What is the core use case?: For posting on social media platforms");
    expect(text).toContain("What is the preferred visual style?: Not selected");
  });

  it("describes multiple options and custom text in question answers", () => {
    const text = buildSkillStudioQuestionResponseForTest(
      {
        type: "skill_studio.questions",
        skill_studio_session_id: "skill_studio_multi",
        questions: [
          {
            id: "elements",
            title: "Which content elements does a poster usually need?",
            selection_mode: "multiple",
            options: [
              { id: "intro", label: "Hometown name and introduction" },
              { id: "feature", label: "Featured image / illustration" },
              { id: "slogan", label: "Promotional slogan" },
            ],
          },
        ],
      },
      {
        elements: {
          option_ids: ["intro", "feature"],
          custom_text: "Add an interactive topic suited to social media sharing",
        },
      },
    );

    expect(text).toContain("Which content elements does a poster usually need?: Hometown name and introduction; Featured image / illustration; Additional: Add an interactive topic suited to social media sharing");
  });

  it("builds compact timeline items for submitted question cards", () => {
    const items = buildSkillStudioQuestionTimelineItemsForTest(
      [
        {
          id: "audience",
          title: "Who is the target audience?",
          options: [{ id: "travelers", label: "Out-of-town tourists", description: "Potential travelers" }],
        },
        {
          id: "elements",
          title: "Which content should be highlighted?",
          selection_mode: "multiple",
          options: [
            { id: "food", label: "Local cuisine" },
            { id: "heritage", label: "Intangible cultural heritage" },
          ],
        },
        {
          id: "extra",
          title: "Other additions",
          options: [],
        },
      ],
      {
        audience: "travelers",
        elements: {
          option_ids: ["food", "heritage"],
          custom_text: "Highlight Suzhou Taohuawu New Year prints",
        },
      },
    );

    expect(items).toEqual([
      {
        key: "audience",
        title: "Who is the target audience?",
        summary: "Out-of-town tourists (Potential travelers)",
        answered: true,
      },
      {
        key: "elements",
        title: "Which content should be highlighted?",
        summary: "Local cuisine; Intangible cultural heritage; Additional: Highlight Suzhou Taohuawu New Year prints",
        answered: true,
      },
      {
        key: "extra",
        title: "Other additions",
        summary: "Not selected",
        answered: false,
      },
    ]);
  });

  it("shows question text when a submitted question has no title", () => {
    const items = buildSkillStudioQuestionTimelineItemsForTest(
      [
        {
          id: "video_duration_seconds",
          question: "How long should the video be?",
          options: [{ id: "6", label: "6" }],
        },
      ],
      { video_duration_seconds: "6" },
    );

    expect(items[0]?.title).toBe("How long should the video be?");
  });

  it("preserves submitted skip status in compact question cards", () => {
    const items = buildSkillStudioQuestionTimelineItemsForTest(
      [
        {
          id: "confirm",
          title: "Draft confirmation",
          options: [{ id: "needs_edit", label: "Needs adjusting" }],
        },
      ],
      {},
      "skip",
    );

    expect(items).toEqual([
      {
        key: "confirm",
        title: "Draft confirmation",
        summary: "Skipped",
        answered: true,
      },
    ]);
  });

  it("hides unanswered fields from submitted clarification summaries", () => {
    const items = visibleAssistantClarificationTimelineItemsForTest(
      [
        {
          id: "image_model",
          title: "Image model",
          options: [{ id: "newapi_nanobanana2", label: "LingShan NB 2" }],
        },
        {
          id: "image_quality",
          title: "Image quality",
          options: [
            { id: "low", label: "Low quality" },
            { id: "medium", label: "Standard quality" },
            { id: "high", label: "High quality" },
          ],
        },
      ],
      { image_model: { option_ids: ["newapi_nanobanana2"] } },
    );

    expect(items).toEqual([
      {
        key: "image_model",
        title: "Image model",
        summary: "LingShan NB 2",
        answered: true,
      },
    ]);
  });

  it("shows question text in submitted clarification summaries when title is missing", () => {
    const items = visibleAssistantClarificationTimelineItemsForTest(
      [{
        id: "video_duration_seconds",
        question: "How long should the video be?",
        options: [{ id: "6", label: "6 seconds" }],
      }],
      { video_duration_seconds: "6" },
    );

    expect(items[0]?.title).toBe("How long should the video be?");
  });

  it("keeps submitted option ids visible when dynamic labels are unavailable", () => {
    const items = visibleAssistantClarificationTimelineItemsForTest(
      [{ id: "image_resolution", title: "Image resolution", options: [] }],
      { image_resolution: { option_ids: ["1K"] } },
    );

    expect(items).toEqual([
      {
        key: "image_resolution",
        title: "Image resolution",
        summary: "1K",
        answered: true,
      },
    ]);
  });

  it("builds a bridge tool result payload instead of a new chat message", () => {
    const payload = buildSkillStudioQuestionToolResultForTest(
      {
        type: "skill_studio.questions",
        bridge_key: "skill-key-1",
        project_id: "project-a",
        canvas_id: "canvas-a",
        agent_id: "agent-1",
        turn_id: "turn-a",
        skill_studio_session_id: "skill_studio_01",
        questions: [
          {
            id: "scope",
            title: "What is it mainly for?",
            options: [{ id: "planning", label: "Planning" }],
          },
        ],
      },
      { scope: "planning" },
    );

    expect(payload).toMatchObject({
      bridge_key: "skill-key-1",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      tool_call_status: "completed",
      skill_studio_status: "answered",
      action: "submit",
      selections: { scope: "planning" },
      ok: true,
    });
    expect(payload.message).toContain("What is it mainly for?: Planning");
  });

  it("summarizes canvas command failures without exposing protocol details to users", () => {
    const payload = buildCanvasCommandToolResultPayloadForTest({
      bridgeKey: "bridge-a",
      projectId: "project-a",
      canvasId: "canvas-a",
      result: {
        applied: 0,
        openedUiActions: 0,
        createdNodeIds: [],
        errors: [
          "envelopes[0].commands[0]: edge output role planning_text is not accepted by target imageGenNode for link_type prompt_for. Expected source role input_text.",
        ],
        commandResults: [
          {
            commandIndex: -1,
            type: "validate",
            status: "error",
            label: "Validate canvas command",
            error:
              "edge output role planning_text is not accepted by target imageGenNode for link_type prompt_for. Expected source role input_text.",
          },
        ],
      },
    });

    expect(payload.user_message).toBe("The text must first be connected to the image node as a generation prompt; I'll handle it using an executable prompt source.");
    expect(payload.agent_hint).toContain("Do not mention");
    expect(payload.agent_hint).toContain("prompt_for");
    expect(payload.message).toBe(payload.user_message);
    expect(payload.errors.join("\n")).toContain("planning_text");
    expect(payload.user_message).not.toContain("planning_text");
    expect(payload.user_message).not.toContain("input_text");
    expect(payload.user_message).not.toContain("prompt_for");
  });

  it("marks a workflow persistence failure as failed even after parameter updates applied", () => {
    const persistenceError = "Unable to create the persistent workflow record; the node action was not started: database unavailable";
    const payload = buildCanvasCommandToolResultPayloadForTest({
      bridgeKey: "bridge-workflow-persistence",
      projectId: "project-a",
      canvasId: "canvas-a",
      result: {
        applied: 4,
        openedUiActions: 0,
        createdNodeIds: [],
        errors: [persistenceError],
        commandResults: [
          { commandIndex: 0, type: "update_node_data", status: "success", label: "Update image parameters" },
          { commandIndex: 1, type: "update_node_data", status: "success", label: "Update video parameters" },
          { commandIndex: 2, type: "update_node_data", status: "success", label: "Update review parameters" },
          { commandIndex: 3, type: "run_workflow", status: "success", label: "Run workflow" },
          {
            commandIndex: 3,
            type: "run_node_action",
            status: "error",
            label: "Generate image",
            nodeId: "image-a",
            action: "generate_image",
            error: persistenceError,
          },
        ],
      },
    });

    expect(payload).toMatchObject({
      tool_call_status: "failed",
      canvas_apply_status: "failed",
      applied: false,
      applied_count: 4,
      errors: [persistenceError],
    });
  });

  it("keeps non-workflow partial command batches distinguishable from terminal workflow failure", () => {
    const payload = buildCanvasCommandToolResultPayloadForTest({
      bridgeKey: "bridge-partial-edit",
      result: {
        applied: 1,
        openedUiActions: 0,
        createdNodeIds: [],
        errors: ["The second node does not exist"],
        commandResults: [
          { commandIndex: 0, type: "update_node_data", status: "success", label: "Update node" },
          { commandIndex: 1, type: "update_node_data", status: "error", label: "Update node", error: "The second node does not exist" },
        ],
      },
    });

    expect(payload).toMatchObject({
      tool_call_status: "completed",
      canvas_apply_status: "partially_applied",
      applied: true,
      applied_count: 1,
    });
  });

  it("keeps structured multiple-choice answers in bridge payload", () => {
    const payload = buildSkillStudioQuestionToolResultForTest(
      {
        type: "skill_studio.questions",
        bridge_key: "skill-key-2",
        questions: [
          {
            id: "content",
            title: "Content elements?",
            selection_mode: "multiple",
            options: [
              { id: "photo", label: "Featured image" },
              { id: "qr", label: "QR code / Logo" },
            ],
          },
        ],
      },
      {
        content: {
          option_ids: ["photo", "qr"],
          custom_text: "Leave room for a main title",
        },
      },
    );

    expect(payload.selections).toEqual({
      content: {
        option_ids: ["photo", "qr"],
        custom_text: "Leave room for a main title",
      },
    });
    expect(payload.message).toContain("Content elements?: Featured image; QR code / Logo; Additional: Leave room for a main title");
  });
});

describe("Assistant clarification response", () => {
  it("uses question text in answers when the title is missing", () => {
    const text = buildAssistantClarificationResponseForTest(
      {
        type: "assistant.clarification.request",
        questions: [{
          id: "video_duration_seconds",
          question: "How long should the video be?",
          options: [{ id: "6", label: "6 seconds" }],
        }],
      },
      { video_duration_seconds: "6" },
    );

    expect(text).toContain("How long should the video be?\n6 seconds");
  });

  it("builds a reusable clarification summary from selected answers", () => {
    const text = buildAssistantClarificationResponseForTest(
      {
        type: "assistant.clarification.request",
        clarification_id: "clarify_01",
        title: "Ask the user",
        questions: [
          {
            id: "skill_kind",
            title: "What is the skill you want to create for?",
            options: [
              { id: "workflow", label: "Workflow automation" },
              { id: "domain", label: "Domain knowledge" },
            ],
          },
          {
            id: "scope",
            title: "What is the scope of this skill?",
            options: [
              { id: "user", label: "User level (recommended)" },
              { id: "project", label: "Project level" },
            ],
          },
        ],
      },
      {
        skill_kind: { option_ids: ["workflow"], custom_text: "For poster generation" },
        scope: { option_ids: ["user"], custom_text: "" },
      },
    );

    expect(text).toContain("What is the skill you want to create for?\nWorkflow automation; Additional: For poster generation");
    expect(text).toContain("What is the scope of this skill?\nUser level (recommended)");
  });

  it("keeps clarification replies in the current project when tool metadata omits scope", () => {
    const payload = buildAssistantClarificationToolResultForTest(
      { type: "assistant.clarification.request", clarification_id: "c", bridge_key: "key", questions: [] },
      {},
      { projectId: "project-a", canvasId: "canvas-a", agentId: "main" },
    );
    expect(payload).toMatchObject({project_id: "project-a", canvas_id: "canvas-a", agent_id: "main"});
  });

  it("builds a generic bridge tool result payload", () => {
    const payload = buildAssistantClarificationToolResultForTest(
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-key-1",
        project_id: "project-a",
        canvas_id: "canvas-a",
        agent_id: "agent-1",
        turn_id: "turn-a",
        anchor_text_prefix: "Let me ask a few questions first.",
        clarification_id: "clarify_01",
        questions: [
          {
            id: "skill_kind",
            title: "What is the skill you want to create for?",
            options: [{ id: "workflow", label: "Workflow automation" }],
          },
        ],
      },
      {
        skill_kind: { option_ids: ["workflow"], custom_text: "" },
      },
    );

    expect(payload).toMatchObject({
      bridge_key: "clarify-key-1",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      anchor_text_prefix: "Let me ask a few questions first.",
      tool_call_status: "completed",
      clarification_status: "answered",
      action: "submit",
      answers: {
        skill_kind: { option_ids: ["workflow"], custom_text: "" },
      },
      ok: true,
    });
    expect(payload.message).toContain("What is the skill you want to create for?");
    expect(payload.message).not.toContain("ask only one question at a time");
  });

  it("adds one-question guidance only for Skill Studio revision clarification results", () => {
    const payload = buildAssistantClarificationToolResultForTest(
      {
        type: "assistant.clarification.request",
        bridge_key: "clarify-key-revision",
        clarification_id: "revise_01",
        questions: [
          {
            id: "revision_focus",
            title: "Which direction do you want to adjust first?",
            options: [{ id: "style", label: "Style" }],
          },
        ],
      },
      {
        revision_focus: { option_ids: ["style"], custom_text: "" },
      },
      { skillStudioRevision: true },
    );

    expect(payload.message).toContain("Skill Studio draft revision flow");
    expect(payload.message).toContain("the next step must be to call freezone_request_user_clarification again");
    expect(payload.message).toContain("freezone_finish_agent_catalog_draft");
    expect(payload.message).toContain("Do not reply with plain text only");
    expect(payload.message).not.toContain("continue based on the information above");
  });
});

describe("Skill Studio status events", () => {
  it("marks assistant messages with a status event as Skill Studio UI", () => {
    expect(messageHasSkillStudioUiEventForTest({
      id: "assistant-turn-1",
      role: "assistant",
      text: "",
      timestamp: 10,
      turnId: "turn-1",
      uiEvents: [
        {
          type: "skill_studio.status",
          status: "routing",
          message: "Entering Skill Studio...",
        },
      ],
    })).toBe(true);
  });

  it("hides stale status once an interactive Skill Studio card is present", () => {
    expect(skillStudioEventsFromUiEventsForTest([
      {
        type: "skill_studio.status",
        status: "routing",
        message: "Entering Skill Studio...",
      },
      {
        type: "skill_studio.questions",
        skill_studio_session_id: "skill_studio_01",
        questions: [],
      },
    ]).map((event) => event.type)).toEqual(["skill_studio.questions"]);
  });

  it("shows real chunked progress after a submitted Skill Studio card", () => {
    expect(skillStudioEventsFromUiEventsForTest([
      {
        type: "skill_studio.questions",
        skill_studio_session_id: "skill_studio_01",
        submitted: true,
        questions: [],
      },
      {
        type: "skill_studio.status",
        status: "draft_begin",
        message: "Creating the draft structure...",
      },
    ]).map((event) => event.type)).toEqual(["skill_studio.questions", "skill_studio.status"]);
  });

  it("keeps only the latest Skill Studio status update before the draft arrives", () => {
    const events = skillStudioEventsFromUiEventsForTest([
      {
        type: "skill_studio.status",
        status: "routing",
        message: "Organizing the Skill direction...",
      },
      {
        type: "skill_studio.status",
        status: "drafting",
        message: "Generating the Skill draft...",
      },
      {
        type: "skill_studio.status",
        status: "finalizing",
        message: "The draft is fairly complete; filling in Recipes and validation items...",
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "skill_studio.status",
      status: "finalizing",
      message: "The draft is fairly complete; filling in Recipes and validation items...",
    });
  });

  it("keeps real chunked draft progress ahead of later timer status", () => {
    const events = skillStudioEventsFromUiEventsForTest([
      {
        type: "skill_studio.status",
        status: "draft_recipe_ready",
        message: "Recipe 1 / 6 generated",
      },
      {
        type: "skill_studio.status",
        status: "finalizing",
        message: "The draft is fairly complete; filling in Recipes and validation items...",
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "skill_studio.status",
      status: "draft_recipe_ready",
      message: "Recipe 1 / 6 generated",
    });
  });

  it("merges repeated Skill Studio question events into the latest state", () => {
    const events = skillStudioEventsFromUiEventsForTest([
      {
        type: "skill_studio.questions",
        bridge_key: "skill-key-1",
        skill_studio_session_id: "studio-1",
        questions: [],
      },
      {
        type: "skill_studio.questions",
        bridge_key: "skill-key-1",
        skill_studio_session_id: "studio-1",
        submitted: true,
        action: "submit",
        selections: { audience: "locals" },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "skill_studio.questions",
      bridge_key: "skill-key-1",
      submitted: true,
      selections: { audience: "locals" },
    });
  });

  it("does not match different Skill Studio question cards only because they share a session", () => {
    const initialQuestion = {
      type: "skill_studio.questions" as const,
      bridge_key: "initial-question-key",
      skill_studio_session_id: "studio-1",
      questions: [],
    };
    const revisionQuestion = {
      type: "skill_studio.questions" as const,
      bridge_key: "revision-question-key",
      skill_studio_session_id: "studio-1",
      questions: [],
    };

    expect(skillStudioEventMatchesForTest(initialQuestion, revisionQuestion)).toBe(false);
    expect(skillStudioEventMatchesForTest(revisionQuestion, revisionQuestion)).toBe(true);
  });

  it("merges repeated Skill Studio draft events into the latest draft state", () => {
    const events = skillStudioEventsFromUiEventsForTest([
      {
        type: "skill_studio.draft",
        bridge_key: "draft-key-1",
        skill_studio_session_id: "studio-1",
        skill: { id: "original-skill" },
      },
      {
        type: "skill_studio.draft",
        bridge_key: "draft-key-1",
        skill_studio_session_id: "studio-1",
        draft: { skill: { id: "edited-skill" }, recipes: [] },
      },
      {
        type: "skill_studio.draft",
        bridge_key: "draft-key-1",
        skill_studio_session_id: "studio-1",
        submitted: true,
        draft: { skill: { id: "submitted-skill" }, recipes: [] },
      },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "skill_studio.draft",
      bridge_key: "draft-key-1",
      submitted: true,
      draft: { skill: { id: "submitted-skill" } },
    });
  });

  it("hides routing status once assistant prose has started", () => {
    expect(visibleSkillStudioEventsForMessageForTest({
      id: "assistant-turn-1",
      role: "assistant",
      text: "I am looking at the available Skills.",
      timestamp: 10,
      turnId: "turn-1",
      uiEvents: [
        {
          type: "skill_studio.status",
          status: "routing",
          message: "Entering Skill Studio...",
        },
      ],
    }).map((event) => event.type)).toEqual([]);
  });

  it("keeps submitted Skill Studio progress status once assistant prose has started", () => {
    expect(visibleSkillStudioEventsForMessageForTest({
      id: "assistant-turn-1",
      role: "assistant",
      text: "Okay, I will build the Skill draft.",
      timestamp: 10,
      turnId: "turn-1",
      uiEvents: [
        {
          type: "assistant.clarification.request",
          bridge_key: "clarify-key-1",
          submitted: true,
          action: "submit",
          questions: [],
          answers: {},
        },
        {
          type: "skill_studio.status",
          status: "draft_begin",
          message: "Creating the draft structure...",
        },
      ],
    }).map((event) => event.type)).toEqual(["skill_studio.status"]);
  });

  it("keeps submitted Skill Studio progress parts once assistant prose has started", () => {
    const assistant = message(
      "assistant-turn-1",
      "assistant",
      "Okay, a general brand ad short film flow + 5 fine-grained Recipes. I will build the Skill draft.",
      10,
      "turn-1",
    );
    assistant.parts = [
      {
        id: "clarification:clarify-key-1",
        type: "clarification",
        event: {
          type: "assistant.clarification.request",
          bridge_key: "clarify-key-1",
          submitted: true,
          action: "submit",
          questions: [],
          answers: {},
        },
      },
      {
        id: "skill_studio.status",
        type: "skill_studio",
        event: {
          type: "skill_studio.status",
          status: "draft_begin",
          message: "Creating the draft structure...",
        },
      },
    ];
    assistant.uiEvents = assistant.parts.flatMap((part) => part.type === "text" ? [] : [part.event]);

    expect(visibleAssistantOrderedPartsForMessageForTest(assistant).map((part) => part.type)).toEqual([
      "clarification",
      "skill_studio",
    ]);
  });

  it("hides routing status once an assistant clarification card is visible", () => {
    expect(visibleSkillStudioEventsForMessageForTest({
      id: "assistant-turn-1",
      role: "assistant",
      text: "",
      timestamp: 10,
      turnId: "turn-1",
      uiEvents: [
        {
          type: "skill_studio.status",
          status: "routing",
          message: "Entering Skill Studio...",
        },
        {
          type: "assistant.clarification.request",
          bridge_key: "clarify-key-1",
          title: "Hometown culture short film Skill configuration",
          submitted: true,
          action: "submit",
          questions: [],
          answers: {},
        },
      ],
    }).map((event) => event.type)).toEqual([]);
  });

  it("hides status-only Skill Studio messages once the same turn has a submitted card", () => {
    const statusOnly = message("assistant-status", "assistant", "", 10, "turn-1");
    statusOnly.uiEvents = [
      {
        type: "skill_studio.status",
        status: "routing",
        message: "Entering Skill Studio...",
      },
    ];

    expect(shouldHideSkillStudioStatusOnlyMessageForTest(statusOnly, new Set(["turn-1"]))).toBe(true);
    expect(shouldHideSkillStudioStatusOnlyMessageForTest(statusOnly, new Set(["turn-2"]))).toBe(false);
  });

  it("hides canvas context reads once a Skill Studio card is available", () => {
    const assistant = message("assistant-turn-1", "assistant", "", 10, "turn-1");
    assistant.uiEvents = [
      {
        type: "skill_studio.draft",
        skill_studio_session_id: "studio-1",
        draft: { skill: { id: "home-culture" }, recipes: [] },
      },
    ];

    const visible = visibleCanvasContextActivitiesForMessageForTest(assistant, [
      {
        key: "context:node-params",
        turnId: "turn-1",
        bridgeKey: "node-params",
        status: "done",
        labels: ["Node parameters"],
        errors: [],
      },
      {
        key: "context:validate",
        turnId: "turn-1",
        bridgeKey: "validate",
        status: "done",
        labels: ["Command validation"],
        errors: [],
      },
    ]);

    expect(visible.map((activity) => activity.key)).toEqual(["context:validate"]);
  });
});

describe("Skill Studio draft response", () => {
  it("uses the same Chinese field names as the catalog edit pages", () => {
    expect(skillStudioDraftFieldLabelsForTest.skill).toMatchObject({
      keywords: "Trigger keywords",
      node_scopes: "Node types",
      metaPlanningHints: "Planner hints",
      promptStyleGuide: "Style guide",
      behaviorRules: "Behavior rules",
      passingScore: "Passing score",
      domainRules: "Domain rules",
      ratingBands: "Rating bands",
      visualReviewItems: "Visual review items",
      textReviewItems: "Copy review items",
    });
    expect(skillStudioDraftFieldLabelsForTest.recipe).toMatchObject({
      output_kind: "Output type",
      action_keys: "Action types",
      system_prompt: "System Prompt",
      must_have_items: "Required elements",
      planning_prompt: "Planner prompt",
      result_summary: "Output summary",
      requires_source_media: "Requires upstream multimodal input",
      enabled: "Enabled",
      force_enhancement: "Force enhancement",
      skip_detail_check: "Skip detail check",
    });
    const legacyRecipeKeys = [
      "required" + "_elements",
      "planner" + "_cue",
      "output" + "_summary",
      "needs" + "_multimodal_input",
    ];
    for (const legacyKey of legacyRecipeKeys) {
      expect(skillStudioDraftFieldLabelsForTest.recipe).not.toHaveProperty(legacyKey);
    }
  });

  it("maps canonical evaluation fields for draft display", () => {
    const fields = skillStudioEvaluationDraftFieldsForTest({
      quality_threshold: 7,
      domain_constraints: ["Must be vertical 9:16"],
      rating_bands: [
        { score: 8, description: "Consistent style and accurate expression of cultural elements" },
      ],
      visual_review_items: [
        { name: "Style consistency", weight: 0.35, description: "Does it match the guochao visual style" },
      ],
      text_review_items: [
        { name: "Copy shareability", weight: 0.4, description: "Is the headline memorable" },
      ],
      passingScore: 5,
      domainRules: ["Old field must not be shown"],
      scoreAnchors: [{ score: 10, description: "Old field must not be shown" }],
      visual: {
        dimensions: [{ name: "Old visual field", weight: 1, description: "Must not be shown" }],
      },
      text: {
        dimensions: [{ name: "Old copy field", weight: 1, description: "Must not be shown" }],
      },
    });

    expect(fields).toEqual({
      qualityThreshold: 7,
      domainConstraints: ["Must be vertical 9:16"],
      ratingBands: ["8: Consistent style and accurate expression of cultural elements"],
      visualReviewItems: ["Style consistency (0.35): Does it match the guochao visual style"],
      textReviewItems: ["Copy shareability (0.4): Is the headline memorable"],
    });
  });

  it("builds a bridge tool result with the edited draft payload", () => {
    const event = {
      type: "skill_studio.draft" as const,
      bridge_key: "skill-key-2",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      skill_studio_session_id: "skill_studio_01",
      summary: "Draft summary",
      skill: {
        id: "home-culture-poster",
        name: "Hometown culture poster",
        schema_version: 1,
        version: "1.0.0",
        description: "Hometown culture poster",
        category: "social",
        allowed_recipe_ids: ["home-culture-poster-image"],
        planning: {
          metaPlanningHints: "Identify regional symbols first",
        },
      },
      recipes: [
        {
          id: "home-culture-poster-image",
          name: "Hometown culture poster rendering",
          output_kind: "image",
          system_prompt: "Generate poster",
          must_have_items: ["Regional symbols"],
        },
      ],
    };

    const payload = buildSkillStudioDraftToolResultForTest(event, {
      skill: event.skill,
      recipes: event.recipes,
      summary: event.summary,
    });

    expect(payload).toMatchObject({
      bridge_key: "skill-key-2",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      action: "confirm_add",
      skill_studio_status: "catalog_saved",
      saved_to_catalog: true,
      saved_skill_ids: ["home-culture-poster"],
      saved_recipe_ids: ["home-culture-poster-image"],
      draft: {
        skill: {
          id: "home-culture-poster",
          planning: {
            metaPlanningHints: "Identify regional symbols first",
          },
        },
        recipes: [
          {
            id: "home-culture-poster-image",
            must_have_items: ["Regional symbols"],
          },
        ],
      },
    });
    expect(payload.message).toContain("home-culture-poster");
    expect(payload.message).toContain("saved as an official Skill / Recipe");
  });

  it("normalizes Skill Studio draft input parameters before catalog save", () => {
    const draft = normalizeSkillStudioDraftForCatalogForTest({
      skill: {
        id: "pixar-ip-brand-short-video",
        input_parameters: [
          {
            id: "aspect_ratio",
            label: "Aspect ratio",
            type: "single_select",
            required: false,
            default: "16:9",
            placeholder: "Do not save this display field",
            options: ["16:9 landscape", "9:16 portrait"],
          },
          {
            id: "shot_count",
            label: "Shot count",
            type: "number",
            required: false,
            default: 6,
            options: [4, 6, 8, 9],
          },
        ],
      },
      recipes: [],
    });

    expect(draft.skill).toMatchObject({
      input_parameters: [
        {
          id: "aspect_ratio",
          label: "Aspect ratio",
          type: "single_select",
          required: false,
          default: "16:9 landscape",
          options: ["16:9 landscape", "9:16 portrait"],
        },
        {
          id: "shot_count",
          label: "Shot count",
          type: "number",
          required: false,
          default: 6,
          options: ["4", "6", "8", "9"],
        },
      ],
    });
    expect(JSON.stringify(draft)).not.toContain("placeholder");
  });

  it("builds a bridge tool result when the draft is cancelled", () => {
    const event = {
      type: "skill_studio.draft" as const,
      bridge_key: "skill-key-2",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      skill_studio_session_id: "skill_studio_01",
      draft: { skill: { id: "home-culture-poster" }, recipes: [] },
    };

    const payload = buildSkillStudioDraftCancelToolResultForTest(event);

    expect(payload).toMatchObject({
      bridge_key: "skill-key-2",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      action: "cancel",
      skill_studio_status: "catalog_cancelled",
      cancelled: true,
      draft: null,
      saved_to_catalog: false,
      saved_skill_ids: [],
      saved_recipe_ids: [],
    });
    expect(payload.message).toContain("The user cancelled saving the Skill Studio draft");
    expect(payload.message).toContain("This draft will not be written to the Shrimp Canvas configuration");
    expect(payload.message).toContain("do not resubmit");
    expect(payload.agent_instruction).toContain("Do not resubmit");
    expect(payload.agent_instruction).toContain("Do not call any Skill Studio");
    expect(payload.message).not.toContain("keep replying");
  });

  it("builds a bridge tool result to start a Skill Studio draft revision session", () => {
    const event = {
      type: "skill_studio.draft" as const,
      bridge_key: "skill-key-3",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      skill_studio_session_id: "skill_studio_01",
      draft: { skill: { id: "home-culture-poster" }, recipes: [] },
    };
    const draft = {
      skill: {
        id: "home-culture-poster",
        description: "Draft after manual editing by the user",
      },
      recipes: [],
      summary: "Current draft",
    };

    const payload = buildSkillStudioDraftRevisionToolResultForTest(event, draft);

    expect(payload).toMatchObject({
      bridge_key: "skill-key-3",
      project_id: "project-a",
      canvas_id: "canvas-a",
      agent_id: "agent-1",
      turn_id: "turn-a",
      action: "start_revision",
      skill_studio_status: "revision_started",
      saved_to_catalog: false,
      draft: {
        skill: {
          id: "home-culture-poster",
          description: "Draft after manual editing by the user",
        },
        recipes: [],
        summary: "Current draft",
      },
      draft_ref: {
        skill_studio_session_id: "skill_studio_01",
        skill_id: "home-culture-poster",
        skill_name: null,
        summary: "Current draft",
        recipe_count: 0,
      },
    });
    expect(payload.message).toContain("started a Skill Studio draft revision session");
    expect(payload.message).toContain("This receipt provides the full current draft");
    expect(payload.message).toContain("the draft is only for understanding the object being modified and for later partial patches");
    expect(payload.message).toContain("The user has explicitly said the current draft needs adjusting");
    expect(payload.message).toContain("do not ask again whether adjustments are needed");
    expect(payload.message).toContain("Do not ask whether to save the current version");
    expect(payload.message).toContain("save_now");
    expect(payload.message).toContain("This is not about continuing to finish the original draft");
    expect(payload.message).toContain("the next step must call freezone_request_user_clarification");
    expect(payload.message).toContain("must contain exactly one question");
    expect(payload.message).toContain("Before the user answers the direction of change, do not call freezone_begin_agent_catalog_draft");
    expect(payload.message).toContain("freezone_begin_agent_catalog_draft");
    expect(payload.message).toContain("freezone_finish_agent_catalog_draft");
    expect(payload.message).toContain("Do not call freezone_finish_agent_catalog_draft to show the current draft unchanged");
    expect(payload.message).toContain("Do not pass the full Skill / Recipe catalog in a single tool_call");
    expect(payload.message).toContain("Do not summarize the modification result in plain text");
  });

  it("shows the draft as AI adjusting while a revision session is pending", () => {
    expect(skillStudioDraftFooterTextForTest({
      submitted: false,
      cancelled: false,
      revisionPending: true,
    })).toBe("AI is adjusting; add the direction of change in the follow-up questions");
  });

  it("preserves HTML webpage deliverables when saving an imported Skill Studio recipe", () => {
    const recipe = {id:"campaign-page",name:"Campaign page",output_kind:"text",output_format:"html",action_keys:["campaign-page"],system_prompt:"Create a complete page",planning_prompt:"Use campaign assets",result_summary:"A finished webpage"};
    const normalized = normalizeSkillStudioDraftForCatalogForTest({recipes:[recipe]});
    const saved = buildSkillStudioCatalogSaveItemsForTest(normalized);
    expect(saved[0].payload).toMatchObject({output_kind:"text",output_format:"html"});
    const reimported = JSON.parse(JSON.stringify(saved[0].payload));
    expect(buildSkillStudioCatalogSaveItemsForTest({recipes:[reimported]})[0].payload).toMatchObject({output_kind:"text",output_format:"html"});
  });

  it("normalizes the draft into catalog payloads before saving", () => {
    const items = buildSkillStudioCatalogSaveItemsForTest({
      skill: {
        id: "home-culture-poster",
        name: "Hometown culture poster",
        schema_version: "dramaclaw.workflow-skill.v1",
        version: "1.0.0",
        description: "Hometown culture poster",
        category: "social",
        allowed_recipe_ids: ["home-culture-poster-image"],
        triggers: {
          keywords: ["Hometown culture"],
          node_scopes: ["imageGeneration"],
        },
        planning: {
          metaPlanningHints: "Identify regional symbols first",
          promptStyleGuide: "Ink-wash freehand",
          behaviorRules: ["Keep cultural accuracy"],
          default_aspect_ratios: {
            imageGeneration: "9:16",
            textGeneration: "1:1",
            videoGeneration: "auto",
          },
        },
        evaluation: {
          scoreAnchors: [{ score: 8, description: "Clear cultural symbols" }],
          passingScore: 7,
          domainRules: ["Do not mix regional symbols"],
          visual: {
            dimensions: [{ name: "Cultural recognizability", weight: 0.6, description: "Regional features are visible" }],
          },
          text: {
            dimensions: [{ name: "Copy clarity", weight: 0.4, description: "Concise copy" }],
          },
        },
      },
      recipes: [
        {
          id: "home-culture-poster-image",
          name: "Hometown culture poster rendering",
          output_kind: "image",
          action_keys: ["home-culture-poster-image"],
          system_prompt: "Generate poster",
          must_have_items: ["Regional symbols"],
          planning_prompt: "Generate a poster from regional symbols",
          result_summary: "One hometown culture poster",
          requires_source_media: true,
        },
      ],
    });

    expect(items).toEqual([
      expect.objectContaining({
        kind: "recipes",
        payload: expect.objectContaining({
          id: "home-culture-poster-image",
          output_kind: "image",
          action_keys: ["home-culture-poster-image"],
          system_prompt: "Generate poster",
          must_have_items: ["Regional symbols"],
          planning_prompt: "Generate a poster from regional symbols",
          result_summary: "One hometown culture poster",
          requires_source_media: true,
        }),
      }),
      expect.objectContaining({
        kind: "skills",
        payload: expect.objectContaining({
          id: "home-culture-poster",
          name: "Hometown culture poster",
          schema_version: "dramaclaw.workflow-skill.v1",
          version: "1.0.0",
          enabled: true,
          allowed_recipe_ids: ["home-culture-poster-image"],
          triggers: {
            keywords: ["Hometown culture"],
            node_scopes: ["imageGeneration"],
          },
          planning: expect.objectContaining({
            planning_notes: "Identify regional symbols first",
            prompt_guide: "Ink-wash freehand",
            conduct_rules: ["Keep cultural accuracy"],
          }),
          evaluation: expect.objectContaining({
            quality_threshold: 7,
            domain_constraints: ["Do not mix regional symbols"],
            rating_bands: [{ score: 8, description: "Clear cultural symbols" }],
            visual_review_items: [
              { name: "Cultural recognizability", weight: 0.6, description: "Regional features are visible" },
            ],
            text_review_items: [
              { name: "Copy clarity", weight: 0.4, description: "Concise copy" },
            ],
          }),
        }),
      }),
    ]);
    expect(items[1]?.payload.planning).not.toHaveProperty("default_aspect_ratios");
  });
});

describe("Canvas command approval image params", () => {
  it("replaces a shortened image-model clarification with the complete live catalog", () => {
    const questions = clarificationQuestionsWithLiveModelCatalogsForTest(
      [{
        id: "image_model",
        title: "Image model",
        options: [{ id: "seedream-4.5", label: "Seedream 4.5", description: "Fast" }],
      }],
      [
        { id: "newapi_gpt_image2", label: "LingShan G2", apiModel: "LingShan-G2" },
        { id: "seedream-catalog-id", label: "Seedream 4.5", apiModel: "seedream-4.5" },
      ],
      [],
    );

    expect(questions[0]?.options).toEqual([
      { id: "newapi_gpt_image2", label: "LingShan G2" },
      { id: "seedream-catalog-id", label: "Seedream 4.5", description: "Fast" },
    ]);
  });

  it("resolves a tool-declared video model source from the complete live catalog", () => {
    const questions = clarificationQuestionsWithLiveModelCatalogsForTest(
      [{
        id: "preferred_model",
        title: "Video model",
        options_source: "video_models",
        options: [{ id: "video-fast", label: "Fast model", description: "Speed first" }],
      }],
      [],
      [
        { id: "video-quality", label: "High-quality model", apiModel: "video-quality-v1" },
        { id: "video-fast", label: "Fast model", apiModel: "video-fast-v1" },
      ],
    );

    expect(questions[0]?.options).toEqual([
      { id: "video-quality", label: "High-quality model" },
      { id: "video-fast", label: "Fast model", description: "Speed first" },
    ]);
  });

  it("derives dependent generation options from the selected live model", () => {
    const questions = clarificationQuestionsWithLiveModelCatalogsForTest(
      [
        { id: "image_model", title: "Image model", options: [] },
        { id: "image_aspect_ratio", title: "Image aspect ratio", options: [{ id: "1:1", label: "1:1" }] },
        { id: "image_resolution", title: "Image resolution", options: [] },
        { id: "image_quality", title: "Image quality", options: [] },
        { id: "video_model", title: "Video model", options: [] },
        { id: "video_resolution", title: "Video resolution", options: [] },
        { id: "video_duration_seconds", title: "Video duration", options: [] },
        { id: "video_generate_audio", title: "Generate audio", options: [] },
      ],
      [{
        id: "image-a",
        label: "Image A",
        ratioOptions: ["1:1", "16:9"],
        resolutionOptions: ["1K", "2K"],
        qualityOptions: ["low", "medium", "high"],
      }],
      [{
        id: "video-a",
        label: "Video A",
        resolutionOptions: ["480P", "720P"],
        minDuration: 4,
        maxDuration: 6,
        supportsGenerateAudio: false,
      }],
      {
        image_model: { option_ids: ["image-a"] },
        video_model: { option_ids: ["video-a"] },
      },
    );

    expect(questions.find((question) => question.id === "image_aspect_ratio")?.options)
      .toEqual([{ id: "1:1", label: "1:1" }, { id: "16:9", label: "16:9" }]);
    expect(questions.find((question) => question.id === "image_resolution")?.options)
      .toEqual([{ id: "1K", label: "1K" }, { id: "2K", label: "2K" }]);
    expect(questions.find((question) => question.id === "image_quality")?.options)
      .toEqual([
        { id: "low", label: "low" },
        { id: "medium", label: "medium" },
        { id: "high", label: "high" },
      ]);
    expect(questions.find((question) => question.id === "video_resolution")?.options)
      .toEqual([{ id: "480P", label: "480P" }, { id: "720P", label: "720P" }]);
    expect(questions.find((question) => question.id === "video_duration_seconds")?.options)
      .toEqual([
        { id: "4", label: "4 seconds" },
        { id: "5", label: "5 seconds" },
        { id: "6", label: "6 seconds" },
      ]);
    expect(questions.find((question) => question.id === "video_generate_audio"))
      .toBeUndefined();
  });

  it("requires concrete generation answers before showing recommendation", () => {
    const questions = [
      { id: "image_model", title: "Image model", options: [{ id: "image-a", label: "Image A" }] },
      { id: "image_resolution", title: "Image resolution", options: [{ id: "1K", label: "1K" }] },
    ];

    expect(assistantClarificationCanSubmit(questions, {
      image_model: { option_ids: ["image-a"] },
    })).toBe(false);
    expect(assistantClarificationCanSubmit(questions, {
      image_model: { option_ids: ["image-a"] },
      image_resolution: { option_ids: ["1K"] },
    })).toBe(true);
    expect(assistantClarificationShowsRecommended(questions, true)).toBe(false);
    const recommendationEvent = {
      type: "assistant.clarification.request" as const,
      questions,
      recommended_answers: {
        image_model: { option_ids: ["image-a"] },
        image_resolution: { option_ids: ["1K"] },
      },
    };
    expect(assistantClarificationCanSubmitRecommended({ ...recommendationEvent, recommended_answers: {} }, {
      __action: "recommended",
    })).toBe(false);
    expect(assistantClarificationCanSubmitRecommended(recommendationEvent, {
      __action: "recommended",
      image_model: { option_ids: ["image-a"] },
    })).toBe(false);
    expect(assistantClarificationShowsRecommended(questions, true, {
      image_model: { option_ids: ["image-a"] },
      image_resolution: { option_ids: ["1K"] },
    })).toBe(true);
    expect(assistantClarificationShowsRecommended(questions, true, {
      image_model: { option_ids: ["stale-model"] },
      image_resolution: { option_ids: ["1K"] },
    })).toBe(false);
    const payload = buildAssistantClarificationToolResultForTest(
      { type: "assistant.clarification.request", questions },
      {
        __action: "recommended",
        image_model: { option_ids: ["image-a"] },
        image_resolution: { option_ids: ["1K"] },
      },
    );
    expect(payload.answers).toEqual({
      image_model: { option_ids: ["image-a"] },
      image_resolution: { option_ids: ["1K"] },
    });
    expect(assistantClarificationCanSubmitRecommended(recommendationEvent, {
      __action: "recommended",
      ...payload.answers,
    })).toBe(true);
    expect(assistantClarificationCanSubmitRecommended({
      ...recommendationEvent,
      questions: questions.map((question) => ({ ...question, options: [] })),
    }, { __action: "recommended", ...payload.answers })).toBe(true);
    expect(assistantClarificationShowsRecommended([
      { id: "creative_style", title: "Style", options: [{ id: "warm", label: "Warm" }] },
    ], true)).toBe(true);
  });

  it.each([
    ["loading", { models: [], isLoading: true, isFallback: false }],
    ["fallback", { models: [{ id: "fallback-model" }], isLoading: false, isFallback: true }],
    ["empty", { models: [], isLoading: false, isFallback: false }],
  ] as const)("blocks generation answers when the model catalog is %s", (issue, catalog) => {
    const rawQuestions = [
      { id: "image_model", title: "Image model", options: [{ id: "stale-model", label: "Old model" }] },
      { id: "image_resolution", title: "Image resolution", options: [{ id: "1K", label: "1K" }] },
      { id: "image_variants_per_node", title: "Generation count", options: [{ id: "1", label: "1" }] },
    ];
    const questions = clarificationQuestionsWithLiveModelCatalogsForTest(
      rawQuestions, [], [], {
        image_model: { custom_text: "unlisted-model" },
        image_variants_per_node: { option_ids: ["1"] },
      },
    );
    expect(assistantClarificationGenerationCatalogIssue(rawQuestions, catalog, {
      models: [], isLoading: false, isFallback: false,
    })).toBe(issue);
    expect(questions[0]).toMatchObject({ options: [], allow_custom: false });
    expect(questions[1]).toMatchObject({ options: [], allow_custom: false });
    expect(assistantClarificationCanSubmit(questions, {
      image_model: { custom_text: "unlisted-model" },
      image_variants_per_node: { option_ids: ["1"] },
    })).toBe(false);
  });

  it("requires a live option for every remaining generation question", () => {
    const questions = [
      { id: "image_model", title: "Image model", options: [{ id: "image-a", label: "Image A" }] },
      { id: "image_resolution", title: "Image resolution", options: [] },
      { id: "image_variants_per_node", title: "Generation count", options: [{ id: "1", label: "1" }] },
    ];
    expect(assistantClarificationCanSubmit(questions, {
      image_model: { option_ids: ["image-a"] },
      image_variants_per_node: { option_ids: ["1"] },
    })).toBe(false);
    expect(assistantClarificationCanSubmit([
      { ...questions[0], options: [{ id: "image-b", label: "Image B" }] },
    ], { image_model: { option_ids: ["image-a"] } })).toBe(false);
    expect(assistantClarificationGenerationCatalogIssue([
      { id: "preferred_model", title: "Video model", options_source: "video_models", options: [] },
    ], { models: [], isLoading: false, isFallback: false }, {
      models: [], isLoading: false, isFallback: false,
    })).toBe("empty");
  });

  it.each([
    ["loading", { models: [], isLoading: true, isFallback: false }],
    ["fallback", { models: [{ id: "fallback-model" }], isLoading: false, isFallback: true }],
    ["empty", { models: [], isLoading: false, isFallback: false }],
  ] as const)("explains %s catalogs on missing-field cards", (issue, catalog) => {
    for (const media of ["image", "video"] as const) {
      const dependentId = media === "image" ? "image_resolution" : "video_duration_seconds";
      const dependentSource = media === "image"
        ? "selected_image_model_resolutions" as const
        : "selected_video_model_durations" as const;
      const countId = media === "image" ? "image_variants_per_node" : "video_variants_per_node";
      const modelId = media === "image" ? "image_model" : "video_model";
      const rawQuestions = [
        { id: dependentId, title: "Missing parameter", options_source: dependentSource,
          options: [{ id: "stale-option", label: "Old option" }] },
        { id: countId, title: "Generation count", options: [{ id: "1", label: "1" }] },
      ];
      const answers = {
        [modelId]: { option_ids: ["previous-model"] },
        [dependentId]: { custom_text: "unsupported" },
        [countId]: { option_ids: ["1"] },
      };
      const questions = clarificationQuestionsWithLiveModelCatalogsForTest(
        rawQuestions, [], [], answers,
      );
      const healthy = { models: [{ id: "other-model" }], isLoading: false, isFallback: false };
      expect(assistantClarificationGenerationCatalogIssue(
        rawQuestions, media === "image" ? catalog : healthy,
        media === "video" ? catalog : healthy, answers,
      )).toBe(issue);
      expect(questions[0]).toMatchObject({ options: [], allow_custom: false });
      expect(assistantClarificationCanSubmit(questions, answers)).toBe(false);
    }
  });

  it("explains a missing preselected model on missing-field cards", () => {
    const imageCatalog = {
      models: [{ id: "current-image", resolutionOptions: ["2K"] }],
      isLoading: false, isFallback: false,
    };
    const videoCatalog = {
      models: [{ id: "current-video", minDuration: 4, maxDuration: 6 }],
      isLoading: false, isFallback: false,
    };
    for (const media of ["image", "video"] as const) {
      const isImage = media === "image";
      const questions = [
        { id: isImage ? "image_resolution" : "video_duration_seconds",
          title: isImage ? "Resolution" : "Duration",
          options_source: isImage
            ? "selected_image_model_resolutions" as const
            : "selected_video_model_durations" as const,
          options: [{ id: isImage ? "1K" : "5", label: isImage ? "1K" : "5" }] },
        { id: isImage ? "image_variants_per_node" : "video_variants_per_node",
          title: "Count", options: [{ id: "1", label: "1" }] },
      ];
      const answers = {
        [isImage ? "image_model" : "video_model"]: {
          option_ids: [isImage ? "retired-image" : "retired-video"],
        },
      };
      expect(assistantClarificationGenerationCatalogIssue(
        questions, imageCatalog, videoCatalog, answers,
      )).toBe("model_unavailable");
      const resolved = clarificationQuestionsWithLiveModelCatalogsForTest(
        questions, imageCatalog.models, videoCatalog.models, answers,
      );
      expect(resolved[0]).toMatchObject({ options: [], allow_custom: false });
      expect(assistantClarificationCanSubmit(resolved, answers)).toBe(false);
    }
  });

  it("keeps tool-provided options when the model was already fixed outside the card", () => {
    const questions = clarificationQuestionsWithLiveModelCatalogsForTest(
      [{
        id: "image_resolution",
        title: "Image resolution",
        options_source: "selected_image_model_resolutions",
        options: [{ id: "2K", label: "2K" }],
      }],
      [{ id: "image-a", label: "Image A", resolutionOptions: ["1K", "2K"] }],
      [],
    );

    expect(questions[0]?.options).toEqual([{ id: "2K", label: "2K" }]);
  });

  it("derives missing-field options from an already confirmed model answer", () => {
    const questions = clarificationQuestionsWithLiveModelCatalogsForTest(
      [
        {
          id: "image_resolution",
          title: "Image resolution",
          options_source: "selected_image_model_resolutions",
          options: [],
        },
        {
          id: "video_duration_seconds",
          title: "Video duration",
          options_source: "selected_video_model_durations",
          options: [],
        },
      ],
      [{ id: "image-a", label: "Image A", resolutionOptions: ["1K", "2K"] }],
      [{ id: "video-a", label: "Video A", minDuration: 4, maxDuration: 5 }],
      {
        image_model: { option_ids: ["image-a"] },
        video_model: { option_ids: ["video-a"] },
      },
    );

    expect(questions[0]?.options).toEqual([
      { id: "1K", label: "1K" },
      { id: "2K", label: "2K" },
    ]);
    expect(questions[1]?.options).toEqual([
      { id: "4", label: "4 seconds" },
      { id: "5", label: "5 seconds" },
    ]);
  });

  it("derives image quality only from the selected model capability", () => {
    expect(imageQualityOptionsForApprovalForTest({
      qualityOptions: ["low", "medium", "high"],
    })).toEqual(["low", "medium", "high"]);
    expect(normalizeImageQualityForApprovalForTest(
      "high",
      ["low", "medium", "high"],
    )).toBe("high");
    expect(normalizeImageQualityForApprovalForTest("medium", [])).toBeNull();
  });

  it("updates image node data before running generate_image", () => {
    const approval = {
      id: "approval-a",
      key: "approval-a",
      messageId: "assistant-a",
      receivedAt: 1,
      commandCount: 1,
      plans: [],
      envelopes: [
        {
          schema_version: "canvas_chat_commands.v1" as const,
          commands: [
            { type: "run_node_action" as const, node_id: "image-a", action: "generate_image" },
          ],
        },
      ],
    };

    const amended = amendCanvasApprovalWithImageParamsForTest(approval as never, {
      nodeId: "image-a",
      model: "newapi_gpt_image2",
      aspectRatio: "9:16",
      size: "2K",
      quality: "high",
      count: 2,
    });

    expect(amended.envelopes[0].commands).toEqual([
      {
        type: "update_node_data",
        node_id: "image-a",
        data: {
          model: "newapi_gpt_image2",
          aspectRatio: "9:16",
          size: "2K",
          quality: "high",
          count: 2,
        },
      },
      { type: "run_node_action", node_id: "image-a", action: "generate_image" },
    ]);
  });

  it("discovers media and text targets from a not-yet-created workflow", () => {
    const approval = {
      id: "approval-workflow-settings",
      key: "approval-workflow-settings",
      messageId: "assistant-workflow-settings",
      receivedAt: 1,
      commandCount: 7,
      plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [
          {
            type: "create_node" as const,
            client_id: "text-a",
            node_type: "textAnnotationNode" as const,
            data: { workflowCatalog: { recipeId: "story-copy", recipeLabel: "Story copy" } },
          },
          {
            type: "create_node" as const,
            client_id: "image-source",
            node_type: "imageGenNode" as const,
            data: { imageUrl: "/static/source.png" },
          },
          {
            type: "create_node" as const,
            client_id: "image-a",
            node_type: "imageGenNode" as const,
            data: { model: "image-model", aspectRatio: "9:16", size: "2K" },
          },
          {
            type: "create_node" as const,
            client_id: "video-a",
            node_type: "videoNode" as const,
            data: { model: "video-model", durationSec: 10, quality: "720P" },
          },
          {
            type: "create_node" as const,
            client_id: "speech-a",
            node_type: "audioNode" as const,
            data: { audioKind: "speech", speechMode: "preset" },
          },
          {
            type: "create_node" as const,
            client_id: "music-a",
            node_type: "audioNode" as const,
            data: { audioKind: "music", musicLengthMs: 60000 },
          },
          {
            type: "run_workflow" as const,
            node_ids: ["text-a", "image-a", "video-a", "speech-a", "music-a"],
            scope: "selection" as const,
          },
        ],
      }],
    };

    expect(imageApprovalInitialParamsForTest(
      approval as never,
      [],
      "fallback-image",
      [{
        id: "image-model",
        ratioOptions: ["1:1"],
        resolutionOptions: ["4K"],
      }],
    )).toMatchObject({
      nodeId: "image-a",
      nodeIds: ["image-a"],
      model: "image-model",
      aspectRatio: "1:1",
      size: "4K",
    });
    expect(videoApprovalInitialParamsForTest(
      approval as never,
      [],
      [],
      [{
        id: "video-model",
        ratioOptions: ["1:1"],
        resolutionOptions: ["480P"],
        minDuration: 4,
        maxDuration: 6,
        supportsGenerateAudio: false,
      }],
      "fallback-video",
    )).toMatchObject({
      nodeId: "video-a",
      nodeIds: ["video-a"],
      model: "video-model",
      aspectRatio: "1:1",
      quality: "480P",
      durationSec: 6,
      generateAudio: false,
    });
    expect(textApprovalInitialParamsForTest(approval as never, [])).toEqual({
      nodeIds: ["text-a"],
      recipeLabel: "Story copy",
    });
    expect(audioApprovalInitialParamsForTest(approval as never, [])).toEqual([
      expect.objectContaining({ nodeIds: ["speech-a"], audioKind: "speech" }),
      expect.objectContaining({ nodeIds: ["music-a"], audioKind: "music", musicLengthSec: 60 }),
    ]);
  });

  it("writes batch image settings immediately before the single workflow run", () => {
    const approval = {
      id: "approval-batch-image",
      key: "approval-batch-image",
      messageId: "assistant-batch-image",
      receivedAt: 1,
      commandCount: 1,
      plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [{ type: "run_workflow" as const, scope: "canvas" as const }],
      }],
    };
    const amended = amendCanvasApprovalWithImageParamsForTest(approval as never, {
      nodeId: "image-a",
      nodeIds: ["image-a", "image-b"],
      model: "image-model",
      aspectRatio: "16:9",
      size: "2K",
      quality: "medium",
      count: 1,
    });
    expect(amended.envelopes[0].commands.map((command) => command.type)).toEqual([
      "update_node_data",
      "update_node_data",
      "run_workflow",
    ]);
    expect(amended.envelopes[0].commands[2]).toEqual({
      type: "run_workflow",
      scope: "canvas",
    });
  });

  it("merges image settings into a node created by the same workflow batch", () => {
    const approval = {
      id: "approval-created-image",
      key: "approval-created-image",
      messageId: "assistant-created-image",
      receivedAt: 1,
      commandCount: 2,
      plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [
          {
            type: "create_node" as const,
            client_id: "image-a",
            node_type: "imageGenNode" as const,
            data: { prompt: "City rainy night", model: "recommended" },
          },
          { type: "run_workflow" as const, node_ids: ["image-a"], scope: "selection" as const },
        ],
      }],
    };

    const amended = amendCanvasApprovalWithImageParamsForTest(approval as never, {
      nodeId: "image-a",
      nodeIds: ["image-a"],
      model: "seedream-4.5",
      aspectRatio: "16:9",
      size: "2K",
      quality: null,
      count: 1,
    });

    expect(amended.envelopes[0].commands).toEqual([
      {
        type: "create_node",
        client_id: "image-a",
        node_type: "imageGenNode",
        data: {
          prompt: "City rainy night",
          model: "seedream-4.5",
          aspectRatio: "16:9",
          size: "2K",
          count: 1,
        },
      },
      { type: "run_workflow", node_ids: ["image-a"], scope: "selection" },
    ]);
  });

  it("keeps add_next_node image params through the approval card and amend (#685)", () => {
    const approval = {
      id: "add-next-approval", key: "add-next-approval", messageId: "assistant",
      receivedAt: 1, commandCount: 2, plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [
          {
            type: "add_next_node" as const,
            client_id: "image-a",
            source_node_id: "upload-1",
            node_type: "imageGenNode" as const,
            data: {
              prompt: "Watercolor style",
              model: "newapi_gpt_image2",
              aspectRatio: "9:16",
              size: "1k",
              quality: "medium",
              count: 1,
            },
          },
          { type: "run_node_action" as const, node_id: "image-a", action: "generate_image" },
        ],
      }],
    };
    const groups = imageApprovalParamGroupsForTest(approval as never, [], "other-model", [{
      id: "newapi_gpt_image2",
      resolutionOptions: ["1k", "2k", "4k"],
      qualityOptions: ["low", "medium", "high"],
    }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      nodeId: "image-a",
      model: "newapi_gpt_image2",
      aspectRatio: "9:16",
      size: "1k",
      quality: "medium",
      count: 1,
    });

    const amended = amendCanvasApprovalWithImageParamsForTest(approval as never, groups[0]);
    expect(amended.envelopes[0].commands).toEqual([
      {
        ...approval.envelopes[0].commands[0],
        data: { ...approval.envelopes[0].commands[0].data },
      },
      approval.envelopes[0].commands[1],
    ]);
  });

  it("keeps confirmed params when a later update_node_data targets the add_next_node node", () => {
    const approval = {
      id: "add-next-update-approval", key: "add-next-update-approval", messageId: "assistant",
      receivedAt: 1, commandCount: 3, plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [
          {
            type: "add_next_node" as const,
            client_id: "image-a",
            source_node_id: "upload-1",
            node_type: "imageGenNode" as const,
            data: { model: "newapi_gpt_image2", aspectRatio: "9:16", size: "1k" },
          },
          { type: "update_node_data" as const, node_id: "image-a", data: { aspectRatio: "1:1", prompt: "Watercolor" } },
          { type: "run_node_action" as const, node_id: "image-a", action: "generate_image" },
        ],
      }],
    };
    const models = [{ id: "newapi_gpt_image2", resolutionOptions: ["1k", "2k", "4k"] }];
    const groups = imageApprovalParamGroupsForTest(approval as never, [], "other-model", models);
    expect(groups[0]).toMatchObject({ aspectRatio: "1:1", size: "1k" });

    const amended = amendCanvasApprovalWithImageParamsForTest(approval as never, {
      ...groups[0],
      aspectRatio: "3:4",
      size: "2k",
    });
    const commands = amended.envelopes[0].commands as Array<{ type: string; data?: Record<string, unknown> }>;
    expect(commands.map((command) => command.type)).toEqual([
      "add_next_node",
      "update_node_data",
      "run_node_action",
    ]);
    expect(commands[1].data).toMatchObject({ aspectRatio: "3:4", size: "2k", prompt: "Watercolor" });
    expect(imageApprovalParamGroupsForTest(amended as never, [], "other-model", models)[0])
      .toMatchObject({ aspectRatio: "3:4", size: "2k" });
  });

  it("collects add_next_node image params for run_workflow approvals", () => {
    const approval = {
      id: "add-next-workflow-approval", key: "add-next-workflow-approval", messageId: "assistant",
      receivedAt: 1, commandCount: 2, plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [
          {
            type: "add_next_node" as const,
            client_id: "image-a",
            source_node_id: "upload-1",
            node_type: "imageGenNode" as const,
            data: { model: "newapi_gpt_image2", aspectRatio: "9:16", size: "1k" },
          },
          { type: "run_workflow" as const, scope: "canvas" as const },
        ],
      }],
    };
    const groups = imageApprovalParamGroupsForTest(approval as never, [], "other-model", [{
      id: "newapi_gpt_image2",
      resolutionOptions: ["1k", "2k", "4k"],
    }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ nodeId: "image-a", aspectRatio: "9:16", size: "1k" });

    const amended = amendCanvasApprovalWithImageParamsForTest(approval as never, {
      ...groups[0],
      aspectRatio: "3:4",
    });
    expect(amended.envelopes[0].commands).toEqual([
      {
        ...approval.envelopes[0].commands[0],
        data: expect.objectContaining({ aspectRatio: "3:4", size: "1k" }),
      },
      approval.envelopes[0].commands[1],
    ]);
  });

  it("infers an omitted add_next_node node_type for run_workflow approvals", () => {
    const previous = useCanvasStore.getState();
    useCanvasStore.setState({
      nodes: [{
        id: "upload-1",
        type: "uploadNode" as const,
        position: { x: 0, y: 0 },
        data: { imageUrl: "https://example.com/source.png" },
      }] as never,
      edges: [],
    });
    try {
      const approval = {
        id: "add-next-inferred-approval", key: "add-next-inferred-approval", messageId: "assistant",
        receivedAt: 1, commandCount: 3, plans: [],
        envelopes: [{
          schema_version: "canvas_chat_commands.v1" as const,
          commands: [
            {
              type: "add_next_node" as const,
              client_id: "image-a",
              source_node_id: "upload-1",
              data: { model: "newapi_gpt_image2", aspectRatio: "9:16", size: "1k" },
            },
            // A node newly created in this batch as the source: the type keeps being inferred along the client_id chain (the first downstream of imageGen
            // is still imageGen), consistent with the result of the executor's chooseNextNodeType.
            {
              type: "add_next_node" as const,
              client_id: "image-b",
              source_node_id: "image-a",
              data: { model: "newapi_gpt_image2", aspectRatio: "1:1", size: "2k" },
            },
            { type: "run_workflow" as const, scope: "canvas" as const },
          ],
        }],
      };
      const groups = imageApprovalParamGroupsForTest(approval as never, [], "other-model", [{
        id: "newapi_gpt_image2",
        resolutionOptions: ["1k", "2k", "4k"],
      }]);
      expect(groups).toHaveLength(2);
      expect(groups[0]).toMatchObject({ nodeIds: ["image-a"], aspectRatio: "9:16", size: "1k" });
      expect(groups[1]).toMatchObject({ nodeIds: ["image-b"], aspectRatio: "1:1", size: "2k" });
    } finally {
      useCanvasStore.setState(previous, true);
    }
  });

  it("collects add_next_node without client_id for run_workflow approvals", () => {
    const previous = useCanvasStore.getState();
    const uploadNode = {
      id: "upload-1",
      type: "uploadNode" as const,
      position: { x: 0, y: 0 },
      data: { imageUrl: "https://example.com/source.png" },
    };
    useCanvasStore.setState({ nodes: [uploadNode] as never, edges: [] });
    try {
      const envelopes = normalizeCanvasChatCommandEnvelopesForValidation([{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [
          {
            type: "add_next_node" as const,
            source_node_id: "upload-1",
            node_type: "imageGenNode" as const,
            data: { model: "newapi_gpt_image2", aspectRatio: "9:16", size: "1k" },
          },
          { type: "run_workflow" as const, scope: "canvas" as const },
        ],
      }], ["upload-1"]);
      const clientId = (envelopes[0].commands[0] as { client_id?: string }).client_id;
      expect(clientId).toBe("auto:new:0:0");
      // The executor normalizes once more; ids that were already filled in must stay unchanged so approval and execution map to the same node.
      expect(normalizeCanvasChatCommandEnvelopesForValidation(envelopes, ["upload-1"])).toEqual(envelopes);

      const approval = {
        id: "add-next-no-client-id", key: "add-next-no-client-id", messageId: "assistant",
        receivedAt: 1, commandCount: 2, plans: [], envelopes,
      };
      const groups = imageApprovalParamGroupsForTest(approval as never, [], "other-model", [{
        id: "newapi_gpt_image2",
        resolutionOptions: ["1k", "2k", "4k"],
      }]);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ nodeId: clientId, aspectRatio: "9:16", size: "1k" });

      const amended = amendCanvasApprovalWithImageParamsForTest(approval as never, {
        ...groups[0],
        aspectRatio: "3:4",
      });
      expect(amended.envelopes[0].commands[0]).toMatchObject({
        type: "add_next_node",
        client_id: clientId,
        data: { aspectRatio: "3:4", size: "1k" },
      });
    } finally {
      useCanvasStore.setState(previous, true);
    }
  });

  it("groups mixed workflow media in one approval and amends one run request", () => {
    const approval = {
      id: "mixed-approval", key: "mixed-approval", messageId: "assistant",
      receivedAt: 1, commandCount: 6, plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [
          { type: "create_node" as const, client_id: "image-a", node_type: "imageGenNode" as const, data: { model: "image-model" } },
          { type: "create_node" as const, client_id: "image-b", node_type: "imageGenNode" as const, data: { model: "image-model" } },
          { type: "create_node" as const, client_id: "video-a", node_type: "videoNode" as const, data: { model: "video-model", durationSec: 5 } },
          { type: "create_node" as const, client_id: "video-b", node_type: "videoNode" as const, data: { model: "video-model", durationSec: 5 } },
          { type: "create_node" as const, client_id: "audio-a", node_type: "audioNode" as const, data: { audioKind: "music" } },
          { type: "run_workflow" as const, scope: "canvas" as const },
        ],
      }],
    };
    const images = imageApprovalParamGroupsForTest(approval as never, [], "image-model");
    const videos = videoApprovalParamGroupsForTest(
      approval as never, [], [], [{ id: "video-model", minDuration: 5, maxDuration: 15 }], "video-model",
    );
    const audio = audioApprovalInitialParamsForTest(approval as never, []);
    expect(images).toHaveLength(1);
    expect(images[0].nodeIds).toEqual(["image-a", "image-b"]);
    expect(videos).toHaveLength(1);
    expect(videos[0].nodeIds).toEqual(["video-a", "video-b"]);
    expect(audio).toHaveLength(1);
    let amended = amendCanvasApprovalWithImageParamsForTest(approval as never, { ...images[0], count: 2 });
    amended = amendCanvasApprovalWithVideoParamsForTest(amended, { ...videos[0], count: 2 });
    amended = amendCanvasApprovalWithAudioParamsForTest(amended, audio[0]);
    expect(amended.envelopes).toHaveLength(1);
    expect(amended.envelopes[0].commands.filter((command) => command.type === "run_workflow")).toHaveLength(1);
    expect(amended.envelopes[0].commands.filter((command) => command.type === "create_node" && command.node_type !== "audioNode").map((command) => (command as { data?: Record<string, unknown> }).data?.count)).toEqual([2, 2, 2, 2]);
  });

  it("keeps intentionally different image and video settings in separate rows", () => {
    const approval = {
      id: "approval-distinct-settings",
      key: "approval-distinct-settings",
      messageId: "assistant-distinct-settings",
      receivedAt: 1,
      commandCount: 5,
      plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [
          { type: "create_node" as const, client_id: "image-a", node_type: "imageGenNode" as const, data: { aspectRatio: "16:9" } },
          { type: "create_node" as const, client_id: "image-b", node_type: "imageGenNode" as const, data: { aspectRatio: "9:16" } },
          { type: "create_node" as const, client_id: "video-a", node_type: "videoNode" as const, data: { durationSec: 5 } },
          { type: "create_node" as const, client_id: "video-b", node_type: "videoNode" as const, data: { durationSec: 10 } },
          { type: "run_workflow" as const, scope: "canvas" as const },
        ],
      }],
    };

    expect(imageApprovalParamGroupsForTest(approval as never, [], "image-model")).toHaveLength(2);
    expect(videoApprovalParamGroupsForTest(
      approval as never,
      [],
      [],
      [{ id: "video-model", minDuration: 5, maxDuration: 15 }],
      "video-model",
    )).toHaveLength(2);
  });
});

describe("Canvas command approval audio params", () => {
  it("does not block auto execution when missing custom voice will be skipped", () => {
    const approval = {
      id: "approval-voice-choice",
      key: "approval-voice-choice",
      messageId: "assistant-voice-choice",
      receivedAt: 1,
      commandCount: 1,
      plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [{ type: "run_node_action" as const, node_id: "speech-a", action: "generate_audio" }],
      }],
    };
    const speechNode = {
      id: "speech-a",
      type: "audioNode",
      position: { x: 0, y: 0 },
      data: { audioKind: "speech", speechMode: "preset" },
    };
    expect(canvasApprovalRequiresAudioVoiceChoiceForTest(
      approval as never,
      [speechNode] as never,
    )).toBe(false);
    expect(canvasApprovalRequiresAudioVoiceChoiceForTest(
      approval as never,
      [{ ...speechNode, data: { ...speechNode.data, voicePolicyConfirmed: true } }] as never,
    )).toBe(false);
  });

  it("does not block auto execution when a speech node has no custom voice", () => {
    const approval = {
      id: "approval-agent-voice-switch",
      key: "approval-agent-voice-switch",
      messageId: "assistant-agent-voice-switch",
      receivedAt: 1,
      commandCount: 2,
      plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [
          {
            type: "update_node_data" as const,
            node_id: "speech-a",
            data: {
              speechMode: "clone",
              voicePolicyConfirmed: true,
              voiceAvailable: false,
            },
          },
          { type: "run_node_action" as const, node_id: "speech-a", action: "generate_audio" },
        ],
      }],
    };
    const speechNode = {
      id: "speech-a",
      type: "audioNode",
      position: { x: 0, y: 0 },
      data: {
        audioKind: "speech",
        speechMode: "preset",
        voicePolicyConfirmed: true,
      },
    };

    expect(canvasApprovalRequiresAudioVoiceChoiceForTest(
      approval as never,
      [speechNode] as never,
    )).toBe(false);
  });

  it("allows an unchanged confirmed system voice retry in auto mode", () => {
    const approval = {
      id: "approval-system-retry",
      key: "approval-system-retry",
      messageId: "assistant-system-retry",
      receivedAt: 1,
      commandCount: 1,
      plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [
          { type: "run_node_action" as const, node_id: "speech-a", action: "generate_audio" },
        ],
      }],
    };
    const speechNode = {
      id: "speech-a",
      type: "audioNode",
      position: { x: 0, y: 0 },
      data: {
        audioKind: "speech",
        speechMode: "preset",
        voicePolicyConfirmed: true,
        generationError: "ORG_SERVICE_EGRESS_DENIED",
      },
    };

    expect(canvasApprovalRequiresAudioVoiceChoiceForTest(
      approval as never,
      [speechNode] as never,
    )).toBe(false);
  });

  it("never auto executes the manual voice picker action", () => {
    const approval = {
      id: "approval-open-picker",
      key: "approval-open-picker",
      messageId: "assistant-open-picker",
      receivedAt: 1,
      commandCount: 1,
      plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [
          { type: "run_node_action" as const, node_id: "speech-a", action: "open_voice_picker" },
        ],
      }],
    };

    expect(canvasApprovalRequiresManualUiActionForTest(approval as never)).toBe(true);
  });

  it("persists the selected uploaded voice before generation", () => {
    const approval = {
      id: "approval-custom-speech",
      key: "approval-custom-speech",
      messageId: "assistant-custom-speech",
      receivedAt: 1,
      commandCount: 1,
      plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [{ type: "run_node_action" as const, node_id: "speech-a", action: "generate_audio" }],
      }],
    };
    const amended = amendCanvasApprovalWithAudioParamsForTest(approval as never, {
      nodeId: "speech-a",
      nodeIds: ["speech-a"],
      audioKind: "speech",
      speechMode: "clone",
      presetVoice: "Serena",
      voiceLabel: "My narration",
      voiceRef: { scope: "user_custom", voiceId: "fv_voice_1" },
      voiceAvailable: true,
      emotionPrompt: "",
      musicLengthSec: 30,
      forceInstrumental: true,
      respectSectionsDurations: true,
    });
    expect(amended.envelopes[0].commands[0]).toEqual({
      type: "update_node_data",
      node_id: "speech-a",
      data: expect.objectContaining({
        speechMode: "clone",
        voiceRef: { scope: "user_custom", voiceId: "fv_voice_1" },
        voiceAvailable: true,
        voiceLabel: "My narration",
      }),
    });
  });

  it("coerces a legacy system selection to custom mode and skips when unselected", () => {
    const approval = {
      id: "approval-speech",
      key: "approval-speech",
      messageId: "assistant-speech",
      receivedAt: 1,
      commandCount: 1,
      plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [{ type: "run_workflow" as const, scope: "canvas" as const }],
      }],
    };
    const amended = amendCanvasApprovalWithAudioParamsForTest(approval as never, {
      nodeId: "speech-a",
      nodeIds: ["speech-a"],
      audioKind: "speech",
      speechMode: "preset",
      presetVoice: "Serena",
      voiceLabel: "System female voice",
      emotionPrompt: "Restrained",
      musicLengthSec: 30,
      forceInstrumental: true,
      respectSectionsDurations: true,
    });
    expect(amended.envelopes[0].commands).toEqual([
      {
        type: "update_node_data",
        node_id: "speech-a",
        data: {
          audioKind: "speech",
          speechMode: "clone",
          voicePolicyConfirmed: true,
          emotionPrompt: "Restrained",
          voiceRef: null,
          voiceAvailable: false,
          voiceLabel: "No custom voice selected",
          voiceLanguage: "",
        },
      },
      { type: "run_workflow", scope: "canvas" },
    ]);
  });

  it("merges custom-only skip metadata into a newly created speech node", () => {
    const approval = {
      id: "approval-created-speech",
      key: "approval-created-speech",
      messageId: "assistant-created-speech",
      receivedAt: 1,
      commandCount: 2,
      plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [
          {
            type: "create_node" as const,
            client_id: "speech-a",
            node_type: "audioNode" as const,
            data: { audioKind: "speech", prompt: "After the rain stops" },
          },
          { type: "run_workflow" as const, node_ids: ["speech-a"], scope: "selection" as const },
        ],
      }],
    };

    const amended = amendCanvasApprovalWithAudioParamsForTest(approval as never, {
      nodeId: "speech-a",
      nodeIds: ["speech-a"],
      audioKind: "speech",
      speechMode: "preset",
      presetVoice: "Serena",
      voiceLabel: "System female voice",
      emotionPrompt: "Restrained",
      musicLengthSec: 30,
      forceInstrumental: true,
      respectSectionsDurations: true,
    });

    expect(amended.envelopes[0].commands).toEqual([
      {
        type: "create_node",
        client_id: "speech-a",
        node_type: "audioNode",
        data: {
          audioKind: "speech",
          prompt: "After the rain stops",
          speechMode: "clone",
          voicePolicyConfirmed: true,
          emotionPrompt: "Restrained",
          voiceRef: null,
          voiceAvailable: false,
          voiceLabel: "No custom voice selected",
          voiceLanguage: "",
        },
      },
      { type: "run_workflow", node_ids: ["speech-a"], scope: "selection" },
    ]);
  });

  it("writes music settings before the workflow run", () => {
    const approval = {
      id: "approval-music",
      key: "approval-music",
      messageId: "assistant-music",
      receivedAt: 1,
      commandCount: 1,
      plans: [],
      envelopes: [{
        schema_version: "canvas_chat_commands.v1" as const,
        commands: [{ type: "run_workflow" as const, scope: "canvas" as const }],
      }],
    };
    const amended = amendCanvasApprovalWithAudioParamsForTest(approval as never, {
      nodeId: "music-a",
      nodeIds: ["music-a"],
      audioKind: "music",
      speechMode: "preset",
      presetVoice: "Serena",
      voiceLabel: "Project default voice",
      emotionPrompt: "",
      musicLengthSec: 60,
      forceInstrumental: true,
      respectSectionsDurations: true,
    });
    expect(amended.envelopes[0].commands).toEqual([
      {
        type: "update_node_data",
        node_id: "music-a",
        data: {
          audioKind: "music",
          model: "suno_music",
          musicLengthMs: 60000,
          forceInstrumental: true,
          respectSectionsDurations: true,
        },
      },
      { type: "run_workflow", scope: "canvas" },
    ]);
  });
});

describe("Canvas command approval video params", () => {
  it("updates video node data before running generate_video", () => {
    const approval = {
      id: "approval-a",
      key: "approval-a",
      messageId: "assistant-a",
      receivedAt: 1,
      commandCount: 1,
      plans: [],
      envelopes: [
        {
          schema_version: "canvas_chat_commands.v1" as const,
          commands: [
            { type: "run_node_action" as const, node_id: "video-a", action: "generate_video" },
          ],
        },
      ],
    };

    const amended = amendCanvasApprovalWithVideoParamsForTest(approval as never, {
      nodeId: "video-a",
      model: "newapi_seedance-2.0",
      aspectRatio: "9:16",
      quality: "1080P",
      durationSec: 10,
      generateAudio: true,
      humanReview: true,
      requiresHumanReviewConfirmation: true,
      count: 2,
    });

    expect(amended.envelopes[0].commands).toEqual([
      {
        type: "update_node_data",
        node_id: "video-a",
        data: {
          model: "newapi_seedance-2.0",
          aspectRatio: "9:16",
          quality: "1080P",
          durationSec: 10,
          generateAudio: true,
          humanReview: true,
          count: 2,
        },
      },
      { type: "run_node_action", node_id: "video-a", action: "generate_video" },
    ]);
  });

  it("requires confirmation for a Seedance image-to-video command", () => {
    const approval = {
      id: "approval-real-person",
      key: "approval-real-person",
      messageId: "assistant-real-person",
      receivedAt: 1,
      commandCount: 4,
      plans: [],
      envelopes: [
        {
          schema_version: "canvas_chat_commands.v1" as const,
          commands: [
            {
              type: "create_node" as const,
              client_id: "image-a",
              node_type: "imageGenNode" as const,
              data: { imageUrl: "/static/reference.png" },
            },
            {
              type: "create_node" as const,
              client_id: "video-a",
              node_type: "videoNode" as const,
              data: { model: "newapi_seedance-2.0-fast", genMode: "imageToVideo" },
            },
            {
              type: "create_edge" as const,
              source: "image-a",
              target: "video-a",
              link_type: "reference" as const,
            },
            { type: "run_node_action" as const, node_id: "video-a", action: "generate_video" },
          ],
        },
      ],
    };

    expect(
      canvasApprovalRequiresHumanReviewConfirmationForTest(
        approval as never,
        [],
        [],
      ),
    ).toBe(true);
  });

  it("does not require confirmation after human review is enabled", () => {
    const approval = {
      id: "approval-reviewed",
      key: "approval-reviewed",
      messageId: "assistant-reviewed",
      receivedAt: 1,
      commandCount: 1,
      plans: [],
      envelopes: [
        {
          schema_version: "canvas_chat_commands.v1" as const,
          commands: [
            { type: "run_node_action" as const, node_id: "video-a", action: "generate_video" },
          ],
        },
      ],
    };
    const nodes = [
      {
        id: "video-a",
        type: "videoNode",
        position: { x: 0, y: 0 },
        data: {
          model: "newapi_seedance-2.0-fast",
          genMode: "imageToVideo",
          humanReview: true,
        },
      },
    ];

    expect(
      canvasApprovalRequiresHumanReviewConfirmationForTest(
        approval as never,
        nodes as never,
        [],
      ),
    ).toBe(false);
  });

  it("requires confirmation and enables review before running a dynamic workflow", () => {
    const approval = {
      id: "approval-workflow",
      key: "approval-workflow",
      messageId: "assistant-workflow",
      receivedAt: 1,
      commandCount: 4,
      plans: [],
      envelopes: [
        {
          schema_version: "canvas_chat_commands.v1" as const,
          commands: [
            {
              type: "create_node" as const,
              client_id: "image-a",
              node_type: "imageGenNode" as const,
              data: { imageUrl: "/static/reference.png" },
            },
            {
              type: "create_node" as const,
              client_id: "video-a",
              node_type: "videoNode" as const,
              data: { genMode: "imageToVideo" },
            },
            {
              type: "create_edge" as const,
              source: "image-a",
              target: "video-a",
              link_type: "reference" as const,
            },
            {
              type: "run_workflow" as const,
              node_ids: ["image-a", "video-a"],
              scope: "selection" as const,
            },
          ],
        },
      ],
    };

    expect(
      canvasApprovalRequiresHumanReviewConfirmationForTest(
        approval as never,
        [],
        [],
      ),
    ).toBe(true);

    const amended = amendCanvasApprovalWithHumanReviewForTest(
      approval as never,
      ["video-a"],
      true,
    );
    expect(amended.envelopes[0].commands.slice(-2)).toEqual([
      {
        type: "update_node_data",
        node_id: "video-a",
        data: { humanReview: true },
      },
      {
        type: "run_workflow",
        node_ids: ["image-a", "video-a"],
        scope: "selection",
      },
    ]);
  });
});

describe("Skill Studio flow ordering", () => {
  it("places submitted clarification summaries at their saved text anchor", () => {
    const items = buildAssistantInteractionFlowItemsForTest(
      "What you want is a Skill configuration draft. Let me first use a few key multiple-choice questions to set the direction.\n\nThe direction is clear; generating the draft now.",
      [
        {
          type: "skill_studio.draft",
          anchor_text_prefix: "What you want is a Skill configuration draft. Let me first use a few key multiple-choice questions to set the direction.\n\nThe direction is clear; generating the draft now.",
          skill_studio_session_id: "skill_studio_01",
          skill: { id: "home-culture-poster" },
          recipes: [],
        },
      ],
      [
        {
          type: "assistant.clarification.request",
          submitted: true,
          bridge_key: "clarification-key",
          anchor_text_prefix: "What you want is a Skill configuration draft. Let me first use a few key multiple-choice questions to set the direction.\n\n",
          questions: [],
          answers: {},
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "clarification", "text", "skill_studio"]);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: "What you want is a Skill configuration draft. Let me first use a few key multiple-choice questions to set the direction.\n\n",
    });
  });

  it("keeps interaction cards before text when they arrived before streaming text", () => {
    const items = buildAssistantInteractionFlowItemsForTest(
      "I will continue generating the draft based on your selections.",
      [],
      [
        {
          type: "assistant.clarification.request",
          submitted: true,
          bridge_key: "clarification-key",
          questions: [],
          answers: {},
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["clarification", "text"]);
    expect(items[1]).toMatchObject({ kind: "text", text: "I will continue generating the draft based on your selections." });
  });

  it("keeps a draft card at its arrival point when later text is appended after cancellation", () => {
    const firstText = "Okay, understood: I will generate the full Skill configuration draft.";
    const continuation = "\n\nOkay, saving this Skill draft was cancelled; nothing will be written to the configuration.";
    const items = buildAssistantInteractionFlowItemsForTest(
      `${firstText}${continuation}`,
      [
        {
          type: "skill_studio.draft",
          cancelled: true,
          received_at: 100,
          anchor_text_prefix: `${firstText} (submitting the draft card)`,
          skill_studio_session_id: "skill_studio_01",
          skill: { id: "poster-skill" },
          recipes: [],
        },
      ],
      [],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "skill_studio", "text"]);
    expect(items[0]).toMatchObject({ kind: "text", text: firstText });
    expect(items[2]).toMatchObject({ kind: "text", text: continuation });
  });

  it("renders anchored cards at the text position where the event arrived", () => {
    const items = buildSkillStudioFlowItemsForTest(
      "Intro.\nFollow-up text.",
      [
        {
          type: "skill_studio.draft",
          anchor_text_prefix: "Intro.\n",
          skill_studio_session_id: "skill_studio_01",
          skill: { id: "poster-skill" },
          recipes: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "event", "text"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "Intro.\n" });
    expect(items[2]).toMatchObject({ kind: "text", text: "Follow-up text." });
  });

  it("keeps stale-anchor cards after continuation text when streaming restarts after a tool result", () => {
    const items = buildSkillStudioFlowItemsForTest(
      "This Skill has been saved; you can keep extending it next.",
      [
        {
          type: "skill_studio.draft",
          anchor_text_prefix: "Here's the complete Skill and Recipe draft:",
          skill_studio_session_id: "skill_studio_01",
          skill: { id: "poster-skill" },
          recipes: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "event"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "This Skill has been saved; you can keep extending it next." });
  });

  it("keeps submitted question cards after assistant narration when their saved anchor is stale", () => {
    const items = buildSkillStudioFlowItemsForTest(
      [
        "You want a \"Hometown Culture Poster\" workflow Skill. I will first ask a few key choices the Skill Studio way, then draft the full Skill/Recipe accordingly.",
        "This is a Skill Studio configuration, not a canvas write. Collect a few direction details first, then generate the full Skill/Recipe draft.",
        "The full Skill draft has been organized from your selections; submitting a visual card for you to confirm and fine-tune.",
      ].join("\n\n"),
      [
        {
          type: "skill_studio.questions",
          submitted: true,
          anchor_text_prefix: "Let me enter Skill Studio first.",
          skill_studio_session_id: "skill_studio_01",
          selections: { audience: "local" },
          questions: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "event"]);
    expect(items[0]).toMatchObject({
      kind: "text",
      text: expect.stringContaining("You want a \"Hometown Culture Poster\" workflow Skill"),
    });
  });

  it("keeps submitted unanchored question cards after assistant text", () => {
    const items = buildSkillStudioFlowItemsForTest(
      "I will generate the draft based on your selections.",
      [
        {
          type: "skill_studio.questions",
          submitted: true,
          skill_studio_session_id: "skill_studio_01",
          selections: { audience: "young" },
          questions: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "event"]);
  });

  it("keeps cancelled draft cards after text when no anchor is available", () => {
    const items = buildSkillStudioFlowItemsForTest(
      "Saving was cancelled; I will keep replying based on the current context.",
      [
        {
          type: "skill_studio.draft",
          cancelled: true,
          skill_studio_session_id: "skill_studio_01",
          skill: { id: "poster-skill" },
          recipes: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "event"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "Saving was cancelled; I will keep replying based on the current context." });
  });

  it("keeps cancelled draft cards at the saved anchor before continuation text", () => {
    const items = buildSkillStudioFlowItemsForTest(
      "The Skill draft has been generated; submitting the card.\nSaving was cancelled; I will keep replying based on the current context.",
      [
        {
          type: "skill_studio.draft",
          cancelled: true,
          anchor_text_prefix: "The Skill draft has been generated; submitting the card.\n",
          skill_studio_session_id: "skill_studio_01",
          skill: { id: "poster-skill" },
          recipes: [],
        },
      ],
    );

    expect(items.map((item) => item.kind)).toEqual(["text", "event", "text"]);
    expect(items[0]).toMatchObject({ kind: "text", text: "The Skill draft has been generated; submitting the card.\n" });
    expect(items[2]).toMatchObject({ kind: "text", text: "Saving was cancelled; I will keep replying based on the current context." });
  });
});

describe("repeated canvas status collapsing", () => {
  it("collapses consecutive identical context flow items without crossing text", () => {
    const items = collapseRepeatedCanvasStatusFlowItemsForTest([
      {
        kind: "context",
        key: "context:1",
        activity: { key: "1", turnId: null, bridgeKey: null, status: "done", labels: ["Node details"], errors: [] },
      },
      {
        kind: "context",
        key: "context:2",
        activity: { key: "2", turnId: null, bridgeKey: null, status: "done", labels: ["Node details"], errors: [] },
      },
      { kind: "text", key: "text:1", text: "Continue analyzing." },
      {
        kind: "context",
        key: "context:3",
        activity: { key: "3", turnId: null, bridgeKey: null, status: "done", labels: ["Node details"], errors: [] },
      },
      {
        kind: "context",
        key: "context:4",
        activity: { key: "4", turnId: null, bridgeKey: null, status: "done", labels: ["Canvas ontology"], errors: [] },
      },
    ]);

    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({
      kind: "context",
      activity: { labels: ["Node details"], repeatCount: 2 },
    });
    expect(items[1]).toMatchObject({ kind: "text" });
    expect(items[2]).toMatchObject({
      kind: "context",
      activity: { labels: ["Node details"] },
    });
    expect(items[3]).toMatchObject({
      kind: "context",
      activity: { labels: ["Canvas ontology"] },
    });
  });

  it("collapses consecutive identical canvas context ordered parts for history and streaming", () => {
    const parts = collapseRepeatedCanvasStatusPartsForTest([
      {
        id: "context-1",
        type: "canvas_context",
        event: { key: "1", turnId: null, bridgeKey: null, status: "done", labels: ["Node details"], errors: [] },
      },
      {
        id: "context-2",
        type: "canvas_context",
        event: { key: "2", turnId: null, bridgeKey: null, status: "done", labels: ["Node details"], errors: [] },
      },
      { id: "text-1", type: "text", text: "Let me continue." },
      {
        id: "context-3",
        type: "canvas_context",
        event: { key: "3", turnId: null, bridgeKey: null, status: "done", labels: ["Node details"], errors: [] },
      },
    ]);

    expect(parts).toHaveLength(3);
    expect(parts[0]).toMatchObject({
      type: "canvas_context",
      event: { labels: ["Node details"], repeatCount: 2 },
    });
    expect(parts[1]).toMatchObject({ type: "text" });
    expect(parts[2]).toMatchObject({
      type: "canvas_context",
      event: { labels: ["Node details"] },
    });
  });
});

describe("Freezone chat scope", () => {
  it("keeps different Freezone canvases in separate local session buckets", () => {
    const canvasA = scopeForProjectForTest("project-a", "freezone", "canvas-a");
    const canvasB = scopeForProjectForTest("project-a", "freezone", "canvas-b");

    expect(canvasA).toMatchObject({
      kind: "project",
      id: "project-a",
      surface: "freezone",
      canvasId: "canvas-a",
    });
    expect(scopeSessionKeyForTest(canvasA)).toBe(
      "supertale:project:project-a:freezone:canvas-a:agent:main",
    );
    expect(scopeSessionKeyForTest(canvasB)).toBe(
      "supertale:project:project-a:freezone:canvas-b:agent:main",
    );
  });

  it("keeps different Freezone agents on the same canvas in separate local session buckets", () => {
    const agentA = scopeForProjectForTest("project-a", "freezone", "canvas-a", "main");
    const agentB = scopeForProjectForTest("project-a", "freezone", "canvas-a", "agent-2");

    expect(agentA).toMatchObject({
      kind: "project",
      id: "project-a",
      surface: "freezone",
      canvasId: "canvas-a",
      agentId: "main",
    });
    expect(scopeSessionKeyForTest(agentA)).toBe(
      "supertale:project:project-a:freezone:canvas-a:agent:main",
    );
    expect(scopeSessionKeyForTest(agentB)).toBe(
      "supertale:project:project-a:freezone:canvas-a:agent:agent-2",
    );
  });

  it("does not let agent ids affect director chat scopes", () => {
    const director = scopeForProjectForTest("project-a", "director", null, "agent-2");

    expect(director).toEqual({
      kind: "project",
      id: "project-a",
      surface: "director",
      canvasId: null,
    });
    expect(scopeSessionKeyForTest(director)).toBe("supertale:project:project-a:director");
  });
});

describe("useSuperChat websocket lifecycle", () => {
  const OriginalWebSocket = globalThis.WebSocket;

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.removeItem("freezone.canvasCommandExecutionMode");
    Object.defineProperty(globalThis, "WebSocket", {
      value: OriginalWebSocket,
      writable: true,
      configurable: true,
    });
  });

  it("does not open a websocket while the panel connection is disabled", () => {
    vi.useFakeTimers();
    const sockets: unknown[] = [];
    class TestWebSocket {
      static OPEN = 1;
      readyState = 0;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send() {}
      close() {}
    }
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });

    renderHook(() =>
      useSuperChat({
        project: "project-a",
        displayName: "Tester",
        surface: "freezone",
        freezoneCanvasId: "canvas-a",
        freezoneAgentId: "agent-2",
        connectionEnabled: false,
      }),
    );

    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(sockets).toHaveLength(0);
  });

  it("sends original user text separately from augmented transport text", async () => {
    localStorage.setItem("freezone.canvasCommandExecutionMode", "auto_execute");
    const sentFrames: string[] = [];
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send(frame: string) {
        sentFrames.push(frame);
      }

      close() {}
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });

    const hook = renderHook(() =>
      useSuperChat({
        project: "project-a",
        displayName: "Tester",
        surface: "freezone",
        freezoneCanvasId: "canvas-a",
      }),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => {
      sockets[0]?.onopen?.();
      sockets[0]?.onmessage?.({
        data: JSON.stringify({
          type: "scope.changed",
          scope: {
            kind: "project",
            id: "project-a",
            surface: "freezone",
            canvasId: "canvas-a",
          },
          history: [],
        }),
      } as MessageEvent);
    });
    await waitFor(() => expect(hook.result.current.connected).toBe(true));

    act(() => {
      hook.result.current.send(
        "Check the current node details and reply ok",
        [],
        "Check the current node details and reply ok\n\nnode_type: skillNode\navailable_actions: run_skill",
      );
    });

    const chatFrame = sentFrames
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .find((frame) => frame.type === "chat.message");

    expect(chatFrame).toEqual(expect.objectContaining({
      text: expect.stringContaining("node_type: skillNode"),
      user_text: "Check the current node details and reply ok",
      context: {
        freezone_canvas_id: "canvas-a",
        canvas_command_execution_mode: "auto_execute",
      },
    }));
  });

  it("cancels only the active business turn in the current scope", async () => {
    apiPostMock.mockClear();
    const sentFrames: string[] = [];
    const closeCalls: Array<[number | undefined, string | undefined]> = [];
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send(frame: string) {
        sentFrames.push(frame);
      }

      close(code?: number, reason?: string) {
        closeCalls.push([code, reason]);
      }
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });
    const scope = {
      kind: "project" as const,
      id: "project-a",
      surface: "freezone" as const,
      canvasId: "canvas-a",
      agentId: "agent-2",
    };
    const hook = renderHook(() => useSuperChat({
      project: "project-a",
      displayName: "Tester",
      surface: "freezone",
      freezoneCanvasId: "canvas-a",
      freezoneAgentId: "agent-2",
    }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => {
      sockets[0]?.onopen?.();
      sockets[0]?.onmessage?.({
        data: JSON.stringify({ type: "scope.changed", scope, history: [], busy: false }),
      } as MessageEvent);
    });
    await waitFor(() => expect(hook.result.current.connected).toBe(true));

    act(() => {
      expect(hook.result.current.send("keep this scoped", [])).toBe(true);
    });
    const chatFrame = sentFrames
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .find((frame) => frame.type === "chat.message");
    expect(chatFrame?.turn_id).toEqual(expect.any(String));

    act(() => hook.result.current.abort());

    await waitFor(() => expect(apiPostMock).toHaveBeenCalledWith("api/v1/chat/cancel", {
      json: { scope, turn_id: chatFrame?.turn_id },
    }));
    // Cancellation is a request, not a terminal state, so the connection must stay open for the server's terminal frame. Here we only assert "the cancel was sent to the correct
    // business turn" (the subject of this test); the timing of closing the connection is covered by the two dedicated tests below.
    expect(closeCalls).toEqual([]);
  });

  it("keeps the websocket open after abort until the server terminal frame arrives", async () => {
    apiPostMock.mockClear();
    const sentFrames: string[] = [];
    const closeCalls: Array<[number | undefined, string | undefined]> = [];
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send(frame: string) {
        sentFrames.push(frame);
      }

      close(code?: number, reason?: string) {
        closeCalls.push([code, reason]);
        this.readyState = 3;
      }
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });
    const scope = {
      kind: "project" as const,
      id: "project-a",
      surface: "freezone" as const,
      canvasId: "canvas-a",
      agentId: "agent-2",
    };
    const hook = renderHook(() => useSuperChat({
      project: "project-a",
      displayName: "Tester",
      surface: "freezone",
      freezoneCanvasId: "canvas-a",
      freezoneAgentId: "agent-2",
    }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => {
      sockets[0]?.onopen?.();
      sockets[0]?.onmessage?.({
        data: JSON.stringify({ type: "scope.changed", scope, history: [], busy: false }),
      } as MessageEvent);
    });
    await waitFor(() => expect(hook.result.current.connected).toBe(true));
    act(() => {
      expect(hook.result.current.send("cancel me", [])).toBe(true);
    });
    const turnId = sentFrames
      .map((frame) => JSON.parse(frame) as Record<string, unknown>)
      .find((frame) => frame.type === "chat.message")?.turn_id as string;

    act(() => hook.result.current.abort());

    // Within tens of milliseconds the server sends `agent.turn.completed disposition=cancelled` on this
    // connection; if abort closed it immediately, this frame would be unobservable to any client.
    expect(closeCalls).toEqual([]);
    expect(sockets[0]?.readyState).toBe(1);

    await act(async () => {
      sockets[0]?.onmessage?.({
        data: JSON.stringify({
          type: "agent.turn.completed",
          scope,
          turn_id: turnId,
          status: "cancelled",
          disposition: "cancelled",
        }),
      } as MessageEvent);
      sockets[0]?.onmessage?.({
        data: JSON.stringify({ type: "chat.done", scope, turn_id: turnId }),
      } as MessageEvent);
    });

    // Once the terminal frame is received normally there is no need to close the connection, nor should it trigger a reconnect.
    expect(closeCalls).toEqual([]);
    expect(sockets).toHaveLength(1);
    expect(hook.result.current.busy).toBe(false);
  });

  it("closes the websocket when no terminal frame arrives within the abort grace window", async () => {
    apiPostMock.mockClear();
    const sentFrames: string[] = [];
    const closeCalls: Array<[number | undefined, string | undefined]> = [];
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send(frame: string) {
        sentFrames.push(frame);
      }

      close(code?: number, reason?: string) {
        closeCalls.push([code, reason]);
        this.readyState = 3;
      }
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });
    const scope = {
      kind: "project" as const,
      id: "project-a",
      surface: "freezone" as const,
      canvasId: "canvas-a",
      agentId: "agent-2",
    };
    const hook = renderHook(() => useSuperChat({
      project: "project-a",
      displayName: "Tester",
      surface: "freezone",
      freezoneCanvasId: "canvas-a",
      freezoneAgentId: "agent-2",
    }));
    await waitFor(() => expect(sockets).toHaveLength(1));
    await act(async () => {
      sockets[0]?.onopen?.();
      sockets[0]?.onmessage?.({
        data: JSON.stringify({ type: "scope.changed", scope, history: [], busy: false }),
      } as MessageEvent);
    });
    await waitFor(() => expect(hook.result.current.connected).toBe(true));
    act(() => {
      expect(hook.result.current.send("cancel me", [])).toBe(true);
    });

    vi.useFakeTimers();
    act(() => hook.result.current.abort());
    expect(closeCalls).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(abortTerminalGraceMsForTest() - 1);
    });
    expect(closeCalls).toEqual([]);

    act(() => {
      vi.advanceTimersByTime(1);
    });
    // Only self-rescue when the server never sends a terminal frame: close and let onclose reconnect, reconciling with history.
    expect(closeCalls).toEqual([[4000, "client abort"]]);
  });

  it("defaults freezone canvas execution context to manual confirmation", () => {
    expect(freezoneCanvasCommandExecutionModeForTest()).toBe("manual_confirm");
  });

  it("reconciles a partial stream from the final message carried by chat.done", async () => {
    const sentFrames: string[] = [];
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send(data: string) {
        sentFrames.push(data);
      }
      close() {}
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });

    const hook = renderHook(() =>
      useSuperChat({ project: "project-a", displayName: "Tester" }),
    );
    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    const scope = { kind: "project", id: "project-a" };

    await act(async () => {
      socket.onopen?.();
      socket.onmessage?.({
        data: JSON.stringify({ type: "scope.changed", scope, history: [] }),
      } as MessageEvent);
      socket.onmessage?.({
        data: JSON.stringify({
          type: "assistant.delta",
          scope,
          turn_id: "turn-identity",
          text: "Identity planning is complete; you can go straig",
          accumulated: true,
        }),
      } as MessageEvent);
      socket.onmessage?.({
        data: JSON.stringify({
          type: "chat.done",
          scope,
          turn_id: "turn-identity",
          message: {
            id: 403,
            role: "assistant",
            content: "Identity planning is complete; you can go straight to the next step (script generation).",
            created_at: "2026-08-04T09:13:46.445748+00:00",
          },
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      const replies = hook.result.current.messages.filter((item) => item.role === "assistant");
      expect(replies).toHaveLength(1);
      expect(replies[0]?.text).toBe("Identity planning is complete; you can go straight to the next step (script generation).");
    });
    expect(
      sentFrames
        .map((frame) => JSON.parse(frame) as Record<string, unknown>)
        .filter((frame) => frame.type === "scope.set"),
    ).toHaveLength(2);
  });

  it("persists merged assistant parts after the final assistant message arrives", async () => {
    apiPostMock.mockClear();
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send() {}
      close() {}
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });

    const hook = renderHook(() =>
      useSuperChat({
        project: "project-a",
        displayName: "Tester",
        surface: "freezone",
        freezoneCanvasId: "canvas-a",
        freezoneAgentId: "agent-2",
      }),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    await waitFor(() => expect(socket.onmessage).toBeTypeOf("function"));
    await act(async () => {
      socket.onopen?.();
    });
    const scope = {
      kind: "project",
      id: "project-a",
      surface: "freezone",
      canvasId: "canvas-a",
      agentId: "agent-2",
    };

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "assistant.clarification.event",
          scope,
          turn_id: "turn-1",
          bridge_key: "clarify-key-1",
          event: {
            type: "assistant.clarification.request",
            bridge_key: "clarify-key-1",
            clarification_id: "skill-setup",
            questions: [],
          },
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(hook.result.current.messages.some((item) =>
        item.parts?.some((part) => part.type === "clarification"),
      )).toBe(true);
    });

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
        json: expect.objectContaining({
          turn_id: "turn-1",
          event: expect.objectContaining({
            type: "assistant.message_parts",
            parts: expect.arrayContaining([
              expect.objectContaining({ type: "clarification" }),
            ]),
          }),
        }),
      })),
    );
    apiPostMock.mockClear();

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "assistant.message",
          scope,
          turn_id: "turn-1",
          message: {
            id: 9,
            role: "assistant",
            content: "The draft has been generated.",
            turn_id: "turn-1",
            created_at: "2026-07-13T08:00:00+00:00",
            parts: [
              {
                id: "skill_studio.draft:draft-key-1",
                type: "skill_studio",
                event: {
                  type: "skill_studio.draft",
                  bridge_key: "draft-key-1",
                  skill_studio_session_id: "studio-1",
                  draft: { skill: { id: "hometown-skill" }, recipes: [] },
                },
              },
            ],
          },
        }),
      } as MessageEvent);
    });

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
        json: expect.objectContaining({
          turn_id: "turn-1",
          event: expect.objectContaining({
            type: "assistant.message_parts",
            parts: expect.arrayContaining([
              expect.objectContaining({ type: "clarification" }),
              expect.objectContaining({ type: "skill_studio" }),
              expect.objectContaining({ type: "text", text: "The draft has been generated." }),
            ]),
          }),
        }),
      })),
    );
  });

  it("closes an active thought part before a canvas command card arrives", async () => {
    apiPostMock.mockClear();
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send() {}
      close() {}
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });

    const hook = renderHook(() =>
      useSuperChat({
        project: "project-a",
        displayName: "Tester",
        surface: "freezone",
        freezoneCanvasId: "canvas-a",
        freezoneAgentId: "agent-2",
      }),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    await waitFor(() => expect(socket.onmessage).toBeTypeOf("function"));
    await act(async () => {
      socket.onopen?.();
    });
    const scope = {
      kind: "project",
      id: "project-a",
      surface: "freezone",
      canvasId: "canvas-a",
      agentId: "agent-2",
    };

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "agent.thought.delta",
          scope,
          turn_id: "turn-1",
          text: "I should inspect the canvas first.",
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      const assistant = hook.result.current.messages.find((item) => item.turnId === "turn-1");
      const thoughtPart = assistant?.parts?.find((part) => part.type === "agent_thought") as
        | { event: unknown }
        | undefined;
      expect(thoughtPart?.event)
        .toMatchObject({ status: "running" });
    });
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
        json: expect.objectContaining({
          turn_id: "turn-1",
          event: expect.objectContaining({
            type: "assistant.message_parts",
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: "agent_thought",
                event: expect.objectContaining({ status: "running" }),
              }),
            ]),
          }),
        }),
      })),
    );
    apiPostMock.mockClear();

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "canvas.command",
          scope,
          turn_id: "turn-1",
          bridge_key: "bridge-1",
          canvas_id: "canvas-a",
          envelope: { schema_version: "canvas_chat_commands.v1", commands: [] },
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      const assistant = hook.result.current.messages.find((item) => item.turnId === "turn-1");
      const thoughtPart = assistant?.parts?.find((part) => part.type === "agent_thought") as
        | { event: unknown }
        | undefined;
      expect(thoughtPart?.event)
        .toMatchObject({ status: "completed" });
    });
    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
        json: expect.objectContaining({
          turn_id: "turn-1",
          event: expect.objectContaining({
            type: "assistant.message_parts",
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: "agent_thought",
                event: expect.objectContaining({ status: "completed" }),
              }),
            ]),
          }),
        }),
      })),
    );
  });

  it("keeps an active thought running across hidden catalog draft tools", async () => {
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send() {}
      close() {}
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });

    const hook = renderHook(() =>
      useSuperChat({
        project: "project-a",
        displayName: "Tester",
        surface: "freezone",
        freezoneCanvasId: "canvas-a",
        freezoneAgentId: "agent-2",
      }),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    await waitFor(() => expect(socket.onmessage).toBeTypeOf("function"));
    await act(async () => {
      socket.onopen?.();
    });
    const scope = {
      kind: "project",
      id: "project-a",
      surface: "freezone",
      canvasId: "canvas-a",
      agentId: "agent-2",
    };

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "agent.thought.delta",
          scope,
          turn_id: "turn-1",
          text: "I should submit the draft chunks.",
        }),
      } as MessageEvent);
      socket.onmessage?.({
        data: JSON.stringify({
          type: "agent.tool.started",
          scope,
          turn_id: "turn-1",
          call_id: "call-1",
          name: "freezone_put_agent_catalog_recipe",
          status: "running",
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      const assistant = hook.result.current.messages.find((item) => item.turnId === "turn-1");
      const parts = assistant?.parts ?? [];
      expect(parts.some((part) => part.type === "tool_status")).toBe(false);
      const thoughtPart = parts.find((part) => part.type === "agent_thought") as
        | { event: unknown }
        | undefined;
      expect(thoughtPart?.event).toMatchObject({ status: "running" });
    });
  });

  it("persists updated draft part state after confirming a Skill Studio draft", async () => {
    apiPostMock.mockClear();
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      sent: string[] = [];
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send(value: string) {
        this.sent.push(value);
      }
      close() {}
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });

    const hook = renderHook(() =>
      useSuperChat({
        project: "project-a",
        displayName: "Tester",
        surface: "freezone",
        freezoneCanvasId: "canvas-a",
        freezoneAgentId: "agent-2",
      }),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    await waitFor(() => expect(socket.onmessage).toBeTypeOf("function"));
    await act(async () => {
      socket.onopen?.();
    });
    const scope = {
      kind: "project",
      id: "project-a",
      surface: "freezone",
      canvasId: "canvas-a",
      agentId: "agent-2",
    };

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "assistant.message",
          scope,
          turn_id: "turn-1",
          message: {
            id: 10,
            role: "assistant",
            content: "The draft has been generated.",
            turn_id: "turn-1",
            created_at: "2026-07-13T08:00:00+00:00",
            parts: [
              {
                id: "skill_studio.draft:draft-key-1",
                type: "skill_studio",
                event: {
                  type: "skill_studio.draft",
                  bridge_key: "draft-key-1",
                  skill_studio_session_id: "studio-1",
                  mode: "create",
                  draft: {
                    summary: "Draft",
                    skill: { id: "saved-skill" },
                    recipes: [{ id: "saved-recipe" }],
                    warnings: [],
                  },
                },
              },
            ],
          },
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      expect(hook.result.current.messages.some((message) =>
        message.parts?.some((part) => part.type === "skill_studio"),
      )).toBe(true);
    });
    apiPostMock.mockClear();

    act(() => {
      const draftPart = hook.result.current.messages
        .flatMap((message) => message.parts ?? [])
        .find((part) => part.type === "skill_studio");
      const draft = draftPart?.type === "skill_studio"
        ? draftPart.event as { type: "skill_studio.draft" }
        : null;
      hook.result.current.updateUiEvent(
        "turn-1",
        (candidate) =>
          Boolean(
            candidate
            && typeof candidate === "object"
            && (candidate as Record<string, unknown>).type === "skill_studio.draft"
            && (candidate as Record<string, unknown>).bridge_key === "draft-key-1",
          ),
        (candidate) => ({
          ...(candidate as Record<string, unknown>),
          submitted: true,
          saved_to_catalog: true,
          saved_skill_ids: ["saved-skill"],
          saved_recipe_ids: ["saved-recipe"],
          action: "confirm_add",
          draft: {
            summary: "Draft",
            skill: { id: "saved-skill" },
            recipes: [{ id: "saved-recipe" }],
            warnings: [],
          },
        }),
      );
      expect(draft?.type).toBe("skill_studio.draft");
    });

    await waitFor(() =>
      expect(apiPostMock).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
        json: expect.objectContaining({
          turn_id: "turn-1",
          event: expect.objectContaining({
            type: "assistant.message_parts",
            parts: expect.arrayContaining([
              expect.objectContaining({
                type: "skill_studio",
                event: expect.objectContaining({
                  type: "skill_studio.draft",
                  submitted: true,
                  saved_to_catalog: true,
                  saved_skill_ids: ["saved-skill"],
                  saved_recipe_ids: ["saved-recipe"],
                }),
              }),
              expect.objectContaining({ type: "text", text: "The draft has been generated." }),
            ]),
          }),
        }),
      })),
    );
  });
});

describe("canvas command bridge events", () => {
  it("passes the current assistant text as the canvas command anchor", () => {
    const received: unknown[] = [];
    const handleEvent = (event: Event) => {
      received.push((event as CustomEvent).detail);
    };
    window.addEventListener(SUPERCHAT_CANVAS_COMMAND_EVENT, handleEvent);

    try {
      dispatchCanvasCommandFrameForTest(
        {
          type: "canvas.command",
          turn_id: "turn-a",
          bridge_key: "bridge-a",
          canvas_id: "canvas-a",
          envelope: { schema_version: "canvas_chat_commands.v1", commands: [] },
        },
        "Updating the video node content...\n",
      );
    } finally {
      window.removeEventListener(SUPERCHAT_CANVAS_COMMAND_EVENT, handleEvent);
    }

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      anchorTextPrefix: "Updating the video node content...\n",
      frame: {
        type: "canvas.command",
        bridge_key: "bridge-a",
      },
    });
  });

  it("keeps one thought segment across skill studio status updates", async () => {
    localStorage.clear();
    apiPostMock.mockClear();
    class TestWebSocket {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror: (() => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;

      constructor() {
        sockets.push(this);
      }

      send() {}
      close() {}
    }
    const sockets: TestWebSocket[] = [];
    Object.defineProperty(globalThis, "WebSocket", {
      value: TestWebSocket,
      writable: true,
      configurable: true,
    });

    const hook = renderHook(() =>
      useSuperChat({
        project: "project-a",
        displayName: "Tester",
        surface: "freezone",
        freezoneCanvasId: "canvas-a",
        freezoneAgentId: "agent-2",
      }),
    );

    await waitFor(() => expect(sockets).toHaveLength(1));
    const socket = sockets[0];
    await waitFor(() => expect(socket.onmessage).toBeTypeOf("function"));
    await act(async () => {
      socket.onopen?.();
    });
    const scope = {
      kind: "project",
      id: "project-a",
      surface: "freezone",
      canvasId: "canvas-a",
      agentId: "agent-2",
    };

    await act(async () => {
      socket.onmessage?.({
        data: JSON.stringify({
          type: "agent.thought.delta",
          scope,
          turn_id: "turn-1",
          text: "Let me submit recipe 1.",
        }),
      } as MessageEvent);
      socket.onmessage?.({
        data: JSON.stringify({
          type: "skill_studio.event",
          scope,
          turn_id: "turn-1",
          bridge_key: "bridge-recipe-1",
          event: {
            type: "skill_studio.status",
            status: "draft_recipe_ready",
            message: "Recipe 1 / 5 generated",
          },
        }),
      } as MessageEvent);
      socket.onmessage?.({
        data: JSON.stringify({
          type: "agent.thought.delta",
          scope,
          turn_id: "turn-1",
          text: " Let me submit recipe 2 now.",
        }),
      } as MessageEvent);
    });

    await waitFor(() => {
      const assistant = hook.result.current.messages.find((item) =>
        item.role === "assistant" && item.turnId === "turn-1");
      const thoughtParts = (assistant?.parts ?? []).filter((
        part,
      ): part is ChatMessagePart & { type: "agent_thought"; event: unknown } =>
        part.type === "agent_thought");
      expect(thoughtParts).toHaveLength(1);
      const thoughtPart = thoughtParts[0];
      expect(thoughtPart?.type).toBe("agent_thought");
      if (thoughtPart?.type !== "agent_thought") return;
      expect(thoughtPart.event).toMatchObject({
        status: "running",
        text: "Let me submit recipe 1. Let me submit recipe 2 now.",
      });
    });
  });
});

describe("tool status parts", () => {
  it("attaches freezone thinking state to the active runtime-only assistant message", () => {
    const messages: ChatMessage[] = [
      {
        id: "assistant-turn-a",
        role: "assistant",
        text: "",
        timestamp: 1,
        turnId: "turn-a",
        parts: [
          { id: "usage", type: "agent_usage", event: { usage: { used: 10 } } },
        ],
      },
    ];

    expect(messageIdForThinkingCanvasContextActivityForTest(messages, "turn-a")).toBe("assistant-turn-a");
  });

  it("treats usage-only assistant messages as runtime activity", () => {
    const message = {
      id: "assistant-turn-a",
      role: "assistant",
      text: "",
      timestamp: 1,
      turnId: "turn-a",
      parts: [
        { id: "usage", type: "agent_usage", event: { usage: { used: 10 } } },
      ],
    } satisfies ChatMessage;

    expect(messageHasAgentRuntimeActivityForTest(message)).toBe(true);
    expect(messageHasVisibleAgentProgressActivityForTest(message)).toBe(false);
  });

  it("does not force assistant messages wide for runtime-only status parts", () => {
    expect(assistantPartsPreferWideLayoutForTest([
      { id: "usage", type: "agent_usage", event: { usage: { used: 10 } } },
      toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-1",
        name: "freezone_skill_list",
        status: "completed",
      }, "turn-a"),
      { id: "text", type: "text", text: "Hello, this is an ordinary reply." },
    ])).toBe(false);
  });

  it("keeps assistant messages wide for structured cards", () => {
    expect(assistantPartsPreferWideLayoutForTest([
      { id: "text", type: "text", text: "Please confirm the operation below." },
      { id: "approval", type: "canvas_approval", event: { id: "approval-a" } },
    ])).toBe(true);
  });

  it("uses the ACP call id to update one tool lifecycle card", () => {
    const started = toolStatusPartForTest("agent.tool.started", {
      type: "agent.tool.started",
      turn_id: "turn-a",
      call_id: "call-1",
      name: "read_file",
      status: "pending",
    }, "turn-a");
    const completed = toolStatusPartForTest("agent.tool.updated", {
      type: "agent.tool.updated",
      turn_id: "turn-a",
      call_id: "call-1",
      name: "read_file",
      status: "completed",
    }, "turn-a");

    expect(started.id).toBe("tool_status:turn-a:call-1");
    expect(completed.id).toBe(started.id);

    const messages = upsertRuntimePartInMessagesForTest([], "turn-a", started);
    const updated = upsertRuntimePartInMessagesForTest(messages, "turn-a", completed);
    expect(updated).toHaveLength(1);
    expect(updated[0]?.parts).toHaveLength(1);
    expect(updated[0]?.parts?.[0]).toEqual(completed);
  });

  it("preserves runtime part ordering when a tool lifecycle card updates", () => {
    const started = {
      ...toolStatusPartForTest("agent.tool.started", {
        type: "agent.tool.started",
        turn_id: "turn-a",
        call_id: "call-1",
        name: "read_file",
        status: "pending",
      }, "turn-a"),
      seq: 7,
    };
    const completed = toolStatusPartForTest("agent.tool.updated", {
      type: "agent.tool.updated",
      turn_id: "turn-a",
      call_id: "call-1",
      name: "read_file",
      status: "completed",
    }, "turn-a");

    const messages = upsertRuntimePartInMessagesForTest([], "turn-a", started);
    const updated = upsertRuntimePartInMessagesForTest(messages, "turn-a", completed);

    expect(updated[0]?.parts?.[0]).toMatchObject({
      id: started.id,
      seq: 7,
    });
  });

  it("merges adjacent agent thought parts into one runtime item", () => {
    const merged = mergeAdjacentAgentThoughtPartsForTest([
      {
        id: "thought-1",
        type: "agent_thought",
        seq: 1,
        event: { text: "First understand the user's needs.", status: "completed" },
      },
      {
        id: "thought-2",
        type: "agent_thought",
        seq: 2,
        event: { text: "Then check the canvas state.", status: "running" },
      },
      toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-1",
        name: "freezone_run_node_action",
        status: "completed",
      }, "turn-a"),
      {
        id: "thought-3",
        type: "agent_thought",
        seq: 4,
        event: { text: "Finally compose the reply.", status: "completed" },
      },
    ]);

    expect(merged).toHaveLength(3);
    expect(merged[0]).toMatchObject({
      id: "thought-1+thought-2",
      type: "agent_thought",
      seq: 1,
      event: {
        text: "First understand the user's needs.\n\nThen check the canvas state.",
        status: "running",
      },
    });
    expect(merged[2]).toMatchObject({ id: "thought-3" });
  });

  it("merges adjacent tool status parts with the same display into one runtime item", () => {
    const merged = mergeAdjacentToolStatusPartsForTest([
      toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-1",
        name: "freezone_get_saved_recipe",
        status: "completed",
      }, "turn-a"),
      toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-2",
        name: "freezone_get_saved_recipe",
        status: "completed",
      }, "turn-a"),
      toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-3",
        name: "freezone_list_agent_catalog",
        status: "completed",
      }, "turn-a"),
    ]);

    expect(merged).toHaveLength(2);
    expect(merged[0]).toMatchObject({
      id: "tool_status:turn-a:call-1+tool_status:turn-a:call-2",
      type: "tool_status",
      repeatCount: 2,
    });
    expect(merged[1]).toMatchObject({
      id: "tool_status:turn-a:call-3",
    });
    expect("repeatCount" in (merged[1] ?? {})).toBe(false);
  });

  it("uses friendly labels for Skill Studio catalog draft tools", () => {
    const part = toolStatusPartForTest("agent.tool.updated", {
      type: "agent.tool.updated",
      turn_id: "turn-a",
      call_id: "call-1",
      name: "freezone_put_agent_catalog_draft_outline",
      status: "completed",
    }, "turn-a");

    expect(genericToolTitleForTest((part as { event: ChatMessage }).event)).toBe("Outline Skill plan");
  });

  it("uses a lightweight retry label for failed Skill Studio outline status", () => {
    const part = toolStatusPartForTest("agent.tool.updated", {
      type: "agent.tool.updated",
      turn_id: "turn-a",
      call_id: "call-1",
      name: "freezone_put_agent_catalog_draft_outline",
      status: "failed",
    }, "turn-a");
    const toolMessage = (part as { event: ChatMessage }).event;

    expect(toolStatusRuntimeTextForTest({
      status: "failed",
      title: genericToolTitleForTest(toolMessage),
      toolMessage,
    })).toBe("Skill plan needs to be outlined again");
  });

  it("uses friendly labels for Workflow Skill draft tool status", () => {
    const prepareCompleted = (toolStatusPartForTest("agent.tool.updated", {
      type: "agent.tool.updated",
      turn_id: "turn-a",
      call_id: "call-prepare",
      name: "freezone_prepare_workflow_draft",
      status: "completed",
    }, "turn-a") as { event: ChatMessage }).event;
    const prepareFailed = (toolStatusPartForTest("agent.tool.updated", {
      type: "agent.tool.updated",
      turn_id: "turn-a",
      call_id: "call-prepare-failed",
      name: "freezone_prepare_workflow_draft",
      status: "failed",
    }, "turn-a") as { event: ChatMessage }).event;
    const confirmCompleted = (toolStatusPartForTest("agent.tool.updated", {
      type: "agent.tool.updated",
      turn_id: "turn-a",
      call_id: "call-confirm",
      name: "freezone_confirm_workflow_draft",
      status: "completed",
    }, "turn-a") as { event: ChatMessage }).event;

    expect(toolStatusRuntimeTextForTest({
      status: "done",
      title: genericToolTitleForTest(prepareCompleted),
      toolMessage: prepareCompleted,
    })).toBe("Generate workflow draft done");
    expect(toolStatusRuntimeTextForTest({
      status: "failed",
      title: genericToolTitleForTest(prepareFailed),
      toolMessage: prepareFailed,
    })).toBe("Workflow draft needs to be regenerated");
    expect(toolStatusRuntimeTextForTest({
      status: "done",
      title: genericToolTitleForTest(confirmCompleted),
      toolMessage: confirmCompleted,
    })).toBe("Submit to canvas done");
  });

  it("renders workflow parameter handoff as waiting instead of failed", () => {
    const waiting = (toolStatusPartForTest("agent.tool.updated", {
      type: "agent.tool.updated",
      turn_id: "turn-a",
      call_id: "call-waiting",
      name: "freezone_prepare_workflow_draft",
      status: "failed",
      input: { operation_id: "operation-a" },
      result: {
        ok: false,
        status: "clarification_required",
        code: "generation_parameters_required",
      },
    }, "turn-a") as { event: ChatMessage }).event;

    expect(toolStatusRuntimeTextForTest({
      status: "failed",
      title: genericToolTitleForTest(waiting),
      toolMessage: waiting,
    })).toBe("Waiting for generation parameters");
  });

  it("hides a superseded parameter handoff after the same draft operation succeeds", () => {
    const waiting = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-waiting",
        name: "freezone_prepare_workflow_draft",
        status: "failed",
        input: { operation_id: "operation-a" },
        result: {
          ok: false,
          status: "clarification_required",
          code: "generation_parameters_required",
        },
      }, "turn-a"),
      seq: 1,
    };
    const ready = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-ready",
        name: "freezone_prepare_workflow_draft",
        status: "completed",
        input: { operation_id: "operation-a" },
        result: { ok: true, status: "workflow_draft_ready", draft_id: "draft-a" },
      }, "turn-a"),
      seq: 2,
    };

    const visible = agentRuntimeDisplayPartsForTest([waiting, ready], { streaming: false });

    expect(visible.map((part) => part.id)).toEqual(["tool_status:turn-a:call-ready"]);
  });

  it("hides non-failed tool status parts when replaying historical runtime activity", () => {
    const runningTool = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-running",
        name: "freezone_put_agent_catalog_recipe",
        status: "running",
      }, "turn-a"),
      seq: 1,
    };
    const completedTool = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-completed",
        name: "freezone_put_agent_catalog_recipe",
        status: "completed",
      }, "turn-a"),
      seq: 2,
    };
    const failedTool = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-failed",
        name: "freezone_put_agent_catalog_recipe",
        status: "failed",
        error: "Submission failed",
      }, "turn-a"),
      seq: 3,
    };
    const thought: ChatMessagePart = {
      id: "thought-a",
      type: "agent_thought",
      seq: 4,
      event: { text: "Keep organizing the draft.", status: "running" },
    };

    const historical = agentRuntimeDisplayPartsForTest(
      [runningTool, completedTool, failedTool, thought],
      { streaming: false },
    );
    const streaming = agentRuntimeDisplayPartsForTest(
      [runningTool, completedTool, failedTool, thought],
      { streaming: true },
    );

    expect(historical.map((part) => part.id)).toEqual(["tool_status:turn-a:call-failed", "thought-a"]);
    expect(streaming.map((part) => part.id)).toEqual([
      "tool_status:turn-a:call-running+tool_status:turn-a:call-completed",
      "tool_status:turn-a:call-failed",
      "thought-a",
    ]);
  });

  it("keeps settled Skill Studio catalog tool status visible after the response completes", () => {
    const regularCompletedTool = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-regular",
        name: "read_file",
        status: "completed",
      }, "turn-a"),
      seq: 1,
    };
    const catalogCompletedTool = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-catalog",
        name: "freezone_list_agent_catalog",
        status: "completed",
      }, "turn-a"),
      seq: 2,
    };
    const outlineCompletedTool = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-outline",
        name: "freezone_put_agent_catalog_draft_outline",
        status: "completed",
      }, "turn-a"),
      seq: 3,
    };

    expect(agentRuntimeDisplayPartsForTest(
      [regularCompletedTool, catalogCompletedTool, outlineCompletedTool],
      { streaming: false },
    ).map((part) => part.id)).toEqual([
      "tool_status:turn-a:call-catalog",
      "tool_status:turn-a:call-outline",
    ]);
  });

  it("keeps settled Workflow Skill tool status visible after the response completes", () => {
    const nativeSkillTool = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-native-skill",
        name: "skill",
        status: "completed",
      }, "turn-a"),
      seq: 1,
    };
    const workflowSkillTool = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-skill",
        name: "freezone_get_workflow_skill",
        status: "completed",
      }, "turn-a"),
      seq: 2,
    };
    const prepareWorkflowTool = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-prepare",
        name: "freezone_prepare_workflow_draft",
        status: "completed",
      }, "turn-a"),
      seq: 3,
    };
    const confirmWorkflowTool = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-confirm",
        name: "freezone_confirm_workflow_draft",
        status: "completed",
      }, "turn-a"),
      seq: 4,
    };

    expect(agentRuntimeDisplayPartsForTest(
      [nativeSkillTool, workflowSkillTool, prepareWorkflowTool, confirmWorkflowTool],
      { streaming: false },
    ).map((part) => part.id)).toEqual([
      "tool_status:turn-a:call-native-skill",
      "tool_status:turn-a:call-skill",
      "tool_status:turn-a:call-prepare",
      "tool_status:turn-a:call-confirm",
    ]);
  });

  it("shows the delivered plan draft and hides a duplicate failure for the same operation", () => {
    const failedDuplicate = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-failed",
        name: "dramaclaw.freezone_prepare_workflow_plan_draft",
        status: "failed",
        input: { operation_id: "operation-a" },
        error: "aggregate workflow planning text exceeds 4000 characters",
      }, "turn-a"),
      seq: 1,
    };
    const deliveredDraft = {
      ...toolStatusPartForTest("agent.tool.updated", {
        type: "agent.tool.updated",
        turn_id: "turn-a",
        call_id: "call-completed",
        name: "dramaclaw.freezone_prepare_workflow_plan_draft",
        status: "completed",
        input: { operation_id: "operation-a" },
        output: { ok: true, status: "workflow_draft_ready", draft_id: "draft-a" },
      }, "turn-a"),
      seq: 2,
    };

    expect(agentRuntimeDisplayPartsForTest(
      [failedDuplicate, deliveredDraft],
      { streaming: false },
    ).map((part) => part.id)).toEqual([
      "tool_status:turn-a:call-completed",
    ]);
  });

  it("hides settled tool status once a Skill Studio surface is present", () => {
    const skillStudioPart: ChatMessagePart = {
      id: "skill-studio-draft",
      type: "skill_studio",
      event: {
        type: "skill_studio.draft",
        skill_studio_session_id: "studio-1",
      },
    };
    const completedTool = toolStatusPartForTest("agent.tool.updated", {
      type: "agent.tool.updated",
      turn_id: "turn-a",
      call_id: "call-completed",
      name: "freezone_put_agent_catalog_recipe",
      status: "completed",
    }, "turn-a");

    const hideWithoutSkillStudio = assistantRuntimeShouldHideSettledToolStatusForTest([completedTool]);
    const hideWithSkillStudio = assistantRuntimeShouldHideSettledToolStatusForTest([completedTool, skillStudioPart]);

    expect(hideWithoutSkillStudio).toBe(false);
    expect(hideWithSkillStudio).toBe(true);
    expect(agentRuntimeDisplayPartsForTest([completedTool], {
      streaming: true,
      hideSettledToolStatus: hideWithSkillStudio,
    })).toEqual([]);
  });

  it("keeps runtime activity live while only Skill Studio progress status is present", () => {
    const statusPart: ChatMessagePart = {
      id: "skill-studio-status",
      type: "skill_studio",
      event: {
        type: "skill_studio.status",
        status: "routing",
        message: "Organizing the Skill direction...",
      },
    };
    const thought: ChatMessagePart & { type: "agent_thought"; event: unknown } = {
      id: "thought-a",
      type: "agent_thought",
      event: { text: "I need to read the canvas details.", status: "running" },
    };
    const hideSettledToolStatus = assistantRuntimeShouldHideSettledToolStatusForTest([statusPart, thought]);

    expect(hideSettledToolStatus).toBe(false);
    expect(agentThoughtRuntimePresentationForTest(thought, { streaming: true })).toMatchObject({
      label: "Thinking",
      initiallyExpanded: true,
    });
  });

  it("hides Skill Studio progress status once a draft surface is present in ordered parts", () => {
    const assistant: ChatMessage = {
      id: "assistant-1",
      role: "assistant",
      text: "Okay, I will resubmit this draft; after previewing it you can confirm saving or keep editing.",
      timestamp: Date.now(),
      parts: [
        {
          id: "text-1",
          type: "text",
          text: "Okay, I will resubmit this draft; after previewing it you can confirm saving or keep editing.",
          seq: 1,
        },
        {
          id: "skill-status-1",
          type: "skill_studio",
          seq: 2,
          event: {
            type: "skill_studio.status",
            status: "draft_recipe_ready",
            message: "Recipe 1 / 5 generated",
          },
        },
        {
          id: "skill-draft-1",
          type: "skill_studio",
          seq: 3,
          event: {
            type: "skill_studio.draft",
            skill_studio_session_id: "studio-1",
            submitted: true,
            cancelled: true,
          },
        },
      ],
    };

    expect(visibleAssistantOrderedPartsForMessageForTest(assistant).map((part) => part.id)).toEqual([
      "text-1",
      "skill-draft-1",
    ]);
  });

  it("resolves reused Skill Studio recipes from allowed ids without duplicating draft recipes", () => {
    const referenced = skillStudioReferencedRecipesForTest(
      {
        allowed_recipe_ids: [
          "drama-character-turnaround",
          "video-storyboard-grid",
          "new-recipe",
          "missing-recipe",
        ],
      },
      [{ id: "new-recipe", name: "New Recipe" }],
      [
        {
          id: "drama-character-turnaround",
          name: "Character multi-angle illustration",
          description: "Character settings and turnaround",
          output_kind: "image",
          action_keys: ["character-turnaround"],
          system_prompt: "Generate a character multi-angle template",
          must_have_items: ["Front", "Side"],
          planning_prompt: "Organize the character appearance",
          result_summary: "Character template",
          requires_source_media: true,
          force_enhancement: true,
          skip_detail_check: true,
        },
        {
          id: "video-storyboard-grid",
          name: "Multi-grid storyboard",
          result_summary: "Storyboard sketch",
          output_kind: "image",
        },
      ],
    );

    expect(referenced).toEqual([
      {
        id: "drama-character-turnaround",
        name: "Character multi-angle illustration",
        outputKind: "image",
        actionKeys: ["character-turnaround"],
        systemPrompt: "Generate a character multi-angle template",
        mustHaveItems: ["Front", "Side"],
        planningPrompt: "Organize the character appearance",
        resultSummary: "Character template",
        requiresSourceMedia: true,
        enabled: true,
        forceEnhancement: true,
        skipDetailCheck: true,
        missing: false,
      },
      {
        id: "video-storyboard-grid",
        name: "Multi-grid storyboard",
        outputKind: "image",
        actionKeys: [],
        systemPrompt: "",
        mustHaveItems: [],
        planningPrompt: "",
        resultSummary: "Storyboard sketch",
        requiresSourceMedia: false,
        enabled: true,
        forceEnhancement: false,
        skipDetailCheck: false,
        missing: false,
      },
      {
        id: "missing-recipe",
        name: "",
        outputKind: "",
        actionKeys: [],
        systemPrompt: "",
        mustHaveItems: [],
        planningPrompt: "",
        resultSummary: "",
        requiresSourceMedia: false,
        enabled: true,
        forceEnhancement: false,
        skipDetailCheck: false,
        missing: true,
      },
    ]);
  });

  it("collapses running thought parts when they are shown from history", () => {
    const thought: ChatMessagePart & { type: "agent_thought"; event: unknown } = {
      id: "thought-a",
      type: "agent_thought",
      event: { text: "Keep organizing the draft.", status: "running" },
    };

    expect(agentThoughtRuntimePresentationForTest(thought, { streaming: false })).toMatchObject({
      label: "Thought process",
      initiallyExpanded: false,
    });
    expect(agentThoughtRuntimePresentationForTest(thought, { streaming: true })).toMatchObject({
      label: "Thinking",
      initiallyExpanded: true,
    });
  });

  it("keeps repeated calls to the same tool separate", () => {
    const first = toolStatusPartForTest("agent.tool.started", {
      type: "agent.tool.started",
      turn_id: "turn-a",
      call_id: "call-1",
      name: "read_file",
    }, "turn-a");
    const second = toolStatusPartForTest("agent.tool.started", {
      type: "agent.tool.started",
      turn_id: "turn-a",
      call_id: "call-2",
      name: "read_file",
    }, "turn-a");

    const messages = upsertRuntimePartInMessagesForTest(
      upsertRuntimePartInMessagesForTest([], "turn-a", first),
      "turn-a",
      second,
    );
    expect(messages[0]?.parts?.map((part) => part.id)).toEqual([
      "tool_status:turn-a:call-1",
      "tool_status:turn-a:call-2",
    ]);
  });

  it("does not render hidden canvas write tool calls as assistant status parts", () => {
    expect(shouldRenderToolStatusPart({
      type: "tool.call",
      turn_id: "turn-a",
      name: "freezone_create_node",
      arguments: { node_type: "imageGenNode" },
    })).toBe(false);
  });

  it("does not render direct hidden canvas write tool results as assistant status parts", () => {
    expect(shouldRenderToolStatusPart({
      type: "tool.result",
      turn_id: "turn-a",
      name: "freezone_create_node",
      result: "Node created",
    })).toBe(false);
  });

  it("does not render clarification request tools as assistant status parts", () => {
    expect(shouldRenderAgentToolStatusPart({
      type: "agent.tool.started",
      turn_id: "turn-a",
      name: "freezone_request_user_clarification",
      status: "running",
    })).toBe(false);
  });

  it("does not render node detail reads as assistant status parts", () => {
    expect(shouldRenderAgentToolStatusPart({
      type: "agent.tool.started",
      turn_id: "turn-a",
      name: "freezone_get_node_detail",
      status: "running",
    })).toBe(false);
  });

  it("does not render bridged canvas ontology reads as assistant status parts", () => {
    expect(shouldRenderAgentToolStatusPart({
      type: "agent.tool.started",
      turn_id: "turn-a",
      name: "freezone_get_canvas_ontology",
      status: "running",
    })).toBe(false);
  });

  it.each([
    "tool_search",
    "Tool Search",
    "tool-describe",
    "ToolDescribe",
  ])("does not render internal %s tool status parts", (name) => {
    expect(shouldRenderAgentToolStatusPart({
      type: "agent.tool.started",
      turn_id: "turn-a",
      name,
      status: "running",
    })).toBe(false);
  });

  it.each([
    "freezone_begin_agent_catalog_draft",
    "freezone_put_agent_catalog_skill",
    "freezone_put_agent_catalog_recipe",
    "freezone_finish_agent_catalog_draft",
  ])("does not render %s as assistant status parts", (name) => {
    expect(shouldRenderAgentToolStatusPart({
      type: "agent.tool.started",
      turn_id: "turn-a",
      name,
      status: "running",
    })).toBe(false);
  });

  it.each([
    "freezone_list_agent_catalog",
    "freezone_get_saved_skill",
    "freezone_get_saved_recipe",
  ])("renders %s as readable assistant status parts", (name) => {
    expect(shouldRenderAgentToolStatusPart({
      type: "agent.tool.started",
      turn_id: "turn-a",
      name,
      status: "running",
    })).toBe(true);
  });

  it("does not render canvas command result payloads as assistant status parts", () => {
    expect(shouldRenderToolStatusPart({
      type: "tool.result",
      turn_id: "turn-a",
      name: "freezone_emit_canvas_command",
      result: JSON.stringify({
        envelope: { schema_version: "canvas_chat_commands.v1", commands: [] },
      }),
    })).toBe(false);
  });
});

describe("agent permission options", () => {
  const approval = {
    id: "permission-a",
    kind: "agent" as const,
    title: "Run command",
    options: [
      { optionId: "allow_once", kind: "allow_once", name: "Allow once" },
      { optionId: "allow_session", kind: "allow_always", name: "Allow for session" },
      { optionId: "allow_always", kind: "allow_always", name: "Allow always" },
      { optionId: "deny", kind: "reject_once", name: "Deny" },
    ],
  };

  it("does not confuse session access with permanent access", () => {
    expect(approvalOptionIdForTest(approval, "allow-always")).toBe("allow_always");
    expect(approvalOptionIdForTest(approval, { optionId: "allow_session" })).toBe("allow_session");
    expect(approvalOptionIdForTest(approval, { optionId: "unknown" })).toBe("");
  });
});

describe("canvas context bridge results", () => {
  it("preserves canvas_context_status in the websocket frame", () => {
    const frame = canvasContextToolResultFrameForTest({
      type: "canvas.context.result",
      turn_id: "turn-a",
      bridge_key: "bridge-a",
      project_id: "project-a",
      canvas_id: "canvas-a",
      tool_call_status: "completed",
      canvas_context_status: "resolved",
      ok: true,
      responses: [],
      errors: [],
      message: "ok",
    });

    expect(frame).toMatchObject({
      type: "canvas.context.result",
      canvas_context_status: "resolved",
    });
  });
});

describe("sanitizeMessagesForCache", () => {
  it("strips attachment inline content but keeps metadata and raw", () => {
    const original: ChatMessage = {
      id: "m1",
      role: "user",
      text: "See the image",
      timestamp: 1,
      raw: { keep: "me" },
      attachments: [
        {
          fileName: "a.png",
          mimeType: "image/png",
          fileSize: 1234,
          url: "https://example/a.png",
          path: "/a.png",
          content: "data:image/png;base64,AAAA",
        },
      ],
    };

    const [sanitized] = sanitizeMessagesForCache([original]);

    expect(sanitized.attachments?.[0].content).toBeUndefined();
    expect(sanitized.attachments?.[0].fileName).toBe("a.png");
    expect(sanitized.attachments?.[0].url).toBe("https://example/a.png");
    expect(sanitized.raw).toEqual({ keep: "me" });
    // The original message must not be mutated.
    expect(original.attachments?.[0].content).toBe("data:image/png;base64,AAAA");
  });

  it("leaves messages without attachments or raw untouched", () => {
    const original: ChatMessage = { id: "m1", role: "user", text: "hi", timestamp: 1 };
    expect(sanitizeMessagesForCache([original])[0]).toBe(original);
  });

  it("keeps agent runtime details in the recovery cache for history replay", () => {
    const original: ChatMessage = {
      id: "assistant-turn-a",
      role: "assistant",
      text: "Done",
      timestamp: 1,
      parts: [
        { id: "plan", type: "agent_plan", event: { entries: [] } },
        { id: "thought", type: "agent_thought", event: { text: "private reasoning" } },
        { id: "usage", type: "agent_usage", event: { usage: { used: 10 } } },
        {
          id: "tool",
          type: "tool_status",
          event: { raw: { output: { large: "payload" } } },
        },
      ],
    };

    const [sanitized] = sanitizeMessagesForCache([original]);

    expect(sanitized.parts?.map((part) => part.type)).toEqual([
      "agent_plan",
      "agent_thought",
      "agent_usage",
      "tool_status",
    ]);
  });

  it("drops raw ACP tool payloads from the recovery cache", () => {
    const original: ChatMessage = {
      id: "agent-tool-call-1",
      role: "tool",
      text: "Read complete",
      timestamp: 1,
      raw: { output: { large: "payload" } },
    };

    const [sanitized] = sanitizeMessagesForCache([original]);

    expect(sanitized.raw).toBeUndefined();
    expect(sanitized.text).toBe("Read complete");
  });

  it("de-nests raw so it can't grow across load→save cycles", () => {
    // After one round-trip, normalizeMessage stores the prior normalized
    // message under raw — which itself carries a raw field. Caching must drop
    // that inner raw so depth never exceeds 1.
    const serverPayload = { content: "<ui-spec>{}</ui-spec>" };
    const roundTripped: ChatMessage = {
      id: "m1",
      role: "assistant",
      text: "hi",
      timestamp: 1,
      raw: { id: "m1", role: "assistant", text: "hi", raw: serverPayload },
    };

    const [sanitized] = sanitizeMessagesForCache([roundTripped]);
    const raw = sanitized.raw as Record<string, unknown>;

    expect("raw" in raw).toBe(false);
    expect(raw.text).toBe("hi");
    // Re-sanitizing stays flat (stable fixpoint, no unbounded growth).
    const reSanitized = sanitizeMessagesForCache([
      { ...sanitized, raw: { ...raw, raw: serverPayload } },
    ]);
    expect("raw" in (reSanitized[0].raw as Record<string, unknown>)).toBe(false);
  });
});

describe("pruneOldMessageCaches", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("removes expired, legacy, and malformed caches but keeps fresh ones", () => {
    const now = 10 * DAY_MS;
    localStorage.setItem(
      `${MESSAGE_CACHE_PREFIX}fresh`,
      JSON.stringify({ updatedAt: now - DAY_MS, messages: [] }),
    );
    localStorage.setItem(
      `${MESSAGE_CACHE_PREFIX}stale`,
      JSON.stringify({ updatedAt: now - 8 * DAY_MS, messages: [] }),
    );
    // Legacy bare-array format has no updatedAt → reclaimed.
    localStorage.setItem(`${MESSAGE_CACHE_PREFIX}legacy`, JSON.stringify([{ id: "x" }]));
    localStorage.setItem(`${MESSAGE_CACHE_PREFIX}broken`, "{not json");
    localStorage.setItem("unrelated:key", "keep-me");

    pruneOldMessageCaches(now);

    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}fresh`)).not.toBeNull();
    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}stale`)).toBeNull();
    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}legacy`)).toBeNull();
    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}broken`)).toBeNull();
    expect(localStorage.getItem("unrelated:key")).toBe("keep-me");
  });

  it("reclaims caches with a future timestamp (clock skew / corruption)", () => {
    const now = 10 * DAY_MS;
    localStorage.setItem(
      `${MESSAGE_CACHE_PREFIX}future`,
      JSON.stringify({ updatedAt: now + DAY_MS, messages: [] }),
    );
    pruneOldMessageCaches(now);
    expect(localStorage.getItem(`${MESSAGE_CACHE_PREFIX}future`)).toBeNull();
  });
});

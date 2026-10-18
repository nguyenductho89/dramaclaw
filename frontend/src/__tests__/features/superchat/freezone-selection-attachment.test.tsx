import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { buildCanvasOntologyContext } from "@/features/canvas/ontology/canvasOntology";
import { SuperChatPanel } from "@/features/superchat/superchat-panel";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";
import {
  buildCanvasNodeReferenceAttachment,
  canvasNodeReferenceAttachmentNodes,
  isCanvasNodeReferenceAttachment,
} from "@/features/freezone/chatNodeReferences";
import type { ChatAttachment, ChatMessage } from "@/features/superchat/types";
import { useCanvasStore } from "@/stores/canvasStore";

const superChatMocks = vi.hoisted(() => ({
  send: vi.fn(async () => true),
  appendNotification: vi.fn(async () => undefined),
  messages: [] as ChatMessage[],
  busy: false,
  activeTurnId: null as string | null,
  showToolEvents: false,
  replaceAssistantMessagePart: vi.fn(),
}));

const eventBusMocks = vi.hoisted(() => ({
  on: vi.fn(() => vi.fn()),
}));

const apiMocks = vi.hoisted(() => ({
  post: vi.fn(() => Promise.resolve()),
}));

const imageModelMocks = vi.hoisted(() => ({
  result: {
    models: [
      {
        id: "existing-model",
        providerId: "newapi",
        apiModel: "existing-model",
        label: "Quality-capable model",
        qualityOptions: ["low", "medium", "high"],
      },
      {
        id: "seedream-4.5",
        providerId: "newapi",
        apiModel: "seedream-4.5",
        label: "Seedream 4.5",
      },
    ],
    isLoading: false,
    isFallback: false,
    error: null,
  },
}));

function getFreezoneComposerTextbox(): HTMLElement {
  return screen.getByRole("textbox", {
    name: "Tell Xia Draw what to create or where to refine",
  });
}

function setFreezoneComposerText(input: HTMLElement, value: string): void {
  input.textContent = value;
  fireEvent.input(input);
}

vi.mock("react-i18next", async () => {
  const { enTranslation } = await import("../../helpers/i18n-fixtures");
  const lookup = (key: string): unknown =>
    key.split(".").reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], enTranslation);
  return {
    initReactI18next: {
      type: "3rdParty",
      init: vi.fn(),
    },
    useTranslation: () => ({
      t: (key: string, options?: Record<string, unknown>) => {
        const found = lookup(key);
        const template = typeof found === "string"
          ? found
          : (typeof options?.defaultValue === "string" ? options.defaultValue : key);
        return template.replace(/{{(\w+)}}/g, (_match, name: string) => String(options?.[name] ?? ""));
      },
    }),
  };
});

vi.mock("@tanstack/react-router", () => ({
  useParams: () => ({ project: "project-a" }),
}));

vi.mock("@tanstack/react-query", () => ({
  useMutation: () => ({
    mutateAsync: vi.fn(),
    isPending: false,
  }),
  useQuery: () => ({
    data: undefined,
    isLoading: false,
    isError: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
  }),
}));

vi.mock("@/task-center/event-bus-context", () => ({
  useEventBus: () => ({
    on: eventBusMocks.on,
  }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    post: apiMocks.post,
  },
}));

vi.mock("@/features/canvas/hooks/useFreezoneImageModels", () => ({
  useFreezoneImageModels: () => imageModelMocks.result,
  getFreezoneImageModelsSnapshot: () => imageModelMocks.result,
}));

vi.mock("@/api/projects", () => ({
  listCharacters: vi.fn(async () => []),
  listFreezoneProjectAssets: vi.fn(async () => []),
}));

vi.mock("border-beam-vanilla", () => ({
  attachBorderBeam: () => ({ destroy: vi.fn() }),
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("dramaclaw-spec-render", () => ({
  SpecRenderer: () => null,
  SpecRendererProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  VideoDetailModal: () => null,
}));

vi.mock("@/features/superchat/use-superchat", () => ({
  SUPERCHAT_CANVAS_COMMAND_EVENT: "superchat/canvas-command",
  SUPERCHAT_CANVAS_CONTEXT_REQUEST_EVENT: "superchat/canvas-context-request",
  useSuperChat: () => ({
    abort: vi.fn(),
    approvals: [],
    activeTurnId: superChatMocks.activeTurnId,
    busy: superChatMocks.busy,
    connected: true,
    connecting: false,
    error: null,
    activeModel: null,
    clearPinned: vi.fn(),
    deleteMessage: vi.fn(),
    deletedIds: new Set<string>(),
    historyHasMore: false,
    historyLoadingOlder: false,
    historyReady: true,
    loadOlderHistory: vi.fn(),
    messages: superChatMocks.messages,
    models: [],
    modelsLoading: false,
    requestHistory: vi.fn(),
    refreshModels: vi.fn(),
    refreshRelayInstances: vi.fn(),
    relayInstances: [],
    resolveApproval: vi.fn(),
    selectRelayInstance: vi.fn(),
    appendNotification: superChatMocks.appendNotification,
    send: superChatMocks.send,
    selectedInstanceId: "",
    sessionControl: vi.fn(),
    setSettings: vi.fn(),
    settings: {
      showToolEvents: superChatMocks.showToolEvents,
      showStructuredSourceWhileStreaming: false,
      uploadTarget: "openclaw",
    },
    pinnedIds: new Set<string>(),
    streamText: "",
    switchModel: vi.fn(),
    togglePin: vi.fn(),
    upsertAssistantMessagePart: vi.fn(),
    removeAssistantMessagePart: vi.fn(),
    replaceAssistantMessagePart: superChatMocks.replaceAssistantMessagePart,
  }),
}));

describe("SuperChatPanel Freezone selection attachment state", () => {
  beforeAll(() => {
    Object.defineProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value: vi.fn(),
    });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(document, "execCommand", {
      configurable: true,
      value: vi.fn(() => true),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    superChatMocks.send.mockClear();
    superChatMocks.appendNotification.mockClear();
    superChatMocks.messages = [];
    superChatMocks.busy = false;
    superChatMocks.activeTurnId = null;
    superChatMocks.showToolEvents = false;
    eventBusMocks.on.mockClear();
    apiMocks.post.mockClear();
    useCanvasStore.getState().setCanvasData([], []);
    useCanvasStore.getState().setSelectedNode(null);
  });

  it("uses the dedicated Xia Draw placeholder in freezone mode", () => {
    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(getFreezoneComposerTextbox()).toBeInTheDocument();
    expect(screen.getByText("Tell Xia Draw what to create or where to refine")).toBeInTheDocument();
  });

  it("renders Freezone-only header actions when provided", () => {
    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
        freezoneHeaderActions={<button type="button">History Agent</button>}
      />,
    );

    expect(screen.getByRole("button", { name: "History Agent" })).toBeInTheDocument();
  });

  it("does not append global task completion notifications in freezone mode", async () => {
    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(eventBusMocks.on).not.toHaveBeenCalledWith("*", expect.any(Function));
    expect(superChatMocks.appendNotification).not.toHaveBeenCalled();
  });

  it("does not show a selected canvas node as current-turn context after its attachment was consumed", () => {
    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[
          {
            nodeId: "image-node-1",
            nodeType: "imageNode",
            label: "Image node",
          },
        ]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.queryByText("Used this turn")).not.toBeInTheDocument();
    expect(screen.queryByText("Image node")).not.toBeInTheDocument();
  });

  it("lets the user remove a selected canvas node from current-turn context", () => {
    const node = {
      id: "image-node-1",
      type: "imageNode",
      position: { x: 0, y: 0 },
      selected: true,
      data: {
        title: "Image node",
      },
    } satisfies Partial<CanvasNode> as CanvasNode;

    useCanvasStore.getState().setCanvasData([node], []);
    useCanvasStore.getState().setSelectedNode(node.id);

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [node.id],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.getByText("Used this turn")).toBeInTheDocument();

    const removeButton = screen.getByLabelText("Remove canvas reference");
    expect(removeButton).toHaveClass("opacity-0");
    expect(removeButton).toHaveClass("group-hover:opacity-100");

    fireEvent.click(removeButton);

    expect(screen.queryByText("Used this turn")).not.toBeInTheDocument();
    expect(useCanvasStore.getState().nodes[0]?.selected).toBe(false);
    expect(useCanvasStore.getState().selectedNodeId).toBeNull();
  });

  it("lets the user remove all selected canvas nodes from current-turn context", () => {
    const nodes = [
      {
        id: "image-node-1",
        type: "imageNode",
        position: { x: 0, y: 0 },
        selected: true,
        data: { title: "Image node A" },
      },
      {
        id: "image-node-2",
        type: "imageNode",
        position: { x: 220, y: 0 },
        selected: true,
        data: { title: "Image node B" },
      },
    ] satisfies Partial<CanvasNode>[] as CanvasNode[];

    useCanvasStore.getState().setCanvasData(nodes, []);
    useCanvasStore.getState().setSelectedNode(nodes[0].id);

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: nodes.map((node) => node.id),
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.getByText("Used this turn")).toBeInTheDocument();
    expect(screen.getByText("Cancel all")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Deselect all canvas references"));

    expect(screen.queryByText("Used this turn")).not.toBeInTheDocument();
    expect(useCanvasStore.getState().nodes.every((node) => !node.selected)).toBe(true);
    expect(useCanvasStore.getState().selectedNodeId).toBeNull();
  });

  it("does not duplicate canvas references between attachments and current selection", async () => {
    const node = {
      id: "image-node-1",
      type: "imageNode",
      position: { x: 0, y: 0 },
      selected: true,
      data: {
        displayName: "Image node",
      },
    } satisfies Partial<CanvasNode> as CanvasNode;
    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      [node],
      [],
      [node],
      { displayNodes: [node] },
    );
    expect(attachment).not.toBeNull();

    useCanvasStore.getState().setCanvasData([node], []);
    useCanvasStore.getState().setSelectedNode(node.id);

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([node], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [node.id],
        })}
        pendingAttachments={[attachment as ChatAttachment]}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getAllByRole("button", { name: /Image node · image-node-1/ })).toHaveLength(1);
    expect(screen.getAllByLabelText("Remove canvas reference")).toHaveLength(1);
    expect(screen.getByText("Used this turn")).toBeInTheDocument();
  });

  it("sends selected canvas nodes as canvas reference attachments", async () => {
    const node = {
      id: "image-node-1",
      type: "imageNode",
      position: { x: 0, y: 0 },
      selected: true,
      data: {
        title: "Image node",
        imageUrl: "https://example.test/image.png",
      },
    } satisfies Partial<CanvasNode> as CanvasNode;

    useCanvasStore.getState().setCanvasData([node], []);
    useCanvasStore.getState().setSelectedNode(node.id);

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([node], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [node.id],
        })}
        pendingAttachments={[]}
      />,
    );

    fireEvent.click(screen.getByLabelText("Send"));

    await waitFor(() => expect(superChatMocks.send).toHaveBeenCalledTimes(1));

    const [text, attachments, transportText] = superChatMocks.send.mock.calls[0] as unknown as [
      string,
      ChatAttachment[],
      string,
    ];
    expect(text).toBe("Please continue from the selected canvas node.");
    expect(attachments).toHaveLength(1);
    expect(isCanvasNodeReferenceAttachment(attachments[0])).toBe(true);
    expect(canvasNodeReferenceAttachmentNodes(attachments[0])).toEqual(expect.arrayContaining([
      expect.objectContaining({
        nodeId: node.id,
      }),
    ]));
    expect(transportText).toContain("[SUPERTALE_CANVAS_NODE_REFERENCES]");
    expect(useCanvasStore.getState().nodes[0]?.selected).toBe(false);
  });

  it("renders sent canvas references as node cards instead of ordinary attachment chips", () => {
    const node = {
      id: "image-node-1",
      type: "imageNode",
      position: { x: 0, y: 0 },
      selected: false,
      data: {
        imageUrl: "https://example.test/image.png",
      },
    } satisfies Partial<CanvasNode> as CanvasNode;
    const attachment = buildCanvasNodeReferenceAttachment(
      "project-a",
      "canvas-a",
      [node],
      [],
      [node],
      { displayNodes: [node] },
    );
    expect(attachment).not.toBeNull();
    superChatMocks.messages = [
      {
        id: "message-a",
        role: "user",
        text: "Hello",
        displayName: "User",
        timestamp: Date.now(),
        attachments: [attachment as ChatAttachment],
      },
    ];
    useCanvasStore.getState().setCanvasData([node], []);

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([node], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.getByTitle(/image-node-1/)).toHaveClass("group/canvas-ref");
  });

  it("uses media-specific fallback icons for selected empty canvas nodes", () => {
    const audioNode = {
      id: "audio-node-1",
      type: "audioNode",
      position: { x: 0, y: 0 },
      selected: true,
      data: {
        displayName: "Voiceover and BGM",
        audioUrl: null,
      },
    } satisfies Partial<CanvasNode> as CanvasNode;
    useCanvasStore.getState().setCanvasData([audioNode], []);

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([audioNode], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [audioNode.id],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.getByRole("button", { name: "Voiceover and BGM · audio-node-1" })).toHaveAttribute(
      "data-media-kind",
      "audio",
    );
  });

  it("clears local queued messages when switching freezone canvas scope", () => {
    superChatMocks.busy = true;
    const { rerender } = render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    const input = getFreezoneComposerTextbox();
    setFreezoneComposerText(input, "Add a video node for me");
    fireEvent.keyDown(input, { key: "Enter" });

    expect(screen.getByText("1 queued")).toBeInTheDocument();

    rerender(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-b"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-b",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.queryByText("1 queued")).not.toBeInTheDocument();
    expect(superChatMocks.send).not.toHaveBeenCalled();
  });

  it("does not submit when Enter confirms an IME composition candidate", () => {
    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    const input = getFreezoneComposerTextbox();
    setFreezoneComposerText(input, "Check the current canvas summary and reply ok");
    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      nativeEvent: { isComposing: true, keyCode: 229 },
    });

    expect(superChatMocks.send).not.toHaveBeenCalled();
  });

  it("reveals user message actions below the bubble and copies with the legacy clipboard fallback", () => {
    superChatMocks.messages = [
      {
        id: "message-a",
        role: "user",
        text: "Hello",
        displayName: "User",
        timestamp: Date.now(),
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    const copyButton = screen.getByRole("button", { name: "Copy" });
    // The toolbar floats in the message gap below the bubble via top-full + mt-1, and the container no longer uses hover:pb-10
    // to reserve height for it: changing height on hover would trigger the message list ResizeObserver, and when pinned to the bottom the whole list
    // would jitter upward (see "remove list jumping when hovering Shrimp Director messages").
    expect(copyButton.parentElement).toHaveClass("absolute");
    expect(copyButton.parentElement).toHaveClass("top-full");
    expect(copyButton.parentElement).toHaveClass("mt-1");
    expect(copyButton.parentElement).toHaveClass("right-0");
    expect(copyButton.parentElement?.parentElement).not.toHaveClass("hover:pb-10");

    fireEvent.click(copyButton);

    expect(document.execCommand).toHaveBeenCalledWith("copy");
  });

  it("renders historical freezone skill slash mentions as chips without catalog data", () => {
    superChatMocks.messages = [
      {
        id: "history-skill-message",
        role: "user",
        text: "/pixar-brand-ip-ad-video make a phone ad",
        displayName: "User",
        timestamp: Date.now(),
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    const chipLabel = screen.getByText("pixar-brand-ip-ad-video");
    expect(chipLabel.closest("[data-freezone-skill-message-chip]")).toBeTruthy();
    expect(screen.getByText("make a phone ad")).toBeInTheDocument();
  });

  it("reveals assistant message actions below the bubble on the left side", () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "Hello! How can I help you?",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        parts: [
          { id: "usage", type: "agent_usage", event: { usage: { used: 10 } } },
        ],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    const copyButton = screen.getByLabelText("Copy");
    const actionBar = copyButton.parentElement;
    // main's display semantics put the assistant action bar in the normal document flow below the body to avoid covering later messages.
    expect(actionBar).toHaveClass("mt-1.5");
    expect(actionBar).not.toHaveClass("absolute");
    expect(actionBar).not.toHaveClass("right-0");
  });

  it("shows context usage as an assistant action badge instead of body text", () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "Hello! How can I help you?",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        parts: [
          {
            id: "usage",
            type: "agent_usage",
            event: { usage: { size: 131072, used: 34320 } },
          },
        ],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    const usageButton = screen.getByLabelText("Context usage");
    expect(usageButton).toHaveTextContent("");
    expect(usageButton).toHaveAttribute(
      "title",
      expect.stringContaining("used: 34320"),
    );
    expect(usageButton).not.toHaveAttribute(
      "title",
      expect.stringContaining("usage ratio"),
    );
    expect(screen.queryByText("used: 34320")).not.toBeInTheDocument();
  });

  it("does not render an assistant shell for usage-only runtime metadata", () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        parts: [
          {
            id: "usage",
            type: "agent_usage",
            event: { usage: { size: 131072, used: 34320 } },
          },
        ],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.queryByLabelText("Context usage")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
  });

  it("keeps the thinking placeholder visible when only usage metadata has arrived", () => {
    superChatMocks.busy = true;
    superChatMocks.activeTurnId = "turn-a";
    superChatMocks.messages = [
      {
        id: "user-a",
        role: "user",
        text: "Hello",
        displayName: "User",
        timestamp: 100,
        turnId: "turn-a",
      },
      {
        id: "assistant-turn-a",
        role: "assistant",
        text: "",
        displayName: "Agent",
        timestamp: 110,
        turnId: "turn-a",
        parts: [
          {
            id: "usage",
            type: "agent_usage",
            event: { usage: { size: 131072, used: 85913 } },
          },
        ],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.getByText("Thinking...")).toBeInTheDocument();
    expect(screen.queryByLabelText("Context usage")).not.toBeInTheDocument();
  });

  it("hides orphan recovered ui-event assistant messages without a matching user turn", () => {
    superChatMocks.messages = [
      {
        id: "54",
        role: "user",
        text: "Latest user message",
        displayName: "User",
        timestamp: 100,
        turnId: "turn-current",
      },
      {
        id: "55",
        role: "assistant",
        text: "Latest normal reply",
        displayName: "Agent",
        timestamp: 110,
        turnId: "turn-current",
      },
      {
        id: "ui-events:turn-orphan",
        role: "assistant",
        text: "Orphan recovered reply must not be shown",
        displayName: "Agent",
        timestamp: 120,
        turnId: "turn-orphan",
        parts: [
          { id: "text-orphan", type: "text", text: "Orphan recovered reply must not be shown" },
        ],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.getByText("Latest user message")).toBeInTheDocument();
    expect(screen.getByText("Latest normal reply")).toBeInTheDocument();
    expect(screen.queryByText("Orphan recovered reply must not be shown")).not.toBeInTheDocument();
  });

  it("resolves frontend canvas context requests and shows activity status", async () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "Let me check the current canvas state:",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("superchat/canvas-context-request", {
        detail: {
          bridge_key: "bridge-a",
          canvas_id: "canvas-a",
          turn_id: "turn-a",
          envelope: {
            schema_version: "canvas_context_request.v1",
            requests: [{ type: "canvas_ontology" }],
          },
        },
      }));
    });

    expect(await screen.findByText("Reading Canvas ontology")).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-context-tool-result", {
        detail: {
          type: "canvas.context.result",
          turn_id: "turn-a",
          bridge_key: "bridge-a",
          project_id: "project-a",
          canvas_id: "canvas-a",
          tool_call_status: "completed",
          canvas_context_status: "resolved",
          ok: true,
          responses: [{ type: "canvas_ontology", data: {} }],
          errors: [],
          message: "Frontend returned requested canvas context.",
        },
      }));
    });

    await waitFor(() => expect(screen.getByText("Read Canvas ontology")).toBeInTheDocument());
  });

  it("persists and reports approved canvas command results", async () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "Preparing to create a node",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    const scrollToMock = vi.mocked(HTMLElement.prototype.scrollTo);
    scrollToMock.mockClear();

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-context-activity", {
        detail: {
          type: "canvas.context.activity",
          turn_id: "turn-a",
          bridge_key: "validation-a",
          canvas_id: "canvas-a",
          status: "done",
          labels: ["Command validation"],
          errors: [],
          received_at: 1,
          surface_order: 1,
        },
      }));
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "imageGenNode",
                  data: { prompt: "test image" },
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    expect(screen.getByText("Canvas operations awaiting confirmation")).toBeInTheDocument();
    await waitFor(() => expect(scrollToMock).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "Confirm execution" }));

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/canvas-command-tool-result", expect.objectContaining({
        json: expect.objectContaining({
          bridge_key: "bridge-a",
          turn_id: "turn-a",
          canvas_id: "canvas-a",
          canvas_apply_status: "applied",
        }),
      })),
    );
    expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
      json: expect.objectContaining({
        turn_id: "turn-a",
        event: expect.objectContaining({
          type: "canvas_command_result",
          bridge_key: "bridge-a",
        }),
      }),
    }));
    expect(superChatMocks.replaceAssistantMessagePart).toHaveBeenCalledWith(
      { messageId: "assistant-a", turnId: "turn-a" },
      expect.stringContaining("canvas_approval:"),
      expect.objectContaining({ type: "canvas_feedback" }),
    );
  });

  it("hides and omits image quality after switching to a model without that capability", async () => {
    const node = {
      id: "image-node-1",
      type: "imageGenNode",
      position: { x: 0, y: 0 },
      selected: false,
      data: {
        prompt: "test image",
        model: "existing-model",
        aspectRatio: "16:9",
        size: "1K",
        quality: "medium",
        count: 1,
      },
    } satisfies Partial<CanvasNode> as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "Preparing to generate an image",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([node], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-image",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "run_node_action",
                  node_id: node.id,
                  action: "generate_image",
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    expect(await screen.findByLabelText("Image model")).toBeInTheDocument();
    expect(screen.getByLabelText("Image quality")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Image model"), { target: { value: "seedream-4.5" } });
    await waitFor(() => expect(screen.queryByLabelText("Image quality")).not.toBeInTheDocument());
    fireEvent.change(screen.getByLabelText("Image aspect ratio"), { target: { value: "9:16" } });
    fireEvent.change(screen.getByLabelText("Image resolution"), { target: { value: "2K" } });
    fireEvent.change(screen.getByLabelText("Image count"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm execution" }));

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
        json: expect.objectContaining({
          turn_id: "turn-a",
          event: expect.objectContaining({
            type: "canvas_command_approval_resolution",
            bridge_key: "bridge-image",
            envelopes: [
              expect.objectContaining({
                commands: [
                  {
                    type: "update_node_data",
                    node_id: node.id,
                    data: {
                      model: "seedream-4.5",
                      aspectRatio: "9:16",
                      size: "2K",
                      count: 2,
                    },
                  },
                  {
                    type: "run_node_action",
                    node_id: node.id,
                    action: "generate_image",
                  },
                ],
              }),
            ],
          }),
        }),
      })),
    );
  });

  it("groups video generation parameters like the canvas video node", async () => {
    const node = {
      id: "video-node-1",
      type: "videoNode",
      position: { x: 0, y: 0 },
      selected: false,
      data: {
        prompt: "test video",
        model: "newapi_seedance-2.0",
        aspectRatio: "16:9",
        quality: "720P",
        durationSec: 5,
        generateAudio: false,
        count: 1,
      },
    } satisfies Partial<CanvasNode> as CanvasNode;
    useCanvasStore.getState().setCanvasData([node], []);
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "Preparing to generate a video",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([node], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-video",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "run_node_action",
                  node_id: node.id,
                  action: "generate_video",
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    expect(await screen.findByLabelText("Video model")).toBeInTheDocument();
    expect(screen.queryByLabelText("Video aspect ratio")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Video quality")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Video duration")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Video audio")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Video parameters: 16:9 · 720P · 5s · Muted" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Video parameters: 16:9 · 720P · 5s · Muted" }));
    fireEvent.click(screen.getByRole("button", { name: "9:16" }));
    fireEvent.click(screen.getByRole("button", { name: "1080P" }));
    fireEvent.change(screen.getByLabelText("Video duration"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("switch", { name: "Generate audio" }));
    fireEvent.change(screen.getByLabelText("Video count"), { target: { value: "2" } });

    expect(screen.getByRole("button", { name: "Video parameters: 9:16 · 1080P · 10s · Audio" })).toBeInTheDocument();
    expect(screen.getByLabelText("Video count")).toHaveValue("2");
  });

  it("does not restore a persisted canvas command approval after it was confirmed", async () => {
    superChatMocks.messages = [
      {
        id: "user-a",
        role: "user",
        text: "Add a video node",
        displayName: "User",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
        raw: {
          ui_events: [
            {
              id: 1,
              type: "canvas_command_approval",
              turn_id: "turn-a",
              schema_version: "canvas_command_approval.v1",
              canvas_id: "canvas-a",
              bridge_key: "bridge-a",
              envelopes: [
                {
                  schema_version: "canvas_chat_commands.v1",
                  canvas_id: "canvas-a",
                  commands: [
                    {
                      type: "create_node",
                      node_type: "videoNode",
                      data: { title: "Video input" },
                    },
                  ],
                },
              ],
              received_at: 2,
            },
          ],
        },
      } as ChatMessage,
    ];

    const { rerender } = render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(await screen.findByText("Canvas operations awaiting confirmation")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm execution" }));

    await waitFor(() => expect(screen.queryByText("Canvas operations awaiting confirmation")).not.toBeInTheDocument());

    superChatMocks.messages = [
      superChatMocks.messages[0],
      {
        id: "assistant-a",
        role: "assistant",
        text: "I added a video node for you.",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ] as ChatMessage[];

    rerender(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    await waitFor(() => expect(screen.queryByText("Canvas operations awaiting confirmation")).not.toBeInTheDocument());
    expect(screen.getByText("I added a video node for you.")).toBeInTheDocument();
  });

  it("shows a canvas command approval even when the agent has no visible message yet", async () => {
    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-context-activity", {
        detail: {
          type: "canvas.context.activity",
          turn_id: "turn-a",
          bridge_key: "validation-a",
          canvas_id: "canvas-a",
          status: "done",
          labels: ["Command validation"],
          errors: [],
          received_at: 1,
          surface_order: 1,
        },
      }));
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "videoNode",
                  data: {},
                },
              ],
            },
          ],
          receivedAt: 1,
        },
      }));
    });

    expect(await screen.findByText("Canvas commands validated")).toBeInTheDocument();
    expect(await screen.findByText("Canvas operations awaiting confirmation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm execution" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm execution" }));
    await waitFor(() => expect(screen.queryByText("Canvas operations awaiting confirmation")).not.toBeInTheDocument());
    expect(await screen.findByText("Canvas execution")).toBeInTheDocument();
  });

  it("renders canvas command approval once when the same turn has a tool card", async () => {
    superChatMocks.showToolEvents = true;
    superChatMocks.messages = [
      {
        id: "assistant-turn-a",
        role: "assistant",
        text: "I will run the canvas operation.",
        timestamp: 1,
        turnId: "turn-a",
      },
      {
        id: "tool-turn-a",
        role: "tool",
        text: "freezone_emit_canvas_command",
        timestamp: 2,
        turnId: "turn-a",
        raw: {
          type: "tool.call",
          name: "freezone_emit_canvas_command",
          input: {
            canvas_id: "canvas-a",
            commands: [
              {
                type: "create_node",
                node_type: "imageGenNode",
                data: { prompt: "test image" },
              },
            ],
          },
        },
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "imageGenNode",
                  data: { prompt: "test image" },
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    await waitFor(() => {
      expect(screen.getAllByText("Canvas operations awaiting confirmation")).toHaveLength(1);
    });
  });

  it("restores a persisted canvas command approval when no assistant message exists yet", async () => {
    superChatMocks.messages = [
      {
        id: "user-a",
        role: "user",
        text: "Add a video node",
        displayName: "User",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
        raw: {
          ui_events: [
            {
              id: 1,
              type: "canvas_command_approval",
              turn_id: "turn-a",
              schema_version: "canvas_command_approval.v1",
              canvas_id: "canvas-a",
              bridge_key: "bridge-a",
              envelopes: [
                {
                  schema_version: "canvas_chat_commands.v1",
                  canvas_id: "canvas-a",
                  commands: [
                    {
                      type: "create_node",
                      node_type: "videoNode",
                      data: { title: "Video input" },
                    },
                  ],
                },
              ],
              received_at: 2,
            },
          ],
        },
      } as ChatMessage,
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(await screen.findByText("Canvas operations awaiting confirmation")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Confirm execution" })).toBeInTheDocument();
  });

  it("automatically cancels an expired persisted canvas command approval", async () => {
    superChatMocks.messages = [
      {
        id: "user-a",
        role: "user",
        text: "Add a video node",
        displayName: "User",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
        raw: {
          ui_events: [
            {
              id: 1,
              type: "canvas_command_approval",
              turn_id: "turn-a",
              schema_version: "canvas_command_approval.v1",
              canvas_id: "canvas-a",
              bridge_key: "bridge-a",
              envelopes: [
                {
                  schema_version: "canvas_chat_commands.v1",
                  canvas_id: "canvas-a",
                  commands: [
                    {
                      type: "create_node",
                      node_type: "videoNode",
                      data: { title: "Video input" },
                    },
                  ],
                },
              ],
              received_at: Date.now() - 301_000,
            },
          ],
        },
      } as ChatMessage,
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    await waitFor(() => {
      expect(screen.queryByText("Canvas operations awaiting confirmation")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(apiMocks.post).toHaveBeenCalledWith(
        "api/v1/chat/ui-events",
        expect.objectContaining({
          json: expect.objectContaining({
            event: expect.objectContaining({
              type: "canvas_command_approval_resolution",
              decision: "timeout",
            }),
          }),
        }),
      );
    });
  });

  it("does not restore a persisted canvas command approval when a result already exists", async () => {
    superChatMocks.messages = [
      {
        id: "user-a",
        role: "user",
        text: "Add a video node",
        displayName: "User",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
        raw: {
          ui_events: [
            {
              id: 1,
              type: "canvas_command_approval",
              turn_id: "turn-a",
              schema_version: "canvas_command_approval.v1",
              canvas_id: "canvas-a",
              bridge_key: "bridge-a",
              envelopes: [
                {
                  schema_version: "canvas_chat_commands.v1",
                  canvas_id: "canvas-a",
                  commands: [
                    {
                      type: "create_node",
                      node_type: "videoNode",
                      data: { title: "Video input" },
                    },
                  ],
                },
              ],
              received_at: 2,
            },
            {
              id: 2,
              type: "canvas_command_result",
              turn_id: "turn-a",
              schema_version: "canvas_command_result.v1",
              canvas_id: "canvas-a",
              bridge_key: "bridge-a",
              result: {
                applied: 0,
                openedUiActions: 0,
                createdNodeIds: [],
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
              },
              received_at: 3,
              cancelled: true,
            },
          ],
        },
      } as ChatMessage,
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    await waitFor(() => expect(screen.queryByText("Canvas operations awaiting confirmation")).not.toBeInTheDocument());
  });

  it("starts an agent recovery turn instead of replaying a timed-out command", async () => {
    const envelopes = [
      {
        schema_version: "canvas_chat_commands.v1" as const,
        canvas_id: "canvas-a",
        commands: [
          {
            type: "create_node" as const,
            node_type: "imageGenNode" as const,
            data: { title: "Recovered image node", prompt: "test image" },
          },
        ],
      },
    ];
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "This turn did not receive a valid reply from Shrimp Director. Please try again later.",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
        raw: {
          ui_events: [
            {
              id: 2,
              type: "canvas_command_result",
              turn_id: "turn-a",
              schema_version: "canvas_command_result.v1",
              canvas_id: "canvas-a",
              bridge_key: "bridge-a",
              envelopes,
              result: {
                applied: 0,
                openedUiActions: 0,
                createdNodeIds: [],
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
              received_at: 3,
              cancelled: true,
              cancel_reason: "timeout",
            },
          ],
        },
      } as ChatMessage,
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.queryByText("This turn did not receive a valid reply from Shrimp Director. Please try again later.")).not.toBeInTheDocument();
    // Expired approvals are expanded by default so recovery is immediately visible.
    expect(await screen.findByRole("button", { name: "Run again" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Run again" }));

    await waitFor(() => {
      expect(superChatMocks.send).toHaveBeenCalledWith(
        expect.stringContaining("verify existing nodes and run state"), [], "Recheck and continue the unfinished canvas operation",
      );
      expect(useCanvasStore.getState().nodes).toHaveLength(0);
    });
  });

  it("reports and persists cancelled canvas command approvals", async () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "Preparing to create a node",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "imageGenNode",
                  data: { prompt: "test image" },
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    expect(await screen.findByText("Canvas operations awaiting confirmation")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/canvas-command-tool-result", expect.objectContaining({
        json: expect.objectContaining({
          bridge_key: "bridge-a",
          turn_id: "turn-a",
          canvas_apply_status: "cancelled_by_user",
          cancelled: true,
          errors: ["Canvas operation cancelled"],
        }),
      })),
    );
    expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
      json: expect.objectContaining({
        turn_id: "turn-a",
        event: expect.objectContaining({
          type: "canvas_command_result",
          bridge_key: "bridge-a",
          cancelled: true,
        }),
      }),
    }));
  });

  it("automatically cancels canvas command approvals after the countdown", async () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "Preparing to create a node",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "imageGenNode",
                  data: { prompt: "test image" },
                },
              ],
            },
          ],
          receivedAt: Date.now() - 301_000,
        },
      }));
    });

    await waitFor(() =>
      expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/canvas-command-tool-result", expect.objectContaining({
        json: expect.objectContaining({
          bridge_key: "bridge-a",
          turn_id: "turn-a",
          canvas_apply_status: "cancelled_by_user",
          cancelled: true,
          errors: ["Canvas operation timed out and was cancelled automatically"],
        }),
      })),
    );
    expect(apiMocks.post).toHaveBeenCalledWith("api/v1/chat/ui-events", expect.objectContaining({
      json: expect.objectContaining({
        turn_id: "turn-a",
        event: expect.objectContaining({
          type: "canvas_command_result",
          bridge_key: "bridge-a",
          cancelled: true,
          cancel_reason: "timeout",
        }),
      }),
    }));
  });

  it("shows a countdown before canvas approval buttons", async () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "Preparing to create a node",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "imageGenNode",
                  data: { prompt: "test image" },
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    expect(await screen.findByText("Canvas operations awaiting confirmation")).toBeInTheDocument();
    expect(screen.getByText(/Auto-cancels in (?:299|300)s/)).toBeInTheDocument();
  });

  it("shows a cancelled feedback when a stale canvas approval remains in message parts", () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "The video generation request timed out; the frontend has not returned a result yet.",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
        parts: [
          {
            id: "part-text",
            type: "text",
            text: "The video generation request timed out; the frontend has not returned a result yet.",
          },
          {
            id: "canvas_approval:bridge:bridge-a:turn:turn-a",
            type: "canvas_approval",
            event: {
              id: "bridge:bridge-a:turn:turn-a",
              key: "bridge:bridge-a:turn:turn-a",
              messageId: "assistant-a",
              turnId: "turn-a",
              bridgeKey: "bridge-a",
              agentId: null,
              receivedAt: Date.now() - 31_000,
              autoExpires: true,
              expiresAt: Date.now() - 1_000,
              commandCount: 1,
              envelopes: [
                {
                  schema_version: "canvas_chat_commands.v1",
                  commands: [
                    {
                      type: "run_node_action",
                      node_id: "video-node-a",
                      action: "generate_video",
                    },
                  ],
                },
              ],
              plans: [
                {
                  type: "run_node_action",
                  label: "Generate video",
                  primary: "video-node-a",
                  details: [],
                  nodeId: "video-node-a",
                  action: "generate_video",
                },
              ],
            },
          },
        ],
      } as ChatMessage,
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(screen.getByText("The video generation request timed out; the frontend has not returned a result yet.")).toBeInTheDocument();
    expect(screen.queryByText("Canvas operations awaiting confirmation")).not.toBeInTheDocument();
    expect(
      screen.getByText("The canvas operation timed out and was cancelled without being applied."),
    ).toBeInTheDocument();
  });

  it("renders Freezone tool calls as activity cards", async () => {
    superChatMocks.showToolEvents = true;
    superChatMocks.messages = [
      {
        id: "tool-a",
        role: "tool",
        text: "freezone_create_node",
        displayName: "Tool",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
        raw: {
          type: "tool.call",
          name: "freezone_create_node",
          input: { project_id: "project-a", canvas_id: "canvas-a" },
        },
      } as ChatMessage,
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    expect(await screen.findByText("Create node")).toBeInTheDocument();
    expect(screen.getByText("In progress")).toBeInTheDocument();
    expect(screen.getByText("Project: project-a")).toBeInTheDocument();
  });

  it("hides protocol narration when a canvas command approval is shown", async () => {
    superChatMocks.messages = [
      {
        id: "assistant-a",
        role: "assistant",
        text: "canvas_chat_commands.v1\n{\"commands\":[]}",
        displayName: "Agent",
        timestamp: Date.now(),
        turnId: "turn-a",
        attachments: [],
      },
    ];

    render(
      <SuperChatPanel
        variant="freezone"
        canvasId="canvas-a"
        currentCanvasSelection={[]}
        currentCanvasOntologyContext={buildCanvasOntologyContext([], [], {
          canvasId: "canvas-a",
          selectedNodeIds: [],
        })}
        pendingAttachments={[]}
      />,
    );

    act(() => {
      window.dispatchEvent(new CustomEvent("freezone/canvas-command-approval", {
        detail: {
          canvasId: "canvas-a",
          turnId: "turn-a",
          bridgeKey: "bridge-a",
          envelopes: [
            {
              schema_version: "canvas_chat_commands.v1",
              commands: [
                {
                  type: "create_node",
                  node_type: "imageGenNode",
                  data: { prompt: "test image" },
                },
              ],
            },
          ],
          receivedAt: Date.now(),
        },
      }));
    });

    expect(await screen.findByText("Canvas operations awaiting confirmation")).toBeInTheDocument();
    expect(screen.queryByText(/canvas_chat_commands\.v1/)).not.toBeInTheDocument();
  });
});

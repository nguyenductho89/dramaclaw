// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Connection, Edge, FinalConnectionState, OnConnectStartParams } from "@xyflow/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import { useCanvasStore } from "@/stores/canvasStore";
import { Canvas } from "@/features/canvas/Canvas";

// Canvas uses useQueryClient() (beats/episodeDetail prefetch), so rendering needs a QueryClientProvider wrapper.
function renderCanvas() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <Canvas />
    </QueryClientProvider>,
  );
}

let capturedOnConnect: ((connection: Connection) => void) | null = null;
let capturedOnConnectStart:
  | ((event: MouseEvent | TouchEvent, params: OnConnectStartParams) => void)
  | null = null;
let capturedOnConnectEnd:
  | ((event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => void)
  | null = null;
let capturedReactFlowProps: Record<string, unknown> | null = null;

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock("@xyflow/react", async () => {
  const actual =
    await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    ReactFlow: (props: {
      onConnect?: (connection: Connection) => void;
      onConnectStart?: (event: MouseEvent | TouchEvent, params: OnConnectStartParams) => void;
      onConnectEnd?: (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => void;
      children?: React.ReactNode;
      [key: string]: unknown;
    }) => {
      const { onConnect, onConnectStart, onConnectEnd, children } = props;
      capturedReactFlowProps = props;
      capturedOnConnect = onConnect ?? null;
      capturedOnConnectStart = onConnectStart ?? null;
      capturedOnConnectEnd = onConnectEnd ?? null;
      return <div data-testid="react-flow">{children}</div>;
    },
    Background: () => null,
    MiniMap: () => null,
    useNodesInitialized: () => true,
    useReactFlow: () => ({
      fitView: vi.fn(),
      getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
      getZoom: () => 1,
      screenToFlowPosition: ({ x, y }: { x: number; y: number }) => ({ x, y }),
      setCenter: vi.fn(),
      setViewport: vi.fn(),
    }),
    useStoreApi: () => ({
      getState: () => ({ transform: [0, 0, 1] }),
      setState: vi.fn(),
      subscribe: () => () => {},
    }),
  };
});

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock("@/api/skills", () => ({
  getSkillRegistry: vi.fn().mockResolvedValue([
    {
      id: "freezone.sketch_from_context",
      provider: "freezone_mainline",
      display_name: "Sketch From Context",
      description: "",
      inputs: [
        {
          role: "background",
          label: "Background",
          accepts: {
            node_types: [
              "imageGenNode",
              "imageNode",
              "uploadImageNode",
              "freezoneImageNode",
              "assetImageNode",
              "sceneNode",
              "identityNode",
              "propNode",
            ],
            media_kinds: ["image"],
            has_field: ["image_url"],
          },
          required: false,
          cardinality: "single",
        },
      ],
      outputs: [],
    },
    {
      id: "freezone.frame_from_context",
      provider: "freezone_mainline",
      display_name: "Frame From Context",
      description: "",
      inputs: [
        {
          role: "beat_context",
          label: "Shot Context",
          accepts: { node_types: ["beatContextNode"] },
          required: true,
          cardinality: "single",
        },
        {
          role: "identity",
          label: "Identity",
          accepts: {
            node_types: [
              "imageGenNode",
              "imageNode",
              "uploadImageNode",
              "freezoneImageNode",
              "assetImageNode",
              "sceneNode",
              "identityNode",
              "propNode",
            ],
            canonical_slot_kinds: ["identity", "portrait"],
            media_kinds: ["image"],
            has_field: ["image_url"],
          },
          required: false,
          cardinality: "multi",
        },
      ],
      outputs: [],
    },
  ]),
}));

vi.mock("@/features/canvas/nodes", () => ({
  nodeTypes: {},
}));

vi.mock("@/features/canvas/edges", () => ({
  edgeTypes: {},
}));

vi.mock("@/features/canvas/NodeSelectionMenu", () => ({
  NodeSelectionMenu: () => null,
}));

vi.mock("@/features/canvas/ui/SelectedNodeOverlay", () => ({
  SelectedNodeOverlay: () => null,
}));

vi.mock("@/features/canvas/ui/MultiSelectionToolbar", () => ({
  MultiSelectionToolbar: () => null,
}));

vi.mock("@/features/canvas/ui/MultiSelectionConnectButton", () => ({
  MultiSelectionConnectButton: () => null,
}));

vi.mock("@/features/canvas/ui/NodeSpawnPlusOverlay", () => ({
  NodeSpawnPlusOverlay: () => null,
}));

vi.mock("@/features/canvas/ui/CanvasContextMenu", () => ({
  CanvasContextMenu: () => null,
}));

vi.mock("@/features/canvas/ui/NodeToolDialog", () => ({
  NodeToolDialog: () => null,
}));

vi.mock("@/features/canvas/ui/ImageViewerModal", () => ({
  ImageViewerModal: () => null,
}));

vi.mock("@/features/canvas/ui/VideoViewerModal", () => ({
  VideoViewerModal: () => null,
}));

vi.mock("@/features/canvas/ui/CanvasZoomControl", () => ({
  CanvasZoomControl: () => null,
}));

vi.mock("@/features/canvas/ui/CanvasQuickActionBar", () => ({
  CanvasQuickActionBar: () => null,
}));

vi.mock("@/features/canvas/ui/CanvasMinimapButton", () => ({
  CanvasMinimapButton: () => null,
}));

vi.mock("@/features/canvas/ui/CanvasFpsMeter", () => ({
  CanvasFpsMeter: () => null,
}));

vi.mock("@/features/canvas/snap-align/CanvasSnapAlignButton", () => ({
  CanvasSnapAlignButton: () => null,
}));

vi.mock("@/features/canvas/snap-align/SnapAlignGuides", () => ({
  SnapAlignGuides: () => null,
}));

describe("Canvas manual skill connections", () => {
  beforeEach(() => {
    capturedOnConnect = null;
    capturedOnConnectStart = null;
    capturedOnConnectEnd = null;
    capturedReactFlowProps = null;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "image",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: "/image.png", aspectRatio: "1:1" },
        },
        {
          id: "skill",
          type: CANVAS_NODE_TYPES.skill,
          position: { x: 400, y: 0 },
          data: { skill_id: "freezone.sketch_from_context" },
        },
      ],
      [],
    );
  });

  it("configures ReactFlow loose connection mode so image and skill input handles can be dragged from either side", async () => {
    renderCanvas();

    await waitFor(() => expect(capturedReactFlowProps).toBeTruthy());

    expect(capturedReactFlowProps?.connectionMode).toBe("loose");
  });

  it("creates a role binding when dragging an uploaded image into a skill input", async () => {
    renderCanvas();

    await waitFor(() => expect(capturedOnConnect).toBeTruthy());

    act(() => {
      capturedOnConnect?.({
        source: "image",
        sourceHandle: "source",
        target: "skill",
        targetHandle: "background",
      });
    });

    expect(useCanvasStore.getState().edges).toHaveLength(1);
    expect(useCanvasStore.getState().edges[0]).toMatchObject({
      source: "image",
      target: "skill",
      sourceHandle: "source",
      targetHandle: "background",
      data: {
        edgeKind: "role_binding",
        role: "background",
      },
    });
  });

  it("uses the exact skill input handle under the pointer when connect-end fallback creates the edge", async () => {
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "context",
          type: CANVAS_NODE_TYPES.beatContext,
          position: { x: 0, y: 0 },
          data: {
            beat_context: {
              schema: "beat_context.v1",
              source: "standalone",
              visual_description: "{{YELLOW}} and {{GREEN}} enter",
              detected_identities: ["YELLOW", "GREEN"],
            },
          },
        },
        {
          id: "image",
          type: CANVAS_NODE_TYPES.upload,
          position: { x: 0, y: 0 },
          data: { imageUrl: "/identity.png", aspectRatio: "1:1" },
        },
        {
          id: "skill",
          type: CANVAS_NODE_TYPES.skill,
          position: { x: 400, y: 0 },
          data: { skill_id: "freezone.frame_from_context" },
        },
      ],
      [
        {
          id: "e-context-skill-beat_context",
          source: "context",
          target: "skill",
          sourceHandle: "source",
          targetHandle: "beat_context",
          type: "disconnectableEdge",
          data: {
            edgeKind: "role_binding",
            role: "beat_context",
          },
        },
      ],
    );
    renderCanvas();

    await waitFor(() => expect(capturedOnConnectStart).toBeTruthy());
    await waitFor(() => expect(capturedOnConnectEnd).toBeTruthy());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    const skillElement = document.createElement("div");
    skillElement.className = "react-flow__node";
    skillElement.dataset.id = "skill";
    const greenHandle = document.createElement("div");
    greenHandle.className = "react-flow__handle target";
    greenHandle.dataset.nodeid = "skill";
    greenHandle.dataset.handleid = "identity:GREEN";
    greenHandle.getBoundingClientRect = () =>
      ({
        left: 96,
        top: 96,
        width: 8,
        height: 8,
        right: 104,
        bottom: 104,
        x: 96,
        y: 96,
        toJSON: () => ({}),
      }) as DOMRect;
    skillElement.appendChild(greenHandle);
    document.body.appendChild(skillElement);
    const originalElementFromPoint = document.elementFromPoint;
    const elementFromPoint = vi.fn().mockReturnValue(greenHandle);
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: elementFromPoint,
    });

    try {
      act(() => {
        capturedOnConnectStart?.(
          { clientX: 0, clientY: 0, target: null } as unknown as MouseEvent,
          { nodeId: "image", handleId: "source", handleType: "source" },
        );
      });
      await waitFor(() => expect(capturedReactFlowProps).toBeTruthy());
      act(() => {
        capturedOnConnectEnd?.(
          { clientX: 100, clientY: 100, target: greenHandle } as unknown as MouseEvent,
          { isValid: false } as FinalConnectionState,
        );
      });
    } finally {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: originalElementFromPoint,
      });
      skillElement.remove();
    }

    const identityEdge = useCanvasStore
      .getState()
      .edges.find((edge) => edge.source === "image");
    expect(identityEdge).toMatchObject({
      source: "image",
      target: "skill",
      sourceHandle: "source",
      targetHandle: "identity:GREEN",
      data: {
        edgeKind: "role_binding",
        role: "identity",
        reference_target: { kind: "identity", identity_id: "GREEN" },
      },
    });
  });
});

// The drop-target validation while dragging a line (isValidConnection) and the edge-creation decision on release (onConnect) are two independent pieces of code,
// and once their rules disagree, the user sees "the drop target highlights as valid, but nothing happens on release". Here we do not assert
// a specific rule, but that the two places **give the same answer for the same pair of nodes** -- the rules can change any way later,
// as long as both sides change together.
describe("Canvas drag-line drop validation and edge-creation decision are aligned", () => {
  const NODES = [
    { id: "html", type: CANVAS_NODE_TYPES.htmlArtifact, data: {} },
    { id: "text", type: CANVAS_NODE_TYPES.textAnnotation, data: { text: "Narration" } },
    { id: "audio", type: CANVAS_NODE_TYPES.audio, data: { audioUrl: "/a.mp3" } },
    { id: "image", type: CANVAS_NODE_TYPES.imageGen, data: { imageUrl: "/i.png" } },
    { id: "video", type: CANVAS_NODE_TYPES.video, data: { videoUrl: "/v.mp4" } },
  ];

  // At least one pair of edges "allowed by the edge rules but not open to manual creation" must be covered (the video->audio provenance edge),
  // otherwise using the lenient rules in both places could also keep the test fully green.
  const PAIRS: { source: string; target: string; expected: boolean }[] = [
    { source: "text", target: "html", expected: true },
    { source: "image", target: "html", expected: true },
    { source: "text", target: "audio", expected: true },
    { source: "audio", target: "video", expected: true },
    { source: "audio", target: "image", expected: false },
    { source: "video", target: "audio", expected: false },
  ];

  function resetCanvas() {
    useCanvasStore.getState().setCanvasData(
      NODES.map((node, index) => ({
        ...node,
        position: { x: index * 400, y: 0 },
      })),
      [],
    );
  }

  beforeEach(() => {
    capturedOnConnect = null;
    capturedReactFlowProps = null;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    resetCanvas();
  });

  it("both decisions give the same answer for every pair of nodes", async () => {
    renderCanvas();
    await waitFor(() => expect(capturedOnConnect).toBeTruthy());

    for (const pair of PAIRS) {
      act(() => {
        resetCanvas();
      });
      const connection: Connection = {
        source: pair.source,
        sourceHandle: "source",
        target: pair.target,
        targetHandle: "target",
      };

      const isValidConnection = capturedReactFlowProps?.isValidConnection as
        | ((connection: Connection | Edge) => boolean)
        | undefined;
      const highlightedAsValid = isValidConnection?.(connection);

      act(() => {
        capturedOnConnect?.(connection);
      });
      const edgeCreated = useCanvasStore
        .getState()
        .edges.some((edge) => edge.source === pair.source && edge.target === pair.target);

      expect({ ...pair, highlightedAsValid, edgeCreated }).toEqual({
        ...pair,
        highlightedAsValid: pair.expected,
        edgeCreated: pair.expected,
      });
    }
  });
});

// The material cap (videoReferenceLimits) is a later-added rule and must likewise share one source in both places: if it only blocked in onConnect,
// the user would see the drop target highlight as valid and nothing created on release; if it only blocked in isValidConnection,
// other edge-creation paths (asset drag-in, menu creation) could still connect the 10th image.
describe("Canvas material cap is aligned between drop validation and edge-creation decision", () => {
  const IMAGE_CAP = 9;

  function setupSaturatedVideo() {
    const images = Array.from({ length: IMAGE_CAP + 1 }, (_, index) => ({
      id: `image-${index}`,
      type: CANVAS_NODE_TYPES.imageGen,
      data: { imageUrl: `/i-${index}.png` },
      position: { x: index * 300, y: 0 },
    }));
    const video = {
      id: "video",
      type: CANVAS_NODE_TYPES.video,
      data: { videoUrl: "/v.mp4" },
      position: { x: 0, y: 800 },
    };
    // The first 9 are already connected, and the 10th (image-9) is the one being dragged this time.
    useCanvasStore.getState().setCanvasData(
      [...images, video],
      images.slice(0, IMAGE_CAP).map((node) => ({
        id: `e-${node.id}`,
        source: node.id,
        target: video.id,
        sourceHandle: "source",
        targetHandle: "target",
      })),
    );
  }

  beforeEach(() => {
    capturedOnConnect = null;
    capturedReactFlowProps = null;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    setupSaturatedVideo();
  });

  it(`when ${IMAGE_CAP} images are already connected, both places reject image ${IMAGE_CAP + 1}`, async () => {
    renderCanvas();
    await waitFor(() => expect(capturedOnConnect).toBeTruthy());

    const connection: Connection = {
      source: `image-${IMAGE_CAP}`,
      sourceHandle: "source",
      target: "video",
      targetHandle: "target",
    };
    const isValidConnection = capturedReactFlowProps?.isValidConnection as
      | ((connection: Connection | Edge) => boolean)
      | undefined;
    const highlightedAsValid = isValidConnection?.(connection);

    act(() => {
      capturedOnConnect?.(connection);
    });
    const edgeCreated = useCanvasStore
      .getState()
      .edges.some((edge) => edge.source === connection.source && edge.target === "video");

    expect({ highlightedAsValid, edgeCreated }).toEqual({
      highlightedAsValid: false,
      edgeCreated: false,
    });
    // The existing 9 edges must not be swept away by this rejection.
    expect(
      useCanvasStore.getState().edges.filter((edge) => edge.target === "video"),
    ).toHaveLength(IMAGE_CAP);
  });

  it(`when not full (${IMAGE_CAP - 1} images) both places allow it`, async () => {
    act(() => {
      useCanvasStore.setState((state) => ({
        edges: state.edges.filter((edge) => edge.source !== `image-${IMAGE_CAP - 1}`),
      }));
    });
    renderCanvas();
    await waitFor(() => expect(capturedOnConnect).toBeTruthy());

    const connection: Connection = {
      source: `image-${IMAGE_CAP}`,
      sourceHandle: "source",
      target: "video",
      targetHandle: "target",
    };
    const isValidConnection = capturedReactFlowProps?.isValidConnection as
      | ((connection: Connection | Edge) => boolean)
      | undefined;
    const highlightedAsValid = isValidConnection?.(connection);

    act(() => {
      capturedOnConnect?.(connection);
    });
    const edgeCreated = useCanvasStore
      .getState()
      .edges.some((edge) => edge.source === connection.source && edge.target === "video");

    expect({ highlightedAsValid, edgeCreated }).toEqual({
      highlightedAsValid: true,
      edgeCreated: true,
    });
  });
});

describe("Canvas node drag focus mode", () => {
  beforeEach(() => {
    document.body.classList.remove("canvas-node-drag-focus");
    capturedReactFlowProps = null;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "drag-a",
          type: CANVAS_NODE_TYPES.imageGen,
          position: { x: 0, y: 0 },
          data: {},
        },
        {
          id: "drag-b",
          type: CANVAS_NODE_TYPES.imageGen,
          position: { x: 400, y: 0 },
          data: {},
        },
      ],
      [],
    );
  });

  it("enters and restores focus mode for single-node and selection drags", async () => {
    const view = renderCanvas();
    await waitFor(() => expect(capturedReactFlowProps).toBeTruthy());
    const [first, second] = useCanvasStore.getState().nodes;
    const onNodeDragStart = capturedReactFlowProps?.onNodeDragStart as
      | ((event: { altKey: boolean }, node: typeof first, nodes: typeof first[]) => void)
      | undefined;
    const onNodeDragStop = capturedReactFlowProps?.onNodeDragStop as
      | ((event: object, node: typeof first) => void)
      | undefined;
    const onSelectionDragStart = capturedReactFlowProps?.onSelectionDragStart as
      | ((event: object, nodes: typeof first[]) => void)
      | undefined;
    const onSelectionDragStop = capturedReactFlowProps?.onSelectionDragStop as
      | (() => void)
      | undefined;
    const canvas = view.container.querySelector<HTMLElement>(".dc-canvas");

    act(() => onNodeDragStart?.({ altKey: false }, first, [first]));
    expect(document.body).toHaveClass("canvas-node-drag-focus");
    expect(canvas).toHaveAttribute("data-node-drag-focus", "true");

    act(() => onNodeDragStop?.({}, first));
    expect(document.body).not.toHaveClass("canvas-node-drag-focus");
    expect(canvas).not.toHaveAttribute("data-node-drag-focus");

    act(() => onSelectionDragStart?.({}, [first, second]));
    expect(document.body).toHaveClass("canvas-node-drag-focus");

    act(() => onSelectionDragStop?.());
    expect(document.body).not.toHaveClass("canvas-node-drag-focus");
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { act, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCanvasStore } from "@/stores/canvasStore";
import { Canvas } from "@/features/canvas/Canvas";

// The minimap is shown on hover by default, and as soon as the pointer is dragged out onMouseLeave fires -> 180ms later MiniMap is unmounted,
// which also removes the window listeners of useSmoothMinimapPan and breaks the drag halfway. What is asserted here is
// the Canvas-side wiring that "the minimap must stay mounted during a drag".
type Viewport = { x: number; y: number; zoom: number };
type PanOptions = {
  onPanStart?: () => void;
  onPanEnd?: (pointerInsideMinimap: boolean) => void;
  onViewportSettled?: (viewport: Viewport) => void;
};
let capturedPanOptions: PanOptions | null = null;

vi.mock("@/features/canvas/hooks/useSmoothMinimapPan", () => ({
  useSmoothMinimapPan: (options: PanOptions) => {
    capturedPanOptions = options;
  },
}));

// onMoveEnd must be triggerable on its own: during the minimap easing ReactFlow runs a full
// move lifecycle **every frame**, and here it must be asserted that those frames do not commit the viewport one by one.
let capturedFlowProps: {
  onMoveEnd?: (event: unknown, viewport: Viewport) => void;
} | null = null;

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

vi.mock("@xyflow/react", async () => {
  const actual = await vi.importActual<typeof import("@xyflow/react")>("@xyflow/react");
  return {
    ...actual,
    ReactFlow: (props: {
      children?: React.ReactNode;
      onMoveEnd?: (event: unknown, viewport: Viewport) => void;
    }) => {
      capturedFlowProps = props;
      return <div data-testid="react-flow">{props.children}</div>;
    },
    Background: () => null,
    MiniMap: (props: { onMouseEnter?: () => void; onMouseLeave?: () => void }) => (
      <div
        data-testid="minimap"
        onMouseEnter={props.onMouseEnter}
        onMouseLeave={props.onMouseLeave}
      />
    ),
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
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("@/api/skills", () => ({
  getSkillRegistry: vi.fn().mockResolvedValue([]),
}));

vi.mock("@/features/canvas/nodes", () => ({ nodeTypes: {} }));
vi.mock("@/features/canvas/edges", () => ({ edgeTypes: {} }));
vi.mock("@/features/canvas/NodeSelectionMenu", () => ({ NodeSelectionMenu: () => null }));
vi.mock("@/features/canvas/ui/SelectedNodeOverlay", () => ({ SelectedNodeOverlay: () => null }));
vi.mock("@/features/canvas/ui/MultiSelectionToolbar", () => ({ MultiSelectionToolbar: () => null }));
vi.mock("@/features/canvas/ui/MultiSelectionConnectButton", () => ({
  MultiSelectionConnectButton: () => null,
}));
vi.mock("@/features/canvas/ui/NodeSpawnPlusOverlay", () => ({ NodeSpawnPlusOverlay: () => null }));
vi.mock("@/features/canvas/ui/CanvasContextMenu", () => ({ CanvasContextMenu: () => null }));
vi.mock("@/features/canvas/ui/NodeToolDialog", () => ({ NodeToolDialog: () => null }));
vi.mock("@/features/canvas/ui/ImageViewerModal", () => ({ ImageViewerModal: () => null }));
vi.mock("@/features/canvas/ui/VideoViewerModal", () => ({ VideoViewerModal: () => null }));
vi.mock("@/features/canvas/ui/CanvasZoomControl", () => ({ CanvasZoomControl: () => null }));
vi.mock("@/features/canvas/ui/CanvasQuickActionBar", () => ({ CanvasQuickActionBar: () => null }));
vi.mock("@/features/canvas/ui/CanvasMinimapBookmarksOverlay", () => ({
  CanvasMinimapBookmarksOverlay: () => null,
}));
vi.mock("@/features/canvas/ui/CanvasMinimapButton", () => ({
  CanvasMinimapButton: (props: { onHoverChange: (hovered: boolean) => void }) => (
    <button
      type="button"
      data-testid="minimap-trigger"
      onMouseEnter={() => props.onHoverChange(true)}
    />
  ),
}));
vi.mock("@/features/canvas/ui/CanvasFpsMeter", () => ({ CanvasFpsMeter: () => null }));
vi.mock("@/features/canvas/snap-align/CanvasSnapAlignButton", () => ({
  CanvasSnapAlignButton: () => null,
}));
vi.mock("@/features/canvas/snap-align/SnapAlignGuides", () => ({ SnapAlignGuides: () => null }));

function renderCanvas() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <Canvas />
    </QueryClientProvider>,
  );
}

describe("Canvas keeps the minimap mounted during a minimap drag", () => {
  beforeEach(() => {
    capturedPanOptions = null;
    capturedFlowProps = null;
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    useCanvasStore.getState().setCanvasData([], []);
    useCanvasStore.setState({ currentViewport: { x: 0, y: 0, zoom: 1 } });
  });

  it("when not pinned, dragging out of the minimap does not unmount it; auto-hide resumes only after the drag ends", () => {
    vi.useFakeTimers();
    try {
      renderCanvas();

      // The hover trigger button brings up the minimap (not pinned by default).
      fireEvent.mouseEnter(screen.getByTestId("minimap-trigger"));
      expect(screen.getByTestId("minimap")).toBeTruthy();

      // Start dragging, then the pointer leaves the minimap and triggers mouseleave.
      act(() => {
        capturedPanOptions?.onPanStart?.();
      });
      fireEvent.mouseLeave(screen.getByTestId("minimap"));
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      // The hover is long gone, but the drag is still going on -- the minimap must still be there.
      expect(screen.queryByTestId("minimap")).not.toBeNull();

      // onPanEnd is already the hook-guaranteed "released and easing converged", so there is no need here to bet on a fixed delay
      // (the convergence time varies with the remaining distance, 180ms cannot cover it, and would instead cut the easing short).
      act(() => {
        capturedPanOptions?.onPanEnd?.(false);
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByTestId("minimap")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps showing it if the pointer is still inside the minimap on release", () => {
    vi.useFakeTimers();
    try {
      renderCanvas();
      fireEvent.mouseEnter(screen.getByTestId("minimap-trigger"));
      act(() => {
        capturedPanOptions?.onPanStart?.();
      });
      fireEvent.mouseLeave(screen.getByTestId("minimap"));
      act(() => {
        capturedPanOptions?.onPanEnd?.(true);
        vi.advanceTimersByTime(1000);
      });
      expect(screen.queryByTestId("minimap")).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("during the easing onMoveEnd does not commit the viewport frame by frame, and commits once only on convergence", () => {
    renderCanvas();
    fireEvent.mouseEnter(screen.getByTestId("minimap-trigger"));

    act(() => {
      capturedPanOptions?.onPanStart?.();
    });

    // instance.setViewport goes through the full onMoveStart->onMove->onMoveEnd every time, while
    // the end event is coalesced over 150ms only with panOnScroll; after the user turns off "trackpad panning"
    // panOnScroll=false, and every frame of the easing lands here.
    act(() => {
      capturedFlowProps?.onMoveEnd?.(null, { x: -30, y: 0, zoom: 1 });
      capturedFlowProps?.onMoveEnd?.(null, { x: -60, y: 0, zoom: 1 });
      capturedFlowProps?.onMoveEnd?.(null, { x: -90, y: 0, zoom: 1 });
    });
    expect(useCanvasStore.getState().currentViewport).toEqual({ x: 0, y: 0, zoom: 1 });

    act(() => {
      capturedPanOptions?.onViewportSettled?.({ x: -100, y: 0, zoom: 1 });
    });
    expect(useCanvasStore.getState().currentViewport).toEqual({ x: -100, y: 0, zoom: 1 });
  });

  it("when it is not a minimap drag, onMoveEnd commits the viewport as usual", () => {
    renderCanvas();
    act(() => {
      capturedFlowProps?.onMoveEnd?.(null, { x: -42, y: 7, zoom: 1 });
    });
    expect(useCanvasStore.getState().currentViewport).toEqual({ x: -42, y: 7, zoom: 1 });
  });
});

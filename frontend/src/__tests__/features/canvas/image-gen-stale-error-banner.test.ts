// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import React, { useSyncExternalStore } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { enT } from "@/__tests__/helpers/i18n-fixtures";

const canvasStoreMock = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const actions = {
    setSelectedNode: vi.fn(),
    setActiveOverlayNodeId: vi.fn(),
    updateNodeSize: vi.fn(),
    deleteEdge: vi.fn(),
    addNode: vi.fn(),
    addEdge: vi.fn(),
  };
  let state: Record<string, unknown>;
  const updateNodeData = vi.fn(
    (_id: string, patch: Record<string, unknown>) => {
      state = {
        ...state,
        nodeData: { ...(state.nodeData as Record<string, unknown>), ...patch },
      };
      listeners.forEach((listener) => listener());
    },
  );
  const reset = (nodeData: Record<string, unknown>) => {
    state = {
      ...actions,
      updateNodeData,
      nodeData,
      nodes: [],
      edges: [],
      activeOverlayNodeId: null,
    };
    updateNodeData.mockClear();
  };
  reset({});
  return {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    reset,
    updateNodeData,
  };
});

vi.mock("@xyflow/react", () => ({
  Handle: () => null,
  NodeResizeControl: ({ children }: { children?: React.ReactNode }) =>
    children ?? null,
  Position: { Left: "left", Right: "right" },
  useUpdateNodeInternals: () => vi.fn(),
  // The node decides by transform[2] whether the body image is fed the original or a downsampled copy; here it is fixed at zoom 1,
  // i.e. the tier of "not inspecting a single image closely".
  useStore: (selector: (state: { transform: [number, number, number] }) => unknown) =>
    selector({ transform: [0, 0, 1] }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      key.startsWith("settings.mediaStorage.errors.") ? enT(key, options) : key,
  }),
}));

vi.mock("@/stores/canvasStore", async () => {
  const ReactModule = await import("react");
  const useCanvasStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      ReactModule.useSyncExternalStore(canvasStoreMock.subscribe, () =>
        selector(canvasStoreMock.getState()),
      ),
    { getState: canvasStoreMock.getState },
  );
  return { useCanvasStore, useIsBoxSelecting: () => false };
});

vi.mock("@/features/canvas/hooks/useFreezoneImageModels", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/features/canvas/hooks/useFreezoneImageModels")
  >()),
  useFreezoneImageModels: () => ({
    models: [{ id: "test-model", apiModel: "test-model", label: "Test" }],
    isLoading: false,
    isFallback: false,
  }),
}));
vi.mock("@/features/canvas/hooks/useNodeGenerationHistory", () => ({
  useNodeGenerationHistory: () => ({
    records: [{ id: "history-1", status: "completed" }],
    isLoading: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("@/features/canvas/ui/NodeGenerationHistory", () => ({
  hasCompletedHistoryRecords: () => true,
  historyRecordOutputUrl: (record: { result?: { output_url?: string } }) =>
    record.result?.output_url ?? null,
  NodeGenerationHistory: ({
    onRestore,
  }: {
    onRestore: (record: unknown) => void;
  }) =>
    React.createElement(
      "button",
      {
        type: "button",
        onClick: () =>
          onRestore({
            id: "history-1",
            status: "completed",
            result: { output_url: "https://example.test/restored.png" },
          }),
      },
      "restore history",
    ),
}));
vi.mock("@/features/canvas/hooks/useFreezoneCameraOptions", () => ({
  useFreezoneCameraOptions: () => ({ options: [] }),
}));
vi.mock("@/features/canvas/hooks/useFreezoneStyleTemplates", () => ({
  useFreezoneStyleTemplates: () => ({ templates: [] }),
}));
vi.mock("@/features/canvas/application/useUpstreamGraph", () => ({
  useUpstreamContents: () => [],
  useUpstreamNodes: () => [],
}));
vi.mock("@/features/canvas/application/useNodeGenerationTaskState", () => ({
  useNodeGenerationTaskState: () => ({ isGenerating: false }),
}));
vi.mock("@/features/canvas/nodes/useReferenceMentionSync", () => ({
  useReferenceMentionSync: () => undefined,
}));
vi.mock("@/lib/queries/generation-credit-cost", () => ({
  useGenerationCreditCost: () => ({ data: undefined, error: null }),
}));
vi.mock("@/lib/model-task-access", () => ({
  useModelTaskAccess: () => ({ blocked: false, denialReason: null, message: null }),
}));
vi.mock("@/features/canvas/nodes/shared/albumPendingTotals", () => ({
  setAlbumPendingTotal: vi.fn(),
  useAlbumPendingTotal: () => 0,
}));
vi.mock("@/features/canvas/ui/CanvasNodeImage", () => ({
  CanvasNodeImage: ({ src, alt }: { src: string; alt: string }) =>
    React.createElement("img", { src, alt }),
}));
vi.mock("@/features/canvas/ui/NodeHeader", () => ({
  NODE_HEADER_FLOATING_POSITION_CLASS: "",
  NodeHeader: () => null,
}));

import {
  GENERATION_ERROR_CLEARED_PATCH,
  buildImageGenerationSuccessPatch,
} from "@/features/canvas/application/generationTaskArbitration";
import { ImageGenNode } from "@/features/canvas/nodes/ImageGenNode";

function read(relativePath: string): string {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

/**
 * Grabs the full content of the brace pair in `updateNodeData(<target>, { ... })` (balanced by nesting,
 * since fields like slot_target / generationBatch are themselves object literals).
 * The target is written differently per file: the node itself uses `id`, editor popovers use `nodeId` / `node.id`.
 */
function updateNodeDataPatches(source: string): string[] {
  const patches: string[] = [];
  const opener = /updateNodeData\(\s*[\w.]+\s*,\s*\{/g;
  let match = opener.exec(source);
  while (match !== null) {
    let depth = 0;
    let index = match.index + match[0].length - 1;
    for (; index < source.length; index += 1) {
      if (source[index] === "{") depth += 1;
      else if (source[index] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    patches.push(source.slice(match.index + match[0].length, index));
    opener.lastIndex = index;
    match = opener.exec(source);
  }
  return patches;
}

/** Only covers writes that "install a new image"; clearing (`: null`) does not reveal an image, so it does not matter. */
function installsImage(patch: string): boolean {
  return [
    ...patch.matchAll(
      /\b(?:imageUrl|previewImageUrl|referenceImageUrl)\s*:\s*([^\s,]+)/g,
    ),
  ].some((match) => match[1] !== "null");
}

function staleErrorOffenders(source: string): string[] {
  return updateNodeDataPatches(source).filter(
    (patch) =>
      installsImage(patch) &&
      !patch.includes("GENERATION_ERROR_CLEARED_PATCH") &&
      !patch.includes("buildImageGenerationSuccessPatch"),
  );
}

describe("stale generation-error banner", () => {
  it("translates persisted storage errors at render time and keeps raw diagnostics for copying", async () => {
    const raw = "DramaClawAPI image generation failed: 请求异常: " + // no-cjk-exempt: raw backend error text matched at render time
      "MediaStorageUnavailable('MEDIA_STORAGE_READ_MISMATCH: 媒体存储读取校验失败。')"; // no-cjk-exempt: raw backend error text matched at render time
    const data = {
      displayName: "图片节点16", // no-cjk-exempt: legacy saved Chinese title
      autoTitleIndex: 16,
      generationError: raw,
      generationErrorDetails: raw,
      generationErrorRequestId: "req-storage",
      isGenerating: false,
      model: "test-model",
    };
    canvasStoreMock.reset(data);
    const writeText = vi.fn().mockResolvedValue(undefined);
    const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    try {
      render(React.createElement(ImageGenNode, {
        id: "image-1", data, selected: true, width: 580, height: 360,
        type: "imageGenNode", dragging: false, zIndex: 0,
        selectable: true, deletable: true, draggable: true, isConnectable: true,
        positionAbsoluteX: 0, positionAbsoluteY: 0,
      } as never));
      expect(screen.getByText(
        "MEDIA_STORAGE_READ_MISMATCH: Media storage read verification failed. Check the storage access settings.",
      )).toBeInTheDocument();
      expect(screen.queryByText(raw)).not.toBeInTheDocument();
      await act(async () => {
        fireEvent.click(screen.getByTitle("nodeToolbar.copyErrorReport"));
      });
      expect(writeText).toHaveBeenCalledWith(raw);
      expect(data.generationErrorDetails).toBe(raw);
    } finally {
      if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard);
      else Reflect.deleteProperty(navigator, "clipboard");
    }
  });

  it("removes the rendered failure banner when a history image is restored", () => {
    canvasStoreMock.reset({
      displayName: "Image",
      imageUrl: "https://example.test/failed.png",
      previewImageUrl: "https://example.test/failed.png",
      generationError: "provider failed",
      generationErrorDetails: "provider details",
      generationErrorRequestId: "req-old",
      isGenerating: false,
      model: "test-model",
    });

    function Harness() {
      const data = useSyncExternalStore(
        canvasStoreMock.subscribe,
        () => canvasStoreMock.getState().nodeData as Record<string, unknown>,
      );
      return React.createElement(ImageGenNode, {
        id: "image-1",
        data,
        selected: true,
        width: 580,
        height: 360,
        type: "imageGenNode",
        dragging: false,
        zIndex: 0,
        selectable: true,
        deletable: true,
        draggable: true,
        isConnectable: true,
        positionAbsoluteX: 0,
        positionAbsoluteY: 0,
      } as never);
    }

    render(React.createElement(Harness));
    expect(screen.getByText("provider failed")).toBeInTheDocument();

    act(() =>
      fireEvent.click(screen.getByRole("button", { name: "restore history" })),
    );

    expect(screen.queryByText("provider failed")).not.toBeInTheDocument();
    expect(canvasStoreMock.updateNodeData).toHaveBeenCalledWith(
      "image-1",
      expect.objectContaining({
        imageUrl: "https://example.test/restored.png",
        generationError: null,
        generationErrorDetails: null,
        generationErrorRequestId: null,
      }),
    );
  });

  it("clears every field the failure overlay reads", () => {
    // The popover reads these three fields (copy / details / request ID); missing to clear any one would leave a ghost.
    expect(Object.keys(GENERATION_ERROR_CLEARED_PATCH).sort()).toEqual([
      "generationError",
      "generationErrorDetails",
      "generationErrorRequestId",
    ]);
    expect(Object.values(GENERATION_ERROR_CLEARED_PATCH)).toEqual([
      null,
      null,
      null,
    ]);
    expect(buildImageGenerationSuccessPatch("https://x/y.png")).toMatchObject(
      GENERATION_ERROR_CLEARED_PATCH,
    );
  });

  it("clears the failure state on every in-place image write in ImageGenNode", () => {
    const source = read("src/features/canvas/nodes/ImageGenNode.tsx");

    // The failure banner is absolute-positioned over the image; as long as the node got a new image without clearing the error fields,
    // the previous "generation failed" would smear over the new image.
    expect(source).toContain("{!isGenerating && generationError && (");

    expect(staleErrorOffenders(source)).toEqual([]);
  });

  // The submit orchestration (handleSubmit / result backfill) lives in the shared hook, shared by the workflow and storyboard
  // views. The image-writing paths moved there, so the scanner must follow, otherwise this guardrail would run empty.
  it("clears the failure state on every image write in the shared image form hook", () => {
    expect(
      staleErrorOffenders(
        read("src/features/canvas/nodes/shared/useImageGenerationForm.ts"),
      ),
    ).toEqual([]);
  });

  // All four editor popovers write a new image onto the node. Upscale is the only one that rewrites the source node in place
  // (the other three addNode a new result node), so only it genuinely leaves the previous round's failure ghost;
  // the other three are included too, to block silent regression if they are changed to in-place writes later.
  it.each([
    "src/features/canvas/ui/UpscaleEditorOverlay.tsx",
    "src/features/canvas/ui/EraseOverlay.tsx",
    "src/features/canvas/ui/RedrawOverlay.tsx",
    "src/features/canvas/ui/OutpaintEditorOverlay.tsx",
  ])("clears the failure state on every image write in %s", (path) => {
    expect(staleErrorOffenders(read(path))).toEqual([]);
  });

  // Upscale reuses the source node in place, so "starting a new round" itself must clear the previous round's request ID,
  // without waiting for backfill success — on a mid-way failure the banner would hang on the previous request ID.
  it("clears the previous failure when an in-place upscale starts", () => {
    const source = read("src/features/canvas/ui/UpscaleEditorOverlay.tsx");
    const startPatch = updateNodeDataPatches(source).find((patch) =>
      /isGenerating\s*:\s*true/.test(patch),
    );

    expect(startPatch).toBeDefined();
    expect(startPatch).toContain("GENERATION_ERROR_CLEARED_PATCH");
  });

  // The reference image ranks last in display priority: when a generated image exists it cannot take over the body, and the failure info still matches that
  // old image, so it must not be cleared the moment one is uploaded.
  it("only clears the banner on reference upload when nothing was generated yet", () => {
    const source = read("src/features/canvas/nodes/ImageGenNode.tsx");
    const uploadPatch = updateNodeDataPatches(source).find((patch) =>
      patch.includes("referenceImageUrl: result.url"),
    );

    expect(uploadPatch).toBeDefined();
    expect(uploadPatch).toContain(
      "hasGeneratedResult ? {} : GENERATION_ERROR_CLEARED_PATCH",
    );
  });

  it("clears the request id alongside the message in the Canvas job poller", () => {
    const source = read("src/features/canvas/Canvas.tsx");
    const successPatch = source.slice(
      source.indexOf("generationStoryboardMetadata: undefined,"),
      source.indexOf("generationDebugContext: undefined,"),
    );

    expect(successPatch).toContain("generationError: null,");
    expect(successPatch).toContain("generationErrorDetails: null,");
    expect(successPatch).toContain("generationErrorRequestId: null,");
  });

  // The counter lives in the shared hook (handleSubmit is there), and the voiding is triggered by the host's image-swap paths;
  // the two sides connect via invalidateInFlightGeneration; the assertion is split in two precisely to watch this seam.
  it("invalidates late batch writes when a history image replaces the result", () => {
    const host = read("src/features/canvas/nodes/ImageGenNode.tsx");
    const restoreStart = host.indexOf(
      "const handleRestoreHistory = useCallback",
    );
    const restoreEnd = host.indexOf("// After generation ends (success/failure)", restoreStart);
    const restoreHandler = host.slice(restoreStart, restoreEnd);
    expect(restoreHandler).toContain("invalidateInFlightGeneration()");

    const hook = read("src/features/canvas/nodes/shared/useImageGenerationForm.ts");
    const submitStart = hook.indexOf("const handleSubmit = useCallback");
    const submitEnd = hook.indexOf("useEffect(() => {", submitStart);
    const submitHandler = hook.slice(submitStart, submitEnd);

    expect(hook).toContain("const generationAttemptRef = useRef(0)");
    expect(hook).toContain("generationAttemptRef.current += 1");
    expect(submitHandler).toContain(
      "generationAttemptRef.current === generationAttempt",
    );
    expect(
      submitHandler.match(/if \(!isCurrentGenerationAttempt\(\)\) return;/g),
    ).toHaveLength(3);
  });
});

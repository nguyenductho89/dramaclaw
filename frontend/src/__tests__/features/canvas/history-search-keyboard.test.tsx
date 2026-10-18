// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";

const translations: Record<string, string> = {
  "canvas.history.title": "History Assets",
  "canvas.history.tabs.image": "Images",
  "canvas.history.tabs.video": "Videos",
  "canvas.history.tabs.audio": "Audio",
  "canvas.history.tabs.world": "World Models",
  "canvas.history.noMatch": "No matching history assets",
  "canvas.history.noMatchOtherTabs": "No matches in this tab — try {{tabs}}",
  "canvas.history.delete": "Delete",
  "canvas.history.deleteConfirmTitle": "Delete this history asset?",
  "canvas.history.deleteConfirmDescription": "It will be permanently removed from History Assets. Content already used on the canvas will not be affected.",
  "canvas.history.deleteConfirmAction": "Delete",
  "canvas.history.promptTitle": "Prompt",
  "canvas.history.viewFullPrompt": "View full prompt",
  "common.cancel": "Cancel",
};

const i18nState = vi.hoisted(() => ({ language: "en" }));
const canvasState = vi.hoisted(() => ({ nodes: [] as unknown[] }));
const historyState = vi.hoisted(() => ({
  records: [] as Record<string, unknown>[],
  removeRecord: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      const raw = translations[key] ?? key;
      return options
        ? raw.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options[name] ?? ""))
        : raw;
    },
    i18n: { language: i18nState.language, resolvedLanguage: i18nState.language },
  }),
}));

vi.mock("@/stores/canvasStore", () => ({
  useCanvasStore: (selector: (state: { nodes: unknown[] }) => unknown) => selector(canvasState),
}));

// Tests only the search box keyboard behavior and empty-state text, keeping the whole dependency graph of generation history / viewers / director out
// (the viewer-kit chain would drag three.js into jsdom).
vi.mock("@/features/canvas/hooks/useCanvasGenerationHistory", () => ({
  useCanvasGenerationHistory: () => ({
    records: historyState.records,
    isLoading: false,
    removeRecord: historyState.removeRecord,
  }),
}));
vi.mock("@/features/canvas/ui/ImageViewerModal", () => ({ ImageViewerModal: () => null }));
vi.mock("@/features/canvas/ui/VideoViewerModal", () => ({ VideoViewerModal: () => null }));
vi.mock("@/features/viewer-kit/three-d/ThreeDDirectorDialog", () => ({
  ThreeDDirectorDialog: () => null,
}));
vi.mock("@/features/viewer-kit/three-d/directorManifest", () => ({
  buildStandaloneWorldManifest: () => null,
}));

import { CanvasHistoryAssetsModal } from "@/features/canvas/ui/CanvasHistoryAssetsModal";
import { ConfirmDialogHost } from "@/components/confirm-dialog-host";

function node(type: string, id: string, data: Record<string, unknown>) {
  return { id, type, position: { x: 0, y: 0 }, data } as unknown as CanvasNode;
}

function renderModal(
  onClose = vi.fn(),
  assetSource: "generation-history" | "live-canvas" = "live-canvas",
) {
  render(
    <>
      <CanvasHistoryAssetsModal
        onClose={onClose}
        onUseAsset={vi.fn()}
        onDeleteNode={vi.fn()}
        assetSource={assetSource}
      />
      <ConfirmDialogHost />
    </>,
  );
  return { onClose, input: screen.getByRole("searchbox") as HTMLInputElement };
}

afterEach(() => {
  i18nState.language = "en";
  canvasState.nodes = [];
  historyState.records = [];
  historyState.removeRecord.mockReset();
});

describe("CanvasHistoryAssetsModal delete confirmation", () => {
  it("does not delete on cancel, and deletes the matching history record on confirm", async () => {
    const user = userEvent.setup();
    historyState.records = [
      {
        schema_version: 1,
        canvas_id: "default",
        node_id: "n1",
        recorded_at: "2026-07-17T00:00:00Z",
        id: "image:r1",
        task_type: "image",
        task_key: "image",
        job_id: "r1",
        status: "completed",
        media_type: "image",
        result: { output_url: "/static/demo/history.png" },
      },
    ];
    historyState.removeRecord.mockResolvedValue(true);
    renderModal(vi.fn(), "generation-history");

    await user.click(screen.getByRole("button", { name: "Delete" }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("Delete this history asset?");
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(historyState.removeRecord).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }),
    );
    expect(historyState.removeRecord).toHaveBeenCalledWith("n1", "image:r1");
  });
});

describe("CanvasHistoryAssetsModal progressive prompt display", () => {
  it("the card shows only a two-line summary, and a click opens the full prompt", async () => {
    const user = userEvent.setup();
    const prompt = "Design a landscape poster for a mini game, with the hero jumping between platforms at different heights.";
    historyState.records = [
      {
        schema_version: 1,
        canvas_id: "default",
        node_id: "n1",
        recorded_at: "2026-08-27T00:00:00Z",
        id: "image:prompt",
        task_type: "image",
        task_key: "image",
        job_id: "prompt",
        status: "completed",
        media_type: "image",
        prompt,
        result: { output_url: "/static/demo/history-prompt.png" },
      },
    ];
    renderModal(vi.fn(), "generation-history");

    const caption = screen.getByRole("button", { name: "View full prompt" });
    expect(caption).toHaveClass("h-12");
    expect(caption.querySelector("span")).toHaveClass("line-clamp-2");
    expect(caption).toHaveAttribute("title", "View full prompt");
    expect(caption.querySelector("svg")).toHaveClass("lucide-maximize-2");
    const hoverLayer = caption.closest(".group")?.querySelector('[class*="backdrop-blur"]');
    expect(hoverLayer).toHaveClass("bg-black/50", "backdrop-blur-[10px]");
    expect(hoverLayer?.parentElement).toHaveClass("isolate", "rounded-t-md");
    expect(hoverLayer?.parentElement).toHaveStyle({
      clipPath: "inset(0 round var(--radius-md) var(--radius-md) 0 0)",
    });

    await user.click(caption);
    expect(screen.getByRole("heading", { name: "Prompt" })).toBeInTheDocument();
    expect(screen.getAllByText(prompt)).toHaveLength(2);
  });
});

describe("CanvasHistoryAssetsModal fixed five-column layout", () => {
  it("removes the ratio control and fixes each date group to a five-column grid", () => {
    historyState.records = Array.from({ length: 7 }, (_, index) => ({
      schema_version: 1,
      canvas_id: "default",
      node_id: `n${index}`,
      recorded_at: "2026-08-27T00:00:00Z",
      id: `image:${index}`,
      task_type: "image",
      task_key: "image",
      job_id: `job-${index}`,
      status: "completed",
      media_type: "image",
      result: { output_url: `/static/demo/history-${index}.png` },
    }));
    renderModal(vi.fn(), "generation-history");

    const dialog = screen.getByRole("dialog", { name: "History Assets" });
    const assetGrid = dialog.querySelector(".grid-cols-5");

    expect(dialog).toHaveClass("w-[min(1200px,94vw)]");
    expect(assetGrid).toHaveClass("grid", "grid-cols-5", "gap-3");
    expect(assetGrid?.children).toHaveLength(7);
    expect(screen.queryByLabelText("canvas.toolbar.zoomOut")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("canvas.toolbar.zoomIn")).not.toBeInTheDocument();
  });
});

describe("CanvasHistoryAssetsModal search box Escape", () => {
  it("pressing Escape while composing only cancels the candidates, without closing the dialog or clearing the typed query", async () => {
    const { onClose, input } = renderModal();

    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "xiaomao" } });
    // During IME composition the browser still bubbles the Escape keydown up to document -- that is exactly the regression point:
    // the search box guard skips it (no stopPropagation), so the global listener must recognize isComposing itself.
    fireEvent.keyDown(input, { key: "Escape", isComposing: true });

    expect(onClose).not.toHaveBeenCalled();
    expect(input.value).toBe("xiaomao");
  });

  it("outside composition, with content in the box, Escape first clears the search without closing the dialog", async () => {
    const user = userEvent.setup();
    const { onClose, input } = renderModal();

    await user.type(input, "cat");
    fireEvent.keyDown(input, { key: "Escape" });

    expect(input.value).toBe("");
    expect(onClose).not.toHaveBeenCalled();
  });

  it("Escape closes the dialog when the search box is empty", () => {
    const { onClose, input } = renderModal();

    fireEvent.keyDown(input, { key: "Escape" });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("CanvasHistoryAssetsModal cross-category empty state", () => {
  // resolveMediaUrl only lets same-origin /static paths through, and cross-origin absolute urls are judged null (the asset then cannot enter a bucket).
  const nodes = [
    node(CANVAS_NODE_TYPES.upload, "n-img", {
      imageUrl: "/static/demo/dog.png",
      displayName: "dog",
    }),
    node(CANVAS_NODE_TYPES.video, "n-vid", {
      videoUrl: "/static/demo/cat.mp4",
      displayName: "cat clip",
    }),
    node(CANVAS_NODE_TYPES.audio, "n-aud", {
      audioUrl: "/static/demo/cat.mp3",
      displayName: "cat theme",
    }),
  ];

  it("joins the other matching categories with an English conjunction", async () => {
    const user = userEvent.setup();
    canvasState.nodes = nodes;
    const { input } = renderModal();

    await user.type(input, "cat");

    const empty = screen.getByText(/No matches in this tab/);
    expect(empty).toHaveTextContent("try Videos or Audio");
  });
});

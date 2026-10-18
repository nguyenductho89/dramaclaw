import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CanvasNode } from "@/features/canvas/domain/canvasNodes";
const { generate, viewer } = vi.hoisted(() => ({
  generate: vi.fn(),
  viewer: vi.fn(),
}));
vi.mock("@/features/canvas/application/derivedMedia", () => ({
  generateDerivedMedia: generate,
}));
vi.mock("@/features/canvas/ui/ImageDerivedActions", () => ({
  useDerivedVideoCost: () => ({
    available: true,
    cost: { data: { data: { display: "80" } } },
  }),
}));
vi.mock("@/components/credit-cost-inline", () => ({
  CreditCostInline: () => null,
}));
vi.mock("@/stores/canvasStore", () => ({
  useCanvasStore: () => ({ updateNodeData: vi.fn(), openImageViewer: viewer }),
}));
vi.mock("@/lib/url-params", () => ({
  readUrl: () => ({ project: "p", canvas: "c" }),
}));
import { DerivedMediaActions } from "@/features/canvas/ui/DerivedMediaActions";
function node(data: Record<string, unknown>): CanvasNode {
  return {
    id: "gif",
    type: "animatedGifNode",
    position: { x: 0, y: 0 },
    data,
  } as CanvasNode;
}
describe("derived media toolbar states", () => {
  it("requires confirmation before regenerating a paid video", () => {
    generate.mockClear();
    render(<DerivedMediaActions node={node({ sourceImageUrl: "/a.png", generationError: "failed" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Regenerate video" }));
    expect(generate).not.toHaveBeenCalled();
    expect(screen.getByText(/Video is billed at the quoted price/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm generation" }));
    expect(generate).toHaveBeenCalledWith("p", "gif", "gif", "/a.png", undefined, "c", expect.any(Function));
  });
  it("offers preview/download after success without duplicate delete or retry", () => {
    render(<DerivedMediaActions node={node({ imageUrl: "/a.gif" })} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    expect(viewer).toHaveBeenCalledWith("/a.gif", ["/a.gif"]);
    expect(screen.getByRole("button", { name: "Download GIF" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete|Retry/ })).toBeNull();
  });
  it("only retries local conversion when a paid video exists", () => {
    render(
      <DerivedMediaActions
        node={node({
          sourceImageUrl: "/a.png",
          sourceVideoUrl: "/v.mp4",
          generationError: "failed",
        })}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry conversion · Free" }));
    expect(generate).toHaveBeenCalledWith(
      "p",
      "gif",
      "gif",
      "/a.png",
      "/v.mp4",
      "c",
      expect.any(Function),
    );
  });
  it("shows stage without allowing duplicate generation while busy", () => {
    render(
      <DerivedMediaActions
        node={node({ isGenerating: true, generationStage: "Converting GIF" })}
      />,
    );
    expect(screen.getByRole("status").textContent).toContain("Converting GIF");
    expect(screen.queryByRole("button")).toBeNull();
  });
});

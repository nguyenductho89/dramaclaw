// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const listFreezoneBeatContext = vi.fn();
const listFreezoneProjectAssets = vi.fn();
const fetchFreezoneVideoCharacterLibrary = vi.fn();
const fetchFreezoneAssetLibraryFolders = vi.fn();
const syncFreezoneAssetLibraryFromMainline = vi.fn();

vi.mock("@/api/projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/projects")>()),
  listFreezoneBeatContext: (...args: unknown[]) => listFreezoneBeatContext(...args),
  listFreezoneProjectAssets: (...args: unknown[]) => listFreezoneProjectAssets(...args),
}));

vi.mock("@/api/ops", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/ops")>()),
  fetchFreezoneVideoCharacterLibrary: (...args: unknown[]) =>
    fetchFreezoneVideoCharacterLibrary(...args),
  fetchFreezoneAssetLibraryFolders: (...args: unknown[]) =>
    fetchFreezoneAssetLibraryFolders(...args),
  syncFreezoneAssetLibraryFromMainline: (...args: unknown[]) =>
    syncFreezoneAssetLibraryFromMainline(...args),
}));

vi.mock("@/features/freezone/CanvasesTab", () => ({
  CanvasesTab: () => null,
}));

// The "Mainline assets" tab is controlled by the backend's mainline product surface switch; test with it on by default.
let mainlineAvailable = true;
vi.mock("@/lib/queries/product-surfaces", () => ({
  useProductSurfaces: () => ({ data: undefined, isPending: false }),
  surfaceAccess: (_data: unknown, code: string) =>
    code === "mainline"
      ? {
          surface_code: "mainline",
          label: "Market",
          available: mainlineAvailable,
          unavailable_message: "",
        }
      : undefined,
}));

import { AssetLibraryPanel } from "@/features/freezone/AssetLibraryPanel";

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  };
}

describe("AssetLibraryPanel beat context", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mainlineAvailable = true;
  });

  it("shares one project asset request across matching panels", async () => {
    listFreezoneProjectAssets.mockResolvedValue([]);
    listFreezoneBeatContext.mockResolvedValue({
      scope: { episode: null, beat: null },
      episodes: [],
      assets: [],
    });

    render(
      <>
        <AssetLibraryPanel
          project="demo"
          metadata={{ kind: "default" }}
          currentCanvasId="user_admin_demo"
        />
        <AssetLibraryPanel
          project="demo"
          metadata={{ kind: "default" }}
          currentCanvasId="user_admin_demo"
        />
      </>,
      { wrapper: makeWrapper() },
    );

    await vi.waitFor(() => expect(listFreezoneProjectAssets).toHaveBeenCalledTimes(1));
  });

  it("refetches shared beat context when the asset reload token changes", async () => {
    listFreezoneProjectAssets.mockResolvedValue([]);
    listFreezoneBeatContext.mockResolvedValue({
      scope: { episode: null, beat: null },
      episodes: [],
      assets: [],
    });

    const { rerender } = render(
      <AssetLibraryPanel
        project="demo"
        metadata={{ kind: "default" }}
        currentCanvasId="user_admin_demo"
        reloadToken={0}
      />,
      { wrapper: makeWrapper() },
    );

    await vi.waitFor(() => expect(listFreezoneBeatContext).toHaveBeenCalledTimes(1));
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      rerender(
        <AssetLibraryPanel
          project="demo"
          metadata={{ kind: "default" }}
          currentCanvasId="user_admin_demo"
          reloadToken={1}
        />,
      );
    });

    await vi.waitFor(() => expect(listFreezoneBeatContext).toHaveBeenCalledTimes(2));
  });

  it("clears the project asset error after a successful refetch", async () => {
    listFreezoneProjectAssets
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce([]);
    listFreezoneBeatContext.mockResolvedValue({
      scope: { episode: null, beat: null },
      episodes: [],
      assets: [],
    });

    const { rerender } = render(
      <AssetLibraryPanel
        project="demo"
        metadata={{ kind: "default" }}
        currentCanvasId="user_admin_demo"
        reloadToken={0}
        collapsed={false}
      />,
      { wrapper: makeWrapper() },
    );

    fireEvent.click(screen.getByRole("tab", { name: "Mainline assets" }));
    await screen.findByText(/Failed to load project assets: network down/);

    act(() => {
      rerender(
        <AssetLibraryPanel
          project="demo"
          metadata={{ kind: "default" }}
          currentCanvasId="user_admin_demo"
          reloadToken={1}
          collapsed={false}
        />,
      );
    });

    await vi.waitFor(() => expect(listFreezoneProjectAssets).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => {
      expect(screen.queryByText(/Failed to load project assets/)).toBeNull();
    });
  });

  it("keeps beat director outputs out of the scene asset tab", async () => {
    listFreezoneProjectAssets.mockResolvedValue([
      {
        id: "beat-1-director",
        tab: "director",
        kind: "director",
        role: "director_combined",
        label: "Director composite",
        sublabel: "EP1 / Beat 1",
        url: "/static/director_control_frames/ep001/beat_01/combined.png",
        rel_path: "director_control_frames/ep001/beat_01/combined.png",
        media_type: "image",
        exists: true,
        meta: { episode: 1, beat: 1 },
      },
      {
        id: "beat-1-background",
        tab: "director",
        kind: "director",
        role: "selected_background",
        label: "Current background · Beat 1",
        sublabel: "EP1 / Beat 1",
        url: "/static/director_control_frames/ep001/beat_01/selected_background.png",
        rel_path: "director_control_frames/ep001/beat_01/selected_background.png",
        media_type: "image",
        exists: true,
        meta: { episode: 1, beat: 1 },
      },
      {
        id: "scene-master-kitchen",
        tab: "scenes",
        kind: "scene",
        role: "scene_master",
        label: "Kitchen",
        sublabel: "scene master",
        url: "/static/assets/scenes/kitchen/master.png",
        rel_path: "assets/scenes/kitchen/master.png",
        media_type: "image",
        exists: true,
        meta: { scene_id: "Kitchen" },
      },
    ]);
    listFreezoneBeatContext.mockResolvedValue({
      scope: { episode: null, beat: null },
      episodes: [],
      assets: [],
    });

    render(
      <AssetLibraryPanel
        project="demo"
        metadata={{ kind: "default" }}
        currentCanvasId="user_admin_demo"
        collapsed={false}
      />,
      { wrapper: makeWrapper() },
    );

    fireEvent.click(screen.getByRole("tab", { name: "Mainline assets" }));
    fireEvent.click(screen.getByRole("button", { name: /Scene/ }));
    expect(await screen.findByText("Kitchen")).toBeInTheDocument();
    expect(screen.queryByText("Director composite")).toBeNull();
    expect(screen.queryByText("Current background · Beat 1")).toBeNull();
  });

  it("keeps concrete scene slots and hides auxiliary scene pointers", async () => {
    listFreezoneProjectAssets.mockResolvedValue([
      {
        id: "scene-master-kitchen",
        tab: "scenes",
        kind: "scene",
        role: "scene_master",
        label: "Kitchen / master",
        sublabel: "Kitchen",
        url: "/static/assets/scenes/kitchen/master.png",
        rel_path: "assets/scenes/kitchen/master.png",
        media_type: "image",
        exists: true,
        meta: { scene_id: "Kitchen" },
      },
      {
        id: "scene-reverse-kitchen",
        tab: "scenes",
        kind: "scene",
        role: "scene_reverse_master",
        label: "Kitchen / reverse master",
        sublabel: "Kitchen",
        url: "/static/assets/scenes/kitchen/reverse_master.png",
        rel_path: "assets/scenes/kitchen/reverse_master.png",
        media_type: "image",
        exists: true,
        meta: { scene_id: "Kitchen" },
      },
      {
        id: "scene-deprecated-360-kitchen",
        tab: "scenes",
        kind: "scene",
        role: "scene_360",
        label: "Kitchen / old 360",
        sublabel: "Kitchen",
        url: "/static/assets/scenes/kitchen/scene_panorama_sketch_360.png",
        rel_path: "assets/scenes/kitchen/scene_panorama_sketch_360.png",
        media_type: "image",
        exists: true,
        meta: { scene_id: "Kitchen" },
      },
      {
        id: "scene-director-pano-kitchen",
        tab: "scenes",
        kind: "scene",
        role: "scene_director_pano_360",
        label: "Kitchen / director pano 360",
        sublabel: "Kitchen",
        url: "/static/director_worlds/kitchen/v1/pano_360.png",
        rel_path: "director_worlds/kitchen/v1/pano_360.png",
        media_type: "image",
        exists: true,
        meta: { scene_id: "Kitchen" },
      },
      {
        id: "scene-3gs-master-kitchen",
        tab: "scenes",
        kind: "scene",
        role: "scene_3gs_master_ply",
        label: "Kitchen / 3D world (front)",
        sublabel: "Kitchen",
        url: "/static/assets/scenes/kitchen/3dgs/master.sog",
        rel_path: "assets/scenes/kitchen/3dgs/master.sog",
        media_type: "file",
        exists: true,
        meta: { scene_id: "Kitchen" },
      },
      {
        id: "scene-3gs-reverse-kitchen",
        tab: "scenes",
        kind: "scene",
        role: "scene_3gs_reverse_ply",
        label: "Kitchen / 3D world (back)",
        sublabel: "Kitchen",
        url: "/static/assets/scenes/kitchen/3dgs/reverse.sog",
        rel_path: "assets/scenes/kitchen/3dgs/reverse.sog",
        media_type: "file",
        exists: true,
        meta: { scene_id: "Kitchen" },
      },
      {
        id: "scene-3gs-pano-kitchen",
        tab: "scenes",
        kind: "scene",
        role: "scene_3gs_pano_ply",
        label: "Kitchen / 3D world (360)",
        sublabel: "Kitchen",
        url: "/static/assets/scenes/kitchen/3dgs/pano.sog",
        rel_path: "assets/scenes/kitchen/3dgs/pano.sog",
        media_type: "file",
        exists: true,
        meta: { scene_id: "Kitchen" },
      },
      {
        id: "scene-3gs-active-kitchen",
        tab: "scenes",
        kind: "scene",
        role: "scene_3gs_active_ply",
        label: "Kitchen / 3D world (current)",
        sublabel: "Kitchen",
        url: "/static/assets/scenes/kitchen/3dgs/active.sog",
        rel_path: "assets/scenes/kitchen/3dgs/active.sog",
        media_type: "file",
        exists: true,
        meta: { scene_id: "Kitchen" },
      },
      {
        id: "scene-3gs-collision-kitchen",
        tab: "scenes",
        kind: "scene",
        role: "scene_3gs_collision_glb",
        label: "Kitchen / 3D collider",
        sublabel: "Kitchen",
        url: "/static/assets/scenes/kitchen/3dgs/collision.glb",
        rel_path: "assets/scenes/kitchen/3dgs/collision.glb",
        media_type: "file",
        exists: true,
        meta: { scene_id: "Kitchen" },
      },
      {
        id: "scene-master-bedroom",
        tab: "scenes",
        kind: "scene",
        role: "scene_master",
        label: "Bedroom / master",
        sublabel: "Bedroom",
        url: "/static/assets/scenes/bedroom/master.png",
        rel_path: "assets/scenes/bedroom/master.png",
        media_type: "image",
        exists: true,
        meta: { scene_id: "Bedroom" },
      },
    ]);
    listFreezoneBeatContext.mockResolvedValue({
      scope: { episode: null, beat: null },
      episodes: [],
      assets: [],
    });

    render(
      <AssetLibraryPanel
        project="demo"
        metadata={{ kind: "default" }}
        currentCanvasId="user_admin_demo"
        collapsed={false}
      />,
      { wrapper: makeWrapper() },
    );

    fireEvent.click(screen.getByRole("tab", { name: "Mainline assets" }));
    fireEvent.click(screen.getByRole("button", { name: /Scene/ }));

    expect(await screen.findByText("Kitchen / master")).toBeInTheDocument();
    expect(screen.getByText("Kitchen / reverse master")).toBeInTheDocument();
    expect(screen.getByText("Kitchen / Director world")).toBeInTheDocument();
    expect(screen.getByText("Bedroom / master")).toBeInTheDocument();
    expect(screen.queryByText("Kitchen / old 360")).toBeNull();
    expect(screen.queryByText("Kitchen / director pano 360")).toBeNull();
    expect(screen.queryByText("Kitchen / 3D world (front)")).toBeNull();
    expect(screen.queryByText("Kitchen / 3D world (back)")).toBeNull();
    expect(screen.queryByText("Kitchen / 3D world (360)")).toBeNull();
    expect(screen.queryByText("Kitchen / 3D world (current)")).toBeNull();
    expect(screen.queryByText("Kitchen / 3D collider")).toBeNull();
    expect(screen.getAllByText("Front view")).toHaveLength(2);
    expect(screen.getAllByText("Reverse view")).toHaveLength(1);
    expect(screen.getAllByText("Director world")).toHaveLength(1);
    expect(screen.queryByText("360 image")).toBeNull();
    expect(screen.queryByText("Front world")).toBeNull();
    expect(screen.queryByText("Reverse world")).toBeNull();
    expect(screen.queryByText("360 world")).toBeNull();
    expect(screen.getByRole("button", { name: /Scene.*4/ })).toBeInTheDocument();
  });

  it("hides the mainline asset tab when the mainline surface is disabled", async () => {
    mainlineAvailable = false;
    listFreezoneProjectAssets.mockResolvedValue([]);
    listFreezoneBeatContext.mockResolvedValue({
      scope: { episode: null, beat: null },
      episodes: [],
      assets: [],
    });

    render(
      <AssetLibraryPanel
        project="demo"
        metadata={{ kind: "default" }}
        currentCanvasId="user_admin_demo"
        collapsed={false}
      />,
      { wrapper: makeWrapper() },
    );

    expect(screen.queryByRole("tab", { name: "Mainline assets" })).toBeNull();
    expect(screen.queryByPlaceholderText("Search assets...")).toBeNull();
    // "Project canvases" is not affected by this switch and must still be there.
    expect(screen.getByRole("tab", { name: "Project canvases" })).toBeInTheDocument();
  });

  it("falls back to the canvases tab when mainline is switched off while open", async () => {
    listFreezoneProjectAssets.mockResolvedValue([]);
    listFreezoneBeatContext.mockResolvedValue({
      scope: { episode: null, beat: null },
      episodes: [],
      assets: [],
    });

    const { rerender } = render(
      <AssetLibraryPanel
        project="demo"
        metadata={{ kind: "default" }}
        currentCanvasId="user_admin_demo"
        collapsed={false}
      />,
      { wrapper: makeWrapper() },
    );

    fireEvent.click(screen.getByRole("tab", { name: "Mainline assets" }));
    expect(screen.getByPlaceholderText("Search assets...")).toBeInTheDocument();

    mainlineAvailable = false;
    act(() => {
      rerender(
        <AssetLibraryPanel
          project="demo"
          metadata={{ kind: "default" }}
          currentCanvasId="user_admin_demo"
          collapsed={false}
        />,
      );
    });

    await vi.waitFor(() => {
      expect(screen.queryByPlaceholderText("Search assets...")).toBeNull();
    });
    expect(screen.queryByRole("tab", { name: "Mainline assets" })).toBeNull();
  });

  it("browses the project asset library under its own tab", async () => {
    listFreezoneProjectAssets.mockResolvedValue([]);
    listFreezoneBeatContext.mockResolvedValue({
      scope: { episode: null, beat: null },
      episodes: [],
      assets: [],
    });
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({
      items: [
        {
          id: "lib-1",
          name: "Reference A",
          media: "image",
          source: "upload",
          image_urls: ["/static/library/a.png"],
        },
        {
          id: "lib-2",
          name: "Kitchen still",
          media: "image",
          source: "scene",
          image_urls: ["/static/library/kitchen.png"],
        },
        {
          id: "lib-3",
          name: "Clip B",
          media: "video",
          source: "upload",
          video_url: "/static/library/b.mp4",
        },
      ],
    });

    render(
      <AssetLibraryPanel
        project="demo"
        metadata={{ kind: "default" }}
        currentCanvasId="user_admin_demo"
        collapsed={false}
      />,
      { wrapper: makeWrapper() },
    );

    fireEvent.click(screen.getByRole("tab", { name: "Asset library" }));

    // The root has only folders; items are visible only after clicking in.
    expect(
      await screen.findByRole("button", { name: "Folder Mainline" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Folder Uncategorized" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Reference A")).toBeNull();

    // Items synced from the mainline (characters/scenes/props alike) are all collected into one [Mainline] folder.
    fireEvent.click(screen.getByRole("button", { name: "Folder Mainline" }));
    expect(await screen.findByText("Kitchen still")).toBeInTheDocument();
    expect(screen.queryByText("Reference A")).toBeNull();

    // The breadcrumb goes back to the root, then enter [Uncategorized] to see the locally uploaded images and videos.
    fireEvent.click(screen.getByRole("button", { name: "Back to the asset library root" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Folder Uncategorized" }),
    );
    expect(await screen.findByText("Reference A")).toBeInTheDocument();
    expect(screen.getByText("Clip B")).toBeInTheDocument();
    expect(screen.queryByText("Kitchen still")).toBeNull();
  });

  it("keeps the asset library tab available when mainline is disabled", async () => {
    mainlineAvailable = false;
    listFreezoneProjectAssets.mockResolvedValue([]);
    listFreezoneBeatContext.mockResolvedValue({
      scope: { episode: null, beat: null },
      episodes: [],
      assets: [],
    });
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: [] });

    render(
      <AssetLibraryPanel
        project="demo"
        metadata={{ kind: "default" }}
        currentCanvasId="user_admin_demo"
        collapsed={false}
      />,
      { wrapper: makeWrapper() },
    );

    // The asset library holds locally uploaded assets, which are not part of the mainline, and must stay even with the switch off.
    expect(screen.queryByRole("tab", { name: "Mainline assets" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: "Asset library" }));
    expect(await screen.findByText(/asset library is empty/)).toBeInTheDocument();
  });

  it("opens the asset library modal from the tab bar icon", async () => {
    listFreezoneProjectAssets.mockResolvedValue([]);
    listFreezoneBeatContext.mockResolvedValue({
      scope: { episode: null, beat: null },
      episodes: [],
      assets: [],
    });
    fetchFreezoneVideoCharacterLibrary.mockResolvedValue({ items: [] });
    fetchFreezoneAssetLibraryFolders.mockResolvedValue([]);
    syncFreezoneAssetLibraryFromMainline.mockResolvedValue({ items: [] });

    render(
      <AssetLibraryPanel
        project="demo"
        metadata={{ kind: "default" }}
        currentCanvasId="user_admin_demo"
        collapsed={false}
      />,
      { wrapper: makeWrapper() },
    );

    // The entry is always present; it can be opened even while sitting on the "Project canvases" tab.
    expect(screen.getByRole("tab", { name: "Project canvases" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Asset manager" }));

    expect(
      await screen.findByRole("button", { name: "New folder" }),
    ).toBeInTheDocument();
    // The management state's batch capability has been narrowed to "Batch delete", applying only to locally uploaded assets - mainline-synced
    // items would be pulled back by the next sync after deletion. The entry copy was renamed accordingly, and the new name is asserted here.
    expect(screen.getByRole("button", { name: "Bulk delete" })).toBeInTheDocument();
  });
});

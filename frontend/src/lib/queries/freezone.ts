// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMutation, useQuery } from "@tanstack/react-query";
import { listFreezoneCanvases } from "@/api/canvas";
import {
  listFreezoneBeatContext,
  listFreezoneProjectAssets,
} from "@/api/projects";
import {
  fetchFreezoneAssetLibraryFolders,
  fetchFreezoneVideoCharacterLibrary,
} from "@/api/ops";
import { normalizeLibraryList } from "@/features/canvas/ui/assetLibraryItems";
import { api } from "@/lib/api";
import { p } from "@/lib/api-path";
import { queryKeys } from "@/lib/query-keys";
import type { OkResponse } from "@/types/api";

export type FreezonePresetCanvasRequest =
  | {
      scope: "episode";
      episode: number;
    }
  | {
      scope: "beat";
      episode: number;
      beat: number;
      primary_slot?: "sketch" | "frame" | "render" | string;
    }
  | {
      scope: "asset";
      asset_kind: "character";
      character: string;
    }
  | {
      scope: "asset";
      asset_kind: "portrait";
      character: string;
    }
  | {
      scope: "asset";
      asset_kind: "identity";
      character: string;
      identity_id: string;
    }
  | {
      scope: "asset";
      asset_kind: "prop" | "prop_ref";
      asset_id: string;
    }
  | {
      scope: "asset";
      asset_kind: "scene";
      asset_id: string;
    };

export interface FreezonePresetCanvasData {
  canvas_id: string;
  reused: boolean;
  url: string;
}

export function createFreezonePresetCanvas(project: string, data: FreezonePresetCanvasRequest) {
  return api
    .post(p`api/v1/projects/${project}/freezone/canvases:from-preset`, { json: data })
    .json<OkResponse<FreezonePresetCanvasData>>();
}

export function useCreateFreezonePresetCanvas(project: string) {
  return useMutation({
    mutationFn: (data: FreezonePresetCanvasRequest) =>
      createFreezonePresetCanvas(project, data),
  });
}

export function useFreezoneCanvases(
  project: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: project
      ? queryKeys.freezoneCanvases(project)
      : ["projects", "__missing__", "freezone", "canvases"],
    queryFn: ({ signal }) => {
      if (!project) {
        throw new Error("project is required");
      }
      return listFreezoneCanvases(project, { signal });
    },
    enabled: enabled && Boolean(project),
    staleTime: 15_000,
  });
}

export function useFreezoneProjectAssets(
  project: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: project
      ? queryKeys.freezoneProjectAssets(project)
      : ["projects", "__missing__", "freezone", "assets"],
    queryFn: ({ signal }) => {
      if (!project) {
        throw new Error("project is required");
      }
      return listFreezoneProjectAssets(project, { signal });
    },
    enabled: enabled && Boolean(project),
    staleTime: 15_000,
  });
}

/**
 * The list of the asset library (project-level material library). Writes all use bare calls and invalidate this key themselves,
 * to refresh the list (AssetLibraryModal upload/sync, rename/delete from the sidebar item menu).
 */
export function useFreezoneAssetLibrary(
  project: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: project
      ? queryKeys.freezoneAssetLibrary(project)
      : ["projects", "__missing__", "freezone", "asset-library"],
    queryFn: async () => {
      if (!project) {
        throw new Error("project is required");
      }
      return normalizeLibraryList(
        await fetchFreezoneVideoCharacterLibrary(project),
      );
    },
    enabled: enabled && Boolean(project),
    staleTime: 15_000,
  });
}

/**
 * User-created asset library folders. System folders (mainline / unclassified assets / category-named directories) are not persisted,
 * and are generated directly by buildAssetFolders, so this query only supplies the user-created part. Old backends have no such route,
 * so an empty list is assumed and the browse side still shows the system folders.
 */
export function useFreezoneAssetLibraryFolders(
  project: string | null | undefined,
  enabled = true,
) {
  return useQuery({
    queryKey: project
      ? queryKeys.freezoneAssetLibraryFolders(project)
      : ["projects", "__missing__", "freezone", "asset-library", "folders"],
    queryFn: async () => {
      if (!project) {
        throw new Error("project is required");
      }
      try {
        const folders = await fetchFreezoneAssetLibraryFolders(project);
        return Array.isArray(folders) ? folders : [];
      } catch (err) {
        console.warn("[asset-library] load folders failed, treat as empty", err);
        return [];
      }
    },
    enabled: enabled && Boolean(project),
    staleTime: 15_000,
  });
}

export function useFreezoneBeatContext(
  project: string | null | undefined,
  opts: { episode?: number | null; beat?: number | null } = {},
  enabled = true,
) {
  const episode = typeof opts.episode === "number" ? opts.episode : null;
  const beat = typeof opts.beat === "number" ? opts.beat : null;
  return useQuery({
    queryKey: project
      ? queryKeys.freezoneBeatContext(project, episode, beat)
      : ["projects", "__missing__", "freezone", "beat-context", episode, beat],
    queryFn: ({ signal }) => {
      if (!project) {
        throw new Error("project is required");
      }
      return listFreezoneBeatContext(project, {
        ...(episode !== null ? { episode } : {}),
        ...(beat !== null ? { beat } : {}),
        signal,
      });
    },
    enabled: enabled && Boolean(project),
    staleTime: 15_000,
  });
}

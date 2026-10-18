// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { isSlotTarget } from "../../canvas/domain/mainlineNodeTypes.ts";

/**
 * Extract the "committable media source URL" from node data, falling back by media type:
 * image -> video -> audio -> file/3GS/GLB. Shared by the Commit entry (FreezoneShell) and
 * CommitDialog, so that one place does not support audio while the other still reads only images.
 */
export function getCommitSourceUrl(data: unknown): string | null {
  if (!data || typeof data !== "object") return null;
  const value = data as Record<string, unknown>;
  const pick = (key: string): string | null =>
    typeof value[key] === "string" && (value[key] as string).trim().length > 0
      ? (value[key] as string)
      : null;
  return (
    pick("imageUrl") ??
    pick("videoUrl") ??
    pick("audioUrl") ??
    pick("fileUrl") ??
    pick("modelUrl") ??
    pick("plyUrl") ??
    pick("url")
  );
}

export function isCommitCandidateData(data: unknown): boolean {
  if (!data || typeof data !== "object") return false;

  const value = data as {
    preset_managed?: unknown;
    user_spawned?: unknown;
    slot_target?: unknown;
    committed_at?: unknown;
  };

  return (
    value.preset_managed !== true &&
    value.user_spawned === true &&
    isSlotTarget(value.slot_target) &&
    getCommitSourceUrl(data) !== null &&
    !(
      typeof value.committed_at === "string" &&
      value.committed_at.length > 0
    )
  );
}

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { SkillInputRole } from "./skillRoles.ts";

/**
 * Inference of "which input port of the skill node a canvas edge lands on".
 *
 * Background: in React Flow when the user drags a line from an asset node to a skill node, `targetHandle` may be
 * a specific input role (the user landed exactly on a handle), or empty / the generic `target`
 * (landed on the node body). The latter yields no role, and the connection is silently dropped by `applySkillRoleBindingConnection`
 * as "input port not found" - which shows up as "the scene image cannot connect to the skill node".
 *
 * Intent inference is done only on the frontend: the frontend knows best which source node the user dragged and which skill is the target.
 * The backend only gets resolved_inputs, where the drag intent is already lost, so it is not suited to inferring the role (see the backend analysis report).
 *
 * The rule only produces a "suggested role"; whether an edge is actually formed is still checked by the caller with skillSpec.inputs +
 * accepts; when nothing can be inferred it returns null and the caller keeps its default behavior without misjudging.
 */

export interface SkillConnectionNode {
  id: string;
  type?: string | null;
  data?: Record<string, unknown> | null;
}

export interface InferSkillConnectionRoleArgs {
  sourceNode: SkillConnectionNode | null | undefined;
  targetNode: SkillConnectionNode | null | undefined;
  /** The targetHandle given by React Flow - may be a specific role, or empty / "target". */
  requestedTargetHandle?: string | null;
}

/** The "generic" handle value React Flow gives when the user did not land exactly on an input port. */
const AMBIGUOUS_HANDLES = new Set(["", "target", "source"]);

/**
 * Source asset role / slot kind vocabulary -> skill input port role.
 * The token comes from the source node's `__freezone_source.role` or `slot_target.kind`,
 * and these two vocabularies do not fully match the input port role names (e.g. `selected_background` -> `background`,
 * `current_sketch` -> `sketch`), so an explicit mapping table is needed.
 */
const SOURCE_TOKEN_TO_INPUT_ROLE: Record<string, SkillInputRole> = {
  scene_master: "scene_master",
  scene_reverse_master: "scene_reverse_master",
  selected_background: "background",
  background: "background",
  background_candidate: "background",
  current_sketch: "sketch",
  sketch: "sketch",
  current_sketch_candidate: "sketch",
  sketch_candidate: "sketch",
  current_frame: "frame",
  frame: "frame",
  character_identity: "identity",
  portrait: "identity",
  identity: "identity",
  prop_reference: "prop",
  prop: "prop",
  director_combined: "director_combined",
  source_image: "source_image",
};

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** The role/slot tokens on the source node usable for classification, in priority order (role before slot). */
function sourceRoleTokens(node: SkillConnectionNode): string[] {
  const data = node.data ?? {};
  const tokens: string[] = [];
  const freezoneSource = asRecord(data.__freezone_source);
  const role = nonEmpty(freezoneSource?.role) ?? nonEmpty(data.role);
  if (role) tokens.push(role);
  const slotKind = nonEmpty(asRecord(data.slot_target)?.kind);
  if (slotKind) tokens.push(slotKind);
  return tokens;
}

function sourceHasImage(node: SkillConnectionNode): boolean {
  const data = node.data ?? {};
  return Boolean(
    nonEmpty(data.imageUrl) ?? nonEmpty(data.previewImageUrl) ?? nonEmpty(data.referenceImageUrl),
  );
}

export function inferSkillConnectionRole({
  sourceNode,
  targetNode,
  requestedTargetHandle,
}: InferSkillConnectionRoleArgs): string | null {
  if (!sourceNode || !targetNode) return null;

  // The user landed exactly on an input port handle - respect the user's intent and do not infer.
  const requested = nonEmpty(requestedTargetHandle);
  if (requested && !AMBIGUOUS_HANDLES.has(requested)) {
    return requested;
  }

  const skillId = nonEmpty(asRecord(targetNode.data)?.skill_id) ?? "";

  if (sourceNode.type === "beatContextNode") {
    return "beat_context";
  }

  // Skill-specific rule: "Set as current background" treats any image as source_image.
  if (skillId === "freezone.set_selected_background" && sourceHasImage(sourceNode)) {
    return "source_image";
  }

  // Generic rule: source asset role/slot vocabulary -> input port role.
  for (const token of sourceRoleTokens(sourceNode)) {
    const mapped = SOURCE_TOKEN_TO_INPUT_ROLE[token];
    if (mapped) return mapped;
  }

  return null;
}

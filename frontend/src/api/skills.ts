// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { jsonWithBackendError } from "@/lib/api-errors";
import { apiCall, apiClient } from "./client";
import type {
  ResolvedSkillInput,
  SkillDefinition,
  SkillMediaType,
  SkillOutputRole,
} from "@/features/freezone/context/skillRoles";

const REGISTRY_CACHE_TTL_MS = 5 * 60 * 1000;

let registryCache:
  | {
      loadedAt: number;
      value: SkillDefinition[];
    }
  | null = null;
let registryInFlight: Promise<SkillDefinition[]> | null = null;

export interface SkillRunRequest {
  schema_version?: string;
  skill_node_id: string;
  canvas_id?: string;
  idempotency_key?: string;
  resolved_inputs: ResolvedSkillInput[];
  parameters?: Record<string, unknown>;
}

export interface SkillRunResponse {
  schema_version?: string;
  run_id: string;
  status: string;
  task_key?: string | null;
  task_type?: string | null;
  job_id?: string | null;
  error?: SkillErrorEnvelope | null;
}

export interface SkillErrorEnvelope {
  code: string;
  category: string;
  message: string;
  retryable: boolean;
  user_action_hint?: string | null;
}

export interface SkillRunOutput {
  schema_version?: string;
  role: SkillOutputRole;
  media_type: SkillMediaType;
  node_type: string;
  pushable: boolean;
  image_url?: string | null;
  text?: string | null;
  json_value?: unknown;
  graph_patch?: CanvasGraphPatch | null;
  slot_target?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface CanvasGraphPatchOperation {
  op:
    | "add_node"
    | "update_node"
    | "delete_node"
    | "add_edge"
    | "update_edge"
    | "delete_edge";
  node?: Record<string, unknown> | null;
  edge?: Record<string, unknown> | null;
  node_id?: string | null;
  edge_id?: string | null;
  data?: Record<string, unknown> | null;
  [key: string]: unknown;
}

export interface CanvasGraphPatch {
  schema_version: "graph_patch.v1" | string;
  operations: CanvasGraphPatchOperation[];
  requires_apply: boolean;
  summary?: string | null;
}

export interface SkillRunResult {
  schema_version?: string;
  run_id: string;
  status: string;
  outputs: SkillRunOutput[];
  task_key?: string | null;
  task_type?: string | null;
  job_id?: string | null;
  error?: SkillErrorEnvelope | string | null;
}

// The frontend's "required" override of the backend skill registry: force the specified input slot of the specified skill to required,
// so that both the UI label (required/optional) and the submit-readiness check (isSkillReadyToSubmit) take effect by the stricter rule.
// key = skill id, value = the set of input roles to force required.
const REQUIRED_INPUT_OVERRIDES: Readonly<Record<string, ReadonlySet<string>>> = {
  // Generate a 360 panorama: scene hint / scene main image / scene back image, all three inputs are required.
  freezone_scene_360: new Set(["scene", "scene_master", "scene_reverse_master"]),
};

function applyRequiredOverrides(registry: SkillDefinition[]): SkillDefinition[] {
  return registry.map((skill) => {
    const requiredRoles = REQUIRED_INPUT_OVERRIDES[skill.id];
    if (!requiredRoles) {
      return skill;
    }
    return {
      ...skill,
      inputs: skill.inputs.map((input) =>
        requiredRoles.has(input.role) && !input.required
          ? { ...input, required: true }
          : input,
      ),
    };
  });
}

export async function getSkillRegistry(): Promise<SkillDefinition[]> {
  const now = Date.now();
  if (registryCache && now - registryCache.loadedAt < REGISTRY_CACHE_TTL_MS) {
    return registryCache.value;
  }
  if (registryInFlight) {
    return registryInFlight;
  }

  registryInFlight = apiCall<SkillDefinition[]>("freezone/skills")
    .then((value) => {
      const normalized = applyRequiredOverrides(value);
      registryCache = { loadedAt: Date.now(), value: normalized };
      return normalized;
    })
    .finally(() => {
      registryInFlight = null;
    });
  return registryInFlight;
}

export async function runSkill(
  project: string,
  skillId: string,
  request: SkillRunRequest,
): Promise<SkillRunResponse> {
  return await jsonWithBackendError<SkillRunResponse>(
    apiClient(
      `projects/${encodeURIComponent(project)}/freezone/skills/${encodeURIComponent(skillId)}/run`,
      { method: "POST", json: request },
    ),
  );
}

export async function getSkillRunResult(
  project: string,
  runId: string,
): Promise<SkillRunResult> {
  return await jsonWithBackendError<SkillRunResult>(
    apiClient(
      `projects/${encodeURIComponent(project)}/freezone/skills/runs/${encodeURIComponent(runId)}/result`,
    ),
  );
}

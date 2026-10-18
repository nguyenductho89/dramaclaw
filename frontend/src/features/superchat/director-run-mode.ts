import type { TaskState } from "@/task-center/types";

export type DirectorRunMode = "manual_confirm" | "episode_auto";
export type DirectorVoicePolicy = "system" | "custom";
export type DirectorAutoConfirmationStage =
  | "awaiting_start"
  | "awaiting_confirmation"
  | "awaiting_intervention"
  | "confirmed";

export interface DirectorAutoRunState {
  mode: DirectorRunMode;
  confirmationStage: DirectorAutoConfirmationStage;
  activatedAt: number;
  episode: number | null;
  handledKeys: string[];
  voicePolicy: DirectorVoicePolicy | null;
  voiceChoiceRequired: boolean;
  voicePrerequisiteErrors: string[];
}

export type DirectorAutoTaskDecision =
  | { action: "ignore" }
  | { action: "continue"; episode: number; key: string }
  | { action: "pause"; episode: number; key: string }
  | { action: "complete"; episode: number; key: string };

const STORAGE_PREFIX = "director.episodeRunMode";
const MAX_HANDLED_KEYS = 80;

const MAINLINE_EPISODE_TASK_TYPES = new Set([
  "build_episodes",
  "identity_planner",
  "character_portrait",
  "identity_image",
  "script_writer",
  "build_scenes",
  "scene_reference_asset",
  "prop_reference_asset",
  "sketch_grid_generation",
  "sketch_generation",
  "ai_identity_detection",
  "global_optimize_video",
  "selected_regen",
  "render_plan",
  "system_voice_setup",
  "audio_generation_indextts2",
  "single_video",
  "compose_episode",
]);

export function isDirectorAutoPipelineTask(task: TaskState): boolean {
  return MAINLINE_EPISODE_TASK_TYPES.has(task.task_type);
}

function storageKey(project: string): string {
  return `${STORAGE_PREFIX}:${project.trim() || "home"}`;
}

export function defaultDirectorRunState(): DirectorAutoRunState {
  return {
    mode: "manual_confirm",
    confirmationStage: "awaiting_start",
    activatedAt: 0,
    episode: null,
    handledKeys: [],
    voicePolicy: null,
    voiceChoiceRequired: false,
    voicePrerequisiteErrors: [],
  };
}

export function loadDirectorRunState(project: string): DirectorAutoRunState {
  if (typeof window === "undefined") return defaultDirectorRunState();
  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey(project)) || "null") as
      | Partial<DirectorAutoRunState>
      | null;
    if (!parsed || parsed.mode !== "episode_auto") return defaultDirectorRunState();
    const savedConfirmationStage = parsed.confirmationStage;
    return {
      mode: "episode_auto",
      // Stored auto runs from before the confirmation gate must not bypass
      // the new explicit second-confirmation requirement after an upgrade.
      confirmationStage:
        savedConfirmationStage === "awaiting_start"
        || savedConfirmationStage === "awaiting_confirmation"
        || savedConfirmationStage === "awaiting_intervention"
        || savedConfirmationStage === "confirmed"
          ? savedConfirmationStage
          : "awaiting_start",
      activatedAt: Number.isFinite(parsed.activatedAt) ? Number(parsed.activatedAt) : Date.now(),
      episode: Number.isInteger(parsed.episode) && Number(parsed.episode) > 0
        ? Number(parsed.episode)
        : null,
      handledKeys: Array.isArray(parsed.handledKeys)
        ? parsed.handledKeys.filter((item): item is string => typeof item === "string").slice(-MAX_HANDLED_KEYS)
        : [],
      voicePolicy: parsed.voicePolicy === "system" || parsed.voicePolicy === "custom"
        ? parsed.voicePolicy
        : null,
      voiceChoiceRequired: parsed.voiceChoiceRequired === true,
      voicePrerequisiteErrors: Array.isArray(parsed.voicePrerequisiteErrors)
        ? parsed.voicePrerequisiteErrors.filter((item): item is string => typeof item === "string").slice(0, 8)
        : [],
    };
  } catch {
    return defaultDirectorRunState();
  }
}

export function saveDirectorRunState(project: string, state: DirectorAutoRunState): void {
  if (typeof window === "undefined") return;
  if (state.mode === "manual_confirm") {
    window.localStorage.removeItem(storageKey(project));
    return;
  }
  window.localStorage.setItem(storageKey(project), JSON.stringify({
    ...state,
    handledKeys: state.handledKeys.slice(-MAX_HANDLED_KEYS),
  }));
}

export function activateDirectorEpisodeAuto(): DirectorAutoRunState {
  return {
    mode: "episode_auto",
    confirmationStage: "awaiting_start",
    activatedAt: Date.now(),
    episode: null,
    handledKeys: [],
    voicePolicy: null,
    voiceChoiceRequired: false,
    voicePrerequisiteErrors: [],
  };
}

export function awaitDirectorEpisodeAutoConfirmation(
  state: DirectorAutoRunState,
): DirectorAutoRunState {
  return {
    ...state,
    confirmationStage: "awaiting_confirmation",
  };
}

export function confirmDirectorEpisodeAuto(
  state: DirectorAutoRunState,
): DirectorAutoRunState {
  return {
    ...state,
    confirmationStage: "confirmed",
    activatedAt: Date.now(),
  };
}

export function isDirectorEpisodeAutoConfirmed(state: DirectorAutoRunState): boolean {
  return state.mode === "episode_auto" && state.confirmationStage === "confirmed";
}

export function isDirectorEpisodeAutoSession(state: DirectorAutoRunState): boolean {
  return state.mode === "episode_auto"
    && (state.confirmationStage === "confirmed"
      || state.confirmationStage === "awaiting_intervention");
}

const AUTO_START_INTENT_RE =
  /\b(?:start|begin|go ahead|proceed|continue|confirm|approve|ok(?:ay)?|yes)\b|(?:bắt đầu|tiếp tục|xác nhận|đồng ý|được)/iu;
const AUTO_NEGATED_START_RE =
  /\b(?:don'?t|do not|not yet|cancel|stop|pause|hold)\b.{0,20}\b(?:start|begin|run|proceed|continue|confirm)\b|(?:đừng|không|chưa|hủy|dừng|tạm dừng).{0,12}(?:bắt đầu|chạy|tiếp tục|xác nhận)/iu;

export function isDirectorEpisodeAutoStartIntent(text: string): boolean {
  const normalized = text.trim();
  return normalized.length > 0
    && AUTO_START_INTENT_RE.test(normalized)
    && !AUTO_NEGATED_START_RE.test(normalized);
}

export function directorAutoConfirmationTransportText(
  text: string,
  options: { voiceChoiceRequired?: boolean; voiceErrors?: string[] } = {},
): string {
  const voiceInstruction = options.voiceChoiceRequired
    ? " Before starting, the user must choose a voice policy. Explicitly present both choices: " +
      "'1) Missing voices are matched automatically with system voices by Shrimp Director; 2) I will upload or record custom voices in Shrimp Pond.' " +
      `${options.voiceErrors?.length ? `Known missing items: ${options.voiceErrors.join("; ")}. ` : ""}` +
      `Ask the user to reply "${VOICE_LABEL_SYSTEM}" or "${VOICE_LABEL_CUSTOM}"; do not start yet.`
    : " Then ask the user to reply Continue or Confirm to start.";
  return `${text}\n\n[DRAMACLAW_RUN_MODE_CONFIRMATION]\n`+
    "The user selected Episode Auto but has not completed the required second confirmation. " +
    "Do not call any write, generation, or mutation tool in this turn. Reply briefly in the user's language: " +
    "state that Episode Auto will safely advance the current episode until the final composition is " +
    "complete, and will pause on failure, unmet prerequisites, destructive or ambiguous actions, " +
    `or choices that require the user.${voiceInstruction}\n` +
    "[/DRAMACLAW_RUN_MODE_CONFIRMATION]";
}

const VOICE_LABEL_SYSTEM = "System voice";
const VOICE_LABEL_CUSTOM = "Custom voice";
const VOICE_LABELS_SYSTEM = [VOICE_LABEL_SYSTEM, "Giọng hệ thống"] as const;
const VOICE_LABELS_CUSTOM = [VOICE_LABEL_CUSTOM, "Giọng tùy chỉnh"] as const;
const SYSTEM_VOICE_RE = /(?:system voices?|giọng hệ thống|auto[- ]?match)/iu;
const CUSTOM_VOICE_RE = /(?:custom voices?|giọng tùy chỉnh|upload|record|voice sample|tải lên|ghi âm)/iu;
const VOICE_CHOICE_PROMPT_RE = /(?:please (?:reply|choose|select)|which (?:one|do you)|pick one|vui lòng (?:trả lời|chọn)|bạn chọn)/iu;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function resolveDirectorVoicePolicy(text: string): DirectorVoicePolicy | null {
  const normalized = text.trim();
  const system = SYSTEM_VOICE_RE.test(normalized);
  const custom = CUSTOM_VOICE_RE.test(normalized);
  if (system === custom) return null;
  return system ? "system" : "custom";
}

export function emphasizeDirectorVoiceChoiceLabels(text: string): string {
  const lower = text.toLowerCase();
  const systemLabel = VOICE_LABELS_SYSTEM.find((label) => lower.includes(label.toLowerCase()));
  const customLabel = VOICE_LABELS_CUSTOM.find((label) => lower.includes(label.toLowerCase()));
  if (!systemLabel || !customLabel || !VOICE_CHOICE_PROMPT_RE.test(text)) {
    return text;
  }
  return [systemLabel, customLabel].reduce((current, label) => (
    current.replace(
      new RegExp(`(?:\\*\\*)?(${escapeRegExp(label)})(?:\\*\\*)?`, "gi"),
      (_match, matched: string) => `**${matched}**`,
    )
  ), text);
}

export function directorAutoVoiceChoiceTransportText(text: string): string {
  return `${text}\n\n[DRAMACLAW_VOICE_POLICY_REQUIRED]\n`+
    "Do not start episode auto and do not call generation tools. The user's voice policy is still " +
    "unclear. Ask only: 'Please choose: 1) Missing voices are matched automatically with system voices by Shrimp Director; 2) I will upload or record custom voices in Shrimp Pond.' " +
    `Ask them to reply "${VOICE_LABEL_SYSTEM}" or "${VOICE_LABEL_CUSTOM}".\n[/DRAMACLAW_VOICE_POLICY_REQUIRED]`;
}

export function markDirectorAutoHandled(
  state: DirectorAutoRunState,
  key: string,
  episode?: number,
): DirectorAutoRunState {
  return {
    ...state,
    episode: state.episode ?? (episode && episode > 0 ? episode : null),
    handledKeys: [...state.handledKeys.filter((item) => item !== key), key].slice(-MAX_HANDLED_KEYS),
  };
}

export function directorAutoRunTransportText(text: string): string {
  return `${text}\n\n[DRAMACLAW_RUN_MODE]\nmode=episode_auto\n`+
    "The user enabled Episode Auto in the outer Shrimp Director UI. Treat this as approval to select and start " +
    "the next safe mainline step without asking for per-step confirmation. Keep the one-write-per-turn " +
    "limit. Before any write, inspect the current artifact and the latest task for that exact step. " +
    "If the artifact is merely missing and prerequisites are ready, start its generation. Do not let " +
    "an unrelated or superseded historical failed task block a missing safe step. Pause only when the " +
    "latest attempt for the current required step failed or was cancelled. Stop for destructive " +
    "overwrite/delete, missing voice choice, ambiguity, or unmet prerequisites. Never describe one " +
    "task as failed and then silently proceed as though that same attempt succeeded. " +
    "If this user-authored message may change, redo, replace, or reconfigure project output, do not " +
    "perform that mutation yet. First call dramaclaw_control_episode_auto(action='suspend', reason=...) " +
    "and ask the user to confirm the intended change. Questions, explanations, and progress checks do " +
    "not require suspension. If the user explicitly asks to stop automatic production, call " +
    "dramaclaw_control_episode_auto(action='pause'). Never cancel an already queued or running media " +
    "task unless the user separately and explicitly confirms cancellation. This mode never " +
    "applies Agent-credit billing. The durable auto coordinator is already running now: do not merely " +
    "describe what Episode Auto will do in the future. Inspect current state, report the concrete active " +
    "task or start the next safe task, and say clearly that automatic production has started.\n" +
    "[/DRAMACLAW_RUN_MODE]";
}

export function directorAutoUserMessageTransportText(text: string): string {
  return `${text}\n\n[DRAMACLAW_AUTO_USER_MESSAGE]\n`+
    "The durable backend already owns progression of the active outer Shrimp Director episode auto run. First " +
    "understand the user's actual intent; do not start the next mainline task merely because this " +
    "message arrived. For a question, explanation, result view, or progress/status request, answer or " +
    "read only and leave automatic progression running. If the message may change, redo, replace, or " +
    "reconfigure project output, call dramaclaw_control_episode_auto(action='suspend', reason=...) " +
    "before asking for confirmation, and do not perform the mutation in this turn. If the user " +
    "explicitly asks to stop or switch to manual mode, call " +
    "dramaclaw_control_episode_auto(action='pause'). Never cancel a queued or running generation task " +
    "unless the user explicitly confirms cancellation of that exact task.\n" +
    "[/DRAMACLAW_AUTO_USER_MESSAGE]";
}

export function directorAutoInterventionTransportText(text: string): string {
  return `${text}\n\n[DRAMACLAW_AUTO_INTERVENTION_CONFIRMATION]\n`+
    "The outer Shrimp Director episode auto run is suspended while waiting for the user's answer about a possible " +
    "modification. Interpret the answer semantically. If the user declines/cancels the modification or " +
    "asks to keep the original result and continue automatically, call " +
    "dramaclaw_control_episode_auto(action='resume') and acknowledge that automatic production resumed. " +
    "If the user confirms the modification, first call " +
    "dramaclaw_control_episode_auto(action='pause') to leave automatic mode, then handle at most one " +
    "confirmed project mutation under normal one-write-per-turn rules. If the answer is ambiguous, ask " +
    "one concise follow-up " +
    "and keep the run suspended. A queued or running generation task must continue by default and must " +
    "not be cancelled unless the user explicitly confirms cancelling that exact task.\n" +
    "[/DRAMACLAW_AUTO_INTERVENTION_CONFIRMATION]";
}

function taskTimestamp(task: TaskState): number {
  const value = Date.parse(task.updated_at || task.completed_at || task.created_at || "");
  return Number.isFinite(value) ? value : 0;
}

export function decideDirectorAutoTask(
  state: DirectorAutoRunState,
  task: TaskState,
  options: {
    key?: string;
    batchTerminal?: boolean;
    batchFailed?: boolean;
  } = {},
): DirectorAutoTaskDecision {
  if (!isDirectorEpisodeAutoConfirmed(state)) return { action: "ignore" };
  if (!isDirectorAutoPipelineTask(task)) return { action: "ignore" };
  // Episode planning is a project-level task (episode=0). Once it finishes,
  // Episode Auto enters the newly planned pipeline at episode 1.
  const episode = task.episode > 0
    ? task.episode
    : state.episode ?? (task.task_type === "build_episodes" ? 1 : null);
  if (!episode) return { action: "ignore" };
  if (task.episode > 0 && state.episode !== null && state.episode !== task.episode) {
    return { action: "ignore" };
  }
  if (taskTimestamp(task) < state.activatedAt) return { action: "ignore" };

  const key = options.key || `${task.status}:${task.task_key || task.task_id}`;
  if (state.handledKeys.includes(key)) return { action: "ignore" };
  if (options.batchTerminal === false) return { action: "ignore" };
  if (options.batchFailed || task.status === "failed" || task.status === "cancelled") {
    return { action: "pause", episode, key };
  }
  if (task.status !== "completed") return { action: "ignore" };
  if (task.task_type === "compose_episode") {
    return { action: "complete", episode, key };
  }
  return { action: "continue", episode, key };
}

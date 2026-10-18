import i18next from "i18next";
import type { CanvasChatCommandApplyStep } from "@/features/freezone/canvasChatCommands";

const CANVAS_PROTOCOL_DETAIL_PATTERN =
  /\b(?:semanticOutputRole|planning_text|input_text|context_text|prompt_for|context_for|link_type|node_type|node_id|schema|envelopes\[\d+\]|commands\[\d+\])\b/;

function rawText(errors: string[] | undefined, commandResults: Array<Partial<CanvasChatCommandApplyStep>> | undefined): string {
  return [
    ...(errors ?? []),
    ...(commandResults ?? []).map((step) => step.error).filter((item): item is string => typeof item === "string"),
  ].join("\n");
}

function isUnavailableModelError(text: string): boolean {
  return /field model value|not a valid option.*model|model/i.test(text) && /not a valid option|unavailable|invalid/i.test(text);
}

export function canvasCommandUserMessageFromResult(
  errors: string[] | undefined,
  commandResults: Array<Partial<CanvasChatCommandApplyStep>> | undefined,
): string {
  const text = rawText(errors, commandResults);
  if (!text.trim()) return i18next.t("freezone.cmdMsg.incomplete");
  if (/Recipe text generation.*(?:timed out|timeout)|Request timed out/i.test(text)) {
    return i18next.t("freezone.cmdMsg.recipeTimeout");
  }
  if (/cancel/i.test(text)) return i18next.t("freezone.cmdMsg.cancelled");
  // Switching models changes the output and billing, so the user picks it; the agent must not swap and rerun.
  if (isUnavailableModelError(text)) {
    return i18next.t("freezone.cmdMsg.modelUnavailable");
  }
  if (/planning_text|input_text|semanticOutputRole|prompt_for/.test(text)) {
    return i18next.t("freezone.cmdMsg.textNeedsPromptLink");
  }
  if (/link_type .*not valid|not valid for .*->|cannot connect|unsupported.*connect/i.test(text)) {
    return i18next.t("freezone.cmdMsg.cannotConnect");
  }
  if (/(source node not found|target node not found|node not found)/i.test(text)) {
    return i18next.t("freezone.cmdMsg.nodeNotFound");
  }
  if (/fields are not editable|not editable/i.test(text)) {
    return i18next.t("freezone.cmdMsg.notEditable");
  }
  if (CANVAS_PROTOCOL_DETAIL_PATTERN.test(text)) {
    return i18next.t("freezone.cmdMsg.protocolDetail");
  }
  return text.length > 140 ? `${text.slice(0, 140)}...` : text;
}

export function canvasCommandAgentHintFromResult(
  errors: string[] | undefined,
  commandResults: Array<Partial<CanvasChatCommandApplyStep>> | undefined,
): string {
  const userMessage = canvasCommandUserMessageFromResult(errors, commandResults);
  const nextStep = isUnavailableModelError(rawText(errors, commandResults))
    ? "Do not change the node's model or rerun the generation yourself; list the models this canvas supports and ask the user which one to use, then wait for their choice."
    : "The raw errors and command_results remain available for diagnosis; fix the command and retry only when it is safe.";
  return [
    "Do not mention raw canvas protocol details to the user, including semanticOutputRole, planning_text, input_text, prompt_for, context_for, schema names, command paths, or node ids unless the user explicitly asks for implementation details.",
    `Use this user-facing summary if you need to explain the failure: ${userMessage}`,
    nextStep,
  ].join(" ");
}

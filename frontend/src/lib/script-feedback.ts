// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// This uses the default i18next instance (the one `@/i18n` initializes). `@/i18n` itself is not imported,
// because that module also pulls in react-i18next / HttpBackend, and putting it into this widely imported low-level
// chain would make every test that mocks react-i18next blow up at import time.
import i18n from "i18next";

export interface ScriptFeedback {
  type: "success" | "warning";
  key: string;
  values?: Record<string, string | number>;
}

export function getScriptReviewFeedback(result: unknown): ScriptFeedback {
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (record.review_passed === false) {
      const summary =
        typeof record.review_summary === "string" && record.review_summary.trim()
          ? record.review_summary.trim()
          : i18n.t("episode.script.reviewIssuesFallback");
      return {
        type: "warning",
        key: "episode.script.scriptReviewFailed",
        values: { summary },
      };
    }
  }
  return { type: "success", key: "episode.script.scriptReviewPassed" };
}

export function mergeTaskLogs(
  existing: readonly string[],
  incoming: readonly string[] | null | undefined,
  limit = 200,
): string[] {
  if (!incoming?.length) return [...existing];
  const out = [...existing];
  for (const line of incoming) {
    if (!line || out[out.length - 1] === line || out.includes(line)) continue;
    out.push(line);
  }
  return out.slice(-limit);
}

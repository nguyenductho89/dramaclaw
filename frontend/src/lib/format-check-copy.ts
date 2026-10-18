// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { TFunction } from "i18next";

import type { FormatCheck, FormatCheckIssue } from "@/lib/queries/ingest";

/**
 * Localization of the screenplay format pre-check copy.
 *
 * The backend `screenplay_quality.py` emits English strings (summary/message/fix). It also carries
 * `summary_code` / `issue.code` / `params`, so here the locale entries are looked up by
 * code with the backend text as defaultValue - when a new backend code is added before the frontend
 * key exists, the backend text is shown instead of a bare key.
 */

const SLOT_LABEL_KEYS: Record<string, string> = {
  location: "ingest.formatCheck.slot.location",
  time: "ingest.formatCheck.slot.time",
  interior_exterior: "ingest.formatCheck.slot.interiorExterior",
};

const SLOT_PLACEHOLDER_KEYS: Record<string, string> = {
  location: "ingest.formatCheck.placeholder.location",
  time: "ingest.formatCheck.placeholder.time",
  interior_exterior: "ingest.formatCheck.placeholder.interiorExterior",
};

function camel(code: string): string {
  return code.replace(/_([a-z])/g, (_, ch: string) => ch.toUpperCase());
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Re-assemble the "suggested format" example. The one the backend builds contains a location line and placeholders
 * like [day/night]; only the user's original header/location text can be reused as is.
 */
function buildSuggestion(params: Record<string, unknown>, t: TFunction): string {
  const header = asString(params.header);
  const location = asString(params.location);
  const timeOfDay = asString(params.time_of_day);
  const interiorExterior = asString(params.interior_exterior);
  const missingSlots = asStringArray(params.missing_slots);

  if (params.labeled_form === true && location) {
    return t("ingest.formatCheck.suggestionLabeled", {
      header,
      location,
      time: timeOfDay || t(SLOT_PLACEHOLDER_KEYS.time),
      interiorExterior: interiorExterior || t(SLOT_PLACEHOLDER_KEYS.interior_exterior),
    });
  }

  const placeholders = missingSlots
    .map((slot) => SLOT_PLACEHOLDER_KEYS[slot])
    .filter(Boolean)
    .map((key) => t(key));
  return [header, ...placeholders].join(" ");
}

function localizeIssue(issue: FormatCheckIssue, t: TFunction): FormatCheckIssue {
  const params = (issue.params ?? {}) as Record<string, unknown>;

  // Row-level scene header issues: the three codes share one sentence ("scene header X is missing Y"), distinguished by params.header
  // - the same code (scene_headers_missing_time / missing_interior_exterior) also has a generic
  // report-level message without a header at the report level, so the two cannot share a key.
  if (asString(params.header)) {
    const missing = asStringArray(params.missing_slots)
      .map((slot) => SLOT_LABEL_KEYS[slot])
      .filter(Boolean)
      .map((key) => t(key))
      .join(t("ingest.formatCheck.slotSeparator"));
    return {
      ...issue,
      message: t("ingest.formatCheck.issue.sceneHeaderMissingSlots.message", {
        defaultValue: issue.message,
        header: asString(params.header),
        missing,
      }),
      fix: t("ingest.formatCheck.issue.sceneHeaderMissingSlots.fix", {
        defaultValue: issue.fix,
        suggestion: buildSuggestion(params, t),
      }),
    };
  }

  const base = `ingest.formatCheck.issue.${camel(issue.code)}`;
  const interpolation: Record<string, unknown> = {
    ...params,
    title: asString(params.title) || t("ingest.formatCheck.untitledChapter"),
  };
  return {
    ...issue,
    message: t(`${base}.message`, { defaultValue: issue.message, ...interpolation }),
    fix: t(`${base}.fix`, { defaultValue: issue.fix, ...interpolation }),
  };
}

function localizeSummary(formatCheck: FormatCheck, t: TFunction): string {
  if (!formatCheck.summary_code) return formatCheck.summary;
  return t(`ingest.formatCheck.summary.${camel(formatCheck.summary_code)}`, {
    defaultValue: formatCheck.summary,
    ...(formatCheck.summary_params ?? {}),
  });
}

export function localizeFormatCheck(
  formatCheck: FormatCheck | null | undefined,
  t: TFunction,
): FormatCheck | null {
  if (!formatCheck) return null;
  return {
    ...formatCheck,
    summary: localizeSummary(formatCheck, t),
    issues: (formatCheck.issues ?? []).map((issue) => localizeIssue(issue, t)),
  };
}

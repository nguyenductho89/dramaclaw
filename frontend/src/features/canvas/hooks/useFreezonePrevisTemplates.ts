// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from "react";

import {
  listFreezonePrevisTemplates,
  type FreezonePrevisTemplate,
} from "@/api/ops";
import { readUrl } from "@/lib/url-params";

/**
 * Previs prompt templates for the image node, loaded once per project per tab —
 * the same per-project shared-store shape as useFreezoneStyleTemplates /
 * useFreezoneImageModels.
 *
 * Unlike style templates, a previs template supplies the WHOLE prompt, including
 * the measured camera-height and subject-height sentences. Failing to load it is
 * therefore not silently degradable into "no style": the node simply offers no
 * templates, and the user writes a prompt by hand as before.
 */
export interface UseFreezonePrevisTemplatesResult {
  templates: FreezonePrevisTemplate[];
  version: string;
  isLoading: boolean;
  error: Error | null;
  retry: () => void;
}

const NOOP_RETRY = () => {};

const EMPTY: UseFreezonePrevisTemplatesResult = {
  templates: [],
  version: "",
  isLoading: false,
  error: null,
  retry: NOOP_RETRY,
};

const states = new Map<string, UseFreezonePrevisTemplatesResult>();
const listeners = new Map<string, Set<() => void>>();

function emit(project: string) {
  listeners.get(project)?.forEach((fn) => fn());
}

function writeState(project: string, next: UseFreezonePrevisTemplatesResult) {
  states.set(project, next);
  emit(project);
}

function load(project: string, { emitOnStart }: { emitOnStart: boolean }) {
  const retry = () => {
    const current = states.get(project);
    // Only the error state is retryable: ensureLoaded runs during render, so an
    // automatic retry would become failure -> re-render -> failure forever.
    if (!current?.error) return;
    load(project, { emitOnStart: true });
  };
  const pending: UseFreezonePrevisTemplatesResult = {
    templates: [],
    version: "",
    isLoading: true,
    error: null,
    retry: NOOP_RETRY,
  };
  // On first load, set without emitting: ensureLoaded is called during the render
  // phase and notifying subscribers there means updating one component while
  // rendering another. A manual retry is outside render, so it may emit.
  if (emitOnStart) writeState(project, pending);
  else states.set(project, pending);

  void listFreezonePrevisTemplates(project)
    .then((result) => {
      writeState(project, {
        templates: result.templates,
        version: result.version,
        isLoading: false,
        error: null,
        retry: NOOP_RETRY,
      });
    })
    .catch((error: unknown) => {
      writeState(project, {
        ...EMPTY,
        error: error instanceof Error ? error : new Error(String(error)),
        retry,
      });
    });
}

function ensureLoaded(project: string) {
  if (!project || states.has(project)) return;
  load(project, { emitOnStart: false });
}

function subscribe(project: string, onChange: () => void) {
  let set = listeners.get(project);
  if (!set) {
    set = new Set();
    listeners.set(project, set);
  }
  set.add(onChange);
  return () => {
    set?.delete(onChange);
  };
}

export function useFreezonePrevisTemplates(
  projectOverride?: string | null,
): UseFreezonePrevisTemplatesResult {
  const project =
    projectOverride !== undefined ? projectOverride : readUrl().project;

  if (project) ensureLoaded(project);

  return useSyncExternalStore(
    (onChange) => subscribe(project ?? "", onChange),
    () => (project ? states.get(project) ?? EMPTY : EMPTY),
    () => EMPTY,
  );
}

/** For tests and for a hard refresh after the manifest changes on the server. */
export function resetFreezonePrevisTemplateCache() {
  states.clear();
  listeners.clear();
}

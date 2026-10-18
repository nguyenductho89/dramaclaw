// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useSyncExternalStore } from "react";

import {
  listFreezoneStyleTemplates,
  type FreezoneStyleTemplate,
} from "@/api/ops";
import { readUrl } from "@/lib/url-params";

export interface UseFreezoneStyleTemplatesResult {
  templates: FreezoneStyleTemplate[];
  assetBase: string;
  isLoading: boolean;
  error: Error | null;
  /**
   * retry once after a failure. The style directly decides the image result, unlike camera parameters which are optional, so here
   * one more exit is given than the same-family hooks. It takes effect only in the error state, and calls in other states are no-ops - no
   * automatic retry because ensureLoaded is called in render, and automatic retry would become a failure -> re-render ->
   * failure again infinite loop.
   */
  retry: () => void;
}

const NOOP_RETRY = () => {};

const EMPTY: UseFreezoneStyleTemplatesResult = {
  templates: [],
  assetBase: "",
  isLoading: false,
  error: null,
  retry: NOOP_RETRY,
};

// Per-project shared store — mirrors useFreezoneImageModels /
// useFreezoneCameraOptions. One fetch per project per tab lifetime.
const states = new Map<string, UseFreezoneStyleTemplatesResult>();
const listeners = new Map<string, Set<() => void>>();

function emit(project: string) {
  listeners.get(project)?.forEach((fn) => fn());
}

function writeState(project: string, next: UseFreezoneStyleTemplatesResult) {
  states.set(project, next);
  emit(project);
}

// On takeoff deliberately only states.set without emit: ensureLoaded is called during the render phase, and notifying
// subscribers then amounts to changing another component's state while rendering one. Manual retry is not in render, so emitting is fine.
function startFetch(project: string) {
  states.set(project, {
    templates: [],
    assetBase: "",
    isLoading: true,
    error: null,
    retry: NOOP_RETRY,
  });
  listFreezoneStyleTemplates(project)
    .then(({ templates, assetBase }) => {
      writeState(project, {
        templates,
        assetBase,
        isLoading: false,
        error: null,
        retry: NOOP_RETRY,
      });
    })
    .catch((error: unknown) => {
      const normalized =
        error instanceof Error ? error : new Error(String(error));
      console.warn(
        "[freezone] style-templates fetch failed:",
        normalized.message,
      );
      writeState(project, {
        templates: [],
        assetBase: "",
        isLoading: false,
        error: normalized,
        retry: () => retryLoad(project),
      });
    });
}

function retryLoad(project: string) {
  const current = states.get(project);
  if (!current || current.isLoading || !current.error) return;
  startFetch(project);
  emit(project);
}

function ensureLoaded(project: string) {
  if (states.has(project)) return;
  startFetch(project);
}

export function prefetchFreezoneStyleTemplates(project: string): void {
  if (!project) return;
  ensureLoaded(project);
}

function subscribe(project: string | null, callback: () => void) {
  if (!project) return () => {};
  let bucket = listeners.get(project);
  if (!bucket) {
    bucket = new Set();
    listeners.set(project, bucket);
  }
  bucket.add(callback);
  return () => {
    bucket!.delete(callback);
    if (bucket!.size === 0) listeners.delete(project);
  };
}

export function useFreezoneStyleTemplates(
  projectOverride?: string | null,
): UseFreezoneStyleTemplatesResult {
  const project =
    projectOverride !== undefined ? projectOverride : readUrl().project;

  if (project) ensureLoaded(project);

  return useSyncExternalStore(
    (callback) => subscribe(project ?? null, callback),
    () => (project ? states.get(project) ?? EMPTY : EMPTY),
    () => EMPTY,
  );
}

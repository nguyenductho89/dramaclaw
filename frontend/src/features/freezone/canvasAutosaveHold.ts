// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * A "hold" switch for canvas autosave.
 *
 * During a cross-project paste, nodes enter the store carrying the source project's media URLs, and are rewritten to the target
 * project's addresses only after the backend finishes copying. If the 800ms autosave window in between fires as usual, the source project's URLs land in the database first -
 * and once the migration is interrupted (tab closed, project switched, a single failure), that dirty data becomes permanent state.
 *
 * So call `holdCanvasAutosave(project)` before pasting and release when the migration ends (success or failure);
 * during a hold `useCanvasSync` only writes the local draft and sends no PUT, and does one save on release.
 * Every hold carries a safety cap, so a lost release cannot block autosave forever.
 */

const DEFAULT_MAX_HOLD_MS = 90_000;

type ReleaseListener = (project: string) => void;

const holdsByProject = new Map<string, Set<symbol>>();
const listeners = new Set<ReleaseListener>();

function notifyRelease(project: string): void {
  for (const listener of [...listeners]) {
    try {
      listener(project);
    } catch (error) {
      console.warn('[canvas-autosave-hold] release listener failed', error);
    }
  }
}

/**
 * Hold autosave for `project` and return a release. Multiple holds stack, and autosave resumes only after all are released;
 * it auto-releases after `maxMs`.
 */
export function holdCanvasAutosave(
  project: string,
  options?: { maxMs?: number },
): () => void {
  const token = Symbol('canvas-autosave-hold');
  let holders = holdsByProject.get(project);
  if (!holders) {
    holders = new Set();
    holdsByProject.set(project, holders);
  }
  holders.add(token);

  let released = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const release = () => {
    if (released) {
      return;
    }
    released = true;
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    const current = holdsByProject.get(project);
    if (!current) {
      return;
    }
    current.delete(token);
    if (current.size > 0) {
      return;
    }
    holdsByProject.delete(project);
    notifyRelease(project);
  };

  const maxMs = options?.maxMs ?? DEFAULT_MAX_HOLD_MS;
  if (Number.isFinite(maxMs) && maxMs > 0) {
    timer = setTimeout(() => {
      timer = null;
      console.warn('[canvas-autosave-hold] hold expired, resuming autosave', { project, maxMs });
      release();
    }, maxMs);
  }
  return release;
}

export function isCanvasAutosaveHeld(project: string): boolean {
  const holders = holdsByProject.get(project);
  return Boolean(holders && holders.size > 0);
}

/** Called back once after all of a project's holds are released. Returns an unsubscribe. */
export function subscribeCanvasAutosaveRelease(listener: ReleaseListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

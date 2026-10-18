// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { QueryClient } from "@tanstack/react-query";
import { useAspectRatioStore } from "@/stores/aspect-ratio-store";
import { useAuthStore } from "@/stores/auth-store";
import { useEpisodeWorkbenchStore } from "@/stores/episode-workbench-store";
import { useSaveStatusStore } from "@/stores/save-status-store";
import { useSeenPoolStore } from "@/stores/seen-pool-store";
import { useTaskCenterStore } from "@/task-center/store";
import { useRewardEventsStore } from "@/features/rewards/reward-events-store";

// UX chrome keys that must survive a region switch.
const PRESERVE_KEYS = new Set<string>([
  "supertale-app",
  "i18nextLng",
]);

// Extra keys kept on logout (account switch): the region selection is a device/deployment-level preference, not user state, and switching accounts
// should not force the user to re-pick a region. The region-switch flow still has to clear it (a new value is written right after).
const LOGOUT_PRESERVE_KEYS = new Set<string>([
  ...PRESERVE_KEYS,
  "supertale-region",
]);

// Prefix sweep is self-maintaining: any future region-scoped key matching
// these prefixes is covered without updating this list.
const SWEEP_PREFIXES = [
  "supertale-",
  "st.episode.",
  "st.beats.toggles",
  "st.beats.action-panel.sections",
];

function resetSessionScopedState(
  deps: { queryClient: QueryClient },
  preserveKeys: ReadonlySet<string>,
): void {
  useAuthStore.getState().reset();
  useSaveStatusStore.getState().reset();
  useSeenPoolStore.getState().reset();
  useEpisodeWorkbenchStore.getState().reset();
  useTaskCenterStore.getState().reset();
  useAspectRatioStore.getState().reset();
  useRewardEventsStore.getState().reset();

  deps.queryClient.clear();

  const toRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (!key) continue;
    if (preserveKeys.has(key)) continue;
    if (SWEEP_PREFIXES.some((p) => key.startsWith(p))) {
      toRemove.push(key);
    }
  }
  toRemove.forEach((k) => localStorage.removeItem(k));
}

export function resetRegionState(deps: { queryClient: QueryClient }): void {
  resetSessionScopedState(deps, PRESERVE_KEYS);
}

/**
 * User-state cleanup on logout / account switch: same set as the region switch (per-user zustand stores,
 * the React Query cache, localStorage prefix sweep), but the region selection is kept.
 *
 * Why queryClient must be cleared: manual logout is an in-SPA navigation (no page refresh), and the QueryClient
 * stays resident in memory; queries such as projectSummaries have keys without the username and have a staleTime, so after logging in as another account
 * the cache is still fresh and React Query does not even send a request - B would keep seeing A's project list
 * until a manual refresh.
 */
export function resetUserSessionState(deps: { queryClient: QueryClient }): void {
  resetSessionScopedState(deps, LOGOUT_PRESERVE_KEYS);
}

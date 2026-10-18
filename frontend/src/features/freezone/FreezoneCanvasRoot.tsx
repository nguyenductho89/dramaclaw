// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRouterState } from "@tanstack/react-router";
import { ReactFlowProvider } from "@xyflow/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { SupertaleProjectSummary } from "@/api/projects";
import { GlobalErrorDialog } from "@/components/GlobalErrorDialog";
import {
  subscribeOpenGlobalErrorDialog,
  type GlobalErrorDialogDetail,
} from "@/features/app/errorDialogEvents";
import { FreezoneShell } from "@/features/freezone/FreezoneShell";
import { canvasIdForFreezoneEntry } from "@/features/freezone/projections";
import { useAllProjectSummaries } from "@/lib/queries/projects";
import { readLastCanvas, writeUrl } from "@/lib/url-params";
import { useAuthStore } from "@/stores/auth-store";

type FreezoneCanvasRootProps = {
  /** The `/projects/$project` route param. Guaranteed to be a project id via canonicalProjectRouteParam. */
  project: string;
  /** Whether the canvas is the page currently in view; false means it is kept alive in the background by FreezoneCanvasHost. */
  active: boolean;
};

/**
 * The actual content of the Canvas route. Moved out of routes/_app/projects.$project/freezone.lazy.tsx
 * because its host is no longer that route but FreezoneCanvasHost - only by mounting outside the route
 * can it avoid being unmounted when switching to Market.
 */
export default function FreezoneCanvasRoot({
  project,
  active,
}: FreezoneCanvasRootProps) {
  const { t } = useTranslation();
  const username = useAuthStore((state) => state.username);
  const { data: projects, isLoading: projectsLoading } = useAllProjectSummaries();
  const [globalError, setGlobalError] = useState<GlobalErrorDialogDetail | null>(null);

  // Read `?canvas` from the router's location so it stays consistent with an
  // in-flight navigation (tanstack throttles history onto a microtask, so
  // window.location — and any raw readUrl() — lags a queued canvas switch).
  // This subscription also re-renders the route when the canvas param changes,
  // replacing the old raw popstate listener.
  const canvasParam = useRouterState({
    select: (s) => {
      const canvas = (s.location.search as { canvas?: unknown }).canvas;
      return typeof canvas === "string" && canvas.length > 0 ? canvas : null;
    },
  });

  useEffect(() => subscribeOpenGlobalErrorDialog(setGlobalError), []);

  const freezoneProjects = useMemo<SupertaleProjectSummary[]>(
    () =>
      (projects ?? []).map((item) => ({
        id: item.id,
        name: item.name,
        display_name: item.name,
        updated_at: item.updatedAt,
        episode_count: item.episodeCount,
      })),
    [projects],
  );
  const matchedProject = useMemo(
    () =>
      freezoneProjects.find((item) => item.id === project) ??
      freezoneProjects.find((item) => item.name === project) ??
      null,
    [freezoneProjects, project],
  );

  // During keep-alive the address bar belongs to Market and `?canvas=` is gone. Computing as usual would drop canvasId back to the
  // default, and FreezoneShell would treat it as "the canvas switched" and hydrate again - exactly the cost keep-alive is meant to
  // save, and it would also replace the canvas the user currently has open. So only update while active, and pin
  // the previous value the rest of the time.
  const liveCanvasId = matchedProject
    ? canvasIdForFreezoneEntry({
        explicitCanvasId: canvasParam ?? readLastCanvas(matchedProject.id),
        username,
      })
    : null;
  const pinnedCanvasIdRef = useRef(liveCanvasId);
  if (active && liveCanvasId) {
    pinnedCanvasIdRef.current = liveCanvasId;
  }
  const canvasId = active ? liveCanvasId : pinnedCanvasIdRef.current;

  // Show the spinner while the project list has not arrived. Without this branch, a failed request (projects is undefined but
  // no longer pending) would fall straight into "project not found" below, describing a network error as the
  // project not existing.
  if (projectsLoading || !projects) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-dark text-text-muted">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
      </div>
    );
  }

  if (!matchedProject || !canvasId) {
    return (
      <div className="flex h-full w-full items-center justify-center bg-bg-dark">
        <div className="max-w-md rounded-2xl border border-border-default bg-surface px-6 py-8 text-center">
          <div className="mb-2 text-base font-medium text-text">{t("project.notFound")}</div>
          <div className="mb-6 text-sm text-text-muted">
            {t("project.notFoundDescriptionPrefix")} <code className="rounded bg-bg-dark px-1 py-0.5">{project}</code>{t("project.notFoundDescriptionSuffix")}
          </div>
          <button
            type="button"
            onClick={() => writeUrl({ project: null, canvas: null })}
            className="rounded-lg bg-accent/90 px-4 py-2 text-sm text-white transition hover:bg-accent"
          >
            {t("project.backToProjects")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <ReactFlowProvider>
      <div className="h-full w-full bg-bg-dark">
        <FreezoneShell project={matchedProject} canvasId={canvasId} active={active} />
        <GlobalErrorDialog
          isOpen={Boolean(globalError)}
          title={globalError?.title ?? ""}
          message={globalError?.message ?? ""}
          details={globalError?.details}
          copyText={globalError?.copyText}
          onClose={() => setGlobalError(null)}
        />
      </div>
    </ReactFlowProvider>
  );
}

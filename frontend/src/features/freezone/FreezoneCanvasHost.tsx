// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useRouterState } from "@tanstack/react-router";
import { Suspense, lazy, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const FreezoneCanvasRoot = lazy(() => import("./FreezoneCanvasRoot"));

/** `/projects/<project>/<section>` - the section may be absent (project root path). */
function parseProjectLocation(pathname: string): {
  project: string | null;
  section: string | null;
} {
  const match = pathname.match(/^\/projects\/([^/]+)(?:\/([^/]+))?/);
  if (!match) return { project: null, section: null };
  return { project: decodeURIComponent(match[1]), section: match[2] ?? null };
}

/**
 * Keeps the canvas alive within the same project.
 *
 * The top-bar "Canvas / Market" switch used to be a plain route navigation, and projects.$project has no
 * layout route, so the two are flat siblings; _app.tsx also computes the animation container's key from
 * `/projects/$project/$section`. As a result, on every switch the whole FreezoneShell + Canvas + ReactFlow subtree,
 * with its thousand-plus node components, was destroyed and rebuilt, with unmount and mount in the same commit - this is
 * the "pause after clicking before the page changes", in both directions.
 *
 * Here the canvas is lifted outside the re-keyed animation container and mounted once per project; switching to Market only hides it
 * and marks it inactive. Using visibility rather than display:none is deliberate: display:none zeroes the
 * container size, which makes ReactFlow's ResizeObserver reset the viewport, and on switching back the canvas zoom and
 * position would be lost. visibility:hidden keeps the layout size, so it comes back as it was.
 *
 * The price of keep-alive is that the canvas stays alive in the background, so the "things only the foreground should do" must be handed off explicitly - this is handled by
 * FreezoneShell's active switch (global shortcuts, the two polls).
 */
export function FreezoneCanvasHost() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { project, section } = parseProjectLocation(pathname);
  const isFreezone = section === "freezone";

  // Mount only after the canvas has actually been entered: a user who never opened the canvas while in Market should not pay
  // the mount cost, nor issue those canvas requests.
  // A lazy initial value rather than null first and then an effect: when entering by typing /freezone in the address bar,
  // the former mounts the canvas on the first frame and the latter waits a frame for nothing.
  const [mountedProject, setMountedProject] = useState<string | null>(() =>
    isFreezone && project ? project : null,
  );
  useEffect(() => {
    if (isFreezone && project) {
      setMountedProject(project);
      return;
    }
    // Drop the canvas when leaving the project or switching to another project - keep-alive only holds within a single project;
    // keeping it across projects takes memory and also draws the previous project's content.
    if (!project || project !== mountedProject) {
      setMountedProject(null);
    }
  }, [isFreezone, project, mountedProject]);

  // The canvas is no longer unmounted, so playing video/audio would not stop with it - after switching to Market it would become invisible
  // background sound. Pause once when hiding (pause only, no resume: whether to continue after switching back is up to the user;
  // auto-resume would surprise more than silence).
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (isFreezone) return;
    const container = containerRef.current;
    if (!container) return;
    container
      .querySelectorAll<HTMLMediaElement>("video, audio")
      .forEach((media) => {
        if (!media.paused) media.pause();
      });
  }, [isFreezone]);

  if (!mountedProject) return null;

  return (
    <div
      ref={containerRef}
      className={cn(
        "absolute inset-0 z-0",
        // opacity-0 is a backstop for invisible, not a duplicate: visibility is overridden by a descendant's own
        // `visibility: visible` (this repo has such usages - AssetBoardView's show/hide
        // switch, SplitText's el.style.visibility = "visible" when its animation ends), and opacity
        // cannot be overridden. Neither uses display:none, to keep the container size, otherwise ReactFlow's
        // ResizeObserver resets the viewport and the zoom and position are lost on switching back.
        !isFreezone && "invisible opacity-0 pointer-events-none",
      )}
      aria-hidden={!isFreezone}
      inert={!isFreezone}
    >
      <Suspense fallback={<FreezoneChunkLoading />}>
        {/* The key must include the project: switching project directly within Canvas (ProjectSwitcher stays on Canvas)
            used to rebuild the whole tree via the $project re-key in _app.tsx, and after lifting the canvas out
            nobody does that. Without rebuilding, FreezoneShell's many per-project states would leak across projects
            - most glaringly hasRenderedCanvas is only set, never cleared, so during the new project's hydrate the screen
            still shows the previous project's nodes. */}
        <FreezoneCanvasRoot
          key={mountedProject}
          project={mountedProject}
          active={isFreezone}
        />
      </Suspense>
    </div>
  );
}

/** Placeholder for first entering Canvas while the canvas chunk is still downloading; reuses the original route's loading state. */
function FreezoneChunkLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center bg-bg-dark text-text-muted">
      <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent border-t-transparent" />
    </div>
  );
}

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { quotaSafeStateStorage } from "@/lib/localStorageQuota";

import type { ProjectSection } from "@/components/layout/project-navigation-routes";

/**
 * Remember each project's navigation position:
 * - lastSectionByProject: the last section stayed in within the project (Xiahua freezone or each Xiaji sub-page),
 *   restored there on entering the project, rather than always landing on Xiahua.
 * - lastXiajiSectionByProject: the last Xiaji sub-page stayed in (material/pond/mirror/guide/grid),
 *   restored there when the top switches to "Xiaji", rather than always landing on material.
 */

/** Sections that can be remembered: Xiahua + Xiaji's five sub-pages (other routes such as tasks do not take part in memory). */
const REMEMBERED_SECTIONS = new Set<ProjectSection>([
  "freezone",
  "ingest",
  "characters",
  "episodes",
  "assistant",
  "styles",
]);

export type XiajiSection = Exclude<
  ProjectSection,
  "freezone" | "tasks"
>;

export function isRememberedSection(
  section: ProjectSection | null,
): section is ProjectSection {
  return section !== null && REMEMBERED_SECTIONS.has(section);
}

interface ProjectNavState {
  lastSectionByProject: Record<string, ProjectSection>;
  lastXiajiSectionByProject: Record<string, XiajiSection>;
  rememberSection: (project: string, section: ProjectSection) => void;
  reset: () => void;
}

export const useProjectNavStore = create<ProjectNavState>()(
  persist(
    (set) => ({
      lastSectionByProject: {},
      lastXiajiSectionByProject: {},
      rememberSection: (project, section) =>
        set((state) => {
          if (!project || !REMEMBERED_SECTIONS.has(section)) return state;
          const next: Partial<ProjectNavState> = {
            lastSectionByProject: {
              ...state.lastSectionByProject,
              [project]: section,
            },
          };
          if (section !== "freezone") {
            next.lastXiajiSectionByProject = {
              ...state.lastXiajiSectionByProject,
              [project]: section as XiajiSection,
            };
          }
          return next as ProjectNavState;
        }),
      reset: () =>
        set({ lastSectionByProject: {}, lastXiajiSectionByProject: {} }),
    }),
    {
      name: "supertale-project-nav",
      version: 1,
      storage: createJSONStorage(() => quotaSafeStateStorage),
    },
  ),
);

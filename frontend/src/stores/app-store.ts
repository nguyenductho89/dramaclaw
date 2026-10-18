// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * app-store: cross-region UX chrome.
 *
 * This store is NOT purged on region switch. Keep it strictly region-agnostic:
 * theme, language, dashboard filters, etc. Do NOT add region IDs,
 * project IDs, episode IDs, or any region-specific content here — it will bleed
 * across region switches and cause data confusion. For region-scoped state, add
 * a new store and include it in `src/lib/reset-region-state.ts`.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { quotaSafeStateStorage } from "@/lib/localStorageQuota";
import type { PikoAccessoryDisplayId } from "@/features/companion/piko-accessories";
import type { ProjectStatus } from "@/types/project";

export const TASK_PANEL_HEIGHT_MIN = 200;
export const TASK_PANEL_HEIGHT_DEFAULT = 400;
export const TASK_PANEL_HEIGHT_MAX_VH = 0.7;
export const AI_ASSISTANT_WIDTH_MIN = 440;
export const AI_ASSISTANT_WIDTH_DEFAULT = 640;
export const AI_ASSISTANT_WIDTH_MAX = 760;

export type Theme = "light" | "dark" | "system";
export type DashboardView = "card" | "list";

interface AppState {
  language: string;
  theme: Theme;
  dashboardTab: ProjectStatus;
  dashboardView: DashboardView;
  taskPanelOpen: boolean;
  taskPanelHeight: number;
  aiAssistantOpen: boolean;
  aiAssistantWidth: number;
  /**
   * Top companion avatar: 'piko' (default, a CSS pixel character) or the slug of a petdex pet.
   * A global UI preference (region-agnostic); persisted with supertale-app and not cleared on region switch.
   */
  companionKind: string;
  /**
   * The selected petdex pet (from the full manifest, including the same-origin proxied spritesheet URL). Used for rendering when companionKind is not
   * 'piko': manifest pets are not in the built-in curated table, so the URL must be persisted too.
   */
  companionPet: {
    slug: string;
    displayName: string;
    spritesheetUrl: string;
    submittedBy?: string;
    cols?: number;
    rows?: number;
    /** Imported pet (IndexedDB). spritesheetUrl is a session-level blob and is re-resolved by slug after refresh. */
    imported?: boolean;
  } | null;
  /** Piko-only accessory selection; petdex pets carry no accessories. */
  pikoAccessory: PikoAccessoryDisplayId;
  /**
   * Position of the companion in the viewport (percent of viewport width/height, 0-100); draggable anywhere on the page.
   * null = never dragged, use the default spot. Written and persisted after dragging. A global UI preference.
   */
  companionXPercent: number | null;
  companionYPercent: number | null;
  /** Whether the companion (workbuddy) is hidden. true = hidden globally. A global UI preference, persisted. */
  companionHidden: boolean;
  toggleAiAssistant: () => void;
  setLanguage: (lang: string) => void;
  setTheme: (theme: Theme) => void;
  setDashboardTab: (tab: ProjectStatus) => void;
  setDashboardView: (view: DashboardView) => void;
  setTaskPanelOpen: (open: boolean) => void;
  setTaskPanelHeight: (h: number) => void;
  setAiAssistantOpen: (open: boolean) => void;
  setAiAssistantWidth: (w: number) => void;
  /** For Piko pass 'piko'+null; for a pet pass the slug + pet info. */
  setCompanion: (kind: string, pet: AppState["companionPet"]) => void;
  setPikoAccessory: (accessory: PikoAccessoryDisplayId) => void;
  setCompanionPosition: (xPercent: number, yPercent: number) => void;
  setCompanionHidden: (hidden: boolean) => void;
  /**
   * Re-clamp viewport-relative panel dimensions against the current window size.
   * Call this on window `resize` so a panel sized on a large screen (or restored
   * from persisted state) doesn't exceed the viewport after the window shrinks.
   */
  clampDimensionsToViewport: () => void;
}

function clampAiAssistantWidth(width: number): number {
  const viewportMax =
    typeof window !== "undefined"
      ? Math.max(AI_ASSISTANT_WIDTH_MIN, window.innerWidth - 320)
      : AI_ASSISTANT_WIDTH_MAX;
  const max = Math.min(AI_ASSISTANT_WIDTH_MAX, viewportMax);
  return Math.min(max, Math.max(AI_ASSISTANT_WIDTH_MIN, Math.round(width)));
}

function clampTaskPanelHeight(height: number): number {
  const viewport = typeof window !== "undefined" ? window.innerHeight : 1000;
  const max = Math.floor(viewport * TASK_PANEL_HEIGHT_MAX_VH);
  return Math.min(max, Math.max(TASK_PANEL_HEIGHT_MIN, Math.round(height)));
}

function persistedCompanionPet(pet: AppState["companionPet"]): AppState["companionPet"] {
  if (!pet) return null;
  const spritesheetUrl =
    pet.spritesheetUrl &&
    !pet.spritesheetUrl.startsWith("data:") &&
    !pet.spritesheetUrl.startsWith("blob:") &&
    pet.spritesheetUrl.length <= 2048
      ? pet.spritesheetUrl
      : "";
  return {
    slug: pet.slug,
    displayName: pet.displayName,
    spritesheetUrl,
    submittedBy: pet.submittedBy,
    cols: pet.cols,
    rows: pet.rows,
    imported: pet.imported,
  };
}

export const useAppStore = create<AppState>()(
  persist(
    (set) => ({
      language: "en",
      theme: "dark",
      dashboardTab: "active",
      dashboardView: "card",
      aiAssistantOpen: false,
      aiAssistantWidth: AI_ASSISTANT_WIDTH_DEFAULT,
      companionKind: "piko",
      companionPet: null,
      pikoAccessory: "none",
      companionXPercent: null,
      companionYPercent: null,
      companionHidden: false,
      toggleAiAssistant: () =>
        set((s) => ({ aiAssistantOpen: !s.aiAssistantOpen })),
      setLanguage: (lang) => set({ language: lang }),
      setTheme: (theme) => set({ theme }),
      setDashboardTab: (tab) => set({ dashboardTab: tab }),
      setDashboardView: (view) => set({ dashboardView: view }),
      taskPanelOpen: false,
      taskPanelHeight: TASK_PANEL_HEIGHT_DEFAULT,
      setTaskPanelOpen: (open) => set({ taskPanelOpen: open }),
      setAiAssistantOpen: (open) => set({ aiAssistantOpen: open }),
      setAiAssistantWidth: (w) => set({ aiAssistantWidth: clampAiAssistantWidth(w) }),
      setTaskPanelHeight: (h) => set({ taskPanelHeight: clampTaskPanelHeight(h) }),
      setCompanion: (kind, pet) => set({ companionKind: kind, companionPet: pet }),
      setPikoAccessory: (accessory) => set({ pikoAccessory: accessory }),
      setCompanionPosition: (xPercent, yPercent) =>
        set({ companionXPercent: xPercent, companionYPercent: yPercent }),
      setCompanionHidden: (hidden) => set({ companionHidden: hidden }),
      clampDimensionsToViewport: () =>
        set((s) => {
          const aiAssistantWidth = clampAiAssistantWidth(s.aiAssistantWidth);
          const taskPanelHeight = clampTaskPanelHeight(s.taskPanelHeight);
          if (
            aiAssistantWidth === s.aiAssistantWidth &&
            taskPanelHeight === s.taskPanelHeight
          ) {
            return s;
          }
          return { aiAssistantWidth, taskPanelHeight };
        }),
    }),
    {
      name: "supertale-app",
      storage: createJSONStorage(() => quotaSafeStateStorage),
      version: 7,
      migrate: (persisted: unknown, fromVersion: number) => {
        const base = (persisted ?? {}) as Record<string, unknown>;
        delete base.sidebarCollapsed;
        delete base.sidebarWidth;
        if (fromVersion < 6) {
          base.companionXPercent = null;
          base.companionYPercent = null;
        }
        if (fromVersion < 4 && base.companionKind == null) {
          base.companionKind = "piko";
        }
        if (fromVersion < 5 && base.pikoAccessory == null) {
          base.pikoAccessory = "none";
        }
        if (fromVersion < 1) {
          return {
            ...base,
            taskPanelOpen: base.taskPanelOpen ?? false,
            taskPanelHeight: base.taskPanelHeight ?? TASK_PANEL_HEIGHT_DEFAULT,
            aiAssistantOpen: base.aiAssistantOpen ?? false,
            aiAssistantWidth: base.aiAssistantWidth ?? AI_ASSISTANT_WIDTH_DEFAULT,
          };
        }
        if (fromVersion < 2) {
          return {
            ...base,
            aiAssistantOpen: base.aiAssistantOpen ?? false,
            aiAssistantWidth: base.aiAssistantWidth ?? AI_ASSISTANT_WIDTH_DEFAULT,
          };
        }
        if (fromVersion < 3) {
          return {
            ...base,
            aiAssistantWidth: base.aiAssistantWidth ?? AI_ASSISTANT_WIDTH_DEFAULT,
          };
        }
        if (base.taskPanelHeight === 320) {
          return {
            ...base,
            taskPanelHeight: TASK_PANEL_HEIGHT_DEFAULT,
          };
        }
        return base;
      },
      partialize: (state) => {
        const { companionXPercent: _x, companionYPercent: _y, ...persisted } = state;
        return {
          ...persisted,
          companionPet: persistedCompanionPet(state.companionPet),
        };
      },
    },
  ),
);

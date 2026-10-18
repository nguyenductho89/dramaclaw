// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { MyBuddyAction } from "@/features/companion/mybuddy-actions";

/**
 * petdex pet integration (prototype).
 *
 * petdex (https://petdex.dev) pets are "sprite sheets": each one is a spritesheet cut into frames by
 * a grid, row = animation state, a different render path from Piko's "CSS pixel figure". Here petdex
 * pets are brought in as a "switchable avatar", coexisting with Piko and driven by the same controller state.
 *
 * Purely local approach: pet sprite sheets (webp) are downloaded into public/petdex/, with the directory maintained by the same-origin manifest
 * public/petdex/pets.json (read by {@link fetchLocalPets}) - adding a pet = drop in one
 * <slug>.webp + add an entry in pets.json; users can also store them into IndexedDB via the import dialog. It touches no
 * CDN / manifest (online rate limiting + wasted resources).
 *
 * WARNING licensing: the petdex source is MIT, but pet assets belong to each submitter who picks their own license, and pet.json
 * carries no license field. During the prototype stage these third-party sprite sheets are checked into the repo for demos; before a commercial launch
 * each one must be confirmed for licensing, and unconfirmed ones must be removed from the repo.
 */

// Sprite sheet grid convention (8 columns x 9 rows, each frame 192x208). 8 columns is the "cell upper bound"; the actual frame count of each state
// differs (see PETDEX_STATES), looping over its own frame count and skipping the extra empty cells in that row.
export const PETDEX_GRID_COLS = 8;
export const PETDEX_GRID_ROWS = 9;
export const PETDEX_FRAME_MS = 150; // frame duration, keeps the playback speed consistent across states

export interface PetdexState {
  /** Row index in the sprite sheet (0-based). */
  row: number;
  /** Actual frame count of this state (valid frames in this row starting from column 0). */
  frames: number;
}

// petdex standard 9-state layout (source: petdex pet detail page, consistent across several measured sprite sheets). Frame counts differ per row.
export const PETDEX_STATES = {
  idle: { row: 0, frames: 6 },
  runRight: { row: 1, frames: 8 },
  runLeft: { row: 2, frames: 8 },
  waving: { row: 3, frames: 4 },
  jumping: { row: 4, frames: 5 },
  failed: { row: 5, frames: 8 },
  waiting: { row: 6, frames: 6 },
  running: { row: 7, frames: 6 },
  review: { row: 8, frames: 6 },
} as const satisfies Record<string, PetdexState>;

export type PetdexStateName = keyof typeof PETDEX_STATES;

/** Ordered list of the 9 states (name + display label) - used by the "state simulation" dropdown & click-pet cycle preview. */
export const PETDEX_STATE_OPTIONS: { name: PetdexStateName; label: string }[] = [
  { name: "idle", label: "Idle" },
  { name: "runRight", label: "Run Right" },
  { name: "runLeft", label: "Run Left" },
  { name: "waving", label: "Waving" },
  { name: "jumping", label: "Jumping" },
  { name: "failed", label: "Failed" },
  { name: "waiting", label: "Waiting" },
  { name: "running", label: "Running" },
  { name: "review", label: "Review" },
];

/**
 * Map the controller's actions (already mapped from task-center state: running->typing, success->flag,
 * error->repair, greeting->peek ...) onward to petdex's 9 standard states, syncing "task state <-> pet
 * action". Idle/festival actions with no matching semantics all go to idle.
 */
export function petdexStateForAction(action: MyBuddyAction): PetdexState {
  switch (action) {
    case "typing":
      return PETDEX_STATES.running; // task in progress -> Running
    case "flag":
      return PETDEX_STATES.waving; // task succeeded -> Waving
    case "repair":
      return PETDEX_STATES.failed; // task failed -> Failed
    default:
      return PETDEX_STATES.idle; // normal state (standby/idle/festival/greeting) -> Idle
  }
}

export const PIKO_COMPANION_KIND = "piko";

// --- Local pet catalog ---------------------------------------------------
/** A selectable pet avatar (built-in catalog entries / user-imported entries share this shape). */
export interface PetdexCatalogEntry {
  slug: string;
  displayName: string;
  /** Same-origin sprite sheet address, usually /petdex/<slug>.webp. */
  spritesheetUrl: string;
  submittedBy?: string;
  /** Override in pets.json when the grid is not the default 8x9 (row order / frame counts follow the petdex standard layout). */
  cols?: number;
  rows?: number;
  /** Comes from a user import (IndexedDB). spritesheetUrl is a session-level blob URL and must be re-resolved by slug after a refresh. */
  imported?: boolean;
}

const LOCAL_PETS_URL = "/petdex/pets.json";

/**
 * Read the local pet catalog (same-origin, stable, no network). pets.json is the **only** source of built-in pets;
 * if the manifest is missing/corrupt (e.g. production without this prototype asset deployed) return empty, and the gallery keeps only "My pets" (IndexedDB).
 */
export async function fetchLocalPets(signal?: AbortSignal): Promise<PetdexCatalogEntry[]> {
  try {
    const response = await fetch(LOCAL_PETS_URL, { signal });
    if (response.ok) {
      const data = (await response.json()) as { pets?: Array<Record<string, unknown>> };
      return (data.pets ?? [])
        .filter(
          (p): p is Record<string, unknown> =>
            typeof p?.slug === "string" && typeof p?.spritesheetUrl === "string",
        )
        .map((p) => ({
          slug: p.slug as string,
          displayName: (p.displayName as string) || (p.slug as string),
          spritesheetUrl: p.spritesheetUrl as string,
          submittedBy: typeof p.submittedBy === "string" ? p.submittedBy : undefined,
          cols: typeof p.cols === "number" ? p.cols : undefined,
          rows: typeof p.rows === "number" ? p.rows : undefined,
        }));
    }
  } catch {
    // manifest missing / parse failed -> empty catalog (keep only user imports)
  }
  return [];
}

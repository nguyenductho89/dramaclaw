// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import type { MyBuddyAction } from "@/features/companion/mybuddy-actions";
import {
  PETDEX_FRAME_MS,
  PETDEX_GRID_COLS,
  PETDEX_GRID_ROWS,
  PETDEX_STATES,
  petdexStateForAction,
  type PetdexCatalogEntry,
  type PetdexState,
} from "@/features/companion/petdex/petdex-pets";
import "./petdex-pet.css";

const FIGURE_HEIGHT_PX = 72; // slightly larger than Piko, hung at the bottom edge of the top bar (the lane does not clip overflow)
const FRAME_ASPECT = 192 / 208; // aspect ratio of a single frame, guarantees no stretching

type SpritePetCompanionProps = {
  pet: PetdexCatalogEntry;
  action: MyBuddyAction;
  /** Manually override the current state (from the "state simulation" dropdown / click-pet cycle); when not passed, map by action. */
  stateOverride?: PetdexState | null;
  className?: string;
  style?: CSSProperties;
};

/**
 * Render a petdex pet with a sprite sheet: a viewport the size of one frame, with the background image scaled by the grid, the vertical position choosing the "state
 * row" and the horizontal position stepping through that row frame by frame. The state is mapped from the same controller's action.
 */
export function SpritePetCompanion({
  pet,
  action,
  stateOverride,
  className,
  style,
}: SpritePetCompanionProps) {
  const reducedMotion = useReducedMotion();
  const spriteRef = useRef<HTMLDivElement | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);

  const cols = pet.cols ?? PETDEX_GRID_COLS;
  const rows = pet.rows ?? PETDEX_GRID_ROWS;
  // Actions are strongly tied to tasks: while a task is in progress/succeeded/failed (taskState not idle) the task takes priority and ignores the manual override;
  // only in the normal (idle) state is the manual override of "state simulation / click pet" used for preview.
  const taskState = petdexStateForAction(action);
  const { row, frames } =
    taskState !== PETDEX_STATES.idle ? taskState : (stateOverride ?? PETDEX_STATES.idle);
  const playFrames = Math.min(frames, cols);

  // Frame stepping: change the ref's backgroundPositionX directly, avoiding a React re-render per frame. The background is scaled by
  // cols, with (cols-1) as the positioning denominator; loop only within the first playFrames frames of the state (skipping empty cells).
  // Reset to the first frame when the state changes; freeze on the first frame under reduced-motion.
  useEffect(() => {
    const el = spriteRef.current;
    if (!el) return;
    let frame = 0;
    const apply = () => {
      el.style.backgroundPositionX = cols > 1 ? `${(frame / (cols - 1)) * 100}%` : "0%";
    };
    apply();
    if (reducedMotion || playFrames <= 1) return;
    const timer = window.setInterval(() => {
      frame = (frame + 1) % playFrames;
      apply();
    }, PETDEX_FRAME_MS);
    return () => window.clearInterval(timer);
  }, [cols, playFrames, row, reducedMotion, pet.spritesheetUrl]);

  // Pre-check whether the sprite sheet can load (when blocked by CDN / offline do not render, avoiding a broken-image placeholder).
  useEffect(() => {
    setLoadFailed(false);
    const img = new Image();
    img.onerror = () => setLoadFailed(true);
    img.src = pet.spritesheetUrl;
  }, [pet.spritesheetUrl]);

  const spriteStyle = useMemo<CSSProperties>(
    () => ({
      backgroundImage: `url("${pet.spritesheetUrl}")`,
      backgroundSize: `${cols * 100}% ${rows * 100}%`,
      backgroundPositionY: rows > 1 ? `${(row / (rows - 1)) * 100}%` : "0%",
      height: FIGURE_HEIGHT_PX,
      width: Math.round(FIGURE_HEIGHT_PX * FRAME_ASPECT),
    }),
    [pet.spritesheetUrl, cols, rows, row],
  );

  if (loadFailed) return null;

  return (
    <div
      className={["petdex-pet-companion", className].filter(Boolean).join(" ")}
      style={style}
      title={pet.displayName}
      aria-hidden
    >
      <div ref={spriteRef} className="petdex-pet-sprite" style={spriteStyle} />
    </div>
  );
}

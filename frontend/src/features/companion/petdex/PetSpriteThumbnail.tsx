// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CSSProperties } from "react";
import {
  PETDEX_GRID_COLS,
  PETDEX_GRID_ROWS,
} from "@/features/companion/petdex/petdex-pets";

type PetSpriteThumbnailProps = {
  url: string;
  /** Grid columns/rows (default petdex standard 8x9). */
  cols?: number;
  rows?: number;
  className?: string;
};

/**
 * Static sprite sheet thumbnail: takes the top-left idle first frame, no animation. Shared by gallery rows / import preview, avoiding three places
 * each writing their own background grid positioning (see SpritePetCompanion for the animated version).
 */
export function PetSpriteThumbnail({
  url,
  cols = PETDEX_GRID_COLS,
  rows = PETDEX_GRID_ROWS,
  className,
}: PetSpriteThumbnailProps) {
  const style: CSSProperties = {
    backgroundImage: `url("${url}")`,
    backgroundSize: `${cols * 100}% ${rows * 100}%`,
    backgroundPosition: "0% 0%",
    backgroundRepeat: "no-repeat",
    imageRendering: "pixelated",
  };
  return <div className={className} style={style} />;
}

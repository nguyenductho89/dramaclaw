// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const station = readFileSync("src/features/piko-mini-game/PikoInspirationStation.tsx", "utf8");
const breakout = readFileSync("src/features/piko-mini-game/PikoBreakoutGame.tsx", "utf8");
const flying = readFileSync("src/features/piko-mini-game/PikoFlyingGame.tsx", "utf8");
const leap = readFileSync("src/features/piko-mini-game/PikoLeapGame.tsx", "utf8");
const stackGame = readFileSync("src/features/piko-mini-game/PikoStackGame.tsx", "utf8");
const chrome = readFileSync("src/features/piko-mini-game/PikoGameChrome.tsx", "utf8");

describe("Piko five mini games design upgrade", () => {
  it("share a unified HUD and result layer", () => {
    expect(chrome).toContain("function PikoGameHud");
    expect(chrome).toContain("function PikoGameOverlay");
    expect([breakout, flying, leap, stackGame].every((source) => source.includes("PikoGameHud"))).toBe(true);
    expect([breakout, flying, leap, stackGame].every((source) => source.includes("PikoGameOverlay"))).toBe(true);
  });

  it("the card-flip game has progressive rounds, streak scoring and scan props", () => {
    expect(station).toContain("MEMORY_ROUND_PAIR_COUNTS = [4, 6, 8]");
    expect(station).toContain("scanCards");
    expect(station).toContain("nextStreak * 25");
  });

  it("brick breaker has a three-wave structure, armored bricks and blast bricks", () => {
    expect(breakout).toContain('type BrickKind = "normal" | "armored" | "blast"');
    expect(breakout).toContain("waveRef.current < 3");
    expect(breakout).toContain('brick.kind === "blast"');
  });

  it("the flying game has fixed obstacle templates, precision rewards and a recoverable shield", () => {
    expect(flying).toContain("GATE_PATTERNS");
    expect(flying).toContain("precisionStreakRef");
    expect(flying).toContain("hasShield");
  });

  it("the jumping game has platform variations, perfect landings and one rescue", () => {
    expect(leap).toContain('type PlatformKind = "normal" | "bonus" | "spring" | "fragile"');
    expect(leap).toContain("rescueAvailableRef");
    expect(leap).toContain('showLandingFeedback("perfect")');
  });

  it("Stack Steady uses three-level physics stacking and removes the rolling ball implementation", () => {
    expect(stackGame).toContain('type PropKind = "jelly" | "bulb" | "gear" | "bottle" | "spring" | "critter"');
    expect(stackGame).toContain("const STACK_LEVELS");
    expect(stackGame).toContain("towerBalance");
    expect(stackGame).toContain("rescueOrLose");
    expect(station).toContain('PikoStackGame');
    expect(existsSync("src/features/piko-mini-game/PikoTrackBallGame.tsx")).toBe(false);
    expect(existsSync("src/features/piko-mini-game/PikoRollingBallGame.tsx")).toBe(false);
  });
});

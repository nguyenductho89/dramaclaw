// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  "src/features/piko-mini-game/PikoInspirationStation.tsx",
  "utf8",
);
const librarySource = source.slice(
  source.indexOf("const PIKO_GAME_LIBRARY"),
  source.indexOf("const KIND_LABEL"),
);
const posterCardSource = source.slice(
  source.indexOf("function PikoGamePosterCard"),
  source.indexOf("const KIND_LABEL"),
);
const vi = JSON.parse(
  readFileSync("public/locales/vi/translation.json", "utf8"),
);
const en = JSON.parse(
  readFileSync("public/locales/en/translation.json", "utf8"),
);

describe("Piko Game Center", () => {
  it("keeps only the six confirmed mini games", () => {
    expect(librarySource.match(/\bid:/g)).toHaveLength(6);
    expect(librarySource).not.toContain('id: "catch"');
    expect(source).not.toContain("PikoCatchGame");
    expect(
      existsSync("src/features/piko-mini-game/PikoCatchGame.tsx"),
    ).toBe(false);
  });

  it("uses the confirmed short names and keeps the English titles complete", () => {
    expect([
      vi.pikoMiniGame.title,
      vi.pikoMiniGame.memory.title,
      vi.pikoMiniGame.breakout.title,
      vi.pikoMiniGame.stackGame.title,
      vi.pikoMiniGame.flying.title,
      vi.pikoMiniGame.leap.title,
    ]).toEqual([
      "Piko một chút, bắt lại cảm hứng",
      "Lật hình trí nhớ",
      "Phá gạch",
      "Xếp đi, đừng hoảng",
      "Piko bay",
      "Piko nhảy",
    ]);
    expect(en.pikoMiniGame.catch).toBeUndefined();
    expect(vi.pikoMiniGame.catch).toBeUndefined();
    expect([
      en.pikoMiniGame.title,
      en.pikoMiniGame.memory.title,
      en.pikoMiniGame.breakout.title,
      en.pikoMiniGame.stackGame.title,
      en.pikoMiniGame.flying.title,
      en.pikoMiniGame.leap.title,
    ]).toEqual([
      "Spark Shots",
      "Find a Pair",
      "Bricks Begone",
      "Stack, Don't Panic",
      "Don't Crash",
      "Stick the Landing",
    ]);
  });

  it("uses the native 4:3 poster entry and provides hover videos for the six games", () => {
    expect(source).toContain("aspect-[4/3]");
    expect(source).not.toContain("aspect-[3/2]");
    expect(source).not.toContain("aspect-square");
    expect(librarySource.match(/posterSrc:/g)).toHaveLength(6);
    expect(librarySource.match(/videoSrc:/g)).toHaveLength(6);
    const hoverAssets = [
      "spark-shots",
      "find-a-pair",
      "bricks-begone",
      "stack-dont-panic",
      "dont-crash",
      "stick-the-landing",
    ];
    hoverAssets.forEach((assetName) => {
      expect(librarySource).toContain(
        `videoSrc: "/piko/games/previews/${assetName}-hover.mp4"`,
      );
      expect(librarySource).toContain(
        `posterSrc: "/piko/games/posters/${assetName}-hover-frame.jpg"`,
      );
      expect(existsSync(`public/piko/games/previews/${assetName}-hover.mp4`)).toBe(true);
      expect(existsSync(`public/piko/games/posters/${assetName}-hover-frame.jpg`)).toBe(true);
    });
    expect(posterCardSource.match(/<video/g)).toHaveLength(1);
    expect(posterCardSource).not.toContain("<img");
    expect(posterCardSource).not.toContain("will-change-opacity");
    expect(posterCardSource).not.toContain("duration-[80ms]");
    expect(posterCardSource).not.toContain("setTimeout");
    expect(posterCardSource).not.toContain("hoverVideoVisible");
    expect(posterCardSource).toContain("onPointerEnter={playHoverPreview}");
    expect(posterCardSource).toContain("onPointerLeave={stopHoverPreview}");
    // The hover video is an on-demand resource: opening the game library mounts all six cards at once, so preload must be none,
    // otherwise about 5.9MiB is prefetched even without hovering. The first frame is carried by the poster, and loading is left to load().
    expect(posterCardSource).toContain('preload="none"');
    expect(posterCardSource).not.toContain('preload="auto"');
    expect(posterCardSource).not.toContain('preload="metadata"');
    // load() fires only once on the first hover, and repeated hovers must not interrupt an in-progress load.
    expect(posterCardSource).toContain("hoverVideoLoadStartedRef");
    expect(posterCardSource.match(/video\.load\(\)/g)).toHaveLength(1);
    expect(posterCardSource).toContain("video.currentTime = HOVER_VIDEO_FIRST_FRAME");
    expect(posterCardSource).not.toContain("group-hover:scale");
    expect(posterCardSource).not.toContain("group-focus-visible:scale");
    expect(posterCardSource).not.toContain("transform-gpu");
    expect(posterCardSource).not.toContain("will-change-transform");
    expect(posterCardSource).toContain('video.removeAttribute("poster")');
    expect(posterCardSource).toContain("onSeeked={(event) =>");
    expect(posterCardSource).toContain("transition-[filter] duration-300 ease-out");
    expect(posterCardSource).toContain("group-hover:brightness-[1.04]");
    expect(posterCardSource).toContain("group-hover:saturate-[1.04]");
    expect(source).not.toContain("hover:-translate-y-1");
    expect(source).not.toContain("group-hover:translate-y-0");
    expect(source).toContain("aria-label={title}");
    expect(source).not.toContain("border-b border-white/[0.07]");
  });

  it("the poster entry keeps progressive card spacing according to window width", () => {
    expect(source).toContain(
      "grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 lg:grid-cols-3 lg:gap-6",
    );
  });

  it("entering any mini game shares the Inspiration Whoosh background music", () => {
    expect(source).toContain('const BGM_SOUND_SRC = "/piko/sounds/bgm.mp3"');
    expect(source).toContain('if (!open || stationView !== "game" || isAudioMuted)');
    expect(source).not.toContain('activeGameId !== "inspiration-station"');
  });
});

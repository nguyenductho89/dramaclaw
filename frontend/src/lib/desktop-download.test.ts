// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectDesktopPlatform,
  FALLBACK_DOWNLOAD_URL,
  parseManifestRelease,
  pickInstallerFromManifest,
  resolveDesktopRelease,
} from "./desktop-download";

// Same shape as the electron-updater manifest produced by the release pipeline (the url field carries a versioned file name).
const WINDOWS_MANIFEST = `version: 1.1.0
files:
  - url: DramaClaw-Setup-1.1.0.exe
    sha512: occFiM5M3gMp2RqWdM+5Fjw==
    size: 883116200
path: DramaClaw-Setup-1.1.0.exe
sha512: occFiM5M3gMp2RqWdM+5Fjw==
releaseDate: '2026-07-15T08:45:34.419Z'
`;

// The macOS manifest lists both a zip (auto-update carrier) and a dmg (first-install carrier).
const MAC_MANIFEST = `version: 1.1.0
files:
  - url: DramaClaw-1.1.0-arm64.zip
    sha512: Bw4uOHg/lIXnqAlOKsuZMw==
    size: 1003619976
  - url: DramaClaw-1.1.0-arm64.dmg
    sha512: 5xw1uPGkX0Yl3m2n4o5p6q==
    size: 969342976
path: DramaClaw-1.1.0-arm64.zip
sha512: Bw4uOHg/lIXnqAlOKsuZMw==
releaseDate: '2026-07-15T08:45:34.419Z'
`;

// A file name containing spaces (the electron-builder NSIS default artifactName).
const SPACED_MANIFEST = `version: 1.1.0
files:
  - url: DramaClaw Setup 1.1.0.exe
    sha512: occFiM5M3gMp2RqWdM+5Fjw==
    size: 883116200
path: DramaClaw Setup 1.1.0.exe
releaseDate: '2026-07-15T08:45:34.419Z'
`;

describe("pickInstallerFromManifest", () => {
  it("picks the .exe from the Windows manifest", () => {
    expect(pickInstallerFromManifest(WINDOWS_MANIFEST, "windows")).toEqual({
      file: "DramaClaw-Setup-1.1.0.exe",
      sha512: "occFiM5M3gMp2RqWdM+5Fjw==",
    });
  });

  // The top-level sha512 belongs to the top-level path: (zip); attaching it to the dmg would make users verify against the wrong value.
  it("pairs the .dmg with its own sha512, not the zip's or the top-level one", () => {
    expect(pickInstallerFromManifest(MAC_MANIFEST, "mac")).toEqual({
      file: "DramaClaw-1.1.0-arm64.dmg",
      sha512: "5xw1uPGkX0Yl3m2n4o5p6q==",
    });
  });

  it("returns null when the wanted installer type is absent", () => {
    expect(pickInstallerFromManifest(WINDOWS_MANIFEST, "mac")).toBeNull();
    expect(pickInstallerFromManifest("", "windows")).toBeNull();
  });

  it("leaves sha512 null when the entry has none", () => {
    expect(
      pickInstallerFromManifest("files:\n  - url: DramaClaw-1.0.dmg\n", "mac"),
    ).toEqual({ file: "DramaClaw-1.0.dmg", sha512: null });
  });

  // The electron-builder NSIS default artifactName contains spaces, and in YAML it is a bare scalar.
  it("keeps spaces in the filename", () => {
    expect(pickInstallerFromManifest(SPACED_MANIFEST, "windows")?.file).toBe(
      "DramaClaw Setup 1.1.0.exe",
    );
  });

  it("strips quoting when the manifest quotes the value", () => {
    expect(
      pickInstallerFromManifest("files:\n  - url: 'DramaClaw 1.0.dmg'\n", "mac")
        ?.file,
    ).toBe("DramaClaw 1.0.dmg");
  });
});

describe("parseManifestRelease", () => {
  it("reads version and release date off the manifest", () => {
    expect(parseManifestRelease(WINDOWS_MANIFEST)).toEqual({
      version: "1.1.0",
      releaseDate: "2026-07-15",
    });
  });

  // The path: line also contains the version, but only the version: at the start of a line counts.
  it("ignores version-looking text on other lines", () => {
    expect(parseManifestRelease(MAC_MANIFEST).version).toBe("1.1.0");
  });

  it("returns nulls when the fields are missing", () => {
    expect(parseManifestRelease("")).toEqual({
      version: null,
      releaseDate: null,
    });
  });
});

describe("resolveDesktopRelease", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  function stubManifest(body: string) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );
  }

  it("percent-encodes a filename with spaces exactly once", async () => {
    stubManifest(SPACED_MANIFEST);
    const release = await resolveDesktopRelease("windows");
    expect(release.url).toBe(
      "https://dramaclaw-dl.cdnfg.com/desktop/DramaClaw%20Setup%201.1.0.exe",
    );
  });

  it("carries the installer's own checksum through", async () => {
    stubManifest(MAC_MANIFEST);
    await expect(resolveDesktopRelease("mac")).resolves.toEqual({
      url: "https://dramaclaw-dl.cdnfg.com/desktop/DramaClaw-1.1.0-arm64.dmg",
      resolved: true,
      version: "1.1.0",
      releaseDate: "2026-07-15",
      sha512: "5xw1uPGkX0Yl3m2n4o5p6q==",
    });
  });

  // The manifest already uses the encoded form; encoding again would produce %2520.
  it("does not double-encode an already-encoded filename", async () => {
    stubManifest("files:\n  - url: DramaClaw%20Setup%201.1.0.exe\n");
    const release = await resolveDesktopRelease("windows");
    expect(release.url).toBe(
      "https://dramaclaw-dl.cdnfg.com/desktop/DramaClaw%20Setup%201.1.0.exe",
    );
  });

  it("falls back and warns when the fetch is blocked", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(resolveDesktopRelease("mac")).resolves.toEqual({
      url: FALLBACK_DOWNLOAD_URL,
      resolved: false,
      version: null,
      releaseDate: null,
      sha512: null,
    });
    expect(warn).toHaveBeenCalled();
  });

  // Partial success: the manifest yields a version, but files: has no dmg (naming drift, that release only shipped a
  // zip). The version is non-empty but the url is already the fallback; callers must be able to tell, otherwise they would treat it as a
  // success and cache it for the whole session.
  it("reports resolved=false when the manifest has a version but no installer", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubManifest(
      "version: 1.1.0\nfiles:\n  - url: DramaClaw-1.1.0-arm64.zip\n",
    );
    await expect(resolveDesktopRelease("mac")).resolves.toEqual({
      url: FALLBACK_DOWNLOAD_URL,
      resolved: false,
      version: "1.1.0",
      releaseDate: null,
      sha512: null,
    });
    expect(warn).toHaveBeenCalled();
  });
});

describe("detectDesktopPlatform", () => {
  it("classifies Windows user agents", () => {
    expect(
      detectDesktopPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"),
    ).toBe("windows");
  });

  it("falls back to mac for everything else", () => {
    expect(
      detectDesktopPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
    ).toBe("mac");
    expect(detectDesktopPlatform("")).toBe("mac");
  });
});

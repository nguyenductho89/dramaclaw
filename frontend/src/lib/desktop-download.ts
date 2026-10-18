// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Desktop installer downloads offered on the login hero.
 *
 * Installer file names carry a version (e.g. DramaClaw-Setup-1.1.0.exe); hard-coding them is guaranteed to rot with releases.
 * The release pipeline maintains a pair of "current version pointers": electron-updater's latest.yml /
 * latest-mac.yml (the CDN does not cache *.yml, so changes are visible immediately). They are resolved on demand here to get
 * the real file name of the current installer; the file name is taken from the manifest's url: field and never
 * assembled from a version number, so this file needs no change if the naming pattern changes.
 */
export type DesktopPlatform = "mac" | "windows";

const DOWNLOAD_BASE = "https://dramaclaw-dl.cdnfg.com/desktop/";

const MANIFEST: Record<DesktopPlatform, string> = {
  mac: "latest-mac.yml",
  windows: "latest.yml",
};

// latest-mac.yml lists both a zip (the auto-update carrier) and a dmg (the first-install carrier);
// the website must serve the dmg; the Windows manifest only has an exe.
const INSTALLER_EXT: Record<DesktopPlatform, string> = {
  mac: ".dmg",
  windows: ".exe",
};

/**
 * Fallback when pointer resolution fails (offline, CDN outage, manifest format drift): the GitHub Releases
 * page contains the assets for every platform; slower but reachable, so the button never does nothing.
 */
export const FALLBACK_DOWNLOAD_URL =
  "https://github.com/dramaclaw/dramaclaw/releases/latest";

/** The current release for one platform: direct installer link + the version and release date the manifest reports. */
export type DesktopRelease = {
  /** Direct installer link; falls back to the GitHub Releases page when resolution fails, so the button is always clickable. */
  url: string;
  /**
   * Whether a direct installer link was actually resolved from the manifest.
   *
   * Do not use `version !== null` as the success criterion: when the manifest has a version but `files:` has no
   * target suffix (naming pattern drift, or a mac release that only shipped a zip), the version still resolves,
   * but the url has already fallen back to GitHub; callers deciding by version would treat this partial success as success and
   * cache it, pinning the whole session to the fallback link.
   */
  resolved: boolean;
  /** The version in the manifest (e.g. "1.3.2"); null when the field is missing or the format drifted. */
  version: string | null;
  /** The release date in the manifest, truncated to YYYY-MM-DD; null when it cannot be parsed. */
  releaseDate: string | null;
  /**
   * This installer's own sha512 (base64, in the exact electron-builder format),
   * for users to verify integrity after downloading. null when the manifest lacks the field.
   */
  sha512: string | null;
};

/** One entry of the manifest `files:` list: installer file name + its own checksum. */
export type ManifestInstaller = {
  file: string;
  sha512: string | null;
};

/** Strips the quotes around a YAML scalar (js-yaml adds them when the value contains special characters such as `:` or `#`). */
function unquote(value: string): string {
  return value.trim().replace(/^(['"])(.*)\1$/, "$2");
}

/**
 * Picks the target platform's installer from the electron-updater manifest text: file name and checksum.
 *
 * Scans line by line instead of using one regex, because the sha512 must **follow the files: entry it belongs to**:
 * the manifest also ends with a top-level sha512 that matches the top-level path: (on mac that is the zip used
 * for auto-update); attaching it to the dmg would make users verify against the wrong value, which is worse than showing nothing.
 *
 * The file name is taken to the end of the line and trimmed instead of using `\S+`: electron-builder's NSIS default
 * artifactName produces file names with spaces (`DramaClaw Setup 1.3.2.exe`), which in YAML
 * are unquoted bare scalars; `\S+` would cut at the first space and build a link that is guaranteed to 404.
 */
export function pickInstallerFromManifest(
  manifest: string,
  platform: DesktopPlatform,
): ManifestInstaller | null {
  const ext = INSTALLER_EXT[platform];
  let open: ManifestInstaller | null = null;

  for (const line of manifest.split("\n")) {
    // A line with zero indentation that is not a list item (version:/path:/releaseDate:) ends the current entry.
    if (/^\S/.test(line)) {
      if (open?.file.endsWith(ext)) return open;
      open = null;
      continue;
    }
    const url = line.match(/^\s*-?\s*url:\s*(.+)$/);
    if (url) {
      if (open?.file.endsWith(ext)) return open;
      open = { file: unquote(url[1]), sha512: null };
      continue;
    }
    const sha = line.match(/^\s*sha512:\s*(.+)$/);
    if (sha && open) open.sha512 = unquote(sha[1]);
  }
  return open?.file.endsWith(ext) ? open : null;
}

/**
 * Converts a file name into a single URL path segment.
 *
 * The url in the manifest is sometimes already encoded (spaces written as %20); encoding it again would give
 * %2520, and the link would still 404. So decode once first and then encode uniformly, which normalizes both forms.
 * encodeURIComponent is itself the security boundary, do not remove it: it pins the file name to the last path segment,
 * so `../` traversal and open redirects like `//evil.com` cannot be built.
 */
function encodeInstallerPath(file: string): string {
  let decoded = file;
  try {
    decoded = decodeURIComponent(file);
  } catch {
    // Invalid escape sequence (e.g. a bare % in the file name): just encode as is.
  }
  return encodeURIComponent(decoded);
}

/**
 * Reads the version and release date from the manifest. The download page uses this as the single source of truth for the "current version" -
 * a version hard-coded in the copy is guaranteed to rot with releases, while this manifest is written by the release pipeline itself.
 */
export function parseManifestRelease(manifest: string): {
  version: string | null;
  releaseDate: string | null;
} {
  return {
    version: manifest.match(/^version:\s*(\S+)/m)?.[1] ?? null,
    releaseDate:
      manifest.match(/^releaseDate:\s*'?(\d{4}-\d{2}-\d{2})/m)?.[1] ?? null,
  };
}

/** Resolves the current release; any failed step falls back (the url is always clickable, version fields stay empty). */
export async function resolveDesktopRelease(
  platform: DesktopPlatform,
): Promise<DesktopRelease> {
  const fallback: DesktopRelease = {
    url: FALLBACK_DOWNLOAD_URL,
    resolved: false,
    version: null,
    releaseDate: null,
    sha512: null,
  };
  try {
    const res = await fetch(DOWNLOAD_BASE + MANIFEST[platform], {
      cache: "no-store",
    });
    if (!res.ok) {
      warnUnresolved(platform, `manifest responded ${res.status}`);
      return fallback;
    }
    const manifest = await res.text();
    const installer = pickInstallerFromManifest(manifest, platform);
    if (!installer) warnUnresolved(platform, "no installer url in manifest");
    return {
      url: installer
        ? DOWNLOAD_BASE + encodeInstallerPath(installer.file)
        : FALLBACK_DOWNLOAD_URL,
      resolved: installer !== null,
      sha512: installer?.sha512 ?? null,
      ...parseManifestRelease(manifest),
    };
  } catch (err) {
    // CSP blocks, CORS and being offline look the same on the page (all fall back to the GitHub button),
    // so without a log line there is no way to tell "the CDN is down" from "nginx is missing one allowed domain".
    warnUnresolved(platform, err);
    return fallback;
  }
}

function warnUnresolved(platform: DesktopPlatform, cause: unknown): void {
  // Developer log, not UI text.
  console.warn(
    `[desktop-download] ${platform} version pointer resolution failed, falling back to GitHub Releases.` +
      ` If this is a network error, first check whether CSP connect-src allows ${DOWNLOAD_BASE}`,
    cause,
  );
}

/**
 * Which installer to feature as the filled primary button. Falls back to macOS
 * on anything we can't identify (Linux, phones, bots) so the row never renders
 * empty — the other platform stays one click away as the adjacent text link.
 */
export function detectDesktopPlatform(
  userAgent: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): DesktopPlatform {
  return /windows|win32|win64/i.test(userAgent) ? "windows" : "mac";
}

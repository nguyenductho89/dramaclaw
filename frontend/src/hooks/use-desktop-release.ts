// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import {
  FALLBACK_DOWNLOAD_URL,
  resolveDesktopRelease,
  type DesktopPlatform,
  type DesktopRelease,
} from "@/lib/desktop-download";

type Releases = Record<DesktopPlatform, DesktopRelease>;

let cached: Releases | null = null;

/** Placeholder before resolution completes: the button points at GitHub Releases, version fields are empty and the caller decides how to display them. */
function pending(): Releases {
  const blank: DesktopRelease = {
    url: FALLBACK_DOWNLOAD_URL,
    resolved: false,
    version: null,
    releaseDate: null,
    sha512: null,
  };
  return { mac: { ...blank }, windows: { ...blank } };
}

/**
 * After mount, resolves the version pointer on the CDN (latest*.yml) to get the current installer direct link and version.
 * The module-level cache is the same as useGithubStars: resolved once per session - the login page header and
 * the download page share this one cache, so the CDN is not hit twice when both appear.
 */
export function useDesktopRelease(): Releases {
  const [releases, setReleases] = useState<Releases>(cached ?? pending());

  useEffect(() => {
    if (cached !== null) return;
    let active = true;
    Promise.all(
      (["mac", "windows"] as const).map(
        async (os) => [os, await resolveDesktopRelease(os)] as const,
      ),
    ).then((entries) => {
      const next = pending();
      for (const [os, release] of entries) next[os] = release;
      // Only successful results are cached. If failures were cached too, one transient hiccup (CDN 504,
      // a network switch) would pin the whole session to the GitHub fallback with no way to recover however many pages are visited;
      // when not cached, the next mount retries.
      //
      // The criterion is resolved, not version: when the manifest has a version but the installer was not resolved,
      // version is non-empty but the url is already the fallback, and judging by version would cache this partial success.
      if (Object.values(next).every((r) => r.resolved)) cached = next;
      if (active) setReleases(next);
    });
    return () => {
      active = false;
    };
  }, []);

  return releases;
}

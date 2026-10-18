// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";

// The GitHub anonymous API is limited to 60 requests/hour/IP, so the login page is easily rate-limited (403) behind a shared egress IP.
// The last successfully fetched star count is persisted to localStorage: when a request fails / is rate-limited the local value is the fallback,
// and on success the display is refreshed and written back, so the badge no longer vanishes because of one 403.
const STARS_STORAGE_KEY = "dramaclaw.login.githubStars";

function readStoredStars(): number | null {
  try {
    const raw = window.localStorage.getItem(STARS_STORAGE_KEY);
    if (!raw) return null;
    const value = Number.parseInt(raw, 10);
    return Number.isFinite(value) && value >= 0 ? value : null;
  } catch {
    // localStorage may be unavailable in private mode / restricted environments.
    return null;
  }
}

function writeStoredStars(count: number): void {
  try {
    window.localStorage.setItem(STARS_STORAGE_KEY, String(count));
  } catch {
    // A failed write does not matter; the star count is only a nicety.
  }
}

/**
 * Fetches the star count of the target repo and persists the value to localStorage.
 * - First frame: synchronously returns the last successfully persisted value (null if none).
 * - Request succeeds: updates the display and writes back to localStorage.
 * - Request fails / rate-limited: silently keeps the last persisted value and does not hide the badge.
 */
export function useGithubStars(repo: string): number | null {
  const [stars, setStars] = useState<number | null>(() => readStoredStars());

  useEffect(() => {
    let active = true;
    fetch(`https://api.github.com/repos/${repo}`, {
      headers: { Accept: "application/vnd.github+json" },
    })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { stargazers_count?: number } | null) => {
        const count = data?.stargazers_count;
        if (typeof count !== "number") return;
        writeStoredStars(count);
        if (active) setStars(count);
      })
      .catch(() => {
        /* Silent failure: keep the last persisted star count */
      });
    return () => {
      active = false;
    };
  }, [repo]);

  return stars;
}

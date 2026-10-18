// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";

/**
 * Data layer for the login page announcement center.
 *
 * Announcements are not hard-coded in the frontend: the content is a JSON file
 * on OSS, so editing an announcement means overwriting that object, with no
 * release and no translation-file change. The default URL is
 * `DEFAULT_ANNOUNCEMENTS_URL`; local or private deployments override it with
 * `VITE_LOGIN_ANNOUNCEMENTS_URL` (in dev, point it at `/announcements.json` to
 * read the repo copy `frontend/public/announcements.json`, which must be kept
 * in sync with the live one).
 *
 * JSON shape (an `announcements` array; a bare top-level array is also accepted):
 *
 * ```json
 * {
 *   "announcements": [
 *     {
 *       "id": "channel-release-2026-08",
 *       "publishedAt": "2026-08-24T10:00:00+08:00",
 *       "pinned": false,
 *       "i18n": {
 *         "en": { "title": "Channel release update", "body": "A <hl>channel release</hl>..." },
 *         "vi": { "title": "Cập nhật phiên bản kênh", "body": "..." }
 *       }
 *     }
 *   ]
 * }
 * ```
 *
 * In the body, `<hl>...</hl>` marks a highlight and `<time>...</time>` a time
 * window; `parseAnnouncementBody` splits them into tokens and the UI renders
 * styled spans. **Only these two markers are recognized**; any other angle
 * brackets are plain text, so a broken remote copy shows up as literals at worst
 * and can never inject HTML.
 *
 * When the fetch fails (object not uploaded / offline / new domain without CORS)
 * there is no local cache and no hard-coded fallback: it simply means "no
 * announcements". Announcements convey the current state, so better empty than stale.
 */

/** The text of one announcement in one language. */
export type AnnouncementText = { title: string; body: string };

export type Announcement = {
  /**
   * Primary key of the read state. It is written to localStorage, so **changing
   * the id makes the announcement unread for everyone again**; that is the only
   * way to resurface an old announcement.
   */
  id: string;
  /** ISO 8601. Localized at render time for the current language; never store a pre-formatted string here. */
  publishedAt: string;
  /** Pinned items sort first and carry a "pinned" badge. */
  pinned?: boolean;
  /** Language tag (`en` / `vi` / `en-US`, case-insensitive) -> text in that language. */
  i18n: Record<string, AnnouncementText>;
};

const AnnouncementTextSchema = z.object({
  title: z.string().trim().min(1),
  body: z.string().trim().min(1),
});

const AnnouncementSchema = z.object({
  id: z.string().trim().min(1),
  publishedAt: z
    .string()
    .refine((value) => Number.isFinite(Date.parse(value)), "publishedAt must be a parseable ISO 8601 string"), // i18n-exempt: dev-time zod validation error
  pinned: z.boolean().optional(),
  // At least one language is required, otherwise the announcement renders as an empty card.
  i18n: z.record(z.string(), AnnouncementTextSchema).refine((map) => Object.keys(map).length > 0),
});

// Accept either `{ "announcements": [...] }` or a bare array: a wrong wrapper is the
// most common mistake in a hand-maintained JSON and is not worth losing every announcement.
const PayloadSchema = z.union([
  z.object({ announcements: z.array(AnnouncementSchema) }),
  z.array(AnnouncementSchema),
]);

/**
 * Announcements deliberately do **not** share the `cdn()` prefix from `media.ts`
 * with the QR codes and teaser clips; they go straight to OSS.
 *
 * Those images and videos are loaded by `<img>`/`<video>`, which the browser reads
 * itself (JS cannot see the content, no CORS check) and which never change once
 * published, so a 30-day edge cache on the CDN suits them. Announcements are the opposite:
 *
 * - They are `fetch()`ed so JS can read the JSON, so the response **must** carry
 *   `Access-Control-Allow-Origin`. Without it the object returns 200 and opens in
 *   the address bar, but the page silently shows "no announcements".
 * - Edits should take effect quickly, while the CDN's 30-day edge cache
 *   (`X-Swift-CacheTime: 2592000`) pins the old announcement on edge nodes: the origin
 *   is not consulted again, and **a query string does not bypass it** because this CDN
 *   strips the query from the cache key, so `?t=<timestamp>` hits the same stale copy.
 *
 * Going straight to OSS avoids the edge cache; the object's own
 * `Cache-Control: max-age=60` is the only layer, so an upload takes effect
 * everywhere within a minute. The cost is that this domain must be allowed by the
 * bucket's CORS settings for this site's origin.
 */
export const DEFAULT_ANNOUNCEMENTS_URL = "https://nfg-web.cdnfg.com/dramaclaw/announcements.json";

export function announcementsUrl(): string {
  const override = import.meta.env.VITE_LOGIN_ANNOUNCEMENTS_URL?.trim();
  return override ? override : DEFAULT_ANNOUNCEMENTS_URL;
}

/**
 * Pinned first, the rest by publish time descending. Sorting lives in the data
 * layer rather than a component so the order is defined in one place; the order
 * inside the JSON does not affect the final display.
 */
function sortAnnouncements(items: Announcement[]): Announcement[] {
  return [...items].sort((left, right) => {
    if (Boolean(left.pinned) !== Boolean(right.pinned)) return left.pinned ? -1 : 1;
    return Date.parse(right.publishedAt) - Date.parse(left.publishedAt);
  });
}

export async function fetchAnnouncements(signal?: AbortSignal): Promise<Announcement[]> {
  const url = announcementsUrl();
  // `no-cache` means "revalidate with ETag", not "do not cache": an edited announcement
  // shows up on refresh without a full re-download on every login page visit. This relies
  // on the object carrying a short Cache-Control, otherwise edits wait for the CDN edge cache to expire.
  const res = await fetch(url, { credentials: "omit", cache: "no-cache", signal });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);

  const parsed = PayloadSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error(`invalid announcements payload: ${parsed.error.message}`);

  const items = Array.isArray(parsed.data) ? parsed.data : parsed.data.announcements;
  return sortAnnouncements(items);
}

/**
 * Pick the text for the UI language: exact match (`en-US`), then the primary
 * language (`en`), then English, then the first entry in the JSON. **Always
 * returns one** instead of null: a missing translation should not hide the whole
 * announcement; showing another language at least keeps the information.
 */
export function pickAnnouncementText(item: Announcement, language: string): AnnouncementText {
  const byLowerKey = new Map(
    Object.entries(item.i18n).map(([key, value]) => [key.toLowerCase(), value]),
  );
  const tag = language.toLowerCase();
  const candidates = [tag, tag.split("-")[0], "en"];

  for (const candidate of candidates) {
    const hit = byLowerKey.get(candidate);
    if (hit) return hit;
  }
  // The schema guarantees at least one entry; the ?? only narrows the type.
  return Object.values(item.i18n)[0] ?? { title: "", body: "" };
}

export type AnnouncementBodyToken = { kind: "text" | "hl" | "time"; text: string };

const BODY_MARKUP_RE = /<(hl|time)>([\s\S]*?)<\/\1>/g;

/**
 * Split the body into three token kinds: plain text / highlight / time window.
 *
 * Remote copy is untrusted input, so this uses neither `dangerouslySetInnerHTML`
 * nor i18next HTML parsing: only the closed `<hl>` and `<time>` markers are
 * recognized and all other angle brackets are emitted as text. Any other tag in
 * the copy is shown literally and never becomes DOM.
 */
export function parseAnnouncementBody(body: string): AnnouncementBodyToken[] {
  const tokens: AnnouncementBodyToken[] = [];
  let cursor = 0;

  for (const match of body.matchAll(BODY_MARKUP_RE)) {
    const start = match.index ?? 0;
    if (start > cursor) tokens.push({ kind: "text", text: body.slice(cursor, start) });
    tokens.push({ kind: match[1] as "hl" | "time", text: match[2] });
    cursor = start + match[0].length;
  }
  if (cursor < body.length) tokens.push({ kind: "text", text: body.slice(cursor) });

  return tokens;
}

/**
 * Fetch announcements. Fetched once on mount; on failure the result is an empty
 * array, which callers use to collapse the whole entry point.
 *
 * There is no loading / error state: callers treat "not fetched yet", "failed"
 * and "none exist" identically (show nothing), and extra states would only add
 * unreachable UI branches.
 *
 * The request is aborted on unmount: the login page entry unmounts on a
 * successful login, and letting a request nobody watches call setState would only
 * produce a React warning.
 */
export function useAnnouncements(): Announcement[] {
  const [announcements, setAnnouncements] = useState<Announcement[]>([]);

  useEffect(() => {
    const controller = new AbortController();
    let alive = true;

    fetchAnnouncements(controller.signal)
      .then((items) => {
        if (alive) setAnnouncements(items);
      })
      .catch((error: unknown) => {
        if (!alive || controller.signal.aborted) return;
        // Log once: a missing announcement is not something the user can fix, so the UI
        // quietly drops the entry; this line tells you whether it was CDN/CORS or broken JSON.
        // eslint-disable-next-line no-console
        console.warn("[announcements] load failed:", error);
        setAnnouncements([]);
      });

    return () => {
      alive = false;
      controller.abort();
    };
  }, []);

  return announcements;
}

const READ_STORAGE_KEY = "dramaclaw.login.announcements.read";

function loadReadIds(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(READ_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((value): value is string => typeof value === "string");
  } catch {
    // Private mode, storage disabled by policy, or a previous version wrote a bad format:
    // treat all of them as "unread". Announcements are meant to get attention, so when the
    // state cannot be read, remind once more rather than silently treating it as read.
    return [];
  }
}

export type AnnouncementReadState = {
  isRead: (id: string) => boolean;
  markAllRead: (ids: readonly string[]) => void;
  unreadCount: (ids: readonly string[]) => number;
};

export function useAnnouncementReadState(): AnnouncementReadState {
  const [readIds, setReadIds] = useState<ReadonlySet<string>>(() => new Set(loadReadIds()));

  const markAllRead = useCallback((ids: readonly string[]) => {
    if (ids.length === 0) return;

    setReadIds((current) => {
      const next = new Set(current);
      const previousSize = next.size;
      ids.forEach((id) => next.add(id));
      if (next.size === previousSize) return current;

      try {
        window.localStorage.setItem(READ_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // If it cannot be stored, it only applies to this session and does not affect this interaction.
      }
      return next;
    });
  }, []);

  return {
    isRead: useCallback((id: string) => readIds.has(id), [readIds]),
    markAllRead,
    unreadCount: useCallback(
      (ids: readonly string[]) => ids.filter((id) => !readIds.has(id)).length,
      [readIds],
    ),
  };
}

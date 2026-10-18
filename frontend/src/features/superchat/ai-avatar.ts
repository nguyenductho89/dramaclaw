// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";

/**
 * The AI avatar video (`/video/ai-avatar.mp4`) is rendered as a `<video>` on every assistant message,
 * and each element used to issue its own request (even a 304 hit is a burst of round trips and debugging noise).
 *
 * This makes it "fetched once per session": after the first fetch the video blob is stored in IndexedDB, and one
 * `blob:` object URL is shared in memory. All avatars reuse that URL; blob: does not hit the network, so no matter how many
 * messages there are, there is only one request (or none); after a reload it is read straight from IndexedDB without fetching.
 * When IndexedDB is unavailable (private mode etc.) it falls back to the original path, i.e. the old behavior, with no functional impact.
 */

const AVATAR_PATH = "/video/ai-avatar.mp4";
const DB_NAME = "supertale-media-cache";
const STORE_NAME = "blobs";
const CACHE_KEY = "ai-avatar.mp4";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function idbGet(db: IDBDatabase, key: string): Promise<Blob | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as Blob | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, key: string, value: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Session-wide singleton: every caller awaits the same resolution, so the
// underlying fetch happens at most once.
let avatarUrlPromise: Promise<string> | null = null;

export function loadAiAvatarUrl(): Promise<string> {
  if (!avatarUrlPromise) {
    avatarUrlPromise = (async () => {
      try {
        const db = await openDb();
        const cached = await idbGet(db, CACHE_KEY);
        if (cached) {
          return URL.createObjectURL(cached);
        }
        const response = await fetch(AVATAR_PATH);
        if (!response.ok) {
          throw new Error(`avatar fetch failed: ${response.status}`);
        }
        const blob = await response.blob();
        // Best-effort persist; don't block the URL on the write succeeding.
        idbPut(db, CACHE_KEY, blob).catch(() => undefined);
        return URL.createObjectURL(blob);
      } catch {
        // IndexedDB unavailable / fetch blocked — fall back to the direct path
        // (browser HTTP cache still applies, same as before).
        return AVATAR_PATH;
      }
    })();
  }
  return avatarUrlPromise;
}

/**
 * Resolved AI-avatar source url (a shared `blob:` URL once cached, otherwise the
 * raw path). Returns `null` until ready so callers can hold off rendering the
 * `<video>` — that avoids the brief raw-path request from every freshly mounted
 * avatar before the blob is ready.
 */
export function useAiAvatarUrl(): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    void loadAiAvatarUrl().then((resolved) => {
      if (active) setUrl(resolved);
    });
    return () => {
      active = false;
    };
  }, []);
  return url;
}

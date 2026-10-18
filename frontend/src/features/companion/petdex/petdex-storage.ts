// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Local storage for user-supplied petdex pets: spritesheet.webp (Blob) + pet.json metadata are stored into
// the browser's IndexedDB, persisting across refreshes. Rendering uses an object URL (blob:) - the production CSP's
// img-src includes blob:, so it displays the same way and does not depend on the network/CDN at all.

const DB_NAME = "supertale-petdex";
const DB_VERSION = 1;
const STORE = "pets";

export interface StoredPetRecord {
  slug: string;
  displayName: string;
  submittedBy?: string;
  cols?: number;
  rows?: number;
  /** Original sprite sheet file. */
  blob: Blob;
  addedAt: number;
}

function idbAvailable(): boolean {
  return typeof indexedDB !== "undefined";
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "slug" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function savePetRecord(record: StoredPetRecord): Promise<void> {
  if (!idbAvailable()) throw new Error("IndexedDB unavailable");
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function getAllPetRecords(): Promise<StoredPetRecord[]> {
  if (!idbAvailable()) return [];
  const db = await openDb();
  try {
    return await new Promise<StoredPetRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const request = tx.objectStore(STORE).getAll();
      request.onsuccess = () => resolve((request.result as StoredPetRecord[]) ?? []);
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function deletePetRecord(slug: string): Promise<void> {
  if (!idbAvailable()) return;
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(slug);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export interface ImportedPetEntry {
  slug: string;
  displayName: string;
  submittedBy?: string;
  cols?: number;
  rows?: number;
  /** Object URL (blob:) valid for this session. */
  spritesheetUrl: string;
  imported: true;
}

/**
 * Read all imported pets and create an object URL for each for rendering. Object URLs are valid only for the current session,
 * and the caller revokes them on replace/unmount (in the prototype this is left to the page lifecycle; the amount is tiny).
 */
export async function loadImportedPets(): Promise<ImportedPetEntry[]> {
  const records = await getAllPetRecords();
  return records
    .sort((a, b) => b.addedAt - a.addedAt)
    .map((record) => ({
      slug: record.slug,
      displayName: record.displayName,
      submittedBy: record.submittedBy,
      cols: record.cols,
      rows: record.rows,
      spritesheetUrl: URL.createObjectURL(record.blob),
      imported: true as const,
    }));
}

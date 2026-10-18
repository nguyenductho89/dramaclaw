// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// The item model and category definitions of the asset library. The dialog (AssetLibraryModal, for picking reference images) and the Freezone left
// panel's "Asset library" tab share this; the categories and normalization logic exist in only one copy, avoiding drift between the two sides.
// Only pure data derivation goes here; write operations that call endpoints (upload/rename/delete/sync) stay in their own components.
import type {
  FreezoneAssetLibraryCategory,
  FreezoneAssetLibraryFolder,
  FreezoneAssetLibraryMedia,
  FreezoneAssetLibrarySource,
} from '@/api/ops';
import type { TFn } from '@/lib/i18n-types';

export const ASSET_LIBRARY_CARD_CLASS =
  'overflow-hidden rounded-sm border border-border bg-muted/30 transition-colors';
export const ASSET_LIBRARY_CARD_HOVER_CLASS =
  'hover:border-primary/35 hover:bg-accent';

export type AssetLibraryMedia = FreezoneAssetLibraryMedia;

export interface LibraryItem {
  id: string | null;
  name: string;
  media: AssetLibraryMedia;
  source: FreezoneAssetLibrarySource;
  /** Purpose category (tag). When old items are not returned by the backend, it is derived from source/media as a fallback, see deriveCategory. */
  category: AssetCategory;
  /** Save location (folder key). When old items lack this field it is placed by category, see deriveFolder. */
  folder: AssetFolderKey;
  /** The item's primary display / reference address under its media type. */
  url: string;
  raw: Record<string, unknown>;
}

/** Upper limit of asset name length, consistent with the backend LIBRARY_ITEM_NAME_MAX_LEN. */
export const LIBRARY_ITEM_NAME_MAX_LEN = 60;

const FILE_EXTENSION_PATTERN = /\.([a-z0-9]{2,5})$/i;
const MEDIA_FALLBACK_EXTENSION: Record<AssetLibraryMedia, string> = {
  image: 'png',
  video: 'mp4',
  audio: 'mp3',
};

/**
 * The file name given to an asset on download: asset name + the suffix inferred from the URL.
 *
 * The asset name is typed freely by the user and may contain characters such as `/`, `\`, `:` that the system treats as path separators,
 * all replaced with `_`; if the name is washed out entirely it falls back to the media name, so an empty file name is never produced.
 */
export function libraryItemDownloadFilename(entry: LibraryItem): string {
  const path = entry.url.split(/[?#]/, 1)[0] ?? '';
  const extension =
    FILE_EXTENSION_PATTERN.exec(path)?.[1]?.toLowerCase() ??
    MEDIA_FALLBACK_EXTENSION[entry.media];
  const base =
    entry.name.replace(/[\\/:*?"<>|]+/g, '_').trim() || entry.media;
  // When the name already carries the right suffix do not stack another ("cover.png" should not be downloaded as "cover.png.png").
  return base.toLowerCase().endsWith(`.${extension}`)
    ? base
    : `${base}.${extension}`;
}

/**
 * Asset categories. Categories are no longer split by medium (image/video/audio) but by purpose - under the same category
 * there may be images, videos and audio. `audio` (sound effects) is the only category that naturally holds only audio.
 */
export type AssetCategory = FreezoneAssetLibraryCategory;

export interface AssetCategoryDef {
  key: AssetCategory;
  /** The entry key of the display name - this table follows the UI language, and only the key is left in source. */
  labelKey: string;
  /** Which media files this category accepts - decides the accept attribute and hint text on upload. */
  media: AssetLibraryMedia[];
}

export const ASSET_CATEGORIES: AssetCategoryDef[] = [
  { key: 'other', labelKey: 'canvas.assetLibrary.category.other', media: ['image', 'video'] },
  {
    key: 'character',
    labelKey: 'canvas.assetLibrary.category.character',
    media: ['image', 'video'],
  },
  { key: 'scene', labelKey: 'canvas.assetLibrary.category.scene', media: ['image', 'video'] },
  { key: 'prop', labelKey: 'canvas.assetLibrary.category.prop', media: ['image', 'video'] },
  { key: 'style', labelKey: 'canvas.assetLibrary.category.style', media: ['image', 'video'] },
  { key: 'audio', labelKey: 'canvas.assetLibrary.category.audio', media: ['audio'] },
];

/** The "All categories" key of the category filter. The folder scope is controlled by independent navigation and is no longer mixed into the same row. */
export const ALL_CATEGORY_KEY = 'all';
export type AssetLibraryCategoryFilterKey =
  | typeof ALL_CATEGORY_KEY
  | AssetCategory;

/** Judge from a File's MIME which medium it belongs to; returns null if unrecognized (the file is dropped directly). */
export function mediaOfFile(file: File): AssetLibraryMedia | null {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  return null;
}

const CATEGORY_KEYS = new Set<string>(ASSET_CATEGORIES.map((c) => c.key));

/**
 * Old items have no category field, so derive one from their source/media as a fallback: characters/scenes/
 * props synced from the mainline are matched directly, audio goes to sound effects, and the remaining local uploads go to "Other".
 */
export function deriveCategory(
  raw: unknown,
  source: FreezoneAssetLibrarySource,
  media: AssetLibraryMedia,
): AssetCategory {
  if (typeof raw === 'string' && CATEGORY_KEYS.has(raw)) {
    return raw as AssetCategory;
  }
  if (source === 'character' || source === 'scene' || source === 'prop') {
    return source;
  }
  return media === 'audio' ? 'audio' : 'other';
}

export const SOURCE_LABEL_KEYS: Record<FreezoneAssetLibrarySource, string> = {
  upload: 'canvas.assetLibrary.source.upload',
  character: 'canvas.assetLibrary.source.character',
  scene: 'canvas.assetLibrary.source.scene',
  prop: 'canvas.assetLibrary.source.prop',
};

/**
 * Folder (save location) and category (tag) are two independent dimensions: a category only says "what this asset is for",
 * and a folder says "where it is kept". The key takes three kinds of values -
 *   - `mainline`: the fixed home of assets synced from the mainline, which accepts no uploads;
 *   - category key (other/character/...): the same-named system folder; old items without a folder field
 *     fall in by category, so no data migration is needed;
 *   - others: the id of a user-created folder (randomly generated by the backend, will not collide with the above).
 * Corresponds to RESERVED_FOLDER_KEYS / _resolve_library_folder in the backend video_node.py.
 */
export type AssetFolderKey = string;

export const MAINLINE_FOLDER_KEY = 'mainline';
/** Unclassified local uploads land in the "Other" category, and the folder gets a plainer name. */
export const UNSORTED_FOLDER_LABEL_KEY = 'canvas.assetLibrary.uncategorized';
/** Consistent with the backend FOLDER_NAME_MAX_LEN. */
export const FOLDER_NAME_MAX_LEN = 20;

const SYSTEM_FOLDER_LABEL_KEYS: Record<string, string> = {
  [MAINLINE_FOLDER_KEY]: 'canvas.assetLibrary.folder.mainline',
  ...Object.fromEntries(
    ASSET_CATEGORIES.map((category) => [
      category.key,
      category.key === 'other' ? UNSORTED_FOLDER_LABEL_KEY : category.labelKey,
    ]),
  ),
};

/** Entry key of the system folder display name; returns null when it is not a system key (the id of a user-created folder). */
export function systemFolderLabelKey(key: AssetFolderKey): string | null {
  return SYSTEM_FOLDER_LABEL_KEYS[key] ?? null;
}

/**
 * Names users cannot create (they would collide with system folders), consistent with the backend RESERVED_FOLDER_NAMES.
 * This is a protocol value aligned with the backend, not UI copy, so it is hard-coded and not made an entry.
 */
// i18n-exempt-start
export const RESERVED_FOLDER_NAMES = [
  'Mainline',
  'Unsorted assets',
  'Other',
  'Characters',
  'Scenes',
  'Props',
  'Style',
  'Sound effects',
];
// i18n-exempt-end

export interface AssetFolder {
  key: AssetFolderKey;
  label: string;
  items: LibraryItem[];
  /** System folders cannot be renamed/deleted/have their cover changed - they are derived from tags and have no physical record. */
  system: boolean;
  /** Whether it can serve as the save location of an upload. Mainline is a sync product and is read-only. */
  uploadable: boolean;
  /** Cover image URL set by the user; when never set, fall back to the first image in the folder, and draw an icon if there is none. */
  cover?: string | null;
  /** Folder creation time (ISO). System folders are derived from tags and do not have this field. */
  createdAt?: string | null;
}

/** Folder creation date, down to the day only: enough on the card, and it also avoids time zones showing the time of day skewed. */
export function formatFolderDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Folder cover: the user-specified one first, otherwise use the first image in the folder (audio has no usable picture). */
export function folderCoverUrl(folder: AssetFolder): string | null {
  if (folder.cover) return folder.cover;
  const firstImage = folder.items.find(
    (entry) => entry.media === 'image' && entry.url,
  );
  return firstImage?.url ?? null;
}

/** Old items have no folder field: mainline ones go to mainline, and local uploads go into the same-named system folder by category. */
export function deriveFolder(
  raw: unknown,
  source: FreezoneAssetLibrarySource,
  category: AssetCategory,
): AssetFolderKey {
  if (typeof raw === 'string' && raw) return raw;
  return source === 'upload' ? category : MAINLINE_FOLDER_KEY;
}

/**
 * Place items into folders. [Mainline] and [Unsorted assets] are always present - there must be somewhere clickable even when the library is empty;
 * other system folders appear only when they have content; user-created folders always appear (even freshly created and still empty, they must be visible).
 */
export function buildAssetFolders(
  items: LibraryItem[],
  t: TFn,
  customFolders: FreezoneAssetLibraryFolder[] = [],
): AssetFolder[] {
  const own = (key: AssetFolderKey) =>
    items.filter((entry) => entry.folder === key);
  const folders: AssetFolder[] = [
    {
      key: MAINLINE_FOLDER_KEY,
      label: t(SYSTEM_FOLDER_LABEL_KEYS[MAINLINE_FOLDER_KEY]),
      items: items.filter(
        (entry) =>
          entry.folder === MAINLINE_FOLDER_KEY || entry.source !== 'upload',
      ),
      system: true,
      uploadable: false,
    },
  ];
  for (const category of ASSET_CATEGORIES) {
    const owned = own(category.key);
    if (category.key !== 'other' && owned.length === 0) continue;
    folders.push({
      key: category.key,
      label: t(SYSTEM_FOLDER_LABEL_KEYS[category.key]),
      items: owned,
      system: true,
      uploadable: true,
    });
  }
  for (const folder of customFolders) {
    folders.push({
      key: folder.id,
      label: folder.name,
      items: own(folder.id),
      system: false,
      uploadable: true,
      cover: folder.cover ?? null,
      createdAt: folder.created_at ?? null,
    });
  }
  return folders;
}

function itemUrl(media: AssetLibraryMedia, it: Record<string, unknown>): string {
  if (media === 'video') return typeof it.video_url === 'string' ? it.video_url : '';
  if (media === 'audio') return typeof it.audio_url === 'string' ? it.audio_url : '';
  const urls = it.image_urls ?? it.imageUrls ?? it.images;
  if (Array.isArray(urls)) {
    const first = urls.find((u): u is string => typeof u === 'string');
    if (first) return first;
  }
  return typeof it.cover_url === 'string' ? it.cover_url : '';
}

export function normalizeLibraryList(payload: unknown): LibraryItem[] {
  let arr: unknown[] = [];
  if (Array.isArray(payload)) {
    arr = payload;
  } else if (payload && typeof payload === 'object') {
    const rec = payload as Record<string, unknown>;
    for (const key of ['items', 'data', 'characters', 'list', 'records']) {
      if (Array.isArray(rec[key])) {
        arr = rec[key] as unknown[];
        break;
      }
    }
  }
  return arr
    .filter(
      (it): it is Record<string, unknown> =>
        Boolean(it && typeof it === 'object' && !Array.isArray(it)),
    )
    .map((it) => {
      const idRaw = it.id ?? it.item_id ?? it.itemId ?? null;
      const id =
        typeof idRaw === 'string' ? idRaw : idRaw != null ? String(idRaw) : null;
      const name = typeof it.name === 'string' ? it.name : '';
      // Default to image for compatibility with old data (historical items have no media field).
      const mediaRaw = typeof it.media === 'string' ? it.media : 'image';
      const media: AssetLibraryMedia =
        mediaRaw === 'video' || mediaRaw === 'audio' ? mediaRaw : 'image';
      const sourceRaw = typeof it.source === 'string' ? it.source : 'upload';
      const source: FreezoneAssetLibrarySource =
        sourceRaw === 'character' ||
        sourceRaw === 'scene' ||
        sourceRaw === 'prop'
          ? sourceRaw
          : 'upload';
      const category = deriveCategory(it.category, source, media);
      return {
        id,
        name,
        media,
        source,
        category,
        folder: deriveFolder(it.folder, source, category),
        url: itemUrl(media, it),
        raw: it,
      };
    })
    .filter((it) => Boolean(it.url));
}

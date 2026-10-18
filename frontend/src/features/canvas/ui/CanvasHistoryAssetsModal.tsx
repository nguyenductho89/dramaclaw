// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ArrowDownUp,
  Box as BoxIcon,
  Check,
  Download,
  Loader2,
  Maximize2,
  Pause,
  Play,
  Plus,
  Search,
  Trash2,
  Volume2,
  X,
} from 'lucide-react';

import { useCanvasStore } from '@/stores/canvasStore';
import { confirmDialog } from '@/components/confirm-dialog-host';
import { downloadUrlAsFile } from '@/lib/browserDownload';
import {
  extractCanvasAssets,
  filterAssetBuckets,
  groupAssetsByDate,
  type CanvasAsset,
  type CanvasAssetBuckets,
  type CanvasAssetKind,
} from '@/features/canvas/domain/canvasAssets';
import { CANVAS_NODE_TYPES } from '@/features/canvas/domain/canvasNodes';
import { useCanvasGenerationHistory } from '@/features/canvas/hooks/useCanvasGenerationHistory';
import {
  historyRecordOutputUrl,
  historyRecordPreviewImageUrl,
  historyRecordPrompt,
  historyRecordStrictWorldUrl,
  historyRecordWorldUrl,
} from './NodeGenerationHistory';
import type { FreezoneGenerationHistoryRecord } from '@/api/ops';
import { resolveMediaUrl } from '@/lib/media-url';
import { readUrl } from '@/lib/url-params';
import {
  buildStandaloneWorldManifest,
  type DirectorStageManifest,
} from '@/features/viewer-kit/three-d/directorManifest';
import { ThreeDDirectorDialog } from '@/features/viewer-kit/three-d/ThreeDDirectorDialog';

import { ImageViewerModal } from './ImageViewerModal';
import { VideoViewerModal } from './VideoViewerModal';

// Node types that record backend generation history. Used only to scope the
// per-node fallback fan-out (see useCanvasGenerationHistory); the canvas-level
// aggregate endpoint ignores this list. Pure reference / annotation / layout
// nodes never have history, so we skip them.
const GENERATIVE_HISTORY_NODE_TYPES = new Set<string>([
  CANVAS_NODE_TYPES.imageGen,
  CANVAS_NODE_TYPES.imageEdit,
  CANVAS_NODE_TYPES.exportImage,
  CANVAS_NODE_TYPES.storyboardSplit,
  CANVAS_NODE_TYPES.storyboardGen,
  CANVAS_NODE_TYPES.video,
  CANVAS_NODE_TYPES.videoStory,
  CANVAS_NODE_TYPES.videoCompose,
  CANVAS_NODE_TYPES.audio,
  CANVAS_NODE_TYPES.script,
  CANVAS_NODE_TYPES.threeDWorld,
]);

/**
 * Map backend generation-history records into the asset-card shape the modal
 * already renders. Only completed records that carry a usable output url for an
 * image/video/audio surface; `recorded_at` drives date grouping (fixing the
 * old "Unknown date" bucketing that the live-canvas scrape produced). Deduped by
 * (kind,url) so a restored/duplicated output shows once. No per-tab display cap
 * — every record the backend returns (up to its own fetch limit) is shown, so
 * the history browser never silently hides older assets.
 */
/**
 * An optional "node meta" resolver: use a record's `node_id` to go back to the live canvas and take that (world) node's
 * fallback cover and name. A world record's `result` often has neither a preview image nor a prompt, but the `threeDWorld` node that generated it stores the **input source image**
 * in `previewImageUrl` and points to the upstream image node via `sourceNodeId` (whose displayName is e.g. "University dorm") - which is the most fitting cover/name.
 */
export interface HistoryNodeMeta {
  cover: string | null;
  name: string | null;
}

export function recordsToAssetBuckets(
  records: FreezoneGenerationHistoryRecord[],
  resolveNodeMeta?: (nodeId: string) => HistoryNodeMeta,
): CanvasAssetBuckets {
  const buckets: CanvasAssetBuckets = { image: [], video: [], audio: [], model: [] };
  const seen = new Set<string>();
  for (const record of records) {
    if (record.status !== 'completed' && record.status !== 'succeeded') continue;
    // World (3GS / 360 -> 3GS) record check: **look at the product structure first** (does result contain a real
    // .sog/.ply/3GS url), and only then fall back to media_type. The backend's media_type for image-to-3gs records
    // is unreliable (often `image` rather than `3d`), and trusting only media_type would miss the whole world history -
    // the node-side history strip has always sniffed product urls to judge worlds; this aligns with it.
    const worldUrl = historyRecordStrictWorldUrl(record);
    const isWorld =
      worldUrl !== null ||
      record.media_type === '3d' ||
      record.media_type === '3gs' ||
      record.media_type === 'ply';
    const kind: CanvasAssetKind | null = isWorld
      ? 'model'
      : record.media_type === 'image' ||
          record.media_type === 'video' ||
          record.media_type === 'audio'
        ? record.media_type
        : null;
    if (!kind) continue;
    // World model product urls may hide under keys like sog_url/scene_3gs_ply_fs, so use a dedicated extractor;
    // other types use the generic output url.
    const url = resolveMediaUrl(
      kind === 'model'
        ? (worldUrl ?? historyRecordWorldUrl(record))
        : historyRecordOutputUrl(record),
    );
    if (!url) continue;
    const dedupeKey = `${kind}:${url}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    const ts = new Date(record.recorded_at).getTime();
    // World records use the host node for fallback cover/name (see HistoryNodeMeta); other types have no fallback and keep
    // their own existing values.
    const nodeMeta =
      kind === 'model' ? resolveNodeMeta?.(record.node_id) : undefined;
    // Show only the prompt the backend stored on this record, so the prompt
    // always matches the video. Legacy records that never stored a prompt show
    // nothing (no node-prompt fallback — it misattributed the node's current
    // prompt to old versions). World records are an exception: with no prompt, fall back to the upstream source image node's name.
    const prompt = historyRecordPrompt(record);
    const label = prompt ?? nodeMeta?.name ?? null;
    buckets[kind].push({
      id: record.id,
      kind,
      url,
      previewUrl: resolveMediaUrl(
        historyRecordPreviewImageUrl(record) ?? nodeMeta?.cover ?? null,
      ),
      nodeId: record.node_id,
      label,
      // When "Use" creates a node, pour this record's original prompt into the new node's prompt box; label may fall back to the node name
      // for world records, so the prompt is stored separately here (only has a value when the backend stored a prompt).
      prompt: prompt ?? null,
      // The original generation's registry model id / generation mode, passed through to the "Use" restored node (undefined for old records).
      model: record.model,
      genMode: record.gen_mode,
      timestamp: Number.isNaN(ts) ? null : ts,
    });
  }
  return buckets;
}

const TAB_ORDER: CanvasAssetKind[] = ['image', 'video', 'audio', 'model'];
const TAB_LABEL_KEY: Record<CanvasAssetKind, string> = {
  image: 'canvas.history.tabs.image',
  video: 'canvas.history.tabs.video',
  audio: 'canvas.history.tabs.audio',
  model: 'canvas.history.tabs.world',
};

interface CanvasHistoryAssetsModalProps {
  onClose: () => void;
  /**
   * "Use": add this asset to the canvas as a new node (landing at the viewport center). For bulk use, placement is passed,
   * and the outer layer lays out the nodes as a grid near the viewport center.
   */
  onUseAsset: (asset: CanvasAsset, placement?: { index: number; total: number }) => void;
  /** "Delete" for live-canvas sources: remove the source node corresponding to the asset from the canvas. */
  onDeleteNode: (nodeId: string) => void;
  /** Show only the image tab (for the storyboard group's image-only picking scenario). */
  imageOnly?: boolean;
  /**
   * Asset source:
   * - `'generation-history'` (default): fetch the backend's "whole-canvas generation history" and group by recorded_at
   *   - the semantics the global "History assets" dialog wants (each generation product of a node).
   * - `'live-canvas'`: scrape the assets currently existing on all nodes on the canvas (including uploads/reference images). The storyboard group's image picking
   *   goes through this, since uploaded images that were never generated must be selectable.
   */
  assetSource?: 'generation-history' | 'live-canvas';
}

export function CanvasHistoryAssetsModal({
  onClose,
  onUseAsset,
  onDeleteNode,
  imageOnly = false,
  assetSource = 'generation-history',
}: CanvasHistoryAssetsModalProps) {
  const { t, i18n } = useTranslation();
  const nodes = useCanvasStore((state) => state.nodes);
  const useHistory = assetSource === 'generation-history';

  // Live-node ids feed the per-node fallback fan-out for backends that don't yet
  // expose the canvas-level aggregate endpoint. When the aggregate route is
  // present it ignores these and returns history for deleted nodes too.
  const fallbackNodeIds = useMemo(
    () =>
      nodes
        .filter((node) => GENERATIVE_HISTORY_NODE_TYPES.has(node.type))
        .map((node) => node.id),
    [nodes],
  );
  const { records, isLoading, removeRecord } = useCanvasGenerationHistory(fallbackNodeIds, {
    enabled: useHistory,
  });

  const [activeTab, setActiveTab] = useState<CanvasAssetKind>('image');
  const tabOrder = imageOnly ? (['image'] as CanvasAssetKind[]) : TAB_ORDER;
  const [direction, setDirection] = useState<'desc' | 'asc'>('desc');
  // Keyword search (issue #175). Two states: `query` is the input box display value (including pinyin still being composed under IME
  // and not yet committed), and `searchTerm` is what participates in filtering - it is not updated during composition, otherwise a user typing "kitten" in Chinese
  // would make every step x/xi/xia/xiao a real filter, with the grid repeatedly emptying and the count dropping to (0). The same scheme as the
  // AudioOperationsPanel input box: the draft updates as usual so the input follows the hand, and only downstream submission is blocked.
  const [query, setQuery] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const isComposingRef = useRef(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());

  // Image lightbox state (drives the shared ImageViewerModal nav list).
  const [imageViewerIndex, setImageViewerIndex] = useState<number | null>(null);
  const [videoViewerUrl, setVideoViewerUrl] = useState<string | null>(null);
  // World model "View": build a minimal manifest on the spot from the product url and open the Shrimp realm (director stage) directly.
  const [worldManifest, setWorldManifest] = useState<DirectorStageManifest | null>(null);
  // Full-prompt dialog (opened by clicking a card's compact prompt caption).
  const [promptDialogText, setPromptDialogText] = useState<string | null>(null);

  // World record fallback cover/name: use the record's node_id to go back to the live canvas, take that threeDWorld node's
  // previewImageUrl (= the input source image) as the cover, and the upstream source image node's displayName (e.g. "University dorm") as the name.
  const resolveNodeMeta = useMemo(() => {
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const trimmed = (value: unknown): string | null =>
      typeof value === 'string' && value.trim().length > 0 ? value : null;
    return (nodeId: string): HistoryNodeMeta => {
      const node = byId.get(nodeId);
      if (!node) return { cover: null, name: null };
      const data = node.data as Record<string, unknown>;
      const cover = trimmed(data.previewImageUrl);
      const sourceNodeId = trimmed(data.sourceNodeId);
      const sourceData = (sourceNodeId ? byId.get(sourceNodeId)?.data : undefined) as
        | Record<string, unknown>
        | undefined;
      const name =
        trimmed(sourceData?.displayName) ??
        trimmed(sourceData?.sourceFileName) ??
        trimmed(data.displayName);
      return { cover, name };
    };
  }, [nodes]);

  const buckets = useMemo(
    () =>
      useHistory
        ? recordsToAssetBuckets(records, resolveNodeMeta)
        : extractCanvasAssets(nodes),
    [useHistory, records, nodes, resolveNodeMeta],
  );
  const normalizedQuery = searchTerm.trim().toLowerCase();
  const filteredBuckets = useMemo(
    () => filterAssetBuckets(buckets, normalizedQuery),
    [buckets, normalizedQuery],
  );
  const activeAssets = filteredBuckets[activeTab];
  // When the current tab has no hit but other tabs do, the empty state must point the way - otherwise "No matching history assets" would contradict the count
  // "Video history (1)" plainly shown at the top.
  const otherTabsWithMatches = tabOrder.filter(
    (tab) => tab !== activeTab && filteredBuckets[tab].length > 0,
  );
  const groups = useMemo(
    () => groupAssetsByDate(activeAssets, direction),
    [activeAssets, direction],
  );
  const orderedImageUrls = useMemo(
    () => groups.flatMap((group) => group.assets).map((asset) => asset.url),
    [groups],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape during composition means "close the candidate window", yet the browser still bubbles the keydown to document -
      // if not intercepted here, the search box's guard (which deliberately does not stopPropagation while composing) would let a Chinese
      // user cancelling a candidate close the whole dialog. The same criterion as Canvas.tsx's global keyboard guard.
      if (event.isComposing) return;
      if (event.key === 'Escape') {
        // Inner overlays own Escape while open: prompt dialog first, then the
        // modal itself once viewers/prompt are all closed.
        if (promptDialogText !== null) {
          setPromptDialogText(null);
        } else if (imageViewerIndex === null && !videoViewerUrl && !worldManifest) {
          onClose();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onClose, imageViewerIndex, videoViewerUrl, worldManifest, promptDialogText]);

  useEffect(() => {
    // Reset selection when switching tab so counts can't leak across kinds.
    // Deliberately not cleared when the search term changes: `selectedAssets` is already taken from the filtered activeAssets,
    // and cards filtered out cannot enter any bulk operation, so clearing prevents nothing more; instead it would make a user who hand-picked dozens of cards
    // lose them all by typing one more character (and during a bulk download it would unmount the progress bar along with the spinner). Keeping the selection during
    // filtering and having it back after clearing the search is predictable.
    setSelectedIds(new Set());
  }, [activeTab]);

  const toggleSelect = (asset: CanvasAsset) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(asset.id)) {
        next.delete(asset.id);
      } else {
        next.add(asset.id);
      }
      return next;
    });
  };

  // View: enlarge images / videos. Audio does not go through here - it plays inline on the card (see AssetCard).
  const handleView = (asset: CanvasAsset) => {
    if (asset.kind === 'image') {
      const index = orderedImageUrls.indexOf(asset.url);
      setImageViewerIndex(index >= 0 ? index : 0);
    } else if (asset.kind === 'video') {
      setVideoViewerUrl(asset.url);
    } else if (asset.kind === 'model') {
      // Enter the Shrimp realm directly: history records only have the product url, with no node sources/scene edits, so temporarily build a
      // minimal scene-mode manifest to open the director stage (only for viewing a bare 3GS / 360 panorama).
      const project = readUrl().project;
      if (!project) return;
      const manifest = buildStandaloneWorldManifest({
        project,
        url: asset.url,
        displayName: asset.label ?? t('viewer.threeD.directorWorld'),
      });
      if (manifest) setWorldManifest(manifest);
    }
  };

  const handleUse = (asset: CanvasAsset) => {
    onUseAsset(asset);
    onClose();
  };

  const handleDelete = async (asset: CanvasAsset) => {
    if (!useHistory) {
      onDeleteNode(asset.nodeId);
      return;
    }
    const confirmed = await confirmDialog({
      title: t('canvas.history.deleteConfirmTitle'),
      description: t('canvas.history.deleteConfirmDescription'),
      confirmText: t('canvas.history.deleteConfirmAction'),
      cancelText: t('common.cancel'),
      confirmVariant: 'destructive',
    });
    if (!confirmed) return;
    setDeletingIds((current) => new Set(current).add(asset.id));
    try {
      const deleted = await removeRecord(asset.nodeId, asset.id);
      if (!deleted) toast.error(t('canvas.history.deleteFailed'));
    } finally {
      setDeletingIds((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
    }
  };

  // Bulk operations: the assets selected in the current tab (keeping display order). Switching tabs clears selectedIds,
  // so filtering within activeAssets is enough, with no cross-type mixing.
  const selectedAssets = useMemo(
    () => activeAssets.filter((asset) => selectedIds.has(asset.id)),
    [activeAssets, selectedIds],
  );
  const allSelected =
    activeAssets.length > 0 && selectedAssets.length === activeAssets.length;
  const [isDownloading, setIsDownloading] = useState(false);

  // Select all / deselect all only acts on the "currently visible (filtered)" assets, using the same criterion as allSelected
  // (selectedAssets); otherwise when search filters out selected items, the button would show "Select all" but execute clear. Selected items hidden
  // during filtering stay untouched.
  const handleToggleSelectAll = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      for (const asset of activeAssets) {
        if (allSelected) next.delete(asset.id);
        else next.add(asset.id);
      }
      return next;
    });
  };

  // Bulk download: trigger browser downloads one by one with a small gap between them, to avoid the browser treating concurrent downloads as popup abuse and blocking them.
  const handleBatchDownload = async () => {
    if (isDownloading || selectedAssets.length === 0) return;
    setIsDownloading(true);
    try {
      for (const asset of selectedAssets) {
        // Do not use the label as the file name: for images/videos the label is a whole prompt, which makes a poor file name;
        // it is better to let downloadUrlAsFile infer it from the url.
        await downloadUrlAsFile(asset.url);
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    } finally {
      setIsDownloading(false);
    }
  };

  // Bulk use: add the selected assets one by one as new nodes on the canvas (laid out as a grid), and close the dialog when done.
  const handleBatchUse = () => {
    if (selectedAssets.length === 0) return;
    selectedAssets.forEach((asset, index) => {
      onUseAsset(asset, { index, total: selectedAssets.length });
    });
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4">
      <div
        className="absolute inset-0 bg-black/55 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="canvas-history-assets-title"
        className="relative z-10 flex h-[min(780px,88vh)] w-[min(1200px,94vw)] flex-col overflow-hidden rounded-xl border border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.96)] shadow-[0_18px_48px_rgba(0,0,0,0.45)]"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-4 px-5 pb-3 pt-5">
          <h2
            id="canvas-history-assets-title"
            className="text-lg font-semibold leading-none text-foreground"
          >
            {t('canvas.history.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs + tools */}
        <div className="flex flex-wrap items-center justify-between gap-3 px-5 pb-3">
          <div className="flex items-center gap-1" role="tablist" aria-label={t('canvas.history.title')}>
            {tabOrder.map((tab) => {
              const active = tab === activeTab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => setActiveTab(tab)}
                  aria-pressed={active}
                  className={`rounded-full px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? 'bg-[rgb(var(--accent-rgb)/0.18)] text-[rgb(var(--accent-rgb))]'
                      : 'text-muted-foreground hover:bg-white/[0.06] hover:text-foreground'
                  }`}
                >
                  {t(TAB_LABEL_KEY[tab])}
                  <span className="ml-1 tabular-nums opacity-70">
                    {filteredBuckets[tab].length}
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {/* Keyword search: filters the history assets of all tabs (hit counts are reflected in each tab count).
            The placeholder has two variants - on the live-canvas picking path assets have no prompt (see the
            CanvasAsset.prompt note), only node names/file names are searchable, so it must not promise "search prompts".
            When the box has content, Escape first clears the input, and only otherwise lets the dialog take over closing. */}
            <div className="relative shrink-0">
              <Search
                className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
                aria-hidden
              />
              <input
                type="search"
                value={query}
                aria-label={t(
                  useHistory
                    ? 'canvas.history.searchPlaceholder'
                    : 'canvas.history.searchPlaceholderName',
                )}
                onChange={(event) => {
                  const next = event.target.value;
                  setQuery(next);
                  if (!isComposingRef.current) setSearchTerm(next);
                }}
                onCompositionStart={() => {
                  isComposingRef.current = true;
                }}
                onCompositionEnd={(event) => {
                  isComposingRef.current = false;
                  const next = event.currentTarget.value;
                  setQuery(next);
                  setSearchTerm(next);
                }}
                onKeyDown={(event) => {
                  // Escape during composition means "cancel the candidate", not "clear the search box" - without this check,
                  // pressing Esc to close the candidate window with a Chinese IME would wipe the whole query already typed.
                  if (event.key === 'Escape' && query && !event.nativeEvent.isComposing) {
                    event.stopPropagation();
                    setQuery('');
                    setSearchTerm('');
                  }
                }}
                placeholder={t(
                  useHistory
                    ? 'canvas.history.searchPlaceholder'
                    : 'canvas.history.searchPlaceholderName',
                )}
                className="h-8 w-52 rounded-sm border border-[var(--ui-border-soft)] bg-[rgba(var(--bg-rgb)/0.34)] pl-8 pr-7 text-xs text-foreground outline-none transition-[border-color,box-shadow] placeholder:text-muted-foreground focus:border-accent focus:shadow-[0_0_0_2px_rgba(var(--accent-rgb),0.12)] [&::-webkit-search-cancel-button]:appearance-none"
              />
              {query && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setSearchTerm('');
                  }}
                  aria-label={t('canvas.history.clearSearch')}
                  className="absolute right-2 top-1/2 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/10 hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
            <button
              type="button"
              onClick={() => setDirection((value) => (value === 'desc' ? 'asc' : 'desc'))}
              className="inline-flex h-8 items-center gap-1.5 rounded-full border border-[var(--ui-border-soft)] bg-[rgba(var(--bg-rgb)/0.34)] px-2.5 text-xs text-muted-foreground transition-colors hover:border-[var(--ui-border-strong)] hover:text-foreground"
            >
              <ArrowDownUp className="h-3.5 w-3.5" />
              {t(direction === 'desc' ? 'canvas.history.sortDesc' : 'canvas.history.sortAsc')}
            </button>
            {selectionMode && activeAssets.length > 0 && (
              <button
                type="button"
                onClick={handleToggleSelectAll}
                className="inline-flex h-8 items-center rounded-full px-2.5 text-xs text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                {t(allSelected ? 'canvas.history.deselectAll' : 'canvas.history.selectAll')}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setSelectionMode((value) => !value);
                setSelectedIds(new Set());
              }}
              className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors ${
                selectionMode
                  ? 'border-[rgb(var(--accent-rgb)/0.35)] bg-[rgb(var(--accent-rgb)/0.14)] text-[rgb(var(--accent-rgb))]'
                  : 'border-[var(--ui-border-soft)] bg-[rgba(var(--bg-rgb)/0.34)] text-muted-foreground hover:border-[var(--ui-border-strong)] hover:text-foreground'
              }`}
            >
              <Check className="h-3.5 w-3.5" />
              {selectionMode
                ? t('canvas.history.selectedCount', { n: selectedAssets.length })
                : t('canvas.history.batch')}
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="ui-scrollbar min-h-0 flex-1 overflow-y-auto px-5 pb-6">
          {/* The loading-state criterion uses the **unfiltered** bucket: when search has no hits and the background happens to be refetching (e.g. deleting a node triggers
          a re-fetch), using activeAssets would swap the already determined "no matches" for "loading", hinting that results
          might still appear. */}
          {useHistory && isLoading && buckets[activeTab].length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t('common.loading')}
            </div>
          ) : activeAssets.length === 0 ? (
            <div
              aria-live="polite"
              className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-muted-foreground"
            >
              <span>
                {!normalizedQuery
                  ? t('canvas.history.empty')
                  : otherTabsWithMatches.length > 0
                    ? t('canvas.history.noMatchOtherTabs', {
                        // The conjunction follows the UI language: a hard-coded enumeration comma would make the English UI show
                        // "try Images, Videos". Disjunction rather than conjunction -
                        // here we ask the user to pick another category to look at, not to say both should be viewed.
                        tabs: new Intl.ListFormat(i18n.resolvedLanguage ?? i18n.language, {
                          type: 'disjunction',
                        }).format(otherTabsWithMatches.map((tab) => t(TAB_LABEL_KEY[tab]))),
                      })
                    : t('canvas.history.noMatch')}
              </span>
              {normalizedQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setQuery('');
                    setSearchTerm('');
                  }}
                  className="inline-flex h-8 items-center rounded-full bg-white/[0.08] px-3 text-xs font-medium text-foreground transition-colors hover:bg-white/[0.12]"
                >
                  {t('canvas.history.clearSearch')}
                </button>
              )}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.date ?? 'undated'} className="mb-7">
                <div className="mb-3 text-xs font-medium text-muted-foreground">
                  {group.date ?? t('canvas.history.unknownDate')}
                </div>
                <div className="grid grid-cols-5 items-start gap-3">
                  {group.assets.map((asset) => (
                    <AssetCard
                      key={asset.id}
                      asset={asset}
                      selectionMode={selectionMode}
                      selected={selectedIds.has(asset.id)}
                      onToggleSelect={() => toggleSelect(asset)}
                      onView={() => handleView(asset)}
                      onUse={() => handleUse(asset)}
                      onDelete={() => void handleDelete(asset)}
                      deleting={deletingIds.has(asset.id)}
                      onOpenPrompt={
                        asset.prompt ? () => setPromptDialogText(asset.prompt!) : undefined
                      }
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Bulk action bar: floats up from the bottom when in selection mode and at least one item is selected. */}
        {selectionMode && selectedAssets.length > 0 && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-5">
            <div className="pointer-events-auto flex items-center gap-2 rounded-full border border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.96)] px-2.5 py-2 shadow-[var(--ui-shadow-panel)]">
              <span className="px-2 text-xs text-muted-foreground">
                {t('canvas.history.selectedCount', { n: selectedAssets.length })}
              </span>
              <span className="h-4 w-px bg-white/10" aria-hidden />
              <button
                type="button"
                onClick={handleBatchDownload}
                disabled={isDownloading}
                className="flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-foreground/85 transition-colors hover:bg-white/10 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isDownloading ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Download className="h-3.5 w-3.5" />
                )}
                {t(isDownloading ? 'canvas.history.downloading' : 'canvas.history.batchDownload')}
              </button>
              <button
                type="button"
                onClick={handleBatchUse}
                className="flex items-center gap-1.5 rounded-full bg-[rgb(var(--accent-rgb)/0.16)] px-3 py-1.5 text-xs font-medium text-[rgb(var(--accent-rgb))] transition-colors hover:bg-[rgb(var(--accent-rgb)/0.22)]"
              >
                <Plus className="h-3.5 w-3.5" />
                {t('canvas.history.batchUse')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Viewers */}
      <ImageViewerModal
        open={imageViewerIndex !== null}
        imageUrl={imageViewerIndex !== null ? (orderedImageUrls[imageViewerIndex] ?? '') : ''}
        imageList={orderedImageUrls}
        currentIndex={imageViewerIndex ?? 0}
        onClose={() => setImageViewerIndex(null)}
        onNavigate={(dir) =>
          setImageViewerIndex((index) => {
            if (index === null) {
              return index;
            }
            const next = dir === 'next' ? index + 1 : index - 1;
            if (next < 0 || next >= orderedImageUrls.length) {
              return index;
            }
            return next;
          })
        }
      />
      <VideoViewerModal
        open={Boolean(videoViewerUrl)}
        videoUrl={videoViewerUrl ?? ''}
        onClose={() => setVideoViewerUrl(null)}
      />

      {/* World model "View": enter the Shrimp realm (director stage) for read-only browsing. History products have no saveable source node,
      so the onSaveScene / onCapture* callbacks are not wired (view only). */}
      <ThreeDDirectorDialog
        open={Boolean(worldManifest)}
        onOpenChange={(open) => {
          if (!open) setWorldManifest(null);
        }}
        manifest={worldManifest}
        title={t('viewer.threeD.directorWorld')}
        viewerPurpose="freezone"
      />

      {/* Full prompt view: click the card's prompt summary to open it, shown in full with scrolling. */}
      {promptDialogText !== null && (
        <div className="fixed inset-0 z-[210] flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-sm"
            onClick={() => setPromptDialogText(null)}
            aria-hidden
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="canvas-history-prompt-title"
            className="relative z-10 flex max-h-[70vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-[var(--ui-border-soft)] bg-[rgba(var(--surface-rgb)/0.98)] shadow-[0_18px_48px_rgba(0,0,0,0.45)]"
          >
            <div className="flex items-center justify-between gap-4 px-5 pb-2 pt-4">
              <h3
                id="canvas-history-prompt-title"
                className="text-sm font-semibold text-foreground"
              >
                {t('canvas.history.promptTitle')}
              </h3>
              <button
                type="button"
                onClick={() => setPromptDialogText(null)}
                aria-label={t('common.close')}
                className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="ui-scrollbar overflow-y-auto whitespace-pre-wrap px-5 pb-4 pt-2 text-xs leading-relaxed text-foreground/85">
              {promptDialogText}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

interface AssetCardProps {
  asset: CanvasAsset;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onView: () => void;
  onUse: () => void;
  onDelete: () => void;
  deleting?: boolean;
  /** Click the compact prompt caption to open the full-prompt dialog. */
  onOpenPrompt?: () => void;
}

function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  const total = Math.floor(safe);
  const m = Math.floor(total / 60);
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function AssetCard({
  asset,
  selectionMode,
  selected,
  onToggleSelect,
  onView,
  onUse,
  onDelete,
  deleting = false,
  onOpenPrompt,
}: AssetCardProps) {
  const { t } = useTranslation();
  const isAudio = asset.kind === 'audio';
  // Audio: a lightweight custom player on the card (centered play/pause + bottom progress), playing in place,
  // with no separate modal and no ugly native <audio controls>.
  const audioRef = useRef<HTMLAudioElement>(null);
  const [audioPlaying, setAudioPlaying] = useState(false);
  const [audioTime, setAudioTime] = useState(0);
  const [audioDuration, setAudioDuration] = useState(0);

  // While playing, drive the progress bar smoothly with rAF.
  useEffect(() => {
    if (!audioPlaying) return;
    let raf = 0;
    const tick = () => {
      const el = audioRef.current;
      if (el) setAudioTime(el.currentTime);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [audioPlaying]);

  const toggleAudio = () => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) {
      void el.play().catch(() => undefined);
    } else {
      el.pause();
    }
  };

  const seekToClientX = (clientX: number, bar: HTMLElement) => {
    const el = audioRef.current;
    if (!el || !audioDuration) return;
    const rect = bar.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const next = ratio * audioDuration;
    el.currentTime = next;
    setAudioTime(next);
  };

  const progressPct =
    audioDuration > 0 ? Math.min(100, (audioTime / audioDuration) * 100) : 0;
  const showProgress = isAudio && !selectionMode && (audioPlaying || audioTime > 0);

  return (
    <div
      className={`group flex aspect-square w-full min-w-0 flex-col overflow-hidden rounded-md border bg-[rgba(var(--bg-rgb)/0.28)] transition-colors ${
        selected
          ? 'border-[rgb(var(--accent-rgb)/0.72)] ring-1 ring-[rgb(var(--accent-rgb)/0.35)]'
          : 'border-[var(--ui-border-soft)] hover:border-[var(--ui-border-strong)]'
      }`}
    >
      {/* Thumbnail fills the space left over by the prompt caption, so all cards
          stay the same total height and short prompts get a bigger video. */}
      <div
        style={{
          clipPath: 'inset(0 round var(--radius-md) var(--radius-md) 0 0)',
        }}
        className="relative isolate min-h-0 flex-1 overflow-hidden rounded-t-md"
      >
      {isAudio ? (
        <div className="relative flex h-full w-full items-center justify-center bg-[rgb(var(--accent-rgb)/0.1)]">
          <Volume2 className="h-7 w-7 text-[rgb(var(--accent-rgb)/0.48)]" />
          <audio
            ref={audioRef}
            src={asset.url}
            preload="none"
            onLoadedMetadata={(event) => {
              const d = event.currentTarget.duration;
              if (Number.isFinite(d) && d > 0) setAudioDuration(d);
            }}
            onPlay={() => setAudioPlaying(true)}
            onPause={() => setAudioPlaying(false)}
            onEnded={() => {
              setAudioPlaying(false);
              setAudioTime(0);
            }}
          />
        </div>
      ) : asset.kind === 'model' ? (
        // World models (3GS / 360 panorama): the product itself is not an image, so use the cover thumbnail; with no cover
        // draw a 3D box placeholder, avoiding rendering .sog as <img> and getting a broken image.
        asset.previewUrl ? (
          <img
            src={asset.previewUrl}
            alt={asset.label ?? ''}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center bg-[rgb(var(--accent-rgb)/0.1)]">
            <BoxIcon className="h-7 w-7 text-[rgb(var(--accent-rgb)/0.48)] transition-opacity duration-[var(--duration-fast)] group-focus-within:opacity-0 group-hover:opacity-0" />
          </div>
        )
      ) : asset.kind === 'video' && !asset.previewUrl ? (
        // Most video nodes have no stored cover frame (previewImageUrl is empty), and in the past only an empty play
        // placeholder icon was drawn. Here the <video> renders the video's own first frame as the cover: `#t=0.1` makes the browser
        // seek to 0.1s and paint that frame (t=0 is a black/unpainted frame in some browsers), preload=metadata
        // ensures only the first-frame metadata is fetched without downloading the whole clip. Muted + no controls, a purely static cover, with clicks left to
        // the card's hover mask.
        <video
          src={asset.url.includes('#') ? asset.url : `${asset.url}#t=0.1`}
          className="h-full w-full object-cover"
          muted
          playsInline
          preload="metadata"
          tabIndex={-1}
        />
      ) : (
        <img
          src={asset.previewUrl ?? asset.url}
          alt={asset.label ?? ''}
          loading="lazy"
          className="h-full w-full object-cover"
        />
      )}

      {selectionMode ? (
        <button
          type="button"
          onClick={onToggleSelect}
          aria-pressed={selected}
          className="absolute inset-0"
        >
          <span
            className={`absolute right-2 top-2 flex h-5 w-5 items-center justify-center rounded-full border ${
              selected
                ? 'border-[rgb(var(--accent-rgb))] bg-[rgb(var(--accent-rgb))] text-[#101217]'
                : 'border-white/60 bg-black/40'
            }`}
          >
            {selected && <Check className="h-3 w-3" />}
          </span>
        </button>
      ) : isAudio ? (
        // Audio card: top-left "Use", top-right "Delete" badges appear on hover; play/progress are left to the control layer below,
        // not using a whole-card hover mask to cover the play button.
        <>
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            aria-label={t('canvas.history.delete')}
            title={t('canvas.history.delete')}
            className="absolute right-2 top-2 z-30 flex h-7 w-7 items-center justify-center rounded-md bg-black/50 text-white/85 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-red-500/80 hover:text-white disabled:cursor-wait disabled:opacity-70"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
          <button
            type="button"
            onClick={onUse}
            className="absolute left-2 top-2 z-30 rounded-md bg-black/50 px-2 py-1 text-xs font-medium text-white/90 opacity-0 transition group-focus-within:opacity-100 group-hover:opacity-100 hover:bg-black/70 hover:text-white"
          >
            {t('canvas.history.use')}
          </button>
        </>
      ) : (
        // Image / video hover mask: lightly blurs complex thumbnails so the top-right delete and centered action stay reliably readable.
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 backdrop-blur-[10px] transition-opacity duration-[var(--duration-fast)] group-focus-within:opacity-100 group-hover:opacity-100">
          <button
            type="button"
            onClick={onDelete}
            disabled={deleting}
            aria-label={t('canvas.history.delete')}
            title={t('canvas.history.delete')}
            className="absolute right-2 top-2 flex h-7 w-7 items-center justify-center rounded-md bg-black/45 text-white/85 transition-colors hover:bg-red-500/80 hover:text-white disabled:cursor-wait disabled:opacity-70"
          >
            {deleting ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Trash2 className="h-3.5 w-3.5" />
            )}
          </button>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onView}
              className="rounded-full bg-white/[0.1] px-3 py-1.5 text-xs font-medium text-white/90 transition-colors hover:bg-white/[0.16] hover:text-white"
            >
              {t('canvas.history.view')}
            </button>
            <button
              type="button"
              onClick={onUse}
              className="rounded-full bg-[rgb(var(--accent-rgb)/0.22)] px-3 py-1.5 text-xs font-medium text-[rgb(var(--accent-rgb))] transition-colors hover:bg-[rgb(var(--accent-rgb)/0.3)]"
            >
              {t('canvas.history.use')}
            </button>
          </div>
        </div>
      )}

      {/* Audio custom controls: centered play/pause button + bottom progress bar (always clickable). */}
      {isAudio && !selectionMode && (
        <button
          type="button"
          onClick={toggleAudio}
          aria-label={audioPlaying ? t('canvas.history.pause') : t('canvas.history.play')}
          className="absolute left-1/2 top-1/2 z-20 flex h-11 w-11 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-white/92 text-[#0d0f14] shadow-lg ring-1 ring-black/10 transition hover:scale-105 hover:bg-white"
        >
          {audioPlaying ? (
            <Pause className="h-5 w-5" />
          ) : (
            <Play className="ml-0.5 h-5 w-5" />
          )}
        </button>
      )}
      {showProgress && (
        <div className="absolute inset-x-2 bottom-2 z-20 flex items-center gap-1.5">
          <div
            role="slider"
            aria-label={t('canvas.history.play')}
            aria-valuemin={0}
            aria-valuemax={Math.round(audioDuration)}
            aria-valuenow={Math.round(audioTime)}
            tabIndex={0}
            onClick={(event) => seekToClientX(event.clientX, event.currentTarget)}
            className="relative h-1.5 flex-1 cursor-pointer overflow-hidden rounded-full bg-white/25"
          >
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-[rgb(var(--accent-rgb))]"
              style={{ width: `${progressPct}%` }}
            />
          </div>
          <span className="text-[10px] font-medium tabular-nums text-white/75">
            {formatClock(audioTime)}
          </span>
        </div>
      )}
      </div>

      {/* Prompt: a fixed two-line summary keeps the grid rhythm consistent, click to open the full dialog; it does not expand on hover,
      to avoid a single card changing size and pushing surrounding content. In history assets it is still one card of "product + prompt".
      asset.prompt is used as the display condition (only generation history records have a value): the label of storyboard picking (live-canvas)
      is a file name rather than a prompt and prompt is empty, so a file name is not shown by mistake there. */}
      {(asset.kind === 'image' || asset.kind === 'video') &&
        !selectionMode &&
        asset.prompt && (
          <button
            type="button"
            onClick={onOpenPrompt}
            aria-label={t('canvas.history.viewFullPrompt')}
            title={t('canvas.history.viewFullPrompt')}
            className="group/prompt relative h-12 w-full flex-none select-none px-2.5 py-2 pr-8 text-left text-[12px] leading-4 text-white/68 transition-[background-color,color] hover:bg-white/[0.025] hover:text-white/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-[rgb(var(--accent-rgb)/0.55)]"
          >
            <span className="line-clamp-2">{asset.prompt}</span>
            <span
              aria-hidden
              className="absolute bottom-2 right-2 grid size-5 place-items-center rounded-md bg-white/[0.05] text-white/38 transition-[background-color,color] group-hover/prompt:bg-white/[0.1] group-hover/prompt:text-white/78"
            >
              <Maximize2 className="size-3" />
            </span>
          </button>
        )}

      {/* World model: the name is always shown below the thumbnail (falling back to the "Director world" default name when the prompt is missing),
      so a world card without a cover can at least be recognized. Double-click for the full text (when there is a prompt). */}
      {asset.kind === 'model' && !selectionMode && (
        <div
          title={asset.label ?? t('viewer.threeD.directorWorld')}
          onDoubleClick={asset.label ? onOpenPrompt : undefined}
          className="line-clamp-2 flex-none cursor-pointer select-none px-2.5 py-2 text-[12px] leading-snug text-white/75 transition-colors hover:text-white/90"
        >
          {asset.label ?? t('viewer.threeD.directorWorld')}
        </div>
      )}
    </div>
  );
}

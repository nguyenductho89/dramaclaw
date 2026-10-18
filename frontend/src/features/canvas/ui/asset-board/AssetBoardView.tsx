// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FocusEvent as ReactFocusEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { Check, ChevronDown, ImageIcon, Maximize2, Minimize2, Play } from 'lucide-react';

import {
  buildAssetBoard,
  // Alias: this file also imports the same-named column shell component ./AssetBoardColumn.
  type AssetBoardColumn as BoardColumnKind,
  type AssetBoardItem,
  type AssetBoardReference,
} from '@/features/canvas/domain/assetBoard';
import type {
  CanvasEdge,
  CanvasNode,
} from '@/features/canvas/domain/canvasNodes';
import { ImageViewerModal } from '@/features/canvas/ui/ImageViewerModal';
import { useCanvasStore } from '@/stores/canvasStore';
import { cn } from '@/lib/utils';

import { AssetBoardCard, VideoThumb } from './AssetBoardCard';
import { AssetBoardColumn } from './AssetBoardColumn';
import { AssetBoardColumns } from './AssetBoardColumns';
import { AssetBoardDetail } from './AssetBoardDetail';
import { KeyElementsBar } from './KeyElementsBar';

type VideoFilter = 'all' | 'final' | 'clip';

/** Image lightbox state (video no longer uses a dialog - it plays inline with <video controls> in the detail panel). */
type ViewerState = { urls: string[]; index: number } | null;

/** Master-detail stack entry: column decides which column the left narrow list switches to (audio enters the detail stack the same way as image/video). */
interface DetailEntry {
  column: 'text' | 'image' | 'video' | 'audio';
  nodeId: string;
}

interface AssetBoardViewProps {
  /** When false it stays mounted but invisible (the Shell hides it with visibility), and the data source is frozen at the same time. */
  visible: boolean;
  /** "Locate on canvas": the Shell switches back to the workflow and calls requestFocusNode. */
  onLocateNode: (nodeId: string) => void;
}

// Detail stack safety net: nodes that reference each other (A->B->A->B...) could in theory push forever; the 50-level cap
// is only a fallback and does not affect normal use - the normal path converges via the dedup truncation in openReference below.
const DETAIL_STACK_MAX = 50;

/** How long the "locate" highlight lasts in the expanded grid (same value as the card-side LOCATE_HIGHLIGHT_MS). */
const GRID_LOCATE_HIGHLIGHT_MS = 1200;

const VIDEO_FILTERS: ReadonlyArray<{ value: VideoFilter; label: string }> = [
  { value: 'all', get label() { return i18n.t('canvas.assetBoard.filter.all'); } },
  { value: 'final', get label() { return i18n.t('canvas.assetBoard.filter.final'); } },
  { value: 'clip', get label() { return i18n.t('canvas.assetBoard.filter.clip'); } },
];

// While frozen the item references are stable; memo lets re-renders outside the hidden -> visible switch skip the whole card subtree.
const MemoAssetBoardCard = memo(AssetBoardCard);

export function AssetBoardView({ visible, onLocateNode }: AssetBoardViewProps): ReactElement {
  // While hidden the selector always returns null (Object.is equal) -> canvas dragging / generation progress does not re-render the hidden storyboard.
  const liveNodes = useCanvasStore((state) => (visible ? state.nodes : null));
  const liveEdges = useCanvasStore((state) => (visible ? state.edges : null));
  // Write the ref during render (not in an effect): this is an intentional last-non-null cache, not a leftover
  // misuse of side effects. The comparison before writing is idempotent - the same render only converges dataRef.current to
  // a value consistent with liveNodes/liveEdges, and when StrictMode double-invokes, the second time the condition is already
  // false, so there is no repeated assignment or observable difference. If React Compiler is introduced in future, such
  // "derive from props, write own ref cache" patterns need a manual re-check that they are still safe; do not mechanically
  // apply auto-memoization rewrites.
  const dataRef = useRef<{ nodes: CanvasNode[]; edges: CanvasEdge[] }>({ nodes: [], edges: [] });
  if (liveNodes !== null && liveEdges !== null) {
    if (dataRef.current.nodes !== liveNodes || dataRef.current.edges !== liveEdges) {
      dataRef.current = { nodes: liveNodes, edges: liveEdges };
    }
  }
  const { nodes, edges } = dataRef.current;
  const board = useMemo(() => buildAssetBoard(nodes, edges), [nodes, edges]);

  const [videoFilter, setVideoFilter] = useState<VideoFilter>('all');
  // Expanded state: spread the image/video column into a wide grid on the right half (only key elements + the text column stay on the left),
  // and clicking the collapse button returns to three columns. When a detail is open it renders first; closing the detail returns to the expanded state.
  const [expandedColumn, setExpandedColumn] = useState<'image' | 'video' | null>(null);
  const [viewer, setViewer] = useState<ViewerState>(null);
  // Master-detail stack: click a card/audio chip = set [item]; reference jump in the detail = push; back = pop; close/Esc = clear.
  // Switching the view mode (visible flips) does not clear it - the storyboard's kept-alive semantics.
  const [detailStack, setDetailStack] = useState<DetailEntry[]>([]);
  // "Locate" scroll request: when "Locate" is clicked on a reference asset in the detail, set { nodeId, token }; the token increases monotonically
  // (even re-locating the same node changes the token, so the target card can scroll + highlight again). Passed to columns/cards,
  // only the card of the referenced node gets a non-null token, and the rest are always null (not breaking memo). This is locating within the storyboard
  // list (scrolling to the card position), a different thing from onLocateNode's "jump back to the canvas to focus".
  const [scrollRequest, setScrollRequest] = useState<{ nodeId: string; token: number } | null>(
    null,
  );

  const filteredVideos = useMemo(
    () => (videoFilter === 'all' ? board.video : board.video.filter((i) => i.videoRole === videoFilter)),
    [board.video, videoFilter],
  );

  // Key elements: all marked entries (non-empty keyElementCategory) across the four columns, collected across columns, for the top
  // key element bar to keep showing. Concatenated in column order (text/image/video/audio; within each column already newest-to-oldest by creation).
  const keyElements = useMemo(
    () =>
      [...board.text, ...board.image, ...board.video, ...board.audio].filter(
        (item) => item.keyElementCategory !== null,
      ),
    [board.text, board.image, board.video, board.audio],
  );

  // Paging list for the image lightbox: all image-column cards that have an image.
  const imageUrls = useMemo(
    () => board.image.map((i) => i.mediaUrl).filter((u): u is string => u !== null),
    [board.image],
  );

  // nodeId -> storyboard entry (the lookup table for the detail panel and cross-column reference jumps).
  const itemById = useMemo(() => {
    const map = new Map<string, AssetBoardItem>();
    for (const list of [board.text, board.image, board.video, board.audio]) {
      for (const item of list) map.set(item.nodeId, item);
    }
    return map;
  }, [board.text, board.image, board.video, board.audio]);

  // Click semantics: any card/audio chip (text/image/video/audio) -> open the detail panel. "Jump to canvas"
  // is kept only on the card's crosshair button and "Locate on canvas" inside the detail.
  const openItem = useCallback((item: AssetBoardItem) => {
    setDetailStack([{ column: item.column, nodeId: item.nodeId }]);
  }, []);

  // Clicking a reference thumbnail in the detail: if the referenced node has a storyboard detail to open -> push (the left column switches column automatically);
  // otherwise (the reference image has no matching canvas node detail, e.g. a type no longer on the board) degrade to a single-image lightbox.
  // Dedup semantics (breadcrumb): nodes referencing each other A->B->A->B... would make the stack grow unboundedly - if the target
  // (column, nodeId) already appeared in the stack, do not push again but truncate back to that level
  // (treated as "going back to a level already opened"), so the stack depth converges.
  // The 50-level cap is a defensive fallback, not reached normally.
  const openReference = useCallback(
    (ref: AssetBoardReference) => {
      // A built-in reference image (nodeId=null) has no matching canvas node detail -> degrade directly to a lightbox image view.
      const target = ref.nodeId ? itemById.get(ref.nodeId) : undefined;
      if (target && target.column !== 'audio') {
        // Extract a const: property narrowing does not carry into the setState callback closure.
        const column = target.column;
        const nodeId = target.nodeId;
        setDetailStack((stack) => {
          const existingIndex = stack.findIndex(
            (entry) => entry.column === column && entry.nodeId === nodeId,
          );
          if (existingIndex >= 0) {
            return stack.slice(0, existingIndex + 1);
          }
          const next = [...stack, { column, nodeId }];
          return next.length > DETAIL_STACK_MAX
            ? next.slice(next.length - DETAIL_STACK_MAX)
            : next;
        });
        return;
      }
      setViewer({ urls: [ref.thumbnailUrl], index: 0 });
    },
    [itemById],
  );

  // "Locate" on a reference asset in the detail: scroll the storyboard list to the referenced node's card and highlight it briefly (not canvas positioning).
  // - Same column (e.g. an image detail referencing an image, the left narrow list is the image column): keep the detail, scroll the narrow list to that card.
  // - Cross column (e.g. a video detail referencing an image): fall back to the three-column overview (clear the detail stack) and scroll to the card in the column of that node.
  // The token increases monotonically, so locating the same node twice in a row can re-trigger the target card's scroll + highlight.
  const locateInBoard = useCallback(
    (nodeId: string) => {
      const target = itemById.get(nodeId);
      if (!target) return; // Not in the storyboard (no matching card) -> nowhere to scroll, silently ignore.
      setDetailStack((stack) => {
        const active = stack.length > 0 ? stack[stack.length - 1] : null;
        return active && active.column === target.column ? stack : [];
      });
      setScrollRequest((prev) => ({ nodeId, token: (prev?.token ?? 0) + 1 }));
    },
    [itemById],
  );

  // Open the detail by (column, nodeId) (switch to the copy after the detail header's "Create copy" builds the node).
  // The column is given by the caller and itemById is not consulted: the copy was just written into the store in an event handler and has not
  // re-rendered yet, so itemById in the closure is still the previous frame's snapshot and cannot find it - a lookup would make "Create copy"
  // silently do nothing. The copy has the same type as the source node, so the column is necessarily the same; the caller just passes the column.
  const openNodeDetail = useCallback((nodeId: string, column: BoardColumnKind) => {
    setDetailStack([{ column, nodeId }]);
  }, []);

  const detailBack = useCallback(() => {
    setDetailStack((stack) => (stack.length > 1 ? stack.slice(0, -1) : []));
  }, []);
  const detailClose = useCallback(() => setDetailStack([]), []);

  const previewImage = useCallback(
    (url: string) => {
      const index = imageUrls.indexOf(url);
      // The reference image may not be in the image column (e.g. a node's built-in local reference image) -> single-image preview.
      setViewer(index >= 0 ? { urls: imageUrls, index } : { urls: [url], index: 0 });
    },
    [imageUrls],
  );

  const activeDetail = detailStack.length > 0 ? detailStack[detailStack.length - 1] : null;
  const activeItem = activeDetail ? (itemById.get(activeDetail.nodeId) ?? null) : null;
  const detailOpen = activeDetail !== null;
  const viewerOpen = viewer !== null;

  // The audio switcher always lives in the top bar's audio tab (matches liblib, consistent between overview and audio detail). When an audio detail
  // is open the node id is passed to the top bar -> it switches to the audio tab automatically and highlights that chip; the left column falls back to the switchable text
  // list (see the master-detail branch below), no longer mounting a separate audio bar.
  const activeAudioNodeId = activeDetail?.column === 'audio' ? activeDetail.nodeId : null;

  // Which column the left narrow list shows in detail state - decoupled from the right activeDetail: the header dropdown only changes this,
  // and the right detail panel always follows activeDetail. By default (and each time activeDetail switches to a new node) it returns to
  // the column of that node; after the user manually switches columns from the dropdown the choice is kept until activeDetail changes again.
  const [leftListColumn, setLeftListColumn] = useState<'text' | 'image' | 'video'>('image');
  // State derived synchronously during render (not an effect): whenever activeDetail switches to a new (column, node) - opening a card,
  // reference jump push, back pop - reset the left list to that column. A last-key ref guard ensures that "the user manually switching columns from the dropdown within the same
  // detail" is not overwritten by this sync (activeDetail unchanged -> key unchanged -> no reset).
  // React supports calling setState during render for state "derived from other state": it discards this render output in place
  // and immediately re-renders with the new value, committing no intermediate frame, so the old column never flashes (matching this file's dataRef
  // idempotent render-time write; under StrictMode double-invocation the second time the key already equals the ref, so no repeated set).
  const lastDetailKeyRef = useRef<string | null>(null);
  if (activeDetail !== null) {
    const detailKey = `${activeDetail.column}:${activeDetail.nodeId}`;
    if (detailKey !== lastDetailKeyRef.current) {
      lastDetailKeyRef.current = detailKey;
      // An audio detail has no matching left column (the audio switcher is in the top bar) -> default to the text column; others go to the column of the node.
      const target = activeDetail.column === 'audio' ? 'text' : activeDetail.column;
      if (leftListColumn !== target) {
        setLeftListColumn(target);
      }
    }
  } else {
    // Detail closed: clear the tracking so the next detail open must sync again.
    lastDetailKeyRef.current = null;
  }

  // Esc = close the detail. When the lightbox is open no listener is registered - the lightbox's own Esc closes the lightbox first,
  // avoiding two layers being closed by one key press (the ImageViewerModal listener is in its own implementation).
  useEffect(() => {
    if (!visible || !detailOpen || viewerOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      // Esc in native fullscreen (e.g. fullscreen playback of the detail video) means "exit fullscreen"; after the browser exits it
      // still dispatches keydown - the detail must not be closed along with it.
      if (document.fullscreenElement) return;
      if (event.key === 'Escape') setDetailStack([]);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [visible, detailOpen, viewerOpen]);

  // The lightbox stays mounted (controlled by an open boolean); when closed viewer becomes null, but the content props
  // must keep the last value during the 320-400ms fade-out, otherwise the image would be cleared
  // instantly along with viewer (following the always-mounted convention of CanvasHistoryAssetsModal / Canvas.tsx).
  // Write the ref during render: same as dataRef above, an idempotent latest non-null cache.
  const lastViewerRef = useRef<Exclude<ViewerState, null> | null>(null);
  if (viewer !== null) {
    lastViewerRef.current = viewer;
  }
  const displayViewer = viewer ?? lastViewerRef.current;

  // Key elements + audio merged into one bar, switched by tabs. In overview state it spans the top above the three columns; in detail state it is mounted into the left column
  // (position changes, instance does not, so switching details does not remount and lose the category filter / audio tab selection).
  // If both kinds are empty it renders nothing and takes no space.
  const keyElementsBar =
    keyElements.length > 0 || board.audio.length > 0 ? (
      <KeyElementsBar
        keyItems={keyElements}
        audioItems={board.audio}
        activeAudioNodeId={activeAudioNodeId}
        onOpen={openItem}
      />
    ) : null;

  // Column rendering shared by the three columns and the master-detail layout (in master-detail only the clicked column's narrow list + selection highlight is rendered).
  // Audio does not go through here - its switcher is in the top bar's audio tab (KeyElementsBar).
  // titleSlot: in detail state the left narrow list passes the "Text/Image/Video" switch dropdown to replace the default title (see the master-detail branch in return).
  const renderBoardColumn = (
    column: 'text' | 'image' | 'video',
    titleSlot?: ReactNode,
    // The "Expand" button only makes sense in the three-column overview: in detail state the right half is taken by the detail panel, and in expanded state the right half
    // is taken by the grid, so clicking it changes nothing in either layout (it would only plant the surprise of "suddenly
    // becoming expanded after closing the detail"). So the left narrow list / expanded-state left column never gets it.
    { expandable = false }: { expandable?: boolean } = {},
  ): ReactElement => {
    const selectedNodeId = activeDetail?.nodeId;
    switch (column) {
      case 'text':
        return (
          <BoardColumn
            title={i18n.t('canvas.assetBoard.column.text')}
            titleSlot={titleSlot}
            items={board.text}
            emptyText={i18n.t('canvas.assetBoard.empty.text')}
            onOpen={openItem}
            onLocate={onLocateNode}
            onPreviewImage={previewImage}
            onOpenReference={openReference}
            onLocateReference={locateInBoard}
            selectedNodeId={selectedNodeId}
            scrollRequest={scrollRequest}
            paused={!visible}
            // A text card is just one row of icon + title and is already a list of rows, so it needs no divider (user request);
            // dividers are only for columns like image/video where "one node is one big block of content".
          />
        );
      case 'image':
        return (
          <BoardColumn
            title={i18n.t('canvas.assetBoard.column.image')}
            titleSlot={titleSlot}
            items={board.image}
            emptyText={i18n.t('canvas.assetBoard.empty.image')}
            onOpen={openItem}
            onLocate={onLocateNode}
            onPreviewImage={previewImage}
            onOpenReference={openReference}
            onLocateReference={locateInBoard}
            selectedNodeId={selectedNodeId}
            scrollRequest={scrollRequest}
            paused={!visible}
            dividedItems
            headerExtra={
              expandable ? <ExpandColumnButton column="image" onToggle={setExpandedColumn} /> : undefined
            }
          />
        );
      case 'video':
        return (
          <BoardColumn
            title={i18n.t('canvas.assetBoard.column.video')}
            titleSlot={titleSlot}
            items={filteredVideos}
            emptyText={videoFilter === 'all' ? i18n.t('canvas.assetBoard.empty.video') : i18n.t('canvas.assetBoard.empty.videoNoMatch')}
            onOpen={openItem}
            onLocate={onLocateNode}
            onPreviewImage={previewImage}
            onOpenReference={openReference}
            onLocateReference={locateInBoard}
            selectedNodeId={selectedNodeId}
            scrollRequest={scrollRequest}
            paused={!visible}
            dividedItems
            headerExtra={
              <div className="flex items-center gap-1.5">
                {/* The three items side by side became a dropdown (user request, matches liblib): default "All", expand to see
                Final/Clips. The menu is right-aligned - the trigger is at the top-right of the column header, and left alignment would push it out of the column. */}
                <BoardSelect
                  value={videoFilter}
                  options={VIDEO_FILTERS}
                  onSelect={setVideoFilter}
                  menuLabel={i18n.t('canvas.assetBoard.filterVideos')}
                  menuClassName="right-0"
                  triggerClassName="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[12px] text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white"
                />
                {expandable && <ExpandColumnButton column="video" onToggle={setExpandedColumn} />}
              </div>
            }
          />
        );
    }
  };

  // The wide grid in expanded state: only thumbnail + title (badges/reference asset details are left for the narrow column and the detail),
  // so more assets can be scanned in one screen. Clicking a card still opens the detail as usual.
  const renderExpandedColumn = (column: 'image' | 'video'): ReactElement => {
    const items = column === 'image' ? board.image : filteredVideos;
    return (
      <AssetBoardColumn
        title={column === 'image' ? i18n.t('canvas.assetBoard.column.image') : i18n.t('canvas.assetBoard.column.video')}
        count={items.length}
        emptyText={
          column === 'image'
            ? i18n.t('canvas.assetBoard.empty.image')
            : videoFilter === 'all'
              ? i18n.t('canvas.assetBoard.empty.video')
              : i18n.t('canvas.assetBoard.empty.videoNoMatch')
        }
        headerExtra={
          <div className="flex items-center gap-1.5">
            {column === 'video' && (
              <BoardSelect
                value={videoFilter}
                options={VIDEO_FILTERS}
                onSelect={setVideoFilter}
                menuLabel={i18n.t('canvas.assetBoard.filterVideos')}
                menuClassName="right-0"
                triggerClassName="flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-0.5 text-[12px] text-white/80 transition-colors hover:bg-white/[0.08] hover:text-white"
              />
            )}
            <ExpandColumnButton column={column} expanded onToggle={setExpandedColumn} />
          </div>
        }
      >
        <div className="grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-x-4 gap-y-5 px-2 py-1">
          {items.map((item) => (
            <AssetBoardGridCard
              key={item.nodeId}
              item={item}
              onOpen={openItem}
              scrollTargetToken={
                scrollRequest && scrollRequest.nodeId === item.nodeId ? scrollRequest.token : null
              }
            />
          ))}
        </div>
      </AssetBoardColumn>
    );
  };

  return (
    <div
      aria-hidden={!visible}
      className={cn(
        // pt-12: leaves room for the view switch at the top center of the Shell (top-1.5, h-8 -> bottom edge 38px from the root top).
        // 48px keeps the content only ~10px from the switch (the original pt-16=64px left 26px of space, which the user found too far).
        // pb-0: the three-column panel sticks to the bottom with no gap to the task center status bar (matches liblib,
        // the column shell uses rounded-b-none square corners flush at the bottom, see AssetBoardColumn).
        // The root background keeps the semantic token bg-background: darker than the #262626 panel, so the three columns / audio bar
        // show a "floating" layering (panel color see AssetBoardColumn and the audio bar below).
        'absolute inset-0 z-30 flex flex-col gap-3 bg-background px-4 pt-12 pb-0',
        visible ? 'visible' : 'invisible',
      )}
    >
      {/* Three-column overview: the key element bar spans the very top (matches liblib "Key elements · All ▾ Audio").
      In detail/expanded state it is mounted into the left column instead, giving the whole right half to the detail panel or wide grid. */}
      {activeDetail === null && expandedColumn === null && keyElementsBar}

      {activeDetail !== null ? (
        // Master-detail layout: right = detail panel; left = key element bar + switchable narrow list (Text/Image/Video dropdown).
        // All four kinds of detail (text/image/video/audio) go through this one set: the audio switcher is merged into the key element bar's
        // audio tab, and the audio detail's left column defaults to the text column (leftListColumn sync see above).
        // Detail takes priority over expanded state - clicking a card in expanded state comes here, and closing the detail returns to the expanded grid.
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="flex w-[340px] shrink-0 flex-col gap-3">
            {/* In detail state the key element bar is indented into the left column (user request, matches liblib): the right half from top to bottom
            is the detail panel, and the height the media area can use also increases. */}
            {keyElementsBar}
            {renderBoardColumn(
              leftListColumn,
              <LeftColumnSwitcher current={leftListColumn} onSelect={setLeftListColumn} />,
            )}
          </div>
          <AssetBoardDetail
            visible={visible}
            nodeId={activeDetail.nodeId}
            item={activeItem}
            onBack={detailBack}
            onClose={detailClose}
            onOpenReference={openReference}
            onLocateReference={locateInBoard}
            onZoomImage={previewImage}
            onOpenNode={openNodeDetail}
          />
        </div>
      ) : expandedColumn !== null ? (
        // Expanded state: the left keeps only the key element bar + text column, and the whole right half goes to the expanded column (wide grid).
        <div className="flex min-h-0 flex-1 gap-3">
          <div className="flex w-[340px] shrink-0 flex-col gap-3">
            {keyElementsBar}
            {renderBoardColumn('text')}
          </div>
          {renderExpandedColumn(expandedColumn)}
        </div>
      ) : (
        // The three columns' widths are draggable: dragging the divider changes each column's share, and the result is saved on release (AssetBoardColumns).
        <AssetBoardColumns
          text={renderBoardColumn('text')}
          image={renderBoardColumn('image', undefined, { expandable: true })}
          video={renderBoardColumn('video', undefined, { expandable: true })}
        />
      )}

      <ImageViewerModal
        open={viewer !== null}
        imageUrl={displayViewer ? (displayViewer.urls[displayViewer.index] ?? displayViewer.urls[0] ?? '') : ''}
        imageList={displayViewer ? displayViewer.urls : []}
        currentIndex={displayViewer ? displayViewer.index : 0}
        onClose={() => setViewer(null)}
        onNavigate={(direction) =>
          setViewer((current) => {
            if (current === null) return current;
            const next = direction === 'next' ? current.index + 1 : current.index - 1;
            // Clamp at the boundaries rather than wrap around by modulo: consistent with ImageViewerModal's own behavior of
            // disabling the prev/next buttons at index 0/the end (matches CanvasHistoryAssetsModal).
            if (next < 0 || next >= current.urls.length) return current;
            return { ...current, index: next };
          })
        }
      />
    </div>
  );
}

interface BoardColumnProps {
  title: string;
  items: AssetBoardItem[];
  emptyText: string;
  headerExtra?: ReactNode;
  /** A custom node replacing the default title (in detail state the left narrow list passes the column switch dropdown, see LeftColumnSwitcher). */
  titleSlot?: ReactNode;
  onOpen: (item: AssetBoardItem) => void;
  onLocate: (nodeId: string) => void;
  onPreviewImage: (url: string) => void;
  /** Reference asset hover "Edit" -> open the detail of the referenced node. */
  onOpenReference: (ref: AssetBoardReference) => void;
  /** Reference asset hover "Locate" -> scroll to the referenced node's card and highlight it. */
  onLocateReference: (nodeId: string) => void;
  /** The nodeId of the current detail item in master-detail mode (selection highlight of the narrow list). */
  selectedNodeId?: string;
  /** "Locate" scroll request ({ nodeId, token }): the matching card scrolls into view and highlights briefly, other cards are always null. */
  scrollRequest?: { nodeId: string; token: number } | null;
  /** Add a very faint divider between entries (currently only used by the video column to match the liblib reference image). */
  dividedItems?: boolean;
  /** The storyboard as a whole is invisible (kept-alive hidden): cards stop the generation progress polling. */
  paused?: boolean;
}

// Internal thin wrapper: lays items into the column shell, avoiding repeated JSX across the three columns.
function BoardColumn({
  title,
  items,
  emptyText,
  headerExtra,
  titleSlot,
  onOpen,
  onLocate,
  onPreviewImage,
  onOpenReference,
  onLocateReference,
  selectedNodeId,
  scrollRequest,
  dividedItems,
  paused,
}: BoardColumnProps) {
  return (
    <AssetBoardColumn
      title={title}
      count={items.length}
      emptyText={emptyText}
      headerExtra={headerExtra}
      titleSlot={titleSlot}
      dividedItems={dividedItems}
    >
      {items.map((item) => (
        <MemoAssetBoardCard
          key={item.nodeId}
          item={item}
          onOpen={onOpen}
          onLocate={onLocate}
          onPreviewImage={onPreviewImage}
          onOpenReference={onOpenReference}
          onLocateReference={onLocateReference}
          selected={item.nodeId === selectedNodeId}
          paused={paused}
          // Only the located card gets a non-null token and the rest are always null (memo stable, not interrupted by each locate).
          scrollTargetToken={
            scrollRequest && scrollRequest.nodeId === item.nodeId ? scrollRequest.token : null
          }
        />
      ))}
    </AssetBoardColumn>
  );
}

type LeftColumn = 'text' | 'image' | 'video';

const LEFT_COLUMN_OPTIONS: ReadonlyArray<{ value: LeftColumn; label: string }> = [
  { value: 'text', get label() { return i18n.t('canvas.assetBoard.column.text'); } },
  { value: 'image', get label() { return i18n.t('canvas.assetBoard.column.image'); } },
  { value: 'video', get label() { return i18n.t('canvas.assetBoard.column.video'); } },
];

/**
 * The "Expand / Collapse" button at the top-right of the column header: spreads the image or video column into a wide grid on the right half, and clicking again returns to
 * three columns (matches liblib). In expanded state the left keeps only the key element bar and the text column.
 */
function ExpandColumnButton({
  column,
  expanded = false,
  onToggle,
}: {
  column: 'image' | 'video';
  expanded?: boolean;
  onToggle: (column: 'image' | 'video' | null) => void;
}): ReactElement {
  const label = expanded ? i18n.t('canvas.assetBoard.collapse') : i18n.t('canvas.assetBoard.expand');
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={expanded}
      onClick={() => onToggle(expanded ? null : column)}
      className="rounded-md p-1 text-white/45 transition-colors hover:bg-white/[0.06] hover:text-white"
    >
      {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
    </button>
  );
}

/**
 * A card in the expanded grid: thumbnail + title, click to open the detail. Deliberately leaner than AssetBoardCard -
 * the grid lays out a dozen or more per screen, and with badges/reference asset rows added there would be no "scan at a glance" effect.
 */
function AssetBoardGridCard({
  item,
  onOpen,
  scrollTargetToken = null,
}: {
  item: AssetBoardItem;
  onOpen: (item: AssetBoardItem) => void;
  /** "Locate" scroll token: same semantics as the card (non-null scrolls into view and highlights briefly). */
  scrollTargetToken?: number | null;
}): ReactElement {
  const cardRef = useRef<HTMLButtonElement | null>(null);
  const [locateHighlighted, setLocateHighlighted] = useState(false);
  // The same set as AssetBoardCard: token change -> scroll into view + flash; back to null -> clear the highlight.
  // The grid state must hook it too, otherwise "Locate" on a reference asset in the detail silently does nothing in expanded state.
  useEffect(() => {
    if (scrollTargetToken === null) {
      setLocateHighlighted(false);
      return;
    }
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setLocateHighlighted(true);
    const timer = setTimeout(() => setLocateHighlighted(false), GRID_LOCATE_HIGHLIGHT_MS);
    return () => clearTimeout(timer);
  }, [scrollTargetToken]);

  return (
    <button
      ref={cardRef}
      type="button"
      onClick={() => onOpen(item)}
      title={item.title}
      data-locate-highlight={locateHighlighted ? 'true' : undefined}
      // min-w-0: a title using truncate needs a shrinkable container, otherwise an overlong title (video titles are often a whole
      // prompt) with white-space:nowrap would push the grid item out of its track and cover adjacent cards.
      className={cn(
        'group flex min-w-0 flex-col gap-1.5 rounded-lg text-left',
        locateHighlighted && 'animate-pulse ring-2 ring-primary',
      )}
    >
      <span className="relative flex aspect-video items-center justify-center overflow-hidden rounded-lg bg-[#141414] ring-1 ring-inset ring-transparent transition-[box-shadow] group-hover:ring-white/20">
        {item.column === 'video' ? (
          // Video uses the same thumbnail logic as regular cards: without a cover take the first frame from <video>,
          // otherwise lots of videos with no recorded cover would be all black boxes in the grid.
          <VideoThumb item={item} />
        ) : item.thumbnailUrl ? (
          <img
            src={item.thumbnailUrl}
            alt=""
            loading="lazy"
            draggable={false}
            className="h-full w-full object-cover"
          />
        ) : (
          <ImageIcon className="h-6 w-6 text-muted-foreground" />
        )}
        {item.column === 'video' && item.videoRole === 'final' && (
          <span className="absolute left-1.5 top-1.5 inline-flex items-center gap-0.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-medium text-white/90 backdrop-blur-sm">
            {i18n.t('canvas.assetBoard.finalBadge')}
          </span>
        )}
        {item.column === 'video' && (item.thumbnailUrl || item.mediaUrl) && (
          <span className="absolute inset-0 flex items-center justify-center">
            <span className="flex h-9 w-9 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm">
              <Play className="h-4 w-4 fill-white text-white" />
            </span>
          </span>
        )}
      </span>
      <span className="w-full truncate text-[12px] text-white/60 transition-colors group-hover:text-white/90">
        {item.title}
      </span>
    </button>
  );
}

/**
 * A small selection dropdown in the storyboard (shared by the left narrow list's "Text/Image/Video" column switch and the video column's "All/Final/Clips"
 * filter): the trigger shows the current item + a chevron, click to expand the menu, with the current item checked (lucide Check).
 *
 * Interaction as required "click to expand (no hover needed)": click toggles open/close; clicking outside (focus leaving the wrapper)
 * or Esc collapses (matches the onBlur/Esc collapse convention of AssetBoardDetailToolbar / the reference asset menu).
 * Styles match this branch's system (panel rounded-lg, item hover bg-white/5); the trigger look is given by the caller,
 * because one of the two is a column title and the other a small filter pill at the top-right.
 */
function BoardSelect<T extends string>({
  value,
  options,
  onSelect,
  menuLabel,
  triggerClassName,
  menuClassName,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onSelect: (value: T) => void;
  /** Accessible name of the menu (screen readers and tests use it to locate this group). */
  menuLabel: string;
  triggerClassName: string;
  menuClassName?: string;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const currentLabel = options.find((option) => option.value === value)?.label ?? '';

  const handleBlur = useCallback((event: ReactFocusEvent<HTMLDivElement>) => {
    // Focus leaves the wrapper as a whole (the next focus is not inside) -> collapse (click outside / Tab away).
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
      setOpen(false);
    }
  }, []);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape' && open) {
        event.stopPropagation(); // Do not let Esc bubble up and close the whole detail panel.
        setOpen(false);
        triggerRef.current?.focus();
      }
    },
    [open],
  );

  return (
    <div className="relative" onBlur={handleBlur} onKeyDown={handleKeyDown}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        className={triggerClassName}
      >
        {currentLabel}
        <ChevronDown
          className={cn('h-3.5 w-3.5 text-white/40 transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && (
        <div
          role="menu"
          aria-label={menuLabel}
          className={cn(
            'absolute top-full z-50 mt-1.5 min-w-[140px] rounded-lg border border-white/10 bg-[#2e2e2e] p-1 text-white/85 shadow-xl',
            menuClassName ?? 'left-0',
          )}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={active}
                onClick={() => {
                  onSelect(option.value);
                  setOpen(false);
                  triggerRef.current?.focus();
                }}
                className={cn(
                  'flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[12px] transition-colors hover:bg-white/5 hover:text-white',
                  active ? 'text-white' : 'text-white/80',
                )}
              >
                <Check
                  className={cn('h-3.5 w-3.5 shrink-0', active ? 'opacity-100' : 'opacity-0')}
                />
                <span className="flex-1">{option.label}</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** The "Text/Image/Video" switch dropdown at the header of the left narrow list in detail state (switching columns only changes the left list, the right detail is unaffected). */
function LeftColumnSwitcher({
  current,
  onSelect,
}: {
  current: LeftColumn;
  onSelect: (column: LeftColumn) => void;
}): ReactElement {
  return (
    <BoardSelect
      value={current}
      options={LEFT_COLUMN_OPTIONS}
      onSelect={onSelect}
      menuLabel={i18n.t('canvas.assetBoard.switchColumn')}
      triggerClassName="-mx-1.5 flex items-center gap-1 rounded-md px-1.5 py-0.5 text-sm font-medium text-foreground transition-colors hover:bg-white/5"
    />
  );
}

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import { cn } from '@/lib/utils';

import {
  applyColumnResize,
  useAssetBoardColumnFractions,
  type ColumnFractions,
} from './useAssetBoardColumnFractions';

/** Minimum width of a single column: does not collapse when dragged to the end (matches liblib's column width lower bound). */
const MIN_COLUMN_PX = 200;

interface AssetBoardColumnsProps {
  /** The content of the three columns (text / image / video). The audio bar does not take part, rendered separately full width above. */
  text: ReactNode;
  image: ReactNode;
  video: ReactNode;
}

/** Drag session: snapshot the starting point at pointerdown, recompute from the event clientX on move/up, avoiding closures reading stale state. */
interface DragSession {
  handleIndex: 0 | 1;
  startX: number;
  startFractions: ColumnFractions;
  width: number;
}

/** jsdom / old browsers may lack pointer capture - call only if present, and swallow exceptions about the active state. */
function safeSetPointerCapture(el: Element, pointerId: number): void {
  if (typeof el.setPointerCapture !== 'function') return;
  try {
    el.setPointerCapture(pointerId);
  } catch {
    // Boundaries such as the pointer not being active can be ignored.
  }
}

function safeReleasePointerCapture(el: Element, pointerId: number): void {
  if (typeof el.releasePointerCapture !== 'function') return;
  try {
    el.releasePointerCapture(pointerId);
  } catch {
    // Same as above.
  }
}

/**
 * The three-column container in overview state: two draggable dividers between text / image / video, adjusting widths live and
 * persisting the ratios to localStorage (saved on release). Used only in overview state - this component unmounts as a whole when entering detail state,
 * remounts on the way back and restores the ratios from localStorage (so detail state is naturally unaffected by fractions).
 */
export function AssetBoardColumns({ text, image, video }: AssetBoardColumnsProps): ReactElement {
  const { fractions, setFractions, commitFractions } = useAssetBoardColumnFractions();
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragSession | null>(null);
  const [dragging, setDragging] = useState(false);

  // Disable text selection and unify the cursor while dragging, restored on release/unmount (the effect does not run anyway without document under SSR).
  useEffect(() => {
    if (!dragging) return;
    const { body } = document;
    const prevUserSelect = body.style.userSelect;
    const prevCursor = body.style.cursor;
    body.style.userSelect = 'none';
    body.style.cursor = 'col-resize';
    return () => {
      body.style.userSelect = prevUserSelect;
      body.style.cursor = prevCursor;
    };
  }, [dragging]);

  const handlePointerDown = useCallback(
    (handleIndex: 0 | 1) => (event: ReactPointerEvent<HTMLDivElement>) => {
      const container = containerRef.current;
      if (!container) return;
      const width = container.getBoundingClientRect().width;
      // SSR/not laid out/zero-width fallback: without a valid width do not enter dragging (the conversion would divide by 0).
      if (!(width > 0)) return;
      event.preventDefault();
      dragRef.current = { handleIndex, startX: event.clientX, startFractions: fractions, width };
      setDragging(true);
      safeSetPointerCapture(event.currentTarget, event.pointerId);
    },
    [fractions],
  );

  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const session = dragRef.current;
      if (!session) return;
      const next = applyColumnResize(
        session.startFractions,
        session.handleIndex,
        event.clientX - session.startX,
        session.width,
        MIN_COLUMN_PX,
      );
      setFractions(next);
    },
    [setFractions],
  );

  const endDrag = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const session = dragRef.current;
      if (!session) return;
      // Recompute the final ratios from the clientX of pointerup/cancel (= the position of the last move),
      // with no extra ref mirroring state, avoiding the stale closure caused by async setState.
      const next = applyColumnResize(
        session.startFractions,
        session.handleIndex,
        event.clientX - session.startX,
        session.width,
        MIN_COLUMN_PX,
      );
      dragRef.current = null;
      setDragging(false);
      safeReleasePointerCapture(event.currentTarget, event.pointerId);
      commitFractions(next); // Persist on release
    },
    [commitFractions],
  );

  const renderHandle = (handleIndex: 0 | 1): ReactElement => (
    <div
      role="separator"
      aria-orientation="vertical"
      aria-label={i18n.t('canvas.assetBoard.resizeColumns')}
      data-testid={`asset-board-resizer-${handleIndex}`}
      onPointerDown={handlePointerDown(handleIndex)}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      // A w-3 hit area (12px), with a w-1 thin bar inside for the visual; brighten on hover / while dragging, restrained to match the panel tokens.
      className="group relative flex w-3 shrink-0 cursor-col-resize touch-none items-stretch justify-center"
    >
      <div
        className={cn(
          'my-1 w-1 rounded-full transition-colors',
          dragging ? 'bg-white/10' : 'bg-white/5 group-hover:bg-white/10',
        )}
      />
    </div>
  );

  const columnStyle = (fraction: number) => ({
    flexGrow: fraction,
    flexBasis: 0,
    minWidth: MIN_COLUMN_PX,
  });

  return (
    <div
      ref={containerRef}
      data-testid="asset-board-columns"
      className={cn('flex min-h-0 flex-1', dragging && 'select-none')}
    >
      <div
        data-testid="asset-board-column-wrapper-text"
        className="flex min-h-0 min-w-0"
        style={columnStyle(fractions[0])}
      >
        {text}
      </div>
      {renderHandle(0)}
      <div
        data-testid="asset-board-column-wrapper-image"
        className="flex min-h-0 min-w-0"
        style={columnStyle(fractions[1])}
      >
        {image}
      </div>
      {renderHandle(1)}
      <div
        data-testid="asset-board-column-wrapper-video"
        className="flex min-h-0 min-w-0"
        style={columnStyle(fractions[2])}
      >
        {video}
      </div>
    </div>
  );
}

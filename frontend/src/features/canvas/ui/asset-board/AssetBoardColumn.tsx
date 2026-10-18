// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Children, Fragment, isValidElement, type ReactElement, type ReactNode } from 'react';

interface AssetBoardColumnProps {
  title: string;
  count: number;
  /** Extra controls on the right of the header (such as the video column's filter button group). */
  headerExtra?: ReactNode;
  /**
   * A custom node replacing the header's default title on the left (<h3>{title}+count>). The detail-state left narrow list uses it
   * to mount the "Text/Image/Video" switch dropdown; when not passed it falls back to the default title (three-column overview state, audio detail text column).
   */
  titleSlot?: ReactNode;
  emptyText: string;
  children: ReactNode;
  /** Add a very faint divider between entries (matches the video column of the liblib reference image). */
  dividedItems?: boolean;
}

/**
 * Insert real divider elements between entries.
 *
 * Deliberately not using Tailwind's `divide-y`: v4's divide rule is wrapped in `:where()` (specificity 0),
 * while the card itself carries `border border-transparent` (turning white only on hover) - the card's border-color
 * always wins, the divider color gets painted transparent, and the line is as good as undrawn. A divider as an independent element is unrelated to the card border.
 */
function withDividers(children: ReactNode): ReactNode {
  const items = Children.toArray(children);
  return items.map((child, index) => (
    // key takes the child node's own key (cards are keyed by nodeId), not the index: in-column order is by creation
    // newest to oldest, a newly built node is inserted at the very front, and using the index as key would shift the children at every Fragment position
    // out of alignment, and React would unmount and remount the whole column of cards one by one - the card's local state (image natural size cache,
    // locate highlight) all lost, and videos without a cover would fetch metadata again.
    <Fragment key={isValidElement(child) && child.key !== null ? child.key : index}>
      {index > 0 && (
        <div aria-hidden data-testid="asset-board-item-divider" className="h-px shrink-0 bg-white/10" />
      )}
      {child}
    </Fragment>
  ));
}

export function AssetBoardColumn({
  title,
  count,
  headerExtra,
  titleSlot,
  emptyText,
  children,
  dividedItems = false,
}: AssetBoardColumnProps): ReactElement {
  // rounded-b-none: the storyboard root container's pb-0 makes the column shell hug the bottom, with the bottom edge square and flush (matches liblib).
  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col rounded-lg rounded-b-none border border-white/5 bg-[#262626]">
      <header className="flex items-center justify-between gap-2 px-4 py-3">
        {titleSlot ?? (
          <h3 className="flex items-center gap-2 text-sm font-medium text-foreground">
            {title}
            <span className="text-[10px] font-normal text-white/30">{count}</span>
          </h3>
        )}
        {headerExtra}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {count === 0 ? (
          <p className="px-2 py-8 text-center text-[12px] text-muted-foreground">{emptyText}</p>
        ) : (
          <div className="flex flex-col gap-2">
            {dividedItems ? withDividers(children) : children}
          </div>
        )}
      </div>
    </section>
  );
}

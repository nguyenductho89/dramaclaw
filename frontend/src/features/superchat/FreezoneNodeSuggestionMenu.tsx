// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { FileText, Image as ImageIcon, Music, Play, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { AssetBoardColumn } from "@/features/canvas/domain/assetBoard";
import type { FreezoneNodeSuggestion } from "./freezone-node-suggestions";

// Keep consistent with the column icons of AssetBoardCard/AssetBoardDetail (video uses Play, not Film).
const COLUMN_ICON: Record<AssetBoardColumn, LucideIcon> = {
  text: FileText,
  image: ImageIcon,
  video: Play,
  audio: Music,
};

export type FreezoneNodeSuggestionMenuProps = {
  /** Full candidate list already filtered by the query (not truncated). */
  items: FreezoneNodeSuggestion[];
  /** Number of currently visible (rendered) items; the parent increases it on scroll / keyboard overflow. */
  visibleCount: number;
  activeIndex: number;
  onActiveIndexChange: (index: number) => void;
  onSelect: (nodeId: string, title: string) => void;
  /** Fires when scrolled to the bottom with more results remaining (the parent loads the next page). */
  onReachEnd: () => void;
};

export function FreezoneNodeSuggestionMenu({
  items,
  visibleCount,
  activeIndex,
  onActiveIndexChange,
  onSelect,
  onReachEnd,
}: FreezoneNodeSuggestionMenuProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const visible = items.slice(0, visibleCount);
  itemRefs.current.length = visible.length;

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  return (
    <div className="border-b border-white/10 bg-black/20 px-3 py-2.5">
      <div className="mb-1.5 px-0.5 text-xs text-muted-foreground/85">{t("superchat.panel.nodeMenu.title")}</div>
      {visible.length > 0 ? (
        <div
          className="max-h-64 overflow-y-auto pr-1"
          onScroll={(event) => {
            const el = event.currentTarget;
            if (
              visibleCount < items.length
              && el.scrollTop + el.clientHeight >= el.scrollHeight - 24
            ) {
              onReachEnd();
            }
          }}
        >
          {visible.map((node, index) => {
            const Icon = COLUMN_ICON[node.column];
            return (
              <button
                key={node.nodeId}
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                type="button"
                className={cn(
                  "flex h-9 w-full items-center gap-2 rounded-md px-1 text-left text-sm transition hover:bg-white/[0.06] focus-visible:bg-white/[0.06] focus-visible:outline-none",
                  activeIndex === index && "bg-white/[0.06]",
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                }}
                onMouseEnter={() => onActiveIndexChange(index)}
                onClick={() => onSelect(node.nodeId, node.title)}
              >
                {node.thumbnailUrl ? (
                  <img
                    src={node.thumbnailUrl}
                    alt=""
                    className="size-6 shrink-0 rounded object-cover"
                    loading="lazy"
                  />
                ) : (
                  <span className="flex size-6 shrink-0 items-center justify-center rounded bg-white/[0.06]">
                    <Icon className="size-3.5 text-muted-foreground/80" />
                  </span>
                )}
                <span className="truncate text-[13px] font-medium text-foreground/90">
                  {node.title}
                </span>
              </button>
            );
          })}
        </div>
      ) : (
        <div className="px-0.5 pb-1 pt-0.5 text-xs text-muted-foreground/65">{t("superchat.panel.nodeMenu.empty")}</div>
      )}
    </div>
  );
}

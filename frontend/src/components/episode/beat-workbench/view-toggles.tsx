// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import type { ViewToggleId } from "@/hooks/use-view-toggles";
import type { SelectionState } from "@/hooks/use-selection";

const TOGGLES: { id: ViewToggleId; labelKey: string }[] = [
  { id: "sketch", labelKey: "episode.beat.sectionSketch" },
  { id: "render", labelKey: "episode.beat.sectionRender" },
];

interface ViewTogglesProps {
  toggles: Set<ViewToggleId>;
  onToggle: (id: ViewToggleId) => void;
  selection: SelectionState;
  totalBeats: number;
  onClearSelection: () => void;
  onBatchRegenSketch: () => void;
  onBatchRegenRender: () => void;
  /** Multishot grouping state of the current multi-selection (dev-only
   * MiniMax H3 Multishot feature — see `multishot-review-dialog.tsx`):
   * "groupable" when 2+ CONSECUTIVE beats are selected and none already
   * belongs to a chain, "grouped" when every selected beat already shares
   * the same non-empty chain id, "none" otherwise (buttons hidden). */
  multishotState?: "none" | "groupable" | "grouped";
  onGroupMultishot?: () => void;
  onUngroupMultishot?: () => void;
  onReviewMultishot?: () => void;
  /** Opens the "Segment multishot" workbench dialog (AI planning +
   * Phase 1/2 batch workflow) — always visible, independent of the
   * current selection. See `segments-workbench-dialog.tsx`. */
  onOpenSegments?: () => void;
  legendSlot?: React.ReactNode;
}

export function ViewToggles({
  toggles,
  onToggle,
  selection,
  totalBeats,
  onClearSelection,
  onBatchRegenSketch,
  onBatchRegenRender,
  multishotState = "none",
  onGroupMultishot,
  onUngroupMultishot,
  onReviewMultishot,
  onOpenSegments,
  legendSlot,
}: ViewTogglesProps) {
  const { t } = useTranslation();
  const checkedCount = selection.mode === "multi" ? selection.checked.size : 0;
  const hasSelection = checkedCount > 0;

  return (
    <div className="flex shrink-0 flex-col">
      <div className="flex min-h-10 items-center gap-2 border-b border-white/[0.055] px-3 py-2">
        <div className="flex min-w-0 flex-wrap items-center gap-y-1.5">
          <div className="flex items-center gap-1.5">
            {TOGGLES.map(({ id, labelKey }) => {
              const active = toggles.has(id);
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onToggle(id)}
                  className={cn(
                    "inline-flex h-[22px] items-center gap-1.5 rounded-[5px] px-1.5 text-[11px] font-medium transition-colors",
                    active
                      ? "bg-white/[0.035] text-foreground"
                      : "text-muted-foreground hover:bg-foreground/[0.035] hover:text-foreground",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-3 items-center justify-center rounded-[3px] border transition-colors",
                      active
                        ? "border-primary/70 bg-primary/15 text-primary"
                        : "border-white/[0.09] bg-foreground/[0.025] text-transparent",
                    )}
                    aria-hidden
                >
                    <Check className="size-2" />
                  </span>
                  {t(labelKey)}
                </button>
              );
            })}
          </div>
          {onOpenSegments && (
            <button
              type="button"
              onClick={onOpenSegments}
              className="ml-2 inline-flex h-[22px] items-center rounded-[5px] border border-violet-400/35 bg-violet-400/[0.07] px-2 text-[11px] font-medium text-violet-300 transition-colors hover:border-violet-400/55 hover:bg-violet-400/[0.12] hover:text-violet-200"
            >
              {t("episode.workbench.segments.openButton", { defaultValue: "Segments" })}
            </button>
          )}
          {hasSelection ? (
            <div className="ml-5 flex items-center gap-2">
              <span className="tabular-nums text-[11px] text-foreground/70">
                {t("episode.workbench.view.selectedCount", { count: checkedCount })}
              </span>
              <button
                type="button"
                onClick={onBatchRegenSketch}
                className="inline-flex h-[22px] items-center rounded-[5px] border border-primary/35 bg-primary/[0.07] px-2 text-[11px] font-medium text-primary/90 transition-colors hover:border-primary/55 hover:bg-primary/[0.12] hover:text-primary"
              >
                {t("episode.workbench.view.batchRegenSketch")}
              </button>
              <button
                type="button"
                onClick={onBatchRegenRender}
                className="inline-flex h-[22px] items-center rounded-[5px] border border-primary/35 bg-primary/[0.07] px-2 text-[11px] font-medium text-primary/90 transition-colors hover:border-primary/55 hover:bg-primary/[0.12] hover:text-primary"
              >
                {t("episode.workbench.view.batchRegenRender")}
              </button>
              {multishotState === "groupable" && onGroupMultishot && (
                <button
                  type="button"
                  onClick={onGroupMultishot}
                  className="inline-flex h-[22px] items-center rounded-[5px] border border-violet-400/35 bg-violet-400/[0.07] px-2 text-[11px] font-medium text-violet-300 transition-colors hover:border-violet-400/55 hover:bg-violet-400/[0.12] hover:text-violet-200"
                >
                  {t("episode.workbench.view.groupMultishot")}
                </button>
              )}
              {multishotState === "grouped" && (
                <>
                  {onReviewMultishot && (
                    <button
                      type="button"
                      onClick={onReviewMultishot}
                      className="inline-flex h-[22px] items-center rounded-[5px] border border-violet-400/35 bg-violet-400/[0.07] px-2 text-[11px] font-medium text-violet-300 transition-colors hover:border-violet-400/55 hover:bg-violet-400/[0.12] hover:text-violet-200"
                    >
                      {t("episode.workbench.view.reviewMultishot")}
                    </button>
                  )}
                  {onUngroupMultishot && (
                    <button
                      type="button"
                      onClick={onUngroupMultishot}
                      className="inline-flex h-[22px] items-center rounded-[5px] border border-white/[0.09] bg-white/[0.015] px-2 text-[11px] font-medium text-muted-foreground/85 transition-colors hover:border-white/[0.16] hover:bg-white/[0.04] hover:text-foreground"
                    >
                      {t("episode.workbench.view.ungroupMultishot")}
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                onClick={onClearSelection}
                className="inline-flex h-[22px] items-center rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
              >
                {t("episode.workbench.view.clear")}
              </button>
            </div>
          ) : (
            <span className="ml-5 text-[11px] text-foreground/60">
              {t("episode.workbench.view.selectionHint")}
            </span>
          )}
        </div>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground/75">
          {t("episode.workbench.view.totalShots", { count: totalBeats })}
        </span>
      </div>
      {legendSlot}
    </div>
  );
}

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";
import { AlertTriangle, ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { VideoMultishotShot } from "@/features/canvas/domain/canvasNodes";

function generateMultishotShotId(): string {
  return `shot-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

export interface MultishotShotListEditorProps {
  shots: VideoMultishotShot[];
  /** Server-reported RUNPOD_H3_MULTISHOT_MAX_SHOTS; falls back to the graph's own structural bound (8) when the model info hasn't loaded yet. */
  maxShots?: number | null;
  minShots?: number;
  /** Seconds per shot (shared across the whole chain) — shown in the footer total, not editable here. */
  shotSeconds?: number;
  onChange: (shots: VideoMultishotShot[]) => void;
  disabled?: boolean;
}

/**
 * Ordered shot-list editor for a MiniMax H3 Multishot video node — each row
 * is one shot's raw, user-authored visual description (no per-shot image;
 * the chain takes a single start frame, see VideoNode.tsx's "multishot"
 * submit branch). New UI (no direct precedent in this codebase): reorder
 * uses simple up/down buttons rather than StoryboardGenNode's/
 * ReferenceMediaRow's HTML5 drag-and-drop, trading a little polish for
 * materially less new code in an already large feature.
 */
export function MultishotShotListEditor({
  shots,
  maxShots,
  minShots = 2,
  shotSeconds,
  onChange,
  disabled,
}: MultishotShotListEditorProps) {
  const { t } = useTranslation();
  const effectiveMax = typeof maxShots === "number" && maxShots > 0 ? maxShots : 8;
  const filledCount = shots.filter((shot) => shot.description.trim().length > 0).length;

  const updateShot = (id: string, patch: Partial<VideoMultishotShot>) => {
    onChange(
      shots.map((shot) =>
        shot.id === id
          ? {
              ...shot,
              ...patch,
              // Editing the description invalidates any prior review result
              // for this shot — the prompt/lint shown would otherwise be
              // stale relative to the new text.
              ...(patch.description !== undefined
                ? { finalPrompt: null, lint: undefined, fallbackUsed: undefined }
                : {}),
            }
          : shot,
      ),
    );
  };

  const removeShot = (id: string) => {
    if (shots.length <= minShots) return;
    onChange(shots.filter((shot) => shot.id !== id));
  };

  const addShot = () => {
    if (shots.length >= effectiveMax) return;
    onChange([...shots, { id: generateMultishotShotId(), description: "" }]);
  };

  const moveShot = (index: number, direction: -1 | 1) => {
    const target = index + direction;
    if (target < 0 || target >= shots.length) return;
    const next = [...shots];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  };

  return (
    <div className="nodrag nowheel flex flex-col gap-2">
      <div className="flex max-h-56 flex-col gap-2 overflow-y-auto pr-1">
        {shots.map((shot, index) => (
          <div
            key={shot.id}
            className="flex items-start gap-1.5 rounded-md border border-white/[0.075] bg-white/[0.02] p-1.5"
          >
            <div className="flex shrink-0 flex-col items-center gap-0.5 pt-1">
              <span className="text-[10px] font-medium text-muted-foreground">
                {index === 0
                  ? t("node.videoOps.multishot.startFrameLabel")
                  : t("node.videoOps.multishot.shotLabel", { n: index + 1 })}
              </span>
              <div className="flex gap-0.5">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled || index === 0}
                  onClick={() => moveShot(index, -1)}
                  title={t("node.videoOps.multishot.moveUp")}
                >
                  <ArrowUp className="size-3" />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-xs"
                  disabled={disabled || index === shots.length - 1}
                  onClick={() => moveShot(index, 1)}
                  title={t("node.videoOps.multishot.moveDown")}
                >
                  <ArrowDown className="size-3" />
                </Button>
              </div>
            </div>
            <Textarea
              value={shot.description}
              onChange={(event) => updateShot(shot.id, { description: event.target.value })}
              onKeyDown={(event) => event.stopPropagation()}
              placeholder={t("node.videoOps.multishot.emptyShot")}
              rows={2}
              disabled={disabled}
              className={cn(
                "nodrag min-h-0 flex-1 resize-none text-xs",
                shot.lint?.some((issue) => issue.severity === "error") &&
                  "border-destructive/50",
              )}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              disabled={disabled || shots.length <= minShots}
              onClick={() => removeShot(shot.id)}
              title={t("node.videoOps.multishot.removeShot")}
              className="mt-1 shrink-0"
            >
              <Trash2 className="size-3" />
            </Button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="xs"
          disabled={disabled || shots.length >= effectiveMax}
          onClick={addShot}
          title={
            shots.length >= effectiveMax
              ? t("node.videoOps.multishot.maxShotsReached", { max: effectiveMax })
              : undefined
          }
        >
          <Plus className="size-3" />
          {t("node.videoOps.multishot.addShot")}
        </Button>
        <span className="text-[10px] text-muted-foreground">
          {typeof shotSeconds === "number" && shotSeconds > 0
            ? t("node.videoOps.multishot.totalDuration", {
                count: filledCount,
                seconds: (filledCount * shotSeconds).toFixed(1),
              })
            : null}
        </span>
      </div>

      {filledCount < minShots && (
        <div className="flex items-center gap-1.5 text-[10px] text-amber-600 dark:text-amber-400">
          <AlertTriangle className="size-3 shrink-0" />
          {t("node.videoOps.multishot.minShots", { min: minShots })}
        </div>
      )}
    </div>
  );
}

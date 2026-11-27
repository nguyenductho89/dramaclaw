// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from "react-i18next";

import { cn } from "@/lib/utils";
import type { Beat } from "@/types/episode";

import { parseH3ShotConfig } from "./h3-shot-config";

interface H3BeatListProps {
  beats: Beat[];
  selected: number | null;
  onSelect: (beatNum: number) => void;
}

function Chip({ active, children }: { active: boolean; children: React.ReactNode }) {
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 py-0.5 text-[10px] leading-none",
        active
          ? "border-primary/40 bg-primary/10 text-foreground/85"
          : "border-border/60 text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

export function H3BeatList({ beats, selected, onSelect }: H3BeatListProps) {
  const { t } = useTranslation();
  return (
    <ul className="flex flex-col gap-1.5" aria-label={t("episode.h3Shots.listLabel")}>
      {beats.map((beat) => {
        const config = parseH3ShotConfig(beat.seedance2_config_json);
        const hasPrompt = config.assetsOnly && config.finalPrompt.trim().length > 0;
        return (
          <li key={beat.beat_number}>
            <button
              type="button"
              onClick={() => onSelect(beat.beat_number)}
              data-testid={`h3-beat-${beat.beat_number}`}
              className={cn(
                "flex w-full flex-col gap-1 rounded-lg border px-2.5 py-2 text-left transition-colors",
                selected === beat.beat_number
                  ? "border-primary/50 bg-primary/10"
                  : "border-border/50 hover:bg-muted/40",
              )}
            >
              <span className="text-xs font-medium">{`#${beat.beat_number}`}</span>
              <span className="line-clamp-2 text-[11px] text-muted-foreground">
                {beat.narration_segment || beat.visual_description}
              </span>
              <span className="flex flex-wrap gap-1">
                <Chip active={hasPrompt}>
                  {hasPrompt ? t("episode.h3Shots.promptReady") : t("episode.h3Shots.promptEmpty")}
                </Chip>
                <Chip active={Boolean(beat.video_url)}>{t("episode.h3Shots.videoReady")}</Chip>
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

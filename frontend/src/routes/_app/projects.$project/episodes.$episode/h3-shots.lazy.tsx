// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import { createLazyFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Layers, Loader2 } from "lucide-react";

import { EpisodeEmptyState } from "@/components/episode/episode-empty-state";
import { useHideHeaderOnScroll } from "@/components/episode/header-collapse";
import { H3BeatList } from "@/components/episode/h3-shots/h3-beat-list";
import { H3ShotPanel } from "@/components/episode/h3-shots/h3-shot-panel";
import { useEpisodeBeats } from "@/lib/queries/episodes";
import { useVideoBackends, type VideoBackendOption } from "@/lib/queries/video";
import type { Beat } from "@/types/episode";

interface H3ShotsWorkbenchProps {
  project: string;
  episode: number;
  beats: Beat[];
  beat: Beat;
  backends: VideoBackendOption[];
  onSelect: (beatNum: number) => void;
}

// A separate component because useHideHeaderOnScroll attaches its listeners once, on mount:
// the scroll root has to exist by then, so this mounts only after the data has loaded.
function H3ShotsWorkbench({ project, episode, beats, beat, backends, onSelect }: H3ShotsWorkbenchProps) {
  const scrollHideRef = useHideHeaderOnScroll<HTMLDivElement>();

  return (
    // The episode layout wraps this tab in a plain block, so the height comes from h-full.
    // From lg up each column scrolls on its own. Below lg the columns stack: the beat list
    // keeps a short scroll box and the app's <main> scrolls the page.
    <div ref={scrollHideRef} className="flex h-full min-h-0 flex-col gap-4 p-4 max-lg:h-auto lg:flex-row lg:overflow-hidden">
      <aside className="ui-scrollbar w-full shrink-0 overflow-y-auto max-lg:max-h-[45dvh] lg:w-64">
        <H3BeatList beats={beats} selected={beat.beat_number} onSelect={onSelect} />
      </aside>
      <main className="ui-scrollbar min-w-0 flex-1 lg:overflow-y-auto">
        <H3ShotPanel
          key={beat.beat_number}
          project={project}
          episode={episode}
          beat={beat}
          backends={backends}
        />
      </main>
    </div>
  );
}

export function H3ShotsTabContent() {
  const { t } = useTranslation();
  const { project, episode } = Route.useParams();
  const epNum = parseInt(episode, 10);
  const { data: beatsRes, isLoading } = useEpisodeBeats(project, epNum);
  const backendsRes = useVideoBackends(project);
  const beats = beatsRes?.data ?? [];
  const h3Backends = (backendsRes.data?.data ?? []).filter((b) => b.is_minimax_h3 === true);
  const [selected, setSelected] = useState<number | null>(null);

  useEffect(() => {
    if (selected === null || !beats.some((b) => b.beat_number === selected)) {
      setSelected(beats[0]?.beat_number ?? null);
    }
  }, [beats, selected]);

  if (isLoading || backendsRes.isLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (beats.length === 0) {
    return <EpisodeEmptyState icon={Layers} title={t("episode.h3Shots.noBeats")} />;
  }
  if (h3Backends.length === 0) {
    return (
      <EpisodeEmptyState
        icon={Layers}
        title={t("episode.h3Shots.noBackend")}
        description={t("episode.h3Shots.noBackendHint")}
      />
    );
  }
  const beat = beats.find((b) => b.beat_number === selected) ?? beats[0];

  return (
    <H3ShotsWorkbench
      project={project}
      episode={epNum}
      beats={beats}
      beat={beat}
      backends={h3Backends}
      onSelect={setSelected}
    />
  );
}

export const Route = createLazyFileRoute("/_app/projects/$project/episodes/$episode/h3-shots")({
  component: H3ShotsTabContent,
});

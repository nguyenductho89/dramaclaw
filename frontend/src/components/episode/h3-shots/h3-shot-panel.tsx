// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Eye, Loader2, Pencil, Play, Sparkles, Square, Upload, X } from "lucide-react";

import { LightboxImage } from "@/components/lightbox-image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useTaskController } from "@/hooks/use-task-controller";
import { backendErrorToastMessage } from "@/features/canvas/domain/backendErrors";
import { queryKeys } from "@/lib/query-keys";
import { useUpdateBeat } from "@/lib/queries/scripts";
import {
  useDeleteSeedance2Asset,
  useGenerateSeedance2Prompt,
  useRegenerateBeatVideo,
  useSeedance2BeatStatus,
  useUploadSeedance2Asset,
  type VideoBackendOption,
} from "@/lib/queries/video";
import { resolveMediaUrl } from "@/lib/media-url";
import { cn } from "@/lib/utils";
import type { Beat } from "@/types/episode";

import {
  clampH3Duration,
  H3_MAX_DURATION,
  H3_MIN_DURATION,
  H3_RATIO_OPTIONS,
  h3FallbackReason,
  parseH3ShotConfig,
  serializeH3ShotConfig,
  type H3ShotConfig,
} from "./h3-shot-config";
import { referenceNumber, tokenizeH3Prompt, usedImageNumbers } from "./h3-prompt-preview";

interface H3ShotPanelProps {
  project: string;
  episode: number;
  beat: Beat;
  backends: VideoBackendOption[];
}

export function H3ShotPanel({ project, episode, beat, backends }: H3ShotPanelProps) {
  const { t } = useTranslation();
  const beatNum = beat.beat_number;
  const updateBeat = useUpdateBeat(project, episode);
  const generatePrompt = useGenerateSeedance2Prompt(project, episode);
  const regenerate = useRegenerateBeatVideo(project, episode);
  const uploadAsset = useUploadSeedance2Asset(project, episode);
  const deleteAsset = useDeleteSeedance2Asset(project, episode);
  const status = useSeedance2BeatStatus(project, episode, beatNum, true, { assetsOnly: true });
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const videoTask = useTaskController({
    key: { taskType: "single_video", project, episode, beatNum },
    invalidateKeys: [queryKeys.beats(project, episode), queryKeys.videoPool(project, episode)],
  });

  const [backendValue, setBackendValue] = useState(backends[0]?.value ?? "");
  const backend = backends.find((b) => b.value === backendValue) ?? backends[0];
  const [config, setConfig] = useState<H3ShotConfig>(() =>
    parseH3ShotConfig(beat.seedance2_config_json),
  );
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState<"edit" | "preview">("edit");

  // Re-sync the draft when the stored config changes underneath us (prompt generated,
  // another tab saved) and there are no local edits to lose.
  useEffect(() => {
    if (!dirty) setConfig(parseH3ShotConfig(beat.seedance2_config_json));
  }, [beat.seedance2_config_json, dirty]);
  useEffect(() => {
    setDirty(false);
    setView("edit");
  }, [beatNum]);

  const statusData = status.data && status.data.ok ? status.data.data : null;
  const assetItems = useMemo(() => statusData?.assets.items ?? [], [statusData]);
  const imageByNumber = useMemo(() => {
    const map = new Map<number, (typeof assetItems)[number]>();
    for (const item of assetItems) {
      if (item.media_type === "image" && item.selected) {
        map.set(referenceNumber(item.reference_label), item);
      }
    }
    return map;
  }, [assetItems]);
  const audioByNumber = useMemo(() => {
    const map = new Map<number, (typeof assetItems)[number]>();
    for (const item of assetItems) {
      if (item.media_type === "audio" && item.selected) {
        map.set(referenceNumber(item.reference_label), item);
      }
    }
    return map;
  }, [assetItems]);
  const tokens = useMemo(() => tokenizeH3Prompt(config.finalPrompt), [config.finalPrompt]);
  const usedImages = useMemo(() => usedImageNumbers(tokens), [tokens]);
  const hasPrompt = config.finalPrompt.trim().length > 0;
  // The server reviews the saved prompt, so its verdict is hidden while there are unsaved edits.
  const promptIssues = dirty ? [] : (statusData?.prompt.issues ?? []);
  const fallbackReason = h3FallbackReason(config);

  const patch = (next: Partial<H3ShotConfig>) => {
    setConfig((current) => ({ ...current, ...next }));
    setDirty(true);
  };

  const save = async (next: H3ShotConfig = config): Promise<boolean> => {
    try {
      await updateBeat.mutateAsync({
        beatNum,
        data: { seedance2_config_json: serializeH3ShotConfig(next) },
      });
      setDirty(false);
      void status.refetch();
      return true;
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
      return false;
    }
  };

  const handleGeneratePrompt = async () => {
    if (!backend) return;
    try {
      const res = await generatePrompt.mutateAsync({
        beatNum,
        videoBackend: backend.value,
        promptGuidance: config.promptGuidance,
        assetsOnly: true,
      });
      if (!res.ok) {
        toast.error(res.error || t("episode.h3Shots.promptFailed"));
        return;
      }
      setDirty(false);
      setConfig(parseH3ShotConfig(res.data.seedance2_config_json));
      if (res.data.prompt_source === "fallback") toast.warning(t("episode.h3Shots.promptFallback"));
      void status.refetch();
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleGenerateVideo = async () => {
    if (!backend || !hasPrompt) return;
    const next = { ...config, duration: clampH3Duration(config.duration, minDuration, maxDuration) };
    if (!(await save(next))) return;
    try {
      const res = await regenerate.mutateAsync({
        beatNum,
        videoBackend: backend.value,
        duration: next.duration,
        ratio: next.ratio,
        mode: "multimodal_reference",
        seedance2ConfigJson: serializeH3ShotConfig(next),
      });
      if (res.ok === false) {
        toast.error(res.error || t("episode.h3Shots.videoFailed"));
        return;
      }
      videoTask.start();
      toast.success(t("episode.h3Shots.videoStarted", { n: beatNum }));
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const handleUpload = async (file: File | undefined) => {
    if (!file) return;
    try {
      await uploadAsset.mutateAsync({ beatNum, file });
      void status.refetch();
    } catch (err) {
      toast.error(backendErrorToastMessage(err, t));
    }
  };

  const minDuration = backend?.min_duration ?? H3_MIN_DURATION;
  const maxDuration = backend?.max_duration ?? H3_MAX_DURATION;
  const ratioOptions = backend?.ratio_options?.length ? backend.ratio_options : [...H3_RATIO_OPTIONS];
  const videoUrl = beat.video_url ? resolveMediaUrl(beat.video_url) : null;
  const generating = videoTask.started && videoTask.covers(beatNum);

  const renderToken = (token: ReturnType<typeof tokenizeH3Prompt>[number], index: number) => {
    if (token.kind === "text") return <span key={index}>{token.text}</span>;
    const asset = (token.media === "image" ? imageByNumber : audioByNumber).get(token.n);
    const url = asset?.url ? resolveMediaUrl(asset.url) : null;
    return (
      <span
        key={index}
        className={cn(
          "mx-0.5 inline-flex items-center gap-1 rounded-md border px-1 py-0.5 align-middle text-[11px]",
          asset ? "border-primary/40 bg-primary/10" : "border-destructive/50 bg-destructive/10",
        )}
        title={asset?.label ?? t("episode.h3Shots.unknownReference")}
      >
        {token.media === "image" && url ? (
          <LightboxImage src={url} alt={asset?.label ?? token.raw} className="size-8 shrink-0 rounded" />
        ) : null}
        {token.media === "audio" && url ? <audio src={url} controls className="h-6 w-32" /> : null}
        <span>{token.raw}</span>
      </span>
    );
  };

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <section className="space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-foreground/82">{t("episode.h3Shots.assets")}</h3>
          <div className="flex items-center gap-1.5">
            <input
              ref={uploadInputRef}
              type="file"
              accept="image/*,audio/*"
              className="hidden"
              onChange={(e) => {
                void handleUpload(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <Button
              size="sm"
              variant="outline"
              onClick={() => uploadInputRef.current?.click()}
              disabled={uploadAsset.isPending}
            >
              <Upload className="size-3.5" />
              {t("episode.h3Shots.upload")}
            </Button>
          </div>
        </div>
        <p className="text-[11px] text-muted-foreground">{t("episode.h3Shots.assetsHint")}</p>
        {status.isLoading ? (
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        ) : assetItems.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("episode.h3Shots.noAssets")}</p>
        ) : (
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(7rem,1fr))] gap-2">
            {assetItems.map((item) => {
              const number = referenceNumber(item.reference_label);
              const unused =
                item.media_type === "image" && hasPrompt && item.selected && !usedImages.includes(number);
              const url = item.url ? resolveMediaUrl(item.url) : null;
              return (
                <li
                  key={item.key}
                  className={cn(
                    "relative flex flex-col gap-1 rounded-lg border border-border/60 bg-card/40 p-1.5",
                    unused && "opacity-50",
                  )}
                  data-testid={`h3-asset-${item.key}`}
                >
                  {item.media_type === "image" && url && item.exists ? (
                    <LightboxImage src={url} alt={item.label} className="aspect-square w-full" fit="contain" />
                  ) : item.media_type === "audio" && url && item.exists ? (
                    <audio src={url} controls className="h-8 w-full" />
                  ) : (
                    <div className="flex aspect-square items-center justify-center rounded border border-dashed border-border/60 px-1 text-center text-[10px] text-muted-foreground">
                      {t("episode.h3Shots.missingAsset")}
                    </div>
                  )}
                  <div className="truncate text-[11px] text-foreground/80" title={item.label}>
                    {item.label}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {item.selected
                      ? item.media_type === "audio"
                        ? `<Audio ${number}>`
                        : `<Picture ${number}>`
                      : t("episode.h3Shots.notSent")}
                    {unused ? ` · ${t("episode.h3Shots.unused")}` : ""}
                  </div>
                  {item.key.startsWith("user_") ? (
                    <button
                      type="button"
                      className="absolute right-1 top-1 rounded-full bg-background/80 p-0.5 text-foreground/70 hover:text-foreground"
                      aria-label={t("episode.h3Shots.removeAsset")}
                      onClick={() =>
                        void deleteAsset
                          .mutateAsync({
                            beatNum,
                            mediaKind: item.media_type === "audio" ? "audios" : "images",
                            path: item.abs_path || item.path || "",
                          })
                          .then(() => status.refetch())
                      }
                    >
                      <X className="size-3" />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-xs font-medium text-foreground/82">{t("episode.h3Shots.prompt")}</h3>
          <div className="flex items-center gap-1.5">
            <Button
              size="sm"
              variant={view === "edit" ? "secondary" : "outline"}
              onClick={() => setView("edit")}
            >
              <Pencil className="size-3.5" />
              {t("episode.h3Shots.edit")}
            </Button>
            <Button
              size="sm"
              variant={view === "preview" ? "secondary" : "outline"}
              onClick={() => setView("preview")}
              disabled={!hasPrompt}
            >
              <Eye className="size-3.5" />
              {t("episode.h3Shots.preview")}
            </Button>
          </div>
        </div>
        <Label className="text-[11px] text-muted-foreground" htmlFor={`h3-guidance-${beatNum}`}>
          {t("episode.h3Shots.guidance")}
        </Label>
        <Textarea
          id={`h3-guidance-${beatNum}`}
          value={config.promptGuidance}
          rows={2}
          onChange={(e) => patch({ promptGuidance: e.target.value })}
          onBlur={() => dirty && void save()}
        />
        <Button
          size="sm"
          onClick={() => void handleGeneratePrompt()}
          disabled={!backend || generatePrompt.isPending}
        >
          {generatePrompt.isPending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Sparkles className="size-3.5" />
          )}
          {t("episode.h3Shots.generatePrompt")}
        </Button>

        {promptIssues.length > 0 ? (
          <div
            role="alert"
            className="space-y-1 rounded-lg border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive"
          >
            {promptIssues.map((issue) => (
              <p key={issue.code}>
                {t(`episode.h3Shots.issues.${issue.code}`, { refs: issue.refs.join(", ") })}
              </p>
            ))}
          </div>
        ) : null}
        {fallbackReason !== null ? (
          <p role="status" className="rounded-lg border border-border/60 bg-card/40 p-2 text-xs text-foreground/80">
            {t("episode.h3Shots.promptFallback")}
            {fallbackReason ? <span className="block text-muted-foreground">{fallbackReason}</span> : null}
          </p>
        ) : null}

        {view === "edit" ? (
          <Textarea
            aria-label={t("episode.h3Shots.prompt")}
            value={config.finalPrompt}
            rows={10}
            className="font-mono text-xs"
            onChange={(e) => patch({ finalPrompt: e.target.value })}
            onBlur={() => dirty && void save()}
          />
        ) : (
          <div className="space-y-2">
            {usedImages.length > 0 ? (
              <ul className="flex flex-wrap gap-2" data-testid="h3-used-images">
                {usedImages.map((n) => {
                  const asset = imageByNumber.get(n);
                  const url = asset?.url ? resolveMediaUrl(asset.url) : null;
                  return (
                    <li key={n} className="flex w-20 flex-col gap-0.5">
                      {url ? (
                        <LightboxImage src={url} alt={asset?.label ?? `Picture ${n}`} className="aspect-square w-full" fit="contain" />
                      ) : (
                        <div className="flex aspect-square items-center justify-center rounded border border-dashed border-destructive/50 text-[10px] text-destructive">
                          {t("episode.h3Shots.unknownReference")}
                        </div>
                      )}
                      <span className="truncate text-[10px] text-muted-foreground">{`<Picture ${n}>`}</span>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            <div
              className="whitespace-pre-wrap rounded-lg border border-border/60 bg-card/30 p-3 text-xs leading-6"
              data-testid="h3-prompt-preview"
            >
              {tokens.map(renderToken)}
            </div>
          </div>
        )}
      </section>

      <section className="flex flex-wrap items-end gap-3">
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">{t("episode.h3Shots.backend")}</Label>
          <Select value={backend?.value ?? ""} onValueChange={(v) => setBackendValue(String(v))}>
            <SelectTrigger className="h-8 w-48 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {backends.map((b) => (
                <SelectItem key={b.value} value={b.value}>
                  {b.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground" htmlFor={`h3-duration-${beatNum}`}>
            {t("episode.h3Shots.duration")}
          </Label>
          <Input
            id={`h3-duration-${beatNum}`}
            type="number"
            min={minDuration}
            max={maxDuration}
            value={config.duration}
            className="h-8 w-20 text-xs"
            onChange={(e) => patch({ duration: clampH3Duration(e.target.value, minDuration, maxDuration) })}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-[11px] text-muted-foreground">{t("episode.h3Shots.ratio")}</Label>
          <Select value={config.ratio} onValueChange={(v) => patch({ ratio: String(v) })}>
            <SelectTrigger className="h-8 w-24 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent alignItemWithTrigger={false}>
              {ratioOptions.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {generating ? (
          <Button size="sm" variant="outline" onClick={() => void videoTask.stop()} disabled={videoTask.stopping}>
            <Square className="size-3.5" />
            {t("episode.h3Shots.stop")}
          </Button>
        ) : (
          <Button
            size="sm"
            onClick={() => void handleGenerateVideo()}
            disabled={!backend || !hasPrompt || promptIssues.length > 0 || regenerate.isPending}
          >
            {regenerate.isPending ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Play className="size-3.5" />
            )}
            {t("episode.h3Shots.generateVideo")}
          </Button>
        )}
      </section>

      {videoUrl ? (
        <video
          key={videoUrl}
          src={videoUrl}
          controls
          className="max-h-96 w-full rounded-lg border border-border/60 bg-black"
        />
      ) : null}
    </div>
  );
}

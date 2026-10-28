// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Image as ImageIcon, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { resolveMediaUrl } from "@/lib/media-url";
import type {
  H3InputMode,
  SingleVideoRequestBody,
  VideoReviewData,
} from "@/lib/queries/video";

export const H3_MODES: H3InputMode[] = ["auto", "t2va", "fl2va", "flf2va", "ref2va"];

/** What the user picked for one beat: which H3 graph runs, whether the
 * rendered frame is pinned as `<Picture 1>`, and which reference images
 * (`identity:` / `prop:` / `scene:` keys) go in. Sent with every review,
 * rewrite and generate call so all three number `<Picture N>` identically. */
export interface H3Inputs {
  mode?: H3InputMode;
  firstFrame?: "render" | "none";
  keys?: string[];
}

export function h3InputsToBody(inputs: H3Inputs): Partial<SingleVideoRequestBody> {
  return {
    ...(inputs.mode ? { h3_mode: inputs.mode } : {}),
    ...(inputs.firstFrame ? { h3_first_frame: inputs.firstFrame } : {}),
    ...(inputs.keys ? { h3_reference_keys: inputs.keys } : {}),
  };
}

/**
 * Switching the rendered frame on/off also moves the scene reference: the
 * render already carries the location, so with it the scene image is left out;
 * without it the scene image is the only thing that tells H3 where the shot
 * is, so it must come in (and go back out when the render is re-enabled).
 */
export function withFirstFrame(
  inputs: H3Inputs,
  review: VideoReviewData,
  useRender: boolean,
): H3Inputs {
  const sceneKeys = (review.candidates ?? []).filter((c) => c.kind === "scene").map((c) => c.key);
  const keys = inputs.keys ?? [];
  return {
    ...inputs,
    firstFrame: useRender ? "render" : "none",
    keys: useRender
      ? keys.filter((k) => !sceneKeys.includes(k))
      : [...keys, ...sceneKeys.filter((k) => !keys.includes(k))],
  };
}

/** Initial inputs for a beat, taken from what its first review reports. */
export function h3InputsFromReview(review: VideoReviewData): H3Inputs {
  return {
    mode: (review.requested_mode as H3InputMode | undefined) || "auto",
    firstFrame: review.first_frame_used ? "render" : "none",
    keys: (review.candidates ?? []).filter((c) => c.selected).map((c) => c.key),
  };
}

/** References only enter the request in reference mode (or auto, which
 * resolves to it); fl2va / first+last / text-to-video ignore them. */
export function h3ReferencesUsed(mode: H3InputMode | undefined): boolean {
  return mode === undefined || mode === "auto" || mode === "ref2va";
}

/**
 * Mode selector + first-frame toggle + click-to-add/remove reference tiles.
 * Purely presentational: the owner decides what a change does (re-review,
 * rewrite the prompt, ...).
 */
export function H3InputPicker({
  review,
  inputs,
  onChange,
  className,
}: {
  review: VideoReviewData;
  inputs: H3Inputs;
  onChange: (next: H3Inputs) => void;
  className?: string;
}) {
  const { t } = useTranslation();
  const mode = inputs.mode ?? "auto";
  const referencesUsed = h3ReferencesUsed(inputs.mode);
  const tiles = review.candidates ?? [];

  const toggle = (key: string) => {
    const keys = inputs.keys ?? [];
    onChange({
      ...inputs,
      keys: keys.includes(key) ? keys.filter((k) => k !== key) : [...keys, key],
    });
  };

  return (
    <div className={cn("space-y-3", className)} data-testid="h3-input-picker">
      <div className="space-y-1.5" data-testid="h3-mode-selector">
        <span className="text-xs font-medium text-muted-foreground">
          {t("episode.workbench.videoReview.inputModeLabel")}
        </span>
        <div className="flex flex-wrap gap-1.5">
          {H3_MODES.map((m) => {
            const reason = m === "auto" ? null : (review.available_modes?.[m] ?? null);
            return (
              <Button
                key={m}
                type="button"
                size="xs"
                variant={mode === m ? "default" : "outline"}
                disabled={Boolean(reason)}
                title={
                  reason
                    ? t(`episode.workbench.videoReview.modeUnavailable.${reason}`, {
                        defaultValue: reason,
                      })
                    : t(`episode.workbench.videoReview.modeHint.${m}`)
                }
                onClick={() => onChange({ ...inputs, mode: m })}
              >
                {t(`episode.workbench.videoReview.modeName.${m}`)}
              </Button>
            );
          })}
        </div>
        {(mode === "ref2va" || mode === "auto") && (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={inputs.firstFrame !== "none" && Boolean(review.render_exists)}
              disabled={!review.render_exists || mode === "auto"}
              onChange={(e) => onChange(withFirstFrame(inputs, review, e.target.checked))}
            />
            {review.render_exists
              ? t("episode.workbench.videoReview.useRenderAsFirstFrame")
              : t("episode.workbench.videoReview.noRenderYet")}
          </label>
        )}
        {review.plan_error && (
          <div className="rounded-[6px] border border-destructive/35 bg-destructive/[0.08] px-2 py-1 text-xs text-destructive">
            {t(`episode.workbench.videoReview.modeUnavailable.${review.plan_error}`, {
              defaultValue: review.plan_error,
            })}
          </div>
        )}
      </div>

      <div className="space-y-1.5">
        <span className="text-xs font-medium text-muted-foreground">
          {t("episode.workbench.videoReview.referencesHeader")}
        </span>
        {tiles.length > 0 ? (
          <>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(6.5rem,6.5rem))] gap-2">
              {tiles.map((c) => {
                const src = c.path ? resolveMediaUrl(c.path) : null;
                const refTag = review.references.find((r) => r.key === c.key)?.tag;
                const on = c.selected && referencesUsed;
                return (
                  <button
                    type="button"
                    key={c.key}
                    data-testid={`h3-candidate-${c.key}`}
                    aria-pressed={c.selected}
                    disabled={!referencesUsed}
                    onClick={() => toggle(c.key)}
                    title={c.appearance_details || c.name}
                    className={cn(
                      "overflow-hidden rounded-[7px] border bg-white/[0.018] text-left transition",
                      on
                        ? "border-sky-500/60 ring-1 ring-sky-500/40"
                        : "border-white/[0.075] opacity-55",
                      !referencesUsed && "cursor-not-allowed",
                    )}
                  >
                    <div className="relative aspect-square w-full bg-white/[0.02]">
                      {src ? (
                        <img
                          src={src}
                          alt={c.name}
                          className="absolute inset-0 h-full w-full object-cover"
                        />
                      ) : (
                        <ImageIcon className="absolute inset-0 m-auto size-5 text-muted-foreground/60" />
                      )}
                      <span className="absolute right-1 top-1 flex size-4 items-center justify-center rounded-full bg-black/60 text-white">
                        {on ? <Check className="size-3" /> : <Plus className="size-3" />}
                      </span>
                    </div>
                    <div className="px-1.5 py-1">
                      <div className="truncate text-[10px] font-medium">
                        {refTag ? `${refTag} · ` : ""}
                        {c.name}
                      </div>
                      <div className="truncate text-[9px] text-muted-foreground">
                        {t(`episode.workbench.videoReview.kind.${c.kind}`, {
                          defaultValue: c.kind,
                        })}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {referencesUsed
                ? t("episode.workbench.videoReview.referencesToggleHint")
                : t("episode.workbench.videoReview.referencesUnusedHint")}
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            {t("episode.workbench.videoReview.referencesEmpty")}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * `useMutation` clears its `data` the moment `mutate` is called again, so a
 * picker driven straight from it would unmount (and lose scroll/focus) on
 * every click while the next dry run is in flight. This keeps showing the
 * last good review until the new one arrives; `resetKey` (the beat) drops it
 * so one beat's images never show under another.
 */
export function useStickyReview(
  review: VideoReviewData | null,
  resetKey: unknown,
): VideoReviewData | null {
  const [kept, setKept] = useState<{ key: unknown; review: VideoReviewData } | null>(null);
  useEffect(() => {
    if (review) setKept({ key: resetKey, review });
  }, [review, resetKey]);
  if (review) return review;
  return kept && kept.key === resetKey ? kept.review : null;
}

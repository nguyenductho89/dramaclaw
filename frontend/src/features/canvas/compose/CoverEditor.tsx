// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ImageUp, Loader2, X } from "lucide-react";

import { uploadFreezoneImage } from "@/api/ops";
import {
  mediaNeedsCrossOrigin,
  resolveImageDisplayUrl,
} from "@/features/canvas/application/imageData";
import {
  captureVideoFrame,
  coverFrameSourceAt,
  hasCoverableVideo,
  waitForVideoFrameReady,
} from "./coverCapture";
import type { ComposeCover, ComposeTimelineState } from "./timelineModel";

export interface CoverEditorProps {
  project: string;
  timeline: ComposeTimelineState;
  durationMs: number;
  /** The default position of the frame-picking slider when opened (usually the current playhead). */
  defaultFrameMs: number;
  /** An existing cover (used to echo the tab / slider position). */
  cover: ComposeCover | null;
  onCancel: () => void;
  /** Passes back the cover that has been uploaded and landed on confirm. */
  onApply: (cover: ComposeCover) => void;
}

type CoverTab = "frame" | "upload";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function formatTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

export function CoverEditor({
  project,
  timeline,
  durationMs,
  defaultFrameMs,
  cover,
  onCancel,
  onApply,
}: CoverEditorProps) {
  const { t } = useTranslation();
  const canPickFrame = useMemo(() => hasCoverableVideo(timeline), [timeline]);
  const [tab, setTab] = useState<CoverTab>(
    cover?.source === "upload" || !canPickFrame ? "upload" : "frame",
  );
  const [frameMs, setFrameMs] = useState(() =>
    clamp(cover?.frameMs ?? defaultFrameMs, 0, Math.max(0, durationMs)),
  );
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadPreview, setUploadPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Frame-picking preview: when the slider changes seek the preview <video> to the matching source frame. On a source swap, wait for metadata before seeking.
  // frameMs is clamped to durationMs - 1: the clip interval of activeClipAt is end-exclusive,
  // and without clamping when the slider is dragged to the very end, no frame source can be taken, and the preview/capture would land on an uncontrollable old frame.
  useEffect(() => {
    if (tab !== "frame") return;
    const el = videoRef.current;
    if (!el) return;
    const src = coverFrameSourceAt(
      timeline,
      clamp(frameMs, 0, Math.max(0, durationMs - 1)),
    );
    if (!src) return;
    const resolved = resolveImageDisplayUrl(src.sourceUrl);
    const seekTo = src.sourceMs / 1000;
    if (el.dataset.src !== resolved) {
      el.dataset.src = resolved;
      // Cross-origin CDN media must load with CORS, otherwise drawing this frame
      // to a canvas taints it and `captureVideoFrame` → toBlob throws a
      // SecurityError ("failed to capture the current frame"). Same-origin /static (dev proxy) skips it.
      if (mediaNeedsCrossOrigin(resolved)) {
        el.crossOrigin = "anonymous";
      } else {
        el.removeAttribute("crossorigin");
      }
      el.src = resolved;
      const onMeta = () => {
        try {
          el.currentTime = seekTo;
        } catch {
          /* ignore */
        }
      };
      el.addEventListener("loadedmetadata", onMeta, { once: true });
      try {
        el.load();
      } catch {
        /* ignore */
      }
      return () => el.removeEventListener("loadedmetadata", onMeta);
    }
    try {
      el.currentTime = seekTo;
    } catch {
      /* ignore */
    }
  }, [tab, frameMs, timeline, durationMs]);

  // Release the object URL of the upload preview.
  useEffect(
    () => () => {
      if (uploadPreview) URL.revokeObjectURL(uploadPreview);
    },
    [uploadPreview],
  );

  const onPickFile = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = ""; // Allow selecting the same file repeatedly
    if (!file) return;
    setUploadFile(file);
    setUploadPreview((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
    setError(null);
  }, []);

  const confirmDisabled =
    busy ||
    (tab === "upload" && !uploadFile) ||
    (tab === "frame" && !canPickFrame);

  const handleConfirm = useCallback(async () => {
    if (confirmDisabled) return;
    setBusy(true);
    setError(null);
    try {
      const name = `cover_${Date.now()}.jpg`;
      if (tab === "upload") {
        if (!uploadFile) return;
        const res = await uploadFreezoneImage(project, uploadFile, name);
        onApply({ source: "upload", frameMs: null, url: res.url });
      } else {
        const el = videoRef.current;
        // When the slider is dragged and OK is clicked right away the element may still be seeking - wait for the target frame to settle before capturing,
        // otherwise what gets captured is the previous decoded frame.
        if (el) await waitForVideoFrameReady(el);
        const blob = el ? await captureVideoFrame(el) : null;
        if (!blob) throw new Error(t("videoCompose.cover.captureFailed"));
        const res = await uploadFreezoneImage(project, blob, name);
        onApply({ source: "frame", frameMs, url: res.url });
      }
      // After success the parent closes the editor, and busy is not reset here (avoiding flicker).
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [confirmDisabled, frameMs, onApply, project, t, tab, uploadFile]);

  const tabClass = (active: boolean) =>
    `rounded-md px-3 py-1.5 text-sm transition-colors ${
      active
        ? "bg-white/12 text-text-dark"
        : "text-text-muted hover:bg-white/[0.06] hover:text-text-dark"
    }`;

  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[640px] max-w-[92vw] rounded-2xl border border-border-dark bg-surface-dark p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="text-sm font-semibold text-text-dark">
            {t("videoCompose.cover.title")}
          </h3>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="rounded-full p-1 text-text-muted transition-colors hover:bg-white/[0.08] hover:text-text-dark disabled:opacity-50"
            aria-label={t("common.close")}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Tabs */}
        <div className="mb-4 inline-flex gap-1 rounded-lg bg-bg-dark p-1">
          <button
            type="button"
            disabled={!canPickFrame}
            onClick={() => setTab("frame")}
            className={`${tabClass(tab === "frame")} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {t("videoCompose.cover.tabFrame")}
          </button>
          <button
            type="button"
            onClick={() => setTab("upload")}
            className={tabClass(tab === "upload")}
          >
            {t("videoCompose.cover.tabUpload")}
          </button>
        </div>

        {/* Preview (16:9) */}
        <div className="relative aspect-video w-full overflow-hidden rounded-lg bg-black">
          {tab === "frame" ? (
            <video
              ref={videoRef}
              className="h-full w-full object-contain"
              muted
              playsInline
              preload="metadata"
            />
          ) : uploadPreview ? (
            <img
              src={uploadPreview}
              alt=""
              className="h-full w-full object-contain"
            />
          ) : (
            <label className="flex h-full w-full cursor-pointer flex-col items-center justify-center gap-2 text-text-muted transition-colors hover:bg-white/[0.04]">
              <ImageUp className="h-7 w-7" />
              <span className="text-xs">{t("videoCompose.cover.uploadHint")}</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={onPickFile}
              />
            </label>
          )}
        </div>

        {/* Controls */}
        {tab === "frame" ? (
          <div className="mt-4 flex items-center gap-3">
            <input
              type="range"
              min={0}
              max={Math.max(0, durationMs)}
              step={1}
              value={frameMs}
              disabled={!canPickFrame}
              onChange={(e) => setFrameMs(Number(e.target.value))}
              className="h-1 flex-1 cursor-pointer accent-primary disabled:cursor-not-allowed disabled:opacity-40"
            />
            <span className="w-[88px] shrink-0 text-right font-mono text-xs tabular-nums text-text-muted">
              {formatTime(frameMs)} / {formatTime(durationMs)}
            </span>
          </div>
        ) : (
          uploadPreview && (
            <div className="mt-4">
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-md border border-border-dark px-3 py-1.5 text-xs text-text-dark transition-colors hover:bg-white/[0.06]">
                <ImageUp className="h-4 w-4" />
                {t("videoCompose.cover.reupload")}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={onPickFile}
                />
              </label>
            </div>
          )
        )}

        {error && (
          <div className="mt-3 rounded-md bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {t("videoCompose.cover.error")}: {error}
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={onCancel}
            className="rounded-md border border-border-dark px-4 py-1.5 text-sm text-text-dark transition-colors hover:bg-white/[0.06] disabled:opacity-50"
          >
            {t("common.cancel")}
          </button>
          <button
            type="button"
            disabled={confirmDisabled}
            onClick={() => void handleConfirm()}
            className="flex items-center gap-1.5 rounded-md bg-primary px-5 py-1.5 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-4 w-4 animate-spin" />}
            {busy ? t("videoCompose.cover.uploading") : t("common.confirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

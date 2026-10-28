// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Bottom floating bar for frame cropping: exit, aspect-ratio presets, live size, generate. Only handles display and callbacks; the crop-box state lives in VideoNode.
import { ArrowUp, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { CROP_RATIO_PRESETS, type CropRatioId } from "@/features/canvas/application/videoCrop/cropMath";
import { CANVAS_NODE_OPS_PANEL_CLASS } from "@/features/canvas/ui/nodeFrameStyles";

interface VideoCropPanelProps {
  ratioId: CropRatioId;
  /** Source pixel size rounded to even numbers; pass 0 when there is no box yet. */
  width: number;
  height: number;
  isSubmitting: boolean;
  canSubmit: boolean;
  onRatioChange: (ratioId: CropRatioId) => void;
  onCancel: () => void;
  onSubmit: () => void;
  /** Clicking X while submitting: aborts this crop request, not exiting crop mode; the box stays. */
  onAbort: () => void;
}

export function VideoCropPanel({
  ratioId,
  width,
  height,
  isSubmitting,
  canSubmit,
  onRatioChange,
  onCancel,
  onSubmit,
  onAbort,
}: VideoCropPanelProps) {
  const { t } = useTranslation();

  const ratioLabel = (id: CropRatioId) => {
    if (id === "free") return t("node.videoNode.crop.ratio.free");
    if (id === "original") return t("node.videoNode.crop.ratio.original");
    return id;
  };

  // While submitting, X changes meaning from "exit crop" to "cancel this submission", so it must stay
  // clickable and switch to different wording, so the user does not think the click did nothing.
  const closeLabel = isSubmitting ? t("node.videoNode.crop.abort") : t("node.videoNode.crop.cancel");

  return (
    <div
      className={`nodrag nopan nowheel flex items-center gap-2 rounded-[var(--node-radius)] ${CANVAS_NODE_OPS_PANEL_CLASS} p-2`}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        aria-label={closeLabel}
        title={closeLabel}
        onClick={isSubmitting ? onAbort : onCancel}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-text-dark/80 transition-colors hover:bg-white/[0.08] hover:text-white disabled:cursor-not-allowed disabled:opacity-55"
      >
        <X className="h-4 w-4" />
      </button>

      <div role="group" aria-label={t("node.videoNode.crop.ratioGroup")} className="flex items-center gap-1">
        {CROP_RATIO_PRESETS.map((id) => {
          const active = id === ratioId;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={active}
              disabled={isSubmitting}
              onClick={() => onRatioChange(id)}
              className={`h-7 shrink-0 whitespace-nowrap rounded-full px-2.5 text-[12px] font-medium tabular-nums transition-colors disabled:cursor-not-allowed disabled:opacity-55 ${
                active
                  ? "bg-white text-black"
                  : "text-text-dark/80 hover:bg-white/[0.08] hover:text-white"
              }`}
            >
              {ratioLabel(id)}
            </button>
          );
        })}
      </div>

      <span className="min-w-[88px] shrink-0 whitespace-nowrap text-center text-[12px] tabular-nums text-text-muted">
        {width > 0 && height > 0 ? `${width} × ${height}` : "—"}
      </span>

      <button
        type="button"
        aria-label={t("node.videoNode.crop.submit")}
        title={t("node.videoNode.crop.submit")}
        disabled={isSubmitting || !canSubmit}
        onClick={onSubmit}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-white text-black transition-colors hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/30 disabled:text-text-muted"
      >
        {isSubmitting ? (
          <Loader2 className="h-4 w-4 animate-spin" data-testid="video-crop-submitting" />
        ) : (
          <ArrowUp className="h-4 w-4" />
        )}
      </button>
    </div>
  );
}

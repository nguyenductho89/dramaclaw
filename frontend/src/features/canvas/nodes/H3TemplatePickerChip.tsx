import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LayoutTemplate, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { loadCommunityH3Templates } from "@/features/canvas/domain/communityH3Templates";
import {
  H3_PROMPT_TEMPLATES,
  H3_TEMPLATE_CATEGORIES,
  type H3PromptTemplate,
  type H3TemplateCategory,
  type H3TemplateSource,
  h3TemplateText,
} from "@/features/canvas/domain/h3PromptTemplates";
import {
  NODE_FLOATING_PANEL_SURFACE_CLASS,
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from "@/features/canvas/ui/nodeControlStyles";

const POPOVER_WIDTH = 720;
const POPOVER_MAX_HEIGHT = 560;
const POPOVER_GAP = 8;

interface H3TemplatePickerChipProps {
  /** Current prompt — applying over a non-empty prompt asks for confirmation. */
  prompt: string;
  /** Images already connected to the video node; new inputs would shift their `<Picture N>` numbers. */
  connectedImageCount: number;
  /** `run` also generates the picture inputs and then the video. */
  onApply: (template: H3PromptTemplate, options: { run: boolean }) => void | Promise<void>;
}

/**
 * Quick-start MiniMax-H3 (RunPod) prompt templates for the Freezone video
 * node, adapted from pixo.video's H3 prompt examples — see
 * `domain/h3PromptTemplates.ts`. Same portal/anchor pattern as the camera
 * movement chip so the popover sits above the react-flow toolbar.
 */
export function H3TemplatePickerChip({ prompt, connectedImageCount, onApply }: H3TemplatePickerChipProps) {
  const { t, i18n } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [isOpen, setIsOpen] = useState(false);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [source, setSource] = useState<H3TemplateSource>("fal");
  const [category, setCategory] = useState<H3TemplateCategory>("cinematic");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [community, setCommunity] = useState<readonly H3PromptTemplate[]>([]);

  // The community prompts are a large data file; fetch it only when its tab is opened.
  useEffect(() => {
    if (source !== "community" || community.length > 0) return;
    let alive = true;
    void loadCommunityH3Templates().then((items) => {
      if (alive) setCommunity(items);
    });
    return () => {
      alive = false;
    };
  }, [source, community.length]);

  const pool = useMemo(
    () => (source === "community" ? community : H3_PROMPT_TEMPLATES),
    [source, community],
  );
  const categories = useMemo(
    () =>
      H3_TEMPLATE_CATEGORIES.filter((key) =>
        pool.some((item) => item.source === source && item.category === key),
      ),
    [pool, source],
  );
  const activeCategory = categories.includes(category) ? category : (categories[0] ?? category);
  const visible = useMemo(
    () =>
      pool.filter((item) => item.source === source && item.category === activeCategory),
    [pool, source, activeCategory],
  );
  const selected =
    visible.find((item) => item.id === selectedId) ?? visible[0] ?? null;

  useEffect(() => {
    if (!isOpen) return;
    const updateAnchor = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const rect = trigger.getBoundingClientRect();
      const popHeight = Math.min(POPOVER_MAX_HEIGHT, rect.top - POPOVER_GAP - 8);
      const wantTop = rect.top - popHeight - POPOVER_GAP;
      const top = wantTop < 8 ? rect.bottom + POPOVER_GAP : wantTop;
      const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8));
      setAnchor({ left, top });
    };
    updateAnchor();
    window.addEventListener("resize", updateAnchor);
    window.addEventListener("scroll", updateAnchor, true);
    return () => {
      window.removeEventListener("resize", updateAnchor);
      window.removeEventListener("scroll", updateAnchor, true);
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen) return;
    const onPointerDown = (event: MouseEvent) => {
      if (
        triggerRef.current?.contains(event.target as Node) ||
        popoverRef.current?.contains(event.target as Node)
      ) {
        return;
      }
      setIsOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown, true);
    return () => document.removeEventListener("mousedown", onPointerDown, true);
  }, [isOpen]);

  const hasAudioInput = selected?.inputs.some((input) => input.label.startsWith("<Audio")) ?? false;
  // Community prompts have no image prompts to generate a first frame from.
  const needsOwnFirstFrame = selected?.source === "community";

  const handleApply = (run: boolean) => {
    if (!selected) return;
    if (prompt.trim() && !window.confirm(t("canvas.h3Templates.confirmReplace"))) return;
    if (connectedImageCount > 0 && !window.confirm(t("canvas.h3Templates.confirmConnected"))) return;
    void onApply(selected, { run });
    setIsOpen(false);
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          setIsOpen((prev) => !prev);
        }}
        className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} group/h3tpl px-1.5`}
        title={t("canvas.h3Templates.hint")}
      >
        <LayoutTemplate className={`${NODE_TEXT_CONTROL_ICON_CLASS} group-hover/h3tpl:text-text-dark`} />
        <span>{t("canvas.h3Templates.title")}</span>
      </button>
      {isOpen &&
        anchor &&
        createPortal(
          <div
            ref={popoverRef}
            className="fixed z-[10000]"
            style={{ left: anchor.left, top: anchor.top }}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={(event) => event.stopPropagation()}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div
              className={`nodrag nowheel flex flex-col ${NODE_FLOATING_PANEL_SURFACE_CLASS}`}
              style={{ width: POPOVER_WIDTH, maxWidth: "calc(100vw - 16px)", maxHeight: POPOVER_MAX_HEIGHT }}
            >
              <div className="flex h-10 shrink-0 items-center justify-between px-4">
                <span className="text-sm font-medium text-text-dark">{t("canvas.h3Templates.title")}</span>
                <button
                  type="button"
                  onClick={() => setIsOpen(false)}
                  className="flex size-6 items-center justify-center rounded-md text-text-muted/90 transition-colors hover:bg-white/[0.08] hover:text-text-dark"
                  aria-label={t("common.close")}
                >
                  <X className="size-3.5" />
                </button>
              </div>

              <div className="flex shrink-0 gap-1.5 px-4 pb-1.5">
                {(["fal", "pixo", "community"] as const).map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setSource(key);
                      setSelectedId(null);
                    }}
                    className={`h-7 rounded-md border px-2.5 text-[12px] transition-colors ${
                      key === source
                        ? "border-accent bg-[rgb(var(--accent-rgb)/0.14)] text-text-dark"
                        : "border-white/12 text-text-muted hover:bg-white/[0.08] hover:text-text-dark"
                    }`}
                  >
                    {t(`canvas.h3Templates.sources.${key}`)}
                  </button>
                ))}
              </div>

              <div className="flex shrink-0 flex-wrap gap-1.5 px-4 pb-2">
                {categories.map((key) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => {
                      setCategory(key);
                      setSelectedId(null);
                    }}
                    className={`h-7 rounded-md px-2.5 text-[12px] transition-colors ${
                      key === activeCategory
                        ? "bg-white/[0.14] text-text-dark"
                        : "text-text-muted hover:bg-white/[0.08] hover:text-text-dark"
                    }`}
                  >
                    {t(`canvas.h3Templates.categories.${key}`)}
                  </button>
                ))}
              </div>

              <div className="flex min-h-0 flex-1 gap-3 px-4 pb-2">
                <div className="ui-scrollbar flex w-[230px] shrink-0 flex-col gap-1.5 overflow-y-auto">
                  {source === "community" && community.length === 0 && (
                    <div className="px-1 text-[11px] text-text-muted">{t("canvas.h3Templates.loading")}</div>
                  )}
                  {visible.map((item) => {
                    const isSelected = selected?.id === item.id;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        onClick={() => setSelectedId(item.id)}
                        className={`rounded-[8px] border px-2.5 py-2 text-left transition-colors ${
                          isSelected
                            ? "border-accent bg-[rgb(var(--accent-rgb)/0.14)]"
                            : "border-white/12 bg-white/[0.04] hover:border-white/20 hover:bg-white/[0.08]"
                        }`}
                      >
                        <div className="text-[12px] font-medium text-text-dark">
                          {h3TemplateText(item.title, i18n.language)}
                        </div>
                        <div className="mt-0.5 text-[11px] leading-snug text-text-muted">
                          {h3TemplateText(item.description, i18n.language)}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {selected && (
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <div className="text-[11px] text-text-muted">
                      {selected.mode === "fl2va"
                        ? t("canvas.h3Templates.modeFirstFrame")
                        : selected.mode === "flf2va"
                          ? t("canvas.h3Templates.modeFirstLastFrame")
                          : t("canvas.h3Templates.modeReference")}
                      {" · "}
                      {selected.aspectRatio}
                      {" · "}
                      {t("canvas.h3Templates.seconds", { count: selected.durationSec })}
                    </div>
                    <div className="flex flex-col gap-0.5">
                      <div className="text-[11px] font-medium text-text-dark">
                        {t("canvas.h3Templates.inputs")}
                      </div>
                      {selected.inputs.map((input) => (
                        <div key={input.label} className="text-[11px] text-text-muted">
                          <span className="font-mono text-text-dark/90">{input.label}</span>
                          {" — "}
                          {h3TemplateText(input.role, i18n.language)}
                          {input.imagePrompt && (
                            <div className="mt-0.5 line-clamp-2 text-[10.5px] italic text-text-muted/80">
                              {input.imagePrompt}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    <pre className="ui-scrollbar min-h-0 flex-1 overflow-auto whitespace-pre-wrap rounded-md bg-black/30 p-2 font-mono text-[10.5px] leading-relaxed text-text-dark/85">
                      {selected.prompt}
                    </pre>
                    <div className="text-[11px] text-text-muted">{t("canvas.h3Templates.placeholderHint")}</div>
                  </div>
                )}
              </div>

              <div className="flex shrink-0 items-center justify-end gap-2 px-4 pb-4 pt-1">
                {(hasAudioInput || needsOwnFirstFrame) && (
                  <span className="mr-auto text-[11px] text-text-muted">
                    {t(
                      hasAudioInput
                        ? "canvas.h3Templates.needsAudioUpload"
                        : "canvas.h3Templates.needsFirstFrameUpload",
                    )}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => handleApply(false)}
                  disabled={!selected}
                  className="h-8 min-w-[50px] rounded-md border border-white/15 px-3 text-[13px] text-text-dark transition-colors hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:text-text-muted"
                >
                  {t("canvas.h3Templates.createNodes")}
                </button>
                <button
                  type="button"
                  onClick={() => handleApply(true)}
                  disabled={!selected || hasAudioInput || needsOwnFirstFrame}
                  className="h-8 min-w-[50px] rounded-md bg-primary px-3 text-[13px] text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-text-muted"
                >
                  {t("canvas.h3Templates.createAndRun")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

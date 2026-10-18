// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { AlertTriangle, CheckCircle2, CircleX } from "lucide-react";
import { useTranslation } from "react-i18next";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * Import standard format and examples for premium drama (drama). Hard-coded line by line instead of
 * stuffing a long string into i18n: these are samples shown as is, and every line break / space
 * is meaningful and must not be touched by translators.
 *
 * English and Vietnamese each get a set: the parser (utils/screenplay_scene_parser.py) reads the same
 * Fountain / Final Draft keywords for both, but the samples are "copy this" templates, so the
 * Vietnamese UI shows Vietnamese content (names, actions, dialogue) around the literal keywords.
 *
 * NOTE FOR TRANSLATORS - this applies to the `ingest.novelFormat.rule*`,
 * `ingest.sceneHeaders.*` and `aiAssistant.formatCheck.recommended` strings too:
 * the parser matches these keywords *literally*. It accepts Fountain / Final Draft
 * headings and nothing else. Translate the explanation around them; never translate
 * `EPISODE N`, `Characters:`, `INT.` / `EXT.`, or the time values
 * (`NIGHT` / `DAY` / ...). A localized guide whose keywords were
 * translated reads fine and then fails every import made by someone who
 * followed it.
 */
const DRAMA_FORMAT_SPEC_EN = [
  "Fountain / Final Draft (recommended)",
  "INT. SEOUL SUBWAY STATION - NIGHT",
  "EXT. SEOUL STREET - DAWN",
  "",
  "Time values",
  "DAY / NIGHT / MORNING / AFTERNOON / EVENING / DAWN / DUSK",
  "",
  "Exact clock time (its own line, under the heading)",
  "INT. SEOUL SUBWAY STATION - NIGHT",
  "Time: 11:47 PM",
].join("\n");

const DRAMA_REPAIRABLE_FORMAT_EN = [
  "EPISODE 1",
  "",
  "SCENE 1 - SEOUL SUBWAY STATION",
  "Characters: Ji-won, Old Woman",
  "△ Rainwater drips from the ceiling.",
  "JI-WON: Is anyone here?",
  "",
  "INT./EXT. MOVING TAXI - DAY",
  "Characters: Ji-won",
  "△ The taxi weaves through traffic.",
  "JI-WON: Faster, please.",
].join("\n");

const DRAMA_FORMAT_EXAMPLE_EN = [
  "EPISODE 1",
  "",
  "INT. SEOUL SUBWAY STATION - NIGHT",
  "Characters: Ji-won, Old Woman",
  "",
  "△ Rainwater drips from the ceiling. The platform is completely empty.",
  "",
  "JI-WON: Is anyone here?",
  "",
  "OLD WOMAN: You should not have come this late.",
  "",
  "",
  "INT. SUBWAY CAR - NIGHT",
  "Characters: Ji-won, Old Woman, Boy",
  "",
  "△ The train doors close. The lights flicker above the empty seats.",
  "",
  "JI-WON: Where is this train going?",
  "",
  "OLD WOMAN: To the last station.",
  "",
  "",
  "EXT. SEOUL STREET - DAWN",
  "Characters: Ji-won",
  "",
  "△ Ji-won steps onto the deserted street as the first morning light appears.",
  "",
  "JI-WON: I made it back.",
].join("\n");
const DRAMA_FORMAT_SPEC_VI = [
  "Fountain / Final Draft (khuyến nghị)",
  "INT. GA TÀU ĐIỆN NGẦM SEOUL - NIGHT",
  "EXT. PHỐ SEOUL - DAWN",
  "",
  "Giá trị thời gian",
  "DAY / NIGHT / MORNING / AFTERNOON / EVENING / DAWN / DUSK",
  "",
  "Giờ chính xác (một dòng riêng, ngay dưới tiêu đề cảnh)",
  "INT. GA TÀU ĐIỆN NGẦM SEOUL - NIGHT",
  "Time: 11:47 PM",
].join("\n");

const DRAMA_REPAIRABLE_FORMAT_VI = [
  "EPISODE 1",
  "",
  "SCENE 1 - GA TÀU ĐIỆN NGẦM SEOUL",
  "Characters: Ji-won, Bà cụ",
  "△ Nước mưa nhỏ giọt từ trần xuống.",
  "JI-WON: Có ai ở đây không?",
  "",
  "INT./EXT. TAXI ĐANG CHẠY - DAY",
  "Characters: Ji-won",
  "△ Chiếc taxi len lỏi giữa dòng xe.",
  "JI-WON: Làm ơn đi nhanh lên.",
].join("\n");

const DRAMA_FORMAT_EXAMPLE_VI = [
  "EPISODE 1",
  "",
  "INT. GA TÀU ĐIỆN NGẦM SEOUL - NIGHT",
  "Characters: Ji-won, Bà cụ",
  "",
  "△ Nước mưa nhỏ giọt từ trần xuống. Sân ga hoàn toàn vắng lặng.",
  "",
  "JI-WON: Có ai ở đây không?",
  "",
  "BÀ CỤ: Cháu không nên đến muộn thế này.",
  "",
  "",
  "INT. TOA TÀU - NIGHT",
  "Characters: Ji-won, Bà cụ, Cậu bé",
  "",
  "△ Cửa tàu đóng lại. Đèn nhấp nháy trên những hàng ghế trống.",
  "",
  "JI-WON: Chuyến tàu này đi đâu vậy?",
  "",
  "BÀ CỤ: Đến ga cuối cùng.",
  "",
  "",
  "EXT. PHỐ SEOUL - DAWN",
  "Characters: Ji-won",
  "",
  "△ Ji-won bước ra con phố vắng khi những tia nắng đầu tiên xuất hiện.",
  "",
  "JI-WON: Mình đã trở về được rồi.",
].join("\n");

/**
 * Samples follow the UI language, not the script language: these are "copy this" templates and
 * go with the person reading them. English is the default; Vietnamese gets its own set.
 */
const FORMAT_SAMPLES = {
  vi: {
    spec: DRAMA_FORMAT_SPEC_VI,
    repairable: DRAMA_REPAIRABLE_FORMAT_VI,
    example: DRAMA_FORMAT_EXAMPLE_VI,
  },
  en: {
    spec: DRAMA_FORMAT_SPEC_EN,
    repairable: DRAMA_REPAIRABLE_FORMAT_EN,
    example: DRAMA_FORMAT_EXAMPLE_EN,
  },
} as const;

export function NovelFormatDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t, i18n } = useTranslation();
  const samples = (i18n.resolvedLanguage ?? i18n.language ?? "").startsWith("vi")
    ? FORMAT_SAMPLES.vi
    : FORMAT_SAMPLES.en;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl rounded-lg bg-black sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("ingest.novelFormat.title")}</DialogTitle>
        </DialogHeader>

        {/* Make the scrollbar thin and faint: its length is decided by the content/viewport ratio and cannot be changed, so just keep it from stealing attention. */}
        <ScrollArea className="max-h-[58vh] [&_[data-slot=scroll-area-scrollbar]]:w-1.5 [&_[data-slot=scroll-area-thumb]]:bg-white/15">
          <div className="space-y-5 pr-3">
            <p className="text-sm leading-6 text-foreground/75">
              {t("ingest.novelFormat.intro")}
            </p>

            <section className="grid gap-2 sm:grid-cols-3">
              <div className="rounded-md border border-emerald-500/20 bg-emerald-500/[0.06] p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                  <CheckCircle2 className="size-3.5" />
                  {t("ingest.novelFormat.standardStatus")}
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {t("ingest.novelFormat.standardStatusHint")}
                </p>
              </div>
              <div className="rounded-md border border-amber-500/20 bg-amber-500/[0.06] p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-amber-400">
                  <AlertTriangle className="size-3.5" />
                  {t("ingest.novelFormat.warningStatus")}
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {t("ingest.novelFormat.warningStatusHint")}
                </p>
              </div>
              <div className="rounded-md border border-destructive/25 bg-destructive/[0.07] p-3">
                <div className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                  <CircleX className="size-3.5" />
                  {t("ingest.novelFormat.blockingStatus")}
                </div>
                <p className="mt-1.5 text-xs leading-5 text-muted-foreground">
                  {t("ingest.novelFormat.blockingStatusHint")}
                </p>
              </div>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("ingest.novelFormat.specLabel")}
              </h3>
              <pre className="whitespace-pre-wrap rounded-md border border-white/10 bg-white/[0.03] px-3.5 py-3 text-[13px] leading-7 text-foreground/90">
                {samples.spec}
              </pre>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("ingest.novelFormat.repairableLabel")}
              </h3>
              <p className="text-xs leading-5 text-muted-foreground">
                {t("ingest.novelFormat.repairableHint")}
              </p>
              <pre className="whitespace-pre-wrap rounded-md border border-amber-500/15 bg-amber-500/[0.04] px-3.5 py-3 text-[13px] leading-7 text-foreground/80">
                {samples.repairable}
              </pre>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("ingest.novelFormat.rulesLabel")}
              </h3>
              <ul className="list-disc space-y-1.5 pl-5 text-xs leading-5 text-foreground/70">
                <li>{t("ingest.novelFormat.ruleEpisode")}</li>
                <li>{t("ingest.novelFormat.ruleScene")}</li>
                <li>{t("ingest.novelFormat.ruleCharacters")}</li>
                <li>{t("ingest.novelFormat.ruleBody")}</li>
                <li>{t("ingest.novelFormat.ruleDialogue")}</li>
                <li>{t("ingest.novelFormat.ruleLocationChange")}</li>
                <li>{t("ingest.novelFormat.ruleTimeTokens")}</li>
                <li>{t("ingest.novelFormat.ruleClockTime")}</li>
              </ul>
            </section>

            <section className="space-y-2">
              <h3 className="text-xs font-medium text-muted-foreground">
                {t("ingest.novelFormat.exampleLabel")}
              </h3>
              <pre className="whitespace-pre-wrap rounded-md border border-white/10 bg-white/[0.03] px-3.5 py-3 text-[13px] leading-7 text-foreground/70">
                {samples.example}
              </pre>
            </section>
          </div>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

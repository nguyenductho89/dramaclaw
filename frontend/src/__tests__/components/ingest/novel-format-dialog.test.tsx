// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { NovelFormatDialog } from "@/components/ingest/NovelFormatDialog";
import { enTranslation, viTranslation } from "../../helpers/i18n-fixtures";

/**
 * The samples in the format dialog are "copy this" templates, one set each for English and Vietnamese: the parser reads the same keywords,
 * but showing Vietnamese users English-only content would be no help. What is pinned here is that "the samples follow the UI language".
 */
async function renderIn(lng: "vi" | "en") {
  const i18n = i18next.createInstance();
  await i18n.use(initReactI18next).init({
    lng,
    fallbackLng: lng,
    interpolation: { escapeValue: false },
    resources: {
      vi: { translation: viTranslation },
      en: { translation: enTranslation },
    },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <NovelFormatDialog open onOpenChange={vi.fn()} />
    </I18nextProvider>,
  );
}

beforeAll(() => {
  // Radix's Dialog needs these two in jsdom, and throws if they are missing.
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  window.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

describe("NovelFormatDialog", () => {
  it("shows the Fountain sample and English-only rules in the English UI", async () => {
    const { baseElement } = await renderIn("en");
    const shown = baseElement.textContent ?? "";
    // The three <pre> blocks are, in order: complete scene heading / repairable format / example excerpt. They are asserted separately,
    // because "which block a given line appears in" is exactly what this dialog is there to convey.
    const [spec, repairable, example] = Array.from(
      baseElement.querySelectorAll("pre"),
    ).map((el) => el.textContent ?? "");

    expect(spec).toContain("INT. SEOUL SUBWAY STATION - NIGHT");
    expect(spec).toContain("EXT. SEOUL STREET - DAWN");
    // The exact clock time goes on its own Time: line and cannot be written into the location name.
    expect(spec).toContain("Time: 11:47 PM");
    // There are only 7 time words, and anything else makes the whole line unrecognizable.
    expect(spec).toContain("DAY / NIGHT / MORNING / AFTERNOON / EVENING / DAWN / DUSK");

    // INT./EXT. cannot land on a single interior/exterior value, and one such scene pulls the whole script from
    // standard down to repairable, so it belongs to "repairable" rather than "complete". It corresponds to the backend
    // tests/test_screenplay_scene_parser.py::test_int_ext_heading_is_repairable_not_complete.
    expect(spec).not.toContain("INT./EXT.");
    expect(repairable).toContain("SCENE 1 - SEOUL SUBWAY STATION");
    expect(repairable).toContain("INT./EXT. MOVING TAXI - DAY");

    // The complete example is aligned verbatim with the one in tests/test_screenplay_scene_parser.py,
    // which pins that it parses as standard with zero warnings.
    expect(example).toContain("EXT. SEOUL STREET - DAWN");
    expect(example).toContain("JI-WON: I made it back.");

    expect(shown).toContain("MIDNIGHT");
    // The English UI must not leak the Vietnamese sample.
    expect(shown).not.toContain("GA TÀU ĐIỆN NGẦM SEOUL");
  });

  it("shows the Vietnamese sample in the Vietnamese UI", async () => {
    const { baseElement } = await renderIn("vi");
    const shown = baseElement.textContent ?? "";

    expect(shown).toContain("INT. GA TÀU ĐIỆN NGẦM SEOUL - NIGHT");
    expect(shown).toContain("JI-WON: Có ai ở đây không?");
  });
});

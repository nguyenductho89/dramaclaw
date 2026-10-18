// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import HttpBackend from "i18next-http-backend";
import { useAppStore } from "@/stores/app-store";
import { BUILD_ID } from "@/lib/app-version";
import { SUPPORTED, normalize, type Supported } from "./languages";

export { SUPPORTED, normalize, type Supported };

function initialLanguage(): Supported {
  if (typeof window !== "undefined") {
    const queryLanguage = new URLSearchParams(window.location.search).get("lng");
    if (queryLanguage) return normalize(queryLanguage);
  }
  return normalize(useAppStore.getState().language || "en");
}

i18n
  .use(HttpBackend)
  .use(initReactI18next)
  .init({
    // Default to English unless the user explicitly selects another supported
    // language via URL or the app language setting.
    lng: initialLanguage(),
    fallbackLng: "en",
    supportedLngs: [...SUPPORTED],
    // `zh-CN` / `en-US` / `vi-VN` collapse to `zh` / `en` / `vi`, so the
    // backend loader only has to serve one translation file per language.
    load: "languageOnly",
    defaultNS: "translation",
    backend: {
      // Translation JSON files are static and cached long-term by browsers/CDNs. Without a
      // version, keys added in a release would still read the old cache for existing users
      // and render as raw keys (e.g. ingest.reuploadConfirm.*). Adding a BUILD_ID query busts
      // the cache: the URL changes on every build while staying cacheable within one build.
      // BUILD_ID rather than APP_VERSION: the latter is a fixed default when CI does not inject it, so two releases would look identical and the cache would never be busted.
      loadPath: `/locales/{{lng}}/{{ns}}.json?v=${encodeURIComponent(BUILD_ID)}`,
    },
    interpolation: {
      escapeValue: false,
    },
  });

// Keep the app-store's `language` field AND `<html lang>` in lockstep with
// what i18next actually resolved. Without this, the switcher (which reads
// app-store) can show a different pill than the page is rendered in — the
// drift we hit when different persistence layers disagreed on the language.
function syncResolvedLanguage() {
  const lng = normalize(i18n.resolvedLanguage ?? i18n.language);
  if (useAppStore.getState().language !== lng) {
    useAppStore.setState({ language: lng });
  }
  if (typeof document !== "undefined" && document.documentElement.lang !== lng) {
    document.documentElement.lang = lng;
  }
}

if (i18n.isInitialized) {
  syncResolvedLanguage();
} else {
  i18n.on("initialized", syncResolvedLanguage);
}
i18n.on("languageChanged", syncResolvedLanguage);

export default i18n;

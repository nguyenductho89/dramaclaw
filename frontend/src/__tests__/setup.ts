// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import "@testing-library/jest-dom/vitest";

// jsdom v29 + Node.js >=22 exposes a broken localStorage (plain object without
// Storage methods) when --localstorage-file is not set. Provide a spec-compliant
// in-memory replacement so zustand/persist and other code that relies on
// localStorage.setItem / getItem / removeItem works correctly in tests.
if (typeof globalThis.localStorage === "undefined" || typeof globalThis.localStorage.setItem !== "function") {
  class MemoryStorage implements Storage {
    private readonly store = new Map<string, string>();

    get length() {
      return this.store.size;
    }
    key(index: number) {
      return [...this.store.keys()][index] ?? null;
    }
    getItem(key: string) {
      return this.store.get(String(key)) ?? null;
    }
    setItem(key: string, value: string) {
      this.store.set(String(key), String(value));
    }
    removeItem(key: string) {
      this.store.delete(String(key));
    }
    clear() {
      this.store.clear();
    }
  }

  // Keep the constructor and instance aligned so prototype instrumentation
  // (including quota/error simulations) observes the same methods as callers.
  const storage = new MemoryStorage();
  Object.defineProperty(globalThis, "Storage", { value: MemoryStorage, writable: true, configurable: true });
  Object.defineProperty(window, "Storage", { value: MemoryStorage, writable: true, configurable: true });

  Object.defineProperty(globalThis, "localStorage", { value: storage, writable: true, configurable: true });
  Object.defineProperty(window, "localStorage", { value: storage, writable: true, configurable: true });
}

import { server } from "@/__mocks__/msw/server";
import { beforeAll, afterAll, afterEach } from "vitest";

// `bypass` (not `error`): the repo has test files that own their own `setupServer`
// instance (e.g. render-plan.test.tsx). With two MSW instances listening, `error`
// from the global server would reject requests the test-local server would handle.
// `bypass` lets non-matching requests pass through to other interceptors or fail
// naturally, without MSW crying foul.
beforeAll(() => server.listen({ onUnhandledRequest: "bypass" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import { enTranslation } from "./helpers/i18n-fixtures";

// Component tests assert the English text users see. Without an initialised default
// i18next instance t() only echoes the key. Initialise from the shipped
// en/translation.json so a mistyped key shows up as a raw key in the render.
// Tests that bring their own I18nextProvider use their own createInstance().
void i18next.use(initReactI18next).init({
  lng: "en",
  fallbackLng: "en",
  resources: { en: { translation: enTranslation } },
  interpolation: { escapeValue: false },
  react: { useSuspense: false },
});

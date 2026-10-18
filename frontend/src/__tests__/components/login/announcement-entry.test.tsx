// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";

import { AnnouncementEntry } from "@/components/login/cinematic/AnnouncementEntry";
import styles from "@/components/login/login.module.css";

// Run against the real translations instead of mocking react-i18next: UI wording is
// part of the copy, and only a real i18next catches "added a key but forgot the translation".
beforeAll(async () => {
  await i18next.use(initReactI18next).init({
    lng: "en",
    resources: {
      en: { translation: JSON.parse(readFileSync("public/locales/en/translation.json", "utf8")) },
    },
  });
});

// Announcement content comes from a JSON on OSS. public/announcements.json in the repo is
// the copy to upload, so use it as the fixture: it tests the component and also checks
// that the JSON shape passes the schema.
const SHIPPED_PAYLOAD = JSON.parse(readFileSync("public/announcements.json", "utf8"));

function stubFetch(impl: () => unknown) {
  const fetchMock = vi.fn(async () => impl() as Response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function jsonResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

// Read state lives in localStorage; without clearing it cases would leak into each other.
beforeEach(() => {
  window.localStorage.clear();
  stubFetch(() => jsonResponse(SHIPPED_PAYLOAD));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const DIALOG = { name: "Announcements" };

function findAnnouncementDot(trigger: HTMLElement) {
  return trigger.querySelector(`.${styles.announcementDot}`);
}

async function openCenter() {
  const user = userEvent.setup();
  render(<AnnouncementEntry />);
  const trigger = screen.getByRole("button", { name: "View announcements" });
  await user.click(trigger);
  const dialog = await screen.findByRole("dialog", DIALOG);
  return { user, trigger, dialog };
}

async function openLoadedCenter() {
  const opened = await openCenter();
  await waitFor(() =>
    expect(within(opened.dialog).queryAllByRole("listitem").length).toBeGreaterThan(0),
  );
  return opened;
}

describe("AnnouncementEntry", () => {
  it("pulls the announcements from the OSS json instead of a bundled list", async () => {
    const fetchMock = stubFetch(() => jsonResponse(SHIPPED_PAYLOAD));

    await openLoadedCenter();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    // Straight to OSS, not the CDN prefix from `media.ts`: the CDN has a 30-day edge cache and
    // strips the query from the cache key, so even a timestamp cannot refresh it and an edit
    // would take a month to show. This line pins the domain so nobody "unifies" it back to cdn().
    expect(url).toBe("https://nfg-web.cdnfg.com/dramaclaw/announcements.json");
    // The login page is opened while logged out; do not send cookies to OSS.
    expect(init).toMatchObject({ credentials: "omit", cache: "no-cache" });
  });

  it("clears the trigger dot after the announcement center is opened", async () => {
    const { trigger, dialog } = await openLoadedCenter();

    await waitFor(() => expect(findAnnouncementDot(trigger)).toBeNull());
    expect(within(dialog).queryByText("1 unread")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("dramaclaw.login.announcements.read")).toContain(
      "channel-release-2026-08",
    );
  });

  it("preserves read ids that are not in the current remote payload", async () => {
    window.localStorage.setItem(
      "dramaclaw.login.announcements.read",
      JSON.stringify(["retired-announcement"]),
    );

    await openLoadedCenter();

    await waitFor(() => {
      const stored = JSON.parse(
        window.localStorage.getItem("dramaclaw.login.announcements.read") ?? "[]",
      ) as string[];
      expect(stored).toEqual(
        expect.arrayContaining(["retired-announcement", "channel-release-2026-08"]),
      );
    });
  });

  it("lists each announcement as its own card and closes from the confirm button", async () => {
    const { user, dialog } = await openLoadedCenter();

    const items = within(dialog).getAllByRole("listitem");
    expect(items).toHaveLength(1);
    expect(within(items[0]).getByRole("heading")).toHaveTextContent("Channel release update");
    expect(items[0]).toHaveTextContent("A channel release is going live");

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByRole("dialog", DIALOG)).not.toBeInTheDocument());
    expect(window.localStorage.getItem("dramaclaw.login.announcements.read")).toContain(
      "channel-release-2026-08",
    );
  });

  it("renders the subject and the time window as separate highlight spans", async () => {
    await openLoadedCenter();

    // Highlight fragments are separate elements, proving <time>/<hl> were really turned into
    // styled spans instead of being printed into the body as plain text.
    expect(screen.getByText("channel release").tagName).toBe("SPAN");
    expect(screen.getByText("18:00 and 19:00").tagName).toBe("SPAN");
  });

  it("prints any other markup in the remote copy as literal text", async () => {
    stubFetch(() =>
      jsonResponse({
        announcements: [
          {
            id: "escape-check",
            publishedAt: "2026-08-24T10:00:00+08:00",
            i18n: { en: { title: "Escape", body: "See <img src=x onerror=alert(1)> then the body" } },
          },
        ],
      }),
    );

    const { dialog } = await openLoadedCenter();

    // Remote copy is untrusted input: only <hl>/<time> are recognized, other tags stay literal.
    expect(dialog).toHaveTextContent("See <img src=x onerror=alert(1)> then the body");
    expect(dialog.querySelector("img")).toBeNull();
  });

  it("falls back to another language when the current one is missing from the json", async () => {
    window.localStorage.clear();
    stubFetch(() =>
      jsonResponse({
        announcements: [
          {
            id: "en-only",
            publishedAt: "2026-08-24T10:00:00+08:00",
            i18n: { vi: { title: "English only", body: "Body in English" } },
          },
        ],
      }),
    );

    const { dialog } = await openLoadedCenter();

    // A missing translation should not hide the whole announcement; another language keeps the information.
    expect(within(dialog).getByRole("heading", { name: "English only" })).toBeInTheDocument();
  });

  it("sorts pinned announcements first, then newest", async () => {
    stubFetch(() =>
      jsonResponse({
        announcements: [
          {
            id: "old",
            publishedAt: "2026-08-01T10:00:00+08:00",
            i18n: { en: { title: "Old announcement", body: "old" } },
          },
          {
            id: "new",
            publishedAt: "2026-08-20T10:00:00+08:00",
            i18n: { en: { title: "New announcement", body: "new" } },
          },
          {
            id: "pinned",
            publishedAt: "2026-07-01T10:00:00+08:00",
            pinned: true,
            i18n: { en: { title: "Pinned announcement", body: "top" } },
          },
        ],
      }),
    );

    const { dialog } = await openLoadedCenter();

    // Order is decided by the data layer; the order inside the JSON does not affect display.
    const titles = within(dialog)
      .getAllByRole("heading", { level: 3 })
      .map((node) => node.textContent);
    expect(titles).toEqual(["Pinned announcement", "New announcement", "Old announcement"]);
  });

  it("shows the complete announcement without an expand control", async () => {
    const { dialog } = await openLoadedCenter();

    expect(dialog).toHaveTextContent("A channel release is going live");
    expect(screen.queryByRole("button", { name: "Expand this announcement" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Collapse this announcement" })).not.toBeInTheDocument();
  });

  it("disables mark-all after opening has acknowledged the visible list", async () => {
    await openLoadedCenter();

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Mark all read" })).toBeDisabled(),
    );
  });

  it("keeps the trigger but drops the dot and the list when the json cannot be loaded", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(() => {
      throw new Error("network down");
    });

    const { dialog, trigger } = await openCenter();

    // A failed fetch means "no announcements": the trigger stays, but no red dot and the list is empty.
    // No "reload" button, since refreshing the login page retries anyway.
    await waitFor(() => expect(findAnnouncementDot(trigger)).toBeNull());
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0);
    expect(within(dialog).getByRole("button", { name: "Mark all read" })).toBeDisabled();
  });

  it("treats a malformed payload as no announcements rather than half a card", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(() =>
      jsonResponse({ announcements: [{ id: "broken", publishedAt: "not-a-date", i18n: {} }] }),
    );

    const { dialog, trigger } = await openCenter();

    await waitFor(() => expect(findAnnouncementDot(trigger)).toBeNull());
    expect(within(dialog).queryAllByRole("listitem")).toHaveLength(0);
  });

  it("traps focus in the dialog and hands it back to the trigger on close", async () => {
    const { user, trigger, dialog } = await openLoadedCenter();

    // Regression case: the hand-rolled portal version had no focus management and Tab escaped to the page behind the dialog.
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));

    await user.keyboard("{Tab}");
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => expect(screen.queryByRole("dialog", DIALOG)).not.toBeInTheDocument());
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("closes the dialog on Escape", async () => {
    const { user } = await openLoadedCenter();

    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog", DIALOG)).not.toBeInTheDocument());
  });
});

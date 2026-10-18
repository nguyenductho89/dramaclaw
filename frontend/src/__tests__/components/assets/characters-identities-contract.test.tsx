// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Opening the Characters tab must not fan out identities per character.
 *
 * `/characters/{name}/identities` used to fire once per character - as many requests as there were characters in the list,
 * just to put an identity count on the sidebar. Ownership is now computed in one go by `useIdentityOwnerIndex` from the `identity_ids` the
 * character list carries, and real identity details are only fetched for the **selected** character.
 *
 * Renders the whole page for the same reason as `episodes-list-beats-contract.test.tsx`: the fan-out does not show up in
 * the rendered result, it shows up in "which hooks the page composition layer happens to call", and hook unit tests cannot stop the composition layer from
 * wiring the wrong call pattern back in.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { http, HttpResponse } from "msw";
import ky from "ky";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

vi.mock("@tanstack/react-router", () => ({
  createLazyFileRoute: () => () => ({
    useParams: () => ({ project: "demo" }),
    useSearch: () => ({}),
  }),
  Link: ({ children, ...rest }: { children: ReactNode }) => (
    <a {...(rest as object)}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useParams: () => ({ project: "demo" }),
  useRouterState: ({ select }: { select?: (s: unknown) => unknown } = {}) => {
    const state = { location: { pathname: "/projects/demo/characters" } };
    return select ? select(state) : state;
  },
  useMatches: () => [],
}));

vi.mock("@/hooks/use-task-controller", () => ({
  useTaskController: () => ({
    started: false,
    stream: { status: "idle", progress: 0, currentTask: "", result: null, error: null },
    logs: [],
    start: vi.fn(),
    stop: vi.fn(),
    stopping: false,
  }),
}));

import { CharactersPage } from "@/routes/_app/projects.$project/characters.lazy";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: {} });
  // jsdom has no matchMedia, so `useMediaQuery` falls all the way back to false and the page renders the mobile
  // collapsed Select - character names hide inside a dropdown that is not expanded, and the precondition check of the assertions has nowhere to land. Here it
  // reports a desktop width, so the branch that really lists all characters runs.
  // jsdom does not implement these two: after a character in the list is selected it scrolls into view, and without them the component throws outright.
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
});

beforeEach(() => {
  window.localStorage.clear();
});

const CHARACTERS = [
  { name: "Su Qingyan", is_main: true, identity_ids: ["Su Qingyan_teen", "Su Qingyan_legitimate_daughter"] },
  { name: "Shen Yan", is_main: false, identity_ids: ["Shen Yan_teen"] },
  { name: "Liu Mingwei", is_main: false, identity_ids: [] },
];

function recordRequests(): string[] {
  const seen: string[] = [];
  server.use(
    http.get("http://localhost:3000/api/v1/*", ({ request }) => {
      seen.push(new URL(request.url).pathname);
      return HttpResponse.json({ ok: true, data: [] });
    }),
  );
  // Registered in two use calls: `server.use` is an unshift, so what is registered later comes first. The character list must override the
  // catch-all above, otherwise the whole page gets an empty array, no identity request is sent, and the assertions pass vacuously.
  server.use(
    http.get("http://localhost:3000/api/v1/projects/demo/characters", ({ request }) => {
      // A dedicated handler does not go through the catch-all, so it has to record itself, otherwise this request does not reach `seen`.
      seen.push(new URL(request.url).pathname);
      return HttpResponse.json({ ok: true, data: CHARACTERS });
    }),
  );
  return seen;
}

function renderWithProviders(ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("the characters tab does not fan identities out per character", () => {
  it("lists every character but only asks for the selected one's identities", async () => {
    const seen = recordRequests();

    renderWithProviders(<CharactersPage />);

    // First confirm the three characters really rendered - otherwise the page crashes halfway and the request assertions below pass vacuously
    // because nothing was sent.
    // First confirm all three characters really rendered - otherwise the page crashes halfway and the request assertions below pass vacuously
    // because nothing was sent. The first character appears in both the sidebar and the right-hand detail, hence All.
    expect((await screen.findAllByText("Su Qingyan")).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.getByText("Liu Mingwei")).toBeInTheDocument());
    expect(screen.getByText("Shen Yan")).toBeInTheDocument();

    // Chinese in the path is percent-encoded; decode before comparing, so the assertion shows which character it is.
    const identityRequests = seen
      .map((path) => decodeURIComponent(path))
      .filter((path) => path.endsWith("/identities"));
    // Three characters, one identity request: ownership is computed by `useIdentityOwnerIndex` from the `identity_ids` the character list
    // carries, with no extra request; details are only fetched for the automatically selected first character.
    // Specific paths are listed rather than counting - the shape of the regression is "one per character", and listing shows
    // which ones were missed.
    expect(identityRequests).toEqual(["/api/v1/projects/demo/characters/Su Qingyan/identities"]);
  // The assets page no longer scans the beats of every episode just to show global usage statistics.
    expect(seen.filter((path) => path.includes("/beats"))).toEqual([]);
  });

  it("does not load character assets when the remembered tab is scenes", async () => {
    window.localStorage.setItem("supertale-asset-tab:demo", "scenes");
    const seen = recordRequests();

    renderWithProviders(<CharactersPage />);

    await waitFor(() =>
      expect(seen).toContain("/api/v1/projects/demo/scenes"),
    );
    expect(seen).not.toContain("/api/v1/projects/demo/characters");
    expect(seen).not.toContain(
      "/api/v1/projects/demo/character-image-selection",
    );
  });
});

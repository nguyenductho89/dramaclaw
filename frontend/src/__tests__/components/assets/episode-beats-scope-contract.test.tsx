// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * When really entering one episode, only the beats of the current episode may be requested.
 *
 * `/episodes/{n}/beats` is the most expensive route in the whole project: it opens the DB, builds four asset URLs for every beat,
 * and forks an ffprobe for every audio. The episode list no longer touches it (see
 * `episodes-list-beats-contract.test.tsx`), so what remains of the contract is - clicking into episode 3 pulls only
 * episode 3, and must not take other episodes along.
 *
 * Renders the whole page for the same reason as the other two contract tests: pulling one more episode never shows up in the rendered result, it shows up in
 * "which hooks the page composition layer happens to call".
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import i18next from "i18next";
import { I18nextProvider, initReactI18next } from "react-i18next";
import { http, HttpResponse } from "msw";
import ky from "ky";
import type { ReactNode } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { server } from "@/__mocks__/msw/server";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

vi.mock("@tanstack/react-router", () => ({
  createLazyFileRoute: () => () => ({
    useParams: () => ({ project: "demo", episode: "3" }),
    useSearch: () => ({}),
  }),
  Link: ({ children, ...rest }: { children: ReactNode }) => (
    <a {...(rest as object)}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useParams: () => ({ project: "demo", episode: "3" }),
  useRouterState: ({ select }: { select?: (s: unknown) => unknown } = {}) => {
    const state = { location: { pathname: "/projects/demo/episodes/3/beats" } };
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

import { TaskCenterProvider } from "@/task-center/provider";
import { BeatsTabContent } from "@/routes/_app/projects.$project/episodes.$episode/beats.lazy";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: {} });
  // jsdom does not implement these; the component throws outright without them.
  Element.prototype.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  // `BeatCardGrid` uses it via `useResponsiveColumns`; jsdom does not implement it, and the constructor throws inside an
  // effect, the whole subtree is unmounted by React and the page is blank - the request assertions then pass vacuously
  // because "nothing was sent". A stub is enough: the hook already called `measure()` once before building the observer, and in jsdom the
  // width is always 0, so whichever branch the column count takes does not affect the request surface asserted here.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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

function recordRequests(): string[] {
  const seen: string[] = [];
  server.use(
    http.get("http://localhost:3000/api/v1/*", ({ request }) => {
      seen.push(new URL(request.url).pathname);
      return HttpResponse.json({ ok: true, data: [] });
    }),
  );
  // Registered in two use calls: `server.use` is an unshift, so what is registered later comes first, and this episode's beats must override the
  // catch-all above so the page has something to render and the assertions do not pass vacuously.
  server.use(
    http.get("http://localhost:3000/api/v1/projects/demo/episodes/3/beats", ({ request }) => {
      // A dedicated handler does not go through the catch-all, so it has to record itself, otherwise this request does not reach `seen`.
      seen.push(new URL(request.url).pathname);
      return HttpResponse.json({
        ok: true,
        // Fields follow `Beat` in `types/episode.ts`: `beat_number` is the React key of `BeatCardGrid`,
        // and without it the two cards would fold into one with the same key, which would distort the "two rendered" precondition assertion.
        data: [
          { beat_number: 1, narration_segment: "Episode three, first beat", visual_description: "" },
          { beat_number: 2, narration_segment: "Episode three, second beat", visual_description: "" },
        ],
      });
    }),
  );
  return seen;
}

function renderWithProviders(ui: ReactNode) {
  // `staleTime` must align with the 30s in `main.tsx`, not the library default of 0. This page has two
  // observers subscribing to the same beats key (one from the page itself, one inside `useBeatStates`),
  // and with staleTime=0 the one mounted later fetches again - it does not happen in production, but in the test it would turn
  // "request the current episode only once" into two. After aligning, what this assertion measures is the real request surface.
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 30_000 } },
  });
  return render(
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={qc}>
        {/* `useEpisodeImageTaskInvalidation` in the page subscribes to the task event bus,
            and throws without this Provider. The real one is used instead of a stub, to avoid mocking out the subscription logic too. */}
        <TaskCenterProvider projectId="demo">{ui}</TaskCenterProvider>
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("entering one episode reads only that episode's beats", () => {
  it("requests /episodes/3/beats exactly once and no other episode's", async () => {
    const seen = recordRequests();

    renderWithProviders(<BeatsTabContent />);

    // First confirm this episode's content really rendered - otherwise the page crashes halfway and the request assertions below pass vacuously because
    // nothing was sent.
    //
    // Recognize cards rather than dialogue: the default view `BeatCardGrid` lays out image cards, and narration only goes into the edit
    // panel, not on the card face. Each card has a checkbox button, and when the i18n resources are empty `t()` returns the key as is,
    // so counting them equals counting cards.
    await waitFor(() =>
      expect(screen.getAllByLabelText("episode.beat.select")).toHaveLength(2),
    );

    // Specific paths are listed rather than counting - the shape of the regression is "pulled which other episode along", and listing shows it.
    expect(seen.filter((path) => path.includes("/beats"))).toEqual([
      "/api/v1/projects/demo/episodes/3/beats",
    ]);
  });
});

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Opening the episode list must not pull the full beats of any episode.
 *
 * Every card on this page shows the shot count, and each card used to call `useEpisodeBeats` on its own - as many
 * `/episodes/{n}/beats` as there were episodes in the list, the most expensive route (opens the DB, builds four asset URLs for every beat,
 * forks an ffprobe for every audio), just to take a `.length`. This PR replaces it with the `beat_count` that the
 * list endpoint brings out with a single GROUP BY.
 *
 * The assertions sit at the network layer and render the whole page rather than a single hook: the fan-out never shows up in the rendered result, it
 * shows up in "which hooks the page composition layer happens to call" - exactly the kind a UI refactor quietly wires back in.
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

// The route is kept only enough to let the page run: this file asserts what the network saw, not navigation.
vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => () => ({
    useParams: () => ({ project: "demo" }),
    useSearch: () => ({}),
  }),
  Link: ({ children, ...rest }: { children: ReactNode }) => (
    <a {...(rest as object)}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useSearch: () => ({}),
  useParams: () => ({ project: "demo" }),
  // `useActiveStagePath` uses the select form, and the mock must really run the selector,
  // otherwise what comes back is the whole state object instead of the pathname string.
  useRouterState: ({ select }: { select?: (s: unknown) => unknown } = {}) => {
    const state = { location: { pathname: "/projects/demo/episodes" } };
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

import { EpisodesPage } from "@/routes/_app/projects.$project/episodes";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({ lng: "en", fallbackLng: "en", resources: {} });
});

function recordRequests(): string[] {
  const seen: string[] = [];
  server.use(
    http.get("http://localhost:3000/api/v1/*", ({ request }) => {
      seen.push(new URL(request.url).pathname);
      return HttpResponse.json({ ok: true, data: [] });
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

describe("the episode list does not read the beats table", () => {
  it("renders every episode card without requesting any episode's beats", async () => {
    const seen = recordRequests();
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/episodes", ({ request }) => {
        // A dedicated handler takes precedence over the catch-all, so it has to record itself, otherwise this request does not reach `seen`.
        seen.push(new URL(request.url).pathname);
        return HttpResponse.json({
          ok: true,
          data: [
            { number: 1, title: "Episode One", beat_count: 7 },
            { number: 2, title: "Episode Two", beat_count: 4 },
            { number: 3, title: "Episode Three", beat_count: 0 },
          ],
        });
      }),
    );

    renderWithProviders(<EpisodesPage />);

    // First confirm the three cards really rendered - otherwise the page crashes halfway and the `/beats` assertion below
    // passes vacuously because nothing was sent.
    expect(await screen.findByText("Episode One")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText("Episode Three")).toBeInTheDocument());
    expect(seen.filter((path) => path.endsWith("/episodes"))).toHaveLength(1);
    // Three episodes, three cards, zero beats requests. toEqual([]) is written here rather than counting: the shape of the regression
    // is "one per episode", and listing shows which episodes were missed better than a number.
    expect(seen.filter((path) => path.includes("/beats"))).toEqual([]);
  });
});

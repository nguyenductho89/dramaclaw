// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import { queryKeys } from "@/lib/query-keys";
import { useAddProjectGrant, useProjectGrants } from "@/lib/queries/projects";

const server = setupServer();

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper(queryClient: QueryClient) {
  return function QueryWrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

function grant(index: number) {
  return {
    id: `g${index}`,
    project_id: "p1",
    principal_type: "user",
    principal_id: `u${index}`,
    principal_username: `user${index}`,
    role: "editor",
  };
}

describe("project grant mutation refresh", () => {
  it("only resolves once the member list has caught up", async () => {
    // The quota is only counted by the frontend, and what it counts is exactly this list. If the mutation finishes first while the refresh is still in flight,
    // in that window isLoading is false and data is still the old count from before the member was added - letting it through,
    // the next add could really be the 26th.
    const rows = [grant(0), grant(1)];
    server.use(
      http.get("http://localhost:3000/api/v1/projects/p1/grants", () =>
        HttpResponse.json({ ok: true, data: rows }),
      ),
      http.post("http://localhost:3000/api/v1/projects/p1/grants", async () => {
        // Add idempotently: msw + ky in jsdom run the resolver of the same POST twice
        // (verified with a plain ky.post unit test), and a plain push would count an extra row.
        if (!rows.some((row) => row.id === "g2")) rows.push(grant(2));
        return HttpResponse.json({ ok: true, data: grant(2) });
      }),
    );

    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(
      () => ({ grants: useProjectGrants("p1"), add: useAddProjectGrant("p1") }),
      { wrapper: wrapper(queryClient) },
    );

    await waitFor(() => expect(result.current.grants.data?.data).toHaveLength(2));

    await result.current.add.mutateAsync({ principal_username: "user2", role: "editor" });

    // As soon as mutateAsync returns, the list in the cache must be the one after the member was added.
    // (Read the cache instead of the hook snapshot: the latter has to wait for React to re-render, which would not test this.)
    const cached = queryClient.getQueryData<{ data: unknown[] }>(queryKeys.projectGrants("p1"));
    expect(cached?.data).toHaveLength(3);
  });
});

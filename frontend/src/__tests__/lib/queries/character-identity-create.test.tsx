// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
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

import { useCreateIdentity } from "@/lib/queries/characters";

const server = setupServer();
const querySource = readFileSync("src/lib/queries/characters.ts", "utf-8");
const createIdentitySource = querySource.slice(
  querySource.indexOf("export function useCreateIdentity"),
  querySource.indexOf("export function useUpdateIdentity"),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("identity create query hook", () => {
  it("types age group as part of create identity input", () => {
    expect(createIdentitySource).toContain("age_group?: string");
  });

  it("posts age group when creating an identity", async () => {
    let body: unknown = null;
    server.use(
      http.post(
        "http://localhost:3000/api/v1/projects/demo/characters/Qin/identities",
        async ({ request }) => {
          body = await request.json();
          return HttpResponse.json({
            ok: true,
            data: {
              identity_id: "Qin_child",
              identity_name: "child",
              age_group: "child",
              appearance_details: "coarse cloth tunic",
            },
          });
        },
      ),
    );

    const { result } = renderHook(() => useCreateIdentity("demo", "Qin"), {
      wrapper,
    });
    result.current.mutate({
      identity_name: "child",
      age_group: "child",
      appearance_details: "coarse cloth tunic",
    });

    await waitFor(() => expect(result.current.data).toBeDefined());
    expect(body).toEqual({
      identity_name: "child",
      age_group: "child",
      appearance_details: "coarse cloth tunic",
    });
  });
});

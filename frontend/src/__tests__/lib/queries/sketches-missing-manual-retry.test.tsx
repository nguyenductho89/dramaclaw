// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// TCP-EU-B4b section 2 - the best-effort delivery half of `/sketches/generate-missing-manual`.
//
// This endpoint is **self-healing**: the backend recomputes which manual shot segments are still missing every time (CE
// `src/novelvideo/api/routes/generation.py:4425` `missing_manual_shot_segments`),
// so the correct shape of "resubmit only the rejected part" here is **call the same request again verbatim**:
// no body, no scope, no new parameters. This file pins that down, to stop later people from
// sneaking "pass the rejected scope back" style improvisations that double-bill into the resubmit.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import ky from "ky";
import type { ReactNode } from "react";

// Same as the existing prescription at `src/__tests__/lib/queries/render-plan.test.tsx:11-17`.
vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  handleSessionExpired: vi.fn(),
  setApiQueryClient: vi.fn(),
}));

import { server } from "@/__mocks__/msw/server";
import {
  useGenerateMissingManualSketches,
  type GenerateMissingManualResult,
} from "@/lib/queries/sketches";

interface Seen {
  url: string;
  method: string;
  body: string;
}

let seen: Seen[];

beforeEach(() => {
  seen = [];
  server.use(
    http.post("*/sketches/generate-missing-manual", async ({ request }) => {
      seen.push({
        url: new URL(request.url).pathname,
        method: request.method,
        body: await request.text(),
      });
      return HttpResponse.json({
        ok: true,
        task_type: "sketch_regen",
        data: {
          dispatched: 2,
          scopes: ["a", "b"],
          segments: [[1, 2], [3, 4]],
          rejected: [{ scope: "c", reason: "channel", limit: 12, active: 12 }],
        },
      });
    }),
  );
});

afterEach(() => vi.clearAllMocks());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("useGenerateMissingManualSketches - resubmit after best-effort delivery", () => {
  it("resubmit = the same request verbatim (no body, no scope, no new parameters)", async () => {
    const { result } = renderHook(() => useGenerateMissingManualSketches("demo", 1), {
      wrapper,
    });

    await result.current.mutateAsync();
    await result.current.mutateAsync();

    await waitFor(() => expect(seen).toHaveLength(2));
    expect(seen[0]).toEqual(seen[1]);
    expect(seen[0].body).toBe("{}");
    expect(seen[0].method).toBe("POST");
    expect(seen[0].url).toBe(
      "/api/v1/projects/demo/episodes/1/sketches/generate-missing-manual",
    );
  });

  it("`rejected` in the response is acknowledged by the type, and no longer described as diagnostics in a comment", async () => {
    const { result } = renderHook(() => useGenerateMissingManualSketches("demo", 1), {
      wrapper,
    });
    const res = (await result.current.mutateAsync()) as {
      data: GenerateMissingManualResult;
    };
    expect(res.data.rejected).toEqual([
      { scope: "c", reason: "channel", limit: 12, active: 12 },
    ]);

    // Precedent: `src/__tests__/routes/beats-sketch-render-contract.test.ts` pins the contract
    // at the source-string level. What is pinned here is "comments must stop lying": `rejected` drives
    // the resubmit, and is not a diagnostics field only for humans.
    const source = readFileSync("src/lib/queries/sketches.ts", "utf8");
    expect(source).toContain("rejected");
    expect(source).not.toContain("surfaced for diagnostics only");
  });
});

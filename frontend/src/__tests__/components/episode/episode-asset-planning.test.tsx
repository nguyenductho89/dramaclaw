// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import ky from "ky";
import type { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api", () => ({
  api: ky.create({ baseUrl: "http://localhost:3000/" }),
  uploadApi: ky.create({ baseUrl: "http://localhost:3000/" }),
}));

import { EpisodeAssetPlanning } from "@/components/episode/episode-asset-planning";

const labels = {
  identities: "Identity",
  scenes: "Scene",
  props: "Prop",
  noIdentities: "No identities planned",
  noScenes: "Scenes not planned",
  noProps: "Props not planned",
  planIdentities: "Plan identities",
  replanIdentities: "Re-plan identities",
  defaultIdentity: "Default",
  planScenes: "Plan scenes",
  replanScenes: "Re-plan scenes",
  planProps: "Plan props",
  replanProps: "Re-plan props",
  propInGlobal: "Already in global prop library",
  propCheckingGlobal: "Checking global prop library",
  promoteProp: "Add to global prop library",
  promotePropTitle: (name: string) => `Add to global prop library: ${name}`,
  promotePropName: "Global prop name",
  promotePropType: "Prop type",
  promoteVisualPrompt: "Visual Prompt",
  promoteOwner: "Owner",
  promoteSubmit: "Add to global",
  promoteCancel: "Cancel",
  propTypeLabel: (value: string) => value,
};

const server = setupServer(
  http.get("http://localhost:3000/api/v1/projects/demo/props", () =>
    HttpResponse.json({ ok: true, data: [] }),
  ),
);

beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderPlanning(props: Partial<Parameters<typeof EpisodeAssetPlanning>[0]> = {}) {
  return render(
    <EpisodeAssetPlanning
      project="demo"
      sceneMenu={[]}
      propMenu={[]}
      labels={labels}
      onPlanIdentities={vi.fn()}
      onPlanScenes={vi.fn()}
      onPlanProps={vi.fn()}
      {...props}
    />,
    { wrapper },
  );
}

describe("EpisodeAssetPlanning", () => {
  it("shows the scenes panel with items and replan action", async () => {
    const user = userEvent.setup();
    const onPlanScenes = vi.fn();

    renderPlanning({
      selectedCategory: "scenes",
      sceneMenu: [{ scene_id: "Palace Gate" }],
      onPlanScenes,
    });

    expect(screen.getByText("Palace Gate")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Re-plan scenes" }));
    expect(onPlanScenes).toHaveBeenCalledTimes(1);
  });

  it("shows the props panel with items and replan action", async () => {
    const user = userEvent.setup();
    const onPlanProps = vi.fn();
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/props", () =>
        HttpResponse.json({ ok: true, data: [] }),
      ),
    );

    renderPlanning({
      selectedCategory: "props",
      propMenu: [{ prop_id: "jade pendant", prop_type: "object" }],
      onPlanProps,
    });

    expect(screen.getByText("jade pendant")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Re-plan props" }));
    expect(onPlanProps).toHaveBeenCalledTimes(1);
  });

  it("only renders the selected category's panel", () => {
    const { rerender } = renderPlanning({ selectedCategory: "scenes" });
    expect(screen.getByText("Scenes not planned")).toBeInTheDocument();
    expect(screen.queryByText("Props not planned")).not.toBeInTheDocument();
    expect(screen.queryByText("No identities planned")).not.toBeInTheDocument();

    rerender(
      <EpisodeAssetPlanning
        project="demo"
        selectedCategory="props"
        sceneMenu={[]}
        propMenu={[]}
        labels={labels}
        onPlanIdentities={vi.fn()}
        onPlanScenes={vi.fn()}
        onPlanProps={vi.fn()}
      />,
    );
    expect(screen.getByText("Props not planned")).toBeInTheDocument();
    expect(screen.queryByText("Scenes not planned")).not.toBeInTheDocument();
  });

  it("disables the plan action while planning", () => {
    renderPlanning({ selectedCategory: "scenes", scenePending: true });
    expect(screen.getByText("Scenes not planned")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan scenes" })).toBeDisabled();
  });

  it("blocks scene planning while the global scene catalog is building", () => {
    renderPlanning({
      selectedCategory: "scenes",
      sceneDisabledReason: "Scenes are being built; scene planning will unlock when complete",
    });

    expect(screen.getByText("Scenes are being built; scene planning will unlock when complete")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan scenes" })).toBeDisabled();
  });

  it("blocks identity planning until characters are ready", () => {
    renderPlanning({
      selectedCategory: "identities",
      identityDisabledReason: "Build characters from the knowledge graph first",
    });

    expect(screen.getByText("Build characters from the knowledge graph first")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Plan identities" })).toBeDisabled();
  });

  it("shows planned character identities grouped by character with the default marked", async () => {
    const user = userEvent.setup();
    const onPlanIdentities = vi.fn();
    server.use(
      http.get(
        "http://localhost:3000/api/v1/projects/demo/characters/hero/identities",
        () =>
          HttpResponse.json({
            ok: true,
            data: [
              { identity_id: "hero_young", identity_name: "Young adult" },
              { identity_id: "hero_old", identity_name: "Later years" },
            ],
          }),
      ),
    );

    renderPlanning({
      characters: [{ name: "hero" } as never],
      selectedIdentityIds: ["hero_young"],
      identityDefaultMap: { hero: "hero_young" },
      onPlanIdentities,
    });

    // Only the selected identity is shown, tagged as default; the unselected one is not.
    expect(await screen.findByText("Young adult")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.queryByText("Later years")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Re-plan identities" }));
    expect(onPlanIdentities).toHaveBeenCalledTimes(1);
  });

  it("promotes an episode prop into the global prop library like NiceGUI", async () => {
    const user = userEvent.setup();
    let receivedBody: unknown;
    server.use(
      http.get("http://localhost:3000/api/v1/projects/demo/props", () =>
        HttpResponse.json({
          ok: true,
          data: [{ name: "jade pendant", prop_type: "object" }],
        }),
      ),
      http.post("http://localhost:3000/api/v1/projects/demo/props", async ({ request }) => {
        receivedBody = await request.json();
        return HttpResponse.json({
          ok: true,
          data: {
            name: "bronze mirror",
            prop_type: "artifact",
            visual_prompt: "old bronze mirror with cloud pattern",
            owner: "",
          },
        });
      }),
    );

    renderPlanning({
      selectedCategory: "props",
      propMenu: [
        { prop_id: "jade pendant", prop_type: "object" },
        {
          prop_id: "bronze mirror",
          prop_type: "artifact",
          visual_prompt: "old bronze mirror with cloud pattern",
          description: "fallback description",
          owner_identity_id: "Qin_young_adult",
        },
      ],
    });

    expect(await screen.findByLabelText("Already in global prop library")).toBeInTheDocument();
    await user.click(
      await screen.findByRole("button", {
        name: "Add to global prop library",
      }),
    );

    expect(screen.getByText("Add to global prop library: bronze mirror")).toBeInTheDocument();
    expect(screen.getAllByText("bronze mirror").length).toBeGreaterThan(0);
    expect(screen.getByDisplayValue("old bronze mirror with cloud pattern")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Add to global" }));

    expect(receivedBody).toEqual({
      name: "bronze mirror",
      prop_type: "artifact",
      visual_prompt: "old bronze mirror with cloud pattern",
      owner: "",
    });
  });
});

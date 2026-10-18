// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { describe, expect, it, vi, beforeEach, beforeAll, type Mock } from "vitest";
import type { ReactNode } from "react";

import { enTranslation } from "../../../helpers/i18n-fixtures";

// Local i18n instance: reads public/locales/en/translation.json directly, without the HTTP backend.
// It used to be a hand-copied subset, and a newly added key that was missed made the test fail on "renders the key", so the real one is used.
const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: { en: { translation: enTranslation } },
  });
});

const mutateAsync: Mock = vi.fn().mockResolvedValue({ ok: true, data: null });
const mutate: Mock = vi.fn();
const updateState = { isPending: false };

vi.mock("@/lib/queries/scripts", () => ({
  useUpdateBeat: () => ({
    mutateAsync,
    mutate,
    isPending: updateState.isPending,
  }),
}));

const episodeDetailState: {
  identity_ids: string[];
  prop_menu: { prop_id: string }[];
  scene_menu: {
    scene_id: string;
    base_scene_id?: string;
    variant_id?: string;
    time_of_day?: string;
  }[];
} = { identity_ids: [], prop_menu: [], scene_menu: [] };
vi.mock("@/lib/queries/episodes", () => ({
  useEpisodeDetail: () => ({
    data: {
      ok: true,
      data: {
        number: 1,
        title: "ep1",
        identity_ids: episodeDetailState.identity_ids,
        prop_menu: episodeDetailState.prop_menu,
        scene_menu: episodeDetailState.scene_menu,
      },
    },
  }),
}));

const scenesState: {
  names: string[];
  records?: Array<{
    name: string;
    base_scene_id?: string;
    variant_id?: string;
    time_of_day?: string;
  }>;
} = { names: [] };
vi.mock("@/lib/queries/scenes", () => ({
  useScenes: () => ({
    data: {
      ok: true,
      data: scenesState.records ?? scenesState.names.map((name) => ({ name })),
    },
  }),
  useScenePlatePreview: () => ({
    data: {
      ok: true,
      data: {
        render: {
          label: "Render: will use Bathroom_leak_night, locked lighting",
          status: "time_baked",
          relight: false,
          resolved_scene_name: "Bathroom_leak_night",
          planned_scene_name: "",
        },
      },
    },
  }),
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));

import { TextPane } from "@/components/episode/beat-workbench/text-pane";
import type { Beat } from "@/types/episode";

function Wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={qc}>
      <I18nextProvider i18n={i18n}>{children}</I18nextProvider>
    </QueryClientProvider>
  );
}

function makeBeat(overrides: Partial<Beat> = {}): Beat {
  return {
    beat_number: 1,
    narration_segment: "I came carrying zombie virus samples and fell into the busy street.",
    visual_description: "Busy street under glaring sunlight",
    scene_ref: { scene_id: "Busy Street" },
    time_of_day: "Afternoon",
    audio_type: "narration",
    video_mode: "first_frame",
    video_prompt: "",
    keyframe_prompt: "",
    speaker: "",
    detected_identities: [],
    detected_props: [],
    ...overrides,
  };
}

beforeEach(() => {
  mutateAsync.mockClear();
  mutateAsync.mockResolvedValue({ ok: true, data: null });
  updateState.isPending = false;
  episodeDetailState.identity_ids = [];
  episodeDetailState.prop_menu = [];
  episodeDetailState.scene_menu = [];
  scenesState.names = [];
  scenesState.records = undefined;
});

describe("TextPane", () => {
  it("renders v2 scene fields without legacy staging editors", () => {
    const { container } = render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    expect(screen.getByText("Lines")).toBeInTheDocument();
    expect(screen.getByText("Visual description")).toBeInTheDocument();
    expect(screen.queryByText("Video prompt")).not.toBeInTheDocument();
    expect(screen.queryByText("Keyframe prompt")).not.toBeInTheDocument();
    expect(screen.queryByText(/Fish Speech|fishSpeechPrompt/)).not.toBeInTheDocument();
    expect(screen.getByText("Type")).toBeInTheDocument();
    expect(screen.getByText("Scene")).toBeInTheDocument();
    expect(screen.getByText("Scene variant")).toBeInTheDocument();
    expect(screen.getByText("Time of day")).toBeInTheDocument();
    expect(screen.getByText("Identities")).toBeInTheDocument();
    expect(screen.getByText("Props")).toBeInTheDocument();
    expect(screen.queryByText("More")).not.toBeInTheDocument();
    expect(container.querySelector("details")).not.toBeInTheDocument();
    expect(screen.queryByText(/Set dressing/)).not.toBeInTheDocument();
    expect(screen.queryByText("episode.workbench.text.setScene")).not.toBeInTheDocument();
    expect(screen.queryByText("episode.workbench.text.setProps")).not.toBeInTheDocument();
  });

  it("keeps prompt optimization out of the text editor; SuperPower lives on the sketch workflow", () => {
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ video_mode: "first_frame", video_prompt: "" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(
      screen.queryByRole("button", { name: "AI generate prompt" }),
    ).not.toBeInTheDocument();
  });

  it("keeps no-character option when episode.identity_ids is empty", () => {
    episodeDetailState.identity_ids = [];
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    expect(
      screen.getByRole("button", { name: "No character" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByText("Episode identities not planned. Go to Script page to configure."),
    ).not.toBeInTheDocument();
  });

  it("renders one badge per episode identity and toggles selection", () => {
    episodeDetailState.identity_ids = ["Chen Feng_monk", "Chen Feng_casual_wear"];
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    const group = screen.getByRole("group", { name: "Identities" });
    const buttons = within(group)
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("aria-pressed"));
    expect(buttons).toHaveLength(3);
    expect(buttons[0]).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByText(
        "Identities are not detected or marked. If no character appears, choose \"No character\".",
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Chen Feng_monk" }));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      detected_identities: ["Chen Feng_monk"],
    });
    expect(screen.getByRole("button", { name: "Chen Feng_monk" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByText(
        "Identities are not detected or marked. If no character appears, choose \"No character\".",
      ),
    ).not.toBeInTheDocument();
  });

  it("offers no-character as a mutually exclusive identity option", () => {
    episodeDetailState.identity_ids = ["Chen Feng_monk"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ detected_identities: ["__NO_CHARACTER__"] })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    const noCharacter = screen.getByRole("button", { name: "No character" });
    expect(noCharacter).toHaveAttribute("aria-pressed", "true");

    fireEvent.click(screen.getByRole("button", { name: "Chen Feng_monk" }));
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      detected_identities: ["Chen Feng_monk"],
    });

    fireEvent.click(screen.getByRole("button", { name: "Chen Feng_monk" }));
    expect(mutateAsync.mock.calls[1][0].data).toEqual({
      detected_identities: ["__NO_CHARACTER__"],
    });
  });

  it("renders stale identities (selected but not in episode plan)", () => {
    episodeDetailState.identity_ids = ["Chen Feng_monk"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ detected_identities: ["Chen Feng_monk", "removed_character_id"] })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    const group = screen.getByRole("group", { name: "Identities" });
    const buttons = within(group)
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("aria-pressed"));
    expect(buttons).toHaveLength(3);
    expect(screen.getByText("(removed)")).toBeInTheDocument();
  });

  it("renders episode props and toggles detected_props", () => {
    episodeDetailState.prop_menu = [{ prop_id: "sample_box" }, { prop_id: "jade_sword" }];
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    const group = screen.getByRole("group", { name: "Props" });
    const buttons = within(group)
      .getAllByRole("button")
      .filter((b) => b.hasAttribute("aria-pressed"));
    expect(buttons).toHaveLength(3);

    fireEvent.click(screen.getByRole("button", { name: "sample_box" }));
    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      detected_props: ["sample_box"],
    });
    expect(screen.getByRole("button", { name: "sample_box" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("offers no-prop as a mutually exclusive prop option", () => {
    episodeDetailState.prop_menu = [{ prop_id: "sample_box" }];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ detected_props: ["__NO_PROP__"] })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(screen.getByRole("button", { name: "No prop" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    fireEvent.click(screen.getByRole("button", { name: "sample_box" }));
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      detected_props: ["sample_box"],
    });

    fireEvent.click(screen.getByRole("button", { name: "sample_box" }));
    expect(mutateAsync.mock.calls[1][0].data).toEqual({
      detected_props: ["__NO_PROP__"],
    });
  });

  it("fires audio_type PATCH immediately on select change (no blur needed)", async () => {
    episodeDetailState.identity_ids = [];
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    const trigger = screen.getByRole("combobox", { name: "Type" });
    await user.click(trigger);
    const dialogue = await screen.findByRole("option", { name: "Dialogue" });
    await user.click(dialogue);

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({ audio_type: "dialogue" });
  });

  it("renders narration beats with a read-only narrator label instead of speaker input", () => {
    episodeDetailState.identity_ids = ["Chen Feng_monk"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "narration", speaker: "" })}
          project="demo"
          episode={1}
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    expect(screen.getByText("Narrator")).toBeInTheDocument();
    expect(screen.getByText("Project narrator")).toBeInTheDocument();
    expect(screen.queryByText("Speaker")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Identity ID (e.g. Chen_monk), required for dialogue"),
    ).not.toBeInTheDocument();
  });

  it("does not show narrator speaker semantics for drama narration", () => {
    episodeDetailState.identity_ids = ["Chen Feng_monk"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "narration", speaker: "" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(screen.queryByText("Narrator")).not.toBeInTheDocument();
    expect(screen.queryByText("Project narrator")).not.toBeInTheDocument();
    expect(screen.queryByText("Speaker")).not.toBeInTheDocument();
  });

  it("does not show speaker controls for drama dialogue", () => {
    episodeDetailState.identity_ids = ["Chen Feng_monk"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "dialogue", speaker: "Chen Feng_monk" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(screen.queryByText("Speaker")).not.toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText("Identity ID (e.g. Chen_monk), required for dialogue"),
    ).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Speaker" })).not.toBeInTheDocument();
  });

  it("renders dialogue speaker as a single-select sourced from episode identities", async () => {
    episodeDetailState.identity_ids = ["Chen Feng_monk", "Lu Chen_young_adult"];
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "dialogue", speaker: "Chen Feng_monk" })}
          project="demo"
          episode={1}
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    const speaker = screen.getByRole("combobox", { name: "Speaker" });
    expect(speaker).toHaveTextContent("Chen Feng_monk");

    await user.click(speaker);
    expect(await screen.findByRole("option", { name: "Lu Chen_Young adult" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "old_value_not_in_this_eps" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("option", { name: "Lu Chen_Young adult" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({ speaker: "Lu Chen_young_adult" });
  });

  it("clears stale speaker when switching drama beats to dialogue", async () => {
    episodeDetailState.identity_ids = ["Chen Feng_monk"];
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "narration", speaker: "Chen Feng_monk" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Dialogue" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      audio_type: "dialogue",
      speaker: "",
    });
    expect(screen.queryByText("Speaker")).not.toBeInTheDocument();
  });

  it("hides speaker controls for silence beats and clears speaker when switching away from dialogue", async () => {
    episodeDetailState.identity_ids = ["Chen Feng_monk"];
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "dialogue", speaker: "Chen Feng_monk" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "Type" }));
    await user.click(await screen.findByRole("option", { name: "Silence" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      audio_type: "silence",
      speaker: "",
    });
    expect(screen.queryByText("Speaker")).not.toBeInTheDocument();
    expect(screen.queryByText("Narrator")).not.toBeInTheDocument();
  });

  it("supports the NiceGUI silence audio type", async () => {
    episodeDetailState.identity_ids = [];
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    const trigger = screen.getByRole("combobox", { name: "Type" });
    await user.click(trigger);
    const silence = await screen.findByRole("option", { name: "Silence" });
    await user.click(silence);

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({ audio_type: "silence" });
  });

  it("hides silence from narrated project audio type choices", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ audio_type: "narration" })}
          project="demo"
          episode={1}
          spineTemplate="narrated"
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "Type" }));

    expect(screen.queryByRole("option", { name: "Silence" })).not.toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Type" })).toHaveTextContent("Narration");
  });

  it("edits time_of_day with the shared closed choices", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ time_of_day: "Afternoon" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "Time of day" }));
    await user.click(await screen.findByRole("option", { name: "Night" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({ time_of_day: "night" });
  });

  it("shows non-standard time_of_day as a legacy choice and can clear it", async () => {
    const user = userEvent.setup();
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ time_of_day: "midnight" })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(screen.getByRole("combobox", { name: "Time of day" })).toHaveTextContent(
      "midnight (as written in the script)",
    );

    await user.click(screen.getByRole("combobox", { name: "Time of day" }));
    await user.click(
      await screen.findByRole("option", {
        name: "None (keep the scene's lighting, no relight)",
      }),
    );

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({ time_of_day: "" });
  });

  it("edits scene_ref scene id and clears current variant", async () => {
    const user = userEvent.setup();
    scenesState.names = ["Busy Street", "Forest"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ scene_ref: { scene_id: "Busy Street", variant_id: "Rainy Night" } })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    // This used to also assert that "scene variant" does not appear. That assertion had been a no-op ever since the label was renamed: the local
    // i18n copied the old value "variant", so looking up "scene variant" naturally found nothing. It only showed up after switching to the real entries -
    // the beat carries variant_id: "Rainy Night", so the variant selector should be there. What really needs verifying is that after switching scenes
    // variant_id is cleared, which the assertion below already watches.
    // Scene is now a base-scene dropdown sourced from the episode scene menu.
    await user.click(screen.getByRole("combobox", { name: "Scene" }));
    await user.click(await screen.findByRole("option", { name: "Forest" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      scene_ref: { scene_id: "Forest", variant_id: "" },
    });
  });

  it("writes canonical base and variant when selecting an underscore scene", async () => {
    const user = userEvent.setup();
    scenesState.names = ["Bathroom", "Bathroom_leak"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ scene_ref: { scene_id: "Bathroom" } })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "Scene variant" }));
    await user.click(await screen.findByRole("option", { name: "leak" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      scene_ref: { scene_id: "Bathroom", variant_id: "leak" },
    });
  });

  it("filters time-version scene plates out of the scene selector", async () => {
    const user = userEvent.setup();
    scenesState.records = [
      { name: "Bathroom", base_scene_id: "", variant_id: "", time_of_day: "" },
      { name: "Bathroom_leak", base_scene_id: "Bathroom", variant_id: "leak", time_of_day: "" },
      {
        name: "Bathroom_leak_night",
        base_scene_id: "Bathroom",
        variant_id: "leak",
        time_of_day: "night",
      },
    ];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ scene_ref: { scene_id: "Bathroom" } })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "Scene variant" }));
    expect(
      screen.queryByRole("option", { name: "leak_night" }),
    ).not.toBeInTheDocument();
    await user.click(await screen.findByRole("option", { name: "leak" }));

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      scene_ref: { scene_id: "Bathroom", variant_id: "leak" },
    });
  });

  it("shows the composed scene name when the beat has a scene variant", () => {
    scenesState.names = ["Bathroom", "Bathroom_leak"];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ scene_ref: { scene_id: "Bathroom", variant_id: "leak" } })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(screen.getByRole("combobox", { name: "Scene" })).toHaveTextContent("Bathroom");
    expect(screen.getByRole("combobox", { name: "Scene variant" })).toHaveTextContent("leak");
    expect(screen.getByText("Render: will use Bathroom_leak_night, locked lighting")).toBeInTheDocument();
  });

  it("does not duplicate scene saves on unmount with an explicit empty variant", async () => {
    const user = userEvent.setup();
    scenesState.names = ["Busy Street", "Forest"];
    const { unmount } = render(
      <Wrapper>
        <TextPane
          beat={makeBeat({ scene_ref: { scene_id: "Busy Street", variant_id: "Rainy Night" } })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "Scene" }));
    await user.click(await screen.findByRole("option", { name: "Forest" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    mutateAsync.mockClear();

    unmount();

    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("does not duplicate canonical scene saves on unmount", async () => {
    const user = userEvent.setup();
    scenesState.records = [];
    const beat = makeBeat({ scene_ref: { scene_id: "Bathroom", variant_id: "" } });
    const { rerender, unmount } = render(
      <Wrapper>
        <TextPane beat={beat} project="demo" episode={1} />
      </Wrapper>,
    );

    scenesState.records = [
      { name: "Bathroom", base_scene_id: "", variant_id: "", time_of_day: "" },
      {
        name: "Bathroom_leak_severe",
        base_scene_id: "Bathroom",
        variant_id: "leak_severe",
        time_of_day: "",
      },
    ];
    rerender(
      <Wrapper>
        <TextPane beat={beat} project="demo" episode={1} />
      </Wrapper>,
    );

    await user.click(screen.getByRole("combobox", { name: "Scene variant" }));
    await user.click(await screen.findByRole("option", { name: "leak_severe" }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      scene_ref: { scene_id: "Bathroom", variant_id: "leak_severe" },
    });
    mutateAsync.mockClear();

    unmount();

    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("does not PATCH when textarea blur value is unchanged", () => {
    episodeDetailState.identity_ids = [];
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    const narration = screen.getByDisplayValue("I came carrying zombie virus samples and fell into the busy street.");
    fireEvent.blur(narration);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("does not PATCH on unmount when mention options load without user edits", () => {
    episodeDetailState.identity_ids = [];
    const beat = makeBeat({
      visual_description: "@Lu Chen_young_adult picks up the jade pendant",
      detected_identities: [],
    });
    const { rerender, unmount } = render(
      <Wrapper>
        <TextPane beat={beat} project="demo" episode={1} />
      </Wrapper>,
    );

    episodeDetailState.identity_ids = ["Lu Chen_young_adult"];
    rerender(
      <Wrapper>
        <TextPane beat={beat} project="demo" episode={1} />
      </Wrapper>,
    );
    unmount();

    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("uses latest mention options when flushing a dirty visual draft on unmount", () => {
    episodeDetailState.identity_ids = [];
    const beat = makeBeat({ visual_description: "Original visual" });
    const { rerender, unmount } = render(
      <Wrapper>
        <TextPane beat={beat} project="demo" episode={1} />
      </Wrapper>,
    );

    fireEvent.change(screen.getByDisplayValue("Original visual"), {
      target: { value: "@Lu Chen_young_adult picks up the jade pendant" },
    });
    episodeDetailState.identity_ids = ["Lu Chen_young_adult"];
    rerender(
      <Wrapper>
        <TextPane beat={beat} project="demo" episode={1} />
      </Wrapper>,
    );
    unmount();

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      visual_description: "{{Lu Chen_young_adult}} picks up the jade pendant",
      detected_identities: ["Lu Chen_young_adult"],
    });
  });

  it("converts visual @ mentions to program markers and syncs detected references", () => {
    episodeDetailState.identity_ids = ["Lu Chen_young_adult"];
    episodeDetailState.prop_menu = [{ prop_id: "jade pendant" }];
    render(
      <Wrapper>
        <TextPane beat={makeBeat()} project="demo" episode={1} />
      </Wrapper>,
    );

    const visual = screen.getByDisplayValue("Busy street under glaring sunlight");
    fireEvent.change(visual, { target: { value: "@Lu Chen_young_adult picks up @jade pendant" } });
    fireEvent.blur(visual);

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    expect(mutateAsync.mock.calls[0][0].data).toEqual({
      visual_description: "{{Lu Chen_young_adult}} picks up [[jade pendant]]",
      detected_identities: ["Lu Chen_young_adult"],
      detected_props: ["jade pendant"],
    });
  });

  it("renders stored program markers as user-facing @ mentions", () => {
    episodeDetailState.identity_ids = ["Lu Chen_young_adult"];
    episodeDetailState.prop_menu = [{ prop_id: "jade pendant" }];
    render(
      <Wrapper>
        <TextPane
          beat={makeBeat({
            visual_description: "{{Lu Chen_young_adult}} picks up [[jade pendant]]",
          })}
          project="demo"
          episode={1}
        />
      </Wrapper>,
    );

    expect(screen.getByDisplayValue("@Lu Chen_young_adult picks up @jade pendant")).toBeInTheDocument();
  });
});

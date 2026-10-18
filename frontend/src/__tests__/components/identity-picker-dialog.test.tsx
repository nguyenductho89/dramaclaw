// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider, initReactI18next } from "react-i18next";
import i18next from "i18next";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const i18n = i18next.createInstance();

beforeAll(async () => {
  await i18n.use(initReactI18next).init({
    lng: "en",
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    resources: {
      en: {
        translation: {
          common: { cancel: "Cancel", save: "Save" },
          identityPicker: {
            title: "Select Character Identities",
            empty: "No characters yet. Create characters and identities on the Characters page first.",
            aiPlan: "AI Plan Identities",
            defaultIdentity: "Default",
          },
        },
      },
    },
  });
});

const identitiesByCharacter = vi.hoisted(
  (): {
    data: Record<string, Array<{ identity_id: string; identity_name: string }>>;
  } => ({
    data: {
      Qin: [
        { identity_id: "Qin_child", identity_name: "Child" },
        { identity_id: "Qin_young_adult", identity_name: "Young adult" },
      ],
    },
  }),
);

vi.mock("@/lib/queries/characters", () => ({
  useCharacterIdentities: (_project: string, character: string) => ({
    data: { ok: true, data: identitiesByCharacter.data[character] ?? [] },
  }),
}));

import { IdentityPickerDialog } from "@/components/identity-picker-dialog";

function Wrapper({ children }: { children: ReactNode }) {
  return <I18nextProvider i18n={i18n}>{children}</I18nextProvider>;
}

describe("IdentityPickerDialog", () => {
  it("saves episode default identity map together with selected identities", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();

    render(
      <Wrapper>
        <IdentityPickerDialog
          open
          onOpenChange={vi.fn()}
          project="demo"
          characters={[{ name: "Qin" }]}
          selected={["Qin_child", "Qin_young_adult"]}
          defaultMap={{ Qin: "Qin_child" }}
          onChange={onChange}
          onPlan={vi.fn()}
          planPending={false}
        />
      </Wrapper>,
    );

    await user.click(screen.getByRole("radio", { name: "Young adult Default" }));
    await user.click(screen.getByRole("button", { name: "Save" }));

    expect(onChange).toHaveBeenCalledWith(
      ["Qin_child", "Qin_young_adult"],
      { Qin: "Qin_young_adult" },
    );
  });
});

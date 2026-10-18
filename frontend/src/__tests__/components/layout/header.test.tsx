// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { cloneElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { Header } from "@/components/layout/header";

const runtimeState = vi.hoisted(() => ({ authRequired: true, isCe: false, phoneVisible: false }));
const authState = vi.hoisted(() => ({ username: "local", logout: vi.fn() }));
const resetUserSessionStateMock = vi.hoisted(() => vi.fn());
const securityState = vi.hoisted(() => ({
  data: undefined as
    | undefined
    | { password_configured: boolean; phone: string | null; phone_masked: string | null },
}));
const brandingState = vi.hoisted(() => ({
  enabled: null as boolean | null,
  data: undefined as undefined | {
    schema_version: 1;
    organization: { org_id: string; name: string };
    branding: { logo_url: string; updated_at: string };
  },
}));

vi.mock("@/lib/reset-region-state", () => ({
  resetUserSessionState: resetUserSessionStateMock,
}));

vi.mock("@/lib/runtime-config", () => ({
  authRequired: () => runtimeState.authRequired,
  isCeRuntime: () => runtimeState.isCe,
  phoneOtpEntryVisible: () => runtimeState.phoneVisible,
}));

vi.mock("@/lib/queries/model-gateway", () => ({
  useModelGatewayConfig: () => ({ data: undefined }),
}));

vi.mock("@/components/settings/settings-dialog", () => ({
  SettingsDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Settings dialog</div> : null,
}));

vi.mock("@/lib/queries/auth", () => ({
  useAccountSecurity: () => securityState,
}));

vi.mock("@/lib/queries/org-branding", () => ({
  useOrgBranding: (enabled: boolean) => {
    brandingState.enabled = enabled;
    return { data: brandingState.data };
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: React.ComponentProps<"a"> & { to?: string }) => (
    <a href={to} {...props}>{children}</a>
  ),
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useRouterState: ({ select }: { select: (state: { location: { pathname: string } }) => string }) =>
    select({ location: { pathname: "/" } }),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "app.logoHomeTooltip": "Home",
        "header.settings": "Settings",
        "header.account.open": "Open account",
        "header.notifications": "Announcement Center",
        "header.account.changeAvatar": "Change avatar",
        "header.account.changePassword": "Change password",
        "header.account.setPassword": "Set password",
        "header.account.phoneBinding.title": "Bind phone",
        "header.account.selectLanguage": "Select language",
        "header.account.languageChinese": "Chinese",
        "header.account.languageEnglish": "English",
        "auth.logout": "Log out",
      })[key] ?? key,
    i18n: {
      language: "en",
      resolvedLanguage: "en",
      changeLanguage: vi.fn(),
    },
  }),
}));

vi.mock("@/stores/auth-store", () => ({
  useAuthStore: () => authState,
}));

vi.mock("@/stores/app-store", () => ({
  useAppStore: () => vi.fn(),
}));

vi.mock("@/components/layout/credit-balance-badge", () => ({
  CreditBalanceBadge: () => <div data-testid="credit-balance" />,
}));

vi.mock("@/components/task-center/header-entry", () => ({
  HeaderEntry: () => <button type="button">Tasks</button>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  TooltipProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({
    children,
    render,
  }: React.PropsWithChildren<{ render?: React.ReactElement }>) =>
    render ? cloneElement(render, {}, children) : <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuGroup: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DropdownMenuLabel: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DropdownMenuSeparator: () => <hr />,
  DropdownMenuItem: ({ children, ...props }: React.ComponentProps<"button">) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

function renderHeader() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Header />
    </QueryClientProvider>,
  );
}

describe("Header runtime gating", () => {
  beforeEach(() => {
    runtimeState.authRequired = true;
    runtimeState.isCe = false;
    runtimeState.phoneVisible = false;
    authState.username = "local";
    authState.logout.mockReset();
    resetUserSessionStateMock.mockReset();
    brandingState.enabled = null;
    brandingState.data = undefined;
    securityState.data = undefined;
  });

  it("reads branding only for an authenticated EE session and renders it in the home link", () => {
    brandingState.data = {
      schema_version: 1,
      organization: { org_id: "org-1", name: "Claymore" },
      branding: {
        logo_url: "/assets/org-brand/org-1/logo",
        updated_at: "2026-08-21T10:00:00Z",
      },
    };

    renderHeader();

    expect(brandingState.enabled).toBe(true);
    expect(screen.getByRole("link", { name: "Home — Claymore" })).toBeInTheDocument();
    expect(screen.queryByRole("img", { name: "Claymore" })).not.toBeInTheDocument();

    fireEvent.error(screen.getByTestId("organization-brand").querySelector("img")!);
    expect(screen.queryByTestId("organization-brand")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Home — Claymore" })).toBeInTheDocument();
  });

  it("disables branding in CE", () => {
    runtimeState.isCe = true;
    renderHeader();
    expect(brandingState.enabled).toBe(false);
  });

  it("keeps the settings entry available in EE runtime", () => {
    runtimeState.isCe = false;

    renderHeader();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    expect(screen.getByRole("dialog")).toHaveTextContent("Settings dialog");
  });

  it("renders logout in the account panel when runtime requires auth", async () => {
    renderHeader();

    fireEvent.mouseEnter(screen.getByLabelText("Open account").parentElement!);

    expect(await screen.findByText("Log out")).toBeInTheDocument();
    expect(screen.getByText("Change password")).toBeInTheDocument();
  });

  it("shows a masked phone and first-password action for a passwordless account", async () => {
    securityState.data = {
      password_configured: false,
      phone: "+8613800138000",
      phone_masked: "138****8000",
    };
    renderHeader();

    fireEvent.mouseEnter(screen.getByLabelText("Open account").parentElement!);

    expect(await screen.findByText("138****8000")).toBeInTheDocument();
    expect(screen.getByText("Set password")).toBeInTheDocument();
  });

  it.each([false, true])("gates first phone binding on phone entry visibility (%s)", async (visible) => {
    runtimeState.phoneVisible = visible;
    securityState.data = { password_configured: true, phone: null, phone_masked: null };
    renderHeader();
    fireEvent.mouseEnter(screen.getByLabelText("Open account").parentElement!);
    await screen.findByText("Log out");
    expect(screen.queryByText("Bind phone") !== null).toBe(visible);
  });

  it("does not offer replacing an existing phone", async () => {
    runtimeState.phoneVisible = true;
    securityState.data = { password_configured: true, phone: "+8613800138000", phone_masked: "138****8000" };
    renderHeader();
    fireEvent.mouseEnter(screen.getByLabelText("Open account").parentElement!);
    await screen.findByText("Log out");
    expect(screen.queryByText("Bind phone")).not.toBeInTheDocument();
  });

  it("moves the announcement entry from the header actions into the account panel", async () => {
    renderHeader();

    expect(screen.queryByRole("button", { name: "Announcement Center" })).not.toBeInTheDocument();

    fireEvent.mouseEnter(screen.getByLabelText("Open account").parentElement!);

    expect(
      await screen.findByRole("button", { name: "Announcement Center" }),
    ).toBeInTheDocument();
  });

  // Regression case: after the standalone announcement button was removed, the account avatar became the only entry to the announcement center. It was bound only to
  // onMouseEnter -- touch screens have no hover and keyboards cannot activate it, so the announcement center effectively vanished for those users.
  it("opens the account panel on click so the announcement entry survives without hover", async () => {
    const user = userEvent.setup();
    renderHeader();

    const trigger = screen.getByLabelText("Open account");
    expect(trigger).toHaveAttribute("aria-expanded", "false");

    await user.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(
      await screen.findByRole("button", { name: "Announcement Center" }),
    ).toBeInTheDocument();
  });

  it("opens with the keyboard, lands focus inside the panel and closes on Escape", async () => {
    const user = userEvent.setup();
    renderHeader();

    const trigger = screen.getByLabelText("Open account");
    trigger.focus();
    await user.keyboard("{Enter}");

    // The panel is portaled to the end of body and Tab cannot reach it, so on open focus must be moved to the first item explicitly.
    expect(await screen.findByRole("button", { name: "Announcement Center" })).toHaveFocus();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Announcement Center" }),
      ).not.toBeInTheDocument();
    });
    expect(trigger).toHaveFocus();
  });

  it("closes the pinned panel on a second click and on an outside pointer press", async () => {
    const user = userEvent.setup();
    renderHeader();

    const trigger = screen.getByLabelText("Open account");

    await user.click(trigger);
    await screen.findByRole("button", { name: "Announcement Center" });
    await user.click(trigger);
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Announcement Center" }),
      ).not.toBeInTheDocument();
    });

    await user.click(trigger);
    await screen.findByRole("button", { name: "Announcement Center" });
    fireEvent.pointerDown(document.body);
    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "Announcement Center" }),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps a click-opened panel open when the pointer leaves it", async () => {
    const user = userEvent.setup();
    renderHeader();

    const trigger = screen.getByLabelText("Open account");
    await user.click(trigger);
    await screen.findByRole("button", { name: "Announcement Center" });

    // A panel opened by hover closes when the pointer leaves; one pinned by click must not be closed by mouseleave,
    // otherwise on touch screens the content vanishes as soon as the finger lifts.
    fireEvent.mouseLeave(trigger.parentElement!);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Announcement Center" })).toBeInTheDocument();
    });
  });

  it("hides logout when runtime does not require auth while keeping the local identity", async () => {
    runtimeState.authRequired = false;

    renderHeader();

    fireEvent.mouseEnter(screen.getByLabelText("Open account").parentElement!);

    await waitFor(() => {
      expect(screen.getByText("local")).toBeInTheDocument();
    });
    expect(screen.queryByText("Log out")).not.toBeInTheDocument();
    expect(screen.queryByText("Change password")).not.toBeInTheDocument();
  });

  it("purges user-scoped caches after logout so the next account can't see stale data", async () => {
    // Regression case: manual logout is an in-SPA navigation, and if the QueryClient is not cleared, after logging in with another account
    // projectSummaries is still within staleTime and the new account would see the previous account's project list.
    authState.logout.mockResolvedValue(undefined);

    renderHeader();

    fireEvent.mouseEnter(screen.getByLabelText("Open account").parentElement!);
    fireEvent.click(await screen.findByText("Log out"));

    await waitFor(() => {
      expect(resetUserSessionStateMock).toHaveBeenCalled();
    });
    expect(authState.logout).toHaveBeenCalled();
  });

});

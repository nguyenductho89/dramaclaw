// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HTTPError, type NormalizedOptions } from "ky";
import { toast } from "sonner";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ShareProjectDialog } from "@/components/projects/share-project-dialog";
import { MAX_PROJECT_GRANTS } from "@/lib/limits";
import type { ProjectSummary } from "@/types/project";

const SHARE_DIALOG_ZH: Record<string, string> = {
  "project.shareDialog.title": "Share project",
  "project.shareDialog.descriptionWithOwner": "{{name}} · {{owner}}",
  "project.shareDialog.descriptionFallback": "Manage project members",
  "project.shareDialog.currentUserFallback": "current user",
  "project.shareDialog.addMember": "Add member",
  "project.shareDialog.addMemberHint": "Enter a username, choose a role, then add them to the project.",
  "project.shareDialog.copyLink": "Copy link",
  "project.shareDialog.searchPlaceholder": "Search username",
  "project.shareDialog.alreadyInProject": "Already in project",
  "project.shareDialog.add": "Add",
  "project.shareDialog.members": "Members",
  "project.shareDialog.owner": "Owner",
  "project.shareDialog.projectOwner": "Project owner",
  "project.shareDialog.loadingMembers": "Loading members",
  "project.shareDialog.removeMember": "Remove member",
  "project.shareDialog.roleViewer": "View only",
  "project.shareDialog.roleEditor": "Can edit and run tasks",
  "project.shareDialog.roleAdmin": "Can manage shared members",
  "project.shareDialog.inactive": "Inactive",
  "project.shareDialog.inactiveAccessChanged": "User currently cannot access this project",
  "project.shareDialog.limitReached": "You can share with at most {{limit}} people",
  "project.shareDialog.limitTitle": "Share limit reached",
  "project.shareDialog.noShareableUser": "No shareable user found. This user may be outside this project's sharing scope.",
  "project.shareDialog.quotaUnknownTitle": "Member count not available yet",
  "project.shareDialog.quotaUnknown": "The member list is still loading. Try again once it finishes.",
  "project.shareDialog.memberCount": "{{count}}/{{limit}}",
  "project.shareDialog.toastMemberUpdated": "Shared member updated",
  "project.shareDialog.toastShareFailed": "Share failed. Confirm the user exists and you have permission.",
  "project.shareDialog.toastUserNotFound": "User not found",
  "project.shareDialog.toastUserOutOfScope": "This user is outside this project's sharing scope.",
  "common.close": "Close",
};

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      let value = SHARE_DIALOG_ZH[key] ?? key;
      if (options) {
        for (const [optKey, optValue] of Object.entries(options)) {
          value = value.split(`{{${optKey}}}`).join(String(optValue));
        }
      }
      return value;
    },
  }),
}));

type NoticeOptions = { title?: string; description: string };

const alertDialogMock = vi.hoisted(() =>
  vi.fn((_options: { title?: string; description: string }) => Promise.resolve()),
);
const toastMock = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock("@/components/confirm-dialog-host", () => ({
  alertDialog: (options: NoticeOptions) => alertDialogMock(options),
  confirmDialog: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("sonner", () => ({
  toast: toastMock,
}));

const runtimeState = vi.hoisted(() => ({ isCeRuntime: false }));
const queryMocks = vi.hoisted(() => ({
  grants: [] as Array<Record<string, unknown>>,
  grantsLoading: false,
  grantsError: false,
  searchResults: [] as Array<{ id: string; username: string }>,
  userSearchSuccess: false,
  deleteGrant: vi.fn(),
  useUserSearch: vi.fn(),
}));
const addGrantMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/runtime-config", () => ({
  isCeRuntime: () => runtimeState.isCeRuntime,
}));

vi.mock("@/lib/queries/projects", () => ({
  useProjectGrants: () =>
    queryMocks.grantsLoading
      ? { data: undefined, isLoading: true, isError: false }
      : {
          data: { data: queryMocks.grants },
          isLoading: false,
          // When a refresh fails React Query keeps the previous list, and status goes to error.
          isError: queryMocks.grantsError,
        },
  useUserSearch: (...args: unknown[]) => {
    queryMocks.useUserSearch(...args);
    return {
      data: { data: queryMocks.searchResults },
      isSuccess: queryMocks.userSearchSuccess,
    };
  },
  useAddProjectGrant: () => ({ mutateAsync: addGrantMock, isPending: false }),
  useUpdateProjectGrant: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteProjectGrant: () => ({
    mutateAsync: queryMocks.deleteGrant,
    isPending: false,
  }),
}));

const project = {
  id: "p1",
  name: "Demo",
  ownerUsername: "alice",
  effectiveRole: "owner",
} as ProjectSummary;

function renderDialog() {
  return render(
    <ShareProjectDialog project={project} open onOpenChange={() => {}} />,
  );
}

async function selectSearchResult(username = "huangjiao") {
  await userEvent.type(screen.getByPlaceholderText("Search username"), username);
  await userEvent.click(screen.getByRole("button", { name: username }));
}

function httpError(status: number, body: unknown) {
  const request = new Request("https://example.test/project-grants", { method: "POST" });
  const response = new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
  const options = {
    context: {},
    method: "POST",
    onDownloadProgress: undefined,
    onUploadProgress: undefined,
    prefix: "",
    retry: {},
  } as NormalizedOptions;
  return new HTTPError(response, request, options);
}

async function httpErrorWithConsumedBodyData(status: number, body: unknown) {
  const error = httpError(status, body);
  error.data = body;
  await error.response.text();
  return error;
}

function resetShareDialogMocks() {
  runtimeState.isCeRuntime = false;
  queryMocks.grants = [];
  queryMocks.grantsLoading = false;
  queryMocks.grantsError = false;
  queryMocks.searchResults = [];
  queryMocks.userSearchSuccess = false;
  queryMocks.deleteGrant.mockReset();
  queryMocks.useUserSearch.mockClear();
  addGrantMock.mockReset();
  alertDialogMock.mockClear();
  toastMock.error.mockClear();
  toastMock.success.mockClear();
}

describe("ShareProjectDialog (edition gating)", () => {
  beforeEach(() => {
    resetShareDialogMocks();
  });

  it("renders the share dialog in EE runtime", () => {
    renderDialog();
    expect(screen.getByText("Share project")).toBeInTheDocument();
    expect(queryMocks.useUserSearch).toHaveBeenCalledWith("p1", "");
  });

  it("renders nothing in CE runtime", () => {
    runtimeState.isCeRuntime = true;
    const { container } = renderDialog();
    expect(container.firstChild).toBeNull();
    expect(screen.queryByText("Share project")).not.toBeInTheDocument();
  });

  it("marks ineffective grants inactive while keeping removal available", () => {
    queryMocks.grants = [
      {
        id: "g1",
        project_id: "p1",
        principal_type: "user",
        principal_id: "u9",
        principal_username: "dev09",
        role: "editor",
        effective: false,
        inactive_reason: "principal_access_changed",
      },
    ];

    renderDialog();

    expect(screen.getByText("Inactive")).toBeInTheDocument();
    expect(screen.getByText("User currently cannot access this project")).toBeInTheDocument();
    const memberRow = screen.getByText("dev09").parentElement?.parentElement;
    expect(memberRow).toBeInstanceOf(HTMLElement);
    expect(within(memberRow as HTMLElement).getByRole("combobox")).toBeDisabled();
    expect(
      within(memberRow as HTMLElement).getByRole("button", { name: "Remove member" }),
    ).toBeEnabled();
  });

  it("treats grants without effective as active during rolling deploys", () => {
    queryMocks.grants = [
      {
        id: "g1",
        project_id: "p1",
        principal_type: "user",
        principal_id: "u9",
        principal_username: "dev09",
        role: "editor",
      },
    ];

    renderDialog();

    expect(screen.queryByText("Inactive")).not.toBeInTheDocument();
    const memberRow = screen.getByText("dev09").parentElement?.parentElement;
    expect(memberRow).toBeInstanceOf(HTMLElement);
    expect(within(memberRow as HTMLElement).getByRole("combobox")).toBeEnabled();
  });
});

describe("ShareProjectDialog (user selection)", () => {
  beforeEach(() => {
    resetShareDialogMocks();
  });

  it("shows a local scope hint and cannot submit when search succeeds with no users", async () => {
    queryMocks.userSearchSuccess = true;
    renderDialog();

    await userEvent.type(screen.getByPlaceholderText("Search username"), "nobody");

    expect(screen.getByText("No shareable user found. This user may be outside this project's sharing scope.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add/ })).toBeDisabled();
    expect(addGrantMock).not.toHaveBeenCalled();
  });

  it("submits only the user chosen from the result list", async () => {
    queryMocks.searchResults = [{ id: "u2", username: "huangjiao" }];
    renderDialog();

    await selectSearchResult();
    await userEvent.click(screen.getByRole("button", { name: /Add/ }));

    expect(addGrantMock).toHaveBeenCalledWith({ principal_username: "huangjiao", role: "editor" });
  });

  it("reports an out-of-scope user from Ky data when the response body is consumed", async () => {
    queryMocks.searchResults = [{ id: "u2", username: "huangjiao" }];
    addGrantMock.mockRejectedValue(
      await httpErrorWithConsumedBodyData(403, {
        detail: { code: "project_share_scope_mismatch" },
      }),
    );
    renderDialog();

    await selectSearchResult();
    await userEvent.click(screen.getByRole("button", { name: /Add/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("This user is outside this project's sharing scope.");
    });
    expect(toast.error).not.toHaveBeenCalledWith("Share failed. Confirm the user exists and you have permission.");
  });

  it("clears a selected user when switching projects without unmounting", async () => {
    const projectB = {
      ...project,
      id: "p2",
      name: "Next Demo",
      ownerUsername: "beatrice",
    } as ProjectSummary;
    queryMocks.searchResults = [{ id: "u2", username: "huangjiao" }];
    const { rerender } = renderDialog();

    await selectSearchResult();
    expect(screen.getByPlaceholderText("Search username")).toHaveValue("huangjiao");
    expect(screen.getByRole("button", { name: /Add/ })).toBeEnabled();

    rerender(<ShareProjectDialog project={projectB} open onOpenChange={() => {}} />);

    expect(screen.getByPlaceholderText("Search username")).toHaveValue("");
    expect(screen.getByRole("button", { name: /Add/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /Add/ }));
    expect(addGrantMock).not.toHaveBeenCalled();
  });

  it("reports a missing user from a 404 response", async () => {
    queryMocks.searchResults = [{ id: "u2", username: "huangjiao" }];
    addGrantMock.mockRejectedValue(httpError(404, { detail: "not found" }));
    renderDialog();

    await selectSearchResult();
    await userEvent.click(screen.getByRole("button", { name: /Add/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("User not found");
    });
  });

  it("keeps the generic share failure message for unexpected errors", async () => {
    queryMocks.searchResults = [{ id: "u2", username: "huangjiao" }];
    addGrantMock.mockRejectedValue(new Error("network down"));
    renderDialog();

    await selectSearchResult();
    await userEvent.click(screen.getByRole("button", { name: /Add/ }));

    await waitFor(() => {
      expect(toast.error).toHaveBeenCalledWith("Share failed. Confirm the user exists and you have permission.");
    });
  });
});

function grantRows(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `g${index}`,
    principal_id: `u${index}`,
    principal_username: `user${index}`,
    role: "editor",
  }));
}

describe("ShareProjectDialog (share quota)", () => {
  beforeEach(() => {
    resetShareDialogMocks();
  });

  it("keeps the add button usable below the limit", async () => {
    queryMocks.grants = grantRows(MAX_PROJECT_GRANTS - 1);
    queryMocks.searchResults = [{ id: "u99", username: "huangjiao" }];
    renderDialog();

    await selectSearchResult();

    expect(screen.getByRole("button", { name: /Add/ })).toBeEnabled();
    expect(screen.queryByText(`You can share with at most ${MAX_PROJECT_GRANTS} people`)).not.toBeInTheDocument();
  });

  it("keeps the add button clickable at the limit and explains itself in a dialog", async () => {
    queryMocks.grants = grantRows(MAX_PROJECT_GRANTS);
    queryMocks.searchResults = [{ id: "u99", username: "huangjiao" }];
    renderDialog();

    await selectSearchResult();
    const addButton = screen.getByRole("button", { name: /Add/ });

    // A dead button cannot explain itself; a clickable one gives a place to explain.
    expect(addButton).toBeEnabled();
    await userEvent.click(addButton);

    expect(addGrantMock).not.toHaveBeenCalled();
    expect(alertDialogMock).toHaveBeenCalledTimes(1);
    expect(alertDialogMock.mock.calls[0][0]).toMatchObject({
      title: "Share limit reached",
      description: `You can share with at most ${MAX_PROJECT_GRANTS} people`,
    });
    expect(screen.getByText(`You can share with at most ${MAX_PROJECT_GRANTS} people`)).toBeInTheDocument();
  });

  it("refuses to add while the member list is still loading", async () => {
    // When the list has not come back it is empty, and letting it through treats "unknown how many" as "none at all".
    // The grants endpoint does not count heads, so this add would really be the 26th.
    queryMocks.grantsLoading = true;
    queryMocks.searchResults = [{ id: "u99", username: "huangjiao" }];
    renderDialog();

    await selectSearchResult();
    await userEvent.click(screen.getByRole("button", { name: /Add/ }));

    expect(addGrantMock).not.toHaveBeenCalled();
    expect(alertDialogMock).toHaveBeenCalledTimes(1);
    expect(alertDialogMock.mock.calls[0][0]).toMatchObject({
      title: "Member count not available yet",
      description: "The member list is still loading. Try again once it finishes.",
    });
  });

  it("refuses to add when the last member refresh failed", async () => {
    // When a refresh fails the old list is still there (React Query keeps data, status goes to error).
    // Continuing to let things through on this possibly stale count could make the added member the 26th.
    queryMocks.grants = grantRows(MAX_PROJECT_GRANTS - 1);
    queryMocks.grantsError = true;
    queryMocks.searchResults = [{ id: "u99", username: "huangjiao" }];
    renderDialog();

    await selectSearchResult();
    await userEvent.click(screen.getByRole("button", { name: /Add/ }));

    expect(addGrantMock).not.toHaveBeenCalled();
    expect(alertDialogMock).toHaveBeenCalledTimes(1);
    expect(alertDialogMock.mock.calls[0][0]).toMatchObject({ title: "Member count not available yet" });
  });

  it("shows how many of the allowed slots are used", () => {
    queryMocks.grants = grantRows(3);
    renderDialog();

    expect(screen.getByText(`3/${MAX_PROJECT_GRANTS}`)).toBeInTheDocument();
  });
});

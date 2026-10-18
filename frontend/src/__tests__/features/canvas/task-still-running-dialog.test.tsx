// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// When the frontend stops waiting, a neutral notice is shown instead of an error: no "Copy error report", and the icon is a spinner rather than a
// warning. The user must see "still generating", otherwise a task that is still running would be treated as failed and redone.
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { GlobalErrorDialog } from "@/components/GlobalErrorDialog";
import { notifyTaskStillRunning } from "@/features/canvas/application/errorDialog";
import {
  subscribeOpenGlobalErrorDialog,
  type GlobalErrorDialogDetail,
} from "@/features/app/errorDialogEvents";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        "errorDialog.copyReport": "Copy error report",
        "errorDialog.technicalDetails": "Technical details",
        "errorDialog.stillRunningTitle": "Still generating",
        "errorDialog.stillRunningMessage": "The page stopped waiting, and the task continues in the background.",
        "common.close": "Close",
      })[key] ?? key,
  }),
}));

const t = ((key: string) =>
  ({
    "errorDialog.stillRunningTitle": "Still generating",
    "errorDialog.stillRunningMessage": "The page stopped waiting, and the task continues in the background.",
  })[key] ?? key) as unknown as Parameters<typeof notifyTaskStillRunning>[0];

describe("notifyTaskStillRunning", () => {
  it("sends the pending variant, without copyable error content", () => {
    const seen: GlobalErrorDialogDetail[] = [];
    const unsubscribe = subscribeOpenGlobalErrorDialog((detail) => seen.push(detail));

    notifyTaskStillRunning(t);
    unsubscribe();

    expect(seen).toHaveLength(1);
    expect(seen[0].variant).toBe("pending");
    expect(seen[0].title).toBe("Still generating");
    expect(seen[0].copyText).toBeUndefined();
  });
});

describe("GlobalErrorDialog pending variant", () => {
  it("does not show \"Copy error report\" even with technical details, and uses the spinner icon", () => {
    const { container } = render(
      <GlobalErrorDialog
        isOpen
        variant="pending"
        title="Still generating"
        message="The page stopped waiting, and the task continues in the background."
        details="task_key=freezone_video_generate:job-1"
        onClose={() => {}}
      />,
    );

    expect(screen.queryByText("Copy error report")).toBeNull();
    expect(container.ownerDocument.querySelector(".animate-spin")).not.toBeNull();
  });

  it("the error variant still offers the copy button", () => {
    render(
      <GlobalErrorDialog
        isOpen
        variant="error"
        title="Generation failed"
        message="Upstream returned 500"
        details="request_id=abc"
        onClose={() => {}}
      />,
    );

    expect(screen.getByText("Copy error report")).toBeTruthy();
  });
});

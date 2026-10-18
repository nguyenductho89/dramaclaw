// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";

const handleSessionExpiredMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("@/lib/api", () => ({
  handleSessionExpired: handleSessionExpiredMock,
}));

import { apiCall, apiClient } from "@/api/client";
import {
  BackendStatusError,
  backendErrorToastMessage,
  BillingRuleNotConfiguredError,
  errorFromBackendBody,
  InsufficientCreditsError,
  jsonWithBackendError,
  ProjectQueueLimitError,
} from "@/lib/api-errors";

afterEach(() => {
  handleSessionExpiredMock.mockClear();
  vi.unstubAllGlobals();
});

describe("apiCall backend errors", () => {
  it("routes a 401 through the shared session-expired handler", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ detail: "Missing session or agent token" }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    await expect(
      apiCall("projects/demo/freezone/canvases/demo/projections:status", {
        prefix: "http://localhost/api/v1",
        method: "POST",
        json: { projection_keys: [] },
      } as Parameters<typeof apiCall>[1]),
    ).rejects.toMatchObject({ status: 401 });

    expect(handleSessionExpiredMock).toHaveBeenCalledOnce();
  });

  it("keeps status on string detail backend errors", () => {
    const error = errorFromBackendBody(
      409,
      { detail: "canvas base_revision is required" },
      "Conflict",
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error & { status?: number }).status).toBe(409);
    expect(error?.message).toBe("canvas base_revision is required");
  });

  it("surfaces project queue limit responses as ProjectQueueLimitError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: "The current project's default queue is full. Wait for existing tasks to finish before submitting.",
            data: {
              project_id: "demo",
              queue_kind: "default",
              limit: 3,
              active: 3,
              limit_scope: "project",
            },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const promise = apiCall("projects/demo/freezone/gen", {
      prefix: "http://localhost/api/v1",
      method: "POST",
      json: {
        prompt: "Generate an image",
      },
    } as Parameters<typeof apiCall>[1]);

    await expect(promise).rejects.toMatchObject({
      name: "ProjectQueueLimitError",
      queueKind: "default",
      limitScope: "project",
      message: "The current project's default queue is full",
    });
    await expect(promise).rejects.toBeInstanceOf(ProjectQueueLimitError);
  });

  it("surfaces personal queue limit responses with a personal limit message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error: "Your tasks in the current project's default queue are full. Wait for your own tasks to finish before submitting.",
            data: {
              project_id: "demo",
              requester_user_id: "user_1",
              queue_kind: "default",
              limit: 3,
              active: 3,
              limit_scope: "user",
            },
          }),
          {
            status: 429,
            headers: { "content-type": "application/json" },
          },
        ),
      ),
    );

    const promise = apiCall("projects/demo/freezone/gen", {
      prefix: "http://localhost/api/v1",
      method: "POST",
      json: {
        prompt: "Generate an image",
      },
    } as Parameters<typeof apiCall>[1]);

    await expect(promise).rejects.toMatchObject({
      name: "ProjectQueueLimitError",
      queueKind: "default",
      limitScope: "user",
      message: "You have reached your personal default queue limit",
    });
    await expect(promise).rejects.toBeInstanceOf(ProjectQueueLimitError);
  });

  it.each([
    ["channel", "organization", "The current organization's video queue is full"],
    ["platform", "platform", "The platform video queue is full"],
    ["global_lane_queue", "node", "The current node's video queue is full"],
  ] as const)("preserves the %s lane scope from EE", (limitScope, scopeKind, message) => {
    const error = errorFromBackendBody(
      429,
      {
        ok: false,
        error: "Task lane limit exceeded",
        data: {
          queue_kind: "video",
          limit_scope: limitScope,
          scope_kind: scopeKind,
          limit: 3,
          active: 3,
        },
      },
      "Too Many Requests",
    );

    expect(error).toMatchObject({
      name: "ProjectQueueLimitError",
      queueKind: "video",
      limitScope,
      message,
    });
  });

  it("keeps an unknown lane scope on the generic backend error path", () => {
    const error = errorFromBackendBody(
      429,
      {
        ok: false,
        error: "Task lane limit exceeded",
        data: {
          queue_kind: "video",
          limit_scope: "unknown_scope",
        },
      },
      "Too Many Requests",
    );

    expect(error).toMatchObject({
      name: "BackendStatusError",
      message: "Task lane limit exceeded",
      status: 429,
    });
  });

  it("uses i18n for project queue limit display text", () => {
    const tMock = vi.fn((key: string, options?: { queue?: string; defaultValue?: string }) => {
      if (key === "common.projectQueueKinds.video") return "video";
      if (key === "common.projectQueueFull") return `The current project's ${options?.queue} queue is full`;
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    const message = backendErrorToastMessage(
      new ProjectQueueLimitError("video", "backend message", "project"),
      t,
    );

    expect(message).toBe("The current project's video queue is full");
    expect(tMock).toHaveBeenCalledWith("common.projectQueueKinds.video", {
      defaultValue: "video",
    });
    expect(tMock).toHaveBeenCalledWith("common.projectQueueFull", {
      queue: "video",
      defaultValue: "backend message",
    });
  });

  it("uses i18n for personal queue limit display text", () => {
    const tMock = vi.fn((key: string, options?: { queue?: string; defaultValue?: string }) => {
      if (key === "common.userDefaultQueueFull") {
        return "You have reached your personal default queue limit";
      }
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    const message = backendErrorToastMessage(
      new ProjectQueueLimitError("default", "backend message", "user"),
      t,
    );

    expect(message).toBe("You have reached your personal default queue limit");
    expect(tMock).toHaveBeenCalledWith("common.userDefaultQueueFull", {
      defaultValue: "backend message",
    });
  });

  it.each([
    ["channel", "common.organizationQueueFull", "The current organization's video queue is full"],
    ["platform", "common.platformQueueFull", "The platform video queue is full"],
    ["global_lane_queue", "common.nodeQueueFull", "The current node's video queue is full"],
  ] as const)("uses i18n for the %s queue pool", (limitScope, messageKey, expectedMessage) => {
    const tMock = vi.fn((key: string, options?: { queue?: string; defaultValue?: string }) => {
      if (key === "common.projectQueueKinds.video") return "video";
      if (key === messageKey) return expectedMessage;
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    const message = backendErrorToastMessage(
      new ProjectQueueLimitError("video", "backend message", limitScope),
      t,
    );

    expect(message).toBe(expectedMessage);
    expect(tMock).toHaveBeenCalledWith(messageKey, {
      queue: "video",
      defaultValue: "backend message",
    });
  });

  it("uses i18n for insufficient credits display text", () => {
    const error = errorFromBackendBody(
      402,
      {
        ok: false,
        error: "Insufficient credits. Please contact your administrator to recharge.",
        data: {
          error_code: "INSUFFICIENT_CREDITS",
          required: 6,
          balance: 1,
        },
      },
      "Payment Required",
    );
    const tMock = vi.fn((key: string, options?: { defaultValue?: string }) => {
      if (key === "common.insufficientCredits") {
        return "Insufficient credits. Please contact your administrator to recharge.";
      }
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(backendErrorToastMessage(error, t)).toBe(
      "Insufficient credits. Please contact your administrator to recharge.",
    );
    expect(tMock).toHaveBeenCalledWith("common.insufficientCredits", {
      defaultValue: "Insufficient credits. Please contact your administrator to recharge.",
    });
  });

  it("treats bare 402 responses as insufficient credits", () => {
    const error = errorFromBackendBody(402, null, "Payment Required");
    const tMock = vi.fn((key: string, options?: { defaultValue?: string }) => {
      if (key === "common.insufficientCredits") {
        return "Insufficient credits. Please contact your administrator to recharge.";
      }
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(backendErrorToastMessage(error, t)).toBe(
      "Insufficient credits. Please contact your administrator to recharge.",
    );
  });

  it("maps legacy wrapped Freezone insufficient-credit errors", () => {
    const error = errorFromBackendBody(
      503,
      {
        detail:
          "failed to start freezone image-to-video task: insufficient credits for user usr_1: required 40, available 8",
      },
      "Service Unavailable",
    );
    const tMock = vi.fn((key: string, options?: { defaultValue?: string }) => {
      if (key === "common.insufficientCredits") {
        return "Insufficient credits. Please contact your administrator to recharge.";
      }
      return options?.defaultValue ?? key;
    });

    expect(error).toBeInstanceOf(InsufficientCreditsError);
    expect(backendErrorToastMessage(error, tMock as unknown as TFunction)).toBe(
      "Insufficient credits. Please contact your administrator to recharge.",
    );
  });

  it("prefers a structured billing-rule code over legacy message text", () => {
    const error = errorFromBackendBody(
      503,
      {
        detail: {
          error_code: "BILLING_RULE_NOT_CONFIGURED",
          message: "billing rule is not configured; insufficient credits fallback",
        },
      },
      "Service Unavailable",
    );

    expect(error).toBeInstanceOf(BillingRuleNotConfiguredError);
  });

  it("does not classify non-5xx legacy text as insufficient credits", () => {
    const error = errorFromBackendBody(
      400,
      { detail: "invalid request: insufficient credits text from client" },
      "Bad Request",
    );

    expect(error).not.toBeInstanceOf(InsufficientCreditsError);
  });

  it("uses i18n for missing billing rule display text", () => {
    const error = errorFromBackendBody(
      409,
      {
        ok: false,
        error: "Billing rules are not configured. Please contact your administrator to set credit rules.",
        data: {
          error_code: "BILLING_RULE_NOT_CONFIGURED",
          billing_kind: "feature",
          billing_key: "mainline.build_characters",
        },
      },
      "Conflict",
    );
    const tMock = vi.fn((key: string, options?: { defaultValue?: string }) => {
      if (key === "common.billingRuleNotConfigured") {
        return "Billing rule is not configured. Please contact an administrator to set credit pricing.";
      }
      return options?.defaultValue ?? key;
    });
    const t = tMock as unknown as TFunction;

    expect(error).toBeInstanceOf(BillingRuleNotConfiguredError);
    expect(backendErrorToastMessage(error, t)).toBe(
      "Billing rule is not configured. Please contact an administrator to set credit pricing.",
    );
    expect(tMock).toHaveBeenCalledWith("common.billingRuleNotConfigured", {
      defaultValue: "Billing rules are not configured. Please contact your administrator to set credit rules.",
    });
  });

  it("maps task metadata missing billing rule responses to the billing rule error", () => {
    const error = errorFromBackendBody(
      409,
      {
        ok: false,
        error: "Billing rules are not configured. Please contact your administrator to set credit rules.",
        data: {
          task_id: "task_1",
          status: "failed",
          metadata: {
            error_code: "BILLING_RULE_NOT_CONFIGURED",
            billing_kind: "feature",
            billing_key: "mainline.ingest_fast",
          },
        },
      },
      "Request failed with status code 409 Conflict",
    );

    expect(error).toBeInstanceOf(BillingRuleNotConfiguredError);
    expect(error?.message).toBe("Billing rules are not configured. Please contact your administrator to set credit rules.");
  });

  it("maps FastAPI detail object missing billing rule responses to the billing rule error", () => {
    const error = errorFromBackendBody(
      409,
      {
        detail: {
          error_code: "BILLING_RULE_NOT_CONFIGURED",
          message: "Billing rules are not configured. Please contact your administrator to set credit rules.",
          billing_kind: "feature",
          billing_key: "mainline.ingest_fast",
        },
      },
      "Request failed with status code 409 Conflict",
    );

    expect(error).toBeInstanceOf(BillingRuleNotConfiguredError);
    expect(error?.message).toBe("Billing rules are not configured. Please contact your administrator to set credit rules.");
  });
});

describe("skill run backend errors", () => {
  function stubSkillError(status: number, detail: Record<string, unknown>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ detail }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
  }

  it("surfaces the skill error envelope message instead of the ky status text", async () => {
    stubSkillError(422, {
      code: "render_identity_detection_required",
      category: "validation",
      message: "Before rendering the storyboard, choose the appearing characters in the \"Appearing identities\" of the \"Shot context\" node.",
      retryable: false,
      user_action_hint: null,
    });

    // The way runSkill does it; the test environment has no baseURL, so pass the prefix explicitly.
    const error = await jsonWithBackendError(
      apiClient("projects/demo/freezone/skills/freezone.frame_from_context/run", {
        prefix: "http://localhost/api/v1",
        method: "POST",
        json: {},
      } as Parameters<typeof apiClient>[1]),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(BackendStatusError);
    expect(error).toMatchObject({
      status: 422,
      message: "Before rendering the storyboard, choose the appearing characters in the \"Appearing identities\" of the \"Shot context\" node.",
    });
  });

  it("appends the user action hint of a structured detail", () => {
    const error = errorFromBackendBody(
      404,
      { detail: { code: "beat_not_found", message: "Shot not found", user_action_hint: "Please pick the shot again" } },
      "Not Found",
    );

    expect(error).toMatchObject({ status: 404, message: "Shot not found Please pick the shot again" });
  });
});

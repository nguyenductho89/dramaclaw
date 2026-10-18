// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The completion toast and logs of the task stream must live on the i18n side.
 *
 * review #462: the completion branch used to call `toast.success(data.current_task)` directly, while run_core
 * always writes `current_task="Done"` at the end, so the completion toast of the English UI was still in the backend language; and with an empty value it
 * fell back to a hard-coded "Task completed", which would be just as wrong in the other languages.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import i18next from "i18next";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { toast } from "sonner";

import { useTaskStream } from "@/hooks/use-task-stream";
import { useAuthStore } from "@/stores/auth-store";

import { enTranslation } from "../helpers/i18n-fixtures";

class MockEventSource {
  static instances: MockEventSource[] = [];
  readyState = 1;
  listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  onerror: ((event: Event) => void) | null = null;

  constructor(
    public readonly url: string,
    public readonly options?: EventSourceInit,
  ) {
    MockEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
    const callback =
      typeof listener === "function"
        ? (listener as (event: MessageEvent) => void)
        : (event: MessageEvent) => listener.handleEvent(event);
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(callback);
    this.listeners.set(type, listeners);
  }

  emit(type: string, payload: unknown) {
    const event = { data: JSON.stringify(payload) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close() {
    this.readyState = 2;
  }
}

function wrapper({ children }: { children: ReactNode }) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function mountStream() {
  return renderHook(
    () =>
      useTaskStream({
        taskType: "ingest_fast",
        project: "demo",
        episode: 0,
      }),
    { wrapper },
  );
}

beforeEach(() => {
  MockEventSource.instances.length = 0;
  // @ts-expect-error test EventSource replacement
  globalThis.EventSource = MockEventSource;
  useAuthStore.setState({ username: "alice", role: "admin" });
  vi.mocked(toast.success).mockClear();
  i18next.addResourceBundle("en", "translation", enTranslation, true, true);
});

afterEach(async () => {
  await act(async () => {
    await i18next.changeLanguage("zh");
  });
});

describe("useTaskStream completion toast", () => {
  it("does not echo the backend's \"done\" sentinel in the English UI, and uses the status entry", async () => {
    await act(async () => {
      await i18next.changeLanguage("en");
    });
    mountStream();
    const stream = MockEventSource.instances[0];

    act(() => {
      stream.emit("completed", {
        status: "completed",
        progress: 1,
        current_task: "Done",
      });
    });

    expect(toast.success).toHaveBeenCalledWith("Completed");
  });

  it("uses the entry too when the backend gives no completion text, instead of hard-coded English", () => {
    mountStream();
    const stream = MockEventSource.instances[0];

    act(() => {
      stream.emit("completed", { status: "completed", progress: 1 });
    });

    expect(toast.success).toHaveBeenCalledWith("Completed");
  });

  it("when the backend gives real closing text, it is translated by code before being shown", async () => {
    await act(async () => {
      await i18next.changeLanguage("en");
    });
    mountStream();
    const stream = MockEventSource.instances[0];

    act(() => {
      stream.emit("completed", {
        status: "completed",
        progress: 1,
        current_task: "Scene extraction complete",
        current_task_code: "tasks.progress.scenes.complete",
      });
    });

    expect(toast.success).toHaveBeenCalledWith("Scene extraction complete");
  });
});

describe("useTaskStream log compatibility", () => {
  it("an old backend that only sends logs (string[]) still displays them as usual", () => {
    const { result } = mountStream();
    const stream = MockEventSource.instances[0];

    act(() => {
      stream.emit("running", {
        status: "running",
        progress: 0.3,
        current_task: "Splitting chapters...",
        logs: ["Task started", "Source text saved"],
      });
    });

    expect(result.current.logs).toEqual(["Task started", "Source text saved"]);
  });

  it("a new backend that sends both logs and logs_i18n translates from the structured one", async () => {
    await act(async () => {
      await i18next.changeLanguage("en");
    });
    const { result } = mountStream();
    const stream = MockEventSource.instances[0];

    act(() => {
      stream.emit("running", {
        status: "running",
        progress: 0.3,
        current_task: "Source text saved",
        logs: ["Source text saved"],
        logs_i18n: [{ text: "Source text saved", code: "tasks.log.ingest.sourceSaved" }],
      });
    });

    expect(result.current.logs).toEqual(["Source text saved"]);
  });
});

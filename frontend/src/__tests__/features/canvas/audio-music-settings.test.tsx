// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { beforeEach, describe, expect, it } from "vitest";

import { server } from "@/__mocks__/msw/server";
import { CANVAS_NODE_TYPES } from "@/features/canvas/domain/canvasNodes";
import type { AudioNodeData } from "@/features/canvas/domain/canvasNodes";
import { AudioOperationsPanel } from "@/features/canvas/nodes/AudioOperationsPanel";
import { useCanvasStore } from "@/stores/canvasStore";

function renderPanel(data: Partial<AudioNodeData>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  useCanvasStore.getState().setCanvasData(
    [
      {
        id: "audio-1",
        type: CANVAS_NODE_TYPES.audio,
        position: { x: 0, y: 0 },
        data: { audioUrl: null, ...data },
      },
    ],
    [],
  );
  return render(
    <QueryClientProvider client={queryClient}>
      <AudioOperationsPanel
        nodeId="audio-1"
        data={{ audioUrl: null, ...data }}
      />
    </QueryClientProvider>,
  );
}

// The submit button now also honours the org admission gate (`/org/me`).
// Without a snapshot the gate fails closed and every submit assertion below
// would be measuring the gate rather than the panel.
const allowedOrgMe = {
  user: { user_id: "u1", username: "alice", model_billing_entitlement: "platform" },
  organization: null,
  membership: null,
  capabilities: {
    manage_members: false,
    manage_invites: false,
    manage_gateway_key: false,
    start_model_tasks: true,
  },
  gateway_key: { state: "never_configured", key_version: null },
  denial_reason: null,
};

describe("AudioOperationsPanel music advanced settings", () => {
  beforeEach(() => {
    server.use(http.get("*/api/v1/org/me", () => HttpResponse.json(allowedOrgMe)));
    useCanvasStore.getState().setCanvasData([], []);
  });

  it("opens the Advanced settings panel with the music-length dropdown (Tooltip/UiSelect import is runtime-safe)", () => {
    renderPanel({ audioKind: "music" });

    // Collapsed by default, the length dropdown is not in the document
    expect(screen.queryByText("Music length")).toBeNull();

    // Click "Advanced settings" to expand — if Tooltip were undefined at runtime this would throw while rendering here
    fireEvent.click(screen.getByTitle("Advanced settings"));

    expect(screen.getByText("Music length")).toBeTruthy();
    // UiSelect renders the preset label (default 30s; the trigger + option may each appear once)
    expect(screen.getAllByText("30s").length).toBeGreaterThan(0);
  });

  it("does not show the Advanced settings button for speech (clone) audio nodes", () => {
    renderPanel({ audioKind: "speech" });
    expect(screen.queryByTitle("Advanced settings")).toBeNull();
    // Speech mode keeps "Voice settings"
    expect(screen.getByTitle("Voice settings")).toBeTruthy();
  });

  // Regression: when an audio node references a non-empty text node, submit should be allowed — but without pouring the content into the generator text box.
  it("enables submit when a non-empty upstream text node is referenced, without filling the textarea", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "text-1",
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: { content: "My music description text", mode: "writing" },
        },
        {
          id: "audio-1",
          type: CANVAS_NODE_TYPES.audio,
          position: { x: 300, y: 0 },
          data: { audioUrl: null, audioKind: "music" },
        },
      ],
      [],
    );
    useCanvasStore.getState().addEdge("text-1", "audio-1");

    // data is taken from the store, so the panel gets the backfilled result after updateNodeData (simulating AudioNode's subscription).
    function Harness() {
      const data = useCanvasStore(
        (s) => s.nodes.find((n) => n.id === "audio-1")?.data,
      ) as AudioNodeData;
      return <AudioOperationsPanel nodeId="audio-1" data={data} />;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    // Do not pour the upstream content into the generator text box (keep it empty/placeholder)
    expect(screen.queryByDisplayValue("My music description text")).toBeNull();
    // But since a non-empty text is referenced, the generate button is available
    // The gate fails closed until /org/me lands, so wait for the snapshot before asserting.
    await waitFor(() =>
      expect((screen.getByTitle("Generate") as HTMLButtonElement).disabled).toBe(false),
    );
  });

  // Regression: speech mode likewise does not echo upstream text into the input, only concatenating it into the prompt at submit.
  it("speech mode also does not echo upstream text into the textarea but still allows submit", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    useCanvasStore.getState().setCanvasData(
      [
        {
          id: "text-1",
          type: CANVAS_NODE_TYPES.textAnnotation,
          position: { x: 0, y: 0 },
          data: { content: "My speech synthesis text", mode: "writing" },
        },
        {
          id: "audio-1",
          type: CANVAS_NODE_TYPES.audio,
          position: { x: 300, y: 0 },
          data: {
            audioUrl: null,
            audioKind: "speech",
            speechMode: "clone",
            voiceAvailable: true,
            voiceRef: { scope: "user_custom", voiceId: "voice-1" },
          },
        },
      ],
      [],
    );
    useCanvasStore.getState().addEdge("text-1", "audio-1");

    function Harness() {
      const data = useCanvasStore(
        (s) => s.nodes.find((n) => n.id === "audio-1")?.data,
      ) as AudioNodeData;
      return <AudioOperationsPanel nodeId="audio-1" data={data} />;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <Harness />
      </QueryClientProvider>,
    );

    // Upstream text is not echoed into the input
    expect(screen.queryByDisplayValue("My speech synthesis text")).toBeNull();
    // Referencing a non-empty text suffices to submit (at submit effectivePrompt concatenates upstream + local)
    // The gate fails closed until /org/me lands, so wait for the snapshot before asserting.
    await waitFor(() =>
      expect((screen.getByTitle("Generate") as HTMLButtonElement).disabled).toBe(false),
    );
  });

});

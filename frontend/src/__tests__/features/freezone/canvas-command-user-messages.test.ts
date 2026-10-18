import { describe, expect, it } from "vitest";

import {
  canvasCommandAgentHintFromResult,
  canvasCommandUserMessageFromResult,
} from "@/features/freezone/canvasCommandUserMessages";

describe("canvasCommandUserMessageFromResult", () => {
  it("returns one explicit message for duplicate Recipe text timeouts", () => {
    expect(canvasCommandUserMessageFromResult(
      [
        "Recipe text generation timed out: the model returned no result within the allotted time.",
        "Recipe text generation timed out: the model returned no result within the allotted time.",
      ],
      [
        {
          error: "Recipe text generation timed out: the model returned no result within the allotted time.",
        },
      ],
    )).toBe(
      "Recipe text generation timed out: the model returned no result in time. Please retry later. Downstream nodes were not executed this round.",
    );
  });

  it("does not misreport a Recipe timeout as user cancellation", () => {
    expect(canvasCommandUserMessageFromResult(
      ["Request timed out."],
      [],
    )).toContain("Recipe text generation timed out");
  });
});

describe("unavailable model failures", () => {
  const errors = ["field model value 'LingShan-G2' is not a valid option"];

  it("asks the user to pick a model instead of promising to switch it", () => {
    const message = canvasCommandUserMessageFromResult(errors, []);
    expect(message).toContain("generation model is unavailable");
    expect(message).toContain("Pick one");
    expect(message).not.toContain("I'll use");
  });

  it("tells the agent not to change the model or rerun without the user's choice", () => {
    const hint = canvasCommandAgentHintFromResult(errors, []);
    expect(hint).toMatch(/do not change the node's model/i);
    expect(hint).toMatch(/ask the user/i);
    expect(hint).not.toMatch(/fix the command and retry/i);
  });

  it("keeps the generic retry hint for other failures", () => {
    const hint = canvasCommandAgentHintFromResult(["source node not found: n1"], []);
    expect(hint).toMatch(/fix the command and retry only when it is safe/i);
  });
});

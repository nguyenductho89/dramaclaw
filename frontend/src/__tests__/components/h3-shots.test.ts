import { describe, expect, it } from "vitest";

import {
  h3FallbackReason,
  parseH3ShotConfig,
  serializeH3ShotConfig,
} from "@/components/episode/h3-shots/h3-shot-config";
import {
  referenceNumber,
  tokenizeH3Prompt,
  usedImageNumbers,
} from "@/components/episode/h3-shots/h3-prompt-preview";
import { topTabForPathname } from "@/lib/episode-nav";

describe("h3 shots", () => {
  it("routes /h3-shots to its own tab", () => {
    expect(topTabForPathname("/projects/x/episodes/1/h3-shots")).toBe("h3shots");
    expect(topTabForPathname("/projects/x/episodes/1/beats")).toBe("beats");
  });

  it("tokenizes H3 labels and editor markers", () => {
    const tokens = tokenizeH3Prompt("<Subject 1> is in <Picture 2>, voice <Audio 1>, 见@图片1 和 图片3");
    const refs = tokens.flatMap((t) => (t.kind === "ref" ? [`${t.media}:${t.n}`] : []));
    expect(refs).toEqual(["image:2", "audio:1", "image:1", "image:3"]);
    expect(usedImageNumbers(tokens)).toEqual([1, 2, 3]);
  });

  it("drops the fallback notice once the prompt is edited by hand", () => {
    const config = parseH3ShotConfig(
      JSON.stringify({ final_prompt: "draft", prompt_source: "fallback", prompt_fallback_reason: "why" }),
    );
    expect(h3FallbackReason(config)).toBe("why");
    const edited = { ...config, finalPrompt: "mine" };
    expect(h3FallbackReason(edited)).toBeNull();
    expect(JSON.parse(serializeH3ShotConfig(edited)).prompt_source).toBe("edited");
    expect(JSON.parse(serializeH3ShotConfig(config)).prompt_source).toBe("fallback");
  });

  it("reads the number out of a reference label", () => {
    expect(referenceNumber("图片2")).toBe(2);
    expect(referenceNumber("未发送")).toBe(0);
  });

  it("serializes with the assets-only flag and keeps unknown fields", () => {
    const cfg = parseH3ShotConfig(JSON.stringify({ custom: 1, duration: 40, ratio: "9:16" }));
    expect(cfg.duration).toBe(15);
    const out = JSON.parse(
      serializeH3ShotConfig({ ...cfg, finalPrompt: "p", promptGuidance: " g " }),
    );
    expect(out).toMatchObject({
      custom: 1,
      mode: "multimodal_reference",
      final_prompt: "p",
      prompt_guidance: "g",
      ratio: "9:16",
      h3_assets_only: true,
    });
  });
});

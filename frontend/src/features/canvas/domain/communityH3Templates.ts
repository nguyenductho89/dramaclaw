// Community MiniMax-H3 prompts for the Freezone "H3 templates" picker.
//
// Collected from https://apimodels.app/en/minimax-h3-prompts (English
// versions where the site has them, otherwise the Japanese/Chinese original;
// the prompts belong to the authors credited in the data file, which
// also feeds docs/h3-templates/index.html). They are free-form text prompts, not
// the official six-section layout, so they are kept out of H3_PROMPT_TEMPLATES
// (whose tests enforce that layout) and loaded lazily when the tab is opened.
//
// Each one runs as a first-frame (fl2va) generation: the user connects or
// generates a first frame, since the RunPod backend needs one. `h3TemplateRunnablePrompt`
// leaves their text untouched.

import type { H3PromptTemplate, H3TemplateCategory } from "./h3PromptTemplates";

interface CommunityPromptRecord {
  id: string;
  category: H3TemplateCategory;
  title: { en: string; vi: string };
  author: string | null;
  authorUrl: string | null;
  postUrl: string | null;
  aspectRatio: string;
  durationSec: number | null;
  prompt: string;
}

/** The RunPod H3 backend takes 5-12 s. */
const MIN_SECONDS = 5;
const MAX_SECONDS = 12;
const DEFAULT_SECONDS = 10;

export function toCommunityTemplate(record: CommunityPromptRecord): H3PromptTemplate {
  const seconds = record.durationSec ?? DEFAULT_SECONDS;
  return {
    id: record.id,
    source: "community",
    category: record.category,
    title: record.title,
    description: record.author
      ? { en: `by ${record.author}`, vi: `bởi ${record.author}` }
      : { en: "apimodels.app", vi: "apimodels.app" },
    mode: "fl2va",
    aspectRatio: record.aspectRatio === "9:16" ? "9:16" : "16:9",
    durationSec: Math.min(MAX_SECONDS, Math.max(MIN_SECONDS, seconds)),
    inputs: [
      {
        label: "<Picture 1>",
        role: {
          en: "First frame (connect as image 1)",
          vi: "Ảnh first frame (nối làm ảnh 1)",
        },
      },
    ],
    prompt: record.prompt,
  };
}

let cached: Promise<readonly H3PromptTemplate[]> | null = null;

export function loadCommunityH3Templates(): Promise<readonly H3PromptTemplate[]> {
  cached ??= import("./data/communityH3Prompts.json").then((module) =>
    (module.default as CommunityPromptRecord[]).map(toCommunityTemplate),
  );
  return cached;
}

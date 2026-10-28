// Builders for the fal.ai-guide H3 templates (see falH3PromptTemplates.ts).
// They emit the official MiniMax-H3 rewrite layout so every template shares the
// exact same section headers: six sections for reference generation (ref2va),
// three for first-frame / first+last-frame (fl2va, flf2va).
import type { H3PromptTemplate, H3TemplateCategory, H3TemplateInput } from "./h3PromptTemplates";

export const FAL_NO_TEXT =
  "There are no subtitles, captions, logos or watermarks anywhere in frame.";

export interface PicSpec {
  en: string;
  vi: string;
  /** English prompt for generating this input with an image model. */
  image: string;
}

export function picInputs(pics: PicSpec[]): H3TemplateInput[] {
  return pics.map((pic, index) => ({
    label: `<Picture ${index + 1}>`,
    role: { en: pic.en, vi: pic.vi },
    imagePrompt: pic.image,
  }));
}

function shotLines(shots: string[]): string {
  return shots.map((shot, index) => `[Shot ${index + 1}] ${shot}`).join("\n");
}

export interface RefPromptSpec {
  subjects: string[];
  summary: string;
  retention: string[];
  look: string;
  /** Shot 1 text; later shots must start with `At MM:SS.mmm,`. */
  shots: string[];
  sound: string;
  music: string;
}

export function buildRefPrompt(spec: RefPromptSpec): string {
  return `subject_definitions:
${spec.subjects.join("\n")}

summary:
[keyframe completion + reference generation] ${spec.summary}

retention_analysis:
${spec.retention.join("\n")}

detailed_description:
${spec.look}
${shotLines(spec.shots)}

overall_soundscape:
${spec.sound}

non_diegetic_music:
${spec.music}`;
}

export interface FramePromptSpec {
  look: string;
  shots: string[];
  sound: string;
  music: string;
  /** Number of the shot that ends on `<Picture 2>`; only for flf2va. */
  lastFrameShot?: number;
  lastFrameAtSec?: number;
}

export function buildFramePrompt(spec: FramePromptSpec): string {
  const last =
    spec.lastFrameShot !== undefined
      ? ` At ${spec.lastFrameAtSec?.toFixed(2)} seconds, <Picture 2> (from [Shot ${spec.lastFrameShot}]) is fully referenced as the last frame.`
      : "";
  return `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.${last}

integrated_multimodal_description:
${spec.look}
${shotLines(spec.shots)}

overall_soundscape:
${spec.sound}

non_diegetic_music:
${spec.music}`;
}

export type FalBase = Pick<H3PromptTemplate, "id" | "title" | "description" | "aspectRatio" | "durationSec"> & {
  category: H3TemplateCategory;
};

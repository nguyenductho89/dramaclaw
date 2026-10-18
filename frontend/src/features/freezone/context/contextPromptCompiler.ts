// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * This assembles the prompt sent to the image model, not UI copy. Changes directly change the generation result,
 * so it does not follow the UI language.
 */
// i18n-exempt-start
import type { ContextMatch } from "./contextMatching";
import type { MainlineContext } from "./mainlineContext";

function compactList(values: Array<string | undefined | null>): string {
  return values
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(", ");
}

function beatLabel(beat: MainlineContext | undefined): string {
  if (!beat || typeof beat.episode !== "number" || typeof beat.beat !== "number") {
    return "Unknown Beat";
  }
  return `EP${beat.episode} / Beat ${beat.beat}`;
}

function renderMap(title: string, values: Record<string, string> | undefined): string[] {
  if (!values || Object.keys(values).length === 0) return [];
  return [
    `${title}: ${Object.entries(values)
      .map(([key, value]) => `${key}=${value}`)
      .join(", ")}`,
  ];
}

function renderCommonFacts(match: ContextMatch): string[] {
  const beat = match.beat;
  const lines = [
    `Mainline target: ${beatLabel(beat)}`,
  ];

  if (beat?.visualDescription) {
    lines.push(`Sketch first-frame visual_description: ${beat.visualDescription}`);
  }

  if (beat?.sceneId || match.scene?.sceneId) {
    lines.push(`Scene: ${beat?.sceneId || match.scene?.sceneId}`);
  }

  const identities = compactList(
    match.identities.map((ctx) => ctx.identityId || ctx.character || ctx.label),
  );
  if (identities) {
    lines.push(`Matched identities: ${identities}`);
  }

  const props = compactList(match.props.map((ctx) => ctx.propId || ctx.label));
  if (props) {
    lines.push(`Matched props: ${props}`);
  }

  lines.push(...renderMap("Identity color map", beat?.sketchColors));
  lines.push(...renderMap("Prop color map", beat?.propMarkerColors));

  if (beat?.narrationSegment) {
    lines.push(`Narration/dialogue reference: ${beat.narrationSegment}`);
  }

  return lines;
}

function compileHeader(operation: string, match: ContextMatch): string {
  return [
    "[Mainline context]",
    `Operation: ${operation}`,
    `Match: ${match.reason}`,
    ...renderCommonFacts(match),
  ].join("\n");
}

export function compileDirectorCombinedToSketchPrompt(match: ContextMatch): string {
  return [
    compileHeader("Generate sketch from director composite", match),
    "Use the input director composite as the director composition reference for the current beat and generate sketch candidates usable for the mainline.",
    "Keep the character positions, camera position, shot crop, background anchors and color-marker relationships in the image.",
    "Do not treat color markers as real clothing or props; they are only for identity/prop binding.",
    "The output should serve the t=0 first frame of visual_description; do not draw ahead to the action result frame.",
  ].join("\n");
}

export function compileSelectedBackgroundToSketchPrompt(match: ContextMatch): string {
  return [
    compileHeader("Generate sketch from current background", match),
    "Use the input selected_background as the background/camera reference for the current beat and generate sketch candidates usable for the mainline.",
    "selected_background is the current background slot of this beat and may come from master, reverse, director_env, 360, an uploaded image or an edited image.",
    "Keep the background perspective, floor/wall relationships and the large shapes such as tables, chairs, doors and windows consistent with the mainline scene.",
    "Add the characters, props and t=0 first-frame action state according to visual_description.",
  ].join("\n");
}

export function compileBeatToSketchPrompt(match: ContextMatch): string {
  return [
    compileHeader("Generate sketch from Beat", match),
    "Generate sketch candidates usable for the mainline from the current Beat's visual_description.",
    "The sketch must express the video t=0 first frame; do not draw ahead to later action peaks or result frames.",
    "Identity, prop and color-marker relationships follow the backend mainline DB; the image should be clear and readable so the director can judge the storyboard.",
  ].join("\n");
}

export function compileFrameGenerationContextPrompt(match: ContextMatch): string {
  return [
    compileHeader("Generate storyboard from sketch", match),
    "Use the input sketch as the first-frame composition of the mainline beat and generate storyboard candidates.",
    "Strictly preserve the character positions, identity color map, prop color map, camera angle and layout of the sketch.",
    "Use the matched identity, scene and prop references to improve consistency, but do not rewrite the t=0 first-frame facts of the beat.",
    "The output should be a clean, usable storyboard image; do not keep sketch annotations, arrows, color blocks or text labels.",
  ].join("\n");
}
// i18n-exempt-end

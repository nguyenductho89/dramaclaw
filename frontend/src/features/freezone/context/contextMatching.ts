// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// These three (contextMatching / contextPromptCompiler / contextOperations) are currently not referenced by any
// UI, and reason / label are assembled directly into the English-only prompt of contextPromptCompiler.
// When they are actually attached to a panel these strings should be moved into the locale files; until then the whole file is exempt.
// i18n-exempt-start
import type { MainlineContext } from "./mainlineContext";

export interface ContextMatch {
  matched: boolean;
  reason: string;
  beat?: MainlineContext;
  identities: MainlineContext[];
  scene?: MainlineContext;
  props: MainlineContext[];
  artifacts: MainlineContext[];
}

const EMPTY_MATCH: ContextMatch = {
  matched: false,
  reason: "Missing mainline context; treated as an ordinary image",
  identities: [],
  props: [],
  artifacts: [],
};

function sameBeat(a: MainlineContext, b: MainlineContext): boolean {
  return (
    typeof a.episode === "number" &&
    typeof a.beat === "number" &&
    a.episode === b.episode &&
    a.beat === b.beat
  );
}

function findBeatContext(
  contexts: MainlineContext[],
  artifact: MainlineContext,
): MainlineContext | undefined {
  return contexts.find(
    (ctx) =>
      ctx.kind === "beat" &&
      sameBeat(ctx, artifact) &&
      typeof ctx.visualDescription === "string" &&
      ctx.visualDescription.trim().length > 0,
  );
}

function reasonForBeat(beat: MainlineContext, suffix: string): string {
  return `EP${beat.episode}/B${beat.beat} · ${suffix}`;
}

function findUsableBeatContext(contexts: MainlineContext[]): MainlineContext | undefined {
  return contexts.find(
    (ctx) =>
      ctx.kind === "beat" &&
      typeof ctx.episode === "number" &&
      typeof ctx.beat === "number" &&
      typeof ctx.visualDescription === "string" &&
      ctx.visualDescription.trim().length > 0,
  );
}

function artifactMatch(
  contexts: MainlineContext[],
  kind: "director_combined" | "selected_background",
  suffix: string,
): ContextMatch {
  const artifact = contexts.find((ctx) => ctx.kind === kind);
  if (!artifact) return { ...EMPTY_MATCH };
  const beat = findBeatContext(contexts, artifact);
  if (!beat) {
    return {
      ...EMPTY_MATCH,
      reason: "Missing shot context; treated as an ordinary image",
      artifacts: [artifact],
    };
  }
  return {
    matched: true,
    reason: reasonForBeat(beat, suffix),
    beat,
    identities: contexts.filter((ctx) => ctx.kind === "identity"),
    scene: contexts.find((ctx) => ctx.kind === "scene"),
    props: contexts.filter((ctx) => ctx.kind === "prop"),
    artifacts: [artifact],
  };
}

function matchesIdentity(ctx: MainlineContext, required: Set<string>): boolean {
  const identityId = String(ctx.identityId || "").trim();
  const character = String(ctx.character || "").trim();
  return Boolean(
    (identityId && required.has(identityId)) ||
      (character && required.has(character)) ||
      (identityId && [...required].some((item) => identityId.startsWith(`${item}_`))),
  );
}

function matchesProp(ctx: MainlineContext, required: Set<string>): boolean {
  const propId = String(ctx.propId || "").trim();
  return Boolean(propId && required.has(propId));
}

function matchingContextForBeat(
  contexts: MainlineContext[],
  kind: "identity" | "scene" | "prop",
  beat: MainlineContext,
): MainlineContext[] {
  return contexts.filter((ctx) => {
    if (ctx.kind !== kind) return false;
    if (
      typeof ctx.episode === "number" &&
      typeof ctx.beat === "number" &&
      !sameBeat(ctx, beat)
    ) {
      return false;
    }
    return true;
  });
}

export function matchForDirectorCombinedToSketch(
  contexts: MainlineContext[],
): ContextMatch {
  return artifactMatch(contexts, "director_combined", "Director composite can generate a sketch");
}

export function matchForSelectedBackgroundToSketch(
  contexts: MainlineContext[],
): ContextMatch {
  return artifactMatch(
    contexts,
    "selected_background",
    "Current background can generate a sketch",
  );
}

export function matchForBeatToSketch(contexts: MainlineContext[]): ContextMatch {
  const beat = findUsableBeatContext(contexts);
  if (!beat) return { ...EMPTY_MATCH };
  return {
    matched: true,
    reason: reasonForBeat(beat, "Beat can generate a sketch"),
    beat,
    identities: contexts.filter((ctx) => ctx.kind === "identity"),
    scene: contexts.find((ctx) => ctx.kind === "scene"),
    props: contexts.filter((ctx) => ctx.kind === "prop"),
    artifacts: [],
  };
}

export function matchForFrameGeneration(contexts: MainlineContext[]): ContextMatch {
  const sketch = contexts.find((ctx) => ctx.kind === "sketch");
  if (!sketch) return { ...EMPTY_MATCH };
  const beat = findBeatContext(contexts, sketch);
  if (!beat) {
    return {
      ...EMPTY_MATCH,
      reason: "Missing shot context; treated as an ordinary image",
      artifacts: [sketch],
    };
  }

  const scene = matchingContextForBeat(contexts, "scene", beat).find((ctx) =>
    beat.sceneId ? ctx.sceneId === beat.sceneId : true,
  );
  const requiredIdentitySet = new Set(beat.detectedIdentities || []);
  const identities = matchingContextForBeat(contexts, "identity", beat).filter(
    (ctx) => requiredIdentitySet.size === 0 || matchesIdentity(ctx, requiredIdentitySet),
  );
  const requiredPropSet = new Set(beat.detectedProps || []);
  const props = matchingContextForBeat(contexts, "prop", beat).filter(
    (ctx) => requiredPropSet.size === 0 || matchesProp(ctx, requiredPropSet),
  );

  const parts = ["Sketch can generate a storyboard"];
  parts.push("Identities/scene/props are read from the mainline DB");
  if (identities.length) parts.push(`${identities.length} identities matched`);
  if (scene) parts.push(`${scene.sceneId || "scene"} matched`);
  if (props.length) parts.push(`${props.length} props matched`);

  return {
    matched: true,
    reason: reasonForBeat(beat, parts.join(" · ")),
    beat,
    identities,
    scene,
    props,
    artifacts: [sketch],
  };
}
// i18n-exempt-end

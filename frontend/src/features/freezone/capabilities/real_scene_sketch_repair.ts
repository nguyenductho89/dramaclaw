// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CapabilityParamOption, GenerationCapability } from "./capabilityRegistry";
import { stringifyParamValue } from "./capabilityRegistry";

const K = "canvas.capabilities.real_scene_sketch_repair";

// promptLabel is assembled into the prompt by valuesToLabels; it is model input, not UI copy.
// i18n-exempt-start
const PRESERVE_OPTIONS: CapabilityParamOption[] = [
  { value: "camera", labelKey: `${K}.preserve.camera`, promptLabel: "original camera position / composition" },
  { value: "layout", labelKey: `${K}.preserve.layout`, promptLabel: "positions of tables, chairs, walls, doors and windows" },
  { value: "identity", labelKey: `${K}.preserve.identity`, promptLabel: "character identity colors" },
  { value: "props", labelKey: `${K}.preserve.props`, promptLabel: "prop colors and positions" },
  { value: "street_mood", labelKey: `${K}.preserve.street_mood`, promptLabel: "street-life atmosphere" },
];

const MODIFY_OPTIONS: CapabilityParamOption[] = [
  { value: "deblur", labelKey: `${K}.modify.deblur`, promptLabel: "fix blur / background smeared into a blob" },
  { value: "distortion", labelKey: `${K}.modify.distortion`, promptLabel: "fix 3GS distortion / stretching" },
  { value: "furniture_detail", labelKey: `${K}.modify.furniture_detail`, promptLabel: "clarify table and chair structure" },
  { value: "actor_blocks", labelKey: `${K}.modify.actor_blocks`, promptLabel: "turn block figures into clean character line art" },
  { value: "staging_blocks", labelKey: `${K}.modify.staging_blocks`, promptLabel: "turn placeholder blocks into real objects" },
];
// i18n-exempt-end

function valuesToLabels(values: unknown, options: CapabilityParamOption[]): string {
  const raw = Array.isArray(values) ? values : typeof values === "string" ? [values] : [];
  const labels = raw
    .map((value) => options.find((option) => option.value === value)?.promptLabel ?? String(value))
    .filter(Boolean);
  return labels.length > 0 ? labels.join("; ") : "keep the core structure of the current image"; // i18n-exempt -- assembled into the prompt
}

function readBeatText(metadata: Record<string, unknown> | null | undefined): string {
  const beat = (metadata?.beat_context ?? {}) as Record<string, unknown>;
  const visual = typeof beat.visual_description === "string" ? beat.visual_description : "";
  const narration =
    typeof beat.narration_segment === "string" ? beat.narration_segment : "";
  const lines: string[] = [];
  if (visual.trim()) lines.push(`Beat visual description:\n${visual.trim()}`);
  if (narration.trim()) lines.push(`Narration context:\n${narration.trim()}`);
  return lines.join("\n\n");
}

export const realSceneSketchRepairCapability: GenerationCapability = {
  id: "real_scene_sketch_repair",
  nameKey: `${K}.name`,
  shortNameKey: `${K}.shortName`,
  category: "beat",
  descriptionKey: `${K}.description`,
  outputKind: "sketch",
  model: "openai/gpt-image-2",
  aspectRatio: "16:9",
  imageSize: "2K",
  inputs: [
    {
      key: "3gs_combined",
      labelKey: `${K}.inputs.3gs_combined.label`,
      required: true,
      acceptKinds: ["director", "sketch", "frame", "generic"],
      descriptionKey: `${K}.inputs.3gs_combined.description`,
    },
    {
      key: "scene_refs",
      labelKey: `${K}.inputs.scene_refs.label`,
      required: false,
      acceptKinds: ["scene", "identity", "portrait", "prop", "director", "generic"],
      descriptionKey: `${K}.inputs.scene_refs.description`,
    },
  ],
  params: [
    {
      key: "shot_type",
      labelKey: `${K}.params.shot_type.label`,
      type: "enum",
      // defaultValue / value are protocol values assembled into the prompt and do not follow the UI language.
      // i18n-exempt-start
      defaultValue: "medium shot",
      options: [
        { value: "close-up", labelKey: `${K}.params.shot_type.options.closeup` },
        { value: "medium close-up", labelKey: `${K}.params.shot_type.options.medium_closeup` },
        { value: "medium shot", labelKey: `${K}.params.shot_type.options.medium` },
        { value: "wide shot", labelKey: `${K}.params.shot_type.options.wide` },
      ],
      // i18n-exempt-end
    },
    {
      key: "angle",
      labelKey: `${K}.params.angle.label`,
      type: "enum",
      // i18n-exempt-start
      defaultValue: "eye level",
      options: [
        { value: "eye level", labelKey: `${K}.params.angle.options.eye_level` },
        { value: "high angle", labelKey: `${K}.params.angle.options.high` },
        { value: "low angle", labelKey: `${K}.params.angle.options.low` },
        { value: "over the shoulder", labelKey: `${K}.params.angle.options.over_shoulder` },
        { value: "reverse shot", labelKey: `${K}.params.angle.options.reverse` },
      ],
      // i18n-exempt-end
    },
    {
      key: "lens",
      labelKey: `${K}.params.lens.label`,
      type: "enum",
      defaultValue: "35mm",
      options: [
        { value: "24mm", labelKey: `${K}.params.lens.options.24mm` },
        { value: "35mm", labelKey: `${K}.params.lens.options.35mm` },
        { value: "50mm", labelKey: `${K}.params.lens.options.50mm` },
        { value: "85mm", labelKey: `${K}.params.lens.options.85mm` },
      ],
    },
    {
      key: "lighting",
      labelKey: `${K}.params.lighting.label`,
      type: "enum",
      // i18n-exempt-start
      defaultValue: "dim warm street light",
      options: [
        { value: "dim warm street light", labelKey: `${K}.params.lighting.options.dim_street_warm` },
        { value: "mixed warm and cool neon", labelKey: `${K}.params.lighting.options.mixed_neon` },
        { value: "natural window light", labelKey: `${K}.params.lighting.options.window_daylight` },
        { value: "hard overhead light", labelKey: `${K}.params.lighting.options.hard_toplight` },
      ],
      // i18n-exempt-end
    },
    {
      key: "preserve",
      labelKey: `${K}.params.preserve.label`,
      type: "multiselect",
      defaultValue: ["camera", "layout", "identity", "props"],
      options: PRESERVE_OPTIONS,
    },
    {
      key: "modify",
      labelKey: `${K}.params.modify.label`,
      type: "multiselect",
      defaultValue: ["deblur", "distortion", "furniture_detail", "actor_blocks"],
      options: MODIFY_OPTIONS,
    },
    {
      key: "notes",
      labelKey: `${K}.params.notes.label`,
      type: "text",
      defaultValue: "",
      descriptionKey: `${K}.params.notes.description`,
    },
  ],
  compose: ({ inputUrls, params, metadata, nodePrompt }) => {
    const beatText = readBeatText(metadata);
    const preserve = valuesToLabels(params.preserve, PRESERVE_OPTIONS);
    const modify = valuesToLabels(params.modify, MODIFY_OPTIONS);
    const notes = stringifyParamValue(params.notes);
    // i18n-exempt-start -- protocol defaults aligned with options, assembled into the prompt
    const shotType = stringifyParamValue(params.shot_type) || "medium shot";
    const angle = stringifyParamValue(params.angle) || "eye level";
    const lens = stringifyParamValue(params.lens) || "35mm";
    const lighting = stringifyParamValue(params.lighting) || "dim warm street light";
    // i18n-exempt-end

    const prompt = `Create a repaired real-scene storyboard sketch for the current SuperTale beat.

Camera parameters:
- shot size: ${shotType}
- angle: ${angle}
- lens language: ${lens}
- lighting: ${lighting}

Reference priority:
1. The first connected image is the exact 3GS combined/control frame. Preserve its camera, composition, lens feeling, spatial layout, and object placement.
2. Additional connected references provide scene cleanup, character identity, prop color, material, and semantic anchors.
3. Do not invent a new restaurant or move furniture. Repair what is already there.

Preserve:
${preserve}

Modify / repair:
${modify}

${beatText || "Beat visual description: use the current beat context if available."}
${nodePrompt?.trim() ? `\nNode context:\n${nodePrompt.trim()}` : ""}

Output requirements:
- Clean production storyboard sketch, real-scene based, 16:9.
- Keep the 3GS camera framing exactly; do not move tables, walls, doors, counters, windows, people, staging blocks, or viewpoint.
- Convert blocky 3GS actors into clean storyboard characters at the same approximate screen positions.
- Convert colored staging/prop blocks into the real intended objects while preserving assigned colors.
- Repair 3GS blur, smearing, floaters, warped furniture, and lens distortion.
- Background people should remain visible as simplified grey/neutral figures unless identity references say otherwise.
- No text labels, no subtitles, no UI, no watermark.
${notes ? `\nAdditional notes:\n${notes}` : ""}`;

    return {
      prompt,
      referenceUrls: inputUrls,
      model: "openai/gpt-image-2",
      aspectRatio: "16:9",
      imageSize: "2K",
      quality: "medium",
      outputKind: "sketch",
    };
  },
};

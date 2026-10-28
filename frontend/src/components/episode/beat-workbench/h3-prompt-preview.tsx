// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Fragment, type ReactNode } from "react";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { resolveMediaUrl } from "@/lib/media-url";

export interface H3PreviewImage {
  /** Short label shown in the tooltip, e.g. "Yui (modern schoolgirl)". */
  name: string;
  /** Browser-servable URL (or a raw path the media resolver understands). */
  src: string | null;
}

export interface H3PictureMap {
  /** `<Picture N>` number -> image. */
  pictures: Record<number, H3PreviewImage>;
  /** `<Subject N>` number -> image (scenes are not subjects, so they are skipped). */
  subjects: Record<number, H3PreviewImage>;
}

interface MapInput {
  firstFrame: H3PreviewImage | null;
  lastFrame: H3PreviewImage | null;
  /** In `<Picture N>` order, after the first frame when there is one. */
  references: Array<{ kind: string; name: string; src: string | null }>;
}

/**
 * Mirrors the numbering the backend assembler uses
 * (`assemble_minimax_h3_prompt`): the first frame is Picture 1 when present,
 * references follow in order, the last frame comes right after the first frame
 * only for first+last mode (no references), and `<Subject N>` counts every
 * reference except scenes.
 */
export function buildH3PictureMap({ firstFrame, lastFrame, references }: MapInput): H3PictureMap {
  const pictures: Record<number, H3PreviewImage> = {};
  const subjects: Record<number, H3PreviewImage> = {};
  let n = 1;
  if (firstFrame) pictures[n++] = firstFrame;
  if (lastFrame) pictures[n++] = lastFrame;
  let subjectNo = 0;
  for (const ref of references) {
    const image = { name: ref.name, src: ref.src };
    pictures[n++] = image;
    if (ref.kind !== "scene") subjects[++subjectNo] = image;
  }
  return { pictures, subjects };
}

type Segment =
  | { type: "text"; text: string }
  | { type: "picture"; text: string; n: number }
  | { type: "subject"; text: string; n: number };

const TAG_RE = /<(Picture|Subject) (\d+)>/g;

export function splitH3PromptTags(prompt: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const match of prompt.matchAll(TAG_RE)) {
    const index = match.index ?? 0;
    if (index > last) out.push({ type: "text", text: prompt.slice(last, index) });
    const n = Number(match[2]);
    out.push({
      type: match[1] === "Picture" ? "picture" : "subject",
      text: match[0],
      n,
    });
    last = index + match[0].length;
  }
  if (last < prompt.length) out.push({ type: "text", text: prompt.slice(last) });
  return out;
}

function TagChip({
  label,
  image,
  tone,
}: {
  label: string;
  image: H3PreviewImage | undefined;
  tone: "picture" | "subject";
}) {
  const src = image?.src ? resolveMediaUrl(image.src) : null;
  const chip = (
    <span
      data-testid="h3-tag-chip"
      className={cn(
        "mx-0.5 inline-flex items-center gap-1 rounded-[5px] border px-1 py-px align-baseline font-mono text-[11px]",
        image
          ? tone === "picture"
            ? "cursor-help border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300"
            : "cursor-help border-violet-500/40 bg-violet-500/10 text-violet-700 dark:text-violet-300"
          : "border-destructive/40 bg-destructive/10 text-destructive",
      )}
    >
      {src && (
        <img src={src} alt="" className="size-3.5 rounded-[3px] object-cover" />
      )}
      {label}
    </span>
  );
  if (!image || !src) return chip;
  return (
    <Tooltip>
      <TooltipTrigger delay={120} closeDelay={80} render={chip} />
      <TooltipContent side="top" showArrow={false} className="p-1">
        <img
          src={src}
          alt={image.name}
          className="max-h-56 max-w-56 rounded-[6px] object-contain"
        />
        <div className="mt-1 max-w-56 truncate px-0.5 text-[10px]">{image.name}</div>
      </TooltipContent>
    </Tooltip>
  );
}

/**
 * Read-only render of an H3 prompt where every `<Picture N>` / `<Subject N>`
 * is a chip; hovering one shows the actual image it points to. A tag with no
 * matching image is drawn red so a wrong number is obvious before generating.
 */
export function H3PromptPreview({
  prompt,
  map,
  className,
}: {
  prompt: string;
  map: H3PictureMap;
  className?: string;
}) {
  const segments = splitH3PromptTags(prompt);
  const nodes: ReactNode[] = segments.map((seg, i) => {
    if (seg.type === "text") return <Fragment key={i}>{seg.text}</Fragment>;
    const image = seg.type === "picture" ? map.pictures[seg.n] : map.subjects[seg.n];
    return <TagChip key={i} label={seg.text} image={image} tone={seg.type} />;
  });
  return (
    <div
      data-testid="h3-prompt-preview"
      className={cn(
        "max-h-52 overflow-y-auto whitespace-pre-wrap break-words rounded-[8px] border border-white/[0.075] bg-white/[0.02] p-2 text-xs leading-relaxed",
        className,
      )}
    >
      {nodes}
    </div>
  );
}

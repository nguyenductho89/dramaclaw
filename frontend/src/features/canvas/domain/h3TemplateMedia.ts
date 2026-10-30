// Posters and reference images of the H3 templates, shown in the picker.
//
// The files are third-party material and not in git: they land in
// public/h3-templates/ via scripts/sync_h3_picker_media.py, together with a
// manifest.json ({id: {poster, refs}}). Without them the picker simply shows
// no previews.

export interface H3TemplateMediaEntry {
  poster: boolean;
  refs: number;
}

export type H3TemplateMediaManifest = Readonly<Record<string, H3TemplateMediaEntry>>;

const BASE = "/h3-templates";

let cached: Promise<H3TemplateMediaManifest> | null = null;

export function loadH3TemplateMedia(): Promise<H3TemplateMediaManifest> {
  cached ??= fetch(`${BASE}/manifest.json`)
    .then((res) => (res.ok ? (res.json() as Promise<H3TemplateMediaManifest>) : {}))
    .catch(() => ({}));
  return cached;
}

export function h3PosterUrl(id: string, manifest: H3TemplateMediaManifest): string | null {
  return manifest[id]?.poster ? `${BASE}/${id}/poster.jpg` : null;
}

export function h3RefUrls(id: string, manifest: H3TemplateMediaManifest): string[] {
  const count = manifest[id]?.refs ?? 0;
  return Array.from({ length: count }, (_, i) => `${BASE}/${id}/ref-${i + 1}.webp`);
}

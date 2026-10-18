---
version: alpha
name: DramaClaw
description: >-
  Visual specification of the DramaClaw AIGC video engine: a dark-first, information-dense workbench.
  Tokens are aligned value by value with frontend/src/index.css; dark is authoritative, with light values in parallel under the light-* prefix.
colors:
  # ── canvas / freezone surfaces (source: --*-rgb in index.css, .dark block) ──
  background: "#0a0c12"
  surface: "#15161d"
  surface-panel: "#13141b"
  surface-modal: "#1b1c23"
  surface-field: "#0d0e14"
  border-soft: "#1f2026"
  border-strong: "#2f3036"
  border: "#22232c"
  text: "#e8eaf0"
  text-muted: "#6f7079"
  accent: "#5ba0ff"
  # ── shadcn semantic layer (source: oklch values of the .dark block) ──
  primary: "#00bdcf"
  primary-foreground: "#111b21"
  secondary: "#0e333c"
  foreground: "#e9edef"
  card: "#1f2c34"
  muted: "#182229"
  muted-foreground: "#8696a0"
  ui-border: "#2a3942"
  sidebar: "#111b21"
  destructive: "#ea4335"
  success: "#51bf6f"
  warning: "#efa831"
  chart-1: "#00bdcf"
  chart-2: "#009c9c"
  chart-3: "#31a7cd"
  chart-4: "#34b7f1"
  chart-5: "#51bf6f"
  # ── light theme (source: :root block): same roles, brighter values ──
  light-background: "#ffffff"
  light-surface: "#f5f5f5"
  light-border: "#e0e0e0"
  light-text: "#000000"
  light-text-muted: "#666666"
  light-accent: "#3b82f6"
  light-primary: "#008198"
  light-foreground: "#111b21"
  light-card: "#ffffff"
  light-muted: "#f0f2f5"
  light-muted-foreground: "#667781"
  light-ui-border: "#e9edef"
typography:
  display-lg:
    fontFamily: Inter
    fontSize: 30px
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Inter
    fontSize: 24px
    fontWeight: 600
    lineHeight: 1.33
  headline-md:
    fontFamily: Inter
    fontSize: 20px
    fontWeight: 600
    lineHeight: 1.4
  title-lg:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.55
  body-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.5
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.43
  body-sm:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
  label-md:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.25
  label-strong:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 600
    lineHeight: 1.43
  mono-sm:
    fontFamily: SFMono-Regular
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
  counter-pixel:
    fontFamily: PikoCountdownPixel
    fontSize: 72px
    fontWeight: 600
    lineHeight: 1
rounded:
  sm: 12px
  md: 14px
  lg: 16px
  xl: 20px
  field: 12px
  node: 14px
  panel: 16px
  full: 9999px
spacing:
  base: 4px
  xs: 4px
  sm: 8px
  md: 12px
  lg: 16px
  xl: 24px
  2xl: 32px
  button-y: 4px
  button-x: 11px
  node-gutter: 12px
components:
  modal:
    backgroundColor: "{colors.surface-modal}"
    textColor: "{colors.text}"
    rounded: "{rounded.xl}"
    padding: "{spacing.xl}"
  panel:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.panel}"
    padding: "{spacing.md}"
  button-quiet:
    backgroundColor: "#0f1117"
    textColor: "{colors.text}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
    padding: 4px 11px
  button-quiet-hover:
    backgroundColor: "#15161c"
  button-quiet-primary:
    backgroundColor: "#0f1117"
    textColor: "{colors.accent}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  button-quiet-primary-hover:
    backgroundColor: "#1f2a3f"
    textColor: "{colors.accent}"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.primary-foreground}"
    typography: "{typography.label-strong}"
    rounded: "{rounded.md}"
    height: 36px
    padding: 0 16px
  chip:
    backgroundColor: "#101118"
    textColor: "{colors.text-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
    padding: 2px 10px
  chip-active:
    backgroundColor: "#23334d"
    textColor: "{colors.accent}"
  field:
    backgroundColor: "{colors.surface-field}"
    textColor: "{colors.text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.field}"
    padding: 8px 12px
    height: 36px
  field-focus:
    backgroundColor: "{colors.surface-field}"
    textColor: "{colors.text}"
  canvas-node:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.text}"
    rounded: "{rounded.node}"
    padding: "{spacing.md}"
  canvas-node-selected:
    backgroundColor: "{colors.surface-panel}"
    textColor: "{colors.accent}"
  popover:
    backgroundColor: "{colors.card}"
    textColor: "{colors.foreground}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
  badge-muted:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.muted-foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
  status-failed:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.destructive}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  status-succeeded:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.success}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  status-degraded:
    backgroundColor: "{colors.muted}"
    textColor: "{colors.warning}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  sidebar-item:
    backgroundColor: "{colors.sidebar}"
    textColor: "{colors.foreground}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: "{spacing.sm}"
  # ── light variants (without `.dark`). Same components, referencing light-* tokens. ──
  panel-light:
    backgroundColor: "{colors.light-card}"
    textColor: "{colors.light-foreground}"
    rounded: "{rounded.panel}"
    padding: "{spacing.md}"
  canvas-node-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-text}"
    rounded: "{rounded.node}"
    padding: "{spacing.md}"
  field-light:
    backgroundColor: "{colors.light-background}"
    textColor: "{colors.light-text}"
    typography: "{typography.body-md}"
    rounded: "{rounded.field}"
    padding: 8px 12px
  chip-light:
    backgroundColor: "{colors.light-muted}"
    textColor: "{colors.light-text-muted}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
  button-primary-light:
    backgroundColor: "{colors.light-primary}"
    textColor: "{colors.light-background}"
    typography: "{typography.label-strong}"
    rounded: "{rounded.md}"
    height: 36px
  button-quiet-primary-light:
    backgroundColor: "{colors.light-surface}"
    textColor: "{colors.light-accent}"
    typography: "{typography.label-md}"
    rounded: "{rounded.full}"
  badge-muted-light:
    backgroundColor: "{colors.light-muted}"
    textColor: "{colors.light-muted-foreground}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
---

# DramaClaw DESIGN.md

This file is a machine-readable mirror of `frontend/src/index.css`. Whenever a CSS variable changes, this file must be updated in the same commit.
Diffing against the previous version with `npx @google/design.md diff` is how visual regressions are caught.

> Section headings stay in English (Overview / Colors / ...), because the DESIGN.md spec parses sections by English headings,
> and renaming them would make the linter report "missing sections". Token names, CSS variable names, class names, property names, and color values likewise stay verbatim.

## Overview

DramaClaw (the director agent) is a professional AIGC video workbench: node canvas, storyboard, generation queue, and long-running task panel.
Its users are creators who keep the tool open all day, so the UI is defined as **dark-first, information-dense, and restrained**:
`theme: 'dark'` is the persisted default, and light is a supported alternative, not the main battlefield.

The tone is "a dashboard, not a poster". The interface shell recedes into near-black translucent glass; the only highly saturated color on a screen
belongs to the thing the user is currently operating. Density is deliberate: 12px is the workhorse font size, and 4-8px the workhorse spacing.
Motion is short and decelerating: surfaces "settle" and never bounce.

Explicitly unwanted: marketing-style gradients, decorative illustration, playful bouncy easing, and a second accent color on the same surface.

The above, and all the remaining rules in this file, apply to the **product interface after login**. The public landing pages reachable without logging in
(the download page and the login page) are a small, deliberately carved-out exception, whose boundary is written in Scope & Exceptions.

## Colors

Two palettes coexist, but **must not be mixed on the same surface**:

- **The canvas palette** (`background` #0a0c12 -> `surface` #15161d -> `border` #22232c,
  text `text` #e8eaf0 / `text-muted` #6f7079, accent `accent` #5ba0ff).
  It drives the freezone canvas, node bodies, floating toolbars, and all `.tap-*` / `.ui-*` classes.
  Values are stored as space-separated RGB triplets (`--bg-rgb`) so alpha can be layered on:
  `rgb(var(--accent-rgb) / 0.22)`.
- **The shadcn semantic palette** (`primary` #00bdcf electric cyan, `card` #1f2c34,
  `muted-foreground` #8696a0, `ui-border` #2a3942, plus `destructive` / `success` /
  `warning`). It drives the shadcn primitives (dialogs, dropdowns, tabs, forms), written in `oklch()` to guarantee
  perceptual uniformity.

Rules:

- Semantic status colors are shared by both palettes: `destructive` #ea4335 means danger and failure, `success` #51bf6f
  means completion, and `warning` #efa831 means degraded or quota-limited. **Do not invent a second red.**
- `accent` (blue) and `primary` (cyan) are **two historical accent colors**, not a design decision.
  Canvas surfaces use blue and shadcn surfaces use cyan. Choose by "which palette the surface belongs to", not by taste;
  see also Do's and Don'ts.
- Chroma must be low on resting surfaces. shadcn's `secondary` / `accent` are cyan-tinted grays
  (dark #0e333c, light #def6fa), precisely so that the hover state of dropdowns and tabs stays quiet enough.
- Light mode flips `background` to pure white and `text` to pure black, and swaps the accent for `light-accent` #3b82f6;
  `card` becomes pure white, set against a #f0f2f5 page background.
- `chart-1` ... `chart-5` are the only approved data series colors, running "cyan -> teal -> sky blue -> lake blue -> green",
  so that the same hue family never repeats.

## Typography

Latin glyphs use **Inter**, with CJK falling back in turn to `Noto Sans SC` -> `PingFang SC` -> `Microsoft YaHei`
(see `--font-family-ui-default`; macOS uses the shorter `--font-family-ui-macos`).
Product copy is English and Vietnamese, so:

- **Never set `letterSpacing` on CJK body text.** Letter spacing that looks good with Inter breaks the natural spacing of Han glyphs.
  Negative letter spacing is reserved for `display-lg`.
- At the same px, CJK glyphs look about one step smaller than Latin ones. Labels mixing scripts should prefer `body-md` (14px)
  over `body-sm` (12px).
- Always use a unitless `line-height`, so it scales with the larger x-height of the CJK fallback fonts.
- Vietnamese text uses stacked diacritics, so do not tighten `line-height` below the values defined in the tokens.

The practical division of the hierarchy: `body-sm` (12px) and `body-md` (14px) carry about 90% of product text:
property panel rows, node labels, and task lists. `label-md` (12px/500) is for chips, buttons, and toolbar controls.
`headline-*` appears only once per panel title. `display-lg` is reserved for empty states and dialog titles.
`mono-sm` is used only for IDs, paths, seeds, and timecodes. `counter-pixel` (a pixel-digit subset)
applies only to the Piko mini-game countdown and must not leak into the product interface.

## Layout & Spacing

**A 4px base unit** (`--spacing: 0.25rem`), with an 8/12/16 rhythm layered on top. This is a dense tool:
the two most common spacings in the code are `gap-1` (4px) and `gap-2` (8px), and panel padding is 8-12px,
not 24px.

- Shell: a fixed left sidebar + a fluid workspace. The canvas spreads full-bleed; panels float over it instead of squeezing it out of shape.
- Floating panels (toolbars, property panels, popovers) use `position: fixed`, 12px padding,
  and are clamped within the viewport with a 16px safe margin.
- Node interiors use a 12px gutter and 8px stacking between elements. Property panel rows are spaced 4px; groups are separated by 12px,
  never by divider lines.
- Lists and grids scroll inside `.ui-scrollbar` (a 7px thin thumb, `rgba(148,163,184,0.5)`).
  The horizontal scrollbar is hidden through `.ui-scrollbar-vertical`, but gesture scrolling still works.
- The page body never scrolls horizontally. Wide content brings its own `overflow-x: auto` container.

## Elevation & Depth

Depth comes from **translucent glass on a near-black base**, not from stacking shadows. Every floating surface is:
a translucent fill + a 1px thin border + one soft shadow.

- **Level 0 - base field:** `background` #0a0c12. Opaque, never blurred.
- **Level 1 - node / inline surface:** `surface-panel`, with the thin border `border-soft`
  (`rgba(255,255,255,0.05)`), no blur.
- **Level 2 - floating panel** (`.tap-panel` / `.ui-panel`):
  `background: rgba(21,22,29,0.78)`, `border-soft`, and
  `--ui-shadow-panel` = `0 14px 34px rgba(0,0,0,0.5)` plus a
  `0 1px 0 rgba(255,255,255,0.03) inset` top highlight. When over the canvas, pair with `.backdrop-blur-tap`
  (`saturate(180%) blur(18px)`).
- **Level 3 - dialog / popover:** decision dialogs in the product workbench use the neutral
  `surface-modal` #1b1c23 with `ui-border`; generic shadcn popovers keep using `card`.
  Modals are not blurred: they ask you to make a decision.
- **Focus and selection use glow, not shadow:** hover-primary uses `--ui-glow-accent` =
  `0 0 24px rgb(var(--accent-rgb) / 0.25)`; a focused input uses a
  `0 0 0 3px rgb(var(--accent-rgb) / 0.12)` ring.
- Light mode swaps the same three levels for opaque white cards on #f0f2f5, with much softer shadows
  (`0 2px 10px rgba(0,0,0,0.10)`); the glass metaphor is deliberately downplayed there.

Motion tokens are part of depth too: `--duration-fast` 150ms is for hover and color changes,
`--duration-base` 220ms for panel entry, and `--duration-slow` 320ms for layout shifts,
always paired with `--ease-out-quint` `cubic-bezier(0.22,1,0.36,1)` or `--ease-standard`.
**Never use bounce / elastic**: real objects only decelerate smoothly.

## Shapes

Two corner families, both large relative to small type:

- **Pill** (`rounded.full`, 9999px) is for everything "clickable but not a submit": quiet buttons,
  chips, filters, and tags. This is the signature shape: `rounded-full` is the most used radius in the code.
- **Soft rectangles** are for containers: input `field` 12px, canvas node `node` 14px,
  floating panel `panel` 16px, large drawer `xl` 20px.

`--radius` is 1rem and shadcn's steps derive from it (`sm` 12px -> `xl` 20px), so in this project
Tailwind's `rounded-md` is 14px, not 6px. Do not hard-code radii; reference these tokens.
Icons use a 1.5-2px stroke with round caps, at sizes 14/16/20px, sharing the same visual baseline as `label-md`.

## Components

The **quiet button** (`.tap-button`) is the default action control: pill, 4px/11px padding, 12px label,
thin border, translucent fill. It announces nothing until hover; on hover the border strengthens and the fill rises to
`surface`/0.88. Its primary-action variant (`.tap-button-quiet-primary`) only tints the **text** with `accent`
and adds an accent glow: it is still a quiet button. The disabled state is `opacity: 0.4` plus
`cursor: not-allowed`; do not additionally gray out the label.

The **solid button** (shadcn `button-primary`, cyan on a near-black base) appears at most once per screen: the submit action of a form or dialog.
On the canvas, prefer the quiet primary-action button.

A **chip** (`.tap-chip`) is a pill with muted text; with `data-state="active"` the text flips to `accent`,
the background becomes an `accent`/0.22 fill, and a 1px accent ring is added. The active state is carried by `data-state` rather than a class toggle,
so that React Flow portals can also be hit by the styles.

The **input** (`.tap-field` / `.ui-field`) is a 12px-radius input on `surface-field`, with no visible outline at rest;
on focus it gets a 0.5-alpha accent border and a 3px accent ring. Placeholder and helper text have dedicated tokens
(`--canvas-node-input-placeholder`, `--canvas-node-input-helper`),
so that node inputs stay readable on glass: use them, not `text-muted`.

A **canvas node** is a Level 1 surface with a 14px radius and a 12px gutter. The selected state is an accent ring plus an accent title;
never a drop shadow, which reads as being dragged.

**Popovers / dropdowns / tooltips** use the opaque `card` surface with `ui-border` and a 16px radius,
with hover rows using shadcn's `accent` (#0e333c), deliberately not the canvas blue accent,
because they render within the semantic palette.

## Do's and Don'ts

- **Do** read colors, radii, spacing, and motion from the CSS variables in `frontend/src/index.css`.
  **Don't** hard-code hex values, px radii, or ms durations in components: hard-coded literals are exactly how the two palettes start to drift.
- **Do** choose blue or cyan by "which palette the surface belongs to" (canvas -> `accent` blue, shadcn primitives ->
  `primary` cyan). **Don't** introduce a third accent color, and **don't** change only one side's surfaces to "align" with the other.
  Unifying the two hues is a known open item, and must land as a deliberate change across both palettes.
- **Do** keep a single highly saturated element per screen. **Don't** pile up a solid primary button, an active chip, and a glowing node,
  or the eye cannot find the subject.
- **Do** composite translucency with `rgb(var(--x-rgb) / a)`, so that one declaration fits both themes.
  **Don't** hand-write `rgba(255,255,255,0.05)` in components; use `--ui-border-soft` /
  `--ui-border-strong`.
- **Do** pair `.backdrop-blur-tap` on translucent panels that sit over the canvas. **Don't** blur full-screen modals,
  and don't nest two blurs: the second blur pays for one more full-viewport composite with no visible difference.
- **Do** make any text users must read meet WCAG AA (4.5:1). Four **known debts** have been measured and recorded;
  they are debts, not precedents, so do not copy these ratios into new components:
  - `chip` resting-state label, `text-muted` on the chip fill: **3.83:1**
    (the intent of "quiet when inactive", but below AA for a must-read label)
  - `status-failed`, `destructive` #ea4335 on `muted`: **4.12:1**
    (error text in dark; the fix is to use a brighter red for the text and keep #ea4335 for the fill)
  - `button-quiet-primary-light`, `light-accent` #3b82f6 on `light-surface`:
    **3.37:1** (the weakest link of light mode)
  - `badge-muted-light`, `light-muted-foreground` on `light-muted`: **4.14:1**
- **Do** use `body-sm` (12px) freely for meta information, and always use `body-md` (14px) for mixed-script labels.
  **Don't** go below 12px, and don't use more than two font weights in the same panel.
- **Do** keep hover feedback within 150ms and panel entry at 220ms with `ease-out-quint`.
  **Don't** animate `width`/`height`/`top`/`left` on canvas surfaces: animate only transform and opacity.
- **Do** verify both themes before wrapping up: toggle `.dark` on `<html>` and look closely at glass surfaces, which are
  the first things to break in light mode.

## Scope & Exceptions

This file by default governs the **product interface after login**: canvas, panels, lists, dialogs, everything users keep open all day.
The **public landing pages** reachable without logging in are the only exception zone, because their job is different: the product interface should make people forget the interface itself,
while a landing page must persuade, within ten seconds, someone who has no account yet. Building a landing page with workbench tokens yields an instruction
manual nobody would forward.

The exceptions are limited to the following two, **an allowlist, not "any new page may declare an exception"**:

- `/download` - `src/components/download/download.module.css`, `DownloadCanvasPreview.tsx`
- `/login` - `src/components/login/login.module.css`, `poster-wall.module.css`, `light-rays.css`

Adding a landing page to this allowlist requires updating this section in the same commit. Any interface reachable after login is never in it,
including the first screen entered from a landing page.

### Deviations allowed inside the exception zone

- **Its own palette, without the `index.css` tokens.** The download page takes its material from the brand DC mark: galvanized steel
  (`--zinc` #a8b4be) plus rusty oxide (`--rust` #d9603a / `--rust-hot` #ee7549).
  This is indeed a third accent color, valid only inside the exception zone: **the `rust` family must not appear in any product interface**,
  and within the page the rule "one dominant highly saturated element per screen" still holds: at rest, rust orange goes only to the hero's `DC` lettering,
  the "your system" marker, the main download button, the hero's bottom calibration bar, and the node being rendered in the preview SVG;
  everywhere else it may only be a focus ring or hover feedback.
- **Latin glyphs use Geist Variable** (`@fontsource-variable/geist`), and the CJK fallback chain is unchanged.
  The font may only load with the landing page's lazy chunk; once it appears in the main chunk, the exception is void.
- **The meta-information layer may go as low as 10px.** A landing page uses poster-style typography with much larger line widths and whitespace than the workbench,
  and monospaced scale text only feels like an instrument at 10-11.5px: eyebrow (`.eyebrow` 11px), spec-table keys (`.spec dl` 11.5px),
  checksum values and notes (10.5 / 11px), changelog time (11.5px). Boundary: **this tier is only for labels that "a glance is enough for,
  and need not be read word by word"**; any paragraph that must be read through still holds the product's 12px floor
  (measured on the landing page at 12.5-17px: `.heroNote` 12.5px, `.capabilityCell p` / `.changelog p` 13.5px,
  `.faqAnswer` 14px, hero body 16-17px). Small text at 11px has a cost for CJK scripts, so do not widen this tier to body text.
- **Entry and decorative motion may exceed 320ms.** Section entry 700ms and the hero calibration bar advance 1400ms, both paired with
  `cubic-bezier(0.16,1,0.3,1)` deceleration, and only `opacity` / `transform` / `width` may animate.
  Interaction feedback is also relaxed by a notch: hover / focus / expand run 140-240ms, not the product interface's 150ms cap,
  because landing page elements are larger and travel farther, and 150ms would look abrupt. Boundary: **the upper limit of interaction feedback is still the product's 320ms
  `--duration-slow`**, and only one-off entries and decorative animations may exceed 320ms; bounce / elastic remain forbidden.
- **Marketing gradients and decorative graphics are allowed.** The hero and card textures use radial / linear gradients, and the canvas preview is an inline SVG.

### What must still not be violated inside the exception zone

- Dark first. Landing pages are locked to dark and offer no light variant.
- Text users must read meets WCAG AA (4.5:1).
- The body never scrolls horizontally; wide content brings its own `overflow-x: auto`.
- `@media (prefers-reduced-motion: reduce)` must turn animations off; overly long motion is exactly why this rule cannot be skipped.
- Styles of the exception zone must live in their own style files (CSS Modules preferred; page-private global
  CSS such as `light-rays.css` must make sure class names carry a page prefix). **Global variables of `index.css` must not be modified in reverse**, and landing page class names must not
  leak into the product interface.

`design.md lint` validates only this file itself and does not read CSS, so this section is a convention enforced by review, not by tooling.
Consult this section when reviewing landing pages; it does not apply when reviewing other interfaces.

## Linting

```bash
npx @google/design.md lint DESIGN.md          # 0 errors is the admission line
npx @google/design.md diff old.md DESIGN.md   # token-level visual regression
npx @google/design.md export DESIGN.md --format css-vars   # or tailwind | dtcg
```

Expected baseline: **0 errors, 15 warnings.** Of these, 4 are the measured contrast debts listed above;
11 are `orphaned-tokens`, falling on `border` / `border-soft` / `border-strong` /
`ui-border` / `light-border` / `light-ui-border` / `chart-1..5`:
the alpha version of the spec has neither a border property nor the concept of chart series, so these tokens cannot be referenced by a component.
**Do not delete them to silence warnings**; they are load-bearing in `index.css`.
Any **new error**, or a warning count above 15, means a regression.

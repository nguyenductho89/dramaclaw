// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useTranslation } from 'react-i18next';
import { Image, Music2, Upload, Video } from 'lucide-react';

const MEDIA_TYPES = [
  { key: 'image', labelKey: 'canvas.assetLibrary.media.image', icon: Image },
  { key: 'video', labelKey: 'canvas.assetLibrary.media.video', icon: Video },
  { key: 'audio', labelKey: 'canvas.assetLibrary.media.audio', icon: Music2 },
] as const;

/**
 * The centered drop hint when the canvas receives a usable drag payload.
 *
 * To do fade in/out this component stays mounted and only toggles opacity - but the card carries `backdrop-blur-lg` and a large
 * area shadow, and it is a direct child of `.dc-canvas`, **not inside** `.react-flow__viewport`,
 * so neither of the LOD degradation rules (`.dc-canvas--panning/-low-detail .react-flow__viewport *`
 * turning off backdrop-filter/box-shadow, see the "canvas LOD" section of index.css) can hit it.
 * `opacity: 0` alone does not guarantee the browser skips painting: backdrop-filter forces an independent compositing layer,
 * and the cost of resampling the background every frame may still be paid, exactly the most expensive item in the #241 measurements.
 *
 * So the hidden state additionally carries `visibility: hidden` - in that state the element takes no part in painting at all, and the compositing layer
 * is not established. The interpolation rule of visibility works naturally with the fade-out: hidden->visible takes effect immediately (the fade-in
 * starts normally), while visible->hidden flips only after the whole transition ends (the fade-out is not cut off).
 */
export function CanvasFileDropOverlay({ isVisible }: { isVisible: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      className={`pointer-events-none absolute inset-0 z-[120] flex items-center justify-center overflow-hidden transition-[opacity,visibility] duration-[220ms] ease-[var(--ease-out-quint)] motion-reduce:transition-none ${
        isVisible ? 'visible opacity-100' : 'invisible opacity-0'
      }`}
      role="status"
      aria-live="polite"
      aria-label={t('canvas.fileDrop.aria')}
      aria-hidden={!isVisible}
    >
      <div className="relative w-[min(350px,calc(100%-48px))] overflow-hidden rounded-[18px] border border-white/[0.12] bg-[#11151a]/96 px-6 py-5 text-center shadow-[0_18px_48px_rgba(0,0,0,0.42)] backdrop-blur-lg">
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-cyan-100/38 to-transparent" />

        <div className="relative mx-auto grid size-10 place-items-center rounded-[12px] border border-cyan-100/16 bg-cyan-200/[0.07] text-cyan-100">
          <Upload className="size-5" aria-hidden="true" />
        </div>
        <div className="relative mt-3.5 text-base font-semibold tracking-[-0.01em] text-text-dark">
          {t('canvas.fileDrop.title')}
        </div>
        <div className="relative mt-1.5 text-xs leading-5 text-text-muted/86">
          {t('canvas.fileDrop.hint')}
        </div>

        <div className="relative mt-3.5 flex items-center justify-center gap-2">
          {MEDIA_TYPES.map(({ key, labelKey, icon: Icon }) => (
            <span
              key={key}
              className="inline-flex h-7 items-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-2.5 text-[11px] font-medium text-white/62"
            >
              <Icon className="size-3 text-cyan-100/72" aria-hidden="true" />
              {t(labelKey)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

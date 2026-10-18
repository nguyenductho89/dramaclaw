// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Palette, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import type { FreezoneStyleTemplate } from '@/api/ops';
import { StyleAssetImage } from '@/features/canvas/ui/StyleAssetImage';
import type { StyleSelectionState } from '@/features/canvas/ui/StyleGalleryModal';
import {
  NODE_REFERENCE_MEDIA_CHIP_CLASS,
  NODE_REFERENCE_MEDIA_DETACH_CLASS,
  NODE_TEXT_CONTROL_ICON_CLASS,
  NODE_TEXT_CONTROL_TRIGGER_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';

/** The thumbnail takes over the ready state, so this chip only needs to cover the other four. */
export type StyleTriggerChipState = Exclude<StyleSelectionState, 'ready'>;

const STYLE_TRIGGER_CHIP_KEYS: Record<
  StyleTriggerChipState,
  { label: string; title: string }
> = {
  none: { label: 'canvas.style.chip', title: 'canvas.style.chip' },
  loading: {
    label: 'canvas.style.chipLoading',
    title: 'canvas.style.chipLoadingTitle',
  },
  failed: {
    label: 'canvas.style.chipFailed',
    title: 'canvas.style.chipFailedTitle',
  },
  missing: {
    label: 'canvas.style.chipMissing',
    title: 'canvas.style.chipMissingTitle',
  },
};

export interface StyleTriggerChipProps {
  /** Omitted equals none — the normal case of no style selected. */
  state?: StyleTriggerChipState;
  onOpen: () => void;
}

/**
 * Placeholder entry chip shown when no style is selected; once a style is really selected and its template found, the thumbnail takes over and it no longer occupies the top row.
 * "Not found" does not mean "not selected": loading / load failure / stale id must all be reported honestly, otherwise the user would think
 * they selected no style, while that id is in fact still sent along with the generation request.
 */
export function StyleTriggerChip({
  state = 'none',
  onOpen,
}: StyleTriggerChipProps) {
  const { t } = useTranslation();
  const keys = STYLE_TRIGGER_CHIP_KEYS[state];
  const label = t(keys.label);
  const title = t(keys.title);
  const degraded = state === 'failed' || state === 'missing';
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
      title={title}
      className={`${NODE_TEXT_CONTROL_TRIGGER_CLASS} shrink-0 ${
        degraded ? 'text-amber-300/90' : ''
      }`}
    >
      <Palette className={`${NODE_TEXT_CONTROL_ICON_CLASS} shrink-0`} />
      <span>{label}</span>
    </button>
  );
}

export interface StyleThumbnailProps {
  template: FreezoneStyleTemplate;
  assetBase: string;
  onOpen: () => void;
  onClear: () => void;
}

/** The selected style keeps a cover in the input box: click to open the gallery, hover to show the name and the clear button. */
export function StyleThumbnail({
  template,
  assetBase,
  onOpen,
  onClear,
}: StyleThumbnailProps) {
  const { t } = useTranslation();
  return (
    <div className="group/stylethumb relative">
      <div
        role="button"
        tabIndex={0}
        aria-label={t('canvas.style.thumbAria', { label: template.label })}
        className={`${NODE_REFERENCE_MEDIA_CHIP_CLASS} cursor-pointer`}
        onClick={(event) => {
          event.stopPropagation();
          onOpen();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onOpen();
        }}
      >
        <StyleAssetImage
          rel={template.cover}
          assetBase={assetBase}
          alt={template.label}
          draggable={false}
          className="h-full w-full object-cover"
        />
        <button
          type="button"
          aria-label={t('canvas.style.clear')}
          title={t('canvas.style.clear')}
          className={NODE_REFERENCE_MEDIA_DETACH_CLASS}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            onClear();
          }}
        >
          <X className="h-3 w-3" strokeWidth={2.5} />
        </button>
      </div>
      {/* The thumbnail is only 48px and cannot fit text, so the name goes in the hover popover. */}
      <span className="pointer-events-none absolute left-full top-1/2 z-10 ml-1.5 hidden max-w-[160px] -translate-y-1/2 truncate whitespace-nowrap rounded bg-black/85 px-1.5 py-0.5 text-[11px] font-medium text-text-dark shadow-sm group-hover/stylethumb:block">
        {template.label}
      </span>
    </div>
  );
}

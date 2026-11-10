// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, X } from 'lucide-react';

import type { FreezonePrevisTemplate } from '@/api/ops';
import { useFreezonePrevisTemplates } from '@/features/canvas/hooks/useFreezonePrevisTemplates';
import { NODE_FLOATING_PANEL_SURFACE_CLASS } from '@/features/canvas/ui/nodeControlStyles';

export interface PrevisTemplateSelection {
  templateId: string;
  slots: Record<string, string>;
}

interface PrevisTemplatePickerPopoverProps {
  selected: PrevisTemplateSelection | null;
  onSelect: (next: PrevisTemplateSelection | null) => void;
  onClose: () => void;
}

const CATEGORY_ORDER: FreezonePrevisTemplate['category'][] = [
  'plate',
  'sheet',
  'storyboard',
];

/** Placeholders a template's prompt text actually uses, minus the ones the
 * manifest already supplies a default for — those are tuning knobs (camera
 * height, subject height), not things the user must fill in to get a prompt. */
function requiredSlots(template: FreezonePrevisTemplate): string[] {
  const text = `${template.prompt.gemini} ${template.prompt.qwen}`;
  const names = new Set<string>();
  for (const match of text.matchAll(/\{([a-z0-9_]+)\}/gi)) {
    const name = match[1];
    if (!(name in template.slots)) names.add(name);
  }
  return Array.from(names);
}

export function PrevisTemplatePickerPopover({
  selected,
  onSelect,
  onClose,
}: PrevisTemplatePickerPopoverProps) {
  const { t } = useTranslation();
  const { templates, isLoading, error, retry } = useFreezonePrevisTemplates();
  const [openId, setOpenId] = useState<string | null>(selected?.templateId ?? null);

  const grouped = useMemo(() => {
    const buckets = new Map<string, FreezonePrevisTemplate[]>();
    for (const item of templates) {
      const arr = buckets.get(item.category) ?? [];
      arr.push(item);
      buckets.set(item.category, arr);
    }
    return CATEGORY_ORDER.filter((key) => buckets.has(key)).map((key) => ({
      key,
      label: t(`canvasNodes.previsPicker.category.${key}`, key),
      items: buckets.get(key) ?? [],
    }));
  }, [templates, t]);

  const active = templates.find((item) => item.id === openId) ?? null;
  const slots = selected?.templateId === openId ? selected.slots : {};

  const setSlot = (name: string, value: string) => {
    if (!active) return;
    onSelect({
      templateId: active.id,
      slots: { ...slots, [name]: value },
    });
  };

  return (
    <div className={`${NODE_FLOATING_PANEL_SURFACE_CLASS} w-[320px] max-h-[420px] overflow-y-auto p-2`}>
      <div className="flex items-center justify-between px-1 pb-2">
        <span className="text-xs font-medium">
          {t('canvasNodes.previsPicker.title', 'Previs template')}
        </span>
        <button type="button" onClick={onClose} className="p-1" aria-label={t('common.close', 'Close')}>
          <X className="h-3 w-3" />
        </button>
      </div>

      {isLoading && (
        <div className="px-2 py-3 text-xs opacity-70">{t('common.loading', 'Loading...')}</div>
      )}
      {error && (
        <div className="px-2 py-3 text-xs">
          <span className="opacity-70">{error.message}</span>{' '}
          <button type="button" onClick={retry} className="underline">
            {t('common.retry', 'Retry')}
          </button>
        </div>
      )}

      {selected && (
        <button
          type="button"
          onClick={() => {
            onSelect(null);
            setOpenId(null);
          }}
          className="mb-1 w-full rounded px-2 py-1 text-left text-xs opacity-70 hover:opacity-100"
        >
          {t('canvasNodes.previsPicker.clear', 'No template')}
        </button>
      )}

      {grouped.map((group) => (
        <div key={group.key} className="mb-2">
          <div className="px-2 pb-1 text-[10px] uppercase tracking-wide opacity-50">
            {group.label}
          </div>
          {group.items.map((item) => {
            const isSelected = selected?.templateId === item.id;
            return (
              <div key={item.id}>
                <button
                  type="button"
                  onClick={() => {
                    setOpenId(item.id);
                    if (!isSelected) onSelect({ templateId: item.id, slots: {} });
                  }}
                  className="flex w-full items-start gap-2 rounded px-2 py-1.5 text-left hover:bg-black/5"
                >
                  <Check
                    className={`mt-0.5 h-3 w-3 shrink-0 ${isSelected ? 'opacity-100' : 'opacity-0'}`}
                  />
                  <span className="min-w-0">
                    <span className="block text-xs">{item.label}</span>
                    {item.description && (
                      <span className="block text-[10px] leading-snug opacity-60">
                        {item.description}
                      </span>
                    )}
                  </span>
                </button>

                {openId === item.id && (
                  <div className="mb-2 ml-7 mr-2 space-y-1">
                    {item.reference_slots.length > 0 && (
                      <div className="text-[10px] opacity-60">
                        {item.reference_slots
                          .map((slot) => `${slot.tag}: ${slot.role}`)
                          .join(' · ')}
                      </div>
                    )}
                    {requiredSlots(item).map((name) => (
                      <label key={name} className="block">
                        <span className="text-[10px] opacity-60">{name}</span>
                        <input
                          type="text"
                          value={slots[name] ?? ''}
                          onChange={(event) => setSlot(name, event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          className="w-full rounded border border-black/10 bg-transparent px-1.5 py-1 text-xs"
                        />
                      </label>
                    ))}
                    {/* The manifest's own defaults, editable. These carry the
                        measured numbers (camera height, subject height) — a user
                        shooting something other than two standing adults needs to
                        change them, and leaving them hidden is how a frame ends up
                        plausible-looking and wrong. */}
                    {Object.keys(item.slots).map((name) => (
                      <label key={name} className="block">
                        <span className="text-[10px] opacity-60">
                          {name} ({item.slots[name]})
                        </span>
                        <input
                          type="text"
                          value={slots[name] ?? ''}
                          placeholder={item.slots[name]}
                          onChange={(event) => setSlot(name, event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          className="w-full rounded border border-black/10 bg-transparent px-1.5 py-1 text-xs"
                        />
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      ))}

      {!isLoading && !error && templates.length === 0 && (
        <div className="px-2 py-3 text-xs opacity-70">
          {t('canvasNodes.previsPicker.empty', 'No previs templates available')}
        </div>
      )}
    </div>
  );
}

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { useRef, useState, type ReactElement } from 'react';
import { ChevronDown, ImageIcon, MessageSquarePlus } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/shadcn/dropdown-menu';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import type { AssetBoardItem } from '@/features/canvas/domain/assetBoard';
import { ADD_NODE_TO_CHAT_LABEL, addNodesToChat } from '@/features/canvas/ui/AddNodeToChatButton';
import {
  KEY_ELEMENT_CATEGORY_KEYS,
  KEY_ELEMENT_CATEGORY_LABEL,
  type KeyElementCategory,
} from '@/features/canvas/domain/keyElements';
import { cn } from '@/lib/utils';

import { AssetBoardAudioChip } from './AssetBoardAudioChip';

/** "All" + the four categories; the category dropdown inside the key elements tab uses it. */
type CategoryFilter = 'all' | KeyElementCategory;

// Getters so labels follow the active language at read time (not frozen at import).
const FILTER_LABEL: Record<CategoryFilter, string> = {
  get all() { return i18n.t('canvas.assetBoard.filter.all'); },
  get character() { return KEY_ELEMENT_CATEGORY_LABEL.character; },
  get scene() { return KEY_ELEMENT_CATEGORY_LABEL.scene; },
  get object() { return KEY_ELEMENT_CATEGORY_LABEL.object; },
  get other() { return KEY_ELEMENT_CATEGORY_LABEL.other; },
};

const FILTER_OPTIONS: readonly CategoryFilter[] = ['all', ...KEY_ELEMENT_CATEGORY_KEYS];

/** The two tabs of the top bar: key elements (with a category dropdown) / audio. */
type BarTab = 'keyElements' | 'audio';

/**
 * The storyboard's top bar (matches liblib's top "Key elements · All ▾   Audio"): merges the two kinds of persistent content into
 * one bar, switched by tabs -
 *   - Key elements: canvas nodes marked manually by the user (keyElementCategory non-empty), with a category dropdown filter;
 *   - Audio: the audio nodes on the canvas (reusing AssetBoardAudioChip, click to open the audio detail).
 *
 * Tabs are shown by whether content exists: only key elements -> only the key elements tab; only audio -> only the audio
 * tab (equivalent to the old standalone audio bar); both -> two tabs. In "audio detail state" the host
 * passes audioItems empty to hide the audio tab (the audio switcher has moved to the detail's left column then, avoiding duplication).
 */
export function KeyElementsBar({
  keyItems,
  audioItems,
  activeAudioNodeId,
  onOpen,
}: {
  /** Entries with non-empty keyElementCategory (collected across columns by the host). */
  keyItems: AssetBoardItem[];
  /** Audio entries (the audio switcher lives in this audio tab, covering both overview and audio detail states). */
  audioItems: AssetBoardItem[];
  /** The id of the currently open audio detail node: non-empty -> the top bar switches to the audio tab automatically and highlights that chip. */
  activeAudioNodeId?: string | null;
  /** Click a chip to open that node's detail (shared by key elements and audio). */
  onOpen: (item: AssetBoardItem) => void;
}): ReactElement {
  const hasKey = keyItems.length > 0;
  const hasAudio = audioItems.length > 0;
  const [tab, setTab] = useState<BarTab>(hasKey ? 'keyElements' : 'audio');
  const [filter, setFilter] = useState<CategoryFilter>('all');
  // An audio detail opens (activeAudioNodeId points to some audio) -> the top bar switches to the audio tab. Derived and synced during render
  // (the same convention as this repo's dataRef/leftListColumn); the lastRef guard switches only once when it changes, after which the user
  // can still switch back to key elements by hand.
  const lastActiveAudioRef = useRef<string | null | undefined>(undefined);
  if (activeAudioNodeId !== lastActiveAudioRef.current) {
    lastActiveAudioRef.current = activeAudioNodeId;
    if (activeAudioNodeId && tab !== 'audio') setTab('audio');
  }
  // If the selected tab's content has become empty -> fall back to the other tab with content, ensuring activeTab is always valid.
  const activeTab: BarTab =
    tab === 'audio' && !hasAudio ? 'keyElements' : tab === 'keyElements' && !hasKey ? 'audio' : tab;
  const visibleKey =
    filter === 'all' ? keyItems : keyItems.filter((item) => item.keyElementCategory === filter);

  const tabClass = (active: boolean) =>
    cn(
      'text-sm font-medium transition-colors',
      active ? 'text-foreground' : 'text-white/45 hover:text-white/70',
    );

  return (
    // This bar is only a persistent index and should not eat up the height of the three columns: thumbnails 48px, py-2.5 top and bottom, row gap-2
    // (the original 64px + py-3 + gap-3 was a notch taller, and the user asked to narrow it).
    <div className="flex shrink-0 flex-col gap-2 rounded-lg border border-white/5 bg-[#262626] px-4 py-2.5">
      <div className="flex items-center gap-4">
        {hasKey && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                onClick={() => setTab('keyElements')}
                className={cn(
                  '-mx-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 hover:bg-white/5',
                  tabClass(activeTab === 'keyElements'),
                )}
              >
                {i18n.t('canvas.assetBoard.keyElement.barTab', { filter: FILTER_LABEL[filter] })}
                <ChevronDown className="h-3.5 w-3.5 text-white/40" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={6}
              className="z-50 min-w-[120px] border-white/10 bg-[#2e2e2e] text-white/85 shadow-xl"
            >
              {FILTER_OPTIONS.map((option) => (
                <DropdownMenuItem
                  key={option}
                  className={cn(
                    'rounded-[6px] text-white/80 focus:bg-white/[0.08] focus:text-white',
                    option === filter && 'text-white',
                  )}
                  onSelect={() => {
                    setFilter(option);
                    setTab('keyElements');
                  }}
                >
                  {FILTER_LABEL[option]}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {hasAudio && (
          <button type="button" onClick={() => setTab('audio')} className={tabClass(activeTab === 'audio')}>
            {i18n.t('canvas.assetBoard.column.audio')}
          </button>
        )}
      </div>

      {activeTab === 'audio' ? (
        <div className="flex items-start gap-3 overflow-x-auto">
          {audioItems.map((item) => (
            <AssetBoardAudioChip
              key={item.nodeId}
              item={item}
              onOpen={onOpen}
              selected={item.nodeId === activeAudioNodeId}
            />
          ))}
        </div>
      ) : visibleKey.length > 0 ? (
        // The hoverable overlay hosts the "Add to chat" pill: TooltipContent goes through a Portal and is not clipped by this
        // overflow-x-auto; on hover the thumbnail pops up directly above it, and clicking the pill @-mentions that node into the shrimp guide.
        <TooltipProvider delay={120}>
          <div className="flex items-start gap-3 overflow-x-auto">
            {visibleKey.map((item) => (
              <Tooltip key={item.nodeId}>
                <TooltipTrigger
                  render={
                    // No native title attached anymore: coexisting with the overlay tooltip would show two at once; the accessible name is provided by the title span below.
                    <button
                      type="button"
                      onClick={() => onOpen(item)}
                      className="flex w-12 shrink-0 flex-col items-center gap-1"
                    >
                      <span className="flex h-12 w-12 items-center justify-center overflow-hidden rounded-md border border-white/10 bg-black/20 transition-colors hover:border-white/25">
                        {item.thumbnailUrl ? (
                          // alt="" makes the thumbnail decorative: the button's accessible name is provided by the title span below.
                          <img
                            src={item.thumbnailUrl}
                            alt=""
                            loading="lazy"
                            draggable={false}
                            className="h-full w-full object-cover"
                          />
                        ) : (
                          <ImageIcon className="h-5 w-5 text-white/30" />
                        )}
                      </span>
                      <span className="w-full truncate text-center text-[11px] text-white/60">
                        {item.title}
                      </span>
                    </button>
                  }
                />
                <TooltipContent
                  side="top"
                  sideOffset={6}
                  showArrow={false}
                  className="border-0 bg-transparent p-0 shadow-none"
                >
                  <button
                    type="button"
                    onClick={(event) => {
                      // Do not bubble to the thumbnail: its onClick opens the detail, and here we only want to @-mention the node into the shrimp guide.
                      event.stopPropagation();
                      addNodesToChat([item.nodeId]);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    className="inline-flex items-center gap-1 rounded-md bg-[#2e2e2e] px-2.5 py-1.5 text-xs font-medium text-white/90 shadow-xl ring-1 ring-white/10 transition-colors hover:bg-[#3a3a3a] hover:text-white"
                  >
                    <MessageSquarePlus className="h-3.5 w-3.5" />
                    {ADD_NODE_TO_CHAT_LABEL}
                  </button>
                </TooltipContent>
              </Tooltip>
            ))}
          </div>
        </TooltipProvider>
      ) : (
        // Under the key elements tab, when the current category is empty (switched to an empty category): a placeholder so it does not collapse into having no content.
        <p className="py-1 text-[12px] text-white/40">{i18n.t('canvas.assetBoard.keyElement.emptyCategory')}</p>
      )}
    </div>
  );
}

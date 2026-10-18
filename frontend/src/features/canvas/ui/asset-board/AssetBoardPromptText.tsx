// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Music } from 'lucide-react';

import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { useUpstreamNodes } from '@/features/canvas/application/useUpstreamGraph';
import {
  resolvePromptReferences,
  type PromptReferenceTarget,
} from '@/features/canvas/domain/promptReferences';
import type { CanvasNode } from '@/features/canvas/domain/canvasNodes';
import { buildMentionRegex } from '@/lib/mention-markers';

/**
 * A reference chip in the prompt (read-only): a thumbnail square + an "imageN" label, with a large image preview floating above on hover.
 *
 * Isomorphic with the reference chip inside workflow nodes (see nodes/shared/ReferenceTextChip: portal + fixed
 * positioning, getting around ancestors' overflow clipping), but **deliberately without the detach badge** - the detail is a read-only display surface.
 */
function PromptReferenceChip({
  target,
  onOpen,
}: {
  target: PromptReferenceTarget;
  onOpen?: (target: PromptReferenceTarget) => void;
}): ReactElement {
  const triggerRef = useRef<HTMLElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
  const previewUrl = target.thumbnailUrl ? resolveImageDisplayUrl(target.thumbnailUrl) : null;

  const showPreview = () => {
    if (!previewUrl) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    // Leave 8px along the chip's top edge; the floating layer itself moves up by translateY(-100%).
    setAnchor({ top: rect.top - 8, left: rect.left });
  };

  const clickable = Boolean(onOpen && target.nodeId);
  const Tag = clickable ? 'button' : 'span';

  return (
    <span
      className="relative inline-block align-middle"
      onMouseEnter={showPreview}
      onMouseLeave={() => setAnchor(null)}
    >
      <Tag
        ref={triggerRef as never}
        {...(clickable ? { type: 'button' as const, onClick: () => onOpen?.(target) } : {})}
        aria-label={target.label}
        title={target.label}
        className={`inline-flex items-center gap-1 rounded-[6px] border border-white/15 bg-white/10 py-0.5 pl-0.5 pr-1.5 align-middle text-[12px] leading-4 text-white/85 ${
          clickable ? 'cursor-pointer transition-colors hover:bg-white/20' : ''
        }`}
      >
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={target.label}
            className="h-4 w-4 shrink-0 rounded-[3px] object-cover"
          />
        ) : (
          <Music className="h-3.5 w-3.5 shrink-0 text-white/70" aria-hidden />
        )}
        {target.label}
      </Tag>
      {anchor &&
        previewUrl &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            style={{
              position: 'fixed',
              top: anchor.top,
              left: anchor.left,
              transform: 'translateY(-100%)',
            }}
            className="pointer-events-none z-[2000] rounded-lg bg-black p-1.5 shadow-[0_10px_24px_rgba(0,0,0,0.45)]"
          >
            <img
              src={previewUrl}
              alt=""
              className="max-h-[220px] max-w-[280px] rounded-[6px] object-contain"
            />
          </div>,
          document.body,
        )}
    </span>
  );
}

interface AssetBoardPromptTextProps {
  node: CanvasNode;
  prompt: string;
  /** Click the chip to jump to that reference's detail (optional; an own reference image without nodeId is not clickable). */
  onOpenReference?: (target: PromptReferenceTarget) => void;
}

/**
 * The prompt body of the detail panel: render `@imageN` / `@videoN` / `@audioN` as read-only chips with thumbnails
 * (large image on hover), and show the rest of the text as is.
 *
 * - **The parsing layer reuses `buildMentionRegex`** (the same one as the workflow mention-textarea highlight layer and
 *   the mentionsToProgramMarkers parsing layer): dictionary-driven, matching by label length in descending order,
 *   `@image1@image2` adjacent ones can each hit as well, with no need for a trailing space.
 * - **The numbering map reuses `resolvePromptReferences`** (internally it is the workflow's
 *   orderedReferenceUrlsWithOwnFirst / sortUpstreamByReferenceOrder + per-type counting).
 * - The dictionary contains only labels that **really resolve to a target now**, so references that have been deleted / numbers out of range
 *   such as `@image9` naturally do not match and show as plain text as is (no empty chip rendered, no error).
 */
export function AssetBoardPromptText({
  node,
  prompt,
  onOpenReference,
}: AssetBoardPromptTextProps): ReactElement {
  // Directly reuse the workflow's useUpstreamNodes: subscribing only to this node's one-hop upstream, in edge order, and using
  // useShallow to stabilize the reference (a bare selector returning a new array every time would push rendering into an infinite loop).
  const upstreamNodes = useUpstreamNodes(node.id);
  const targets = useMemo(
    () => resolvePromptReferences(node, upstreamNodes),
    [node, upstreamNodes],
  );

  const parts = useMemo<ReactNode[]>(() => {
    const pattern = buildMentionRegex([...targets.keys()]);
    if (!pattern) return [prompt];
    const out: ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(prompt)) !== null) {
      const target = targets.get(match[1]);
      if (!target) continue;
      if (match.index > lastIndex) out.push(prompt.slice(lastIndex, match.index));
      out.push(
        <PromptReferenceChip
          key={`${match.index}-${target.label}`}
          target={target}
          onOpen={onOpenReference}
        />,
      );
      lastIndex = match.index + match[0].length;
    }
    if (lastIndex < prompt.length) out.push(prompt.slice(lastIndex));
    return out;
  }, [onOpenReference, prompt, targets]);

  return (
    <p className="whitespace-pre-wrap text-[13px] leading-5 text-white/60">
      {parts.map((part, index) =>
        typeof part === 'string' ? <span key={index}>{part}</span> : part,
      )}
    </p>
  );
}

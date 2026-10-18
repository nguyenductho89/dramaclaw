// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import type { MainlineContext } from '@/features/freezone/context/mainlineContext';

interface Props {
  /** Resolved mainline contexts for this node (from `collectNodeMainlineContexts`). */
  mainlineContexts: MainlineContext[];
  /** Workflow id this node will execute, e.g. `beat_to_sketch`, `sketch_to_frame`. */
  workflowDefaultId?: string;
  /** Optional extra className for layout tuning at call sites. */
  className?: string;
}

// Map workflow_default_id to (short word, the node id promoted after commit).
//
// **Must align exactly with the `workflow_default_id=...` actually emitted in `SuperTale/src/novelvideo/freezone/presets.py`**
// (around line 3603/3628/3653/3678/3703).
// Use an exact-match dictionary rather than prefix/suffix fuzzy matching - when a preset is renamed it silently misses immediately
// rather than mismatching to the wrong slot text.
//
// `promotedNode` corresponds to the role of the ref node in the preset (`current_sketch` / `current_frame` etc. in
// `_node_mainline_context_from_ref`); after commit, the next canvas reload
// grows an independent asset node with that role.
interface SlotMapping {
  /** The entry key of the short word - things like "Sketch" and "Storyboard" have to follow the UI language. */
  candidateKey: string;
  promotedNode: string;
}
const SLOT_MAPPING_BY_WORKFLOW: Record<string, SlotMapping> = {
  beat_to_sketch: { candidateKey: 'canvas.commitHint.sketch', promotedNode: 'current_sketch' },
  selected_background_to_sketch: {
    candidateKey: 'canvas.commitHint.sketch',
    promotedNode: 'current_sketch',
  },
  director_combined_to_sketch: {
    candidateKey: 'canvas.commitHint.sketch',
    promotedNode: 'current_sketch',
  },
  sketch_to_frame: { candidateKey: 'canvas.commitHint.frame', promotedNode: 'current_frame' },
  background_sketch_to_frame: {
    candidateKey: 'canvas.commitHint.frame',
    promotedNode: 'current_frame',
  },
};

function deriveSlotMapping(workflowDefaultId?: string): SlotMapping | null {
  if (!workflowDefaultId) return null;
  return SLOT_MAPPING_BY_WORKFLOW[workflowDefaultId] ?? null;
}

/**
 * Inline hint that tells the user what category of product a generation node
 * will produce. Three states:
 *
 * 1. "typed mainline candidate" — node has a beat-context binding AND its
 *    workflow has a known slot kind (sketch / frame / director_render / etc.).
 *    Commit can propose a default target.
 * 2. "untyped mainline candidate" — beat context binding but no resolvable
 *    slot kind. Commit will treat it as a mainline candidate, target picked
 *    at commit time.
 * 3. "free candidate" — no beat-context binding. User must choose target.
 *
 * The hint never auto-commits; it only labels what is about to be produced so
 * the user knows whether to expect the typed-mainline confirm path or the
 * generic "pick a target" path. See
 * `docs/mainline_canvas_projection_architecture.md` §Commit Boundary.
 */
export function CommitTargetHint({
  mainlineContexts,
  workflowDefaultId,
  className,
}: Props) {
  const { t } = useTranslation();
  const hint = useMemo(() => {
    const beatCtx = mainlineContexts.find((ctx) => ctx.kind === 'beat');
    const slotMapping = deriveSlotMapping(workflowDefaultId);
    if (beatCtx && typeof beatCtx.episode === 'number' && typeof beatCtx.beat === 'number') {
      if (slotMapping) {
        // Key point: a mainline skill node is trigger+display in one, and the product first lands on this node's imageUrl,
        // with no downstream "storyboard node". Only after commit does the mainline DB generate the `current_xxx`
        // asset - only on the next canvas open will the independent asset node be seen.
        return {
          variant: 'typed' as const,
          text: t('canvas.commitHint.typed', {
            episode: beatCtx.episode,
            beat: beatCtx.beat,
            candidate: t(slotMapping.candidateKey),
            promoted: slotMapping.promotedNode,
          }),
        };
      }
      return {
        variant: 'untyped' as const,
        text: t('canvas.commitHint.untyped', {
          episode: beatCtx.episode,
          beat: beatCtx.beat,
        }),
      };
    }
    return {
      variant: 'free' as const,
      text: t('canvas.commitHint.free'),
    };
  }, [mainlineContexts, t, workflowDefaultId]);

  const variantClass =
    hint.variant === 'typed'
      ? 'border-amber-300/35 bg-amber-300/12 text-amber-100'
      : hint.variant === 'untyped'
        ? 'border-amber-300/20 bg-amber-300/6 text-amber-50/85'
        : 'border-white/10 bg-black/20 text-text-muted';

  return (
    <div
      className={`shrink-0 rounded-md border px-2 py-1 text-[10px] leading-tight ${variantClass} ${className ?? ''}`}
      title={t('canvas.commitHint.title')}
    >
      {hint.text}
    </div>
  );
}

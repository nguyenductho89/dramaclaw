// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Rules layer of the "reference" pick: after an image / video node opens + Reference, which nodes on the canvas can be chosen as
 * a reference.
 *
 * The landing is an ordinary upstream edge (canvasStore.addEdge(source, target)) - the prompt bar's
 * reference chips and the reference images / videos at submission are derived from upstream edges anyway (see useUpstreamContents
 * and extractUpstreamContent), so this feature needs no new data path, only a clear statement of "who can connect in".
 *
 * Type rules still have a single source of truth, nodeRegistry: here a layer of "reference semantics" narrowing is added on top of it
 * (image nodes accept only images / text), the same idea as UPSTREAM_SPAWN_WHITELIST narrowing the upstream menu
 * - an edge allowed by the edge rules is not necessarily the edge the user wants through this entry.
 */
import type { TFunction } from 'i18next';

import {
  CANVAS_NODE_TYPES,
  type CanvasNode,
  type CanvasNodeType,
} from '../domain/canvasNodes';
import { localizeNodeDisplayName } from '../domain/nodeDisplay';
import {
  isManualConnectionAllowed,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '../domain/nodeRegistry';
import { extractUpstreamContent } from './graphContentResolver';

export type ReferenceKind = 'text' | 'image' | 'video' | 'audio';

/**
 * Target node type -> the kinds of reference material it can accept. Types not in the table have no + Reference entry.
 */
const ACCEPTED_REFERENCE_KINDS: Partial<
  Record<CanvasNodeType, readonly ReferenceKind[]>
> = {
  [CANVAS_NODE_TYPES.imageGen]: ['image', 'text'],
  [CANVAS_NODE_TYPES.video]: ['image', 'video', 'audio', 'text'],
};

/**
 * The fallback kinds when a node has no content yet, decided by node type.
 *
 * Why not look only at the current content: an empty text node or a not-yet-generated image node should be connectable first and filled in later
 * - looking only at content would make them vanish out of thin air in the pick state. Conversely, an upload node can hold images / videos /
 * audio, so when the content can be determined, content wins.
 */
const DEFAULT_REFERENCE_KIND: Partial<Record<CanvasNodeType, ReferenceKind>> = {
  [CANVAS_NODE_TYPES.textAnnotation]: 'text',
  [CANVAS_NODE_TYPES.script]: 'text',
  [CANVAS_NODE_TYPES.upload]: 'image',
  [CANVAS_NODE_TYPES.imageEdit]: 'image',
  [CANVAS_NODE_TYPES.imageGen]: 'image',
  [CANVAS_NODE_TYPES.exportImage]: 'image',
  [CANVAS_NODE_TYPES.storyboardGen]: 'image',
  [CANVAS_NODE_TYPES.video]: 'video',
  [CANVAS_NODE_TYPES.audio]: 'audio',
};

/** The kind name in prompts such as "video is not supported as a reference for now". */
const REFERENCE_KIND_LABEL_KEY: Record<ReferenceKind, string> = {
  text: 'canvas.referencePick.kind.text',
  image: 'canvas.referencePick.kind.image',
  video: 'canvas.referencePick.kind.video',
  audio: 'canvas.referencePick.kind.audio',
};

export interface ReferencePickCandidate {
  /** The name the node shows on the canvas, used in the "Select xxx" prompt. */
  label: string;
  kind: ReferenceKind;
}

export interface ReferencePickTargets {
  /** Nodes that can be clicked: nodeId -> candidate info. */
  candidates: Map<string, ReferencePickCandidate>;
  /**
   * Nodes that cannot be chosen: nodeId -> the reason text why. In the pick state they are dimmed and show this sentence on hover.
   *
   * Why compute a separate copy rather than "draw no mask if not a candidate": vanishing silently only makes the user feel "clicked but nothing
   * happened", unable to tell unsupported from a broken feature - especially obvious for an image node facing video / audio nodes.
   * Stating why it cannot be chosen is easier than making people try repeatedly.
   *
   * Group nodes are not here: a group is a container, not a material, and putting a dark layer on it would blur all the content in the group together,
   * while every child node in the group already has its own mask.
   */
  rejections: Map<string, string>;
}

/** Whether this node type has a + Reference entry. */
export function supportsReferencePick(type: CanvasNodeType | undefined): boolean {
  return type !== undefined && ACCEPTED_REFERENCE_KINDS[type] !== undefined;
}

export function acceptedReferenceKinds(
  type: CanvasNodeType,
): readonly ReferenceKind[] | null {
  return ACCEPTED_REFERENCE_KINDS[type] ?? null;
}

/** The kinds of reference material a node can contribute right now; null means it can contribute nothing. */
export function referenceKindOf(node: CanvasNode): ReferenceKind | null {
  const content = extractUpstreamContent(node);
  if (content.imageUrl) return 'image';
  if (content.videoUrl) return 'video';
  if (content.audioUrl) return 'audio';
  if (content.text) return 'text';
  return DEFAULT_REFERENCE_KIND[node.type as CanvasNodeType] ?? null;
}

/**
 * Compute the destination of every node on the canvas at the moment of entering the pick state: selectable, or explainably not selectable.
 *
 * The result is a snapshot, stored in referencePickStore, and each node's overlay does only one Map lookup,
 * without each scanning the nodes array on every store change (that would be O(N^2)).
 */
export function collectReferencePickTargets(
  nodes: readonly CanvasNode[],
  targetNodeId: string,
  targetNodeType: CanvasNodeType,
  t: TFunction,
): ReferencePickTargets {
  const candidates = new Map<string, ReferencePickCandidate>();
  const rejections = new Map<string, string>();
  const accepted = ACCEPTED_REFERENCE_KINDS[targetNodeType];
  if (!accepted || !nodeHasTargetHandle(targetNodeType)) {
    return { candidates, rejections };
  }

  for (const node of nodes) {
    if (node.id === targetNodeId) continue;
    const type = node.type as CanvasNodeType | undefined;
    if (!type || type === CANVAS_NODE_TYPES.group) continue;

    const kind = referenceKindOf(node);
    if (
      kind
      && accepted.includes(kind)
      && nodeHasSourceHandle(type)
      && isManualConnectionAllowed(type, targetNodeType)
    ) {
      candidates.set(node.id, {
        label: localizeNodeDisplayName(type, node.data ?? {}, t),
        kind,
      });
      continue;
    }
    // If the kind can be named, name it ("video is not supported as a reference for now"); for ones that cannot be named, mostly nodes such as style or multi-version
    // that hold no material at all, a generic sentence is enough.
    rejections.set(
      node.id,
      kind
        ? t('canvas.referencePick.rejectKind', { kind: t(REFERENCE_KIND_LABEL_KEY[kind]) })
        : t('canvas.referencePick.rejectGeneric'),
    );
  }
  return { candidates, rejections };
}

/** The kinds of material an @ reference can point to; text does not take part (an @ in a prompt points only to media material). */
export type ReferenceMediaKind = Exclude<ReferenceKind, 'text'>;

export interface ReferenceMaterialOption {
  nodeId: string;
  /** The name the node shows on the canvas. */
  label: string;
  kind: ReferenceMediaKind;
  /** Thumbnail of the list row; audio has none, so a music note is drawn by kind. */
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
}

/**
 * "Material reference" list: media materials on the canvas that this node can still reference and does not currently reference.
 *
 * Used in the menu that replaces an @ reference in the prompt - there, besides switching the target among already referenced materials, one can
 * directly switch to another material on the canvas (selecting it creates an edge, and the reference row gains one). The selectable range is
 * exactly the same as the + Reference pick state, using the same collectReferencePickTargets, avoiding the two entries giving different answers about
 * "what can serve as a reference".
 *
 * The only narrowing: nodes with no content yet do not enter this list. The pick state is right to include them (connect first, generate later),
 * but selecting an item here means "replace this @ with it", and an empty node cannot be the target of an @ -
 * listing it would only yield a "clicked but nothing happened".
 *
 * Please give excludedNodeIds by the **actual edges** (not by reference rows that have content): upstream nodes that are already connected but
 * have not produced content yet also should not appear in "not yet referenced" again, otherwise selecting it would just addEdge once more on an
 * already existing edge, and nothing would happen in the UI.
 */
export function collectReferenceMaterials(
  nodes: readonly CanvasNode[],
  targetNodeId: string,
  targetNodeType: CanvasNodeType,
  excludedNodeIds: ReadonlySet<string>,
  t: TFunction,
): ReferenceMaterialOption[] {
  const { candidates } = collectReferencePickTargets(nodes, targetNodeId, targetNodeType, t);
  const options: ReferenceMaterialOption[] = [];
  for (const node of nodes) {
    const candidate = candidates.get(node.id);
    if (!candidate || candidate.kind === 'text') continue;
    if (excludedNodeIds.has(node.id)) continue;
    const content = extractUpstreamContent(node);
    if (!content.imageUrl && !content.videoUrl && !content.audioUrl) continue;
    options.push({
      nodeId: node.id,
      label: candidate.label,
      kind: candidate.kind,
      imageUrl: content.imageUrl || undefined,
      videoUrl: content.videoUrl || undefined,
      audioUrl: content.audioUrl || undefined,
    });
  }
  return options;
}

export function collectReferenceCandidates(
  nodes: readonly CanvasNode[],
  targetNodeId: string,
  targetNodeType: CanvasNodeType,
  t: TFunction,
): Map<string, ReferencePickCandidate> {
  return collectReferencePickTargets(nodes, targetNodeId, targetNodeType, t).candidates;
}

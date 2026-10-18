// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * Sorts upstream nodes by the order the user manually dragged them into in the "references" row (`referenceOrder`).
 * Nodes present in `referenceOrder` come first by their index; those absent (newly connected) follow the sorted ones in
 * connection order, so a later-referenced image always sorts after an earlier-referenced one — **not** by canvas y position,
 * otherwise an image newly connected above would be inserted before an older image below (indices 1/2 get scrambled). Only a manual drag changes the order.
 * The input `nodes` is already in connection order (`useUpstreamNodes` returns them in the append order of upstream edges); its index
 * is the fallback order among "not manually ordered" nodes. Chip display, image1/audio1 numbering and submission order
 * all go through this function so the visual order always matches the submission order.
 */
/**
 * Collects a node's one-hop upstream nodes in "edge order" (the append order of edges in the edges array).
 *
 * The UI numbering (@image1 / reference-row chips, via useUpstreamNodes) and the references collected at submission
 * must use the same function: submission once collected with `state.nodes.filter(...)` (node creation order),
 * so a node created first but connected later was ordered before others in references, and @image1 in the prompt
 * pointed to a different image on the backend (the backend interprets imageN by the image's position in references). Execution dependencies
 * (`dependency_for`) only control ordering and are not consumable upstream references.
 */
type UpstreamEdge = {
  source: string;
  target: string;
  data?: unknown;
};

export function isExecutionDependencyEdge(edge: UpstreamEdge): boolean {
  const data = edge.data;
  return (
    typeof data === "object"
    && data !== null
    && !Array.isArray(data)
    && (data as { link_type?: unknown }).link_type === "dependency_for"
  );
}

export function upstreamNodesInEdgeOrder<T extends { id: string }>(
  nodes: T[],
  edges: ReadonlyArray<UpstreamEdge>,
  targetId: string,
): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return edges
    .filter((edge) => edge.target === targetId && !isExecutionDependencyEdge(edge))
    .map((edge) => byId.get(edge.source))
    .filter((node): node is T => node !== undefined);
}

/**
 * The ordered list of reference images an image node submits to the backend: the node's own reference images (uploaded directly onto the node)
 * come first, upstream-connected images follow in order, with URL dedupe (when an own image and an upstream image share a URL, the
 * earliest position is kept). The backend interprets imageN by position, so the @imageN numbering, the mention-remap baseline and the submission
 * must share this single list — otherwise the own reference images take slot 1 and shift every @imageN by one.
 */
export function orderedReferenceUrlsWithOwnFirst(
  ownReferenceUrl: string | null,
  upstreamUrls: string[],
): string[] {
  return Array.from(
    new Set(
      [ownReferenceUrl, ...upstreamUrls].filter(
        (url): url is string => typeof url === "string" && url.length > 0,
      ),
    ),
  );
}

export function sortUpstreamByReferenceOrder<T extends { id: string }>(
  nodes: T[],
  referenceOrder: string[] | undefined,
): T[] {
  const orderIndex = new Map<string, number>();
  (referenceOrder ?? []).forEach((nid, i) => orderIndex.set(nid, i));
  const inputIndex = new Map<string, number>();
  nodes.forEach((node, i) => inputIndex.set(node.id, i));
  return [...nodes].sort((a, b) => {
    const ia = orderIndex.has(a.id)
      ? (orderIndex.get(a.id) as number)
      : Number.POSITIVE_INFINITY;
    const ib = orderIndex.has(b.id)
      ? (orderIndex.get(b.id) as number)
      : Number.POSITIVE_INFINITY;
    if (ia !== ib) return ia - ib;
    return (inputIndex.get(a.id) ?? 0) - (inputIndex.get(b.id) ?? 0);
  });
}

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  CANVAS_NODE_TYPES,
  DEFAULT_NODE_WIDTH,
  type CanvasEdge,
  type CanvasNode,
} from '@/features/canvas/domain/canvasNodes';

const DEFAULT_NODE_HEIGHT = 320;
const COLUMN_GAP = 80;
const ROW_GAP = 48;
// The horizontal gap between two connected components in the same row, slightly larger than the vertical gap for visual separation.
const COMPONENT_GAP_X = 120;
// The vertical gap between different rows.
const COMPONENT_GAP_Y = 96;
// After assigning vertical coordinates by the barycenter method, the maximum "full-width blank band" height allowed to remain. Blank bands beyond it are compressed to
// this value - a blank band means a Y interval in which no node of the component covers it, and compression simply shifts all nodes below the band
// up together, keeping relative geometry and edge direction unchanged and only deleting large visual gaps.
const MAX_VERTICAL_GAP = 120;
// The target aspect ratio of the canvas after tidying (screens are usually 16:9, slightly wider than 1; 1.6:1 is taken here).
// Used to estimate the strip width of shelf packing from the total area, avoiding all connected components being piled into one
// vertical strip thousands of pixels long (the old behavior).
const TARGET_PAGE_ASPECT = 16 / 9;

interface NodeSize {
  width: number;
  height: number;
}

// Chat-created workflows are laid out before React Flow has measured the new
// nodes. Use the component design sizes in that first pass so large media cards
// do not overlap; a measured pass may refine these values afterward.
const FALLBACK_NODE_SIZES: Partial<Record<string, NodeSize>> = {
  [CANVAS_NODE_TYPES.video]: { width: 580, height: 380 },
  [CANVAS_NODE_TYPES.imageGen]: { width: 580, height: 360 },
  [CANVAS_NODE_TYPES.textAnnotation]: { width: 440, height: 320 },
  [CANVAS_NODE_TYPES.audio]: { width: 480, height: 210 },
  [CANVAS_NODE_TYPES.upload]: { width: 320, height: 350 },
  [CANVAS_NODE_TYPES.script]: { width: 480, height: 320 },
  [CANVAS_NODE_TYPES.skill]: { width: 380, height: 320 },
};

function getNodeSize(node: CanvasNode): NodeSize {
  const fallback = node.type ? FALLBACK_NODE_SIZES[node.type] : undefined;
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : undefined;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : undefined;
  const width = node.measured?.width
    ?? (typeof node.width === 'number' ? node.width : undefined)
    ?? styleWidth
    ?? fallback?.width
    ?? DEFAULT_NODE_WIDTH;
  const height = node.measured?.height
    ?? (typeof node.height === 'number' ? node.height : undefined)
    ?? styleHeight
    ?? fallback?.height
    ?? DEFAULT_NODE_HEIGHT;
  return { width, height };
}

function computeComponents(
  nodes: CanvasNode[],
  edgePairs: Array<[string, string]>
): CanvasNode[][] {
  const idMap = new Map(nodes.map((node) => [node.id, node] as const));
  const adjacency = new Map<string, Set<string>>();
  for (const node of nodes) {
    adjacency.set(node.id, new Set());
  }
  for (const [source, target] of edgePairs) {
    adjacency.get(source)?.add(target);
    adjacency.get(target)?.add(source);
  }

  const visited = new Set<string>();
  const components: CanvasNode[][] = [];
  for (const node of nodes) {
    if (visited.has(node.id)) {
      continue;
    }
    const stack = [node.id];
    const component: CanvasNode[] = [];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (visited.has(id)) {
        continue;
      }
      visited.add(id);
      const current = idMap.get(id);
      if (!current) {
        continue;
      }
      component.push(current);
      const neighbors = adjacency.get(id);
      if (!neighbors) {
        continue;
      }
      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          stack.push(neighborId);
        }
      }
    }
    if (component.length > 0) {
      components.push(component);
    }
  }
  return components;
}

function computeLevels(
  nodeIds: string[],
  outgoing: Map<string, string[]>,
  incoming: Map<string, string[]>
): Map<string, number> {
  const level = new Map<string, number>();
  const queue: string[] = [];
  for (const id of nodeIds) {
    if ((incoming.get(id) ?? []).length === 0) {
      level.set(id, 0);
      queue.push(id);
    }
  }
  // Longest-path layering; the layer cap is the total node count, to avoid candidate growing without bound when "cycle + upstream entry"
  // causes an infinite loop (user-drawn edges have no cycle detection at all, and tidying would freeze the whole page). A simple path's depth is at most
  // N-1, so a DAG never reaches this cap and behaves the same; nodes in a cycle stop propagating at the cap.
  const maxLevel = nodeIds.length;
  while (queue.length > 0) {
    const id = queue.shift()!;
    const currentLevel = level.get(id) ?? 0;
    for (const target of outgoing.get(id) ?? []) {
      const candidate = currentLevel + 1;
      if (candidate > maxLevel) {
        continue;
      }
      const existing = level.get(target);
      if (existing === undefined || candidate > existing) {
        level.set(target, candidate);
        queue.push(target);
      }
    }
  }
  for (const id of nodeIds) {
    if (!level.has(id)) {
      level.set(id, 0);
    }
  }
  return level;
}

interface LayoutComponentResult {
  positions: Map<string, { x: number; y: number }>;
  width: number;
  height: number;
}

// Number of iterations for ordering/coordinates: empirically 4~8 passes suffice to converge, and more has diminishing returns.
const ORDER_SWEEPS = 6;
const COORD_SWEEPS = 8;

function median(sortedValues: number[]): number {
  const n = sortedValues.length;
  if (n === 0) {
    return 0;
  }
  const mid = Math.floor(n / 2);
  return n % 2 === 1
    ? sortedValues[mid]
    : (sortedValues[mid - 1] + sortedValues[mid]) / 2;
}

function mean(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((acc, value) => acc + value, 0) / values.length;
}

/**
 * With the in-layer order fixed, bring each node's center as close as possible to `desired`, while guaranteeing adjacent nodes do not overlap
 * (gap = sum of the two half-heights + ROW_GAP). First squeeze downward once in order to remove overlap, then translate the whole
 * so the column center's mean aligns with desired's mean, avoiding the whole column drifting one way after multiple passes.
 */
function resolveColumnCenters(
  orderedIds: string[],
  desired: Map<string, number>,
  heights: Map<string, number>,
  centerY: Map<string, number>
): void {
  const n = orderedIds.length;
  if (n === 0) {
    return;
  }
  const centers = orderedIds.map((id) => desired.get(id) ?? centerY.get(id) ?? 0);
  for (let i = 1; i < n; i += 1) {
    const prevHalf = (heights.get(orderedIds[i - 1]) ?? DEFAULT_NODE_HEIGHT) / 2;
    const currHalf = (heights.get(orderedIds[i]) ?? DEFAULT_NODE_HEIGHT) / 2;
    const minCenter = centers[i - 1] + prevHalf + ROW_GAP + currHalf;
    if (centers[i] < minCenter) {
      centers[i] = minCenter;
    }
  }
  const desiredMean = mean(orderedIds.map((id) => desired.get(id) ?? centerY.get(id) ?? 0));
  const shift = desiredMean - mean(centers);
  for (let i = 0; i < n; i += 1) {
    centerY.set(orderedIds[i], centers[i] + shift);
  }
}

/**
 * Compress the "full-width vertical blank bands" in a component. The barycenter method may pull sparse regions far apart, so that in some Y interval
 * all columns have no node - a blank band running across. Here these bands are found by the union of node vertical intervals, and the part
 * exceeding MAX_VERTICAL_GAP is pressed out as a whole: all nodes below the band are shifted up uniformly, so relative order is kept,
 * no overlap is produced, edge direction is unchanged, and only the gaps are deleted. Modifies centerY in place.
 */
function compactVerticalBands(
  ids: string[],
  heights: Map<string, number>,
  centerY: Map<string, number>
): void {
  const intervals = ids
    .map((id) => {
      const half = (heights.get(id) ?? DEFAULT_NODE_HEIGHT) / 2;
      const c = centerY.get(id) ?? 0;
      return { id, top: c - half, bottom: c + half };
    })
    .sort((a, b) => a.top - b.top);
  let maxBottom = Number.NEGATIVE_INFINITY;
  let cumulativeShift = 0;
  for (const interval of intervals) {
    if (maxBottom !== Number.NEGATIVE_INFINITY && interval.top - maxBottom > MAX_VERTICAL_GAP) {
      cumulativeShift += interval.top - maxBottom - MAX_VERTICAL_GAP;
    }
    if (cumulativeShift > 0) {
      centerY.set(interval.id, (centerY.get(interval.id) ?? 0) - cumulativeShift);
    }
    maxBottom = Math.max(maxBottom, interval.bottom);
  }
}

function layoutComponent(
  componentNodes: CanvasNode[],
  edgePairs: Array<[string, string]>
): LayoutComponentResult {
  const ids = componentNodes.map((node) => node.id);
  const idSet = new Set(ids);
  const nodeById = new Map(componentNodes.map((node) => [node.id, node] as const));
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const id of ids) {
    outgoing.set(id, []);
    incoming.set(id, []);
  }
  for (const [source, target] of edgePairs) {
    if (!idSet.has(source) || !idSet.has(target) || source === target) {
      continue;
    }
    outgoing.get(source)!.push(target);
    incoming.get(target)!.push(source);
  }

  const level = computeLevels(ids, outgoing, incoming);
  // List of node ids per layer; the initial order is by original position (top -> bottom, left -> right), giving later iterations a stable starting point.
  const columns = new Map<number, string[]>();
  for (const node of componentNodes) {
    const lvl = level.get(node.id) ?? 0;
    const bucket = columns.get(lvl) ?? [];
    bucket.push(node.id);
    columns.set(lvl, bucket);
  }
  const sortedLevels = [...columns.keys()].sort((a, b) => a - b);
  for (const lvl of sortedLevels) {
    columns.get(lvl)!.sort((a, b) => {
      const na = nodeById.get(a)!;
      const nb = nodeById.get(b)!;
      if (na.position.y !== nb.position.y) {
        return na.position.y - nb.position.y;
      }
      return na.position.x - nb.position.x;
    });
  }

  const indexInLayer = (lvl: number): Map<string, number> => {
    const map = new Map<string, number>();
    (columns.get(lvl) ?? []).forEach((id, index) => map.set(id, index));
    return map;
  };

  // -- Phase 1: median heuristic ordering, reducing edge crossings between adjacent layers --
  // Each pass reorders a layer by "the median of the positions of connected nodes in the adjacent layer"; alternating up and down sweeps converge over several passes.
  for (let sweep = 0; sweep < ORDER_SWEEPS; sweep += 1) {
    const downward = sweep % 2 === 0;
    const order = downward ? sortedLevels.slice(1) : [...sortedLevels].reverse().slice(1);
    for (const lvl of order) {
      const adjLevel = downward ? lvl - 1 : lvl + 1;
      const adjIndex = indexInLayer(adjLevel);
      const neighborMap = downward ? incoming : outgoing;
      const arr = columns.get(lvl)!;
      const currentIndex = new Map(arr.map((id, index) => [id, index] as const));
      const keyed = arr.map((id) => {
        const neighborIndices = (neighborMap.get(id) ?? [])
          .map((neighbor) => adjIndex.get(neighbor))
          .filter((value): value is number => value !== undefined)
          .sort((a, b) => a - b);
        // Nodes with no connected neighbors keep their relative positions, avoiding being scattered at random.
        const key = neighborIndices.length > 0 ? median(neighborIndices) : currentIndex.get(id)!;
        return { id, key, fallback: currentIndex.get(id)! };
      });
      keyed.sort((a, b) => (a.key !== b.key ? a.key - b.key : a.fallback - b.fallback));
      columns.set(lvl, keyed.map((entry) => entry.id));
    }
  }

  // -- Column width / column X coordinates (left -> right in order, equal width and centered within a layer) --
  const columnWidths = new Map<number, number>();
  for (const lvl of sortedLevels) {
    let maxWidth = 0;
    for (const id of columns.get(lvl)!) {
      maxWidth = Math.max(maxWidth, getNodeSize(nodeById.get(id)!).width);
    }
    columnWidths.set(lvl, maxWidth);
  }
  const columnX = new Map<number, number>();
  let xCursor = 0;
  for (const lvl of sortedLevels) {
    columnX.set(lvl, xCursor);
    xCursor += (columnWidths.get(lvl) ?? 0) + COLUMN_GAP;
  }

  // -- Phase 2: vertical coordinate assignment (barycenter method) --
  // First stack in order to get initial centers; then over several passes pull each node toward the average height of its connected nodes in the adjacent layer,
  // vertically aligning connected nodes and noticeably reducing long diagonals/crossings.
  const heights = new Map<string, number>();
  for (const id of ids) {
    heights.set(id, getNodeSize(nodeById.get(id)!).height);
  }
  const centerY = new Map<string, number>();
  for (const lvl of sortedLevels) {
    let yCursor = 0;
    for (const id of columns.get(lvl)!) {
      const half = (heights.get(id) ?? DEFAULT_NODE_HEIGHT) / 2;
      centerY.set(id, yCursor + half);
      yCursor += (heights.get(id) ?? DEFAULT_NODE_HEIGHT) + ROW_GAP;
    }
  }
  for (let sweep = 0; sweep < COORD_SWEEPS; sweep += 1) {
    const downward = sweep % 2 === 0;
    const order = downward ? sortedLevels : [...sortedLevels].reverse();
    for (const lvl of order) {
      const adjLevel = downward ? lvl - 1 : lvl + 1;
      const neighborMap = downward ? incoming : outgoing;
      const arr = columns.get(lvl)!;
      const desired = new Map<string, number>();
      for (const id of arr) {
        const neighborCenters = (neighborMap.get(id) ?? [])
          .filter((neighbor) => level.get(neighbor) === adjLevel)
          .map((neighbor) => centerY.get(neighbor)!)
          .filter((value) => value !== undefined);
        if (neighborCenters.length > 0) {
          desired.set(id, mean(neighborCenters));
        }
      }
      resolveColumnCenters(arr, desired, heights, centerY);
    }
  }

  // -- Phase 3: compress full-width vertical blank bands, removing the large middle gaps left by the barycenter method --
  compactVerticalBands(ids, heights, centerY);

  // -- Wrap-up: convert center coordinates to top-left coordinates and normalize to the component-local (0,0) --
  const positions = new Map<string, { x: number; y: number }>();
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const lvl of sortedLevels) {
    const colX = columnX.get(lvl) ?? 0;
    const colWidth = columnWidths.get(lvl) ?? 0;
    for (const id of columns.get(lvl)!) {
      const size = getNodeSize(nodeById.get(id)!);
      const x = colX + (colWidth - size.width) / 2;
      const y = (centerY.get(id) ?? 0) - size.height / 2;
      positions.set(id, { x, y });
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x + size.width);
      maxY = Math.max(maxY, y + size.height);
    }
  }

  if (!Number.isFinite(minX)) {
    return { positions, width: 0, height: 0 };
  }
  for (const [id, pos] of positions) {
    positions.set(id, { x: pos.x - minX, y: pos.y - minY });
  }
  return { positions, width: maxX - minX, height: maxY - minY };
}

export interface AutoLayoutResult {
  positions: Record<string, { x: number; y: number }>;
  changedCount: number;
}

export function computeAutoLayout(
  nodes: CanvasNode[],
  edges: CanvasEdge[]
): AutoLayoutResult {
  const topLevelNodes = nodes.filter((node) => !node.parentId);
  if (topLevelNodes.length === 0) {
    return { positions: {}, changedCount: 0 };
  }

  const topLevelIds = new Set(topLevelNodes.map((node) => node.id));
  const edgePairs: Array<[string, string]> = [];
  for (const edge of edges) {
    if (topLevelIds.has(edge.source) && topLevelIds.has(edge.target)) {
      edgePairs.push([edge.source, edge.target]);
    }
  }

  const anchorX = topLevelNodes.reduce(
    (acc, node) => Math.min(acc, node.position.x),
    Number.POSITIVE_INFINITY
  );
  const anchorY = topLevelNodes.reduce(
    (acc, node) => Math.min(acc, node.position.y),
    Number.POSITIVE_INFINITY
  );
  const baseX = Number.isFinite(anchorX) ? anchorX : 0;
  const baseY = Number.isFinite(anchorY) ? anchorY : 0;

  const components = computeComponents(topLevelNodes, edgePairs);
  // Ordering is still by "original position top-left -> bottom-right", keeping the relative order after tidying close to the user's mental positions,
  // making it easy to quickly locate a node from memory after the rearrangement.
  components.sort((a, b) => {
    const aMin = Math.min(...a.map((node) => node.position.y));
    const bMin = Math.min(...b.map((node) => node.position.y));
    if (aMin !== bMin) {
      return aMin - bMin;
    }
    const aX = Math.min(...a.map((node) => node.position.x));
    const bX = Math.min(...b.map((node) => node.position.x));
    return aX - bX;
  });

  // First lay out inside each connected component and get their respective bboxes.
  const laidOut = components.map((component) => ({
    component,
    layout: layoutComponent(component, edgePairs),
  }));

  // Estimate the target strip width of shelf packing: derive it back from the total area + desired aspect ratio, and guarantee at least
  // room for the widest single component. This lets one row hold several small components, while also avoiding a large component being
  // cut off by a forced line break.
  const totalArea = laidOut.reduce(
    (acc, item) => acc + item.layout.width * item.layout.height,
    0,
  );
  const widestComponent = laidOut.reduce(
    (acc, item) => Math.max(acc, item.layout.width),
    0,
  );
  const idealStripWidth = totalArea > 0
    ? Math.sqrt(totalArea * TARGET_PAGE_ASPECT)
    : 0;
  const stripWidth = Math.max(idealStripWidth, widestComponent);

  // Shelf packing: fill the current row from left to right, and move to the next row when stripWidth is exceeded.
  // Row height = the maximum height of the components in that row, and the next row counts from baseY + rowYCursor.
  const positions: Record<string, { x: number; y: number }> = {};
  let rowXCursor = 0;
  let rowYCursor = 0;
  let currentRowMaxHeight = 0;
  for (const { layout } of laidOut) {
    if (rowXCursor > 0 && rowXCursor + layout.width > stripWidth) {
      rowYCursor += currentRowMaxHeight + COMPONENT_GAP_Y;
      rowXCursor = 0;
      currentRowMaxHeight = 0;
    }
    for (const [id, pos] of layout.positions) {
      positions[id] = {
        x: baseX + rowXCursor + pos.x,
        y: baseY + rowYCursor + pos.y,
      };
    }
    rowXCursor += layout.width + COMPONENT_GAP_X;
    currentRowMaxHeight = Math.max(currentRowMaxHeight, layout.height);
  }

  let changedCount = 0;
  const nodeMap = new Map(topLevelNodes.map((node) => [node.id, node] as const));
  for (const [id, pos] of Object.entries(positions)) {
    const node = nodeMap.get(id);
    if (!node) {
      continue;
    }
    if (Math.round(node.position.x) !== Math.round(pos.x)
      || Math.round(node.position.y) !== Math.round(pos.y)) {
      changedCount += 1;
    }
  }

  return { positions, changedCount };
}

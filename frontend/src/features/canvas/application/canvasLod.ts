// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * "Detail degradation" (LOD) rules for canvas panning.
 *
 * Background (measured, 69 nodes / zoom 0.1 / the same machine):
 *   baseline                                    62.3 fps, p90 frame time 26.6ms
 *   only remove backdrop-filter/shadow/filter   66.8 fps, p90 frame time 26.2ms
 *   only hide <video>                           66.3 fps, p90 frame time 26.4ms
 *   remove both                                 74.5 fps, p90 frame time 14.1ms
 *
 * p90 at 26ms is exactly two vsync periods, i.e. one frame dropped for every 10 frames; the "stutter" the eye sees
 * is this, not the average fps. Cutting any single item cannot get back across the 13.3ms budget line; both must
 * be cut together. The reference liblib.tv at the same zoom is 74.6 fps / p90 14.1ms, with 0 <video> on its canvas cards
 * and a backdrop-filter density only 1/4 of ours - this is a trade-off, not a trick.
 *
 * So there are two tiers:
 *   - Gesture tier (panning/zooming in progress): only turn off visual effects. Nobody can see frosted glass and
 *     shadows while moving; they come back as soon as the gesture stops, with zero visual change in the steady state.
 *   - Low-zoom tier: nodes are already tiny on screen, so additionally replace <video> with a static first frame/placeholder block.
 *     Video layers are independent compositing layers whose count grows linearly with nodes, and only replacing them gets back across the budget line.
 */

/**
 * Low-zoom tier threshold. Only below it are videos degraded to static images.
 *
 * The standard canvas node width is about 320-400px, taking about 110-140px on screen at 0.35x; at that point no useful information
 * can be made out in the first frame, so switching to a static image loses no readability. Above this value everything stays as is, avoiding
 * any behavior change in the common working zoom range (0.5-1).
 */
export const LOW_DETAIL_ZOOM_THRESHOLD = 0.35;

export function isLowDetailZoom(zoom: number): boolean {
  return Number.isFinite(zoom) && zoom < LOW_DETAIL_ZOOM_THRESHOLD;
}

/**
 * Node types that are not shell-replaced at the low-zoom tier.
 *
 * - skillNode: the generation task resume logic lives inside the component (SkillNode has its own resume effect, not covered by
 *   the Canvas-layer resumeGeneration), so a task completing during unmount would have nobody to write back; and its
 *   handle id set is dynamic (the union of spec role / beat references / existing edges), so replicating it in a shell
 *   is not worth it. There are very few skill nodes, so they keep full rendering.
 * - groupNode: storyboard groups carry a dragHandle (.storyboard-group-drag-handle) and conditionally rendered
 *   handle pairs; a shell would break dragging and edge anchoring; the group itself is just a title box, with negligible render cost.
 * - beatContextNode: the start-frame draft is only persisted on onBlur, and React unmount does not dispatch blur, so
 *   shelling it during editing would lose the input outright.
 */
export const LOD_SHELL_EXEMPT_TYPES: ReadonlySet<string> = new Set([
  'skillNode',
  'groupNode',
  'beatContextNode',
]);

/* ------------------------------------------------------------------------- *
 * "Node media active" signal
 *
 * A playing video must not be shelled - the user actively playing it means they are watching, and even at small zoom the player should not
 * be pulled out (it would also lose the playback progress). The playing state was originally a ref inside the VideoNode component, while the shell
 * decision happens outside the component and cannot read it, so it is lifted into a module-level registry.
 *
 * Deliberately not made reactive: registry changes do not trigger re-rendering and take effect naturally the next time a tier is crossed/remounted.
 * The cost is that "after pausing at the low-zoom tier the node keeps full rendering until the next tier crossing" - a single node, acceptable.
 * ------------------------------------------------------------------------- */

const mediaActiveNodes = new Set<string>();

export function setNodeMediaActive(nodeId: string, active: boolean): void {
  if (active) mediaActiveNodes.add(nodeId);
  else mediaActiveNodes.delete(nodeId);
}

export function isNodeMediaActive(nodeId: string): boolean {
  return mediaActiveNodes.has(nodeId);
}

/** Attached to the canvas container while a gesture is in progress; CSS uses it to turn off backdrop-filter / shadow / filter. */
export const CANVAS_PANNING_CLASS = 'dc-canvas--panning';

/** Attached to the canvas container at the low-zoom tier; also turns off effects and additionally gives nodes a degradation hook. */
export const CANVAS_LOW_DETAIL_CLASS = 'dc-canvas--low-detail';

/**
 * How long after a gesture ends to remove the panning class.
 *
 * React Flow's onMoveEnd may fire before inertial scrolling (trackpad/wheel) has really stopped,
 * and restoring effects immediately would drop frames again on the tail of the glide. 80ms is enough to cover the tail frames, and short enough not to
 * be perceived as "effects coming back half a beat late".
 */
export const PANNING_CLASS_RELEASE_DELAY_MS = 80;

/* ------------------------------------------------------------------------- *
 * "Is the canvas still" signal
 *
 * Several places in nodes need to read scrollWidth / clientWidth / getBoundingClientRect to
 * decide how to render (e.g. title overflow fade). Such reads force a synchronous layout, about 2ms each on a DOM of this size.
 * Normally harmless, but during fast panning React Flow's visibility culling mounts 3~4 nodes per frame, and each newly mounted node runs it -
 * that is layout jitter on the order of 20ms per frame, and the measured drag frame rate dropped to around 20fps because of it.
 *
 * So give them a unified "do not measure now" signal: skip during a gesture, or at the low-zoom tier (where text is only
 * a few pixels tall and measuring brings no readability benefit), and measure again once the canvas settles.
 *
 * Deliberately not React state: when this signal changes it must notify hundreds of nodes, and going through state would hand the saved
 * layout time back to render. Subscribers decide for themselves whether to setState after receiving the callback.
 * ------------------------------------------------------------------------- */

let gestureActive = false;
let lowDetailActive = false;
const resumeListeners = new Set<() => void>();

function notifyIfSettled(wasDeferred: boolean): void {
  if (wasDeferred && !isCanvasMeasurementDeferred()) {
    for (const listener of resumeListeners) listener();
  }
}

export function setCanvasGestureActive(active: boolean): void {
  if (gestureActive === active) return;
  const wasDeferred = isCanvasMeasurementDeferred();
  gestureActive = active;
  notifyIfSettled(wasDeferred);
}

export function setCanvasLowDetail(active: boolean): void {
  if (lowDetailActive === active) return;
  const wasDeferred = isCanvasMeasurementDeferred();
  lowDetailActive = active;
  notifyIfSettled(wasDeferred);
}

/** true means "reading layout now is not worthwhile", and callers should skip measuring. */
export function isCanvasMeasurementDeferred(): boolean {
  return gestureActive || lowDetailActive;
}

/** Whether a gesture (pan/zoom) is in progress. The shell upgrade pump pauses grants accordingly. */
export function isCanvasGestureActive(): boolean {
  return gestureActive;
}

/* ------------------------------------------------------------------------- *
 * The "all-shell first frame" window when switching canvases
 *
 * Switching canvases mounts hundreds of nodes at once. Even if the camera is positioned first (see hydrate in useCanvasSync),
 * dozens of full components inside the viewport may still have to mount in the same commit, and that is the freeze of several hundred
 * milliseconds. Here hydrate opens a short window: nodes mounted inside the window all start as shells
 * (~4 elements), and are then handed to the upgrade queue above, which completes 3 per frame into full components - one long frame is spread into
 * dozens of short frames, so the user sees "gray blocks first, filled in one by one" rather than "a white screen flash".
 *
 * The window is closed with two rAFs rather than a timer: after the first rAF the mount commit is done, and the second covers
 * the second wave of mounts from culling recomputed after ReactFlow applies the viewport. After that nodes newly entering the viewport follow the original
 * gesture rules, unrelated to this window.
 * ------------------------------------------------------------------------- */

let hydrateBurstActive = false;

/** Whether the hydrate first-frame window is open. Node mounts use it to decide whether to start from a shell. */
export function isCanvasHydrateBurstActive(): boolean {
  return hydrateBurstActive;
}

/** Called before setCanvasData to open the "everything mounted this time starts as a shell" window. */
export function beginCanvasHydrateBurst(): void {
  hydrateBurstActive = true;
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      hydrateBurstActive = false;
    });
  });
}

/* ------------------------------------------------------------------------- *
 * Zoom tier sync when switching canvases
 *
 * The camera is positioned with reactFlow.setViewport before nodes are mounted, but Canvas's
 * lowDetailActive (which drives onlyRenderVisibleElements) is only updated by onMove/onMoveEnd,
 * and ReactFlow's programmatic setViewport dispatches those events only on the next beat. So the new canvas's nodes
 * are mounted according to "the previous canvas's zoom tier": 0.6 -> 0.2 would first mount a dozen or so by culling and then flip to all,
 * and 0.2 -> 0.6 would first mount all 354 and then cull back to a dozen - a whole wave mounted in vain in both directions.
 *
 * Here hydrate gets a direct channel: in the same event it synchronously feeds Canvas the target zoom, and React
 * batches it with setCanvasData into the same commit, so nodes mount at the final tier in one go.
 * ------------------------------------------------------------------------- */

const hydrateViewportListeners = new Set<(zoom: number) => void>();

/** Canvas subscribes to the target zoom of a canvas switch; returns the unsubscribe function. */
export function onCanvasHydrateViewport(
  listener: (zoom: number) => void,
): () => void {
  hydrateViewportListeners.add(listener);
  return () => {
    hydrateViewportListeners.delete(listener);
  };
}

/** Called on hydrate; must be in the same event as setCanvasData to be batched into the same commit. */
export function notifyCanvasHydrateViewport(zoom: number): void {
  for (const listener of hydrateViewportListeners) listener(zoom);
}

/* ------------------------------------------------------------------------- *
 * Batched upgrade queue from shell to full component
 *
 * Mounting a full node component is expensive (VideoNode ~5ms each: hundreds of hooks + handle measurement reflow +
 * store subscription storm), and mounting several in one frame drops frames. So every shell upgrade to a full component queues for a
 * quota: only UPGRADES_PER_FRAME are granted per frame, and none at all during a gesture (the user is moving the
 * canvas, and shells are exactly what this tier should look like).
 *
 * Two sources share this one queue:
 *   1. All shells inside the viewport when zoom upgrades a tier (leaving low zoom) - previously all upgraded in one commit, measured
 *      as two long frames of 179ms + 234ms; spread out after batching.
 *   2. Nodes newly mounted into the viewport during a gesture - previously mounted as full components directly, dozens of times per second during
 *      fast panning, the source of the steady-state 40fps spikes.
 * ------------------------------------------------------------------------- */

/**
 * Upgrades granted per frame. A VideoNode-level mount is ~5ms each, 3 is about 15ms, just touching
 * the 13.3ms budget line of 75Hz; any larger becomes perceptible again.
 */
const UPGRADES_PER_FRAME = 3;

type UpgradeGrant = () => void;
const upgradeQueue: UpgradeGrant[] = [];
let upgradePumpScheduled = false;

function pumpUpgrades(): void {
  upgradePumpScheduled = false;
  if (upgradeQueue.length === 0) return;
  // No grants during a gesture, but keep the pump alive so it continues the next frame after the gesture stops.
  if (!gestureActive) {
    for (const grant of upgradeQueue.splice(0, UPGRADES_PER_FRAME)) grant();
  }
  if (upgradeQueue.length > 0) scheduleUpgradePump();
}

function scheduleUpgradePump(): void {
  if (upgradePumpScheduled) return;
  upgradePumpScheduled = true;
  requestAnimationFrame(pumpUpgrades);
}

/**
 * Queue for one shell -> full component upgrade quota; `grant` is called back when it is your turn.
 * Returns a cancel function (called when the node is unmounted/downgraded again while queued).
 */
export function requestShellUpgrade(grant: UpgradeGrant): () => void {
  upgradeQueue.push(grant);
  scheduleUpgradePump();
  return () => {
    const index = upgradeQueue.indexOf(grant);
    if (index >= 0) upgradeQueue.splice(index, 1);
  };
}

/** Called back when the canvas is still again; returns the unsubscribe function. */
export function onCanvasMeasurementResume(listener: () => void): () => void {
  resumeListeners.add(listener);
  return () => {
    resumeListeners.delete(listener);
  };
}

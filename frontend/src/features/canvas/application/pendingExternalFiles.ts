// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
/**
 * The carrier of the "external File -> new node" delivery chain (module-level staging).
 *
 * Why the event bus alone is not enough: the senders (canvas file drop, pasted images,
 * spawnExternalAssetNodes, UploadNode morphing into video/audio) all "build the node first, send the File to it on the next frame",
 * and InMemoryCanvasEventBus has no replay semantics - at the moment of sending there is no
 * subscriber, and the File is lost forever. At the low-zoom tier (zoom < LOW_DETAIL_ZOOM_THRESHOLD) this
 * assumption simply does not hold: a new node first mounts as an LOD shell (see [[LodShellNode]]), and the full component only attaches its subscription once
 * the requestShellUpgrade upgrade queue releases it, necessarily later than the delivery frame. The result is an "Upload resource" node left
 * forever empty on the canvas, unrelated to the image the user dragged in.
 *
 * So the File itself is staged here, and the event is downgraded to "poke an already-mounted node":
 *   - Sender: after stashExternalFile(...) emit the event as usual (do both, see each delivery point);
 *   - Consumer: useExternalFileHandoff takes once on mount and once on receiving the event.
 * take is consuming (removed once taken), so "re-delivery on mount" and "immediate delivery on event" will not process the same
 * File twice, and no extra dedup marker is needed.
 *
 * New senders must stash - with publish but no stash the consumer side cannot see the File (the consumer only trusts what is in
 * staging, and does not read the file of the event payload).
 */
import type { CanvasEventMap } from '@/features/canvas/application/ports';

/** The three "inject external File" channels, one to one with the event names in [[ports]]. */
export type ExternalFileChannel = Extract<
  keyof CanvasEventMap,
  'upload-node/external-file' | 'video-node/external-file' | 'audio-node/external-file'
>;

/**
 * The cap is only a fallback: when a node is deleted before consuming (undo, accidentally deleting the node) nobody takes, and the entry would
 * keep holding the reference to the File forever. Beyond the cap the oldest is evicted in insertion order - Files waiting for delivery are naturally
 * "the few just dragged in", and in normal use the map never holds more than a few at a time.
 */
const MAX_PENDING = 64;

const pending = new Map<string, File>();

/**
 * The separator is NUL: neither channel names nor node ids can contain it, so no ambiguous key can be concatenated. It must be written as a
 * \u0000 escape - embedding a bare 0x00 byte directly would make git treat this file as binary, with neither a line-level diff in the PR nor any way to review it.
 */
function keyOf(channel: ExternalFileChannel, nodeId: string): string {
  return `${channel}\u0000${nodeId}`;
}

/** Stage a File waiting for delivery; stashing repeatedly for the same node, the last one wins. */
export function stashExternalFile(
  channel: ExternalFileChannel,
  nodeId: string,
  file: File,
): void {
  const key = keyOf(channel, nodeId);
  // Overwriting an existing entry does not make the map larger, in which case evicting would only discard an unrelated File waiting for delivery for nothing.
  if (pending.size >= MAX_PENDING && !pending.has(key)) {
    const oldest = pending.keys().next();
    if (!oldest.done) pending.delete(oldest.value);
  }
  pending.set(key, file);
}

/** Take away the File waiting for delivery (consuming); returns null if none. */
export function takeExternalFile(
  channel: ExternalFileChannel,
  nodeId: string,
): File | null {
  const key = keyOf(channel, nodeId);
  const file = pending.get(key);
  if (file === undefined) return null;
  pending.delete(key);
  return file;
}

/** For tests only: clear the staging, avoiding cross-contamination between cases. */
export function resetPendingExternalFilesForTest(): void {
  pending.clear();
}

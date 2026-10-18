// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { XYPosition } from '@xyflow/react';

import type { FreezoneJobRef } from '@/api/ops';
import type {
  CanvasEdge,
  CanvasNode,
  CanvasNodeData,
  CanvasNodeType,
  NodeToolType,
  StoryboardFrameItem,
} from '../domain/canvasNodes';
import type { CanvasNodeDefinition } from '../domain/nodeRegistry';

export interface IdGenerator {
  next: () => string;
}

export interface NodeCatalog {
  getDefinition: (type: CanvasNodeType) => CanvasNodeDefinition;
  getMenuDefinitions: () => CanvasNodeDefinition[];
}

export interface NodeFactory {
  createNode: (
    type: CanvasNodeType,
    position: XYPosition,
    data?: Partial<CanvasNodeData>
  ) => CanvasNode;
}

export interface GraphImageResolver {
  collectInputImages: (nodeId: string, nodes: CanvasNode[], edges: CanvasEdge[]) => string[];
}

/**
 * A single "upstream node content" record. All possible fields are optional, and callers take what they need.
 * `text` comes from any upstream node carrying prompt / content, and `imageUrl` / `videoUrl` /
 * `audioUrl` come from material-type nodes.
 */
export interface UpstreamContent {
  nodeId: string;
  nodeType: CanvasNodeType;
  displayName?: string;
  workflowStepId?: string;
  text?: string;
  imageUrl?: string;
  videoUrl?: string;
  audioUrl?: string;
}

export interface GraphContentResolver {
  collectInputContents: (
    nodeId: string,
    nodes: CanvasNode[],
    edges: CanvasEdge[]
  ) => UpstreamContent[];
}

export interface GenerateImagePayload {
  prompt: string;
  model: string;
  /** Registry model id (for restoration), distinguished from the backend request model string. */
  modelId?: string;
  /** Generation mode (for restoration). */
  generationMode?: string;
  size: string;
  aspectRatio: string;
  referenceImages?: string[];
  extraParams?: Record<string, unknown>;
  /**
   * Dynamic parameter values declared by the backend "media models", submitted as `model_params` as is, and validated by the backend
   * `media_model_request_schema` against the catalog declaration.
   *
   * Kept apart from `extraParams`: that is the old structure of the frontend static registry, where the gateway reads only quality from it
   * and discards all other keys - stuffing catalog parameters into it would be filling them in for nothing.
   */
  modelParams?: Record<string, unknown>;
  capabilityId?: string;
  /** Triggering node id, forwarded so the backend records per-node history. */
  nodeId?: string;
  capabilityParams?: Record<string, unknown>;
  capabilityInputs?: Record<
    string,
    {
      nodeId?: string;
      role?: string;
      sourceUrl?: string;
      assetKind?: string;
    }
  >;
}

/**
 * The return value of submitGenerateImageJob.
 *
 * The lifecycles of the two ids are entirely different, and keeping only one is not enough:
 * - `jobId` is the gateway's in-process Map key, serving only that polling loop in Canvas.tsx, and invalid after a refresh;
 * - `ref` is the backend task handle, and persisting it on the node (see generationTaskDescriptor) is the only clue
 *   for resumeNodeGeneration to find the result after a refresh.
 *
 * Earlier this returned only jobId, so after detaching from listening there was no way out other than resubmitting - the erase/redraw path
 * has always been right (see regenerateFreezoneRedrawNode), and this brings it in line.
 */
export interface SubmittedImageJob {
  jobId: string;
  ref: FreezoneJobRef;
}

export interface AiGateway {
  setApiKey: (provider: string, apiKey: string) => Promise<void>;
  generateImage: (payload: GenerateImagePayload) => Promise<string>;
  submitGenerateImageJob: (payload: GenerateImagePayload) => Promise<SubmittedImageJob>;
  getGenerateImageJob: (jobId: string) => Promise<{
    job_id: string;
    // 'detached': the front-end stopped following the task; it is NOT a
    // failure and must never be rendered as one (see TaskPollTimeoutError).
    status: 'queued' | 'running' | 'succeeded' | 'failed' | 'detached' | 'not_found';
    result?: string | null;
    error?: string | null;
  }>;
}

export interface ImageSplitGateway {
  split: (
    imageSource: string,
    rows: number,
    cols: number,
    lineThickness: number
  ) => Promise<string[]>;
}

export interface ToolProcessorResult {
  outputImageUrl?: string;
  storyboardFrames?: StoryboardFrameItem[];
  rows?: number;
  cols?: number;
  frameAspectRatio?: string;
}

export interface ToolProcessor {
  process: (
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>
  ) => Promise<ToolProcessorResult>;
}

export interface CanvasEventMap {
  'tool-dialog/open': {
    nodeId: string;
    toolType: NodeToolType;
  };
  'tool-dialog/close': undefined;
  'upload-node/reupload': {
    nodeId: string;
  };
  'upload-node/paste-image': {
    nodeId: string;
    file: File;
  };
  /**
   * External entries such as the "Upload resource" menu, canvas drag-and-drop, and the video node's "external materials" inject a File into the
   * upload node. Images/videos/audio are all accepted - the UploadNode subscription side uses a three-way dispatcher
   * handleMediaFile, and videos and audio morph in place via convertNodeType into video/audio nodes
   * (the id is unchanged, so the edge connected first is not lost). Non-media files are silently discarded, and the sender should filter first by itself.
   *
   * The carrier of the File itself is the module-level staging of [[pendingExternalFiles]], and the payload deliberately does not carry
   * file: the sender must do both stashExternalFile + emit the event; the event itself is only "poke an already
   * mounted node", and the consumer (useExternalFileHandoff) only trusts what is in staging. The reason is that the bus has no
   * replay, and at the low-zoom tier a new node first mounts as an LOD shell, so by the time the full component attaches its subscription an early-sent event is already
   * lost. The payload not carrying file is so that the pattern "publish without stash" does not compile at all.
   */
  'upload-node/external-file': {
    nodeId: string;
  };
  'video-node/reupload': {
    nodeId: string;
  };
  /**
   * External entries such as the "Upload resource" menu inject a File into the video node (video only).
   * Same as upload-node/external-file: the File goes through [[pendingExternalFiles]] staging and does not enter the payload.
   */
  'video-node/external-file': {
    nodeId: string;
  };
  /**
   * External entries such as the "Upload resource" menu inject a File into the audio node (audio only).
   * Same as upload-node/external-file: the File goes through [[pendingExternalFiles]] staging and does not enter the payload.
   */
  'audio-node/external-file': {
    nodeId: string;
  };
  'video-viewer/open': {
    videoUrl: string;
    title?: string;
  };
  /**
   * Triggered by the Commit button on the node toolbar: write the node's image back to the matching slot of the main flow.
   * FreezoneShell listens, looks up the node and pushes CommitDialog; the toolbar only emits the event.
   */
  'freezone/commit-node': {
    nodeId: string;
    auto?: boolean;
    successMessage?: string;
  };
  /** Triggered by the projection group toolbar: refresh that projection, without the toolbar changing canvas state directly. */
  'freezone/projection-sync': {
    projectionKey: string;
  };
  /** Triggered by the projection group toolbar: remove that projection, without going through the ordinary deleteNode. */
  'freezone/projection-remove': {
    projectionKey: string;
  };
  /** Triggered by the canvas toolbar: add the currently selected node as a reference into the Freezone chat input box. */
  'freezone/add-nodes-to-chat': {
    nodeIds: string[];
  };
  /** Chat triggers a low-risk node UI action; actual execution is done by Canvas/SelectedNodeOverlay reusing the existing toolbar handlers. */
  'freezone/run-node-action': {
    nodeId: string;
    action: string;
    parameters?: Record<string, unknown>;
    executionMode?: 'single' | 'workflow';
    requestId?: string;
  };
  /** After a node action carrying a requestId finishes, report back to the chat command dispatcher. */
  'freezone/node-action-result': {
    requestId: string;
    nodeId: string;
    action: string;
    status: 'success' | 'error';
    error?: string;
    output?: Record<string, unknown>;
  };
  /** The node has taken over an action carrying a requestId; used to tell "generating" apart from "the event has no handler". */
  'freezone/node-action-accepted': {
    requestId: string;
    nodeId: string;
    action: string;
  };
  /** The main-line asset has been written directly inside the node, notify the asset library to re-fetch. */
  'freezone/assets-updated': undefined;
}

export interface CanvasEventBus {
  publish: <TType extends keyof CanvasEventMap>(
    type: TType,
    payload: CanvasEventMap[TType]
  ) => number;
  subscribe: <TType extends keyof CanvasEventMap>(
    type: TType,
    handler: (payload: CanvasEventMap[TType]) => void
  ) => () => void;
}

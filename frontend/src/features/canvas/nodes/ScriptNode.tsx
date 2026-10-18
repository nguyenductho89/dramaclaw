// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  Handle,
  Position,
  useUpdateNodeInternals,
  type NodeProps,
} from '@xyflow/react';
import {
  AlignJustify,
  ArrowUp,
  AlertCircle,
  ChevronDown,
  Expand,
  FileText,
  ImageIcon,
  Languages,
  Loader2,
  Upload,
  User,
  Video,
  X,
} from 'lucide-react';

import {
  CANVAS_NODE_TYPES,
  isAudioNode,
  isExportImageNode,
  isImageEditNode,
  isImageGenNode,
  isTextAnnotationNode,
  isUploadNode,
  isVideoNode,
  type CanvasNode,
  type CanvasNodeType,
  type ScriptGenAction,
  type ScriptNodeData,
} from '@/features/canvas/domain/canvasNodes';
import { isRenderableImageSrc, resolveImageDisplayUrl } from '@/features/canvas/application/imageData';
import { localizeNodeDisplayName } from '@/features/canvas/domain/nodeDisplay';
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from '@/features/canvas/ui/NodeHeader';
import { NodeResizeHandle } from '@/features/canvas/ui/NodeResizeHandle';
import { NodeGenerationOverlay } from '@/features/canvas/ui/NodeGenerationOverlay';
import { RegenerateButton } from '@/features/canvas/ui/RegenerateButton';
import { EditableTableCell } from '@/features/canvas/ui/EditableTableCell';
import {
  CANVAS_NODE_INPUT_FRAME_CLASS,
  CANVAS_NODE_INPUT_PLACEHOLDER_CLASS,
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  CANVAS_NODE_PANEL_SURFACE_CLASS,
  canvasNodeFrameClass,
} from '@/features/canvas/ui/nodeFrameStyles';
import { OperationPanelShell } from '@/features/canvas/ui/OperationPanelShell';
import { PanelExpandButton } from '@/features/canvas/ui/PanelExpandButton';
import { useCanvasStore } from '@/stores/canvasStore';
import {
  fetchFreezoneStoryScriptResult,
  fetchFreezoneTextTranslateResult,
  submitFreezoneStoryScript,
  submitFreezoneTextTranslate,
  uploadFreezoneImage,
  type FreezoneGenerationHistoryRecord,
  type FreezoneStoryScriptResult,
  type FreezoneStoryScriptRow,
} from '@/api/ops';
import { awaitTaskCompletion } from '@/api/tasks';
import { generationTaskDescriptor } from '@/features/canvas/application/resumeGeneration';
import { useUpstreamNodes } from '@/features/canvas/application/useUpstreamGraph';
import { useNodeGenerationTaskState } from '@/features/canvas/application/useNodeGenerationTaskState';
import { useNodeGenerationHistory } from '@/features/canvas/hooks/useNodeGenerationHistory';
import {
  NodeGenerationHistory,
  hasCompletedHistoryRecords,
} from '@/features/canvas/ui/NodeGenerationHistory';
import { useModelTaskAccess } from '@/lib/model-task-access';
import { readUrl } from '@/lib/url-params';
import {
  BillingRuleNotConfiguredError,
  backendErrorToastMessage,
} from '@/lib/api-errors';
import { CreditCostPill } from '@/components/credits/credit-visual';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import {
  NODE_CREDIT_PILL_FLAT_CLASS,
  NODE_GENERATE_BUTTON_BASE_CLASS,
  NODE_GENERATE_BUTTON_DISABLED_CLASS,
  NODE_GENERATE_BUTTON_ENABLED_CLASS,
  NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS,
  NODE_INLINE_ICON_BUTTON_CLASS,
} from '@/features/canvas/ui/nodeControlStyles';

type ScriptNodeProps = NodeProps & {
  id: string;
  data: ScriptNodeData;
  selected?: boolean;
};

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 320;
// After a table appears, enlarge by default to the libtv-equivalent size (800x400).
const DEFAULT_WIDTH_WITH_RESULT = 800;
const DEFAULT_HEIGHT_WITH_RESULT = 400;
const MIN_WIDTH = 360;
const MIN_HEIGHT = 240;
const MAX_WIDTH = 1600;
const MAX_HEIGHT = 1200;
const PANEL_GAP_PX = 12;
const PANEL_OVERHANG_PX = 60;
const TEXT_TRANSLATE_FEATURE_KEY = 'freezone.text_translate';
const STORY_SCRIPT_FEATURE_KEY = 'freezone.story_script';
// Input panel size after "enlarge": a more comfortable height and width for the prompt editing area (same experience as ImageGenNode).
const OPS_PANEL_EXPANDED_WIDTH = 880;
const OPS_PANEL_EXPANDED_HEIGHT = 560;

// Estimated sizes of upstream nodes (aligned with each node's DEFAULT_WIDTH / DEFAULT_HEIGHT),
// used to compute coordinates when placing generated text / video / upload nodes to the left of the script node.
// Note: the actual size of addNode is decided by canvasNodeFactory; these are only approximations for layout.
const SPAWN_TEXT_WIDTH = 440;
const SPAWN_TEXT_HEIGHT = 320;
const SPAWN_VIDEO_WIDTH = 580;
const SPAWN_VIDEO_HEIGHT = 380;
const SPAWN_UPLOAD_WIDTH = 320;
const SPAWN_UPLOAD_HEIGHT = 350;
const SPAWN_GAP_X = 40;
const SPAWN_GAP_Y = 24;

// The backend freezone/text/story-script endpoint will change in the future; model params are not controlled by the frontend for now
// and no selector is exposed in the UI; no model is passed on submit, and the backend default behavior decides.

interface ScriptActionDef {
  key: ScriptGenAction;
  labelKey: string;
  Icon: typeof AlignJustify;
}

const SCRIPT_ACTIONS: ScriptActionDef[] = [
  {
    key: 'fromScript',
    labelKey: 'node.scriptNode.action.fromScript',
    Icon: AlignJustify,
  },
  {
    key: 'fromVideoRef',
    labelKey: 'node.scriptNode.action.fromVideoRef',
    Icon: Video,
  },
  {
    key: 'fromCharacter',
    labelKey: 'node.scriptNode.action.fromCharacter',
    Icon: User,
  },
];

// Aligned with the libtv script table columns: 19 columns, widths hard-set in pixels, with the overall min-width inherited from tailwind.
// The keys must match the field names of the backend FreezoneStoryScriptRow verbatim — previously the backend never sent the character /
// character_desc_1 / action keys, so those three columns always showed "-" (issue #207).
type ScriptCellRender = 'text' | 'image';

interface ScriptColumnDef {
  key: string;
  /** Header labels are UI copy and a module-level constant cannot reach t, so keys are stored and translated at render. */
  labelKey: string;
  /** Pixel width (used as both min-width and width, so columns do not jitter under long text). */
  widthPx: number;
  render?: ScriptCellRender;
}

const SCRIPT_COLUMNS: ScriptColumnDef[] = [
  { key: 'shot_no', labelKey: 'node.scriptNode.column.shot_no', widthPx: 60 },
  { key: 'duration', labelKey: 'node.scriptNode.column.duration', widthPx: 80 },
  { key: 'visual_description', labelKey: 'node.scriptNode.column.visual_description', widthPx: 200 },
  { key: 'character_1', labelKey: 'node.scriptNode.column.character_1', widthPx: 120 },
  { key: 'character_description_1', labelKey: 'node.scriptNode.column.character_description_1', widthPx: 180 },
  { key: 'character_image_1', labelKey: 'node.scriptNode.column.character_image_1', widthPx: 80, render: 'image' },
  { key: 'character_2', labelKey: 'node.scriptNode.column.character_2', widthPx: 120 },
  { key: 'character_description_2', labelKey: 'node.scriptNode.column.character_description_2', widthPx: 180 },
  { key: 'character_image_2', labelKey: 'node.scriptNode.column.character_image_2', widthPx: 80, render: 'image' },
  { key: 'reference', labelKey: 'node.scriptNode.column.reference', widthPx: 80, render: 'image' },
  { key: 'shot', labelKey: 'node.scriptNode.column.shot', widthPx: 120 },
  { key: 'character_action', labelKey: 'node.scriptNode.column.character_action', widthPx: 120 },
  { key: 'emotion', labelKey: 'node.scriptNode.column.emotion', widthPx: 120 },
  { key: 'scene_tags', labelKey: 'node.scriptNode.column.scene_tags', widthPx: 120 },
  { key: 'lighting_mood', labelKey: 'node.scriptNode.column.lighting_mood', widthPx: 120 },
  { key: 'sound', labelKey: 'node.scriptNode.column.sound', widthPx: 120 },
  { key: 'dialogue', labelKey: 'node.scriptNode.column.dialogue', widthPx: 120 },
  { key: 'shot_prompt', labelKey: 'node.scriptNode.column.shot_prompt', widthPx: 200 },
  { key: 'video_motion_prompt', labelKey: 'node.scriptNode.column.video_motion_prompt', widthPx: 200 },
];

const SCRIPT_TABLE_MIN_WIDTH = SCRIPT_COLUMNS.reduce(
  (sum, col) => sum + col.widthPx,
  0,
);

function isScriptResult(value: unknown): value is FreezoneStoryScriptResult {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as { rows?: unknown };
  return Array.isArray(candidate.rows);
}

type ScriptReferenceKind = 'text' | 'image' | 'video' | 'audio';

interface ScriptReference {
  nodeId: string;
  kind: ScriptReferenceKind;
  /** Image used for the chip / preview (image / video first frame); not needed by text nodes. */
  thumbUrl?: string | null;
  /** Content of a text node (concatenated into source_text on submit); not needed by other nodes. */
  text?: string | null;
  /** Video node: video source URL, used for the hover-preview <video>. */
  videoUrl?: string | null;
  /** Video node: total video duration (seconds), raising timestamp precision as duration_sec on submit. */
  durationSec?: number | null;
  /** Node display name (for the chip tooltip / character name). */
  displayName?: string | null;
}

function classifyUpstreamNode(node: CanvasNode): ScriptReference | null {
  if (isTextAnnotationNode(node)) {
    return {
      nodeId: node.id,
      kind: 'text',
      text: typeof node.data.content === 'string' ? node.data.content : '',
      displayName: node.data.displayName ?? null,
    };
  }
  if (isVideoNode(node)) {
    const videoUrl =
      typeof node.data.videoUrl === 'string' && node.data.videoUrl.length > 0
        ? node.data.videoUrl
        : null;
    const thumbUrl =
      (typeof node.data.previewImageUrl === 'string' && node.data.previewImageUrl) ||
      null;
    const durationSec =
      typeof node.data.durationMs === 'number' && node.data.durationMs > 0
        ? node.data.durationMs / 1000
        : null;
    return {
      nodeId: node.id,
      kind: 'video',
      thumbUrl,
      videoUrl,
      durationSec,
      displayName: node.data.displayName ?? null,
    };
  }
  if (isAudioNode(node)) {
    return {
      nodeId: node.id,
      kind: 'audio',
      displayName: node.data.displayName ?? null,
    };
  }
  if (isImageGenNode(node)) {
    const data = node.data;
    const ref =
      typeof data.referenceImageUrl === 'string' && data.referenceImageUrl.length > 0
        ? data.referenceImageUrl
        : null;
    return {
      nodeId: node.id,
      kind: 'image',
      thumbUrl: data.previewImageUrl || data.imageUrl || ref,
      displayName: data.displayName ?? null,
    };
  }
  if (isUploadNode(node) || isImageEditNode(node) || isExportImageNode(node)) {
    const data = node.data;
    return {
      nodeId: node.id,
      kind: 'image',
      thumbUrl: data.previewImageUrl || data.imageUrl || null,
      displayName: data.displayName ?? null,
    };
  }
  return null;
}

// The submission logic is extracted into a shared hook: the node body's "Retry" button and the bottom operations panel's "Generate" button share one
// submission path. Errors are uniformly written to data.generationError (rendered on the node body), no longer using the panel's local state.
function useScriptStorySubmit(
  nodeId: string,
  references: ScriptReference[],
  prompt: string,
  data: ScriptNodeData,
  onSettled?: () => void,
): { submit: () => Promise<void>; isGenerating: boolean } {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const { t } = useTranslation();
  const { isGenerating } = useNodeGenerationTaskState(data);

  const submit = useCallback(async () => {
    if (isGenerating) return;
    const project = readUrl().project;
    if (!project) {
      console.error('[script-node] submit: no project in URL');
      updateNodeData(nodeId, { generationError: t('node.scriptNode.error.missingProject') });
      return;
    }

    // The same story-script endpoint supports three kinds of input, dispatched by the upstream connection type (the backend defaults to newapi,
    // and the frontend neither passes nor shows provider/model):
    //  - text node       → source_text
    //  - video node      → video_url (+ duration_sec)
    //  - character image → character_refs[] (image_url + character name)
    // Text box content: with any asset it is the steering prompt; otherwise it is the main source_text input.
    const { sourceText, steeringPrompt, hasMedia } = resolveStoryScriptTextInput(
      references,
      prompt,
    );

    const videoRef = references.find((ref) => ref.kind === 'video' && ref.videoUrl);
    const characterRefs = references
      .filter((ref) => ref.kind === 'image' && ref.thumbUrl)
      .map((ref) => ({
        imageUrl: ref.thumbUrl as string,
        name: ref.displayName?.trim() || undefined,
      }));

    // Videos / character images are now real main inputs: the backend extracts frames from videos and sends key frames and character images together to
    // the vision model (before issue #207 they were silently dropped by Pydantic and the model could only invent from the system prompt).
    // So only when there is no asset at all is the text box content used as the source_text fallback; with assets it is always the
    // steering prompt and no longer passed off as the script body.
    if (!hasMedia && sourceText.length === 0) {
      updateNodeData(nodeId, {
        generationError: t('node.scriptNode.error.missingInput'),
      });
      return;
    }

    updateNodeData(nodeId, {
      isGenerating: true,
      generationStartedAt: Date.now(),
      generationError: null,
    });
    try {
      const ref = await submitFreezoneStoryScript(project, {
        sourceText,
        videoUrl: videoRef?.videoUrl ?? undefined,
        durationSec: videoRef?.durationSec ?? undefined,
        characterRefs: characterRefs.length > 0 ? characterRefs : undefined,
        prompt: steeringPrompt,
        canvasId: readUrl().canvas ?? 'default',
        nodeId,
      });
      // Persist the task handle so a page refresh can resume this job.
      updateNodeData(nodeId, generationTaskDescriptor(ref));
      await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
      const result = await fetchFreezoneStoryScriptResult(project, ref.job_id);
      updateNodeData(nodeId, {
        isGenerating: false,
        generationStartedAt: null,
        scriptResult: result,
        scriptTitle: result.title ?? null,
        generationError: null,
      });
    } catch (error) {
      console.error('[script-node] submit failed', error);
      updateNodeData(nodeId, {
        isGenerating: false,
        generationStartedAt: null,
        generationError: backendErrorToastMessage(error, t),
      });
    } finally {
      onSettled?.();
    }
  }, [isGenerating, nodeId, references, prompt, updateNodeData, onSettled, t]);

  return { submit, isGenerating };
}

export const ScriptNode = memo(({ id, data, selected, width, height }: ScriptNodeProps) => {
  const { t } = useTranslation();
  const updateNodeInternals = useUpdateNodeInternals();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  // Subscribe to ONLY one-hop upstream (not the whole nodes array) so unrelated
  // node drags don't re-render this node. See useUpstreamGraph.
  const upstreamNodes = useUpstreamNodes(id);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const resolvedTitle = useMemo(
    () => localizeNodeDisplayName(CANVAS_NODE_TYPES.script, data, t),
    [data, t],
  );

  const scriptResult = isScriptResult(data.scriptResult) ? data.scriptResult : null;
  const rows = scriptResult?.rows ?? [];
  const hasResult = rows.length > 0;

  // Table cell editing: write the edited value back to data.scriptResult.rows[idx][colKey].
  // The whole scriptResult is the single source of truth held by the store; the node table +
  // the fullscreen table share the same onCommit, ensuring edits in both places are persisted.
  const handleCellCommit = useCallback(
    (rowIndex: number, colKey: string, nextValue: string) => {
      if (!scriptResult) return;
      const existingRows = scriptResult.rows ?? [];
      const existing = existingRows[rowIndex];
      if (!existing) return;
      const prevRaw = existing[colKey];
      const prev = typeof prevRaw === 'string' ? prevRaw : prevRaw == null ? '' : String(prevRaw);
      if (prev === nextValue) return;
      const nextRows = existingRows.map((row, index) =>
        index === rowIndex ? { ...row, [colKey]: nextValue } : row,
      );
      updateNodeData(id, {
        scriptResult: { ...scriptResult, rows: nextRows },
      });
    },
    [id, scriptResult, updateNodeData],
  );
  // After a table appears the default size switches to 800x400; nodes the user already resized keep their width and height.
  const fallbackWidth = hasResult ? DEFAULT_WIDTH_WITH_RESULT : DEFAULT_WIDTH;
  const fallbackHeight = hasResult ? DEFAULT_HEIGHT_WITH_RESULT : DEFAULT_HEIGHT;
  const resolvedWidth = Math.max(MIN_WIDTH, Math.round(width ?? fallbackWidth));
  const resolvedHeight = Math.max(MIN_HEIGHT, Math.round(height ?? fallbackHeight));

  const headerSubtitle = scriptResult?.title?.trim() || data.scriptTitle?.trim() || '';

  // Upstream nodes → references; used to hide the "Try" entry, generate chips, and concatenate source_text on submit.
  const references = useMemo<ScriptReference[]>(() => {
    const upstream = [...upstreamNodes];
    upstream.sort((a, b) => (a.position?.y ?? 0) - (b.position?.y ?? 0));
    return upstream
      .map((node) => classifyUpstreamNode(node))
      .filter((entry): entry is ScriptReference => entry != null);
  }, [upstreamNodes]);
  const hasUpstream = references.length > 0;
  const isNodeSelected = Boolean(selected) || selectedNodeId === id;
  const promptText = typeof data.prompt === 'string' ? data.prompt : '';
  // Per-node story-script history; fetched only while the node is selected.
  // Lifted to the node body level: the body's "Retry" and the panel's "Generate" share the one submission instance below, so whichever
  // submission path settles refreshes the history (with two instances the retry path would not refresh and history would miss new records).
  const {
    records: historyRecords,
    isLoading: historyLoading,
    refresh: refreshHistory,
  } = useNodeGenerationHistory(id, { enabled: isNodeSelected });
  const { submit, isGenerating } = useScriptStorySubmit(
    id,
    references,
    promptText,
    data,
    refreshHistory,
  );

  useEffect(() => {
    updateNodeInternals(id);
  }, [id, resolvedHeight, resolvedWidth, updateNodeInternals]);

  // Esc closes fullscreen.
  useEffect(() => {
    if (!isFullscreen) return;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setIsFullscreen(false);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [isFullscreen]);

  const cardToneClass = canvasNodeFrameClass({ selected: isNodeSelected });

  // Three quick actions: create the matching upstream node to the left of the script node and connect the edge.
  // - fromScript     → 1 text node
  // - fromVideoRef   → 1 video node
  // - fromCharacter  → 2 upload nodes (stacked vertically)
  const handlePickAction = useCallback(
    (action: ScriptActionDef) => {
      const state = useCanvasStore.getState();
      const self = state.nodes.find((n) => n.id === id);
      if (!self) return;
      const selfHeight = self.height ?? resolvedHeight;
      const centerY = self.position.y + selfHeight / 2;
      const nodeSize = (
        node: CanvasNode,
        fallbackWidth: number,
        fallbackHeight: number,
      ) => ({
        width:
          node.measured?.width ??
          (typeof node.width === 'number' ? node.width : fallbackWidth),
        height:
          node.measured?.height ??
          (typeof node.height === 'number' ? node.height : fallbackHeight),
      });
      const overlaps = (
        a: { x: number; y: number; width: number; height: number },
        b: { x: number; y: number; width: number; height: number },
      ) => {
        const margin = 12;
        return (
          a.x < b.x + b.width + margin &&
          a.x + a.width + margin > b.x &&
          a.y < b.y + b.height + margin &&
          a.y + a.height + margin > b.y
        );
      };
      const occupiedRects = state.nodes
        .filter((node) => node.id !== self.id)
        .map((node) => {
          const size = nodeSize(node, SPAWN_UPLOAD_WIDTH, SPAWN_UPLOAD_HEIGHT);
          return {
            x: node.position.x,
            y: node.position.y,
            width: size.width,
            height: size.height,
          };
        });

      const spawn = (
        type: CanvasNodeType,
        spawnWidth: number,
        spawnHeight: number,
        offsetY: number,
        extra?: Record<string, unknown>,
      ) => {
        const x = self.position.x - spawnWidth - SPAWN_GAP_X;
        const y = centerY - spawnHeight / 2 + offsetY;
        const newId = state.addNode(type, { x, y }, extra ?? {});
        state.addEdge(newId, id);
        return newId;
      };

      const spawnStacked = (
        type: CanvasNodeType,
        spawnWidth: number,
        spawnHeight: number,
        seeds: ReadonlyArray<Record<string, unknown>>,
      ): string[] => {
        const newIds: string[] = [];
        if (seeds.length === 0) return newIds;
        const baseX = self.position.x - spawnWidth - SPAWN_GAP_X;
        const stepY = spawnHeight + SPAWN_GAP_Y;
        const totalH = spawnHeight * seeds.length + SPAWN_GAP_Y * (seeds.length - 1);
        const preferredStartY = self.position.y + (selfHeight - totalH) / 2;
        const upstreamIds = new Set(
          state.edges.filter((edge) => edge.target === id).map((edge) => edge.source),
        );
        const columnNodes = state.nodes.filter((node) => {
          if (!upstreamIds.has(node.id)) return false;
          if (node.type !== type) return false;
          return Math.abs(node.position.x - baseX) < 8;
        });
        const lastColumnY = columnNodes.reduce<number | null>(
          (maxY, node) => (maxY === null ? node.position.y : Math.max(maxY, node.position.y)),
          null,
        );
        let y =
          lastColumnY === null
            ? preferredStartY
            : Math.max(preferredStartY, lastColumnY + stepY);

        seeds.forEach((seed) => {
          for (let attempt = 0; attempt < 40; attempt += 1) {
            const candidate = { x: baseX, y, width: spawnWidth, height: spawnHeight };
            if (!occupiedRects.some((rect) => overlaps(candidate, rect))) {
              break;
            }
            y += stepY;
          }
          occupiedRects.push({ x: baseX, y, width: spawnWidth, height: spawnHeight });
          const newId = state.addNode(type, { x: baseX, y }, seed);
          state.addEdge(newId, id);
          newIds.push(newId);
          y += stepY;
        });
        return newIds;
      };

      if (action.key === 'fromScript') {
        // An upstream text node is used only as content input: referenceOnly turns off the mode list / model / submit.
        const newId = spawn(CANVAS_NODE_TYPES.textAnnotation, SPAWN_TEXT_WIDTH, SPAWN_TEXT_HEIGHT, 0, {
          referenceOnly: true,
          displayName: t('node.scriptNode.spawn.screenplay'),
        });
        state.autoGroupSpawn(id, [newId], {
          label: t('node.scriptNode.actionGroup', { action: t(action.labelKey) }),
        });
      } else if (action.key === 'fromVideoRef') {
        // An upstream video node is used only as an asset reference: referenceOnly turns off the bottom generation operations panel,
        // while the top toolbar (edit / upscale / analyze / smart subtitle removal / ...) stays available.
        const newId = spawn(CANVAS_NODE_TYPES.video, SPAWN_VIDEO_WIDTH, SPAWN_VIDEO_HEIGHT, 0, {
          referenceOnly: true,
        });
        state.autoGroupSpawn(id, [newId], {
          label: t('node.scriptNode.actionGroup', { action: t(action.labelKey) }),
        });
      } else if (action.key === 'fromCharacter') {
        const newIds = spawnStacked(
          CANVAS_NODE_TYPES.upload,
          SPAWN_UPLOAD_WIDTH,
          SPAWN_UPLOAD_HEIGHT,
          [
            { displayName: t('node.scriptNode.spawn.character', { index: 1 }) },
            { displayName: t('node.scriptNode.spawn.character', { index: 2 }) },
          ],
        );
        state.autoGroupSpawn(id, newIds, {
          label: t('node.scriptNode.actionGroup', { action: t(action.labelKey) }),
        });
      }

      updateNodeData(id, { lastAction: action.key });
    },
    [id, resolvedHeight, updateNodeData],
  );

  return (
    <div
      className="group relative h-full w-full overflow-visible"
      style={{ width: resolvedWidth, height: resolvedHeight }}
      onClick={() => setSelectedNode(id)}
    >
      <Handle
        type="target"
        position={Position.Left}
        id="target"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<FileText className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(nextTitle) => updateNodeData(id, { displayName: nextTitle })}
      />

      <NodeResizeHandle
        minWidth={MIN_WIDTH}
        minHeight={MIN_HEIGHT}
        maxWidth={MAX_WIDTH}
        maxHeight={MAX_HEIGHT}
      />

      <div
        className={`relative flex h-full w-full flex-col overflow-hidden rounded-[var(--node-radius)] border ${CANVAS_NODE_PANEL_SURFACE_CLASS} transition-colors ${cardToneClass}`}
      >
        {isGenerating && (
          <NodeGenerationOverlay
            startedAt={data.generationStartedAt ?? null}
            durationMs={data.generationDurationMs}
          />
        )}
        {hasResult ? (
          <>
            <ScriptResultHeader
              title={headerSubtitle}
              onFullscreen={() => setIsFullscreen(true)}
            />
            {/* Regeneration failed when a result already exists: a banner above the table with retry,
                otherwise the failure is only written to data.generationError and the UI shows no reaction at all. */}
            {data.generationError && !isGenerating && (
              <div className="flex items-center gap-2 border-b border-red-500/25 bg-red-500/10 px-3 py-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-red-300" />
                <span
                  className="min-w-0 flex-1 truncate text-[12px] leading-5 text-red-200/90"
                  title={data.generationError}
                >
                  {data.generationError}
                </span>
                <RegenerateButton label={t('node.scriptNode.retry')} onClick={() => void submit()} />
              </div>
            )}
            <div className="flex-1 overflow-hidden p-2">
              <ScriptResultTable rows={rows} onCellCommit={handleCellCommit} />
            </div>
          </>
        ) : (
          <div className="flex-1 overflow-hidden">
            <div
              className="flex h-full flex-col justify-center gap-2 py-4"
              style={{ marginInline: 32 }}
            >
              {!hasUpstream && (
                <>
                  <div className="text-xs text-[var(--canvas-node-input-helper)]">
                    {t('node.scriptNode.tryLabel')}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {SCRIPT_ACTIONS.map((action) => {
                      const Icon = action.Icon;
                      return (
                        <button
                          key={action.key}
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            handlePickAction(action);
                          }}
                          className="-mx-2 inline-flex items-center gap-3 rounded-lg px-2 py-2 text-left text-sm text-text-dark transition-colors hover:bg-white/[0.08]"
                        >
                          <Icon className="h-4 w-4 shrink-0 text-text-muted/90" />
                          <span className="truncate">{t(action.labelKey)}</span>
                        </button>
                      );
                    })}
                  </div>
                </>
              )}
              {data.generationError && !isGenerating && (
                <div className="flex flex-col items-center gap-2 text-red-300">
                  <AlertCircle className="h-6 w-6 opacity-90" />
                  <span className="max-h-[72px] overflow-y-auto break-words text-center text-[12px] leading-5 text-red-200/90">
                    {data.generationError}
                  </span>
                  <RegenerateButton
                    label={t('node.scriptNode.retry')}
                    onClick={() => void submit()}
                    busy={isGenerating}
                  />
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {isNodeSelected && (hasUpstream || promptHasContent(data)) && (
        <ScriptOperationsPanel
          nodeId={id}
          data={data}
          references={references}
          onSubmit={submit}
          isGenerating={isGenerating}
          historyRecords={historyRecords}
          historyLoading={historyLoading}
          refreshHistory={refreshHistory}
        />
      )}

      {hasResult && isFullscreen && typeof document !== 'undefined' &&
        createPortal(
          <div
            className="fixed inset-0 z-[220] flex flex-col bg-black/85 p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-between text-text-dark">
              <div className="flex items-center gap-3">
                <FileText className="h-5 w-5" />
                <span className="text-base font-medium">{resolvedTitle}</span>
                {headerSubtitle && (
                  <span className="text-sm text-text-muted">{headerSubtitle}</span>
                )}
                <span className="text-sm text-text-muted">
                  {t('node.scriptNode.shotCount', { count: rows.length })}
                </span>
              </div>
              <button
                type="button"
                className="inline-flex h-8 items-center gap-1 rounded border border-[rgba(255,255,255,0.2)] bg-bg-dark/60 px-3 text-sm text-text-dark hover:border-[rgba(255,255,255,0.36)]"
                onClick={() => setIsFullscreen(false)}
              >
                <X className="h-4 w-4" />
                {t('node.scriptNode.close')}
              </button>
            </div>
            <div className="flex-1 overflow-hidden rounded-lg border border-[rgba(255,255,255,0.12)] bg-surface-dark/95">
              <ScriptResultTable rows={rows} onCellCommit={handleCellCommit} />
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
});

ScriptNode.displayName = 'ScriptNode';

function promptHasContent(data: ScriptNodeData): boolean {
  return typeof data.prompt === 'string' && data.prompt.trim().length > 0;
}

interface ScriptResultHeaderProps {
  title: string;
  onFullscreen: () => void;
}

function ScriptResultHeader({ title, onFullscreen }: ScriptResultHeaderProps) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-between border-b border-[rgba(255,255,255,0.08)] px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[13px] font-medium text-text-dark">
          {title || t('node.scriptNode.defaultTitle')}
        </span>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {/* The "script view" has only one view for now, so a placeholder dropdown is put in, to be hooked up to other views later (card view etc.). */}
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded border border-[rgba(255,255,255,0.18)] bg-bg-dark/60 px-2 text-[11px] text-text-dark hover:border-[rgba(255,255,255,0.32)]"
          onClick={(event) => event.stopPropagation()}
        >
          {t('node.scriptNode.scriptView')}
          <ChevronDown className="h-3 w-3" />
        </button>
        <button
          type="button"
          className="inline-flex h-6 items-center gap-1 rounded border border-[rgba(255,255,255,0.18)] bg-bg-dark/60 px-2 text-[11px] text-text-dark hover:border-[rgba(255,255,255,0.32)]"
          onClick={(event) => {
            event.stopPropagation();
            onFullscreen();
          }}
        >
          <Expand className="h-3 w-3" />
          {t('node.scriptNode.fullscreen')}
        </button>
      </div>
    </div>
  );
}

interface ScriptResultTableProps {
  rows: FreezoneStoryScriptRow[];
  onCellCommit?: (rowIndex: number, colKey: string, nextValue: string) => void;
}

// Short numeric columns such as shot number / duration are centered with tabular figures, easier to scan.
const NUMERIC_COLUMN_KEYS = new Set(['shot_no', 'duration']);
// When a single cell has too much content a scrollbar appears inside the cell, avoiding stretching the whole row very tall.
const CELL_MAX_HEIGHT_PX = 196;

function ScriptResultTable({ rows, onCellCommit }: ScriptResultTableProps) {
  const { t } = useTranslation();
  return (
    <div className="ui-scrollbar h-full w-full overflow-auto rounded-lg border border-[rgba(255,255,255,0.08)] bg-bg-dark/30">
      <table
        className="border-collapse text-left text-[12px] text-text-dark"
        style={{ minWidth: SCRIPT_TABLE_MIN_WIDTH, tableLayout: 'fixed' }}
      >
        <thead className="sticky top-0 z-10">
          <tr>
            {SCRIPT_COLUMNS.map((col) => (
              <th
                key={col.key}
                style={{ width: col.widthPx, minWidth: col.widthPx }}
                className={`border-b border-r border-b-[rgba(255,255,255,0.14)] border-r-[rgba(255,255,255,0.06)] bg-bg-dark/95 px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-text-muted/90 backdrop-blur last:border-r-0 ${
                  NUMERIC_COLUMN_KEYS.has(col.key) ? 'text-center' : ''
                }`}
              >
                {t(col.labelKey)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, idx) => (
            <tr
              key={idx}
              className={`align-top transition-colors hover:bg-[rgb(var(--accent-rgb)/0.06)] ${
                idx % 2 === 1 ? 'bg-white/[0.02]' : ''
              }`}
            >
              {SCRIPT_COLUMNS.map((col) => {
                const numeric = NUMERIC_COLUMN_KEYS.has(col.key);
                return (
                  <td
                    key={col.key}
                    style={{ width: col.widthPx, minWidth: col.widthPx }}
                    className={`border-b border-r border-[rgba(255,255,255,0.05)] px-3 py-2 align-top last:border-r-0 ${
                      numeric ? 'text-center tabular-nums text-text-dark/90' : ''
                    }`}
                  >
                    <div
                      className="ui-scrollbar nowheel overflow-y-auto overflow-x-hidden"
                      style={{ maxHeight: CELL_MAX_HEIGHT_PX }}
                    >
                      <ScriptResultCell
                        row={row}
                        col={col}
                        onCommit={
                          onCellCommit
                            ? (next) => onCellCommit(idx, col.key, next)
                            : undefined
                        }
                      />
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface ScriptResultCellProps {
  row: FreezoneStoryScriptRow;
  col: ScriptColumnDef;
  onCommit?: (nextValue: string) => void;
}

function ScriptResultCell({ row, col, onCommit }: ScriptResultCellProps) {
  const raw = row[col.key];

  if (col.render === 'image') {
    // Character image / reference are backfilled by the backend, but the model occasionally still writes non-URL text such as `none`,
    // so <img> renders only for a real image source, otherwise fall back to the "click to upload" placeholder (avoiding a 404 broken image).
    const url = typeof raw === 'string' && isRenderableImageSrc(raw) ? raw : null;
    return <ScriptImageCell url={url} onCommit={onCommit} />;
  }

  const initialText =
    raw == null
      ? ''
      : typeof raw === 'string' || typeof raw === 'number'
        ? String(raw)
        : JSON.stringify(raw);

  if (!onCommit) {
    // Without onCommit it is treated as read-only, keeping the old rendering.
    if (initialText.length === 0) {
      return <span className="text-text-muted/50">-</span>;
    }
    return (
      <span className="block whitespace-pre-wrap break-words leading-snug">{initialText}</span>
    );
  }

  return <EditableTableCell value={initialText} onCommit={onCommit} />;
}

interface ScriptImageCellProps {
  url: string | null;
  /** Editable only when passed: upload/replace/delete all write back to scriptResult.rows[i][key] through it. */
  onCommit?: (nextValue: string) => void;
}

/**
 * The image cell in the table: an empty slot is clickable to upload, an existing image can be previewed / replaced / deleted.
 * In generated results the character and reference images often need a manual fill-in (issue #207: this used to be purely read-only).
 */
function ScriptImageCell({ url, onCommit }: ScriptImageCellProps) {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const editable = Boolean(onCommit);

  const handleFileChange = useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      // Clear immediately, so choosing the same file again in a row still triggers change.
      event.target.value = '';
      if (!file || !onCommit) return;
      const project = readUrl().project;
      if (!project) {
        setUploadError(t('node.scriptNode.error.missingProject'));
        return;
      }
      setUploading(true);
      setUploadError(null);
      try {
        const result = await uploadFreezoneImage(project, file, file.name);
        onCommit(result.url);
      } catch (error) {
        console.error('[script-node] cell image upload failed', error);
        setUploadError(error instanceof Error ? error.message : t('node.scriptNode.uploadFailed'));
      } finally {
        setUploading(false);
      }
    },
    [onCommit],
  );

  const openPicker = useCallback(() => {
    if (uploading) return;
    inputRef.current?.click();
  }, [uploading]);

  const fileInput = editable ? (
    <input
      ref={inputRef}
      type="file"
      accept="image/*"
      className="hidden"
      onChange={handleFileChange}
    />
  ) : null;

  if (!url) {
    if (!editable) {
      return (
        <div className="flex h-14 w-14 items-center justify-center rounded border border-dashed border-[rgba(255,255,255,0.14)] text-text-muted/50">
          <ImageIcon className="h-4 w-4" />
        </div>
      );
    }
    return (
      <div className="flex flex-col gap-1">
        <button
          type="button"
          onClick={openPicker}
          disabled={uploading}
          title={t('node.scriptNode.uploadImage')}
          className="flex h-14 w-14 items-center justify-center rounded border border-dashed border-[rgba(255,255,255,0.14)] text-text-muted/50 transition-colors hover:border-[rgb(var(--accent-rgb)/0.6)] hover:text-text-dark/80 disabled:cursor-wait"
        >
          {uploading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <ImageIcon className="h-4 w-4" />
          )}
        </button>
        {uploadError ? (
          <span className="text-[10px] leading-tight text-red-400">{uploadError}</span>
        ) : null}
        {fileInput}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="group relative h-14 w-14">
        <img
          src={resolveImageDisplayUrl(url)}
          alt=""
          className="h-14 w-14 cursor-zoom-in rounded border border-[rgba(255,255,255,0.08)] object-cover"
          draggable={false}
          onClick={() => setPreviewOpen(true)}
        />
        {editable ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1 rounded bg-black/60 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
            <button
              type="button"
              onClick={openPicker}
              disabled={uploading}
              title={t('node.scriptNode.replaceImage')}
              className="rounded p-1 text-white/85 transition-colors hover:bg-white/15 hover:text-white disabled:cursor-wait"
            >
              {uploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => onCommit?.('')}
              title={t('node.scriptNode.removeImage')}
              className="rounded p-1 text-white/85 transition-colors hover:bg-white/15 hover:text-white"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ) : null}
      </div>
      {uploadError ? (
        <span className="text-[10px] leading-tight text-red-400">{uploadError}</span>
      ) : null}
      {fileInput}
      {previewOpen
        ? createPortal(
            <div
              className="fixed inset-0 z-[120] flex items-center justify-center bg-black/80 p-8"
              onClick={() => setPreviewOpen(false)}
            >
              <img
                src={resolveImageDisplayUrl(url)}
                alt=""
                className="max-h-full max-w-full rounded object-contain"
                draggable={false}
                onClick={(event) => event.stopPropagation()}
              />
              <button
                type="button"
                onClick={() => setPreviewOpen(false)}
                title={t('node.scriptNode.closePreview')}
                className="absolute right-6 top-6 rounded p-2 text-white/80 transition-colors hover:bg-white/15 hover:text-white"
              >
                <X className="h-5 w-5" />
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

interface ScriptOperationsPanelProps {
  nodeId: string;
  data: ScriptNodeData;
  references: ScriptReference[];
  /** The submission instance + history shared with the node body's "Retry" (see the hook call in ScriptNode). */
  onSubmit: () => Promise<void>;
  isGenerating: boolean;
  historyRecords: FreezoneGenerationHistoryRecord[];
  historyLoading: boolean;
  refreshHistory: () => Promise<void>;
}

function ScriptOperationsPanel({
  nodeId,
  data,
  references,
  onSubmit,
  isGenerating,
  historyRecords,
  historyLoading,
  refreshHistory,
}: ScriptOperationsPanelProps) {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const { t } = useTranslation();
  const [isTranslating, setIsTranslating] = useState(false);
  // The collapsed state is a floating panel below the node; clicking "enlarge" at the top right switches to a centered dialog showing the same content.
  const [panelExpanded, setPanelExpanded] = useState(false);
  const prompt = typeof data.prompt === 'string' ? data.prompt : '';
  const storyInput = resolveStoryScriptTextInput(references, prompt);
  const storyBillableChars = countBillableTextChars(
    `${storyInput.sourceText}\n${storyInput.steeringPrompt ?? ''}`,
  );
  const translateBillableChars = countBillableTextChars(prompt);
  const scriptCost = useGenerationCreditCost(
    'feature',
    STORY_SCRIPT_FEATURE_KEY,
    { surface: 'canvas', quantity: storyBillableChars },
  );
  const translateCost = useGenerationCreditCost(
    'feature',
    translateBillableChars > 0 ? TEXT_TRANSLATE_FEATURE_KEY : null,
    { surface: 'canvas', quantity: translateBillableChars },
  );

  const handleRestoreHistory = useCallback(
    (record: FreezoneGenerationHistoryRecord) => {
      // Only story-script records carry a usable `{ title, rows }` payload.
      if (!isScriptResult(record.result)) return;
      updateNodeData(nodeId, {
        scriptResult: record.result,
        scriptTitle: record.result.title ?? null,
        isGenerating: false,
        generationStartedAt: null,
      });
    },
    [nodeId, updateNodeData],
  );

  const handleTranslate = useCallback(async () => {
    if (isGenerating || isTranslating) return;
    if (prompt.trim().length === 0) return;
    const project = readUrl().project;
    if (!project) {
      console.error('[script-node] translate: no project in URL');
      return;
    }
    setIsTranslating(true);
    try {
      const ref = await submitFreezoneTextTranslate(project, {
        text: prompt,
        nodeType: 'text',
        canvasId: readUrl().canvas ?? 'default',
        nodeId,
      });
      await awaitTaskCompletion(ref.task_key, project, { taskType: ref.task_type });
      const result = await fetchFreezoneTextTranslateResult(project, ref.job_id);
      updateNodeData(nodeId, { prompt: result.translated_text });
    } catch (error) {
      console.error('[script-node] translate failed', error);
      toast.error(backendErrorToastMessage(error, t));
    } finally {
      setIsTranslating(false);
    }
  }, [isGenerating, isTranslating, nodeId, prompt, updateNodeData, t]);

  // Submit is allowed once any of text / video / character image has content (consistent with the dispatch in useScriptStorySubmit).
  const hasContent =
    prompt.trim().length > 0 ||
    references.some(
      (ref) =>
        (ref.kind === 'text' && (ref.text ?? '').trim().length > 0) ||
        (ref.kind === 'video' && Boolean(ref.videoUrl)) ||
        (ref.kind === 'image' && Boolean(ref.thumbUrl)),
    );
  const modelTaskAccess = useModelTaskAccess();
  const submitDisabled = isGenerating || !hasContent || modelTaskAccess.blocked;

  return (
    <OperationPanelShell
      expanded={panelExpanded}
      onCollapse={() => setPanelExpanded(false)}
      inlineClassName={`nodrag absolute z-10 flex flex-col rounded-[var(--node-radius)] border ${CANVAS_NODE_INPUT_SURFACE_CLASS} ${CANVAS_NODE_INPUT_FRAME_CLASS}`}
      inlineStyle={{
        top: `calc(100% + ${PANEL_GAP_PX}px)`,
        left: -PANEL_OVERHANG_PX,
        right: -PANEL_OVERHANG_PX,
      }}
      modalStyle={{
        width: `min(${OPS_PANEL_EXPANDED_WIDTH}px, 92vw)`,
        height: `min(${OPS_PANEL_EXPANDED_HEIGHT}px, 86vh)`,
      }}
    >
      <PanelExpandButton
        expanded={panelExpanded}
        onToggle={() => setPanelExpanded((v) => !v)}
        className="absolute right-2 top-2 z-20"
      />
      {references.length > 0 && (
        <div className="px-3 pr-10 pt-3">
          <ScriptReferencesRow references={references} />
        </div>
      )}

      <div className={`px-3 pt-3 ${panelExpanded ? 'flex-1 overflow-hidden' : ''}`}>
        <textarea
          value={prompt}
          onChange={(event) => updateNodeData(nodeId, { prompt: event.target.value })}
          placeholder={t('node.scriptNode.promptPlaceholder')}
          rows={3}
          className={`nodrag nowheel ui-scrollbar w-full resize-none bg-transparent text-[14px] leading-[1.6] text-text-dark outline-none ${CANVAS_NODE_INPUT_PLACEHOLDER_CLASS} ${panelExpanded ? 'h-full' : 'min-h-[72px]'}`}
          disabled={isGenerating}
        />
      </div>

      {data.generationError && !isGenerating && (
        <div className="px-3 pb-1 text-[11px] text-red-400 break-words [overflow-wrap:anywhere]">{data.generationError}</div>
      )}

      <div className="flex shrink-0 items-center justify-end gap-2 px-3 pb-3 pt-1">
        <div className="flex shrink-0 items-center gap-2">
          <IconButton
            title={t('node.scriptNode.translate')}
            onClick={handleTranslate}
            disabled={isGenerating || isTranslating || prompt.trim().length === 0}
            active={isTranslating}
          >
            {isTranslating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Languages className="h-4 w-4" />
            )}
          </IconButton>
          <CreditCostPill
            display={
              translateCost.data?.data.cost === 0
                ? null
                : translateCost.data?.data.display
            }
            promotion={translateCost.data?.data.promotion}
            disabled={isGenerating || isTranslating || prompt.trim().length === 0}
            className={NODE_CREDIT_PILL_FLAT_CLASS}
          />
          <CreditCostPill
            display={
              scriptCost.data?.data.display ??
              (scriptCost.error instanceof BillingRuleNotConfiguredError
                ? t('common.billingRuleNotConfiguredShort')
                : null)
            }
            promotion={scriptCost.data?.data.promotion}
            disabled={submitDisabled}
            className={NODE_CREDIT_PILL_FLAT_CLASS}
          />
          <button
            type="button"
            disabled={submitDisabled}
            title={modelTaskAccess.message ?? t('node.scriptNode.generate')}
            onClick={() => void onSubmit()}
            className={`${NODE_GENERATE_BUTTON_BASE_CLASS} ${
              submitDisabled
                ? NODE_GENERATE_BUTTON_DISABLED_CLASS
                : NODE_GENERATE_BUTTON_ENABLED_CLASS
            }`}
          >
            {isGenerating ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowUp className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>

      {hasCompletedHistoryRecords(historyRecords) && (
        <div className="border-t border-white/[0.04] px-3 py-2">
          <NodeGenerationHistory
            records={historyRecords}
            isLoading={historyLoading}
            onRestore={handleRestoreHistory}
            onRefresh={() => void refreshHistory()}
            isActive={(record) => {
              if (!isScriptResult(record.result) || !isScriptResult(data.scriptResult)) {
                return false;
              }
              return JSON.stringify(record.result) === JSON.stringify(data.scriptResult);
            }}
          />
        </div>
      )}
    </OperationPanelShell>
  );
}

function countBillableTextChars(text: string): number {
  return text.replace(/[\s\u3000]+/gu, '').length;
}

function resolveStoryScriptTextInput(
  references: ScriptReference[],
  prompt: string,
): { sourceText: string; steeringPrompt?: string; hasMedia: boolean } {
  const upstreamText = references
    .filter((ref) => ref.kind === 'text')
    .map((ref) => (ref.text ?? '').trim())
    .filter((text) => text.length > 0)
    .join('\n\n');
  const trimmedPrompt = prompt.trim();
  const hasMedia = references.some(
    (ref) =>
      (ref.kind === 'video' && Boolean(ref.videoUrl)) ||
      (ref.kind === 'image' && Boolean(ref.thumbUrl)),
  );
  return {
    sourceText: upstreamText.length > 0 ? upstreamText : hasMedia ? '' : trimmedPrompt,
    steeringPrompt:
      upstreamText.length > 0 || hasMedia ? trimmedPrompt || undefined : undefined,
    hasMedia,
  };
}

interface ScriptReferencesRowProps {
  references: ScriptReference[];
}

function ScriptReferencesRow({ references }: ScriptReferencesRowProps) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {references.map((ref, index) => (
        <ScriptReferenceChip key={ref.nodeId} reference={ref} index={index} />
      ))}
    </div>
  );
}

interface ScriptReferenceChipProps {
  reference: ScriptReference;
  index: number;
}

function ScriptReferenceChip({ reference, index }: ScriptReferenceChipProps) {
  const { t } = useTranslation();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [previewPos, setPreviewPos] = useState<{ left: number; top: number } | null>(null);
  const PREVIEW_W = 240;
  const PREVIEW_OFFSET = 10;

  // Only image / video have a visual preview; text / audio chips do not pop up a large image.
  const hasPreview =
    (reference.kind === 'image' && Boolean(reference.thumbUrl)) ||
    (reference.kind === 'video' && Boolean(reference.videoUrl || reference.thumbUrl));

  const showPreview = useCallback(() => {
    if (!hasPreview) return;
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(
      8,
      Math.min(window.innerWidth - PREVIEW_W - 8, rect.left + rect.width / 2 - PREVIEW_W / 2),
    );
    const top = rect.top - PREVIEW_OFFSET;
    setPreviewPos({ left, top });
  }, [hasPreview]);

  const hidePreview = useCallback(() => {
    setPreviewPos(null);
  }, []);

  const titleText = reference.displayName?.trim()
    ? reference.displayName.trim()
    : t('node.scriptNode.referenceFallback', { index: index + 1 });

  // Chip visuals: image uses a thumbnail, video uses the first frame (fallback video element), text uses a T mark, audio uses A.
  const chipBody = (() => {
    if (reference.kind === 'image' && reference.thumbUrl) {
      return (
        <img
          src={resolveImageDisplayUrl(reference.thumbUrl)}
          alt={titleText}
          className="h-full w-full object-cover"
        />
      );
    }
    if (reference.kind === 'video') {
      if (reference.thumbUrl) {
        return (
          <img
            src={resolveImageDisplayUrl(reference.thumbUrl)}
            alt={titleText}
            className="h-full w-full object-cover"
          />
        );
      }
      if (reference.videoUrl) {
        return (
          <video
            src={resolveImageDisplayUrl(reference.videoUrl)}
            muted
            playsInline
            preload="metadata"
            className="h-full w-full object-cover"
          />
        );
      }
      return <Video className="h-4 w-4 text-text-muted" />;
    }
    if (reference.kind === 'text') {
      return <span className="text-[11px] font-semibold text-text-muted">T</span>;
    }
    return <span className="text-[11px] text-text-muted">A</span>;
  })();

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        onMouseEnter={showPreview}
        onMouseLeave={hidePreview}
        className="nodrag relative flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-[7px] border border-white/10 bg-white/[0.04] transition-colors hover:border-white/30"
        title={titleText}
      >
        {chipBody}
        <span className="absolute right-1 top-1 flex h-3 min-w-3 items-center justify-center rounded-full bg-black/30 px-0.5 text-[9px] font-medium leading-none text-white/90 backdrop-blur-sm">
          {index + 1}
        </span>
      </button>
      {previewPos &&
        hasPreview &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            className="pointer-events-none fixed z-[400] -translate-y-full"
            style={{ left: previewPos.left, top: previewPos.top, width: PREVIEW_W }}
          >
            <div className="overflow-hidden rounded-xl border border-white/15 bg-surface-dark/95 shadow-2xl backdrop-blur-sm">
              {reference.kind === 'video' && reference.videoUrl ? (
                <video
                  src={resolveImageDisplayUrl(reference.videoUrl)}
                  autoPlay
                  loop
                  muted
                  playsInline
                  className="block h-auto w-full object-contain"
                />
              ) : reference.thumbUrl ? (
                <img
                  src={resolveImageDisplayUrl(reference.thumbUrl)}
                  alt={titleText}
                  className="block h-auto w-full object-contain"
                  draggable={false}
                />
              ) : null}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

interface IconButtonProps {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  children: React.ReactNode;
}

function IconButton({ title, onClick, disabled, active, children }: IconButtonProps) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className={`${NODE_INLINE_ICON_BUTTON_CLASS} ${
        active ? NODE_INLINE_ICON_BUTTON_ACTIVE_CLASS : ''
      }`}
    >
      {children}
    </button>
  );
}

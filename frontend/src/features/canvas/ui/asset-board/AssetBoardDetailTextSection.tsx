// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, type ReactElement } from 'react';

import {
  isScriptNode,
  isVideoStoryNode,
  type CanvasNode,
  type CanvasNodeData,
  type ScriptNodeData,
  type VideoStoryRow,
} from '@/features/canvas/domain/canvasNodes';
import { useCanvasStore } from '@/stores/canvasStore';

import {
  AssetBoardDetailTextBody,
  scriptRowsOf,
  type TextBodyCellCommit,
} from './AssetBoardDetailTextBody';
/**
 * Text detail body dispatch (a pure read-only reading page - at the user's request, text-type details carry no function buttons;
 * generation/derivation/analysis are all done back on the nodes on the workflow side):
 * - script -> read-only script table + row-table cell editing (no edits while generating);
 * - videoStory -> read-only storyboard table + row-table cell editing (no edits while analyzing);
 * - other text-type nodes (textAnnotation / beatContext) land directly in the read-only body.
 */
export function AssetBoardDetailTextSection({
  node,
  title,
}: {
  node: CanvasNode;
  title: string;
}): ReactElement {
  if (isScriptNode(node)) {
    return <ScriptDetail node={node} title={title} />;
  }
  if (isVideoStoryNode(node)) {
    return <VideoStoryDetail node={node} title={title} />;
  }
  return <AssetBoardDetailTextBody node={node} title={title} />;
}

function ScriptDetail({ node, title }: { node: CanvasNode; title: string }): ReactElement {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const data = node.data as ScriptNodeData;
  // The generation/history entries were removed from the storyboard text detail (a read-only reading page; generation still happens on the workflow ScriptNode),
  // so useScriptStorySubmit / useNodeGenerationHistory and the upstream references derivation are no longer mounted.
  // All that is needed here is "whether it is generating" to disable inline editing - just read the node data directly.
  const isGenerating = data.isGenerating === true;

  // Row-table cell write-back: the result as a whole is unknown (the backend { title, rows[] }), only the rows item is replaced,
  // and the other fields (title etc.) are carried over as is. No edits while generating - the backfill would overwrite the edit.
  const handleCellCommit = useCallback<TextBodyCellCommit>(
    (rowIndex, colKey, nextValue) => {
      const result = data.scriptResult;
      const rows = scriptRowsOf(result);
      const existing = rows[rowIndex];
      if (!existing) return;
      const prevRaw = existing[colKey];
      const prev = typeof prevRaw === 'string' ? prevRaw : prevRaw == null ? '' : String(prevRaw);
      if (prev === nextValue) return;
      const nextRows = rows.map((row, index) =>
        index === rowIndex ? { ...row, [colKey]: nextValue } : row,
      );
      updateNodeData(node.id, {
        scriptResult: { ...(result as Record<string, unknown>), rows: nextRows },
      } as Partial<CanvasNodeData>);
    },
    [data.scriptResult, node.id, updateNodeData],
  );

  const generationError =
    typeof data.generationError === 'string' && data.generationError.trim().length > 0
      ? data.generationError
      : null;

  return (
    // Read-only reading page: no function buttons such as "Generate storyboard script / History" (user request; generation still happens on the workflow side
    // ScriptNode); here only the script table is shown and inline cell editing is allowed.
    <div className="flex w-full flex-col gap-3">
      {generationError && (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-200">
          {generationError}
        </p>
      )}
      <AssetBoardDetailTextBody
        node={node}
        title={title}
        onCellCommit={isGenerating ? undefined : handleCellCommit}
      />
    </div>
  );
}

function VideoStoryDetail({ node, title }: { node: CanvasNode; title: string }): ReactElement {
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const data = node.data as Record<string, unknown>;
  // While analyzing: the result backfill would overwrite inline edits, so no edits during this time (the onCellCommit guard below).
  const isAnalyzing = data.isAnalyzing === true;
  const analysisError =
    typeof data.analysisError === 'string' && data.analysisError.trim().length > 0
      ? data.analysisError
      : null;

  // Row-table cell write-back: the same form as VideoStoryNode.handleCellCommit (do not write for the same value,
  // shallow-copy the whole row and replace that column).
  const handleCellCommit = useCallback<TextBodyCellCommit>(
    (rowIndex, colKey, nextValue) => {
      const rows = (Array.isArray(data.rows) ? data.rows : []) as VideoStoryRow[];
      const existing = rows[rowIndex];
      if (!existing) return;
      const prevRaw = existing[colKey as keyof VideoStoryRow];
      const prev = typeof prevRaw === 'string' ? prevRaw : prevRaw == null ? '' : String(prevRaw);
      if (prev === nextValue) return;
      const nextRows = rows.map((row, index) =>
        index === rowIndex ? { ...row, [colKey]: nextValue } : row,
      );
      updateNodeData(node.id, { rows: nextRows } as Partial<CanvasNodeData>);
    },
    [data.rows, node.id, updateNodeData],
  );

  return (
    // Read-only reading page: text-type details never carry function buttons (user request), and generation/analysis is still done on the workflow side.
    <div className="flex w-full flex-col gap-3">
      {analysisError && (
        <p className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-1.5 text-[12px] text-red-200">
          {analysisError}
        </p>
      )}
      <AssetBoardDetailTextBody
        node={node}
        title={title}
        // No edits while analyzing - the result backfill would overwrite the edit.
        onCellCommit={isAnalyzing ? undefined : handleCellCommit}
      />
    </div>
  );
}

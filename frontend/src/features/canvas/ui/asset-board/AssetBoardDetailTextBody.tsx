// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { useState, type ReactElement } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkBreaks from 'remark-breaks';
import remarkGfm from 'remark-gfm';

import {
  isBeatContextNode,
  isScriptNode,
  isTextAnnotationNode,
  isVideoStoryNode,
  type CanvasNode,
  type VideoStoryRow,
} from '@/features/canvas/domain/canvasNodes';

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * Table cell write-back (the same form as VideoStoryNode.handleCellCommit): row index + column field name +
 * new value, with the host deciding whether to write back to data.rows or data.scriptResult.rows.
 */
export type TextBodyCellCommit = (
  rowIndex: number,
  colKey: string,
  nextValue: string,
) => void;

/** Markdown reading page of the text detail (aligned with TextAnnotationNode's ReactMarkdown config). */
function MarkdownBody({ content }: { content: string }): ReactElement {
  return (
    <div className="text-sm leading-6 text-white/80">
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkBreaks]}
        components={{
          h1: ({ ...props }) => <h1 className="mb-2 mt-4 text-lg font-semibold text-foreground" {...props} />,
          h2: ({ ...props }) => <h2 className="mb-2 mt-4 text-base font-semibold text-foreground" {...props} />,
          h3: ({ ...props }) => <h3 className="mb-1 mt-3 text-sm font-semibold text-foreground" {...props} />,
          p: ({ ...props }) => <p className="my-1.5" {...props} />,
          strong: ({ ...props }) => <strong className="font-semibold text-foreground" {...props} />,
          em: ({ ...props }) => <em className="italic" {...props} />,
          ul: ({ ...props }) => <ul className="my-1.5 ml-5 list-disc" {...props} />,
          ol: ({ ...props }) => <ol className="my-1.5 ml-5 list-decimal" {...props} />,
          li: ({ ...props }) => <li className="my-0.5" {...props} />,
          code: ({ ...props }) => <code className="rounded bg-white/10 px-1 py-0.5 text-xs" {...props} />,
          hr: () => <hr className="my-3 border-white/10" />,
          table: ({ ...props }) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[13px]" {...props} />
            </div>
          ),
          th: ({ ...props }) => (
            <th className="border-b border-white/10 px-2 py-1.5 text-left font-medium text-white/60" {...props} />
          ),
          td: ({ ...props }) => <td className="border-b border-white/5 px-2 py-1.5 align-top" {...props} />,
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}

/** One cell: display value + the row/column coordinates of that cell (editable only with coordinates). */
interface RowCell {
  value: string;
  /** The column field name used for write-back; null -> that column is read-only (e.g. shot numbers, a display value fallback from array order). */
  colKey: string | null;
}

function cell(value: string, colKey: string | null = null): RowCell {
  return { value, colKey };
}

interface RowTableProps {
  headers: string[];
  rows: RowCell[][];
  /** Editable only when passed: click a cell to enter editing, blur writes back, Esc abandons. */
  onCellCommit?: TextBodyCellCommit;
}

/** A simple row table for storyboard/script: narrow columns such as shot number + a wide content column. */
function RowTable({ headers, rows, onCellCommit }: RowTableProps): ReactElement {
  // Only one cell is being edited at a time (coordinates + draft), with the same semantics as VideoStoryNode's table editing.
  const [editing, setEditing] = useState<{ row: number; col: number } | null>(null);
  const [draft, setDraft] = useState('');

  const commit = (rowIndex: number, colKey: string) => {
    onCellCommit?.(rowIndex, colKey, draft);
    setEditing(null);
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[13px] text-white/80">
        <thead>
          <tr>
            {headers.map((header) => (
              <th
                key={header}
                className="whitespace-nowrap border-b border-white/10 px-2 py-2 text-left font-medium text-white/50"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((cells, rowIndex) => (
            <tr key={rowIndex}>
              {cells.map((item, cellIndex) => {
                const editable = Boolean(onCellCommit) && item.colKey !== null;
                const isEditing =
                  editing !== null && editing.row === rowIndex && editing.col === cellIndex;
                if (isEditing && item.colKey) {
                  const colKey = item.colKey;
                  return (
                    <td key={cellIndex} className="border-b border-white/5 px-1 py-1 align-top">
                      <textarea
                        value={draft}
                        autoFocus
                        rows={Math.min(6, Math.max(1, draft.split('\n').length))}
                        onChange={(event) => setDraft(event.target.value)}
                        onBlur={() => commit(rowIndex, colKey)}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') {
                            event.preventDefault();
                            setEditing(null);
                          }
                        }}
                        className="w-full min-w-[80px] resize-y rounded border border-white/25 bg-white/[0.06] px-1.5 py-1 text-[13px] leading-5 text-white/90 outline-none"
                      />
                    </td>
                  );
                }
                return (
                  <td
                    key={cellIndex}
                    // Read-only columns keep the original style; editable columns get a clickable hint (hover highlight + text cursor).
                    className={`border-b border-white/5 px-2 py-2 align-top leading-5 ${
                      editable ? 'cursor-text rounded transition-colors hover:bg-white/[0.06]' : ''
                    }`}
                    title={editable ? i18n.t('canvas.assetBoard.textBody.clickToEdit') : undefined}
                    onClick={
                      editable
                        ? () => {
                            // The '-' in a display value is the placeholder for "empty" and should not be taken as body text when entering editing.
                            setDraft(item.value === '-' ? '' : item.value);
                            setEditing({ row: rowIndex, col: cellIndex });
                          }
                        : undefined
                    }
                  >
                    {item.value}
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

/** scriptNode.scriptResult is unknown (the backend { title, rows[] }) - softly take the row records. */
export function scriptRowsOf(result: unknown): Array<Record<string, unknown>> {
  if (!result || typeof result !== 'object') return [];
  const rows = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows)) return [];
  return rows.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object');
}

/**
 * Which field the "content summary" column is currently showing - editing must write back to **the one being shown**, otherwise what the user edits
 * is narrative but the value lands in an empty visualDescription, apparently not taking effect.
 */
export function videoStorySummaryField(row: VideoStoryRow): 'visualDescription' | 'narrative' {
  return str(row.visualDescription) !== null || str(row.narrative) === null
    ? 'visualDescription'
    : 'narrative';
}

function videoStorySummary(row: VideoStoryRow): string {
  return str(row.visualDescription) ?? str(row.narrative) ?? '-';
}

interface AssetBoardDetailTextBodyProps {
  node: CanvasNode;
  /** The storyboard entry title (the large title at the top of the detail reading page, matching the liblib text detail). */
  title: string;
  /**
   * Cell write-back of script / videoStory row tables. Editable only when passed; the host is responsible for landing
   * (rowIndex, colKey, value) back in the matching store field.
   */
  onCellCommit?: TextBodyCellCommit;
}

/**
 * Text column detail body: textAnnotation / beatContext render Markdown;
 * scriptNode renders scriptTitle + row table; videoStoryNode renders the shot row table.
 */
export function AssetBoardDetailTextBody({
  node,
  title,
  onCellCommit,
}: AssetBoardDetailTextBodyProps): ReactElement {
  let body: ReactElement;
  if (isTextAnnotationNode(node) || isBeatContextNode(node)) {
    const content = str(node.data.content);
    body = content ? (
      <MarkdownBody content={content} />
    ) : (
      <p className="py-8 text-center text-[13px] text-muted-foreground">{i18n.t('canvas.assetBoard.textBody.noText')}</p>
    );
  } else if (isScriptNode(node)) {
    const rows = scriptRowsOf(node.data.scriptResult);
    const scriptTitle = str(node.data.scriptTitle);
    body = (
      <div className="flex flex-col gap-3">
        {scriptTitle && <h2 className="text-base font-semibold text-foreground">{scriptTitle}</h2>}
        {rows.length > 0 ? (
          <RowTable
            headers={[i18n.t('canvas.assetBoard.textBody.colShotNo'), i18n.t('canvas.assetBoard.textBody.colDuration'), i18n.t('canvas.assetBoard.textBody.colVisual'), i18n.t('canvas.assetBoard.textBody.colDialogue')]}
            onCellCommit={onCellCommit}
            rows={rows.map((row, index) => [
              cell(str(row.shot_no) ?? String(index + 1), 'shot_no'),
              cell(str(row.duration) ?? '-', 'duration'),
              cell(str(row.visual_description) ?? '-', 'visual_description'),
              cell(str(row.dialogue) ?? '-', 'dialogue'),
            ])}
          />
        ) : (
          <p className="py-8 text-center text-[13px] text-muted-foreground">{i18n.t('canvas.assetBoard.textBody.noScript')}</p>
        )}
      </div>
    );
  } else if (isVideoStoryNode(node)) {
    const rows = Array.isArray(node.data.rows) ? node.data.rows : [];
    body =
      rows.length > 0 ? (
        <RowTable
          headers={[i18n.t('canvas.assetBoard.textBody.colShotNo'), i18n.t('canvas.assetBoard.textBody.colDuration'), i18n.t('canvas.assetBoard.textBody.colSummary')]}
          onCellCommit={onCellCommit}
          rows={rows.map((row, index) => [
            cell(
              row.shotNumber !== null && row.shotNumber !== undefined && `${row.shotNumber}`.trim().length > 0
                ? `${row.shotNumber}`
                : String(index + 1),
              'shotNumber',
            ),
            cell(str(row.duration) ?? '-', 'duration'),
            cell(videoStorySummary(row), videoStorySummaryField(row)),
          ])}
        />
      ) : (
        <p className="py-8 text-center text-[13px] text-muted-foreground">{i18n.t('canvas.assetBoard.textBody.noShotRows')}</p>
      );
  } else {
    // Text column fallback (unknown text-type node): no structured rendering path.
    body = <p className="py-8 text-center text-[13px] text-muted-foreground">{i18n.t('canvas.assetBoard.textBody.noContent')}</p>;
  }

  return (
    <div className="flex w-full flex-col gap-4">
      <h1 className="text-xl font-semibold text-foreground">{title}</h1>
      {body}
    </div>
  );
}

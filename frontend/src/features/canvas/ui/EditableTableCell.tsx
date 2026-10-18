// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect, useRef } from 'react';

interface EditableTableCellProps {
  value: string;
  onCommit: (nextValue: string) => void;
  /** Placeholder (shown when the cell is empty, aligned with the "-" of read-only mode). */
  emptyPlaceholder?: string;
}

/**
 * A single-cell inline editor in storyboard / script-type tables. An uncontrolled contentEditable
 * - it does not re-render while typing, and syncs back to the DOM only when the external value changes (regenerate / edited elsewhere);
 * commit on blur; Esc cancels; paste forces plain text; keydown stops bubbling,
 * preventing React Flow from accidentally deleting the node with Backspace/Delete.
 */
export function EditableTableCell({ value, onCommit, emptyPlaceholder = '-' }: EditableTableCellProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.innerText !== value) {
      el.innerText = value;
    }
  }, [value]);

  return (
    <div
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      spellCheck={false}
      data-empty-placeholder={emptyPlaceholder}
      className="editable-table-cell nodrag nowheel -mx-1 block min-h-[1.2em] cursor-text whitespace-pre-wrap break-words rounded px-1 leading-snug outline-none focus:bg-bg-dark/60 focus:ring-1 focus:ring-[rgb(var(--accent-rgb)/0.4)]"
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onBlur={(event) => {
        const next = event.currentTarget.innerText;
        if (next !== value) {
          onCommit(next);
        }
      }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          if (ref.current) {
            ref.current.innerText = value;
          }
          event.currentTarget.blur();
        }
      }}
      onPaste={(event) => {
        event.preventDefault();
        const plain = event.clipboardData.getData('text/plain');
        document.execCommand('insertText', false, plain);
      }}
    />
  );
}

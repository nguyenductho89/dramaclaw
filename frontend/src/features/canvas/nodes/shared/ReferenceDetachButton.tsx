// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface ReferenceDetachButtonProps {
  /** Upstream node id (the edge's source) */
  nodeId: string;
  /** Detach-reference callback */
  onDetach: (nodeId: string) => void;
  /** Extra positioning/style class names (defaults to the top right corner) */
  className?: string;
}

/**
 * The "detach reference" button on a reference asset thumbnail.
 *
 * Uses <span role="button"> (rather than <button>) so that it can nest inside a reference chip that is
 * itself a <button> without producing an illegal button nesting.
 *
 * Convention: the parent container needs `group relative`, the button is `hidden` by default and
 * shown on hover through `group-hover:flex`.
 */
export function ReferenceDetachButton({ nodeId, onDetach, className }: ReferenceDetachButtonProps) {
  const { t } = useTranslation();
  return (
    <span
      role="button"
      tabIndex={-1}
      title={t('canvas.reference.detach')}
      className={
        className ??
        'nodrag absolute right-1 top-1 z-10 hidden h-4 w-4 items-center justify-center rounded-full bg-black/70 text-white shadow-sm ring-1 ring-white/15 transition-colors hover:bg-red-500 group-hover:flex'
      }
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onDetach(nodeId);
      }}
    >
      <X className="h-3 w-3" strokeWidth={2.5} />
    </span>
  );
}

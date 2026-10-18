// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Maximize2, Minimize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { CANVAS_NODE_INPUT_SURFACE_CLASS } from '@/features/canvas/ui/nodeFrameStyles';

interface PanelExpandButtonProps {
  expanded: boolean;
  onToggle: () => void;
  /** Positioning / layout classes from the caller (e.g. `absolute right-2 top-2`). */
  className?: string;
}

/**
 * The operation area's "Enlarge / Collapse" toggle. The floating operation panels of each node (ImageGen / Video / Audio ...)
 * share this one button: expanding enlarges the panel into a more comfortable editing size, and collapsing restores it. The position is decided by the caller
 * through `className` (generally absolute at the panel's top-right).
 */
export function PanelExpandButton({ expanded, onToggle, className }: PanelExpandButtonProps) {
  const { t } = useTranslation();
  const label = expanded
    ? t('node.operationPanel.collapse')
    : t('node.operationPanel.expand');
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={(event) => {
        event.stopPropagation();
        onToggle();
      }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={(event) => event.stopPropagation()}
      className={`nodrag flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${CANVAS_NODE_INPUT_SURFACE_CLASS} text-text-muted transition-colors hover:bg-white/[0.1] hover:text-text-dark ${className ?? ''}`}
    >
      {expanded ? (
        <Minimize2 className="h-3.5 w-3.5" />
      ) : (
        <Maximize2 className="h-3.5 w-3.5" />
      )}
    </button>
  );
}

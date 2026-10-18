// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import i18n from 'i18next';
import { MessageSquarePlus } from 'lucide-react';
import type { ReactElement } from 'react';

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { canvasEventBus } from '@/features/canvas/application/canvasServices';
import { cn } from '@/lib/utils';

export function addNodeToChatLabel(): string {
  return i18n.t('canvas.addToChat.label');
}

/**
 * Add a node as a reference into the shrimp guide input box. Canvas nodes and storyboard cards share this one entry: the two views are
 * two projections of the same node data, and the reference semantics must be consistent, so both only emit an event and let FreezoneShell
 * land it uniformly (select + expand chat), avoiding each side writing its own selection logic and the behavior drifting apart.
 */
export function addNodesToChat(nodeIds: string[]): void {
  const ids = nodeIds.filter((nodeId) => nodeId.trim().length > 0);
  if (ids.length === 0) return;
  canvasEventBus.publish('freezone/add-nodes-to-chat', { nodeIds: ids });
}

/** For canvas nodes: floats at the top-right inside the card, transparent normally, appearing on hover of the node root (`group`) or keyboard focus. */
const FLOATING_BUTTON_CLASS = cn(
  // nodrag must stay, otherwise pressing the button would be taken by React Flow as dragging the node.
  'nodrag absolute right-1.5 top-1.5 z-30 inline-flex h-7 w-7 items-center justify-center rounded-md',
  'bg-black/55 text-white/85 opacity-0 backdrop-blur-sm transition-opacity',
  'hover:bg-black/75 hover:text-white focus-visible:opacity-100',
  'group-hover:opacity-100 group-focus-within:opacity-100',
);

type AddNodeToChatTriggerProps = {
  nodeId: string;
  className: string;
  iconClassName?: string;
  /** Direction of the text hint; default top, and pass bottom for positions hugging the top edge so the hint is not clipped. */
  side?: 'top' | 'bottom' | 'left' | 'right';
};

/**
 * The button itself. The text hint uses the shadcn Tooltip rather than the native title: the native one needs about a second of hovering to show,
 * and its style is inconsistent with the product's other floating descriptions. So only aria-label is kept here for screen readers, and title is no longer attached
 * - having both would pop up two hints at the same time.
 */
function AddNodeToChatTrigger({
  nodeId,
  className,
  iconClassName,
  side = 'top',
}: AddNodeToChatTriggerProps): ReactElement {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              aria-label={addNodeToChatLabel()}
              onClick={(event) => {
                // Do not bubble to the node root / card: their onClick resets the selection to "only this one"
                // or opens the detail directly, while what is wanted here is accumulating references (click several nodes to build up a group of context).
                event.stopPropagation();
                addNodesToChat([nodeId]);
              }}
              onPointerDown={(event) => event.stopPropagation()}
              className={className}
            />
          }
        >
          <MessageSquarePlus className={cn('h-4 w-4', iconClassName)} />
        </TooltipTrigger>
        <TooltipContent side={side}>{addNodeToChatLabel()}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

type AddNodeToChatButtonProps = {
  nodeId: string;
  /** Append/override positioning style; the default is the one canvas nodes use, "floating at the top-right inside the card". */
  className?: string;
  iconClassName?: string;
  side?: AddNodeToChatTriggerProps['side'];
};

/** The "Add to chat" at the top-right of a canvas node. */
export function AddNodeToChatButton({
  nodeId,
  className,
  iconClassName,
  // Default facing left: the node's floating title bar and resolution badge both hang on the same top-right corner at -top-7,
  // and a hint facing up would land right on top of them.
  side = 'left',
}: AddNodeToChatButtonProps): ReactElement {
  return (
    <AddNodeToChatTrigger
      nodeId={nodeId}
      className={cn(FLOATING_BUTTON_CLASS, className)}
      iconClassName={iconClassName}
      side={side}
    />
  );
}

/**
 * For the storyboard: carries no positioning/colors of its own, with styles entirely given by the caller (the card's top-right action group, the detail header's
 * icon button each have their own existing classes), but shares the same behavior and text hint.
 */
export function AddNodeToChatIconButton({
  nodeId,
  className,
  iconClassName,
  side,
}: AddNodeToChatButtonProps & { className: string }): ReactElement {
  return (
    <AddNodeToChatTrigger
      nodeId={nodeId}
      className={className}
      iconClassName={iconClassName}
      side={side}
    />
  );
}

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { AtSign } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { NODE_REFERENCE_MEDIA_MENTION_CLASS } from '@/features/canvas/ui/nodeControlStyles';

interface ReferenceMentionButtonProps {
  /** This reference's name in the prompt, such as "image1"; used only for the title. */
  mentionName: string;
  onInsert: () => void;
  className?: string;
}

/**
 * The @ button at the lower right of a reference asset thumbnail: one click inserts this reference into the prompt input below.
 *
 * Before this, to reference the Nth image the user had to count its position and hand-type `@imageN` — a miscount
 * made the backend generate from the wrong image. Here the chip is bound directly to its number, and one click inserts the correct mention.
 *
 * Like [[ReferenceDetachButton]] it uses <span role="button">: the reference chip itself is a
 * <button>, and nesting <button> is an illegal structure.
 */
export function ReferenceMentionButton({
  mentionName,
  onInsert,
  className,
}: ReferenceMentionButtonProps) {
  const { t } = useTranslation();
  return (
    <span
      role="button"
      tabIndex={-1}
      title={t('canvas.reference.mention', { name: mentionName })}
      className={className ?? NODE_REFERENCE_MEDIA_MENTION_CLASS}
      onMouseDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        // Double-clicking a chip means "jump to that node on the canvas"; do not let the second click landing on @ also trigger the jump.
        event.preventDefault();
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onInsert();
      }}
    >
      <AtSign className="h-2.5 w-2.5" strokeWidth={2.5} />
    </span>
  );
}

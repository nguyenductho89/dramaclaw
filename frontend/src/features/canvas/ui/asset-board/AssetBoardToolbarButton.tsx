// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { Loader2, type LucideIcon } from 'lucide-react';
import type { ReactElement, ReactNode } from 'react';

/**
 * The unified style of detail toolbar buttons (shared by the image/video/text toolbars + the second batch of image action areas).
 *
 * The corner radius is reduced to rounded-[6px]: this project's --radius=1rem, rounded-md works out to 14px, which on a ~29px-high
 * button is almost a full pill, blurring together with the badge chips (rounded-full); shrinking one notch tells them apart.
 */
export const DETAIL_TOOLBAR_BUTTON_CLASS =
  'inline-flex items-center gap-1.5 rounded-[6px] border border-white/10 bg-white/5 px-2.5 py-1.5 text-[12px] text-white/75 transition-colors hover:bg-white/10 hover:text-white/90 disabled:cursor-not-allowed disabled:opacity-45';

/**
 * The detail toolbar button. It is split into its own file (rather than left in AssetBoardDetailToolbar) to break the circular import between
 * the toolbar <-> the second batch of action areas (AssetBoardImageEditMenu).
 */
export function DetailToolbarButton({
  icon: Icon,
  label,
  onClick,
  disabled = false,
  busy = false,
  title,
  trailing,
}: {
  icon: LucideIcon;
  label: string;
  onClick?: () => void;
  disabled?: boolean;
  /** In progress: the icon becomes a spinner and is disabled (the simplest in-progress feedback for generation-type actions). */
  busy?: boolean;
  title?: string;
  trailing?: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      title={title ?? label}
      disabled={disabled || busy}
      onClick={onClick}
      className={DETAIL_TOOLBAR_BUTTON_CLASS}
    >
      {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Icon className="h-3.5 w-3.5" />}
      {label}
      {trailing}
    </button>
  );
}

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// The "New folder" dialog. It takes only a name, with duplicate/too-long judged by the backend and echoed below the input box.
// It may open on top of the "Upload asset" dialog (a folder can also be created on the spot at the save location), so z-index
// is raised via layer rather than hard-coded.
//
// Folder rename and asset rename also reuse this one: all are "pop a dialog to take a name", differing only in title,
// field name and length limit, each passed in.
import { useEffect, useId, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Loader2, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { FOLDER_NAME_MAX_LEN } from './assetLibraryItems';

export interface AssetLibraryNewFolderDialogProps {
  open: boolean;
  onClose: () => void;
  /** Throwing counts as failure, the error message is shown directly below the input box, and the dialog stays open. */
  onSubmit: (name: string) => Promise<void>;
  /** Pass a higher layer when stacked on top of the upload dialog. */
  z?: number;
  /** Rename reuses the same dialog, changing only the title and initial value. */
  title?: string;
  /** New or rename - only affects the description line under the title, defaulting to new. */
  mode?: 'create' | 'rename';
  initialName?: string;
  /** The field name above the input box. Pass "Asset name" when renaming an asset. */
  fieldLabel?: string;
  placeholder?: string;
  /** Character limit, kept consistent with the backend validation. */
  maxLength?: number;
}

export function AssetLibraryNewFolderDialog({
  open,
  onClose,
  onSubmit,
  z = 320,
  title,
  mode = 'create',
  initialName = '',
  fieldLabel,
  placeholder,
  maxLength = FOLDER_NAME_MAX_LEN,
}: AssetLibraryNewFolderDialogProps) {
  const { t } = useTranslation();
  // The asset rename dialog and the folder dialog may be on the tree at the same time, and a hard-coded id would be duplicated.
  const inputId = useId();
  const errorId = useId();
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (open) {
      setName(initialName);
      setError(null);
      setSubmitting(false);
    }
  }, [open, initialName]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !submitting) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose, submitting]);

  if (typeof document === 'undefined' || !open) return null;

  const clean = name.trim();
  const canSubmit = clean.length > 0 && !submitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(clean);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      // Must reset in finally: on success the dialog is closed and this setState does not matter; but
      // the handler may also return without doing anything (e.g. project is still null), and resetting only in
      // catch would then gray out "Save" permanently, with the user not even seeing an error hint.
      setSubmitting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 flex items-center justify-center"
      style={{ zIndex: z }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        className="absolute inset-0 bg-black/60"
        onClick={() => {
          if (!submitting) onClose();
        }}
      />
      <div className="relative w-[min(420px,90vw)] overflow-hidden rounded-xl border border-[var(--ui-border-strong)] bg-[var(--ui-surface-modal)] shadow-[0_18px_48px_rgba(0,0,0,0.5)]">
        <div className="flex items-start justify-between gap-4 px-5 pb-2 pt-5">
          <div>
            <h3 className="text-lg font-semibold text-foreground">
              {title ?? t('canvas.assetLibrary.newFolder')}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {mode === 'create'
                ? t('canvas.assetLibrary.folderDialog.createHint')
                : t('canvas.assetLibrary.folderDialog.renameHint')}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t('common.close')}
            aria-label={t('common.close')}
            disabled={submitting}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-[rgba(var(--bg-rgb)/0.5)] hover:text-foreground disabled:opacity-40"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 pb-4 pt-3">
          <div className="mb-2 flex items-center justify-between gap-3">
            <label
              htmlFor={inputId}
              className="text-xs font-medium text-foreground"
            >
              {fieldLabel ?? t('canvas.assetLibrary.folderDialog.fieldLabel')}{' '}
              <span className="text-destructive">*</span>
            </label>
            <span className="text-xs text-muted-foreground">
              {name.length}/{maxLength}
            </span>
          </div>
          <div className="flex items-center rounded-sm border border-[var(--ui-border-soft)] bg-[rgba(var(--bg-rgb)/0.5)] px-3 transition-[border-color,box-shadow] focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/15">
            <input
              id={inputId}
              value={name}
              autoFocus
              maxLength={maxLength}
              placeholder={
                placeholder ?? t('canvas.assetLibrary.folderDialog.placeholder')
              }
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleSubmit();
              }}
              aria-invalid={Boolean(error)}
              aria-describedby={error ? errorId : undefined}
              className="h-10 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground/60"
            />
          </div>
          {error && (
            <div
              id={errorId}
              role="alert"
              className="mt-2 text-xs text-destructive"
            >
              {error}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-5 pb-5">
          <Button
            size="sm"
            variant="ghost"
            className="px-4 text-muted-foreground hover:text-foreground"
            onClick={onClose}
          >
            {t('common.cancel')}
          </Button>
          <Button
            size="sm"
            className="bg-primary px-4 text-primary-foreground hover:bg-primary/90"
            disabled={!canSubmit}
            onClick={() => void handleSubmit()}
          >
            {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

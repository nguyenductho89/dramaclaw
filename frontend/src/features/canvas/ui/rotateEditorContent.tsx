// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import {
  Check,
  FlipHorizontal,
  FlipVertical,
  Loader2,
  RotateCw,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  isIdentityRotateTransform,
  rotateImageInPlace,
} from '@/features/canvas/application/imageRotate';

import { CANVAS_NODE_TOOLBAR_PILL_CLASS } from './nodeFrameStyles';

/**
 * The **shell-agnostic** content layer of the "Rotate and mirror" editor: state machine + that control bar.
 *
 * It is extracted because the same interaction has to be mounted on two shells: the workflow stuffs it into the
 * `ReactFlowNodeToolbar` above the node (RotateEditorOverlay), while the storyboard detail has no React Flow and goes through
 * a full-screen dialog portaled to body (AssetBoardRotateDialog). Both sides share the hook and
 * control bar here, so behavior/visuals do not each grow their own way.
 *
 * The preview image is not here: the framing boxes of the two shells differ too much (the workflow crops by node size, the storyboard has a large image
 * centered), and each just renders `<img style={{ transform }}>`, with the transform given by the hook.
 */

// Rotation anchor: every click of "clockwise 90 degrees" adds 90 degrees onto the angle slider's current value,
// while mirroring is a boolean toggle (pressing again cancels it), consistent with libtv behavior.
function normalizeAngle(angle: number): number {
  const n = angle % 360;
  return n < 0 ? n + 360 : n;
}

export interface RotateEditorController {
  angle: number;
  mirrorH: boolean;
  mirrorV: boolean;
  isSaving: boolean;
  /** The CSS transform for live preview (rotation + two-way mirroring). */
  transform: string;
  onAngleChange: (value: number) => void;
  onRotate90: () => void;
  onToggleMirrorH: () => void;
  onToggleMirrorV: () => void;
  onExit: () => void;
  onSave: () => void;
}

export interface UseRotateEditorOptions {
  /** The target node the rotation is written back to (the "rotate result" node pre-built by the caller before entering the editor). */
  nodeId: string;
  imageSource: string;
  /**
   * Close the editor. `committed` indicates whether a rotation was really committed (write-back to the node has started):
   *   - `false`: the user exits / presses Esc / closes with no transform at all - the caller should delete the "rotate result"
   *     node pre-created when entering rotation, avoiding a node appearing from nowhere.
   *   - `true`: the rotation result has started being written back to that node, and the caller keeps it.
   */
  onClose: (committed: boolean) => void;
  /**
   * When submission succeeds and the write-back task has taken off, hand its completion to the host, triggered before `onClose(true)`.
   * The storyboard uses it to attach the busy state and failure feedback (the red line on the source node's detail panel); the workflow does not need it,
   * so it can be omitted.
   */
  onCommitted?: (completion: Promise<void>) => void;
}

export function useRotateEditor({
  nodeId,
  imageSource,
  onClose,
  onCommitted,
}: UseRotateEditorOptions): RotateEditorController {
  const [angle, setAngle] = useState(0);
  const [mirrorH, setMirrorH] = useState(false);
  const [mirrorV, setMirrorV] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const transform = useMemo(() => {
    const sx = mirrorH ? -1 : 1;
    const sy = mirrorV ? -1 : 1;
    return `rotate(${angle}deg) scale(${sx}, ${sy})`;
  }, [angle, mirrorH, mirrorV]);

  const onRotate90 = useCallback(() => {
    setAngle((prev) => normalizeAngle(prev + 90));
  }, []);

  const onAngleChange = useCallback((value: number) => {
    if (Number.isFinite(value)) {
      setAngle(normalizeAngle(value));
    }
  }, []);

  const onToggleMirrorH = useCallback(() => setMirrorH((prev) => !prev), []);
  const onToggleMirrorV = useCallback(() => setMirrorV((prev) => !prev), []);
  const onExit = useCallback(() => onClose(false), [onClose]);

  const onSave = useCallback(() => {
    if (isSaving) return;
    const rotateTransform = { angleDeg: angle, mirrorH, mirrorV };
    // With no transform at all, close directly, with no need to upload and rewrite. Treated as "not committed", so the caller deletes
    // the pre-created result node (equivalent to exit).
    if (isIdentityRotateTransform(rotateTransform)) {
      onClose(false);
      return;
    }

    // Setting isGenerating and the later write-back are all done inside the application function; when project is missing it returns
    // null, and the editing state is not changed here (consistent with the original behavior of "just return, do not close").
    const completion = rotateImageInPlace(nodeId, imageSource, rotateTransform);
    if (!completion) return;

    setIsSaving(true);
    onCommitted?.(completion);
    // The rotation result has started being written back to that node - mark it as committed, and the caller keeps the node.
    onClose(true);
    void completion.finally(() => setIsSaving(false));
  }, [
    angle,
    imageSource,
    isSaving,
    mirrorH,
    mirrorV,
    nodeId,
    onClose,
    onCommitted,
  ]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isSaving) {
        onClose(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSaving, onClose]);

  return {
    angle,
    mirrorH,
    mirrorV,
    isSaving,
    transform,
    onAngleChange,
    onRotate90,
    onToggleMirrorH,
    onToggleMirrorV,
    onExit,
    onSave,
  };
}

const ICON_BUTTON_CLASS =
  'flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-text-dark transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-50';

/**
 * Control bar: exit · angle · clockwise 90 degrees · horizontal/vertical mirror · save.
 *
 * @param showTitle whether to show the "Rotate and mirror" title to the right of the exit button. The one in the workflow sits directly above the node,
 *   its width follows the node, and adding a title would push past the node boundary, so it is off by default; the storyboard floats above a large image,
 *   with ample space and a need to say which editor is current, so it is on.
 */
export function RotateEditorToolbar({
  controller,
  showTitle = false,
}: {
  controller: RotateEditorController;
  showTitle?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { angle, isSaving, mirrorH, mirrorV } = controller;

  return (
    <div
      className={`flex w-max items-center gap-1 whitespace-nowrap ${CANVAS_NODE_TOOLBAR_PILL_CLASS}`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-bg-dark/70 text-text-muted transition-colors hover:bg-bg-dark hover:text-text-dark disabled:cursor-not-allowed disabled:opacity-50"
        onClick={controller.onExit}
        title={t('rotateEditor.exit')}
        aria-label={t('rotateEditor.exit')}
        disabled={isSaving}
      >
        <X className="h-4 w-4" />
      </button>

      {showTitle && (
        <>
          <span className="shrink-0 px-1.5 text-xs font-medium text-text-dark">
            {t('rotateEditor.title')}
          </span>
          <span className="mx-0.5 h-5 w-px shrink-0 bg-white/10" aria-hidden />
        </>
      )}

      <div className="flex shrink-0 items-center gap-2 px-2" title={t('rotateEditor.angleLabel')}>
        {/* When the "Rotate and mirror" title is already there, "Rotation angle" is not repeated, leaving only the input box (the accessible name
        is provided by the input's own aria-label), consistent with libtv's control bar. */}
        {!showTitle && (
          <span className="shrink-0 text-[11px] text-text-dark/90">
            {t('rotateEditor.angleLabel')}
          </span>
        )}
        <div className="relative shrink-0">
          <input
            type="number"
            min={0}
            max={360}
            step={1}
            value={Math.round(angle)}
            disabled={isSaving}
            aria-label={t('rotateEditor.angleLabel')}
            onChange={(event) => controller.onAngleChange(Number(event.target.value))}
            className="h-7 w-16 rounded-md border border-[rgba(255,255,255,0.14)] bg-bg-dark/60 px-1.5 pr-5 text-center text-xs text-text-dark outline-none focus:border-accent disabled:opacity-50"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-text-muted">
            {t('rotateEditor.angleSuffix')}
          </span>
        </div>
      </div>

      <button
        type="button"
        className={ICON_BUTTON_CLASS}
        onClick={controller.onRotate90}
        title={t('rotateEditor.rotate90')}
        aria-label={t('rotateEditor.rotate90')}
        disabled={isSaving}
      >
        <RotateCw className="h-4 w-4" />
      </button>

      <button
        type="button"
        className={ICON_BUTTON_CLASS}
        onClick={controller.onToggleMirrorH}
        title={t('rotateEditor.mirrorH')}
        aria-label={t('rotateEditor.mirrorH')}
        aria-pressed={mirrorH}
        disabled={isSaving}
      >
        <FlipHorizontal className="h-4 w-4" />
      </button>

      <button
        type="button"
        className={ICON_BUTTON_CLASS}
        onClick={controller.onToggleMirrorV}
        title={t('rotateEditor.mirrorV')}
        aria-label={t('rotateEditor.mirrorV')}
        aria-pressed={mirrorV}
        disabled={isSaving}
      >
        <FlipVertical className="h-4 w-4" />
      </button>

      <button
        type="button"
        onClick={controller.onSave}
        disabled={isSaving}
        className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full bg-white px-3 text-xs font-medium text-bg-dark transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        title={t('rotateEditor.save')}
      >
        {isSaving ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : (
          <Check className="h-4 w-4" />
        )}
        {isSaving ? t('rotateEditor.saving') : t('rotateEditor.save')}
      </button>
    </div>
  );
}

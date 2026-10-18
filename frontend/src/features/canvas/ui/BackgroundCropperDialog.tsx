// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import ReactCrop, { type Crop, type PixelCrop } from 'react-image-crop';
import 'react-image-crop/dist/ReactCrop.css';

import { UiButton, UiModal } from '@/components/ui/primitives';
import { resolveImageDisplayUrl } from '@/features/canvas/application/imageData';

/**
 * Screenshot region dialog - the user picks a fixed-ratio region from a source image (master/reverse etc.)
 * as the beat's selected_background.
 *
 * Flow:
 *   1. Load the source image and show the react-image-crop UI
 *   2. The user drags out a fixed-ratio region (aspect ratio locked)
 *   3. Click "Use as background source" -> canvas.toBlob
 *   4. The parent component decides whether to go the mainline Commit or the legacy background-anchor upload
 *
 * Different from the Pano360 + 3GS "capture the current viewer view" path - those two sources are rendered live in the browser
 * (yaw/pitch/fov, PlayCanvas camera), and in the end also toBlob -> upload, but through the capture buttons
 * on their own viewer nodes, not through this dialog. This dialog is dedicated to
 * flat sources (master / reverse).
 */
export interface BackgroundCropperDialogProps {
  isOpen: boolean;
  onClose: () => void;
  sourceUrl: string;
  sourceLabel?: string;
  aspectOptions?: readonly string[];
  defaultAspectRatio?: string;
  onConfirmBlob: (blob: Blob, filename: string) => Promise<void>;
  onCandidateSuccess?: (message: string) => void;
  onError?: (message: string) => void;
}

const DEFAULT_ASPECT_OPTIONS = ['16:9'] as const;

function parseAspectRatioValue(value: string): number {
  const [rawWidth, rawHeight] = value.split(':');
  const width = Number(rawWidth);
  const height = Number(rawHeight);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return 16 / 9;
  }
  return width / height;
}

export function centerInitialCrop(width: number, height: number, targetAspectRatio = 16 / 9): Crop {
  const sourceAspect = width / height;
  if (sourceAspect >= targetAspectRatio) {
    // The source is wider -> use the source's full height, centering the target ratio horizontally
    const cropWidthPct = (targetAspectRatio / sourceAspect) * 100;
    return {
      unit: '%',
      x: (100 - cropWidthPct) / 2,
      y: 0,
      width: cropWidthPct,
      height: 100,
    };
  }
  // The source is taller -> use the source's full width, centering the target ratio vertically
  const cropHeightPct = (sourceAspect / targetAspectRatio) * 100;
  return {
    unit: '%',
    x: 0,
    y: (100 - cropHeightPct) / 2,
    width: 100,
    height: cropHeightPct,
  };
}

export function pixelCropFromPercentCrop(
  cropValue: Crop,
  width: number,
  height: number,
): PixelCrop {
  if (cropValue.unit !== '%') {
    return {
      unit: 'px',
      x: cropValue.x,
      y: cropValue.y,
      width: cropValue.width,
      height: cropValue.height,
    };
  }
  return {
    unit: 'px',
    x: (cropValue.x / 100) * width,
    y: (cropValue.y / 100) * height,
    width: (cropValue.width / 100) * width,
    height: (cropValue.height / 100) * height,
  };
}

async function exportCroppedBlob(
  image: HTMLImageElement,
  pixelCrop: PixelCrop,
): Promise<Blob> {
  const canvas = document.createElement('canvas');
  // Compute scale with the source's original resolution (image.naturalWidth/Height), ensuring the crop
  // output is a subset of the source's real pixels rather than displayed pixels (the latter would be scaled down to the dialog size).
  const scaleX = image.naturalWidth / image.width;
  const scaleY = image.naturalHeight / image.height;
  canvas.width = Math.round(pixelCrop.width * scaleX);
  canvas.height = Math.round(pixelCrop.height * scaleY);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas 2d context unavailable');
  ctx.drawImage(
    image,
    pixelCrop.x * scaleX,
    pixelCrop.y * scaleY,
    pixelCrop.width * scaleX,
    pixelCrop.height * scaleY,
    0,
    0,
    canvas.width,
    canvas.height,
  );
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas toBlob returned null'));
      },
      'image/png',
      0.95,
    );
  });
}

export function BackgroundCropperDialog({
  isOpen,
  onClose,
  sourceUrl,
  sourceLabel,
  aspectOptions = DEFAULT_ASPECT_OPTIONS,
  defaultAspectRatio,
  onConfirmBlob,
  onCandidateSuccess,
  onError,
}: BackgroundCropperDialogProps) {
  const { t } = useTranslation();
  const [crop, setCrop] = useState<Crop | undefined>(undefined);
  const [completedCrop, setCompletedCrop] = useState<PixelCrop | undefined>(undefined);
  const [selectedAspectRatio, setSelectedAspectRatio] = useState(
    defaultAspectRatio ?? aspectOptions[0] ?? '16:9',
  );
  const [uploading, setUploading] = useState(false);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const normalizedAspectOptions = useMemo(
    () => Array.from(new Set(aspectOptions.length > 0 ? aspectOptions : DEFAULT_ASPECT_OPTIONS)),
    [aspectOptions],
  );
  const targetAspectRatio = useMemo(
    () => parseAspectRatioValue(selectedAspectRatio),
    [selectedAspectRatio],
  );

  // Reset crop when source changes / dialog opens
  useEffect(() => {
    if (isOpen) {
      setSelectedAspectRatio(defaultAspectRatio ?? normalizedAspectOptions[0] ?? '16:9');
      setCrop(undefined);
      setCompletedCrop(undefined);
    }
  }, [defaultAspectRatio, isOpen, normalizedAspectOptions, sourceUrl]);

  useEffect(() => {
    if (!isOpen || !imgRef.current) return;
    const img = imgRef.current;
    const nextCrop = centerInitialCrop(img.width, img.height, targetAspectRatio);
    setCrop(nextCrop);
    setCompletedCrop(pixelCropFromPercentCrop(nextCrop, img.width, img.height));
  }, [isOpen, selectedAspectRatio, targetAspectRatio]);

  const handleImageLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    imgRef.current = img;
    const initialCrop = centerInitialCrop(img.width, img.height, targetAspectRatio);
    setCrop(initialCrop);
    setCompletedCrop(pixelCropFromPercentCrop(initialCrop, img.width, img.height));
  }, [targetAspectRatio]);

  const handleConfirm = useCallback(async () => {
    if (!imgRef.current || !completedCrop) return;
    if (completedCrop.width === 0 || completedCrop.height === 0) return;
    setUploading(true);
    try {
      const blob = await exportCroppedBlob(imgRef.current, completedCrop);
      const filename = `background_${sourceLabel ?? 'source'}_${Date.now()}.png`;
      await onConfirmBlob(blob, filename);
      onCandidateSuccess?.(t('viewer.threeD.backgroundCropperGenerated'));
      onClose();
    } catch (err) {
      console.error('[bg-cropper] upload failed', err);
      onError?.(err instanceof Error ? err.message : String(err));
    } finally {
      setUploading(false);
    }
  }, [completedCrop, sourceLabel, onConfirmBlob, onCandidateSuccess, onError, onClose, t]);

  const displaySrc = sourceUrl ? resolveImageDisplayUrl(sourceUrl) : '';

  return (
    <UiModal
      isOpen={isOpen}
      title={t('viewer.threeD.backgroundCropperTitle', {
        aspect: selectedAspectRatio,
        source: sourceLabel ? ` · ${sourceLabel}` : '',
      })}
      onClose={onClose}
      widthClassName="w-[720px] max-w-[92vw]"
      footer={
        <>
          <UiButton variant="ghost" onClick={onClose} disabled={uploading}>
            {t('common.cancel')}
          </UiButton>
          <UiButton
            onClick={() => void handleConfirm()}
            disabled={uploading || !completedCrop || completedCrop.width === 0}
          >
            {uploading ? t('common.processing') : t('viewer.threeD.useAsBackgroundSource')}
          </UiButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="text-xs text-text-muted">
          {t('viewer.threeD.backgroundCropperDescription', { aspect: selectedAspectRatio })}
        </p>
        {normalizedAspectOptions.length > 1 && (
          <div className="flex flex-wrap gap-2">
            {normalizedAspectOptions.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setSelectedAspectRatio(option)}
                className={`rounded-[8px] border px-3 py-1.5 text-xs font-medium transition ${
                  selectedAspectRatio === option
                    ? 'border-cyan-200 bg-cyan-200 text-slate-950'
                    : 'border-white/10 bg-white/[0.04] text-text-secondary hover:border-white/20 hover:bg-white/[0.08]'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        )}
        {displaySrc && (
          <div className="flex items-center justify-center rounded-md border border-[rgba(255,255,255,0.08)] bg-black/40 p-2">
            <ReactCrop
              className="[&_.ReactCrop__crop-selection]:!border-2 [&_.ReactCrop__crop-selection]:!border-cyan-200 [&_.ReactCrop__crop-selection]:shadow-[inset_0_0_0_1px_rgba(0,0,0,0.75),0_0_0_1px_rgba(0,0,0,0.75)]"
              crop={crop}
              onChange={(_, percentCrop) => setCrop(percentCrop)}
              onComplete={(c) => setCompletedCrop(c)}
              aspect={targetAspectRatio}
              keepSelection
            >
              <img
                src={displaySrc}
                alt={sourceLabel ?? 'source'}
                onLoad={handleImageLoad}
                className="max-h-[60vh] max-w-full"
                draggable={false}
              />
            </ReactCrop>
          </div>
        )}
      </div>
    </UiModal>
  );
}

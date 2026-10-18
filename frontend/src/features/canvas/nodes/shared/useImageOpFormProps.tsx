// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, type ReactNode } from 'react';

import {
  ASSET_BOARD_IMAGE_OP_MAP,
  clearAssetBoardImageOp,
  isAssetBoardImageOpKey,
  isGridImageOpKey,
  runAssetBoardImageOp,
} from '@/features/canvas/application/assetBoardImageOps';
import { imageModelSupportsQuality } from '@/features/canvas/application/gridTemplateAction';
import { useFreezoneImageModels } from '@/features/canvas/hooks/useFreezoneImageModels';
import { AssetBoardImageOpChip } from '@/features/canvas/ui/asset-board/AssetBoardImageOpChip';
import type { CreditPromotionDisplay } from '@/components/credits/credit-visual';
import { useGenerationCreditCost } from '@/lib/queries/generation-credit-cost';
import { useCanvasStore } from '@/stores/canvasStore';

/** The few props overridden onto `ImageGenerationForm` (for feature nodes only). */
export interface ImageOpFormProps {
  promptLeadingChip: ReactNode;
  onPromptLeadingChipDelete: () => void;
  promptPlaceholder: string;
  onSubmit: () => void;
  submitDisabled: boolean;
  totalCreditCostDisplay: string | null;
  /**
   * Must be overridden together with `totalCreditCostDisplay`: these two props are spread after the host form,
   * and overriding only display would pair the grid's price with the promo label of the base-image quote.
   */
  creditPromotion: CreditPromotionDisplay | null;
}

/**
 * The differing part of the generation form for a feature node (the kind created after picking an item in the "nine-grid / grid template" dropdown):
 * the input gets a switchable, deletable feature chip **inside** it, the feature description serves as the placeholder, and ↑ goes through the matching template
 * instead of regular text-to-image.
 *
 * The workflow (`ImageGenNode`) and the storyboard (`AssetBoardImageGenForm`) mount the same
 * `ImageGenerationForm`, so this difference should be written only once — both spread the same return value,
 * and interaction is naturally consistent. A plain image generation node has no `imageOpKey`, returns null, and the host renders as before.
 */
export function useImageOpFormProps(
  nodeId: string,
  options: { isGenerating: boolean },
): ImageOpFormProps | null {
  const opKeyRaw = useCanvasStore((state) => {
    const node = state.nodes.find((candidate) => candidate.id === nodeId);
    return (node?.data as { imageOpKey?: unknown } | undefined)?.imageOpKey;
  });
  const opKey = isAssetBoardImageOpKey(opKeyRaw) ? opKeyRaw : null;

  const handleSubmit = useCallback(() => {
    void runAssetBoardImageOp(nodeId);
  }, [nodeId]);
  // Backspace at the start of the input = delete this chip = the node falls back to plain image generation.
  const handleChipDelete = useCallback(() => {
    clearAssetBoardImageOp(nodeId);
  }, [nodeId]);

  // Compute cost of a feature node: grids are quoted by image_selection (the same query as the toolbar dropdown, so both places show
  // the same number); if the quote has not returned, fall back to the hard-coded cost in the feature table. Panorama has no matching basis, returning null
  // → CreditCostPill does not render itself.
  const isGridOp = opKey !== null && isGridImageOpKey(opKey);
  const { models: imageModels } = useFreezoneImageModels();
  const selectedModel = imageModels[0];
  // When value is null, useGenerationCreditCost sets enabled:false itself (image_selection
  // belongs to the requiresValue tier), so non-grid features do not needlessly send one quote request.
  const creditCost = useGenerationCreditCost(
    'image_selection',
    isGridOp ? (selectedModel?.apiModel ?? null) : null,
    {
      surface: 'canvas',
      params: imageModelSupportsQuality(selectedModel?.apiModel)
        ? { size: '2K', quality: 'medium' }
        : { size: '2K' },
    },
  );

  if (!opKey) {
    return null;
  }

  return {
    promptLeadingChip: (
      <AssetBoardImageOpChip nodeId={nodeId} opKey={opKey} disabled={options.isGenerating} />
    ),
    onPromptLeadingChipDelete: handleChipDelete,
    promptPlaceholder: ASSET_BOARD_IMAGE_OP_MAP[opKey].description,
    // A feature submit does not require a prompt (the template itself is "generate based on the current image", and the prompt is an optional supplement),
    // so the shared form's `submitDisabled = isGenerating || !hasEffectivePrompt` cannot be reused.
    onSubmit: handleSubmit,
    submitDisabled: options.isGenerating,
    totalCreditCostDisplay: isGridOp
      ? (creditCost.data?.data.display ?? String(ASSET_BOARD_IMAGE_OP_MAP[opKey].cost))
      : null,
    creditPromotion: isGridOp ? (creditCost.data?.data.promotion ?? null) : null,
  };
}

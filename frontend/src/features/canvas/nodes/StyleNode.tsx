// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { memo, useCallback, useMemo, useState } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Images, Palette } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import {
  CANVAS_NODE_TYPES,
  isImageGenNode,
  type StyleNodeData,
} from '@/features/canvas/domain/canvasNodes';
import {
  localizeDefaultNodeDisplayName,
  localizeNodeDisplayName,
} from '@/features/canvas/domain/nodeDisplay';
import {
  NodeHeader,
  NODE_HEADER_FLOATING_POSITION_CLASS,
} from '@/features/canvas/ui/NodeHeader';
import { StyleAssetImage } from '@/features/canvas/ui/StyleAssetImage';
import {
  StyleGalleryModal,
  describeStyleSelection,
  resolveStyleSelectionState,
  type StyleSelectionState,
} from '@/features/canvas/ui/StyleGalleryModal';
import {
  CANVAS_NODE_INPUT_SURFACE_CLASS,
  canvasNodeFrameClass,
} from '@/features/canvas/ui/nodeFrameStyles';
import { useFreezoneStyleTemplates } from '@/features/canvas/hooks/useFreezoneStyleTemplates';
import { useCanvasStore } from '@/stores/canvasStore';
import { useShallow } from 'zustand/react/shallow';

type StyleNodeProps = NodeProps & {
  id: string;
  data: StyleNodeData;
  selected?: boolean;
};

// The card holds only the cover and no longer carries a name row (the style name is in the node title). The cover is 16:9 (720×405);
// once the width is fixed, the height equals the cover's own height, with no cropping to another ratio.
export const STYLE_NODE_WIDTH = 220;
export const STYLE_NODE_HEIGHT = 124;

// "Cover not found" has four causes and the card must say which one: saying "No style selected" would make the user think
// the node is empty, while that id is in fact still sent along with the generation request (the ready state never reaches here).
const STYLE_NODE_PLACEHOLDER_KEYS: Record<StyleSelectionState, string> = {
  none: 'canvas.style.placeholderNone',
  ready: '',
  loading: 'canvas.style.placeholderLoading',
  failed: 'canvas.style.placeholderFailed',
  missing: 'canvas.style.placeholderMissing',
};

export const StyleNode = memo(({ id, data, selected }: StyleNodeProps) => {
  const { t } = useTranslation();
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const [galleryOpen, setGalleryOpen] = useState(false);

  const {
    templates,
    assetBase,
    isLoading: templatesLoading,
    error: templatesError,
    retry: retryTemplates,
  } = useFreezoneStyleTemplates();
  const templateId =
    typeof data.styleTemplateId === 'string' && data.styleTemplateId.length > 0
      ? data.styleTemplateId
      : null;
  const template = describeStyleSelection(templateId, templates);
  const selectionState = resolveStyleSelectionState(templateId, template, {
    isLoading: templatesLoading,
    hasError: templatesError != null,
  });
  // Opening the gallery is an explicit user action, so re-fetch the last failed manifest along the way (a no-op in the success state).
  const openGallery = useCallback(() => {
    retryTemplates();
    setGalleryOpen(true);
  }, [retryTemplates]);

  // The source of truth is the downstream image node's styleTemplateId — this node is only a projection of it, so changing the style writes to
  // downstream first, and the reconciliation over there then aligns this node's data (see the module comment of styleNodeSync).
  const downstreamImageNodeIds = useCanvasStore(
    useShallow((state) => {
      const targetIds = state.edges
        .filter((edge) => edge.source === id)
        .map((edge) => edge.target);
      return state.nodes
        .filter((node) => targetIds.includes(node.id) && isImageGenNode(node))
        .map((node) => node.id);
    }),
  );
  const isOrphan = downstreamImageNodeIds.length === 0;

  // The title follows the selected style: "Style · Category · Style name". If the user renamed it by hand (data.displayName
  // has a value), the user's name wins; do not overwrite their rename.
  const resolvedTitle = useMemo(() => {
    const customTitle =
      typeof data.displayName === 'string' ? data.displayName.trim() : '';
    if (customTitle) return customTitle;
    if (!template) return localizeNodeDisplayName(CANVAS_NODE_TYPES.style, data, t);
    return [
      localizeDefaultNodeDisplayName(CANVAS_NODE_TYPES.style, data, t),
      template.category,
      template.label,
    ]
      .filter((part) => typeof part === 'string' && part.trim().length > 0)
      .join(' · ');
  }, [data, t, template]);
  const cardToneClass = canvasNodeFrameClass({ selected });

  const handleSelectStyle = useCallback(
    (nextId: string | null) => {
      downstreamImageNodeIds.forEach((imageNodeId) => {
        updateNodeData(imageNodeId, { styleTemplateId: nextId });
      });
      setGalleryOpen(false);
    },
    [downstreamImageNodeIds, updateNodeData],
  );

  return (
    <div
      className="group relative h-full w-full overflow-visible"
      style={{ width: STYLE_NODE_WIDTH, height: STYLE_NODE_HEIGHT }}
      onClick={() => setSelectedNode(id)}
    >
      <Handle
        type="source"
        position={Position.Right}
        id="source"
        className="!h-2 !w-2 !border-0 !bg-[rgb(148,163,184)]"
      />

      <NodeHeader
        className={NODE_HEADER_FLOATING_POSITION_CLASS}
        icon={<Palette className="h-4 w-4" />}
        titleText={resolvedTitle}
        editable
        onTitleChange={(next) => updateNodeData(id, { displayName: next })}
      />

      <div
        role="button"
        tabIndex={0}
        aria-label={
          template ? t('canvas.style.thumbAria', { label: template.label }) : t('canvas.style.select')
        }
        aria-disabled={isOrphan}
        onClick={(event) => {
          event.stopPropagation();
          if (isOrphan) return;
          openGallery();
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          if (isOrphan) return;
          openGallery();
        }}
        className={`relative flex h-full w-full flex-col overflow-hidden rounded-[var(--node-radius)] border ${CANVAS_NODE_INPUT_SURFACE_CLASS} transition-colors ${cardToneClass} ${
          isOrphan ? 'cursor-default' : 'cursor-pointer'
        }`}
      >
        <div className="relative flex-1 overflow-hidden bg-white/[0.04]">
          {template ? (
            <StyleAssetImage
              rel={template.cover}
              assetBase={assetBase}
              alt={template.label}
              draggable={false}
              className="h-full w-full object-cover"
            />
          ) : (
            <div
              className={`flex h-full w-full items-center justify-center text-[12px] ${
                selectionState === 'failed' || selectionState === 'missing'
                  ? 'text-amber-300/90'
                  : 'text-text-muted/90'
              }`}
            >
              {STYLE_NODE_PLACEHOLDER_KEYS[selectionState]
                ? t(STYLE_NODE_PLACEHOLDER_KEYS[selectionState])
                : ''}
            </div>
          )}
        </div>
        {isOrphan && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-black/60 px-2 py-1 text-center text-[11px] text-text-dark/80">
            {t('canvas.style.noImageUpstream')}
          </span>
        )}
      </div>

      {/*
        Clicking anywhere on the cover also opens the gallery, but that is a hidden interaction with no hint — this button at the top right
        is the visible entry. It is placed outside the card as a sibling: the card itself is role="button", and nesting the button
        inside would produce nested interactive elements.
      */}
      {!isOrphan && (
        <button
          type="button"
          aria-label={t('canvas.style.change')}
          title={t('canvas.style.change')}
          onClick={(event) => {
            event.stopPropagation();
            openGallery();
          }}
          className="absolute right-2 top-2 z-10 flex size-7 items-center justify-center rounded-md bg-black/55 text-text-dark opacity-0 transition-opacity hover:bg-black/75 focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Images className="size-4" />
        </button>
      )}

      {galleryOpen && (
        <StyleGalleryModal
          templates={templates}
          assetBase={assetBase}
          selectedId={templateId}
          isLoading={templatesLoading}
          onSelect={handleSelectStyle}
          onClose={() => setGalleryOpen(false)}
        />
      )}
    </div>
  );
});

StyleNode.displayName = 'StyleNode';

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { compileFreezoneRecipePrompt, generateFreezoneRecipeText } from '@/api/ops';
import { CANVAS_NODE_TYPES } from '../domain/canvasNodes';
import {
  compileWorkflowNodePrompt,
  generateWorkflowText,
  selectWorkflowUpstreamText,
} from './workflowRecipeRuntime';
import {
  bindWorkflowProductOperation,
  clearWorkflowProductOperation,
  WORKFLOW_EXECUTION_ACTIVITY_EVENT,
  type WorkflowExecutionActivityDetail,
} from './workflowExecutionActivity';

vi.mock('@/api/ops', () => ({
  compileFreezoneRecipePrompt: vi.fn(),
  generateFreezoneRecipeText: vi.fn(),
}));

const compileMock = vi.mocked(compileFreezoneRecipePrompt);
const generateTextMock = vi.mocked(generateFreezoneRecipeText);

describe('workflowRecipeRuntime', () => {
  beforeEach(() => {
    compileMock.mockReset();
    generateTextMock.mockReset();
  });

  it('keeps legacy node prompts unchanged', async () => {
    const result = await compileWorkflowNodePrompt({
      nodeData: { prompt: 'manual' },
      nodeKind: 'image',
      nodePrompt: 'manual',
      fallbackPrompt: 'upstream\n\nmanual',
    });

    expect(result).toBe('upstream\n\nmanual');
    expect(compileMock).not.toHaveBeenCalled();
  });

  it('compiles catalog-backed nodes with user goal and upstream context', async () => {
    compileMock.mockResolvedValue('compiled prompt');

    const result = await compileWorkflowNodePrompt({
      nodeData: {
        workflowCatalog: {
          skillId: 'ecommerce-product',
          skillVersion: '2.0.0',
          confirmedInputs: { aspect_ratio: '9:16', language: 'zh' },
          recipeId: 'ecommerce-scene-image',
          recipeVersion: '1',
          promptStrategy: 'previous_output',
          promptBuilder: { userGoal: 'Generate three product images' },
        },
      },
      nodeKind: 'image',
      nodePrompt: 'Nordic kitchen',
      upstreamText: 'Silver coffee machine',
      fallbackPrompt: 'fallback',
      referenceMedia: [{ kind: 'image', label: 'Product reference image' }],
    });

    expect(result).toBe('compiled prompt');
    expect(compileMock).toHaveBeenCalledWith({
      recipeId: 'ecommerce-scene-image',
      recipeVersion: '1',
      skillId: 'ecommerce-product',
      skillVersion: '2.0.0',
      confirmedInputs: { aspect_ratio: '9:16', language: 'zh' },
      nodeKind: 'image',
      promptStrategy: 'previous_output',
      nodePrompt: 'Nordic kitchen',
      upstreamText: 'Silver coffee machine',
      userGoal: 'Generate three product images',
      referenceMedia: [{ kind: 'image', label: 'Product reference image' }],
    });
  });

  it('does not forward legacy dependency arrays as confirmed Skill inputs', async () => {
    compileMock.mockResolvedValue('compiled background music prompt');

    await compileWorkflowNodePrompt({
      nodeData: {
        workflowCatalog: {
          skillId: 'short-drama-quick',
          confirmedInputs: ['n_script'],
          recipeId: 'drama-background-music',
          promptStrategy: 'ambient_bgm',
          inputStrategy: 'script_to_bgm',
          promptBuilder: 'episode_bgm',
        },
      },
      nodeKind: 'audio',
      nodePrompt: 'Cool-grey ocean wave ambient score',
      upstreamText: '',
      fallbackPrompt: 'Episode 1 script\n\nCool-grey ocean wave ambient score',
    });

    expect(compileMock).toHaveBeenCalledWith({
      recipeId: 'drama-background-music',
      recipeVersion: '',
      skillId: 'short-drama-quick',
      skillVersion: '',
      confirmedInputs: {},
      nodeKind: 'audio',
      promptStrategy: 'llm_refine',
      nodePrompt: 'Cool-grey ocean wave ambient score',
      upstreamText: '',
      userGoal: '',
      referenceMedia: undefined,
    });
  });

  it('reports Recipe compilation and task submission phases', async () => {
    compileMock.mockResolvedValue('compiled prompt');
    const phases: string[] = [];
    const listener = (event: Event) => {
      phases.push(
        (event as CustomEvent<WorkflowExecutionActivityDetail>).detail.phase,
      );
    };
    window.addEventListener(WORKFLOW_EXECUTION_ACTIVITY_EVENT, listener);

    try {
      await compileWorkflowNodePrompt({
        nodeId: 'image-1',
        nodeData: { workflowCatalog: { recipeId: 'product-image' } },
        nodeKind: 'image',
        nodePrompt: 'Product image',
        fallbackPrompt: 'fallback',
      });
    } finally {
      window.removeEventListener(WORKFLOW_EXECUTION_ACTIVITY_EVENT, listener);
    }

    expect(phases).toEqual(['compiling_recipe', 'submitting']);
  });

  it('binds workflow Recipe compilation to its admitted product operation', async () => {
    compileMock.mockResolvedValue('compiled prompt');
    bindWorkflowProductOperation('image-billed', {
      projectId: 'project-a',
      operationId: 'agent_product_a',
    });

    try {
      await compileWorkflowNodePrompt({
        nodeId: 'image-billed',
        nodeData: { workflowCatalog: { recipeId: 'product-image' } },
        nodeKind: 'image',
        nodePrompt: 'Product image',
        fallbackPrompt: 'fallback',
      });
    } finally {
      clearWorkflowProductOperation('image-billed');
    }

    expect(compileMock).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'project-a',
      productOperationId: 'agent_product_a',
    }));
  });

  it('keeps explicitly connected HTML text even when Recipe selects user assets', async () => {
    generateTextMock.mockResolvedValue('<html></html>');
    await generateWorkflowText({nodeData: {workflowCatalog: {recipeId: 'page', inputStrategy: {type: 'user_assets'}}}, nodePrompt: 'Build', upstreamText: 'Manually connected copy', upstreamInputMode: 'connected'});
    expect(generateTextMock).toHaveBeenCalledWith(expect.objectContaining({upstreamText: 'Manually connected copy'}));
  });

  it('executes a catalog-backed text node', async () => {
    generateTextMock.mockResolvedValue('# E-commerce plan');

    const result = await generateWorkflowText({
      nodeData: {
        workflowCatalog: {
          recipeId: 'ecommerce-text-plan',
          recipeVersion: 1,
          userGoal: 'Generate a three-screen detail page',
        },
      },
      nodePrompt: 'Coffee machine selling points',
      upstreamText: 'Silver metal body',
    });

    expect(result).toBe('# E-commerce plan');
    expect(generateTextMock).toHaveBeenCalledWith({
      recipeId: 'ecommerce-text-plan',
      recipeVersion: '1',
      nodePrompt: 'Coffee machine selling points',
      upstreamText: 'Silver metal body',
      userGoal: 'Generate a three-screen detail page',
    });
  });

  it('passes an ordered supplemental Recipe pipeline to the compiler', async () => {
    compileMock.mockResolvedValue('combined prompt');

    await compileWorkflowNodePrompt({
      nodeData: {
        workflowCatalog: {
          recipeId: 'shotlist',
          recipePipeline: [
            { id: 'cinematic-lighting', version: 2 },
            'identity-continuity',
          ],
        },
      },
      nodeKind: 'image',
      nodePrompt: 'The protagonist on a rainy night street',
      fallbackPrompt: 'fallback',
    });

    expect(compileMock).toHaveBeenCalledWith(expect.objectContaining({
      recipeId: 'shotlist',
      recipePipeline: [
        { id: 'cinematic-lighting', version: '2' },
        { id: 'identity-continuity' },
      ],
    }));
  });

  it('selects only upstream text declared by inputStrategy', () => {
    const result = selectWorkflowUpstreamText(
      {
        workflowCatalog: {
          inputStrategy: { type: 'previous_step', step_id: 'brief' },
        },
      },
      [
        {
          nodeId: 'outline-node',
          nodeType: CANVAS_NODE_TYPES.textAnnotation,
          workflowStepId: 'outline',
          text: 'Creative outline',
        },
        {
          nodeId: 'brief-node',
          nodeType: CANVAS_NODE_TYPES.textAnnotation,
          workflowStepId: 'brief',
          text: 'Ad script',
        },
      ],
      'Creative outline\n\nAd script',
    );

    expect(result).toBe('Ad script');
  });

  it('suppresses text context for user-assets-only strategies', () => {
    expect(selectWorkflowUpstreamText(
      { workflowCatalog: { inputStrategy: { type: 'user_assets' } } },
      undefined,
      'Should not be passed to the model',
    )).toBe('');
  });
});

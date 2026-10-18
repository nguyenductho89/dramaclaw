// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import type { CanvasNode, NodeToolType } from '../domain/canvasNodes';
import type { ToolProcessorResult } from '../application/ports';

export type ToolOptionPrimitive = string | number | boolean;
export type ToolOptions = Record<string, ToolOptionPrimitive>;

interface ToolFieldBase {
  key: string;
  /** The entry key of the display name - only the key is left in the tool schema, and the text follows the UI language. */
  labelKey: string;
}

export interface ToolTextField extends ToolFieldBase {
  type: 'text';
  placeholder?: string;
}

export interface ToolNumberField extends ToolFieldBase {
  type: 'number';
  min?: number;
  max?: number;
  step?: number;
}

export interface ToolSelectField extends ToolFieldBase {
  type: 'select';
  options: Array<{
    value: string;
    /** Entry key. Mutually exclusive with `label`; when both are present it takes precedence. */
    labelKey?: string;
    /** Language-independent literals such as "16:9" are displayed as is. */
    label?: string;
  }>;
}

export interface ToolColorField extends ToolFieldBase {
  type: 'color';
}

export type ToolFieldSchema =
  | ToolTextField
  | ToolNumberField
  | ToolSelectField
  | ToolColorField;

export interface ToolExecutionContext {
  processTool: (
    toolType: NodeToolType,
    sourceImageUrl: string,
    options: Record<string, unknown>
  ) => Promise<ToolProcessorResult>;
}

export type ToolIconKey = 'crop' | 'annotate' | 'split';
export type ToolEditorKind = 'form' | 'crop' | 'annotate' | 'split';

export interface CanvasToolPlugin {
  type: NodeToolType;
  labelKey: string;
  icon: ToolIconKey;
  editor: ToolEditorKind;
  supportsNode: (node: CanvasNode) => boolean;
  createInitialOptions: (node: CanvasNode) => ToolOptions;
  fields: ToolFieldSchema[];
  execute: (
    sourceImageUrl: string,
    options: ToolOptions,
    context: ToolExecutionContext
  ) => Promise<ToolProcessorResult>;
}

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * Modules outside React (pure functions, capability tables, derivation logic) need `t` passed in as a parameter.
 * Only the call shape is constrained here and no concrete react-i18next types are depended on, so tests can pass in a fake directly.
 */
export type TFn = (key: string, options?: Record<string, unknown>) => string;

// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

/**
 * Product quotas. The backend currently has no cap on either (canvas saves use PUT and do not count; grants do not
 * count people either), so this is the only checkpoint - it guards against mistakes, not malicious calls. To make it a
 * security boundary, add a server-side check in both `put_canvas` and the grants endpoint.
 */

/** Maximum number of canvases one user can create in a project (only blank canvases the user created manually count). */
export const MAX_USER_CREATED_CANVASES_PER_PROJECT = 25;

/** Maximum number of people a project can be shared with (excluding the owner). */
export const MAX_PROJECT_GRANTS = 25;

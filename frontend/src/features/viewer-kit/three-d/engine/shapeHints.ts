// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
// Reproduces DIRECTOR_SHAPE_HINTS of the old PlayCanvas 3GS director stage:
// gives a prop / staging a coarse "shape semantics" label that decides the default scale, affordances and
// attachment points (attachment_points). An attachment point uses a 3D offset (relative to the prop entity's local frame,
// already applied with prop scale + yaw), and an actor landing on this point takes facing_delta to decide its facing.
//
// Important: image-freezone has no real prop assets yet; shape_hint generates a built-in low-poly
// blocking silhouette in code. default_scale is the suggested bounding-box size for new/AI staging, and at runtime
// the user can still keep scaling.

export type AttachKind = 'mount' | 'seat' | 'operate' | 'hold';
export type ActorState = 'standing' | 'sitting' | 'mounted' | 'operating' | 'lying';

export interface AttachmentPoint {
  id: string;
  kind: AttachKind;
  /** Prop-local coordinate offset (meters). x: left/right, y: up/down, z: front/back; rotated by prop yaw at runtime. */
  offset: [number, number, number];
  actor_state: ActorState;
  /** Actor yaw at the attachment point (radians relative to the prop yaw). Riding a horse = pi (actor faces the prop front). */
  facing_delta?: number;
}

export interface ShapeHintSpec {
  default_scale: [number, number, number];
  default_affordances: string[];
  default_attachment_points: AttachmentPoint[];
}

export interface ShapeHintProxyPart {
  name: string;
  type: 'box';
  /** Local offset inside the marker bounding box; root center is [0, 0, 0]. */
  offset: [number, number, number];
  /** Local scale as a fraction of the marker bounding box. */
  scale: [number, number, number];
}

export const SHAPE_HINTS = {
  box: {
    default_scale: [1, 1, 1],
    default_affordances: ['blocking_mass'],
    default_attachment_points: [],
  },
  generic_large: {
    default_scale: [2, 1.6, 1.2],
    default_affordances: ['blocking_mass'],
    default_attachment_points: [],
  },
  pile: {
    default_scale: [1.2, 1, 1.2],
    default_affordances: ['blocking_mass'],
    default_attachment_points: [],
  },
  quadruped_mount: {
    default_scale: [1.4, 1.25, 2.2],
    default_affordances: ['mountable', 'blocking_mass'],
    default_attachment_points: [
      { id: 'saddle', kind: 'mount', offset: [0, 1.15, 0], actor_state: 'mounted', facing_delta: 0 },
    ],
  },
  wheeled_artillery: {
    default_scale: [1.4, 1.0, 2.4],
    default_affordances: ['operable', 'aimable', 'blocking_mass'],
    default_attachment_points: [
      { id: 'operator', kind: 'operate', offset: [-1.2, 0, -0.8], actor_state: 'operating' },
    ],
  },
  long_vehicle: {
    default_scale: [1.2, 1.4, 3.6],
    default_affordances: ['seatable', 'blocking_mass'],
    default_attachment_points: [
      { id: 'passenger_front', kind: 'seat', offset: [0, 0.7, 0.8], actor_state: 'sitting' },
      { id: 'passenger_back', kind: 'seat', offset: [0, 0.7, -0.8], actor_state: 'sitting' },
    ],
  },
  sports_car: {
    default_scale: [1.65, 0.65, 3.2],
    default_affordances: ['seatable', 'blocking_mass'],
    default_attachment_points: [],
  },
  flying_craft: {
    default_scale: [3, 1, 4],
    default_affordances: ['seatable', 'blocking_mass'],
    default_attachment_points: [
      { id: 'passenger', kind: 'seat', offset: [0, 1, 0], actor_state: 'sitting' },
    ],
  },
} as const satisfies Record<string, ShapeHintSpec>;

export type ShapeHintName = keyof typeof SHAPE_HINTS;

export const SHAPE_HINT_NAMES: ShapeHintName[] = Object.keys(SHAPE_HINTS) as ShapeHintName[];

export function getShapeHint(name: ShapeHintName): ShapeHintSpec {
  return SHAPE_HINTS[name];
}

const SHAPE_HINT_PROXY_PARTS: Record<ShapeHintName, ShapeHintProxyPart[]> = {
  box: [
    { name: 'body', type: 'box', offset: [0, 0, 0], scale: [1, 1, 1] },
  ],
  generic_large: [
    { name: 'body', type: 'box', offset: [0, 0, 0], scale: [1, 1, 1] },
  ],
  pile: [
    { name: 'base_left', type: 'box', offset: [-0.22, -0.16, 0.08], scale: [0.55, 0.68, 0.72] },
    { name: 'base_right', type: 'box', offset: [0.24, -0.22, -0.12], scale: [0.5, 0.56, 0.6] },
    { name: 'top', type: 'box', offset: [0.03, 0.26, 0.02], scale: [0.46, 0.48, 0.5] },
  ],
  quadruped_mount: [
    { name: 'body', type: 'box', offset: [0, 0.08, 0], scale: [0.58, 0.42, 0.78] },
    { name: 'neck', type: 'box', offset: [0, 0.24, -0.34], scale: [0.22, 0.36, 0.16] },
    { name: 'head', type: 'box', offset: [0, 0.36, -0.46], scale: [0.28, 0.2, 0.2] },
    { name: 'leg_front_left', type: 'box', offset: [-0.19, -0.32, -0.24], scale: [0.13, 0.56, 0.12] },
    { name: 'leg_front_right', type: 'box', offset: [0.19, -0.32, -0.24], scale: [0.13, 0.56, 0.12] },
    { name: 'leg_back_left', type: 'box', offset: [-0.19, -0.32, 0.25], scale: [0.13, 0.56, 0.12] },
    { name: 'leg_back_right', type: 'box', offset: [0.19, -0.32, 0.25], scale: [0.13, 0.56, 0.12] },
  ],
  wheeled_artillery: [
    { name: 'carriage', type: 'box', offset: [0, -0.05, 0.08], scale: [0.55, 0.34, 0.58] },
    { name: 'barrel', type: 'box', offset: [0, 0.14, -0.22], scale: [0.16, 0.16, 0.9] },
    { name: 'wheel_left', type: 'box', offset: [-0.34, -0.27, 0.12], scale: [0.16, 0.42, 0.42] },
    { name: 'wheel_right', type: 'box', offset: [0.34, -0.27, 0.12], scale: [0.16, 0.42, 0.42] },
    { name: 'trail', type: 'box', offset: [0, -0.18, 0.42], scale: [0.2, 0.12, 0.52] },
  ],
  long_vehicle: [
    { name: 'body', type: 'box', offset: [0, -0.04, 0], scale: [0.76, 0.52, 1] },
    { name: 'front', type: 'box', offset: [0, 0.02, -0.38], scale: [0.58, 0.42, 0.24] },
    { name: 'rear', type: 'box', offset: [0, 0.02, 0.38], scale: [0.58, 0.42, 0.24] },
  ],
  sports_car: [
    { name: 'body', type: 'box', offset: [0, -0.12, 0], scale: [0.86, 0.36, 0.84] },
    { name: 'cabin', type: 'box', offset: [0, 0.15, -0.04], scale: [0.48, 0.3, 0.34] },
    { name: 'hood', type: 'box', offset: [0, 0.02, -0.33], scale: [0.7, 0.2, 0.3] },
    { name: 'wheel_front_left', type: 'box', offset: [-0.42, -0.3, -0.28], scale: [0.12, 0.26, 0.18] },
    { name: 'wheel_front_right', type: 'box', offset: [0.42, -0.3, -0.28], scale: [0.12, 0.26, 0.18] },
    { name: 'wheel_back_left', type: 'box', offset: [-0.42, -0.3, 0.28], scale: [0.12, 0.26, 0.18] },
    { name: 'wheel_back_right', type: 'box', offset: [0.42, -0.3, 0.28], scale: [0.12, 0.26, 0.18] },
  ],
  flying_craft: [
    { name: 'body', type: 'box', offset: [0, 0, 0], scale: [0.2, 0.28, 0.94] },
    { name: 'wing_left', type: 'box', offset: [-0.32, -0.02, 0.02], scale: [0.62, 0.08, 0.34] },
    { name: 'wing_right', type: 'box', offset: [0.32, -0.02, 0.02], scale: [0.62, 0.08, 0.34] },
    { name: 'tail', type: 'box', offset: [0, 0.16, 0.4], scale: [0.42, 0.24, 0.14] },
  ],
};

export function proxyPartsForHint(hint: ShapeHintName): ShapeHintProxyPart[] {
  return SHAPE_HINT_PROXY_PARTS[hint];
}

export function proxyLocalBottomForHint(hint: ShapeHintName): number {
  return Math.min(
    ...proxyPartsForHint(hint).map((part) => part.offset[1] - part.scale[1] / 2),
  );
}

// Per-axis [min, max] scale limits (for manual editing, looser than at import time). Reproduces BuilderGPT's
// QUADRUPED_MOUNT_MANUAL_SCALE_LIMITS / GENERIC_PROP_SCALE_LIMITS.
const GENERIC_SCALE_LIMITS: [number, number][] = [
  [0.08, 12],
  [0.08, 12],
  [0.08, 12],
];

const SHAPE_SPECIFIC_SCALE_LIMITS: Partial<Record<ShapeHintName, [number, number][]>> = {
  quadruped_mount: [
    [0.35, 3.2],
    [0.35, 3.0],
    [0.55, 5.0],
  ],
};

export function scaleLimitsForHint(hint: ShapeHintName): [number, number][] {
  return SHAPE_SPECIFIC_SCALE_LIMITS[hint] ?? GENERIC_SCALE_LIMITS;
}

export function clampScaleToHint(
  hint: ShapeHintName,
  scale: [number, number, number],
): [number, number, number] {
  const limits = scaleLimitsForHint(hint);
  return [
    Math.min(limits[0][1], Math.max(limits[0][0], scale[0])),
    Math.min(limits[1][1], Math.max(limits[1][0], scale[1])),
    Math.min(limits[2][1], Math.max(limits[2][0], scale[2])),
  ];
}

// Pick the selected attachment point: no id specified -> the first; specified but not found -> null (meaning this prop cannot be mounted).
export function resolveAttachmentPoint(
  hint: ShapeHintName,
  attachPointId: string | undefined,
): AttachmentPoint | null {
  const points = SHAPE_HINTS[hint].default_attachment_points;
  if (points.length === 0) return null;
  if (!attachPointId) return points[0];
  return points.find((p) => p.id === attachPointId) ?? null;
}

// Rotate the prop-local offset into a world vector by the prop yaw; the y axis is not rotated.
export function rotatedOffsetY(offset: [number, number, number], yawRad: number): [number, number, number] {
  const cos = Math.cos(yawRad);
  const sin = Math.sin(yawRad);
  const [x, y, z] = offset;
  return [x * cos + z * sin, y, -x * sin + z * cos];
}

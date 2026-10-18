// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import * as pc from 'playcanvas';

import { createFlyCameraController, type FlyCameraController } from './flyCamera';
import { createAxesGridDrawer, type AxesGridDrawer } from './axesGrid';
import { nextPose, POSES, requirePoseName, type PoseName } from './poses';
import {
  clampScaleToHint,
  proxyLocalBottomForHint,
  proxyPartsForHint,
  resolveAttachmentPoint,
  rotatedOffsetY,
  SHAPE_HINTS,
  type ActorState,
  type AttachmentPoint,
  type ShapeHintName,
} from './shapeHints';
import type { DirectorPlacement, DirectorStageOrientationMode } from '../directorManifest';
import {
  DEFAULT_DIRECTOR_WORLD_SOURCE_TRANSFORM,
  buildSogPivotTransform,
  constrainSourceTransformForType,
  normalizeDirectorWorldSourceTransform,
  type DirectorWorldSourceTransform,
} from '../sourceTransform';

export type { PoseName } from './poses';
export { isPoseName, POSES, POSE_LABEL_KEYS, requirePoseName } from './poses';
export { SHAPE_HINT_NAMES, type ShapeHintName } from './shapeHints';

/**
 * The engine does not depend on react-i18next: status copy is turned into keys only here, and the caller passes t in to resolve them.
 * When not passed the key is echoed as-is - unit tests and call sites outside React still work.
 */
export type ViewerStatusTranslate = (
  key: string,
  params?: Record<string, string | number>,
) => string;

export interface ViewerAppOptions {
  canvas: HTMLCanvasElement;
  fov?: number;
  translate?: ViewerStatusTranslate;
}

export interface CaptureScreenshotOptions {
  markers?: boolean;
  renderMode?: 'combined' | 'env_only' | 'actor_overlay_black' | 'actor_mask';
  frameAspect?: CaptureFrameAspect;
  framePaddingCssPx?: number;
  frameRectCss?: FrameCaptureCssRect;
  maxLongEdge?: number;
}

export type CaptureFrameAspect = '16:9' | '2:3' | '9:16' | '1:1' | '4:3';

export interface FrameCaptureCssRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FrameCaptureRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

function captureAspectRatio(aspect: CaptureFrameAspect): number {
  switch (aspect) {
    case '16:9':
      return 16 / 9;
    case '2:3':
      return 2 / 3;
    case '9:16':
      return 9 / 16;
    case '1:1':
      return 1;
    case '4:3':
      return 4 / 3;
  }
}

export function calculateFrameCaptureRect(input: {
  canvasWidth: number;
  canvasHeight: number;
  clientWidth?: number;
  clientHeight?: number;
  canvasRectCss?: FrameCaptureCssRect;
  frameRectCss?: FrameCaptureCssRect;
  frameAspect?: CaptureFrameAspect;
  paddingCssPx?: number;
}): FrameCaptureRect {
  const canvasWidth = Math.max(1, Math.floor(input.canvasWidth));
  const canvasHeight = Math.max(1, Math.floor(input.canvasHeight));
  const clientWidth = input.clientWidth && input.clientWidth > 0 ? input.clientWidth : canvasWidth;
  const clientHeight = input.clientHeight && input.clientHeight > 0 ? input.clientHeight : canvasHeight;
  const scaleX = canvasWidth / clientWidth;
  const scaleY = canvasHeight / clientHeight;
  if (
    input.frameRectCss &&
    input.canvasRectCss &&
    input.frameRectCss.width > 0 &&
    input.frameRectCss.height > 0
  ) {
    const sx = Math.round((input.frameRectCss.left - input.canvasRectCss.left) * scaleX);
    const sy = Math.round((input.frameRectCss.top - input.canvasRectCss.top) * scaleY);
    const sw = Math.round(input.frameRectCss.width * scaleX);
    const sh = Math.round(input.frameRectCss.height * scaleY);
    const clampedSx = Math.min(Math.max(0, sx), canvasWidth - 1);
    const clampedSy = Math.min(Math.max(0, sy), canvasHeight - 1);
    return {
      sx: clampedSx,
      sy: clampedSy,
      sw: Math.max(1, Math.min(canvasWidth - clampedSx, sw)),
      sh: Math.max(1, Math.min(canvasHeight - clampedSy, sh)),
    };
  }
  if (!input.frameAspect) {
    return { sx: 0, sy: 0, sw: canvasWidth, sh: canvasHeight };
  }
  const padding = Math.max(0, input.paddingCssPx ?? 16);
  const availableWidth = Math.max(1, canvasWidth - padding * 2 * scaleX);
  const availableHeight = Math.max(1, canvasHeight - padding * 2 * scaleY);
  const ratio = captureAspectRatio(input.frameAspect);
  let sw = availableWidth;
  let sh = sw / ratio;
  if (sh > availableHeight) {
    sh = availableHeight;
    sw = sh * ratio;
  }
  const roundedWidth = Math.max(1, Math.round(sw));
  const roundedHeight = Math.max(1, Math.round(sh));
  return {
    sx: Math.max(0, Math.round((canvasWidth - roundedWidth) / 2)),
    sy: Math.max(0, Math.round((canvasHeight - roundedHeight) / 2)),
    sw: roundedWidth,
    sh: roundedHeight,
  };
}

export function shouldHideEditorOverlaysForCapture(
  renderMode: CaptureScreenshotOptions['renderMode'],
): boolean {
  void renderMode;
  return true;
}

export function distanceSqPointToRay(
  origin: [number, number, number],
  direction: [number, number, number],
  point: [number, number, number],
): { along: number; distanceSq: number } {
  const dx = direction[0];
  const dy = direction[1];
  const dz = direction[2];
  const lengthSq = dx * dx + dy * dy + dz * dz;
  if (lengthSq <= 1e-8) return { along: 0, distanceSq: Infinity };
  const vx = point[0] - origin[0];
  const vy = point[1] - origin[1];
  const vz = point[2] - origin[2];
  const along = (vx * dx + vy * dy + vz * dz) / lengthSq;
  const cx = origin[0] + dx * along;
  const cy = origin[1] + dy * along;
  const cz = origin[2] + dz * along;
  const px = point[0] - cx;
  const py = point[1] - cy;
  const pz = point[2] - cz;
  return { along, distanceSq: px * px + py * py + pz * pz };
}

export interface LoadSplatOptions {
  orientationMode?: DirectorStageOrientationMode;
  sourceTransform?: Partial<DirectorWorldSourceTransform> | null;
}

export interface LoadPanoOptions {
  sourceTransform?: Partial<DirectorWorldSourceTransform> | null;
}

// Textureless, self-contained Quaternius mannequin (mesh + 45 anim clips, 0 external textures).
// Identity is conveyed by color tint, not skin/hair — so we deliberately avoid the textured
// Base Characters (.gltf + external PNGs) which need a texture handler this viewer doesn't register.
// Mesh and its own animations come from one file, so pose clips bind to the skeleton with no retarget.
const ACTOR_PROXY_MODEL_URL = '/viewer-kit/quaternius/ual2/UAL2_Standard.glb';
// Extra locomotion clips (idle/walk/sprint/sitting/driving) that UAL2 lacks. Same rig as UAL2,
// so tracks bind to the proxy skeleton. UAL2's own clips are pulled from the proxy container itself.
const ACTOR_ANIMATION_LIBRARY_URLS = ['/viewer-kit/quaternius/ual1/UAL1_Standard.glb'] as const;
const STAGE_GROUND_Y = 0;

export type MarkerKind = 'actor' | 'prop' | 'staging';

export interface PlaceMarkerOptions {
  color?: string;
  scale?: number | [number, number, number];
  label?: string;
  shapeHint?: ShapeHintName;
  position?: [number, number, number];
}

export interface CrosshairTarget {
  kind: MarkerKind | 'surface' | 'empty';
  index?: number;
  name?: string;
  type?: string;
  position: [number, number, number] | null;
  source?: string;
}

export interface MarkerCounts {
  actor: number;
  prop: number;
  staging: number;
}

export interface SelectionState {
  kind: MarkerKind;
  index: number;          // zero-based index within markers[kind]
  label: string;
  position: [number, number, number];
  pose: PoseName | null;  // only meaningful for actors; always null for prop / staging
  actionPlaying: boolean | null; // only meaningful for actors; controls whether the current pose action loops
  mounted: boolean;       // whether the actor is mounted on a prop / staging; always false for non-actors
  // shape hint of prop / staging; always null for actors.
  shapeHint: ShapeHintName | null;
}

// Serializable snapshot of a single marker; written into ThreeDWorldNodeData.scene.
export interface ThreeDMarkerSnapshot {
  label: string;
  color: string;                                  // hex like #ff3344
  placement?: DirectorPlacement;                  // preferred placement; legacy fields below remain for old saves
  position: [number, number, number];
  yawDeg: number;                                 // entity.eulerAngles.y
  scale: [number, number, number];                // localScale
  pose?: PoseName;                                // actor only
  actionPlaying?: boolean;                        // actor only; default true
  /** Whether the actor is mounted on a prop/staging; references the target within the same snapshot by kind+index. */
  mount?: { kind: 'prop' | 'staging'; index: number; attachPointId: string };
  shapeHint?: ShapeHintName;                      // prop / staging only
}

export interface ThreeDSceneSnapshot {
  schemaVersion: 1;
  savedAt: number;                                // unix ms
  actors: ThreeDMarkerSnapshot[];
  props: ThreeDMarkerSnapshot[];
  stagings: ThreeDMarkerSnapshot[];
  world?: {
    splatYOffset?: number;
    activeSourceId?: string;
    sourceTransform?: DirectorWorldSourceTransform;
  };
  camera?: { azim: number; elev: number; distance: number; focalPoint: [number, number, number] };
}

export interface SelectionScreenPosition {
  x: number;              // CSS px relative to canvas
  y: number;
  visible: boolean;       // false when selected item is behind camera or off-screen
}

/**
 * 3D world (.ply / .sog) loading progress. `.sog` is decoded by PlayCanvas's built-in SogBundleParser,
 * `.ply` goes through PlyParser - GSplatHandler picks automatically by suffix, so the frontend needs no extra decoder.
 */
export interface SplatLoadProgress {
  phase: 'loading' | 'ready' | 'error';
  /** 0-100; null when the total size is unknown (the backend gave no Content-Length), and the UI degrades to indeterminate progress. */
  percent: number | null;
  loadedBytes: number;
  totalBytes: number | null;
  /** Gaussian point count after decoding; null if unknown. */
  gaussians: number | null;
  /** User-friendly message when phase==='error'. */
  message: string | null;
}

/**
 * Classify the underlying loader's raw error into a user-readable copy key (technical details are still kept in console / Error).
 * Typical case: the URL points to a backend local path / expired -> a 404 HTML is fetched -> SogBundleParser unzips it as a zip ->
 * "EOCDR not found".
 */
export function splatErrorMessageKey(raw: string): string {
  const lower = raw.toLowerCase();
  if (
    lower.includes('eocdr') ||
    lower.includes('zip') ||
    lower.includes('central directory')
  ) {
    return 'viewer.threeD.statusMessages.engine.splatCorrupt';
  }
  if (
    lower.includes('404') ||
    lower.includes('not found') ||
    lower.includes('failed to fetch') ||
    lower.includes('network') ||
    lower.includes('403')
  ) {
    return 'viewer.threeD.statusMessages.engine.splatUnreachable';
  }
  if (lower.includes('decode') || lower.includes('parse') || lower.includes('invalid')) {
    return 'viewer.threeD.statusMessages.engine.splatDecode';
  }
  return 'viewer.threeD.statusMessages.engine.splatGeneric';
}

export interface ViewerApp {
  readonly app: pc.AppBase;
  readonly camera: pc.Entity;
  readonly fly: FlyCameraController;
  readonly axesGrid: AxesGridDrawer;
  loadSplat: (url: string, options?: LoadSplatOptions) => Promise<void>;
  // A pure 360 panorama serves as the director world's in-sphere environment map; the same 3D stage is still used to place actor/prop/staging.
  loadPano: (url: string | null, options?: LoadPanoOptions) => Promise<void>;
  clearWorldSource: () => void;
  // Optional collision.glb: used as the physical surface for crosshair projection / grounding; without it the y=0 plane is used.
  loadCollision: (url: string | null) => Promise<void>;
  hasCollision: () => boolean;
  setCollisionVisible: (visible: boolean) => void;
  // Debug hit marker: a small pink sphere, shown at the hit point whenever a raycast hits the ground / collision once enabled.
  // Off by default; BuilderGPT controls it via the ?show_hit_marker=1 URL parameter, here it is an explicit API.
  setHitMarkerEnabled: (enabled: boolean) => void;
  isHitMarkerEnabled: () => boolean;
  resetCamera: () => void;
  setStatus: (next: string) => void;
  onStatus: (listener: (status: string) => void) => () => void;
  /** Subscribe to 3D world loading progress (percentage / loaded bytes / Gaussian point count / friendly error). */
  onSplatProgress: (listener: (progress: SplatLoadProgress) => void) => () => void;
  placeMarker: (kind: MarkerKind, options?: PlaceMarkerOptions) => boolean;
  deleteLastMarker: (kind: MarkerKind) => boolean;
  clearMarkers: (kind?: MarkerKind) => void;
  getMarkerCounts: () => MarkerCounts;
  onMarkersChange: (listener: (counts: MarkerCounts) => void) => () => void;
  captureScreenshot: (options?: CaptureScreenshotOptions) => string | null;
  // Selection: ray / crosshair picking, providing event subscription and screen projection for the current selection
  selectAtScreen: (clientX: number, clientY: number) => boolean;
  selectAtCrosshair: () => boolean;
  getCrosshairTarget: () => CrosshairTarget;
  clearSelection: () => void;
  getSelection: () => SelectionState | null;
  onSelectionChange: (listener: (selection: SelectionState | null) => void) => () => void;
  getSelectionScreenPosition: () => SelectionScreenPosition | null;
  // Selection operations: cycle / index select / move / ground / rotate / scale / delete.
  // All mutating methods return a boolean saying whether a change really happened (false when nothing is selected or the list is empty).
  getMarkerLabels: (kind: MarkerKind) => string[];
  selectByIndex: (kind: MarkerKind, index: number) => boolean;
  // Pose: actor only; setSelectedPose / cycleSelectedPose both return whether they took effect.
  getActorPose: (index: number) => PoseName | null;
  setSelectedPose: (pose: PoseName) => boolean;
  cycleSelectedPose: (dir?: 1 | -1) => boolean;
  isSelectedActionPlaying: () => boolean | null;
  setSelectedActionPlaying: (playing: boolean) => boolean;
  mountSelectedAtCrosshair: () => boolean;
  unmountSelected: () => boolean;
  isSelectedMounted: () => boolean;
  setSelectedLabel: (label: string) => boolean;
  cycleSelection: (kind: MarkerKind, dir?: 1 | -1) => boolean;
  moveSelectedToCrosshair: () => boolean;
  groundSelected: () => boolean;
  rotateSelected: (deg: number) => boolean;
  scaleSelected: (factor: number) => boolean;
  // Translate the selection as a whole along world coordinates by (dx, dy, dz) (meters).
  nudgeSelected: (dx: number, dy: number, dz: number) => boolean;
  // Smoothly interpolate the camera to look at the current selection (keeping the original azim/elev/distance). Returns false if nothing is selected.
  lookAtSelected: (durationMs?: number) => boolean;
  // PlayCanvas TranslateGizmo toggle; on by default. When turned off the gizmo detaches and hides immediately.
  setTranslateGizmoEnabled: (enabled: boolean) => void;
  isTranslateGizmoEnabled: () => boolean;
  // Manual height offset of the 3GS/SOG world relative to the director floor. actor/prop/staging coordinates are unchanged.
  nudgeWorldYOffset: (delta: number) => boolean;
  resetWorldYOffset: () => boolean;
  getWorldYOffset: () => number;
  getSourceTransform: () => DirectorWorldSourceTransform;
  setSourceTransform: (transform: Partial<DirectorWorldSourceTransform>) => boolean;
  resetSourceTransform: () => boolean;
  // Scene persistence: export a serializable snapshot of the current actor/prop/staging + camera; calling loadSceneSnapshot
  // applies the snapshot back to the current viewer (clear markers first, then rebuild in order and restore pose / camera).
  exportSceneSnapshot: () => ThreeDSceneSnapshot;
  loadSceneSnapshot: (snap: ThreeDSceneSnapshot) => void;
  // Shape hint: the runtime marker blocking proxy. The UI only exposes it for staging; prop keeps the default box.
  // setSelectedShapeHint returns whether it took effect (false when the selection is not a staging).
  getMarkerShapeHint: (kind: 'prop' | 'staging', index: number) => ShapeHintName | null;
  setSelectedShapeHint: (hint: ShapeHintName) => boolean;
  // Camera presets: reproduces the old PlayCanvas 3GS director stage.
  // fitView: fit the whole splat into the frame (target = scene center, offset on the same order as sceneRadius).
  // cameraBehindSelected: place the camera 1.6m behind the selected object and 0.45m higher, taking the back direction from the entity yaw.
  // cameraFaceSelected : place the camera 1.8m in front of the selected object and 0.45m higher, usable for an over-shoulder reverse shot.
  // With no selection, behind / face degrade to fitView.
  fitView: () => boolean;
  cameraBehindSelected: () => boolean;
  cameraFaceSelected: () => boolean;
  deleteSelected: () => boolean;
  destroy: () => void;
}

const DEFAULT_FOV = 96;
const INITIAL_AZIM = -45;
const INITIAL_ELEV = -10;
const INITIAL_ZOOM = 1;
const MAX_VIEWER_DPR = 1.5;

export function resolveViewerDevicePixelRatio(rawDpr: number | null | undefined): number {
  if (typeof rawDpr !== 'number' || !Number.isFinite(rawDpr) || rawDpr <= 0) {
    return 1;
  }
  return Math.min(rawDpr, MAX_VIEWER_DPR);
}

export function resolveSnapshotWorldTransform(snap: ThreeDMarkerSnapshot): {
  position: [number, number, number];
  yawDeg: number;
} | null {
  if (!snap.placement) {
    return {
      position: snap.position,
      yawDeg: snap.yawDeg,
    };
  }
  if (snap.placement.space === 'world') {
    return {
      position: snap.placement.position,
      yawDeg: snap.placement.yawDeg,
    };
  }
  return null;
}

export interface ActorAnimationPoseLayer {
  play: (name: string) => void;
  pause: () => void;
  activeStateCurrentTime: number;
}

export interface ActorAnimationPoseSampler {
  baseLayer?: ActorAnimationPoseLayer | null;
  playing: boolean;
}

export function sampleActorAnimationPoseFrame(
  anim: ActorAnimationPoseSampler,
  clipName: string,
  sampleTime: number,
  playing: boolean,
): void {
  const layer = anim.baseLayer;
  if (!layer) return;
  layer.play(clipName);
  if (!playing) layer.pause();
  layer.activeStateCurrentTime = sampleTime;
  anim.playing = playing;
}

export async function createViewerApp(options: ViewerAppOptions): Promise<ViewerApp> {
  const { canvas, fov = DEFAULT_FOV } = options;
  const tr: ViewerStatusTranslate = options.translate ?? ((key) => key);
  let statusText = '';
  const statusListeners = new Set<(status: string) => void>();
  const setStatus = (next: string) => {
    statusText = next;
    for (const listener of statusListeners) listener(statusText);
  };

  const splatProgressListeners = new Set<(p: SplatLoadProgress) => void>();
  let lastSplatProgress: SplatLoadProgress | null = null;
  const emitSplatProgress = (p: SplatLoadProgress) => {
    lastSplatProgress = p;
    for (const listener of splatProgressListeners) listener(p);
  };

  const app = new pc.Application(canvas, {
    mouse: new pc.Mouse(canvas),
    keyboard: new pc.Keyboard(window),
    graphicsDeviceOptions: {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    },
  });
  app.setCanvasFillMode(pc.FILLMODE_NONE);
  app.setCanvasResolution(pc.RESOLUTION_AUTO);
  app.scene.exposure = 1.0;

  // Follow the container size automatically with a ResizeObserver.
  const resize = () => {
    const rect = canvas.parentElement?.getBoundingClientRect();
    if (!rect) return;
    const dpr = resolveViewerDevicePixelRatio(window.devicePixelRatio);
    app.graphicsDevice.maxPixelRatio = dpr;
    app.resizeCanvas(rect.width, rect.height);
  };
  resize();
  const resizeObserver = new ResizeObserver(resize);
  if (canvas.parentElement) resizeObserver.observe(canvas.parentElement);

  const camera = new pc.Entity('viewer_camera');
  camera.addComponent('camera', {
    clearColor: new pc.Color(0, 0, 0),
    fov,
    nearClip: 0.01,
    farClip: 1000,
    toneMapping: pc.TONEMAP_ACES2,
  });
  app.root.addChild(camera);

  const light = new pc.Entity('viewer_light');
  light.addComponent('light', {
    type: 'directional',
    color: new pc.Color(1, 0.92, 0.82),
    intensity: 1.2,
  });
  light.setEulerAngles(45, 35, 0);
  app.root.addChild(light);

  const fly = createFlyCameraController({
    app,
    camera,
    canvas,
    initialAzim: INITIAL_AZIM,
    initialElev: INITIAL_ELEV,
    initialZoom: INITIAL_ZOOM,
  });

  const axesGrid = createAxesGridDrawer({ app, camera });

  let destroyed = false;
  const updateHandler = () => {
    if (destroyed) return;
    fly.tick();
    axesGrid.tick();
    syncActorProxyMaterials();
    updateSelectionMarker();
  };
  app.on('update', updateHandler);
  app.start();
  setStatus(tr('viewer.threeD.statusMessages.engine.ready'));

  let splatPivotEntity: pc.Entity | null = null;
  let splatEntity: pc.Entity | null = null;
  let splatAsset: pc.Asset | null = null;
  let activeSplatUrl = '';
  let activePanoUrl = '';
  let sourceTransform: DirectorWorldSourceTransform = { ...DEFAULT_DIRECTOR_WORLD_SOURCE_TRANSFORM };
  let panoEntity: pc.Entity | null = null;
  let panoAsset: pc.Asset | null = null;
  // Track the scene AABB for the camera preset's fit_view; copied from the gsplat aabb once the splat has loaded.
  let sceneCenter = new pc.Vec3(0, 0, 0);
  let sceneRadiusValue = 1;

  function applySourceTransform(): void {
    if (!splatPivotEntity || !splatEntity) return;
    const pivot = buildSogPivotTransform({
      sceneCenter: [sceneCenter.x, sceneCenter.y, sceneCenter.z],
      transform: sourceTransform,
    });
    splatPivotEntity.setLocalPosition(
      pivot.pivotPosition[0],
      pivot.pivotPosition[1],
      pivot.pivotPosition[2],
    );
    splatPivotEntity.setLocalEulerAngles(
      pivot.pivotEulerDeg[0],
      pivot.pivotEulerDeg[1],
      pivot.pivotEulerDeg[2],
    );
    splatPivotEntity.setLocalScale(
      pivot.pivotScale,
      pivot.pivotScale,
      pivot.pivotScale,
    );
    splatEntity.setLocalPosition(
      pivot.splatLocalPosition[0],
      pivot.splatLocalPosition[1],
      pivot.splatLocalPosition[2],
    );
  }

  function applyPanoSourceTransform(): void {
    if (!panoEntity) return;
    panoEntity.setLocalPosition(
      sourceTransform.xOffset,
      sourceTransform.yOffset,
      sourceTransform.zOffset,
    );
    panoEntity.setLocalEulerAngles(
      sourceTransform.pitchDeg,
      180 + sourceTransform.yawDeg,
      sourceTransform.rollDeg,
    );
    const radius = 120 * sourceTransform.scale;
    panoEntity.setLocalScale(radius, radius, radius);
  }

  function clearPanoEnvironment(): void {
    if (panoEntity) {
      panoEntity.destroy();
      panoEntity = null;
    }
    if (panoAsset) {
      app.assets.remove(panoAsset);
      panoAsset = null;
    }
    activePanoUrl = '';
  }

  function clearSplat(): void {
    if (splatPivotEntity) {
      splatPivotEntity.destroy();
      splatPivotEntity = null;
    }
    if (splatEntity) {
      splatEntity.destroy();
      splatEntity = null;
    }
    if (splatAsset) {
      app.assets.remove(splatAsset);
      splatAsset = null;
    }
    activeSplatUrl = '';
  }

  function clearWorldSource(): void {
    clearSplat();
    clearPanoEnvironment();
    setStatus(tr('viewer.threeD.statusMessages.engine.emptyWorld'));
    emitSplatProgress({
      phase: 'ready',
      percent: 100,
      loadedBytes: 0,
      totalBytes: null,
      gaussians: null,
      message: null,
    });
  }

  function nudgeWorldYOffset(delta: number): boolean {
    if (!Number.isFinite(delta)) return false;
    sourceTransform = normalizeDirectorWorldSourceTransform({
      ...sourceTransform,
      yOffset: sourceTransform.yOffset + delta,
    });
    applySourceTransform();
    applyPanoSourceTransform();
    return true;
  }

  function resetWorldYOffset(): boolean {
    sourceTransform = normalizeDirectorWorldSourceTransform({
      ...sourceTransform,
      yOffset: 0,
    });
    applySourceTransform();
    applyPanoSourceTransform();
    return true;
  }

  function setSourceTransform(transform: Partial<DirectorWorldSourceTransform>): boolean {
    sourceTransform = normalizeDirectorWorldSourceTransform({
      ...sourceTransform,
      ...transform,
    });
    applySourceTransform();
    applyPanoSourceTransform();
    return true;
  }

  function resetSourceTransform(): boolean {
    sourceTransform = { ...DEFAULT_DIRECTOR_WORLD_SOURCE_TRANSFORM };
    applySourceTransform();
    applyPanoSourceTransform();
    return true;
  }

  // Decide how to rotate the splat entity into world coordinates by the URL suffix.
  // Reproduces the supersplat_auto default of the BuilderGPT viewer.
  function pickSplatOrientationEuler(
    url: string,
    mode: DirectorStageOrientationMode = 'supersplat_auto',
  ): [number, number, number] {
    if (mode === 'identity') return [0, 0, 0];
    if (mode === 'lcc_legacy') return [90, 0, 180];
    if (mode === 'flip_z') return [0, 0, 180];
    const lower = url.split('?')[0].split('#')[0].toLowerCase();
    if (lower.endsWith('.lcc')) return [90, 0, 180];
    if (lower.endsWith('.spz')) return [0, 0, 0];
    return [0, 0, 180];
  }

  function isSourceViewPlyUrl(url: string): boolean {
    const lower = url.split('?')[0].split('#')[0].toLowerCase();
    return (
      lower.endsWith('/master_sharp.ply') ||
      lower.endsWith('/master_sharp.sog') ||
      lower.endsWith('/reverse_sharp.ply') ||
      lower.endsWith('/reverse_sharp.sog') ||
      lower.endsWith('/pano_sharp.ply') ||
      lower.endsWith('/pano_sharp.sog') ||
      lower.endsWith('/pano_sharp_merged.ply') ||
      lower.endsWith('/pano_sharp_merged.sog') ||
      lower.endsWith('/pano_depth.ply') ||
      lower.endsWith('/pano_depth.sog')
    );
  }

  function applySourceViewDefaultCamera(url: string): boolean {
    if (!camera.camera || !isSourceViewPlyUrl(url)) return false;
    // SHARP / pano_sharp PLYs are generated in source-image camera space.
    // Match BuilderGPT's pano default: camera at source origin, looking forward.
    camera.camera.horizontalFov = true;
    camera.camera.fov = 96;
    camera.camera.nearClip = 0.001;
    camera.camera.farClip = Math.max(1000, sceneRadiusValue * 8);
    fly.setCameraByOffset(new pc.Vec3(0, 0, 1), new pc.Vec3(0, 0, -1));
    return true;
  }

  function applyDefaultCameraForSplat(url: string): void {
    if (applySourceViewDefaultCamera(url)) return;
    if (camera.camera) {
      camera.camera.horizontalFov = false;
      camera.camera.fov = fov;
    }
    fly.resetToInitial();
    enterDefaultInteriorView();
  }

  // Build the Asset by hand (instead of loadFromUrl) so we can subscribe to the 'progress' event for loading progress;
  // GSplatHandler still picks PlyParser / SogBundleParser automatically by the url suffix.
  function loadAsset(
    url: string,
    type: 'gsplat' | 'container' | 'texture',
    onProgress?: (loaded: number, total: number) => void,
  ): Promise<pc.Asset> {
    return new Promise((resolve, reject) => {
      const asset = new pc.Asset(`viewer_${type}`, type, { url });
      const cleanup = () => {
        asset.off('progress');
        asset.off('load');
        asset.off('error');
      };
      if (onProgress) {
        asset.on('progress', (loaded: number, total: number) => {
          onProgress(loaded, total);
        });
      }
      asset.once('load', () => {
        cleanup();
        if (destroyed) {
          app.assets.remove(asset);
          reject(new Error('viewer destroyed'));
          return;
        }
        resolve(asset);
      });
      asset.once('error', (err: unknown) => {
        cleanup();
        let message: string;
        if (typeof err === 'string') message = err;
        else if (err && typeof err === 'object' && 'message' in err) {
          message = String((err as { message?: unknown }).message ?? JSON.stringify(err));
        } else {
          message = JSON.stringify(err);
        }
        app.assets.remove(asset);
        reject(new Error(`asset load failed (${type}): ${url}\n${message}`));
      });
      app.assets.add(asset);
      app.assets.load(asset);
    });
  }

  function readSplatCount(asset: pc.Asset): number | null {
    const res = asset.resource as { numSplats?: unknown } | null | undefined;
    const n = res && typeof res.numSplats === 'number' ? res.numSplats : null;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  }

  async function loadSplat(url: string, options: LoadSplatOptions = {}) {
    if (!url) {
      setStatus(tr('viewer.threeD.statusMessages.engine.noWorldSource'));
      return;
    }
    clearPanoEnvironment();
    clearSplat();
    activeSplatUrl = url;
    sourceTransform = normalizeDirectorWorldSourceTransform(options.sourceTransform);
    setStatus(tr('viewer.threeD.statusMessages.engine.loadingWorld'));
    emitSplatProgress({
      phase: 'loading',
      percent: null,
      loadedBytes: 0,
      totalBytes: null,
      gaussians: null,
      message: null,
    });
    let asset: pc.Asset;
    try {
      asset = await loadAsset(url, 'gsplat', (loaded, total) => {
        const percent =
          total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : null;
        if (percent !== null)
          setStatus(tr('viewer.threeD.statusMessages.engine.loadingWorldPercent', { percent }));
        emitSplatProgress({
          phase: 'loading',
          percent,
          loadedBytes: loaded,
          totalBytes: total > 0 ? total : null,
          gaussians: null,
          message: null,
        });
      });
    } catch (error) {
      if (destroyed) return;
      const raw = error instanceof Error ? error.message : String(error);
      const friendly = tr(splatErrorMessageKey(raw));
      setStatus(friendly);
      emitSplatProgress({
        phase: 'error',
        percent: null,
        loadedBytes: 0,
        totalBytes: null,
        gaussians: null,
        message: friendly,
      });
      throw error instanceof Error ? error : new Error(raw);
    }
    if (destroyed) {
      app.assets.remove(asset);
      return;
    }
    splatAsset = asset;
    splatPivotEntity = new pc.Entity('viewer_splat_pivot');
    splatEntity = new pc.Entity('viewer_splat');
    const [ex, ey, ez] = pickSplatOrientationEuler(url, options.orientationMode);
    splatEntity.setLocalEulerAngles(ex, ey, ez);
    splatEntity.addComponent('gsplat', { asset, unified: true });
    splatPivotEntity.addChild(splatEntity);
    app.root.addChild(splatPivotEntity);

    // Adjust the scene radius with the splat AABB so fly speed and near/far clipping adapt.
    type GSplatLike = { customAabb?: pc.BoundingBox; resource?: { aabb?: pc.BoundingBox } };
    const gsplat = splatEntity.findComponent('gsplat') as unknown as GSplatLike | null;
    const aabb = gsplat?.customAabb || gsplat?.resource?.aabb;
    if (aabb) {
      const radius = Math.max(aabb.halfExtents.x, aabb.halfExtents.y, aabb.halfExtents.z);
      sceneRadiusValue = radius || 1;
      sceneCenter.copy(aabb.center);
      fly.setSceneRadius(sceneRadiusValue);
      camera.camera!.nearClip = Math.max(0.001, radius / 10000);
      camera.camera!.farClip = Math.max(1000, radius * 8);
    }
    applySourceTransform();
    applyDefaultCameraForSplat(url);
    const gaussians = readSplatCount(asset);
    setStatus(
      gaussians != null
        ? tr('viewer.threeD.statusMessages.engine.worldLoadedGaussians', {
            count: gaussians.toLocaleString(),
          })
        : tr('viewer.threeD.statusMessages.engine.worldLoaded'),
    );
    emitSplatProgress({
      phase: 'ready',
      percent: 100,
      loadedBytes: 0,
      totalBytes: null,
      gaussians,
      message: null,
    });
  }

  async function loadPano(url: string | null, options: LoadPanoOptions = {}): Promise<void> {
    clearSplat();
    clearPanoEnvironment();
    sourceTransform = constrainSourceTransformForType(options.sourceTransform, 'pano360');
    if (!url) {
      setStatus(tr('viewer.threeD.statusMessages.engine.panoCleared'));
      return;
    }
    setStatus(tr('viewer.threeD.statusMessages.engine.panoLoading'));
    let asset: pc.Asset;
    try {
      asset = await loadAsset(url, 'texture');
    } catch (error) {
      if (destroyed) return;
      const raw = error instanceof Error ? error.message : String(error);
      setStatus(tr('viewer.threeD.statusMessages.engine.panoFailed', { message: raw }));
      throw error instanceof Error ? error : new Error(raw);
    }

    if (destroyed) {
      app.assets.remove(asset);
      return;
    }
    activePanoUrl = url;
    panoAsset = asset;
    const texture = asset.resource as pc.Texture | null;
    const material = new pc.StandardMaterial();
    material.diffuseMap = texture;
    material.emissiveMap = texture;
    material.emissive = new pc.Color(1, 1, 1);
    material.useLighting = false;
    material.depthWrite = false;
    material.cull = pc.CULLFACE_NONE;
    material.update();

    const radius = 120;
    const sphere = new pc.Entity('pano360_environment_sphere');
    sphere.addComponent('render', { type: 'sphere', material });
    if (sphere.render) {
      sphere.render.castShadows = false;
      sphere.render.receiveShadows = false;
    }
    sphere.setLocalScale(radius, radius, radius);
    app.root.addChild(sphere);
    panoEntity = sphere;
    applyPanoSourceTransform();

    sceneCenter = new pc.Vec3(0, 1, 0);
    sceneRadiusValue = 1;
    fly.setSceneRadius(1);
    if (camera.camera) {
      camera.camera.horizontalFov = false;
      camera.camera.fov = fov;
      camera.camera.nearClip = 0.01;
      camera.camera.farClip = radius * 4;
    }
    fly.resetToInitial();
    setStatus(tr('viewer.threeD.statusMessages.engine.panoLoaded'));
  }

  // ---------- Collision physical surface ----------
  // collision.glb is kept only as an optional debug wireframe. actor / prop / staging of the director stage
  // coordinates all land on the stage ground and no longer read terrain height from collision.
  let collisionEntity: pc.Entity | null = null;
  let collisionMeshInstances: pc.MeshInstance[] = [];
  let collisionVisible = false;

  function applyCollisionMaterials(): void {
    if (!collisionEntity) return;
    for (const render of collisionEntity.findComponents('render') as pc.RenderComponent[]) {
      for (const mi of render.meshInstances ?? []) {
        const mat = new pc.StandardMaterial();
        mat.diffuse = new pc.Color(0, 0.95, 1);
        mat.emissive = new pc.Color(0, 0.95, 1);
        mat.useLighting = false;
        mat.opacity = collisionVisible ? 0.45 : 0.001;
        mat.blendType = pc.BLEND_NORMAL;
        mat.depthWrite = false;
        mat.depthTest = collisionVisible;
        mat.update();
        mi.material = mat;
        mi.castShadow = false;
      }
      render.castShadows = false;
      render.receiveShadows = false;
    }
  }

  function setCollisionVisible(visible: boolean): void {
    collisionVisible = visible;
    applyCollisionMaterials();
  }

  async function loadCollision(url: string | null): Promise<void> {
    if (collisionEntity) {
      collisionEntity.destroy();
      collisionEntity = null;
    }
    collisionMeshInstances = [];
    if (!url) return;
    setStatus(tr('viewer.threeD.statusMessages.engine.collisionLoading', { url }));
    let asset: pc.Asset;
    try {
      asset = await loadAsset(url, 'container');
    } catch (error) {
      if (destroyed) return;
      console.warn('[viewer] collision load failed (fallback to y=0 plane):', error);
      setStatus(
        tr('viewer.threeD.statusMessages.engine.collisionFailed', {
          message: String((error as Error)?.message ?? error),
        }),
      );
      return;
    }
    if (destroyed) {
      app.assets.remove(asset);
      return;
    }
    type ContainerResource = { instantiateRenderEntity?: (opts?: { castShadows?: boolean }) => pc.Entity };
    const resource = asset.resource as ContainerResource | null;
    if (!resource?.instantiateRenderEntity) {
      setStatus(tr('viewer.threeD.statusMessages.engine.collisionMissingApi'));
      return;
    }
    collisionEntity = resource.instantiateRenderEntity({ castShadows: false });
    collisionEntity.name = 'collision_mesh';
    // Keep consistent with the default splat orientation (for other splat orientations use lcc/spz and the splat's own rotation).
    collisionEntity.setEulerAngles(0, 0, 180);
    app.root.addChild(collisionEntity);
    collisionMeshInstances = (collisionEntity.findComponents('render') as pc.RenderComponent[])
      .flatMap((render) => Array.from(render.meshInstances ?? []));
    applyCollisionMaterials();
    setStatus(
      tr('viewer.threeD.statusMessages.engine.collisionLoaded', {
        count: collisionMeshInstances.length,
      }),
    );
  }

  // ---------- Placeholder placement / screenshots ----------
  // Phase 2a: director-state actor / prop / staging have no backend asset pipeline yet, so use plain-color primitives
  // placed at the "ground the crosshair points at"; crosshair = screen center = straight ahead of the camera.
  const markers: Record<MarkerKind, pc.Entity[]> = { actor: [], prop: [], staging: [] };
  // The hex color each marker was created with, used when saving / restoring the scene snapshot.
  // Reading material.diffuse directly also works, but a mannequin has many bones and materials; recording the original hex is simple and reliable.
  const markerColors = new WeakMap<pc.Entity, string>();
  type MountTarget = {
    kind: 'prop' | 'staging';
    entity: pc.Entity;
    attachPointId: string;
  };
  const mountLinks = new WeakMap<pc.Entity, MountTarget>();
  const markerListeners = new Set<(counts: MarkerCounts) => void>();
  const emitMarkers = () => {
    const counts: MarkerCounts = {
      actor: markers.actor.length,
      prop: markers.prop.length,
      staging: markers.staging.length,
    };
    for (const l of markerListeners) l(counts);
  };

  function parseHex(hex: string): pc.Color {
    const h = (hex || '#ffbd59').replace('#', '');
    if (h.length === 6) {
      const r = Number.parseInt(h.slice(0, 2), 16) / 255;
      const g = Number.parseInt(h.slice(2, 4), 16) / 255;
      const b = Number.parseInt(h.slice(4, 6), 16) / 255;
      return new pc.Color(r, g, b);
    }
    return new pc.Color(1, 0.74, 0.35);
  }

  function makeMaterial(color: pc.Color): pc.StandardMaterial {
    const m = new pc.StandardMaterial();
    m.diffuse = color.clone();
    m.emissive = color.clone();
    m.opacity = 1;
    m.blendType = pc.BLEND_NONE;
    m.useLighting = false;
    m.useTonemap = false;
    m.update();
    return m;
  }

  function rebuildShapeHintProxy(entity: pc.Entity, hint: ShapeHintName, colorHex: string): void {
    if (entity.render) {
      entity.removeComponent('render');
    }
    while (entity.children.length > 0) {
      entity.children[0].destroy();
    }
    const material = makeMaterial(parseHex(colorHex));
    for (const part of proxyPartsForHint(hint)) {
      const child = new pc.Entity(`shape_${part.name}`);
      child.addComponent('render', { type: part.type });
      if (child.render) {
        child.render.castShadows = false;
        child.render.receiveShadows = false;
        for (const meshInstance of child.render.meshInstances ?? []) {
          meshInstance.material = material;
          meshInstance.castShadow = false;
          meshInstance.receiveShadow = false;
        }
      }
      child.setLocalPosition(part.offset[0], part.offset[1], part.offset[2]);
      child.setLocalScale(part.scale[0], part.scale[1], part.scale[2]);
      entity.addChild(child);
    }
  }

  // The mannequin uses an emissive solid-color material: independent of scene lighting, with stable color, consistent with BuilderGPT's
  // playcanvas 3GS director stage.
  function makeFlatMaterial(color: pc.Color): pc.StandardMaterial {
    const m = new pc.StandardMaterial();
    m.diffuse = color.clone();
    m.emissive = color.clone();
    m.opacity = 1;
    m.blendType = pc.BLEND_NONE;
    m.useLighting = false;
    m.useTonemap = false;
    m.update();
    return m;
  }

  function makeBone(name: string, position: [number, number, number] = [0, 0, 0]): pc.Entity {
    const e = new pc.Entity(name);
    e.setLocalPosition(position[0], position[1], position[2]);
    return e;
  }

  type ContainerAssetResource = {
    instantiateRenderEntity?: (options?: { castShadows?: boolean }) => pc.Entity;
    animations?: pc.Asset[];
  };

  const QUATERNIUS_POSE_CLIPS: Record<PoseName, { names: string[]; sampleTime: number }> = {
    standing: { names: ['Idle_Loop', 'Idle_No_Loop', 'Idle_FoldArms_Loop', 'A_TPose'], sampleTime: 0.25 },
    talking: { names: ['Idle_Talking_Loop', 'Idle_Rail_Call', 'Yes'], sampleTime: 0.3 },
    arms_crossed: { names: ['Idle_FoldArms_Loop', 'Idle_No_Loop'], sampleTime: 0.25 },
    sitting: { names: ['Sitting_Idle_Loop', 'Sitting_Talking_Loop', 'Idle_Rail_Loop'], sampleTime: 0.45 },
    eating: { names: ['Consume', 'Idle_Talking_Loop', 'Farm_Harvest'], sampleTime: 0.75 },
    crouching: { names: ['Crouch_Idle_Loop', 'Crouch_Fwd_Loop'], sampleTime: 0.25 },
    kneeling: { names: ['Fixing_Kneeling', 'Farm_PlantSeed'], sampleTime: 0.35 },
    lying: { names: ['LayToIdle', 'Death01'], sampleTime: 0.02 },
    walking: { names: ['Walk_Loop', 'Walk_Formal_Loop', 'Walk_Carry_Loop'], sampleTime: 0.35 },
    running: { names: ['Sprint_Loop', 'Jog_Fwd_Loop', 'Shield_Dash_RM'], sampleTime: 0.25 },
    pointing: { names: ['Pistol_Aim_Neutral', 'Spell_Simple_Shoot', 'OverhandThrow'], sampleTime: 0.35 },
    holding: { names: ['Walk_Carry_Loop', 'Idle_Lantern_Loop', 'PickUp_Table'], sampleTime: 0.18 },
    interacting: { names: ['Interact', 'Chest_Open', 'Farm_Harvest', 'Farm_PlantSeed'], sampleTime: 0.55 },
    fighting: { names: ['Punch_Cross', 'Punch_Jab', 'Melee_Hook'], sampleTime: 0.28 },
    sword: { names: ['Sword_Idle', 'Sword_Block', 'Sword_Regular_A'], sampleTime: 0.25 },
  };

  let actorProxyAsset: pc.Asset | null = null;
  let actorProxyLoadStarted = false;
  const actorAnimationEntities = new WeakMap<pc.Entity, pc.Entity>();
  const actorAnimationTracks = new WeakMap<pc.Entity, Map<string, unknown>>();
  const actorAnimationTrackLibrary = new Map<string, unknown>();

  async function loadActorProxyModel(): Promise<void> {
    if (actorProxyLoadStarted || actorProxyAsset) return;
    actorProxyLoadStarted = true;
    const [proxyAsset, ...animationAssets] = await Promise.all([
      loadAsset(ACTOR_PROXY_MODEL_URL, 'container'),
      ...ACTOR_ANIMATION_LIBRARY_URLS.map((url) => loadAsset(url, 'container')),
    ]);
    actorProxyAsset = proxyAsset;

    // The proxy GLB (UAL2) already carries its own clips — pull them into the shared track
    // library so we never load UAL2 a second time just for its animations.
    const proxyResource = actorProxyAsset?.resource as ContainerAssetResource | null | undefined;
    for (const asset of proxyResource?.animations ?? []) {
      const track = asset.resource;
      // Key by the AnimTrack's own name (the glTF clip name, e.g. "Idle_Loop"). The wrapping
      // asset.name is a generic container name and never matches the pose→clip map.
      const clipName = (track as { name?: string } | null | undefined)?.name;
      if (track && clipName) actorAnimationTrackLibrary.set(clipName, track);
    }

    for (const asset of animationAssets) {
      const resource = asset.resource as ContainerAssetResource | null | undefined;
      for (const asset of resource?.animations ?? []) {
        const track = asset.resource;
        const clipName = (track as { name?: string } | null | undefined)?.name;
        if (!track || !clipName) continue;
        actorAnimationTrackLibrary.set(clipName, track);
      }
    }
    for (const [pose, config] of Object.entries(QUATERNIUS_POSE_CLIPS) as Array<[PoseName, { names: string[] }]>) {
      if (!config.names.some((name) => actorAnimationTrackLibrary.has(name))) {
        throw new Error(`3GS actor pose "${pose}" has no matching Quaternius clip: ${config.names.join(', ')}`);
      }
    }
  }

  function instantiateActorProxyModel(color: pc.Color): pc.Entity {
    const resource = actorProxyAsset?.resource as ContainerAssetResource | null | undefined;
    const model = resource?.instantiateRenderEntity?.({ castShadows: false });
    if (!model) throw new Error('Quaternius actor proxy asset is not loaded.');
    const root = new pc.Entity('actor_proxy_quaternius');
    model.name = 'quaternius_mannequin';
    model.setLocalPosition(0, 0, 0);
    model.setLocalEulerAngles(0, 180, 0);
    const actorMaterial = makeFlatMaterial(color);
    for (const render of model.findComponents('render') as pc.RenderComponent[]) {
      render.castShadows = false;
      render.receiveShadows = false;
      for (const meshInstance of render.meshInstances ?? []) {
        meshInstance.material = actorMaterial;
        meshInstance.castShadow = false;
        meshInstance.receiveShadow = false;
      }
    }
    for (const modelComponent of model.findComponents('model') as pc.ModelComponent[]) {
      modelComponent.castShadows = false;
      modelComponent.receiveShadows = false;
      for (const meshInstance of modelComponent.meshInstances ?? []) {
        meshInstance.material = actorMaterial;
        meshInstance.castShadow = false;
        meshInstance.receiveShadow = false;
      }
    }
    root.addChild(model);
    model.addComponent('anim', { activate: true });
    // Tracks come from a separate GLB (same Quaternius rig); bind them against this model's
    // own skeleton root so bone paths resolve, otherwise the mesh stays in the bind (T) pose.
    if (model.anim) model.anim.rootBone = model;
    actorAnimationEntities.set(root, model);
    actorAnimationTracks.set(root, actorAnimationTrackLibrary);

    // Keep a seated hip reference available for future proxy pose alignment.
    root.addChild(makeBone('anchor_seat', [0, 0.8, 0]));
    return root;
  }

  function setActorAnimationPlayback(actor: pc.Entity, playing: boolean): void {
    const animEntity = actorAnimationEntities.get(actor);
    const anim = animEntity?.anim;
    if (!anim) throw new Error(`3GS actor "${actor.name}" has no animation component.`);
    if (playing) {
      if (anim.baseLayer?.activeState) anim.baseLayer.play(anim.baseLayer.activeState);
      anim.playing = true;
    } else {
      anim.baseLayer?.pause();
      anim.playing = false;
    }
    actorActionPlaying.set(actor, playing);
  }

  function sampleActorAnimationPose(actor: pc.Entity, pose: PoseName): void {
    const animEntity = actorAnimationEntities.get(actor);
    const tracks = actorAnimationTracks.get(actor);
    const anim = animEntity?.anim;
    if (!anim || !tracks) throw new Error(`3GS actor "${actor.name}" has no animation component/tracks.`);
    const config = QUATERNIUS_POSE_CLIPS[pose] ?? QUATERNIUS_POSE_CLIPS.standing;
    const clipName = config.names.find((name) => tracks.has(name));
    if (!clipName) {
      throw new Error(`3GS actor pose "${pose}" has no loaded clip: ${config.names.join(', ')}`);
    }
    const track = tracks.get(clipName);
    if (!track) throw new Error(`3GS actor clip "${clipName}" is missing.`);
    try {
      anim.assignAnimation(clipName, track as never, undefined, 1, true);
      const playing = actorActionPlaying.get(actor) ?? true;
      sampleActorAnimationPoseFrame(anim, clipName, config.sampleTime, playing);
      actorActionPlaying.set(actor, playing);
    } catch (error) {
      console.error('[viewer][anim] failed to apply pose', { pose, clipName, error });
      throw new Error(`3GS actor failed to apply pose "${pose}" with clip "${clipName}".`);
    }
  }

  function applyActorPose(actor: pc.Entity, pose: PoseName): void {
    sampleActorAnimationPose(actor, pose);
  }

  function crosshairRay(): pc.Ray | null {
    const rect = canvas.getBoundingClientRect();
    return screenToRay(rect.left + rect.width / 2, rect.top + rect.height / 2);
  }

  function raycastRayToHorizontalPlane(ray: pc.Ray, planeY: number): pc.Vec3 | null {
    const fwd = ray.direction;
    const pos = ray.origin;
    if (Math.abs(fwd.y) < 1e-4) return null;
    const t = (planeY - pos.y) / fwd.y;
    if (!Number.isFinite(t) || t <= 0) return null;
    return new pc.Vec3(pos.x + fwd.x * t, planeY, pos.z + fwd.z * t);
  }

  // Crosshair landing point: intersect the real ray from the screen center with the director's horizontal floor.
  // Does not depend on collision by default, since most director worlds have no usable collision mesh.
  function raycastCrosshairToGround(): pc.Vec3 {
    const ray = crosshairRay();
    if (ray) {
      const groundHit = raycastRayToHorizontalPlane(ray, STAGE_GROUND_Y);
      if (groundHit) {
        showHitMarker(groundHit);
        return groundHit;
      }
    }

    const pos = camera.getPosition();
    const fwd = camera.forward;
    const fallback = new pc.Vec3(pos.x + fwd.x * 5, STAGE_GROUND_Y, pos.z + fwd.z * 5);
    showHitMarker(fallback);
    return fallback;
  }

  // ---------- Debug hit marker ----------
  // Reproduces BuilderGPT showHitMarker: after a raycast place a pink emissive sphere at the hit point, to make it easy to
  // diagnose the crosshair-to-ground distance error. Off by default.
  let hitMarker: pc.Entity | null = null;
  let hitMarkerEnabled = false;

  function ensureHitMarker(): pc.Entity {
    if (hitMarker) return hitMarker;
    const e = new pc.Entity('collision_hit_marker');
    const mat = new pc.StandardMaterial();
    mat.diffuse = new pc.Color(1, 0.1, 0.85);
    mat.emissive = new pc.Color(1, 0.1, 0.85);
    mat.useLighting = false;
    mat.depthTest = false;
    mat.depthWrite = false;
    mat.opacity = 0.95;
    mat.blendType = pc.BLEND_NORMAL;
    mat.update();
    e.addComponent('render', { type: 'sphere', material: mat });
    if (e.render) {
      e.render.castShadows = false;
      e.render.receiveShadows = false;
    }
    e.setLocalScale(0.07, 0.07, 0.07);
    e.enabled = false;
    app.root.addChild(e);
    hitMarker = e;
    return e;
  }

  function showHitMarker(point: pc.Vec3): void {
    if (!hitMarkerEnabled) return;
    const m = ensureHitMarker();
    m.setPosition(point);
    m.enabled = true;
  }

  function setHitMarkerEnabled(enabled: boolean): void {
    hitMarkerEnabled = enabled;
    if (!enabled && hitMarker) hitMarker.enabled = false;
  }

  // Ground Y at (x, z): the director stage's fixed floor. collision is kept only as a debug / future capability.
  function groundYAt(x: number, z: number): number {
    void x;
    void z;
    return STAGE_GROUND_Y;
  }

  // The current pose name of each actor entity. A WeakMap guarantees automatic GC after the entity is destroyed.
  const actorPoses = new WeakMap<pc.Entity, PoseName>();
  const actorActionPlaying = new WeakMap<pc.Entity, boolean>();
  const actorProxyMaterialColors = new WeakMap<pc.Entity, string>();
  const actorProxyMaterials = new Map<string, pc.StandardMaterial>();
  const markerYaws = new WeakMap<pc.Entity, number>();
  // The shape_hint of each prop / staging entity; used only for the runtime blocking proxy.
  // Default: prop -> 'box', staging -> 'generic_large'; the UI only allows changing staging.
  const markerShapeHints = new WeakMap<pc.Entity, ShapeHintName>();

  function getEntityShapeHint(entity: pc.Entity): ShapeHintName {
    return markerShapeHints.get(entity) ?? 'box';
  }

  function actorFlatMaterial(colorHex: string): pc.StandardMaterial {
    const cached = actorProxyMaterials.get(colorHex);
    if (cached) return cached;
    const material = makeFlatMaterial(parseHex(colorHex));
    actorProxyMaterials.set(colorHex, material);
    return material;
  }

  function applyActorProxyMaterial(entity: pc.Entity, colorHex: string): void {
    const material = actorFlatMaterial(colorHex);
    for (const render of entity.findComponents('render') as pc.RenderComponent[]) {
      render.castShadows = false;
      render.receiveShadows = false;
      for (const meshInstance of render.meshInstances ?? []) {
        meshInstance.material = material;
        meshInstance.castShadow = false;
        meshInstance.receiveShadow = false;
      }
    }
    for (const modelComponent of entity.findComponents('model') as pc.ModelComponent[]) {
      modelComponent.castShadows = false;
      modelComponent.receiveShadows = false;
      for (const meshInstance of modelComponent.meshInstances ?? []) {
        meshInstance.material = material;
        meshInstance.castShadow = false;
        meshInstance.receiveShadow = false;
      }
    }
  }

  function syncActorProxyMaterials(): void {
    for (const actor of markers.actor) {
      const colorHex = actorProxyMaterialColors.get(actor);
      if (!colorHex) continue;
      applyActorProxyMaterial(actor, colorHex);
    }
  }

  // Get the semantic reference point of a prop/staging; used for tolerant crosshair/click selection and establishes no mount relationship.
  function attachmentPointForProp(
    prop: pc.Entity,
    attachPointId?: string,
  ): AttachmentPoint | null {
    return resolveAttachmentPoint(getEntityShapeHint(prop), attachPointId);
  }

  function tupleToVec3(value: [number, number, number]): pc.Vec3 {
    return new pc.Vec3(value[0], value[1], value[2]);
  }

  function validTuple3(value: unknown): value is [number, number, number] {
    return Array.isArray(value)
      && value.length >= 3
      && value.slice(0, 3).every((item) => typeof item === 'number' && Number.isFinite(item));
  }

  function placeMarker(kind: MarkerKind, opts: PlaceMarkerOptions = {}): boolean {
    const explicitPosition = validTuple3(opts.position) ? tupleToVec3(opts.position) : null;
    const hit = explicitPosition ?? raycastCrosshairToGround();
    const defaultColor: Record<MarkerKind, string> = {
      actor: '#ff3344',
      prop: '#ffd34d',
      staging: '#4587ff',
    };
    const userScale = typeof opts.scale === 'number' && opts.scale > 0 ? opts.scale : 1;
    const explicitScale = validTuple3(opts.scale) ? tupleToVec3(opts.scale) : null;
    const colorHex = opts.color ?? defaultColor[kind];
    const color = parseHex(colorHex);

    let entity: pc.Entity;
    if (kind === 'actor') {
      entity = instantiateActorProxyModel(color);
      entity.name = opts.label || `marker_actor_${markers.actor.length + 1}`;
      entity.setLocalScale(explicitScale ?? new pc.Vec3(userScale, userScale, userScale));
      entity.setPosition(hit.x, hit.y, hit.z);
      markerYaws.set(entity, 0);
      actorPoses.set(entity, 'standing');
      actorActionPlaying.set(entity, true);
      actorProxyMaterialColors.set(entity, colorHex);
      applyActorProxyMaterial(entity, colorHex);
      applyActorPose(entity, 'standing');
    } else {
      entity = new pc.Entity(opts.label || `marker_${kind}_${markers[kind].length + 1}`);
      const defaultSize = kind === 'staging'
        ? new pc.Vec3(1.0 * userScale, 0.6 * userScale, 1.0 * userScale)
        : new pc.Vec3(0.4 * userScale, 0.4 * userScale, 0.4 * userScale);
      const size = explicitScale ?? defaultSize;
      entity.setLocalScale(size);
      entity.setPosition(hit.x, explicitPosition ? hit.y : hit.y + size.y / 2, hit.z);
      markerYaws.set(entity, 0);
      // Default shape_hint: staging -> generic_large (no attach points), prop -> box (no attach points).
      // Only after the user switches to something like quadruped_mount via setSelectedShapeHint can the saddle attach point be used.
      const hint = opts.shapeHint ?? (kind === 'staging' ? 'generic_large' : 'box');
      markerShapeHints.set(entity, hint);
      rebuildShapeHintProxy(entity, hint, colorHex);
      if (!explicitPosition) {
        entity.setPosition(hit.x, hit.y - size.y * proxyLocalBottomForHint(hint), hit.z);
      }
    }
    markerColors.set(entity, colorHex);
    app.root.addChild(entity);
    markers[kind].push(entity);
    emitMarkers();
    return true;
  }

  function deleteLastMarker(kind: MarkerKind): boolean {
    const last = markers[kind].pop();
    if (!last) return false;
    if (kind === 'actor') {
      mountLinks.delete(last);
    } else {
      for (const actor of markers.actor) {
        const link = mountLinks.get(actor);
        if (link?.entity === last) unmountActor(actor);
      }
    }
    if (selection && selection.kind === kind && selection.entity === last) {
      setSelection(null);
    }
    last.destroy();
    emitMarkers();
    return true;
  }

  function clearMarkers(kind?: MarkerKind): void {
    const kinds: MarkerKind[] = kind ? [kind] : ['actor', 'prop', 'staging'];
    if (!kind) {
      for (const actor of markers.actor) mountLinks.delete(actor);
    } else if (kind === 'actor') {
      for (const actor of markers.actor) mountLinks.delete(actor);
    } else {
      for (const actor of markers.actor) {
        const link = mountLinks.get(actor);
        if (link?.kind === kind) unmountActor(actor);
      }
    }
    for (const k of kinds) {
      while (markers[k].length > 0) {
        markers[k].pop()?.destroy();
      }
    }
    if (selection && (!kind || selection.kind === kind)) {
      setSelection(null);
    }
    emitMarkers();
  }

  // ---------- Selection (picking + highlight + subscription) ----------
  // Single select: pick one entity from the markers arrays of actor / prop / staging.
  // Highlight: reproduces the old PlayCanvas 3GS director stage's selection
  // wireframe marker - a root-level box rendered in WIREFRAME style, adapting to the different sizes of actor sitting / standing /
  // prop / staging; updateSelectionMarker makes it follow the selected entity every frame.
  type InternalSelection = {
    kind: MarkerKind;
    entity: pc.Entity;
  };
  let selection: InternalSelection | null = null;
  const selectionListeners = new Set<(s: SelectionState | null) => void>();
  let selectionMarker: pc.Entity | null = null;

  function describeSelection(): SelectionState | null {
    if (!selection) return null;
    const idx = markers[selection.kind].indexOf(selection.entity);
    if (idx < 0) return null;
    const pos = selection.entity.getPosition();
    const pose = selection.kind === 'actor' ? actorPoses.get(selection.entity) ?? 'standing' : null;
    const actionPlaying = selection.kind === 'actor' ? actorActionPlaying.get(selection.entity) ?? true : null;
    const mounted = selection.kind === 'actor' && mountLinks.has(selection.entity);
    const shapeHint = selection.kind === 'actor' ? null : getEntityShapeHint(selection.entity);
    return {
      kind: selection.kind,
      index: idx,
      label: selection.entity.name || `${selection.kind}_${idx + 1}`,
      position: [pos.x, pos.y, pos.z],
      pose,
      actionPlaying,
      mounted,
      shapeHint,
    };
  }

  function emitSelection(): void {
    const snapshot = describeSelection();
    for (const l of selectionListeners) l(snapshot);
  }

  function ensureSelectionMarker(): pc.Entity {
    if (selectionMarker) return selectionMarker;
    const marker = new pc.Entity('selection_wireframe');
    const mat = new pc.StandardMaterial();
    mat.diffuse = new pc.Color(1, 0.78, 0.18);
    mat.emissive = new pc.Color(1, 0.78, 0.18);
    mat.useLighting = false;
    mat.opacity = 0.95;
    mat.blendType = pc.BLEND_NORMAL;
    mat.depthWrite = false;
    mat.update();
    marker.addComponent('render', { type: 'box', material: mat });
    if (marker.render) {
      marker.render.castShadows = false;
      marker.render.receiveShadows = false;
      for (const mi of marker.render.meshInstances ?? []) {
        mi.renderStyle = pc.RENDERSTYLE_WIREFRAME;
        mi.material = mat;
      }
    }
    marker.enabled = false;
    app.root.addChild(marker);
    selectionMarker = marker;
    return marker;
  }

  // Reproduces the old PlayCanvas 3GS director stage's selectionMarkerTransform:
  //   actor standing -> 1.9m high, 0.82m * actorScale wide and deep; sitting -> 1.45m high
  //   prop_staging   -> 8% larger than the entity, minimum 0.45m; padded to the lower-middle
  //   prop           -> 15% larger than the entity, minimum 0.28m; padded to the lower-middle
  function selectionMarkerTransform(sel: InternalSelection): { position: pc.Vec3; scale: pc.Vec3 } {
    const pos = sel.entity.getPosition();
    const scale = sel.entity.getLocalScale();
    if (sel.kind === 'actor') {
      const sitting = (actorPoses.get(sel.entity) ?? 'standing') === 'sitting';
      const baseHeight = sitting ? 1.45 : 1.9;
      const height = baseHeight * Math.max(0.1, scale.y);
      const width = 0.82 * Math.max(0.1, scale.x);
      const depth = 0.82 * Math.max(0.1, scale.z);
      return {
        position: new pc.Vec3(pos.x, pos.y + height / 2, pos.z),
        scale: new pc.Vec3(width, height, depth),
      };
    }
    if (sel.kind === 'staging') {
      const sx = Math.max(0.45, scale.x * 1.08);
      const sy = Math.max(0.45, scale.y * 1.08);
      const sz = Math.max(0.45, scale.z * 1.08);
      const lift = Math.max(0.28, scale.y * 0.45);
      return {
        position: new pc.Vec3(pos.x, pos.y - scale.y / 2 + lift, pos.z),
        scale: new pc.Vec3(sx, sy, sz),
      };
    }
    const sx = Math.max(0.28, scale.x * 1.15);
    const sy = Math.max(0.28, scale.y * 1.15);
    const sz = Math.max(0.28, scale.z * 1.15);
    const lift = Math.max(0.18, scale.y * 0.35);
    return {
      position: new pc.Vec3(pos.x, pos.y - scale.y / 2 + lift, pos.z),
      scale: new pc.Vec3(sx, sy, sz),
    };
  }

  function updateSelectionMarker(): void {
    if (!selection) {
      if (selectionMarker) selectionMarker.enabled = false;
      return;
    }
    const marker = ensureSelectionMarker();
    const { position, scale } = selectionMarkerTransform(selection);
    const yaw = selection.entity.getEulerAngles().y;
    marker.enabled = true;
    marker.setPosition(position);
    marker.setEulerAngles(0, yaw, 0);
    marker.setLocalScale(scale);
  }

  function setSelection(next: { kind: MarkerKind; entity: pc.Entity } | null): void {
    selection = next ? { kind: next.kind, entity: next.entity } : null;
    updateSelectionMarker();
    updateTranslateGizmoAttachment();
    emitSelection();
  }

  // ---------- TranslateGizmo (XYZ axis dragging) ----------
  // Reproduces the old PlayCanvas 3GS director stage's pc.TranslateGizmo:
  // After selecting an actor / prop / staging, attach the gizmo to that entity; dragging the X/Y/Z arrows or plane
  // translates in world space. When dragging a prop / staging, the actors mounted on it move along.
  //
  // PlayCanvas TranslateGizmo / Gizmo.createLayer is only stable from v2+; when missing or throwing,
  // gizmoCreateFailed=true is set and never retried, and the feature degrades silently as a whole (other interactions are unaffected).
  let translateGizmoEnabled = true;
  let translateGizmo: pc.TranslateGizmo | null = null;
  let translateGizmoLayer: pc.Layer | null = null;
  let translateGizmoAttachedEntity: pc.Entity | null = null;
  let translateGizmoCreateFailed = false;

  function ensureTranslateGizmo(): pc.TranslateGizmo | null {
    if (translateGizmo) return translateGizmo;
    if (translateGizmoCreateFailed) return null;
    if (!camera.camera) return null;
    try {
      const GizmoCtor = (pc as unknown as { Gizmo?: { createLayer?: typeof pc.Gizmo.createLayer } }).Gizmo;
      const TranslateGizmoCtor = (pc as unknown as { TranslateGizmo?: typeof pc.TranslateGizmo }).TranslateGizmo;
      if (!GizmoCtor?.createLayer || !TranslateGizmoCtor) {
        translateGizmoCreateFailed = true;
        return null;
      }
      translateGizmoLayer = GizmoCtor.createLayer(app, 'SuperTale Translate Gizmo');
      const gizmo = new TranslateGizmoCtor(camera.camera, translateGizmoLayer);
      gizmo.coordSpace = 'world';
      gizmo.size = 1.08;
      gizmo.axisCenterSize = 0.085;
      gizmo.axisLineThickness = 0.035;
      gizmo.axisLineLength = 0.72;
      // Disable middle / right-button dragging; middle is the fly dolly and right is camera rotation, avoiding accidental gizmo touches.
      gizmo.mouseButtons[1] = false;
      gizmo.mouseButtons[2] = false;
      gizmo.on('transform:move', () => {
        if (!translateGizmoAttachedEntity || !selection) return;
        syncMountedActorsForSelection();
        updateSelectionMarker();
        emitSelection();
      });
      gizmo.on('transform:end', () => {
        if (translateGizmoAttachedEntity && selection) {
          syncMountedActorsForSelection();
          updateSelectionMarker();
          emitSelection();
        }
      });
      translateGizmo = gizmo;
      return gizmo;
    } catch (error) {
      console.warn('[viewer] TranslateGizmo init failed; XYZ drag disabled:', error);
      translateGizmoCreateFailed = true;
      return null;
    }
  }

  function updateTranslateGizmoAttachment(): void {
    if (!translateGizmoEnabled) {
      if (translateGizmo && translateGizmoAttachedEntity) {
        try { translateGizmo.detach(); } catch (_) { /* ignore */ }
      }
      translateGizmoAttachedEntity = null;
      if (translateGizmo) translateGizmo.enabled = false;
      return;
    }
    if (!selection) {
      if (translateGizmo && translateGizmoAttachedEntity) {
        try { translateGizmo.detach(); } catch (_) { /* ignore */ }
      }
      translateGizmoAttachedEntity = null;
      if (translateGizmo) translateGizmo.enabled = false;
      return;
    }
    const gizmo = ensureTranslateGizmo();
    if (!gizmo) return;
    if (translateGizmoAttachedEntity !== selection.entity) {
      try { gizmo.detach(); } catch (_) { /* ignore */ }
      try {
        gizmo.attach([selection.entity]);
        translateGizmoAttachedEntity = selection.entity;
      } catch (error) {
        console.warn('[viewer] TranslateGizmo attach failed:', error);
        translateGizmoAttachedEntity = null;
      }
    }
    gizmo.enabled = true;
  }

  function setTranslateGizmoEnabled(enabled: boolean): void {
    if (translateGizmoEnabled === enabled) return;
    translateGizmoEnabled = enabled;
    updateTranslateGizmoAttachment();
  }

  function isTranslateGizmoEnabled(): boolean {
    return translateGizmoEnabled;
  }

  function syncMountedActorsForSelection(): void {
    if (!selection || selection.kind === 'actor') return;
    syncMountedActorsOf(selection.entity);
  }

  // Screen coordinates -> world ray (origin = camera, direction = unit vector toward picked screen point).
  function screenToRay(clientX: number, clientY: number): pc.Ray | null {
    if (!camera.camera) return null;
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const start = camera.getPosition().clone();
    const end = camera.camera.screenToWorld(x, y, 1);
    const direction = end.sub(start);
    if (direction.lengthSq() < 1e-8) return null;
    direction.normalize();
    return new pc.Ray(start, direction);
  }

  function markerPickWorldPosition(kind: MarkerKind, entity: pc.Entity): pc.Vec3 {
    if (kind === 'prop' || kind === 'staging') return mountTargetWorldPosition(entity);
    const pos = entity.getPosition();
    const scale = entity.getLocalScale();
    return new pc.Vec3(pos.x, pos.y + 0.9 * scale.y, pos.z);
  }

  function markerPickRadius(kind: MarkerKind, entity: pc.Entity): number {
    const scale = entity.getLocalScale();
    const maxScale = Math.max(scale.x, scale.y, scale.z);
    return kind === 'actor'
      ? Math.max(0.45, maxScale * 0.6)
      : Math.max(0.55, maxScale * 0.45);
  }

  // Run AABB-vs-ray detection on every entity of the markers (including children) and pick the hit closest to the origin.
  function pickMarker(ray: pc.Ray): { kind: MarkerKind; entity: pc.Entity } | null {
    let best: { kind: MarkerKind; entity: pc.Entity } | null = null;
    let bestDistance = Infinity;
    const hitPoint = new pc.Vec3();
    const kinds: MarkerKind[] = ['actor', 'prop', 'staging'];
    for (const kind of kinds) {
      for (const entity of markers[kind]) {
        const renders = entity.findComponents('render') as pc.RenderComponent[];
        for (const render of renders) {
          for (const meshInstance of render.meshInstances ?? []) {
            const aabb = meshInstance.aabb;
            if (!aabb || !aabb.intersectsRay(ray, hitPoint)) continue;
            const distance = hitPoint.distance(ray.origin);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = { kind, entity };
            }
          }
        }
      }
    }
    if (best) return best;

    for (const kind of kinds) {
      for (const entity of markers[kind]) {
        const candidate = markerPickWorldPosition(kind, entity);
        const radius = markerPickRadius(kind, entity);
        const distance = distanceSqPointToRay(
          [ray.origin.x, ray.origin.y, ray.origin.z],
          [ray.direction.x, ray.direction.y, ray.direction.z],
          [candidate.x, candidate.y, candidate.z],
        );
        if (distance.along <= 0 || distance.distanceSq > radius * radius) continue;
        if (distance.distanceSq < bestDistance) {
          bestDistance = distance.distanceSq;
          best = { kind, entity };
        }
      }
    }
    return best;
  }

  function selectAtScreen(clientX: number, clientY: number): boolean {
    const ray = screenToRay(clientX, clientY);
    if (!ray) return false;
    const hit = pickMarker(ray);
    if (!hit) {
      setSelection(null);
      return false;
    }
    setSelection(hit);
    return true;
  }

  function selectAtCrosshair(): boolean {
    const ray = crosshairRay();
    if (!ray) return false;
    const hit = pickMarker(ray);
    if (!hit) {
      setSelection(null);
      return false;
    }
    setSelection(hit);
    return true;
  }

  function getCrosshairTarget(): CrosshairTarget {
    const ray = crosshairRay();
    if (!ray) {
      return {
        kind: 'empty',
        position: null,
        source: 'none',
      };
    }
    const item = pickMarker(ray);
    if (item) {
      const index = markers[item.kind].indexOf(item.entity);
      const pos = item.entity.getPosition();
      return {
        kind: item.kind,
        index,
        name: item.entity.name || `${item.kind}_${index + 1}`,
        type: item.kind === 'staging' ? 'prop_staging' : item.kind,
        position: [pos.x, pos.y, pos.z],
      };
    }

    const groundHit = raycastRayToHorizontalPlane(ray, STAGE_GROUND_Y);
    if (groundHit) {
      return {
        kind: 'surface',
        position: [groundHit.x, groundHit.y, groundHit.z],
        source: 'stage_ground',
      };
    }

    return {
      kind: 'empty',
      position: null,
      source: 'none',
    };
  }

  function clearSelection(): void {
    setSelection(null);
  }

  function getSelectionScreenPosition(): SelectionScreenPosition | null {
    if (!selection || !camera.camera) return null;
    // Project a point slightly above the entity top, so the tag floats over the head without being occluded.
    const worldPos = selection.entity.getPosition().clone();
    const localScale = selection.entity.getLocalScale();
    const lift = selection.kind === 'actor' ? 1.95 * localScale.y : 0.65 * localScale.y;
    worldPos.y += lift;
    const screen = camera.camera.worldToScreen(worldPos);
    const rect = canvas.getBoundingClientRect();
    const visible = screen.z > 0
      && screen.x >= 0 && screen.x <= rect.width
      && screen.y >= 0 && screen.y <= rect.height;
    return { x: screen.x, y: screen.y, visible };
  }

  // ---------- Selection operations ----------
  // actor uses root.y = ground.y (feet on the ground); prop / staging use the proxy's lowest point on the ground.
  function placeOnGround(kind: MarkerKind, entity: pc.Entity, x: number, groundY: number, z: number): void {
    if (kind === 'actor') {
      entity.setPosition(x, groundY, z);
    } else {
      const scale = entity.getLocalScale();
      const hint = getEntityShapeHint(entity);
      entity.setPosition(x, groundY - scale.y * proxyLocalBottomForHint(hint), z);
    }
  }

  function getMarkerLabels(kind: MarkerKind): string[] {
    return markers[kind].map((entity, idx) => entity.name || `${kind}_${idx + 1}`);
  }

  function selectByIndex(kind: MarkerKind, index: number): boolean {
    const list = markers[kind];
    if (index < 0 || index >= list.length) return false;
    setSelection({ kind, entity: list[index] });
    return true;
  }

  function cycleSelection(kind: MarkerKind, dir: 1 | -1 = 1): boolean {
    const list = markers[kind];
    if (list.length === 0) return false;
    let nextIndex = 0;
    if (selection && selection.kind === kind) {
      const cur = list.indexOf(selection.entity);
      if (cur >= 0) nextIndex = (cur + dir + list.length) % list.length;
    }
    setSelection({ kind, entity: list[nextIndex] });
    return true;
  }

  function moveSelectedToCrosshair(): boolean {
    if (!selection) return false;
    const ray = crosshairRay();
    if (!ray) return false;
    if (selection.kind === 'actor') unmountActor(selection.entity);
    const current = selection.entity.getPosition();
    const hit = raycastRayToHorizontalPlane(ray, current.y);
    if (!hit) return false;
    selection.entity.setPosition(hit.x, current.y, hit.z);
    if (selection.kind !== 'actor') syncMountedActorsOf(selection.entity);
    updateSelectionMarker();
    emitSelection();
    return true;
  }

  function groundSelected(): boolean {
    if (!selection) return false;
    if (selection.kind === 'actor') unmountActor(selection.entity);
    const pos = selection.entity.getPosition();
    placeOnGround(selection.kind, selection.entity, pos.x, groundYAt(pos.x, pos.z), pos.z);
    if (selection.kind !== 'actor') syncMountedActorsOf(selection.entity);
    emitSelection();
    return true;
  }

  function rotateSelected(deg: number): boolean {
    if (!selection) return false;
    const currentYaw = markerYaws.get(selection.entity) ?? selection.entity.getEulerAngles().y;
    const nextYaw = currentYaw + deg;
    markerYaws.set(selection.entity, nextYaw);
    selection.entity.setEulerAngles(0, nextYaw, 0);
    if (selection.kind !== 'actor') syncMountedActorsOf(selection.entity);
    emitSelection();
    return true;
  }

  function scaleSelected(factor: number): boolean {
    if (!selection || !Number.isFinite(factor) || factor <= 0) return false;
    const s = selection.entity.getLocalScale();
    // prop / staging are clamped by the shape_hint's scale limits; actors are unconstrained (the director state may need
    // giants / dwarfs). Reproduces the manual editing path of BuilderGPT normalizedPropScale.
    let nextArr: [number, number, number] = [s.x * factor, s.y * factor, s.z * factor];
    if (selection.kind !== 'actor') {
      const hint = getEntityShapeHint(selection.entity);
      nextArr = clampScaleToHint(hint, nextArr);
    }
    const next = new pc.Vec3(nextArr[0], nextArr[1], nextArr[2]);
    // When min/max is already reached the factor is ineffective -> return early, avoiding meaningless grounding / syncing.
    if (next.x === s.x && next.y === s.y && next.z === s.z) return false;
    // After scaling, the proxy's lowest point must stay at the original ground height.
    const pos = selection.entity.getPosition();
    selection.entity.setLocalScale(next);
    if (selection.kind !== 'actor') {
      const hint = getEntityShapeHint(selection.entity);
      const ground = pos.y + s.y * proxyLocalBottomForHint(hint);
      selection.entity.setPosition(pos.x, ground - next.y * proxyLocalBottomForHint(hint), pos.z);
      syncMountedActorsOf(selection.entity);
    }
    emitSelection();
    return true;
  }

  function topCenterWorldPosition(propEntity: pc.Entity): pc.Vec3 {
    const pos = propEntity.getPosition();
    const scale = propEntity.getLocalScale();
    return new pc.Vec3(pos.x, pos.y + scale.y / 2, pos.z);
  }

  function mountTargetWorldPosition(propEntity: pc.Entity): pc.Vec3 {
    const point = attachmentPointForProp(propEntity);
    if (!point) return topCenterWorldPosition(propEntity);
    const propPos = propEntity.getPosition();
    const propScale = propEntity.getLocalScale();
    const propYawRad = propEntity.getEulerAngles().y * pc.math.DEG_TO_RAD;
    const [ox, oy, oz] = rotatedOffsetY(
      [point.offset[0] * propScale.x, point.offset[1] * propScale.y, point.offset[2] * propScale.z],
      propYawRad,
    );
    return new pc.Vec3(propPos.x + ox, propPos.y + oy, propPos.z + oz);
  }

  function pickMountTargetAtRay(ray: pc.Ray, ignoreActor?: pc.Entity): MountTarget | null {
    let best: MountTarget | null = null;
    let bestDistance = Infinity;
    const hitPoint = new pc.Vec3();
    const kinds: Array<'prop' | 'staging'> = ['prop', 'staging'];
    for (const kind of kinds) {
      for (const entity of markers[kind]) {
        const point = attachmentPointForProp(entity);
        if (!point) continue;
        const renders = entity.findComponents('render') as pc.RenderComponent[];
        for (const render of renders) {
          for (const meshInstance of render.meshInstances ?? []) {
            const aabb = meshInstance.aabb;
            if (!aabb || !aabb.intersectsRay(ray, hitPoint)) continue;
            const distance = hitPoint.distance(ray.origin);
            if (distance < bestDistance) {
              bestDistance = distance;
              best = { kind, entity, attachPointId: point.id };
            }
          }
        }
      }
    }
    if (best) return best;

    for (const kind of kinds) {
      for (const entity of markers[kind]) {
        if (entity === ignoreActor) continue;
        const point = attachmentPointForProp(entity);
        if (!point) continue;
        const candidate = mountTargetWorldPosition(entity);
        const radius = markerPickRadius(kind, entity);
        const distance = distanceSqPointToRay(
          [ray.origin.x, ray.origin.y, ray.origin.z],
          [ray.direction.x, ray.direction.y, ray.direction.z],
          [candidate.x, candidate.y, candidate.z],
        );
        if (distance.along <= 0 || distance.distanceSq > radius * radius) continue;
        if (distance.distanceSq < bestDistance) {
          bestDistance = distance.distanceSq;
          best = { kind, entity, attachPointId: point.id };
        }
      }
    }
    return best;
  }

  function actorAnchorSeatLocal(actorRoot: pc.Entity): [number, number, number] {
    const scale = actorRoot.getLocalScale();
    return [0, 0.8 * scale.y, 0];
  }

  const ACTOR_STATE_TO_POSE: Record<ActorState, PoseName> = {
    standing: 'standing',
    sitting: 'sitting',
    mounted: 'sitting',
    operating: 'interacting',
    lying: 'lying',
  };

  function alignActorOnProp(actor: pc.Entity, prop: pc.Entity, attachPointId: string): void {
    const point = attachmentPointForProp(prop, attachPointId);
    if (!point) return;
    const propPos = prop.getPosition();
    const propScale = prop.getLocalScale();
    const propYawDeg = prop.getEulerAngles().y;
    const propYawRad = propYawDeg * pc.math.DEG_TO_RAD;
    const [ox, oy, oz] = rotatedOffsetY(
      [point.offset[0] * propScale.x, point.offset[1] * propScale.y, point.offset[2] * propScale.z],
      propYawRad,
    );
    const actorYawRad = propYawRad + Number(point.facing_delta ?? 0);
    const actorYawDeg = ((actorYawRad * pc.math.RAD_TO_DEG) % 360 + 540) % 360 - 180;
    const [sx, sy, sz] = rotatedOffsetY(actorAnchorSeatLocal(actor), actorYawRad);
    actor.setPosition(propPos.x + ox - sx, propPos.y + oy - sy, propPos.z + oz - sz);
    actor.setEulerAngles(0, actorYawDeg, 0);
    markerYaws.set(actor, actorYawDeg);
  }

  function mountActorOn(actor: pc.Entity, target: MountTarget): void {
    const point = attachmentPointForProp(target.entity, target.attachPointId);
    if (!point) return;
    mountLinks.set(actor, target);
    const pose = ACTOR_STATE_TO_POSE[point.actor_state] ?? 'sitting';
    actorPoses.set(actor, pose);
    applyActorPose(actor, pose);
    alignActorOnProp(actor, target.entity, target.attachPointId);
  }

  function unmountActor(actor: pc.Entity): boolean {
    if (!mountLinks.has(actor)) return false;
    mountLinks.delete(actor);
    actorPoses.set(actor, 'standing');
    applyActorPose(actor, 'standing');
    return true;
  }

  function syncMountedActorsOf(prop: pc.Entity): void {
    for (const actor of markers.actor) {
      const link = mountLinks.get(actor);
      if (link?.entity === prop) alignActorOnProp(actor, prop, link.attachPointId);
    }
  }

  function mountSelectedAtCrosshair(): boolean {
    if (!selection || selection.kind !== 'actor') return false;
    const ray = crosshairRay();
    if (!ray) return false;
    const target = pickMountTargetAtRay(ray, selection.entity);
    if (!target) return false;
    mountActorOn(selection.entity, target);
    updateSelectionMarker();
    emitSelection();
    return true;
  }

  function unmountSelected(): boolean {
    if (!selection || selection.kind !== 'actor') return false;
    const ok = unmountActor(selection.entity);
    if (ok) {
      updateSelectionMarker();
      emitSelection();
    }
    return ok;
  }

  function isSelectedMounted(): boolean {
    if (!selection || selection.kind !== 'actor') return false;
    return mountLinks.has(selection.entity);
  }

  function getMarkerShapeHint(kind: 'prop' | 'staging', index: number): ShapeHintName | null {
    const entity = markers[kind][index];
    if (!entity) return null;
    return getEntityShapeHint(entity);
  }

  function setSelectedShapeHint(hint: ShapeHintName): boolean {
    if (!selection) return false;
    if (selection.kind !== 'staging') return false;
    if (!(hint in SHAPE_HINTS)) return false;
    const previousHint = getEntityShapeHint(selection.entity);
    const position = selection.entity.getPosition();
    const scale = selection.entity.getLocalScale();
    const groundY = position.y + scale.y * proxyLocalBottomForHint(previousHint);
    markerShapeHints.set(selection.entity, hint);
    rebuildShapeHintProxy(selection.entity, hint, markerColors.get(selection.entity) ?? '#ffd34d');
    selection.entity.setPosition(position.x, groundY - scale.y * proxyLocalBottomForHint(hint), position.z);
    syncMountedActorsOf(selection.entity);
    emitSelection();
    return true;
  }

  function getActorPose(index: number): PoseName | null {
    const e = markers.actor[index];
    if (!e) return null;
    return actorPoses.get(e) ?? 'standing';
  }

  function setSelectedPose(pose: PoseName): boolean {
    if (!selection || selection.kind !== 'actor') return false;
    if (!POSES.includes(pose)) return false;
    applyActorPose(selection.entity, pose);
    actorPoses.set(selection.entity, pose);
    const link = mountLinks.get(selection.entity);
    if (link) alignActorOnProp(selection.entity, link.entity, link.attachPointId);
    emitSelection();
    return true;
  }

  function cycleSelectedPose(dir: 1 | -1 = 1): boolean {
    if (!selection || selection.kind !== 'actor') return false;
    const cur = actorPoses.get(selection.entity) ?? 'standing';
    return setSelectedPose(nextPose(cur, dir));
  }

  function isSelectedActionPlaying(): boolean | null {
    if (!selection || selection.kind !== 'actor') return null;
    return actorActionPlaying.get(selection.entity) ?? true;
  }

  function setSelectedActionPlaying(playing: boolean): boolean {
    if (!selection || selection.kind !== 'actor') return false;
    setActorAnimationPlayback(selection.entity, playing);
    emitSelection();
    return true;
  }

  function setSelectedLabel(label: string): boolean {
    if (!selection) return false;
    const next = label.trim();
    if (!next) return false;
    selection.entity.name = next;
    emitSelection();
    return true;
  }

  function nudgeSelected(dx: number, dy: number, dz: number): boolean {
    if (!selection) return false;
    if (selection.kind === 'actor') unmountActor(selection.entity);
    const p = selection.entity.getPosition();
    selection.entity.setPosition(p.x + dx, p.y + dy, p.z + dz);
    if (selection.kind !== 'actor') syncMountedActorsOf(selection.entity);
    emitSelection();
    return true;
  }

  function lookAtSelected(durationMs = 300): boolean {
    if (!selection) return false;
    const target = selection.entity.getPosition();
    // The actor's anchor is at the feet; raise the line of sight to roughly chest height so the camera does not look at the feet.
    const lift = selection.kind === 'actor' ? 1.0 * selection.entity.getLocalScale().y : 0;
    fly.lookAtTarget(new pc.Vec3(target.x, target.y + lift, target.z), durationMs);
    return true;
  }

  // Center point of the selected object (actors use chest height, prop / staging use the entity's current position).
  function selectionCenter(): pc.Vec3 | null {
    if (!selection) return null;
    const pos = selection.entity.getPosition();
    if (selection.kind === 'actor') {
      return new pc.Vec3(pos.x, pos.y + 1.0 * selection.entity.getLocalScale().y, pos.z);
    }
    return pos.clone();
  }

  function fitView(): boolean {
    const target = sceneCenter.clone();
    const offset = new pc.Vec3(sceneRadiusValue * 0.15, sceneRadiusValue * 1.15, sceneRadiusValue * 0.2);
    fly.setCameraByOffset(target, offset);
    return true;
  }

  // Default view when entering the scene interior: stand near sceneCenter looking at the center, to avoid the actualDistance ≈ 1.6 R
  // back-computed from INITIAL_ZOOM * R pushing the camera outside the room. Used by loadSplat / resetCamera.
  function enterDefaultInteriorView(): void {
    if (!(sceneRadiusValue > 0)) return;
    const r = sceneRadiusValue;
    const target = sceneCenter.clone();
    const offset = new pc.Vec3(r * 0.25, r * 0.18, r * 0.25);
    fly.setCameraByOffset(target, offset);
  }

  function cameraBehindSelected(): boolean {
    const center = selectionCenter();
    if (!center || !selection) return fitView();
    const yawRad = selection.entity.getEulerAngles().y * pc.math.DEG_TO_RAD;
    const offset = new pc.Vec3(Math.sin(yawRad) * 1.6, 0.45, Math.cos(yawRad) * 1.6);
    fly.setCameraByOffset(center, offset);
    return true;
  }

  function cameraFaceSelected(): boolean {
    const center = selectionCenter();
    if (!center || !selection) return fitView();
    const yawRad = selection.entity.getEulerAngles().y * pc.math.DEG_TO_RAD;
    const offset = new pc.Vec3(-Math.sin(yawRad) * 1.8, 0.45, -Math.cos(yawRad) * 1.8);
    fly.setCameraByOffset(center, offset);
    return true;
  }

  function deleteSelected(): boolean {
    if (!selection) return false;
    const list = markers[selection.kind];
    const idx = list.indexOf(selection.entity);
    if (idx < 0) {
      setSelection(null);
      return false;
    }
    const entity = selection.entity;
    if (selection.kind === 'actor') {
      mountLinks.delete(entity);
    } else {
      for (const actor of markers.actor) {
        const link = mountLinks.get(actor);
        if (link?.entity === entity) unmountActor(actor);
      }
    }
    list.splice(idx, 1);
    setSelection(null);
    entity.destroy();
    emitMarkers();
    return true;
  }

  // ---------- Scene snapshot: save / restore ----------
  function snapshotMarker(entity: pc.Entity, kind: MarkerKind): ThreeDMarkerSnapshot {
    const pos = entity.getPosition();
    const eul = entity.getEulerAngles();
    const scl = entity.getLocalScale();
    const position: [number, number, number] = [pos.x, pos.y, pos.z];
    const yawDeg = markerYaws.get(entity) ?? eul.y;
    const snap: ThreeDMarkerSnapshot = {
      label: entity.name,
      color: markerColors.get(entity) ?? (kind === 'actor' ? '#ff3344' : kind === 'staging' ? '#4587ff' : '#ffd34d'),
      placement: { space: 'world', position, yawDeg },
      position,
      yawDeg,
      scale: [scl.x, scl.y, scl.z],
    };
    if (kind === 'actor') {
      snap.pose = actorPoses.get(entity) ?? 'standing';
      snap.actionPlaying = actorActionPlaying.get(entity) ?? true;
      const link = mountLinks.get(entity);
      if (link) {
        const idx = markers[link.kind].indexOf(link.entity);
        if (idx >= 0) {
          snap.mount = { kind: link.kind, index: idx, attachPointId: link.attachPointId };
        }
      }
    } else {
      snap.shapeHint = getEntityShapeHint(entity);
    }
    return snap;
  }

  function exportSceneSnapshot(): ThreeDSceneSnapshot {
    return {
      schemaVersion: 1,
      savedAt: Date.now(),
      actors: markers.actor.map((e) => snapshotMarker(e, 'actor')),
      props: markers.prop.map((e) => snapshotMarker(e, 'prop')),
      stagings: markers.staging.map((e) => snapshotMarker(e, 'staging')),
      world: {
        splatYOffset: sourceTransform.yOffset,
        sourceTransform,
      },
      camera: fly.getCameraState(),
    };
  }

  // Rebuild a marker from a snapshot; does not go through placeMarker since that needs a crosshair raycast,
  // on restore it lands directly at the stored position/yaw/scale.
  function restoreMarker(kind: MarkerKind, snap: ThreeDMarkerSnapshot): pc.Entity | null {
    const color = parseHex(snap.color);
    const transform = resolveSnapshotWorldTransform(snap);
    if (!transform) {
      console.warn(
        `[viewer] skipping ${kind} "${snap.label}" during PlayCanvas restore: unsupported placement space "${snap.placement?.space ?? 'unknown'}"`,
      );
      return null;
    }
    let entity: pc.Entity;
    if (kind === 'actor') {
      entity = instantiateActorProxyModel(color);
      entity.name = snap.label || `marker_actor_${markers.actor.length + 1}`;
      entity.setLocalScale(snap.scale[0], snap.scale[1], snap.scale[2]);
      entity.setPosition(transform.position[0], transform.position[1], transform.position[2]);
      entity.setEulerAngles(0, transform.yawDeg, 0);
      markerYaws.set(entity, transform.yawDeg);
      const pose = requirePoseName(snap.pose, `snapshot pose for "${snap.label}"`);
      actorPoses.set(entity, pose);
      actorActionPlaying.set(entity, snap.actionPlaying ?? true);
      actorProxyMaterialColors.set(entity, snap.color);
      applyActorProxyMaterial(entity, snap.color);
      applyActorPose(entity, pose);
    } else {
      entity = new pc.Entity(snap.label || `marker_${kind}_${markers[kind].length + 1}`);
      entity.setLocalScale(snap.scale[0], snap.scale[1], snap.scale[2]);
      entity.setPosition(transform.position[0], transform.position[1], transform.position[2]);
      entity.setEulerAngles(0, transform.yawDeg, 0);
      markerYaws.set(entity, transform.yawDeg);
      const hint: ShapeHintName = snap.shapeHint && (snap.shapeHint in SHAPE_HINTS)
        ? snap.shapeHint
        : (kind === 'staging' ? 'generic_large' : 'box');
      markerShapeHints.set(entity, hint);
      rebuildShapeHintProxy(entity, hint, snap.color);
    }
    markerColors.set(entity, snap.color);
    app.root.addChild(entity);
    markers[kind].push(entity);
    return entity;
  }

  function loadSceneSnapshot(snap: ThreeDSceneSnapshot): void {
    if (!snap || snap.schemaVersion !== 1) {
      console.warn('[viewer] loadSceneSnapshot: unsupported schema', snap?.schemaVersion);
      return;
    }
    // Clear the stage: destroy existing markers + clear selection + clear the pose/color WeakMaps (GC is automatic).
    clearMarkers();
    if (snap.world?.sourceTransform) {
      sourceTransform = normalizeDirectorWorldSourceTransform(snap.world.sourceTransform);
      applySourceTransform();
    } else if (snap.world && typeof snap.world.splatYOffset === 'number' && Number.isFinite(snap.world.splatYOffset)) {
      sourceTransform = normalizeDirectorWorldSourceTransform({
        ...sourceTransform,
        yOffset: snap.world.splatYOffset,
      });
      applySourceTransform();
    }
    for (const s of snap.props ?? []) restoreMarker('prop', s);
    for (const s of snap.stagings ?? []) restoreMarker('staging', s);
    for (const s of snap.actors ?? []) {
      const actor = restoreMarker('actor', s);
      if (!actor || !s.mount) continue;
      const target = markers[s.mount.kind][s.mount.index];
      if (target) {
        mountActorOn(actor, { kind: s.mount.kind, entity: target, attachPointId: s.mount.attachPointId || '' });
      }
    }
    if (snap.camera) fly.setCameraState(snap.camera);
    emitMarkers();
    emitSelection();
  }

  function captureScreenshot(options?: CaptureScreenshotOptions): string | null {
    const markerEntities = [
      ...markers.actor,
      ...markers.prop,
      ...markers.staging,
    ];
    const renderMode = options?.renderMode ?? (options?.markers === false ? 'env_only' : 'combined');
    const hideEditorOverlays = shouldHideEditorOverlaysForCapture(renderMode);
    const hiddenMarkers = renderMode === 'env_only';
    const hideWorld = renderMode === 'actor_overlay_black' || renderMode === 'actor_mask';
    const hideNonActors = renderMode === 'actor_mask';
    const forceActorMaskMaterial = renderMode === 'actor_mask';
    const markerEnabled = markerEntities.map((entity) => entity.enabled);
    const propEnabled = [...markers.prop, ...markers.staging].map((entity) => entity.enabled);
    const selectionMarkerEnabled = selectionMarker?.enabled ?? null;
    const hitMarkerEnabledBefore = hitMarker?.enabled ?? null;
    const splatEnabled = splatEntity?.enabled ?? null;
    const collisionEnabled = collisionEntity?.enabled ?? null;
    const axesVisibleBefore = axesGrid.isVisible?.() ?? null;
    const translateGizmoEnabledBefore = translateGizmoEnabled;
    const originalMaterials: Array<{ meshInstance: pc.MeshInstance; material: pc.Material | null }> = [];
    let maskMaterial: pc.StandardMaterial | null = null;
    try {
      setTranslateGizmoEnabled(false);
      if (hideEditorOverlays) {
        if (selectionMarker) selectionMarker.enabled = false;
        if (hitMarker) hitMarker.enabled = false;
        if (collisionEntity) collisionEntity.enabled = false;
        axesGrid.setVisible(false);
      }
      if (hiddenMarkers) {
        for (const entity of markerEntities) entity.enabled = false;
        if (selectionMarker) selectionMarker.enabled = false;
      }
      if (hideWorld) {
        if (splatEntity) splatEntity.enabled = false;
        if (collisionEntity) collisionEntity.enabled = false;
        axesGrid.setVisible(false);
      }
      if (hideNonActors) {
        for (const entity of [...markers.prop, ...markers.staging]) entity.enabled = false;
        if (selectionMarker) selectionMarker.enabled = false;
      }
      if (forceActorMaskMaterial) {
        maskMaterial = makeFlatMaterial(new pc.Color(1, 1, 1));
        for (const actor of markers.actor) {
          for (const render of actor.findComponents('render') as pc.RenderComponent[]) {
            for (const meshInstance of render.meshInstances ?? []) {
              originalMaterials.push({ meshInstance, material: meshInstance.material });
              meshInstance.material = maskMaterial;
            }
          }
        }
      }
      // preserveDrawingBuffer:true is already on; force one render so the latest frame is guaranteed written.
      app.render();
      const rect = calculateFrameCaptureRect({
        canvasWidth: canvas.width,
        canvasHeight: canvas.height,
        clientWidth: canvas.clientWidth,
        clientHeight: canvas.clientHeight,
        canvasRectCss: canvas.getBoundingClientRect(),
        frameRectCss: options?.frameRectCss,
        frameAspect: options?.frameAspect,
        paddingCssPx: options?.framePaddingCssPx,
      });
      const maxLongEdge = Number.isFinite(options?.maxLongEdge)
        ? Math.max(1, Math.floor(options?.maxLongEdge ?? 0))
        : 0;
      const outputScale = maxLongEdge > 0
        ? Math.min(1, maxLongEdge / Math.max(rect.sw, rect.sh))
        : 1;
      if (
        outputScale >= 1 &&
        rect.sx === 0 &&
        rect.sy === 0 &&
        rect.sw === canvas.width &&
        rect.sh === canvas.height
      ) {
        return canvas.toDataURL('image/png');
      }
      const outputCanvas = document.createElement('canvas');
      outputCanvas.width = Math.max(1, Math.round(rect.sw * outputScale));
      outputCanvas.height = Math.max(1, Math.round(rect.sh * outputScale));
      const context = outputCanvas.getContext('2d');
      if (!context) return canvas.toDataURL('image/png');
      context.imageSmoothingEnabled = renderMode === 'env_only';
      context.drawImage(
        canvas,
        rect.sx,
        rect.sy,
        rect.sw,
        rect.sh,
        0,
        0,
        outputCanvas.width,
        outputCanvas.height,
      );
      return outputCanvas.toDataURL('image/png');
    } catch (error) {
      console.warn('[viewer] screenshot failed', error);
      return null;
    } finally {
      for (const item of originalMaterials) {
        if (item.material) item.meshInstance.material = item.material;
      }
      if (maskMaterial) maskMaterial.destroy();
      for (let index = 0; index < markerEntities.length; index += 1) {
        markerEntities[index].enabled = markerEnabled[index] ?? true;
      }
      for (let index = 0; index < markers.prop.length + markers.staging.length; index += 1) {
        const entity = [...markers.prop, ...markers.staging][index];
        if (entity) entity.enabled = propEnabled[index] ?? true;
      }
      if (selectionMarker && selectionMarkerEnabled !== null) {
        selectionMarker.enabled = selectionMarkerEnabled;
      }
      if (hitMarker && hitMarkerEnabledBefore !== null) hitMarker.enabled = hitMarkerEnabledBefore;
      if (splatEntity && splatEnabled !== null) splatEntity.enabled = splatEnabled;
      if (collisionEntity && collisionEnabled !== null) collisionEntity.enabled = collisionEnabled;
      if (axesVisibleBefore !== null) axesGrid.setVisible(axesVisibleBefore);
      setTranslateGizmoEnabled(translateGizmoEnabledBefore);
    }
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    app.off('update', updateHandler);
    resizeObserver.disconnect();
    fly.destroy();
    clearMarkers();
    clearSplat();
    clearPanoEnvironment();
    if (collisionEntity) {
      collisionEntity.destroy();
      collisionEntity = null;
    }
    collisionMeshInstances = [];
    if (selectionMarker) {
      selectionMarker.destroy();
      selectionMarker = null;
    }
    if (hitMarker) {
      hitMarker.destroy();
      hitMarker = null;
    }
    if (translateGizmo) {
      try { translateGizmo.destroy(); } catch (_) { /* ignore */ }
      translateGizmo = null;
    }
    translateGizmoLayer = null;
    translateGizmoAttachedEntity = null;
    app.destroy();
    statusListeners.clear();
    markerListeners.clear();
    selectionListeners.clear();
    selection = null;
  }

  await loadActorProxyModel();

  return {
    app,
    camera,
    fly,
    axesGrid,
    loadSplat,
    loadPano,
    clearWorldSource,
    loadCollision,
    hasCollision: () => collisionMeshInstances.length > 0,
    setCollisionVisible,
    setHitMarkerEnabled,
    isHitMarkerEnabled: () => hitMarkerEnabled,
    resetCamera: () => {
      if (activePanoUrl) {
        fly.resetToInitial();
        return;
      }
      applyDefaultCameraForSplat(activeSplatUrl);
    },
    setStatus,
    onStatus(listener) {
      statusListeners.add(listener);
      listener(statusText);
      return () => statusListeners.delete(listener);
    },
    onSplatProgress(listener) {
      splatProgressListeners.add(listener);
      if (lastSplatProgress) listener(lastSplatProgress);
      return () => splatProgressListeners.delete(listener);
    },
    placeMarker,
    deleteLastMarker,
    clearMarkers,
    getMarkerCounts: () => ({
      actor: markers.actor.length,
      prop: markers.prop.length,
      staging: markers.staging.length,
    }),
    onMarkersChange(listener) {
      markerListeners.add(listener);
      listener({
        actor: markers.actor.length,
        prop: markers.prop.length,
        staging: markers.staging.length,
      });
      return () => markerListeners.delete(listener);
    },
    captureScreenshot,
    selectAtScreen,
    selectAtCrosshair,
    getCrosshairTarget,
    clearSelection,
    getSelection: describeSelection,
    onSelectionChange(listener) {
      selectionListeners.add(listener);
      listener(describeSelection());
      return () => selectionListeners.delete(listener);
    },
    getSelectionScreenPosition,
    getMarkerLabels,
    selectByIndex,
    getActorPose,
    setSelectedPose,
    cycleSelectedPose,
    isSelectedActionPlaying,
    setSelectedActionPlaying,
    mountSelectedAtCrosshair,
    unmountSelected,
    isSelectedMounted,
    setSelectedLabel,
    cycleSelection,
    moveSelectedToCrosshair,
    groundSelected,
    rotateSelected,
    scaleSelected,
    nudgeSelected,
    lookAtSelected,
    setTranslateGizmoEnabled,
    isTranslateGizmoEnabled,
    nudgeWorldYOffset,
    resetWorldYOffset,
    getWorldYOffset() {
      return sourceTransform.yOffset;
    },
    getSourceTransform() {
      return { ...sourceTransform };
    },
    setSourceTransform,
    resetSourceTransform,
    exportSceneSnapshot,
    loadSceneSnapshot,
    fitView,
    cameraBehindSelected,
    cameraFaceSelected,
    getMarkerShapeHint,
    setSelectedShapeHint,
    deleteSelected,
    destroy,
  };
}

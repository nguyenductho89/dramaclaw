// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useMemo, useRef } from 'react';

import './multi-angle-sphere.css';

export interface MultiAngleSphereProps {
  /** 0..360, 0 front / 90 right / 180 back / 270 left. */
  horizontalDeg: number;
  /** -90..90, positive = looking down / negative = looking up. */
  verticalDeg: number;
  /** Relative size of the center reference image (the closer the shot size, the larger). */
  imageScale: number;
  imageSource: string;
  onAngleChange: (next: { horizontalDeg: number; verticalDeg: number }) => void;
}

// Sphere radius (px); the scene is designed as about 200px square, leaving room around for the arrow keys.
const RADIUS = 78;
// Meridians: one vertical great circle every 15 degrees.
const MERIDIAN_STEP = 15;
const MERIDIAN_COUNT = 180 / MERIDIAN_STEP;
// Parallels: 4 circles each in the north and south.
const PARALLEL_LATITUDES = [15, 30, 45, 60];
// Drag sensitivity (px -> degrees).
const DRAG_SENSITIVITY = 0.6;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function ChevronUp() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 14L11.65 10.35a.5.5 0 0 1 .7 0L16 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChevronDownIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M8 10L11.65 13.65a.5.5 0 0 0 .7 0L16 10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChevronLeftIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M13.8 16L10.15 12.35a.5.5 0 0 1 0-.7L13.8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function ChevronRightIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M10 16L13.65 12.35a.5.5 0 0 0 0-.7L10 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * A libtv-style 3D wireframe sphere angle adjustment area: a CSS 3D globe of latitude and longitude lines + a 3D small camera orbiting along the sphere surface
 * + a reference image at the center facing the viewer + four directional nudge buttons. Dragging changes the azimuth/elevation angle.
 *
 * verticalDeg -> the sphere's rotateX (elevation), horizontalDeg -> rotateY (azimuth). The camera hangs in the same
 * pivot, pushed along +Z to the sphere surface `translateZ(RADIUS)`, so it orbits around the center along with the pivot.
 */
export function MultiAngleSphere({
  horizontalDeg,
  verticalDeg,
  imageScale,
  imageSource,
  onAngleChange,
}: MultiAngleSphereProps) {
  // The center reference image size scales with the shot size.
  const cardW = clamp(56 + 64 * imageScale, 64, 104);
  const cardH = clamp(38 + 44 * imageScale, 46, 74);

  const meridians = useMemo(
    () => Array.from({ length: MERIDIAN_COUNT }, (_, i) => i * MERIDIAN_STEP),
    [],
  );
  const parallels = useMemo(
    () =>
      PARALLEL_LATITUDES.flatMap((lat) => [lat, -lat]).map((lat) => {
        const rad = (lat * Math.PI) / 180;
        const ringRadius = RADIUS * Math.cos(rad);
        const offsetY = RADIUS * Math.sin(rad);
        return { lat, ringRadius, offsetY };
      }),
    [],
  );

  const handlePointerDown = useCallback(
    (event: React.PointerEvent<HTMLDivElement>) => {
      // The directional keys handle clicks themselves, so do not let the drag logic fire too.
      if ((event.target as HTMLElement).closest('.ma-dir-btn')) return;
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      target.setPointerCapture(event.pointerId);
      let lastX = event.clientX;
      let lastY = event.clientY;
      let yaw = horizontalDeg;
      let pitch = verticalDeg;

      const handleMove = (ev: PointerEvent) => {
        ev.preventDefault();
        const dx = ev.clientX - lastX;
        const dy = ev.clientY - lastY;
        lastX = ev.clientX;
        lastY = ev.clientY;
        yaw = (((yaw + dx * DRAG_SENSITIVITY) % 360) + 360) % 360;
        pitch = clamp(pitch - dy * DRAG_SENSITIVITY, -90, 90);
        onAngleChange({ horizontalDeg: yaw, verticalDeg: pitch });
      };
      const handleUp = (ev: PointerEvent) => {
        target.releasePointerCapture(ev.pointerId);
        target.removeEventListener('pointermove', handleMove);
        target.removeEventListener('pointerup', handleUp);
      };
      target.addEventListener('pointermove', handleMove);
      target.addEventListener('pointerup', handleUp);
    },
    [horizontalDeg, verticalDeg, onAngleChange],
  );

  const nudge = useCallback(
    (dh: number, dv: number) => {
      onAngleChange({
        horizontalDeg: (((horizontalDeg + dh) % 360) + 360) % 360,
        verticalDeg: clamp(verticalDeg + dv, -90, 90),
      });
    },
    [horizontalDeg, verticalDeg, onAngleChange],
  );

  // horizontalDeg is a display value normalized to 0..360 (driving the slider/number box/backend). Feeding it directly to
  // rotateY would make the CSS transition spin a whole circle backwards at the 359 <-> 0 boundary. Here a "continuous"
  // yaw accumulator is maintained: each time it approaches the target angle by the shortest path (landing within +-180 degrees), so the sphere always turns the nearest way.
  const continuousYawRef = useRef(horizontalDeg);
  const shortestDelta = (((horizontalDeg - continuousYawRef.current) % 360) + 540) % 360 - 180;
  const continuousYaw = continuousYawRef.current + shortestDelta;
  continuousYawRef.current = continuousYaw;

  // Sphere rotation: elevation uses rotateX (negated so "looking down = positive" looks downward), azimuth uses rotateY.
  const pivotStyle = {
    ['--ma-pitch' as string]: `${-verticalDeg}deg`,
    ['--ma-yaw' as string]: `${continuousYaw}deg`,
  } as React.CSSProperties;

  return (
    <div className="ma-scene" onPointerDown={handlePointerDown}>
      {/* Shared 3D world: the rotating sphere/camera + the center reference image, all sorted by Z depth */}
      <div className="ma-world">
      {/* Rotation pivot: wireframe sphere + orbiting camera */}
      <div className="ma-pivot" style={pivotStyle}>
        {/* Meridians (vertical great circles) */}
        {meridians.map((deg) => (
          <div
            key={`mer-${deg}`}
            className="ma-ring ma-meridian"
            style={{
              width: RADIUS * 2,
              height: RADIUS * 2,
              marginLeft: -RADIUS,
              marginTop: -RADIUS,
              transform: `rotateY(${deg}deg)`,
            }}
          />
        ))}
        {/* Equator (horizontal great circle) */}
        <div
          className="ma-ring ma-meridian"
          style={{
            width: RADIUS * 2,
            height: RADIUS * 2,
            marginLeft: -RADIUS,
            marginTop: -RADIUS,
            transform: 'rotateX(90deg)',
          }}
        />
        {/* Parallels (horizontal circles, shifted up and down by latitude) */}
        {parallels.map(({ lat, ringRadius, offsetY }) => (
          <div
            key={`par-${lat}`}
            className="ma-ring ma-parallel"
            style={{
              width: ringRadius * 2,
              height: ringRadius * 2,
              marginLeft: -ringRadius,
              marginTop: -ringRadius,
              transform: `translateY(${-offsetY}px) rotateX(90deg)`,
            }}
          />
        ))}

        {/* Orbiting camera: pushed to the front point of the sphere, rotating with the pivot, i.e. orbiting around the center */}
        <div className="ma-camera" style={{ transform: `translateZ(${RADIUS}px)` }}>
          {/* Camera -> sphere center connector */}
          <div className="ma-camera-line" style={{ height: RADIUS }} />
          <div className="ma-camera-body">
            <div className="ma-camera-face ma-camera-face-front">
              <span className="ma-camera-lens" />
            </div>
            <div
              className="ma-camera-face ma-camera-face-back"
              style={{ backgroundImage: `url("${imageSource}")` }}
            />
            <div className="ma-camera-face ma-camera-face-right" />
            <div className="ma-camera-face ma-camera-face-left" />
            <div className="ma-camera-face ma-camera-face-top" />
            <div className="ma-camera-face ma-camera-face-bottom" />
          </div>
        </div>
      </div>

      {/* Center reference image: at the sphere center, always facing the viewer; in the same 3D world as the camera, occluded correctly by Z */}
      <div className="ma-center-image" style={{ width: cardW, height: cardH }}>
        <img src={imageSource} alt="" draggable={false} />
      </div>
      </div>

      {/* Four-direction nudge */}
      <button type="button" className="ma-dir-btn ma-dir-up" onClick={() => nudge(0, 15)} aria-label="up">
        <ChevronUp />
      </button>
      <button type="button" className="ma-dir-btn ma-dir-down" onClick={() => nudge(0, -15)} aria-label="down">
        <ChevronDownIcon />
      </button>
      <button type="button" className="ma-dir-btn ma-dir-left" onClick={() => nudge(-15, 0)} aria-label="left">
        <ChevronLeftIcon />
      </button>
      <button type="button" className="ma-dir-btn ma-dir-right" onClick={() => nudge(15, 0)} aria-label="right">
        <ChevronRightIcon />
      </button>
    </div>
  );
}

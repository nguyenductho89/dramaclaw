// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  isMyBuddyAction,
  MYBUDDY_ACTIONS,
  type MyBuddyAction,
} from "@/features/companion/mybuddy-actions";
import { PikoActionTransition } from "@/features/companion/PikoActionTransition";
import { SpritePetCompanion } from "@/features/companion/petdex/SpritePetCompanion";
import {
  loadImportedPets,
  type ImportedPetEntry,
} from "@/features/companion/petdex/petdex-storage";
import {
  PETDEX_STATE_OPTIONS,
  PETDEX_STATES,
  PIKO_COMPANION_KIND,
  type PetdexStateName,
} from "@/features/companion/petdex/petdex-pets";
import { useAppStore } from "@/stores/app-store";
import { useTaskCenterStore } from "@/task-center/store";
import { displayLabel, isActive, isTerminal } from "@/task-center/derivations";
import {
  BUBBLE_FADE_OUT_MS,
  BUBBLE_VISIBLE_MS,
  FAILURE_ACTION_MS,
  SUCCESS_ACTION_MS,
  useMyBuddyCompanionController,
} from "@/features/companion/use-mybuddy-companion-controller";
import { useRewardEventsStore } from "@/features/rewards/reward-events-store";
import { openVersionUpdateDialog } from "@/features/version-update/version-update-events";

/** Bubble visible duration is aligned with the pet action duration by event kind (the bubble wraps up in sync when the success/failure animation ends),
 * and shares the same fade-out rhythm as the Piko bubble ({@link BUBBLE_FADE_OUT_MS}). */
const PET_BUBBLE_VISIBLE_MS: Record<"running" | "success" | "failure", number> = {
  running: BUBBLE_VISIBLE_MS,
  success: SUCCESS_ACTION_MS,
  failure: FAILURE_ACTION_MS,
};

type DragPixel = {
  id: number;
  x: number;
  y: number;
  variant: number;
};

type CompanionDragPosition = {
  xPercent: number;
  yPercent: number;
};

type ViewportSize = {
  width: number;
  height: number;
};

const COMPANION_FIGURE_W = 72;
const COMPANION_FIGURE_H = 80;
const DRAG_TRAIL_MAX = 10;
const DRAG_TRAIL_LIFETIME_MS = 520;
const DRAG_TRAIL_DISTANCE_PX = 11;
const DRAG_TILT_MAX_DEG = 14;
const DRAG_TILT_FACTOR = 0.58;
const SHOW_PIKO_DEBUG = import.meta.env.VITE_PIKO_DEBUG === "true";

function currentViewportSize(): ViewportSize {
  if (typeof window === "undefined") return { width: 1280, height: 720 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function randomCompanionHomeXPercent() {
  const leftRange = [18, 40] as const;
  const rightRange = [60, 82] as const;
  const [min, max] = Math.random() < 0.5 ? leftRange : rightRange;
  return min + Math.random() * (max - min);
}

export function MyBuddyCompanion() {
  const { t } = useTranslation();
  const {
    action,
    bubbleKey,
    isBubbleLeaving,
    specialAction,
    isDiveRecovering,
    triggerDiveAction,
    festivalSkin,
    festivalPhase,
  } = useMyBuddyCompanionController();
  const [importRefreshKey, setImportRefreshKey] = useState(0);
  const [importedPets, setImportedPets] = useState<ImportedPetEntry[]>([]);
  const [homeXPercent] = useState(randomCompanionHomeXPercent);
  // Manual state override of the pet (null = follow system/task). Shared by the "state simulation" dropdown selection and click-pet cycling.
  const [petStateName, setPetStateName] = useState<PetdexStateName | null>(null);
  const [companionResetNonce, setCompanionResetNonce] = useState(0);
  const [draggingCompanion, setDraggingCompanion] = useState(false);
  const [dragPixels, setDragPixels] = useState<DragPixel[]>([]);
  const [dropRippleNonce, setDropRippleNonce] = useState(0);
  const [dropSettling, setDropSettling] = useState(false);
  const [dragPosition, setDragPosition] = useState<CompanionDragPosition | null>(null);
  const [pikoDebugAction, setPikoDebugAction] = useState<MyBuddyAction | null>(null);
  const [pikoDiveTargetX, setPikoDiveTargetX] = useState(0);
  const [viewportSize, setViewportSize] = useState(currentViewportSize);
  const floatingRef = useRef<HTMLDivElement | null>(null);
  const dragPixelIdRef = useRef(0);
  const dragPixelTimersRef = useRef<Set<number>>(new Set());
  const dragFrameRef = useRef<number | null>(null);
  const pendingDragPositionRef = useRef<CompanionDragPosition | null>(null);
  const releaseFrameRef = useRef<number | null>(null);
  const dropSettleTimerRef = useRef<number | null>(null);
  const companionKind = useAppStore((state) => state.companionKind);
  const companionPet = useAppStore((state) => state.companionPet);
  const pikoAccessory = useAppStore((state) => state.pikoAccessory);
  const companionXPercent = useAppStore((state) => state.companionXPercent);
  const companionYPercent = useAppStore((state) => state.companionYPercent);
  const companionHidden = useAppStore((state) => state.companionHidden);
  const setCompanionPosition = useAppStore((state) => state.setCompanionPosition);
  const triggerMockAccessoryUnlock = useRewardEventsStore((state) => state.triggerMockAccessoryUnlock);
  const triggerMockAccessoryBatchUnlock = useRewardEventsStore(
    (state) => state.triggerMockAccessoryBatchUnlock,
  );
  const isPiko = companionKind === PIKO_COMPANION_KIND;
  const pikoAction = isDiveRecovering ? action : pikoDebugAction ?? action;

  // Load imported pets (IndexedDB) and build a session-level blob URL for each. Reclaim strategy: after getting a new batch,
  // revoke the previous batch (rather than revoking first in cleanup - otherwise the URL of the pet currently on display would be
  // revoked early and flash on refresh), and reclaim the last batch on unmount.
  const importedUrlsRef = useRef<string[]>([]);
  useEffect(() => {
    let cancelled = false;
    loadImportedPets()
      .then((pets) => {
        if (cancelled) {
          pets.forEach((p) => URL.revokeObjectURL(p.spritesheetUrl));
          return;
        }
        const previous = importedUrlsRef.current;
        importedUrlsRef.current = pets.map((p) => p.spritesheetUrl);
        setImportedPets(pets);
        previous.forEach((url) => URL.revokeObjectURL(url));
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [importRefreshKey]);

  useEffect(() => {
    const refreshImportedPets = () => setImportRefreshKey((key) => key + 1);
    window.addEventListener("mybuddy-imported-pets-changed", refreshImportedPets);
    return () => window.removeEventListener("mybuddy-imported-pets-changed", refreshImportedPets);
  }, []);

  useEffect(
    () => () => {
      importedUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    },
    [],
  );

  useEffect(() => {
    const resetCompanionState = () => {
      setPetStateName(null);
      setPikoDebugAction(null);
      setCompanionResetNonce((nonce) => nonce + 1);
    };
    window.addEventListener("mybuddy-companion-reset", resetCompanionState);
    return () => window.removeEventListener("mybuddy-companion-reset", resetCompanionState);
  }, []);

  const importedBySlug = useMemo(
    () => new Map(importedPets.map((p) => [p.slug, p] as const)),
    [importedPets],
  );

  // Current pet: when an avatar is chosen the PetdexCatalogEntry is already stored in companionPet. Imported pets take the
  // session-level blob URL by slug (the persisted url is invalid after a refresh); built-in pets use companionPet directly.
  const activePet = useMemo(() => {
    if (isPiko || !companionPet) return null;
    if (companionPet.imported) return importedBySlug.get(companionPet.slug) ?? null;
    return companionPet;
  }, [isPiko, companionPet, importedBySlug]);

  // Pet bubble: following Piko - triggered by task "start / success / failure" events, shown for a few seconds then fades out.
  const tasks = useTaskCenterStore((state) => state.tasks);
  const [petBubble, setPetBubble] = useState<{
    kind: "running" | "success" | "failure";
    text: string;
  } | null>(null);
  const [petBubbleLeaving, setPetBubbleLeaving] = useState(false);
  const prevStatusRef = useRef<Map<string, string>>(new Map());
  const bubbleInitedRef = useRef(false);
  const bubbleTimerRef = useRef<number | null>(null);
  const bubbleLeaveTimerRef = useRef<number | null>(null);

  useEffect(() => {
    // Compare the previous frame's state by task key, to catch the "newly started / newly succeeded / newly failed" transitions.
    const current = new Map<string, string>();
    let event: { kind: "running" | "success" | "failure"; name: string } | null = null;
    for (const [key, task] of tasks) {
      current.set(key, task.status);
      const prev = prevStatusRef.current.get(key);
      if (!bubbleInitedRef.current || prev === task.status) continue;
      if (isActive(task)) event = { kind: "running", name: displayLabel(task, t) };
      else if (isTerminal(task) && task.status === "completed")
        event = { kind: "success", name: displayLabel(task, t) };
      else if (isTerminal(task) && task.status === "failed")
        event = { kind: "failure", name: displayLabel(task, t) };
    }
    prevStatusRef.current = current;
    if (!bubbleInitedRef.current) {
      // Record the baseline on the first frame; but if a task is already running right now, also pop one "in progress" bubble (otherwise a task
      // already running at mount would never get a bubble).
      bubbleInitedRef.current = true;
      const active = Array.from(tasks.values()).find(isActive);
      if (!active) return;
      event = { kind: "running", name: displayLabel(active, t) };
    }
    if (!event) return;
    const textKey =
      event.kind === "running"
        ? "myBuddy.taskRunning"
        : event.kind === "success"
          ? "myBuddy.taskSuccess"
          : "myBuddy.taskFailure";
    if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current);
    if (bubbleLeaveTimerRef.current) window.clearTimeout(bubbleLeaveTimerRef.current);
    setPetBubbleLeaving(false);
    setPetBubble({ kind: event.kind, text: t(textKey, { name: event.name }) });
    // Visible duration is aligned with the action animation by event kind (success 2.6s / failure 3.6s / in progress 3.5s) -> fade out -> unmount.
    const visibleMs = PET_BUBBLE_VISIBLE_MS[event.kind];
    bubbleTimerRef.current = window.setTimeout(() => setPetBubbleLeaving(true), visibleMs);
    bubbleLeaveTimerRef.current = window.setTimeout(
      () => setPetBubble(null),
      visibleMs + BUBBLE_FADE_OUT_MS,
    );
  }, [tasks, t]);

  useEffect(
    () => () => {
      if (bubbleTimerRef.current) window.clearTimeout(bubbleTimerRef.current);
      if (bubbleLeaveTimerRef.current) window.clearTimeout(bubbleLeaveTimerRef.current);
    },
    [],
  );

  useEffect(
    () => () => {
      dragPixelTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      dragPixelTimersRef.current.clear();
      if (dragFrameRef.current) window.cancelAnimationFrame(dragFrameRef.current);
      if (releaseFrameRef.current) window.cancelAnimationFrame(releaseFrameRef.current);
      if (dropSettleTimerRef.current) window.clearTimeout(dropSettleTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    const handleResize = () => setViewportSize(currentViewportSize());
    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  // Position: a percentage of the viewport width/height, freely draggable across the page. Before any drag, use the default landing spot (random x at the top).
  const xPercent = companionXPercent ?? homeXPercent;
  const yPercent = companionYPercent ?? 1;
  const displayXPercent = dragPosition?.xPercent ?? xPercent;
  const displayYPercent = dragPosition?.yPercent ?? yPercent;
  const displayLeftPx = Math.round((displayXPercent / 100) * viewportSize.width);
  const displayTopPx = Math.round((displayYPercent / 100) * viewportSize.height);
  const pikoDiveTargetY = Math.max(96, viewportSize.height - displayTopPx - 112);
  const pikoFigureStyle = {
    position: "absolute",
    top: 0,
    left: 0,
    "--mybuddy-dive-target-x": `${pikoDiveTargetX}px`,
    "--mybuddy-dive-target-y": `${pikoDiveTargetY}px`,
  } as CSSProperties;

  useLayoutEffect(() => {
    if (specialAction !== "dive") return;
    const leftBound = Math.max(-92, -displayLeftPx + 24);
    const rightBound = Math.min(92, viewportSize.width - displayLeftPx - COMPANION_FIGURE_W - 24);
    const rawOffset = (Math.random() < 0.5 ? -1 : 1) * (28 + Math.random() * 56);
    if (leftBound > rightBound) {
      setPikoDiveTargetX(0);
      return;
    }
    setPikoDiveTargetX(Math.min(Math.max(rawOffset, leftBound), rightBound));
  }, [displayLeftPx, specialAction, viewportSize.width]);

  const emitDragPixel = useCallback((x: number, y: number, variant: number) => {
    const id = dragPixelIdRef.current + 1;
    dragPixelIdRef.current = id;
    setDragPixels((pixels) => [...pixels.slice(-(DRAG_TRAIL_MAX - 1)), { id, x, y, variant }]);
    const timer = window.setTimeout(() => {
      setDragPixels((pixels) => pixels.filter((pixel) => pixel.id !== id));
      dragPixelTimersRef.current.delete(timer);
    }, DRAG_TRAIL_LIFETIME_MS);
    dragPixelTimersRef.current.add(timer);
  }, []);

  const scheduleDragPosition = useCallback((position: CompanionDragPosition) => {
    pendingDragPositionRef.current = position;
    if (dragFrameRef.current) return;
    dragFrameRef.current = window.requestAnimationFrame(() => {
      const nextPosition = pendingDragPositionRef.current;
      pendingDragPositionRef.current = null;
      dragFrameRef.current = null;
      if (nextPosition) setDragPosition(nextPosition);
    });
  }, []);

  // Click the pet: cycle the action preview through the 9 states (including "follow system" auto=null).
  const cyclePetState = useCallback(() => {
    setPetStateName((current) => {
      const order: (PetdexStateName | null)[] = [null, ...PETDEX_STATE_OPTIONS.map((o) => o.name)];
      const next = (order.indexOf(current) + 1) % order.length;
      return order[next];
    });
  }, []);

  const handlePikoDebugActionChange = useCallback((event: ChangeEvent<HTMLSelectElement>) => {
    const nextAction = event.target.value;
    setPikoDebugAction(nextAction === "auto" || !isMyBuddyAction(nextAction) ? null : nextAction);
  }, []);

  const handleChestDebugChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      const nextAction = event.target.value;
      if (nextAction === "single") {
        triggerMockAccessoryUnlock();
      } else if (nextAction === "batch") {
        triggerMockAccessoryBatchUnlock();
      }
      event.currentTarget.value = "";
    },
    [triggerMockAccessoryBatchUnlock, triggerMockAccessoryUnlock],
  );

  // Drag / click: a transparent handle layer captures the pointer. Moving beyond a threshold -> 2D drag positioning (persisted as viewport percentages);
  // barely moving -> treated as a click -> switch the pet action.
  const handleDragPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const startX = event.clientX;
      const startY = event.clientY;
      const startLeftPx = Math.round((xPercent / 100) * vw);
      const startTopPx = Math.round((yPercent / 100) * vh);
      const grabX = startX - startLeftPx;
      const grabY = startY - startTopPx;
      let dragging = false;
      let latestXPercent = xPercent;
      let latestYPercent = yPercent;
      let lastX = startX;
      let lastY = startY;
      let lastTrailX = startX;
      let lastTrailY = startY;
      if (releaseFrameRef.current) window.cancelAnimationFrame(releaseFrameRef.current);
      floatingRef.current?.style.setProperty("--mybuddy-drag-tilt", "0deg");
      const onMove = (moveEvent: PointerEvent) => {
        if (!dragging && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 4) {
          return;
        }
        if (!dragging) setDraggingCompanion(true);
        dragging = true;
        const px = Math.round(
          Math.min(Math.max(0, moveEvent.clientX - grabX), Math.max(0, vw - COMPANION_FIGURE_W)),
        );
        const py = Math.round(
          Math.min(Math.max(0, moveEvent.clientY - grabY), Math.max(0, vh - COMPANION_FIGURE_H)),
        );
        latestXPercent = (px / vw) * 100;
        latestYPercent = (py / vh) * 100;
        scheduleDragPosition({ xPercent: latestXPercent, yPercent: latestYPercent });
        const moveX = moveEvent.clientX - lastX;
        const moveY = moveEvent.clientY - lastY;
        const speed = Math.hypot(moveX, moveY);
        const tilt =
          speed > 0.5
            ? Math.max(-DRAG_TILT_MAX_DEG, Math.min(DRAG_TILT_MAX_DEG, moveX * DRAG_TILT_FACTOR))
            : 0;
        floatingRef.current?.style.setProperty("--mybuddy-drag-tilt", `${tilt}deg`);
        const distanceFromTrail = Math.hypot(
          moveEvent.clientX - lastTrailX,
          moveEvent.clientY - lastTrailY,
        );
        if (distanceFromTrail >= DRAG_TRAIL_DISTANCE_PX) {
          const trailSpeed = Math.max(1, speed);
          const oppositeX = -(moveX / trailSpeed);
          const oppositeY = -(moveY / trailSpeed);
          const centerX = px + COMPANION_FIGURE_W * 0.46;
          const centerY = py + COMPANION_FIGURE_H * 0.46;
          const jitter = (dragPixelIdRef.current % 3) - 1;
          emitDragPixel(
            centerX + oppositeX * 16 + jitter * 2,
            centerY + oppositeY * 10 - jitter,
            dragPixelIdRef.current % 3,
          );
          lastTrailX = moveEvent.clientX;
          lastTrailY = moveEvent.clientY;
        }
        lastX = moveEvent.clientX;
        lastY = moveEvent.clientY;
      };
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
        setDraggingCompanion(false);
        floatingRef.current?.style.setProperty("--mybuddy-drag-tilt", "0deg");
        if (dragging) {
          if (dragFrameRef.current) {
            window.cancelAnimationFrame(dragFrameRef.current);
            dragFrameRef.current = null;
            pendingDragPositionRef.current = null;
          }
          setDragPosition({ xPercent: latestXPercent, yPercent: latestYPercent });
          setCompanionPosition(latestXPercent, latestYPercent);
          if (dropSettleTimerRef.current) window.clearTimeout(dropSettleTimerRef.current);
          setDropSettling(true);
          setDropRippleNonce((nonce) => nonce + 1);
          dropSettleTimerRef.current = window.setTimeout(() => {
            setDropSettling(false);
            dropSettleTimerRef.current = null;
          }, 260);
          releaseFrameRef.current = window.requestAnimationFrame(() => {
            setDragPosition(null);
            releaseFrameRef.current = null;
          });
        } else {
          setDragPosition(null);
        }
        if (!dragging && !isPiko) cyclePetState();
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    },
    [cyclePetState, emitDragPixel, isPiko, scheduleDragPosition, setCompanionPosition, xPercent, yPercent],
  );

  // When switching avatars clear the manual override and return to following the system.
  useEffect(() => {
    setPetStateName(null);
  }, [companionKind]);

  // Global hide switch: when on, the companion avatar is not rendered (hooks have all run above, so an early return is safe).
  if (companionHidden) return null;

  return (
    <div className="mybuddy-companion-lane">
      {SHOW_PIKO_DEBUG && isPiko && (
        <div className="mybuddy-companion-debug mybuddy-companion-debug-panel">
          <span className="mybuddy-companion-debug-label">
            <span className="mybuddy-companion-debug-brand">Piko</span>
            {t("myBuddy.debug.suffix")}
          </span>
          <select
            className="mybuddy-companion-debug-select mybuddy-companion-debug-action-select"
            value={pikoDebugAction ?? "auto"}
            onChange={handlePikoDebugActionChange}
            aria-label={t("myBuddy.debug.stateSimulation")}
          >
            <option value="auto">{t("myBuddy.debug.auto")}</option>
            {MYBUDDY_ACTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {t(option.labelKey)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="mybuddy-companion-debug-button"
            onClick={() => triggerDiveAction(true)}
          >
            {t("myBuddy.debug.triggerDiveAction")}
          </button>
          <select
            className="mybuddy-companion-debug-select"
            defaultValue=""
            onChange={handleChestDebugChange}
            aria-label={t("myBuddy.debug.chestTrigger")}
          >
            <option value="" disabled>
              {t("myBuddy.debug.chestTrigger")}
            </option>
            <option value="single">{t("myBuddy.debug.chestSingle")}</option>
            <option value="batch">{t("myBuddy.debug.chestBatch")}</option>
          </select>
          <button
            type="button"
            className="mybuddy-companion-debug-button"
            data-tone="neutral"
            onClick={openVersionUpdateDialog}
          >
            {t("myBuddy.debug.triggerUpdateDialog")}
          </button>
        </div>
      )}
      {/* Floating container positioned anywhere on the page (fixed, relative to the viewport). The avatar/bubble/drag handle are all inside it. */}
      <div
        ref={floatingRef}
        className="mybuddy-companion-floating"
        data-companion-kind={isPiko ? "piko" : "petdex"}
        data-dragging={draggingCompanion || undefined}
        data-settling={dropSettling || undefined}
        style={{
          position: "fixed",
          left: displayLeftPx,
          top: displayTopPx,
          width: 66,
          height: 80,
          zIndex: 25,
          pointerEvents: "none",
        }}
      >
        <div className="mybuddy-companion-drag-trail" aria-hidden="true">
          {dragPixels.map((pixel) => (
            <span
              key={pixel.id}
              className="mybuddy-companion-drag-pixel"
              data-variant={pixel.variant}
              style={{
                left: pixel.x - displayLeftPx,
                top: pixel.y - displayTopPx,
              }}
            />
          ))}
        </div>
        {dropRippleNonce > 0 && (
          <span
            key={dropRippleNonce}
            className="mybuddy-companion-drop-ripple"
            aria-hidden="true"
          />
        )}
        <div className="mybuddy-companion-motion-layer">
          <div className="mybuddy-companion-settle-layer">
            {activePet ? (
              <SpritePetCompanion
                key={`pet-${activePet.slug}-${companionResetNonce}`}
                action={action}
                pet={activePet}
                stateOverride={petStateName ? PETDEX_STATES[petStateName] : null}
              />
            ) : (
              // Absolute positioning (top/left:0) lets PikoActionTransition's "leave + enter" two anchors
              // overlap and cross-fade, instead of stacking vertically in flow (which would make it jump up and down when switching actions).
              <PikoActionTransition
                key={`piko-${companionResetNonce}`}
                action={pikoAction}
                festivalSkin={festivalSkin}
                festivalPhase={festivalPhase}
                bubbleKey={pikoDebugAction ? null : bubbleKey}
                isBubbleLeaving={pikoDebugAction ? false : isBubbleLeaving}
                specialAction={specialAction}
                accessory={pikoAccessory}
                style={pikoFigureStyle}
              />
            )}
          </div>
        </div>
        {/* Task start/success/failure: a mosaic pixel-style bubble at the pet's top-right, fading out after a few seconds (petdex pets only;
            Piko has its own bubble system). */}
        {activePet && petBubble && (
          <div
            className="petdex-pet-bubble"
            data-kind={petBubble.kind}
            data-leaving={petBubbleLeaving || undefined}
            role="status"
          >
            {petBubble.text}
          </div>
        )}
        {/* Transparent drag handle: covers the avatar, hold to drag anywhere on the page. */}
        <div
          className="mybuddy-companion-drag-handle"
          onPointerDown={handleDragPointerDown}
          style={{
            position: "absolute",
            inset: 0,
            pointerEvents: "auto",
            touchAction: "none",
            zIndex: 3,
          }}
          title={t("myBuddy.dragHint")}
          aria-hidden
        />
      </div>
    </div>
  );
}

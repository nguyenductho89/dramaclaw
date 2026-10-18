// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useEffect } from "react";

const IMMERSIVE_BODY_CLASS = "st-viewer-immersive-active";

let activeImmersiveViewers = 0;

/**
 * Whether an immersive viewer (e.g. the 3GS director stage fullscreen dialog) is open. While open it owns the keyboard
 * (placing/deleting markers, etc.), and the canvas global shortcuts (Delete removes nodes / copy-paste ...) should yield,
 * otherwise there is key cross-talk like "wanted to delete a marker but deleted the canvas 3D world node".
 */
export function isImmersiveViewerActive(): boolean {
  return activeImmersiveViewers > 0;
}

export function useViewerImmersiveBody(active: boolean) {
  useEffect(() => {
    if (!active) return undefined;

    activeImmersiveViewers += 1;
    document.body.classList.add(IMMERSIVE_BODY_CLASS);

    return () => {
      activeImmersiveViewers = Math.max(0, activeImmersiveViewers - 1);
      if (activeImmersiveViewers === 0) {
        document.body.classList.remove(IMMERSIVE_BODY_CLASS);
      }
    };
  }, [active]);
}

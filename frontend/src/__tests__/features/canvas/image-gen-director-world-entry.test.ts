// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

describe("ImageGenNode director combined world entry", () => {
  it("passes a combined capture handler so preset director assets can export bundles", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/ImageGenNode.tsx"),
      "utf8",
    );

    expect(source).toContain("handleDirectorCaptureCombined");
    expect(source).toContain("onSubmitDirectorCombined={handleDirectorCaptureCombined}");
    expect(source).not.toContain("onCaptureCanvasNode={handleDirectorCaptureCombined}");
    expect(source).toContain("controlFrameBundle");
  });

  it("does not expose selected-background capture from the director-combined entry", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/ImageGenNode.tsx"),
      "utf8",
    );

    expect(source).not.toContain("onCaptureSelectedBackground={handleDirectorCaptureSelectedBackground}");
  });

  it("lets dragged director bundle upload nodes open Director World", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/UploadNode.tsx"),
      "utf8",
    );

    expect(source).toContain("getBeatDirectorStageManifest");
    expect(source).toContain("sourceRole === \"director_combined\"");
    expect(source).toContain("onSubmitDirectorCombined={handleDirectorCaptureCombined}");
    expect(source).toContain("onCaptureCanvasNode={handleDirectorOutputCanvasNode}");
    expect(source).not.toContain("autoCommitDirectorCombined");
    expect(source).toContain("meta.captureBundle");
    // The copy has moved into the locale entries and only keys remain in the source; the wording itself is checked against the locale (see the next case).
    expect(source).toContain("label: t('node.threeDWorld.combinedLabel')");
    expect(source).toContain("label: t('node.threeDWorld.envOnlyLabel')");
    expect(source).toContain("addPanoCaptureGroup");
    expect(source).toContain("kind: 'director_render'");
    expect(source).not.toContain("freezone/assets-updated");
  });

  it("exports both combined and env_only from normal Director World canvas output", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/ThreeDWorldNode.tsx"),
      "utf8",
    );

    expect(source).toContain("meta.captureBundle");
    // The copy has moved into the locale entries and only keys remain in the source; the wording itself is checked against the locale.
    expect(source).toContain("label: t('node.threeDWorld.combinedLabel')");
    expect(source).toContain("label: t('node.threeDWorld.envOnlyLabel')");
    const en = JSON.parse(
      readFileSync(resolve(process.cwd(), "public/locales/en/translation.json"), "utf8"),
    );
    expect(en.node.threeDWorld.combinedLabel).toBe("Director composite");
    expect(en.node.threeDWorld.envOnlyLabel).toBe("Background only");
    expect(source).toContain("director_control_bundle");
  });

  it("guards Director World canvas output against duplicate in-flight group creation", () => {
    const threeDWorldSource = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/ThreeDWorldNode.tsx"),
      "utf8",
    );
    const uploadSource = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/UploadNode.tsx"),
      "utf8",
    );

    expect(threeDWorldSource).toContain("captureCanvasNodeBusyRef");
    expect(uploadSource).toContain("captureCanvasNodeBusyRef");
  });

  it("restores the bundle source when opening Director World from a dragged upload node", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/canvas/nodes/UploadNode.tsx"),
      "utf8",
    );

    expect(source).toContain("directorControlBundleSourceId");
    expect(source).toContain("active_source_id: directorControlBundleSourceId");
    expect(source).toContain("sceneSnapshotFromDirectorControlBundle");
    expect(source).toContain("initialScene={directorInitialScene}");
  });

  it("only writes beat bundles directly in mainline commit mode", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/features/viewer-kit/three-d/ThreeDDirectorDialog.tsx"),
      "utf8",
    );

    expect(source).toContain("autoCommitDirectorCombined &&");
    expect(source).toContain("DIRECTOR_CONTROL_FRAME_MAX_LONG_EDGE");
  });
});

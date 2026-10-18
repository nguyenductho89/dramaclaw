// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
//
// Whether to persist after onLoad measures the real size. There are two pitfalls, neither on the obvious "ratio changed" path:
//
// 1. The record is empty to begin with. Nodes in old projects already had the right ratio and a fitting size, so the ratio and display-size
//    conditions are always false, and imageNaturalWidth/Height never gets written; while
//    nodeBodyImageSrc without a record can only feed the original, so this node never benefits from the downscaled copy -- the whole
//    change silently does nothing for existing projects.
// 2. A backfill write like this is not a user change. If it really entered the undo stack, opening an old project would pile up dozens of "forget one
//    image's size" entries and also clear the redo stack.
import { describe, expect, it } from "vitest";

import { planNaturalSizeRecordWrite } from "@/features/canvas/application/imageData";
import { useCanvasStore } from "@/stores/canvasStore";

const MEASURED = { width: 5504, height: 3072 };
const SETTLED = {
  aspectRatioChanged: false,
  displaySizeMismatch: false,
  measured: MEASURED,
  measuringRecordSubject: true,
  sizeLockedByUser: false,
};

describe("planNaturalSizeRecordWrite", () => {
  it("an empty record must be backfilled even when the ratio and display size already fit", () => {
    expect(planNaturalSizeRecordWrite({ ...SETTLED, record: null })).toEqual({
      persist: true,
      recordHistory: false,
      applySize: false,
    });
  });

  // Same-ratio image swap: 5504x3072 -> 2752x1536, with the ratio and display size both unchanged.
  it("a record that disagrees with the freshly measured truth must be written back too", () => {
    expect(
      planNaturalSizeRecordWrite({ ...SETTLED, record: { width: 2752, height: 1536 } }),
    ).toEqual({ persist: true, recordHistory: false, applySize: false });
  });

  it("backfills and corrections do not enter the undo stack, since they change no pixel on screen", () => {
    expect(planNaturalSizeRecordWrite({ ...SETTLED, record: null }).recordHistory).toBe(false);
    expect(
      planNaturalSizeRecordWrite({ ...SETTLED, record: { width: 1, height: 1 } }).recordHistory,
    ).toBe(false);
  });

  it("a changed ratio or display size is a user-visible change and enters the undo stack", () => {
    expect(
      planNaturalSizeRecordWrite({ ...SETTLED, record: MEASURED, aspectRatioChanged: true }),
    ).toEqual({ persist: true, recordHistory: true, applySize: true });
    expect(
      planNaturalSizeRecordWrite({ ...SETTLED, record: MEASURED, displaySizeMismatch: true }),
    ).toEqual({ persist: true, recordHistory: true, applySize: true });
  });

  // Converge once written: the same input no longer writes the second time, so node data is not updated on every onLoad.
  it("writes nothing when the record is already the truth", () => {
    expect(planNaturalSizeRecordWrite({ ...SETTLED, record: MEASURED })).toEqual({
      persist: false,
      recordHistory: false,
      applySize: false,
    });
  });

  // Beyond a 1.45 zoom ImageNode feeds imageUrl, which may be a completely different image (the results of rotate, relight,
  // and multi-angle are all in previewImageUrl). Backfilling the record from it swaps an empty value for a wrong one.
  it("does not even backfill when what was measured is not the image the record should describe", () => {
    expect(
      planNaturalSizeRecordWrite({ ...SETTLED, record: null, measuringRecordSubject: false }),
    ).toEqual({ persist: false, recordHistory: false, applySize: false });
  });

  // Nodes whose size the user dragged (isSizeManuallyAdjusted). onLoad used to return right here, so
  // after an image swap the real size could never be written back: the badge was right for that moment thanks to component-local state, but a remount reads the
  // old record; with a same-ratio swap the downscaled-copy validation also cannot tell, so it keeps picking the variant by the old size.
  // Preserving the display size the user dragged and recording the real pixel size correctly are two unrelated things.
  describe("a node whose size the user dragged", () => {
    const LOCKED = { ...SETTLED, sizeLockedByUser: true };

    it("leaves its display size alone but still backfills the record", () => {
      expect(planNaturalSizeRecordWrite({ ...LOCKED, record: null })).toEqual({
        persist: true,
        recordHistory: false,
        applySize: false,
      });
    });

    it("even when the ratio changed it only corrects the record, leaves the size alone, and does not enter the undo stack", () => {
      expect(
        planNaturalSizeRecordWrite({
          ...LOCKED,
          record: { width: 2752, height: 1536 },
          aspectRatioChanged: true,
          displaySizeMismatch: true,
        }),
      ).toEqual({ persist: true, recordHistory: false, applySize: false });
    });

    it("writes nothing when the record is already the truth", () => {
      expect(planNaturalSizeRecordWrite({ ...LOCKED, record: MEASURED })).toEqual({
        persist: false,
        recordHistory: false,
        applySize: false,
      });
    });

    it("does not even backfill when what was measured is not the image the record should describe", () => {
      expect(
        planNaturalSizeRecordWrite({ ...LOCKED, record: null, measuringRecordSubject: false }),
      ).toEqual({ persist: false, recordHistory: false, applySize: false });
    });
  });
});

describe("updateNodeSize recordHistory", () => {
  const seed = (nodeId: string) => {
    useCanvasStore.setState({
      nodes: [
        {
          id: nodeId,
          type: "imageNode",
          position: { x: 0, y: 0 },
          width: 580,
          height: 326,
          data: { label: "image" },
        },
      ] as never,
      edges: [],
      history: { past: [], future: [] },
    } as never);
  };

  it("a factual backfill does not enter the undo stack or clear the redo stack", () => {
    seed("n1");
    const future = useCanvasStore.getState().history.future;

    useCanvasStore.getState().updateNodeSize(
      "n1",
      { width: 580, height: 326 },
      { recordHistory: false, data: { imageNaturalWidth: 5504, imageNaturalHeight: 3072 } as never },
    );

    const after = useCanvasStore.getState();
    expect(after.history.past.length).toBe(0);
    expect(after.history.future).toBe(future);
    expect(after.nodes[0].data.imageNaturalWidth).toBe(5504);
  });

  it("still enters the undo stack by default", () => {
    seed("n2");

    useCanvasStore.getState().updateNodeSize("n2", { width: 321, height: 123 });

    expect(useCanvasStore.getState().history.past.length).toBe(1);
  });
});

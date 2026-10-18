// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * When the imageNaturalWidth/Height group in node data cannot be trusted.
 *
 * The record stores the original image's real pixel size, which the body image relies on to decide whether it may be fed a downsampled copy. But the record is not bound to any
 * URL, while the node's image can be swapped (album main-image selection, restore from history, generation completion backfill -
 * all three paths change only imageUrl/previewImageUrl, and nobody clears this group of numbers). Trusting the old record to feed a copy,
 * onLoad would write numbers belonging to another image back as the real size, and the badge and auto size would both be wrong.
 *
 * Looking at the copy alone cannot recognize this: the copy's long edge is pinned to the budget, and the information about how large the original was is lost
 * in downsampling; the card copies of 5504x3072 and 2752x1536 are both 1280x714. So the criterion is "swapping the image"
 * itself, not "whether the copy looks right" - once the subject changes, distrust immediately; this round feeds the original, and once the real size
 * is measured and persisted, return to the copy.
 *
 * Each subject backs off only once. Even after backing off it may not be persistable (nodes whose size was manually adjusted return
 * early in onLoad and never reach the step of writing data), and without this gate it would become a copy -> original -> copy infinite loop.
 */
export function useNaturalSizeRecordTrust(subject: string | null): {
  /** Whether this round should bypass the copy and feed the original directly. */
  distrusted: boolean;
  /** The record does not match the image at hand; back off to the original and measure again. A second call for the same subject has no effect. */
  distrustRecord: () => void;
  /** The original has been measured, and it is fine to return to the copy. */
  trustAgain: () => void;
} {
  const [distrustedSubject, setDistrustedSubject] = useState<string | null>(null);
  const retriedSubject = useRef<string | null>(null);
  const knownSubject = useRef<string | null>(null);

  const distrustRecord = useCallback(() => {
    if (subject === null || retriedSubject.current === subject) return;
    retriedSubject.current = subject;
    setDistrustedSubject(subject);
  }, [subject]);

  const trustAgain = useCallback(() => {
    setDistrustedSubject((current) => (current === null ? current : null));
  }, []);

  useEffect(() => {
    // "Temporarily no image" is not an image swap. During generation ImageGenNode explicitly empties the body image
    // (visiblePreviewUrl = null), so the typical sequence is old image A -> null while generating -> new result
    // B. Recording null as "the previous one" too, B would see previous as null on arrival, be treated as a first
    // mount and needlessly trust the old record - and this moment is exactly when distrust is most needed. So only non-empty subjects are recorded,
    // knownSubject stores "the last real image", and how long it is hidden in between does not matter.
    if (subject === null) return;
    const previous = knownSubject.current;
    knownSubject.current = subject;
    // On the first mount there is no "previous one" to compare: the record is persisted, so it can only be trusted first. If it really is skewed there is still
    // nodeBodyRecordDescribesImage as a fallback, which recognizes the kind where the ratio does not match.
    if (previous === null || previous === subject) return;
    distrustRecord();
  }, [distrustRecord, subject]);

  return {
    distrusted: distrustedSubject !== null && distrustedSubject === subject,
    distrustRecord,
    trustAgain,
  };
}

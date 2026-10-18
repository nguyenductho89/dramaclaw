// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  installDomReconciliationGuard,
  resetDomReconciliationGuardForTests,
} from "@/lib/dom-reconciliation-guard";

// Native method references, used to restore the prototype after each case and avoid polluting other tests.
const nativeRemoveChild = Node.prototype.removeChild;
const nativeInsertBefore = Node.prototype.insertBefore;

describe("installDomReconciliationGuard", () => {
  beforeEach(() => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    Node.prototype.removeChild = nativeRemoveChild;
    Node.prototype.insertBefore = nativeInsertBefore;
    resetDomReconciliationGuardForTests();
    vi.restoreAllMocks();
  });

  it("no longer throws: after the translator moves the text node into <font>, React removes the original node", () => {
    installDomReconciliationGuard();

    // Reproduce the real scenario: <p> has a text node, and the translation extension moves it into a newly created <font>.
    const p = document.createElement("p");
    const text = document.createTextNode("Hello ");
    p.appendChild(text);

    const font = document.createElement("font");
    font.appendChild(text); // text's parentNode changes from <p> to <font>

    // React still thinks text is a child of <p>, and during reconciliation it will call p.removeChild(text).
    expect(() => p.removeChild(text)).not.toThrow();
    // The node was not removed by mistake, and still hangs under the translator's <font>.
    expect(text.parentNode).toBe(font);
  });

  it("normal removal still works", () => {
    installDomReconciliationGuard();

    const parent = document.createElement("div");
    const child = document.createElement("span");
    parent.appendChild(child);

    parent.removeChild(child);
    expect(child.parentNode).toBeNull();
    expect(parent.childNodes.length).toBe(0);
  });

  it("degrades to append, without throwing, when the insertBefore reference node's parent is misplaced", () => {
    installDomReconciliationGuard();

    const parent = document.createElement("div");
    const orphanRef = document.createElement("i"); // not a child of parent
    const inserted = document.createElement("b");

    expect(() => parent.insertBefore(inserted, orphanRef)).not.toThrow();
    // Degrades to appendChild: the new node still enters parent.
    expect(inserted.parentNode).toBe(parent);
  });

  it("insertBefore keeps the original ordering semantics on the normal path", () => {
    installDomReconciliationGuard();

    const parent = document.createElement("div");
    const first = document.createElement("span");
    const ref = document.createElement("span");
    parent.appendChild(ref);

    parent.insertBefore(first, ref);
    expect(parent.firstChild).toBe(first);
    expect(parent.childNodes[1]).toBe(ref);
  });
});

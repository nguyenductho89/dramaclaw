// SPDX-License-Identifier: Elastic-2.0
// Copyright (c) 2026 ClaymoreLab

// The browser / webview "translate this page" feature (Chrome, Edge, in-app browsers) and some extensions
// rewrite the React-managed DOM directly: they move text nodes into a newly inserted <font> container, or replace whole runs.
// When React's next reconciliation tries to removeChild / insertBefore on the original node, that node's
// parentNode is no longer the parent React remembers, and the browser throws:
//   NotFoundError: Failed to execute 'removeChild' on 'Node': The node to be removed is not a child of this node
// This exception is not caught by app code, bubbles to the root error boundary, and the whole page becomes "page failed to load".
//
// The commonly used mitigation from React issue facebook/react#11538: wrap these two prototype methods with a
// guard - when the target node's parent does not match, silently skip (or append instead) rather than throw. The translation extension
// keeps working, and React no longer crashes because of its DOM rewrites. Only the abnormal "parent mismatch" path
// is short-circuited; the normal path uses the native implementation unchanged, with no side effects and no performance impact.

let installed = false;

export function installDomReconciliationGuard(): void {
  if (installed) return;
  if (typeof Node !== "function" || !Node.prototype) return;
  installed = true;

  const originalRemoveChild = Node.prototype.removeChild;
  Node.prototype.removeChild = function guardedRemoveChild<T extends Node>(
    this: Node,
    child: T,
  ): T {
    if (child.parentNode !== this) {
      // The node was moved to another parent by the translator, so the native call would throw. Treat it as already removed and hand the child
      // back: React drops its reference to it, and the leftover node is cleaned up together with the translator's container.
      if (typeof console !== "undefined") {
        console.warn("[dom-guard] removeChild: the target node's parent has changed, skipping", child);
      }
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = Node.prototype.insertBefore;
  Node.prototype.insertBefore = function guardedInsertBefore<T extends Node>(
    this: Node,
    newNode: T,
    referenceNode: Node | null,
  ): T {
    if (referenceNode && referenceNode.parentNode !== this) {
      // The reference node was moved away by the translator, so inserting before it is impossible. Fall back to appending (insertBefore(node, null)
      // is equivalent to appendChild), so the new node still enters the DOM and React's next reconciliation corrects the order itself.
      if (typeof console !== "undefined") {
        console.warn("[dom-guard] insertBefore: the reference node's parent has changed, appending instead", newNode);
      }
      return originalInsertBefore.call(this, newNode, null) as T;
    }
    return originalInsertBefore.call(this, newNode, referenceNode) as T;
  };
}

export function resetDomReconciliationGuardForTests(): void {
  installed = false;
}

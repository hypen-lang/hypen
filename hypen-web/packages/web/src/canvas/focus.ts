/**
 * Focus Manager
 *
 * Real DOM focus on accessibility-mirror elements (canvas fallback content)
 * is the single source of truth for canvas focus. Tab/Shift+Tab traverse
 * the mirror natively; `focusin`/`focusout` translate DOM focus into
 * `node.focused` + repaint; the pointer path (canvas hit-test) funnels into
 * the same place by focusing the node's mirror element.
 *
 * Loop-free by construction: DOM focus events only ever *read* into node
 * state — nothing in the sync path calls `.focus()` back.
 *
 * The mirror also carries keyboard/AT interaction back to the engine:
 * Enter/Space on a mirror `<button>` produces a native `click` (dispatched
 * to the node's action), and keydown/keyup on the focused element dispatch
 * the node's `onKeyDown`/`onKeyUp` applicators — which the old
 * canvas-attached listeners never could (a canvas without tabindex never
 * receives key events).
 */

import type { VirtualNode } from "./types.js";
import type { AccessibilityLayer } from "./accessibility.js";
import { dispatchNodeEvent, type DispatchEngine } from "./dispatch.js";
import { isToggleControl, activateToggle, handleControlKey } from "./controls.js";

/**
 * Is this node inside an exit-animating subtree? Engine-side those ids are
 * already dead: pointer hit-testing prunes them via `node.exiting`, and the
 * mirror root is made `inert` — this walk covers the keyboard/AT paths in
 * environments where `inert` is unsupported (or focus predates the exit),
 * so a corpse can never dispatch actions or receive focus mid-exit.
 */
function inExitingSubtree(node: VirtualNode): boolean {
  let current: VirtualNode | null = node;
  while (current) {
    if (current.exiting) return true;
    current = current.parent;
  }
  return false;
}

export interface FocusManagerHooks {
  getNode(id: string): VirtualNode | undefined;
  /** Fired after node.focused flags are updated. Renderer repaints and
   *  (for editable nodes) starts/stops the text-edit controller. */
  onFocusChange(next: VirtualNode | null, prev: VirtualNode | null): void;
  /**
   * Elements outside the mirror that still count as "the node is focused" —
   * the text editor's hidden IME proxy. Focus moving there must not clear
   * canvas focus.
   */
  isAuxFocusTarget?(element: unknown): boolean;
  /**
   * Repaint after the mirror operated a control (an AT activation on a
   * checkbox, an arrow key on a slider). Those change node state without
   * going through the pointer path, so nothing else would schedule a frame.
   */
  requestRedraw?(): void;
}

export class FocusManager {
  private mirror: AccessibilityLayer;
  private engine: DispatchEngine;
  private hooks: FocusManagerHooks;
  private focusedNode: VirtualNode | null = null;
  /**
   * Optional first look at mirror key events (the drag-and-drop runtime's
   * Space/Arrow/Tab/Esc handling). Returning `true` consumes the event: it
   * is not dispatched to the node's `onKeyDown`/`onKeyUp` applicators.
   */
  private keyInterceptor: ((node: VirtualNode, type: "keydown" | "keyup", e: KeyboardEvent) => boolean) | null =
    null;

  private boundFocusIn = (e: Event) => this.onFocusIn(e as FocusEvent);
  private boundFocusOut = (e: Event) => this.onFocusOut(e as FocusEvent);
  private boundClick = (e: Event) => this.onMirrorClick(e);
  private boundKeyDown = (e: Event) => this.onMirrorKey("keydown", e as KeyboardEvent);
  private boundKeyUp = (e: Event) => this.onMirrorKey("keyup", e as KeyboardEvent);

  constructor(mirror: AccessibilityLayer, engine: DispatchEngine, hooks: FocusManagerHooks) {
    this.mirror = mirror;
    this.engine = engine;
    this.hooks = hooks;

    const root = mirror.getRoot();
    if (root && typeof root.addEventListener === "function") {
      root.addEventListener("focusin", this.boundFocusIn);
      root.addEventListener("focusout", this.boundFocusOut);
      root.addEventListener("click", this.boundClick);
      root.addEventListener("keydown", this.boundKeyDown);
      root.addEventListener("keyup", this.boundKeyUp);
    }
  }

  // -------------------------------------------------------------------------
  // DOM → node state (the only direction focus state flows)
  // -------------------------------------------------------------------------

  /** Climb from an event target to the mirror element's virtual node. */
  private resolveNode(target: EventTarget | null): VirtualNode | null {
    let el = target as (HTMLElement & { parentNode?: any }) | null;
    const root = this.mirror.getRoot();
    while (el && el !== root) {
      const id = el.getAttribute?.("data-hypen-id");
      if (id) {
        return this.hooks.getNode(id) ?? null;
      }
      el = el.parentNode ?? null;
    }
    return null;
  }

  private onFocusIn(e: FocusEvent): void {
    const node = this.resolveNode(e.target);
    // Focus landing inside an exiting corpse (mirror not yet inert, or inert
    // unsupported) must not register as canvas focus.
    this.syncFocus(node && inExitingSubtree(node) ? null : node);
  }

  private onFocusOut(e: FocusEvent): void {
    // If focus moves to another mirror element, its focusin handles the
    // transition; a handoff to the editor's IME proxy keeps the node
    // focused; only a departure from both clears focus.
    const next = e.relatedTarget as HTMLElement | null;
    if (next && this.hooks.isAuxFocusTarget?.(next)) return;
    const root = this.mirror.getRoot();
    if (!next || !root || !(root.contains?.(next) ?? false)) {
      this.syncFocus(null);
    }
  }

  /** Update node.focused flags from the new DOM focus target. Idempotent. */
  private syncFocus(node: VirtualNode | null): void {
    if (node === this.focusedNode) return;

    const prev = this.focusedNode;
    if (prev) {
      prev.focused = false;
      dispatchNodeEvent(this.engine, prev, "blur", {});
    }

    this.focusedNode = node;
    if (node) {
      node.focused = true;
      dispatchNodeEvent(this.engine, node, "focus", {});
    }

    this.hooks.onFocusChange(node, prev);
  }

  // -------------------------------------------------------------------------
  // Pointer path — canvas hit-test funnels into DOM focus
  // -------------------------------------------------------------------------

  /**
   * Focus a node from the canvas pointer path. Focuses the mirror element
   * (so `document.activeElement` agrees) and syncs node state directly —
   * in real browsers the element's focusin already did that synchronously
   * and the second sync is a no-op; in environments without focus events
   * the direct sync keeps behavior identical.
   */
  requestFocus(node: VirtualNode | null): void {
    if (!node) {
      this.clearFocus();
      return;
    }

    const el = this.mirror.getElement(node.id);
    (el as any)?.focus?.({ preventScroll: true });
    this.syncFocus(node);
  }

  /** Pointer landed on nothing focusable: blur any mirror focus and clear. */
  clearFocus(): void {
    if (typeof document !== "undefined") {
      const active = document.activeElement as HTMLElement | null;
      const root = this.mirror.getRoot();
      if (
        active &&
        ((root && (root.contains?.(active) ?? false)) ||
          this.hooks.isAuxFocusTarget?.(active))
      ) {
        active.blur?.();
      }
    }
    this.syncFocus(null);
  }

  /**
   * Clear focus if the focused node is `node` or one of its descendants —
   * called before a subtree is removed/detached (the mirror element may
   * leave the DOM without a browser blur when focus sits on the IME proxy).
   */
  clearIfWithin(node: VirtualNode): void {
    let current: VirtualNode | null = this.focusedNode;
    while (current) {
      if (current === node) {
        this.syncFocus(null);
        return;
      }
      current = current.parent;
    }
  }

  getFocusedNode(): VirtualNode | null {
    return this.focusedNode;
  }

  // -------------------------------------------------------------------------
  // Mirror interaction → engine actions
  // -------------------------------------------------------------------------

  /**
   * Native click on a mirror element — keyboard activation (Enter/Space on
   * a real `<button>`) or an AT-initiated action. Pointer clicks never land
   * here (fallback content has no rendered boxes), so this can't double-fire
   * with the canvas hit-test click path.
   */
  private onMirrorClick(e: Event): void {
    const node = this.resolveNode(e.target);
    if (!node) return;
    if (!node.clickable) return;
    // Exiting subtrees are engine-dead: activation must not dispatch (the
    // pointer path is already pruned by hit-testing; this is the AT twin).
    if (inExitingSubtree(node)) return;
    // An assistive-technology activation on a checkbox/switch/radio has to
    // change its state, exactly as a pointer press does — the mirror element
    // is the only thing AT can reach.
    if (isToggleControl(node) && activateToggle(this.engine, node)) {
      this.hooks.requestRedraw?.();
    }
    dispatchNodeEvent(this.engine, node, "click", {});
  }

  /**
   * Install (or clear) the key interceptor consulted before applicator
   * dispatch — see {@link keyInterceptor}.
   */
  setKeyInterceptor(
    fn: ((node: VirtualNode, type: "keydown" | "keyup", e: KeyboardEvent) => boolean) | null,
  ): void {
    this.keyInterceptor = fn;
  }

  private onMirrorKey(type: "keydown" | "keyup", e: KeyboardEvent): void {
    const node = this.resolveNode(e.target);
    if (!node) return;
    if (inExitingSubtree(node)) return;
    if (this.keyInterceptor?.(node, type, e)) return;
    // Space/Enter on a toggle, arrows on a slider. Consumed keys still
    // dispatch onKeyDown below: an author who wired both gets both.
    if (type === "keydown" && handleControlKey(this.engine, node, e.key)) {
      e.preventDefault();
      this.hooks.requestRedraw?.();
    }
    dispatchNodeEvent(this.engine, node, type, {
      key: e.key,
      code: e.code,
      ctrlKey: e.ctrlKey,
      shiftKey: e.shiftKey,
      altKey: e.altKey,
    });
  }

  destroy(): void {
    const root = this.mirror.getRoot();
    if (root && typeof root.removeEventListener === "function") {
      root.removeEventListener("focusin", this.boundFocusIn);
      root.removeEventListener("focusout", this.boundFocusOut);
      root.removeEventListener("click", this.boundClick);
      root.removeEventListener("keydown", this.boundKeyDown);
      root.removeEventListener("keyup", this.boundKeyUp);
    }
    this.focusedNode = null;
    this.keyInterceptor = null;
  }
}

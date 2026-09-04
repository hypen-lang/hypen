/**
 * Accessibility Layer
 *
 * Maintain shadow DOM for screen readers
 */

import type { Semantics } from "@hypen-space/core/types";
import type { VirtualNode } from "./types.js";
import {
  findEnclosingVideoNode,
  getScrubberFraction,
  getVideoPlayback,
  isScrubberNode,
  isVideoSlotChildVisible,
} from "./paint.js";

/**
 * Shadow tags that already convey their role natively, so we don't set an
 * explicit `role` on them (it would be redundant). Generic `<div>`/`<span>`
 * hosts are absent, so engine roles like `status`/`progressbar` land there.
 */
const NATIVE_SHADOW_TAGS = new Set([
  "BUTTON",
  "A",
  "IMG",
  "INPUT",
  "TEXTAREA",
  "SELECT",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
]);

/**
 * Attributes this module set on a shadow element on its previous pass, so a
 * re-apply (a reactive `setSemantics` patch) can clear exactly what it owns —
 * a dropped `expanded` must remove its stale `aria-expanded`, a name going
 * away its `aria-label`.
 */
const appliedShadowAttrs = new WeakMap<HTMLElement, string[]>();

/** `137.4` → `"2:17"` — the spoken form for a media timeline. */
function formatMediaTime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const mm = hrs > 0 ? String(mins).padStart(2, "0") : String(mins);
  return `${hrs > 0 ? `${hrs}:` : ""}${mm}:${String(secs).padStart(2, "0")}`;
}

/**
 * Apply engine-derived accessibility semantics to a shadow-tree element.
 *
 * Unlike the DOM renderer, the canvas paints pixels — the accessible name is
 * *not* otherwise exposed — so the derived name is applied directly as
 * `aria-label` (whether derived or explicit). Roles are set only on generic
 * hosts that don't convey them natively. `hidden` is handled by the caller
 * (the node is omitted from the shadow tree entirely).
 *
 * Called at shadow-node create and again on every reactive `setSemantics`
 * re-apply. Idempotent and clearing: attributes set on a previous pass that
 * the new block no longer produces are removed.
 */
export function applyShadowSemantics(element: HTMLElement, semantics?: Semantics): void {
  if (!semantics && !appliedShadowAttrs.has(element)) return;

  const next: Array<[string, string]> = [];

  if (semantics) {
    if (semantics.name) {
      next.push(["aria-label", semantics.name]);
    }

    const tag = element.tagName?.toUpperCase();
    if (semantics.role && !NATIVE_SHADOW_TAGS.has(tag)) {
      next.push(["role", semantics.role]);
    }

    if (semantics.description) {
      next.push(["aria-description", semantics.description]);
    }

    // Self-state relationship attributes.
    if (semantics.expanded !== undefined) {
      next.push(["aria-expanded", String(semantics.expanded)]);
    }
    if (semantics.pressed !== undefined) {
      next.push(["aria-pressed", String(semantics.pressed)]);
    }
    if (semantics.selected !== undefined) {
      next.push(["aria-selected", String(semantics.selected)]);
    }
    if (semantics.current) {
      next.push(["aria-current", semantics.current]);
    }
    if (semantics.checked !== undefined) {
      next.push(["aria-checked", String(semantics.checked)]);
    }

    if (semantics.busy) {
      next.push(["aria-busy", "true"]);
    }

    if (semantics.live) {
      // Live-region politeness — engine-validated ("polite" | "assertive").
      next.push(["aria-live", semantics.live]);
    }
  }

  // Clear what the previous pass set but this one doesn't.
  const previous = appliedShadowAttrs.get(element);
  if (previous) {
    const keep = new Set(next.map(([name]) => name));
    for (const name of previous) {
      if (!keep.has(name)) {
        element.removeAttribute(name);
      }
    }
  }

  for (const [name, value] of next) {
    element.setAttribute(name, value);
  }

  if (next.length > 0) {
    appliedShadowAttrs.set(element, next.map(([name]) => name));
  } else {
    appliedShadowAttrs.delete(element);
  }
}

/**
 * Accessibility Mirror — positioned transparent semantics overlay
 *
 * A live DOM mirror of the virtual tree, rendered INVISIBLY over the canvas
 * with every element absolutely positioned at its painted bounds (the
 * Flutter-web / Google-Docs approach). Canvas *fallback content* was tried
 * first and rejected on evidence: Chromium exposes fallback elements to the
 * accessibility tree (names, roles, focus all work) but gives them ZERO
 * geometry — and screen-reader browse modes (VoiceOver cursor, rotor, touch
 * exploration) are geometry-driven, so they skip boundless elements. A
 * rendered-but-transparent overlay gets real boxes, which makes browse mode
 * work and puts native focus rings exactly over the painted controls.
 *
 * Real DOM focus on mirror elements is the single source of truth for
 * `node.focused`; the overlay is `pointer-events: none` throughout so the
 * canvas keeps all pointer interaction.
 *
 * The mirror is synced **incrementally** from the same patch stream that
 * drives the canvas (`create/insert/move/remove/detach/attach/...`), so
 * mirror elements keep their identity across re-renders — a screen reader's
 * virtual cursor or a keyboard user's focus survives reactive updates
 * instead of being destroyed by a rebuild. Element positions are refreshed
 * after each canvas render via {@link syncPositions}.
 */
export class AccessibilityLayer {
  private mirrorRoot: HTMLElement;
  private nodeMap = new Map<string, HTMLElement>();
  private enabled: boolean;
  /** Whether the environment can host a mirror at all. */
  private supported: boolean;
  private canvas: HTMLElement | null;

  /**
   * Last box written to each mirror element, so the per-frame position sync
   * only touches elements whose geometry actually changed — style writes on
   * n absolutely-positioned elements per frame are what they cost.
   */
  private lastSyncedBounds = new WeakMap<
    HTMLElement,
    { x: number; y: number; width: number; height: number }
  >();
  private lastRootRect: { left: number; top: number; width: number; height: number } | null =
    null;

  private boundReposition = () => this.repositionRoot();

  constructor(canvas: HTMLElement | null, enabled: boolean = true) {
    this.canvas = canvas;
    // The overlay mounts on document.body (positioned with page
    // coordinates, like every canvas-adjacent helper here) — non-browser
    // environments disable the mirror rather than crash.
    this.supported =
      typeof document !== "undefined" &&
      !!(document as any).body &&
      typeof (document as any).body.appendChild === "function" &&
      !!canvas;
    this.enabled = enabled && this.supported;

    if (this.supported) {
      // Plain container — deliberately NO role="application": that role
      // switches screen readers out of virtual-cursor mode (arrow-key
      // browsing stops working) and announces the container on every
      // entry. The mirror is ordinary document content.
      this.mirrorRoot = document.createElement("div");
      this.mirrorRoot.setAttribute("data-hypen-a11y-overlay", "");
      Object.assign(this.mirrorRoot.style, {
        position: "absolute",
        overflow: "hidden",
        // The canvas owns ALL pointer interaction; the overlay is only for
        // keyboard and assistive technology.
        pointerEvents: "none",
      });
      if (this.enabled) {
        this.mount();
      }
    } else {
      // Inert placeholder for non-browser environments
      this.mirrorRoot = {} as HTMLElement;
    }
  }

  private mount(): void {
    // Pseudo-elements can't be styled inline: placeholders (and selection
    // highlights) would otherwise paint through the transparent overlay.
    if (!(document as any).getElementById?.("hypen-a11y-overlay-style")) {
      const style = document.createElement("style");
      style.id = "hypen-a11y-overlay-style";
      style.textContent = [
        "[data-hypen-a11y-overlay] input::placeholder,",
        "[data-hypen-a11y-overlay] textarea::placeholder { color: transparent; opacity: 0; }",
        "[data-hypen-a11y-overlay] ::selection { background: transparent; }",
        "[data-hypen-a11y-overlay] input,",
        "[data-hypen-a11y-overlay] textarea { resize: none; appearance: none; -webkit-appearance: none; }",
      ].join("\n");
      (document as any).head?.appendChild?.(style);
    }

    (document as any).body.appendChild(this.mirrorRoot);
    // The overlay carries the semantics; the (now childless) canvas would
    // otherwise surface as an anonymous element in browse mode.
    (this.canvas as any)?.setAttribute?.("aria-hidden", "true");
    if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
      window.addEventListener("resize", this.boundReposition);
      window.addEventListener("scroll", this.boundReposition, true);
    }
    this.repositionRoot();
  }

  private unmount(): void {
    this.mirrorRoot.remove();
    (this.canvas as any)?.removeAttribute?.("aria-hidden");
    if (typeof window !== "undefined" && typeof window.removeEventListener === "function") {
      window.removeEventListener("resize", this.boundReposition);
      window.removeEventListener("scroll", this.boundReposition, true);
    }
  }

  /** Pin the overlay root to the canvas's page rect. */
  private repositionRoot(): void {
    if (!this.enabled) return;
    const rect = (this.canvas as any)?.getBoundingClientRect?.();
    if (!rect) return;
    const sx = typeof window !== "undefined" ? window.scrollX ?? 0 : 0;
    const sy = typeof window !== "undefined" ? window.scrollY ?? 0 : 0;
    const left = rect.left + sx;
    const top = rect.top + sy;
    const last = this.lastRootRect;
    if (
      last &&
      last.left === left &&
      last.top === top &&
      last.width === rect.width &&
      last.height === rect.height
    ) {
      return;
    }
    this.lastRootRect = { left, top, width: rect.width, height: rect.height };
    Object.assign(this.mirrorRoot.style, {
      left: `${left}px`,
      top: `${top}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
    });
  }

  // -------------------------------------------------------------------------
  // Incremental patch mirroring
  // -------------------------------------------------------------------------

  /**
   * Mirror a `create` patch: build the element (detached — a subsequent
   * `insert` places it). Elements mirror the virtual tree 1:1; visibility
   * and decorative hiding are expressed with `display:none` (which removes
   * the subtree from the AT tree) instead of omission, so sibling order
   * always matches the virtual tree and `beforeId` mapping stays exact.
   *
   * The mirror's accessibility metadata (role, name, busy, hidden) comes
   * from the engine-derived {@link Semantics} block — the single source of
   * truth shared with every other renderer — not from ad-hoc prop sniffing.
   * Form *values* (input value/placeholder) still come from props, as those
   * aren't semantics.
   */
  createNode(node: VirtualNode): void {
    if (!this.enabled) return;

    let element = this.nodeMap.get(node.id);
    if (!element) {
      element = this.createShadowElement(node);
      element.setAttribute("data-hypen-id", node.id);
      // Rendered but invisible: real boxes for AT geometry, zero visual
      // presence — the canvas paints all pixels. `outline` is deliberately
      // NOT suppressed: the native focus ring lands exactly over the
      // painted control. Positions are written by syncPositions.
      Object.assign(element.style, {
        position: "absolute",
        margin: "0",
        padding: "0",
        border: "0",
        background: "transparent",
        color: "transparent",
        caretColor: "transparent",
        overflow: "hidden",
      });
      this.nodeMap.set(node.id, element);
    }

    if (node.focusable) {
      element.tabIndex = 0;
    }

    applyShadowSemantics(element, node.semantics);
    this.syncVisibility(element, node);
  }

  /**
   * Mirror an `insert` or `attach` patch. Re-inserting an element that is
   * already in the tree moves it (native `insertBefore` semantics), so
   * `move` routes here too. An `attach` reinserts the exact element kept
   * alive by {@link detachNode} — AT identity survives router navigation.
   */
  insertNode(parentId: string, id: string, beforeId?: string): void {
    if (!this.enabled) return;

    const element = this.nodeMap.get(id);
    if (!element) return;

    // Root mount: the engine addresses the root as its own parent (or under
    // the reserved "root" id). Everything else hangs off its parent element.
    const parent =
      parentId === id
        ? this.mirrorRoot
        : this.nodeMap.get(parentId) ?? (parentId === "root" ? this.mirrorRoot : null);
    if (!parent) return;

    const before = beforeId ? this.nodeMap.get(beforeId) : null;
    if (before && before.parentNode === parent) {
      parent.insertBefore(element, before);
    } else {
      // Unknown/foreign beforeId — same append fallback the virtual tree uses.
      parent.appendChild(element);
    }
  }

  /**
   * Mirror a `remove` patch: drop the element and purge the subtree's
   * id mappings.
   */
  removeNode(node: VirtualNode): void {
    if (!this.enabled) return;
    this.nodeMap.get(node.id)?.remove();
    this.purge(node);
  }

  private purge(node: VirtualNode): void {
    this.nodeMap.delete(node.id);
    for (const child of node.children) {
      this.purge(child);
    }
  }

  /**
   * Mirror a `detach` patch: unlink the element but keep the subtree and
   * all id mappings alive so a later `attach` reinserts the same elements
   * (router subtree cache parity).
   */
  detachNode(id: string): void {
    if (!this.enabled) return;
    this.nodeMap.get(id)?.remove();
  }

  /**
   * An exit playback started on this subtree root: the engine already
   * considers the ids dead, so the mirror must stop being interactive NOW —
   * `inert` blocks focus and activation for the whole subtree (and evicts
   * any focus the browser holds inside it), `aria-hidden` drops it from the
   * AT tree while the pixels fade. The element is removed outright when the
   * exit finalizes (`removeNode`). DOM-renderer parity: its `beginExit`
   * sets `inert` + the exiting attribute on the root immediately.
   */
  markExiting(id: string): void {
    if (!this.enabled) return;
    const element = this.nodeMap.get(id);
    if (!element) return;
    element.setAttribute("inert", "");
    element.setAttribute("aria-hidden", "true");
  }

  /**
   * Full rebuild from a virtual tree. Only used when re-enabling the mirror
   * (`setEnabled(true)`) and by `clear()` — steady-state sync is incremental.
   */
  rebuild(root: VirtualNode | null): void {
    if (!this.enabled) return;

    this.mirrorRoot.innerHTML = "";
    this.nodeMap.clear();

    if (root) {
      this.mountSubtree(root, this.mirrorRoot);
    }
  }

  private mountSubtree(node: VirtualNode, parent: HTMLElement): void {
    this.createNode(node);
    const element = this.nodeMap.get(node.id);
    if (!element) return;
    this.updateNode(node);
    parent.appendChild(element);
    for (const child of node.children) {
      this.mountSubtree(child, element);
    }
  }

  /**
   * `display:none` removes the subtree from the accessibility tree — used
   * both for `visible: false` and for decorative (`semantics.hidden`) nodes.
   */
  private syncVisibility(element: HTMLElement, node: VirtualNode): void {
    element.style.display = node.visible && !node.semantics?.hidden ? "" : "none";
  }

  /**
   * Write each mirror element's box to its node's painted (scroll-aware)
   * bounds — called by the renderer after every canvas render, so AT
   * geometry follows layout changes and container scrolling. Positions are
   * parent-relative (every mirror element is absolutely positioned).
   */
  syncPositions(root: VirtualNode | null): void {
    if (!this.enabled) return;
    this.repositionRoot();
    if (root) {
      this.syncNodePosition(root, 0, 0, 0, 0);
    }
  }

  /**
   * `scrollX`/`scrollY` accumulate the ancestors' scroll offsets down the
   * recursion (the same subtraction `getScrollAwareBounds` derives by
   * walking up), keeping the pass O(n) instead of O(n·depth). Writes are
   * skipped when the element's box is unchanged since the last sync.
   */
  private syncNodePosition(
    node: VirtualNode,
    parentX: number,
    parentY: number,
    scrollX: number,
    scrollY: number,
  ): void {
    const element = this.nodeMap.get(node.id);
    if (!element || !node.layout) return;

    // Video composition slots are shown/hidden, not mounted/unmounted: a
    // slot the normative table hides keeps its subtree (and its state) but
    // must not be announced or reachable, so it drops out of the mirror
    // the same way `visible: false` does.
    if (node.parent && findEnclosingVideoNode(node.parent) === node.parent) {
      const shown = isVideoSlotChildVisible(node);
      element.style.display = shown && node.visible && !node.semantics?.hidden ? "" : "none";
      if (!shown) return;
    }

    // A Scrubber is a slider to AT: keep its value + value text on the live
    // playback position (this runs after every canvas render, so the
    // announced time never goes stale).
    if (isScrubberNode(node)) {
      this.syncScrubberValue(element, node);
    }

    const x = node.layout.x - scrollX;
    const y = node.layout.y - scrollY;
    const width = node.layout.width;
    const height = node.layout.height;

    const relX = x - parentX;
    const relY = y - parentY;
    const last = this.lastSyncedBounds.get(element);
    if (!last || last.x !== relX || last.y !== relY || last.width !== width || last.height !== height) {
      element.style.left = `${relX}px`;
      element.style.top = `${relY}px`;
      element.style.width = `${width}px`;
      element.style.height = `${height}px`;
      this.lastSyncedBounds.set(element, { x: relX, y: relY, width, height });
    }

    const childScrollX = scrollX + (node.scrollState?.scrollX ?? 0);
    const childScrollY = scrollY + (node.scrollState?.scrollY ?? 0);
    for (const child of node.children) {
      this.syncNodePosition(child, x, y, childScrollX, childScrollY);
    }
  }

  /**
   * `role="slider"` value exposure for a Scrubber. The engine already
   * derives the role (semantics.rs maps `Scrubber` → `Role::Slider`); the
   * numbers only exist renderer-side, so they are written here: seconds for
   * `aria-valuenow`/`max`, and a spoken `m:ss of m:ss` as `aria-valuetext`.
   * A Scrubber outside a Video has no timeline — it carries no value.
   */
  private syncScrubberValue(element: HTMLElement, node: VirtualNode): void {
    const videoNode = findEnclosingVideoNode(node.parent);
    const playback = videoNode ? getVideoPlayback(videoNode.id) : null;
    if (!playback || playback.duration <= 0) {
      element.removeAttribute("aria-valuenow");
      element.removeAttribute("aria-valuetext");
      return;
    }
    const position = getScrubberFraction(node) * playback.duration;
    element.setAttribute("aria-valuemin", "0");
    element.setAttribute("aria-valuemax", String(Math.round(playback.duration)));
    element.setAttribute("aria-valuenow", String(Math.round(position)));
    element.setAttribute(
      "aria-valuetext",
      `${formatMediaTime(position)} of ${formatMediaTime(playback.duration)}`,
    );
  }

  /**
   * Choose the semantic HTML tag for a node's shadow element and set its
   * non-accessibility content (text, input value/placeholder). Roles/names are
   * applied separately from the semantics block.
   */
  private createShadowElement(node: VirtualNode): HTMLElement {
    switch (node.type.toLowerCase()) {
      case "button":
        return document.createElement("button");

      case "link": {
        const a = document.createElement("a");
        a.setAttribute("href", "#");
        return a;
      }

      case "input": {
        const input = document.createElement("input") as HTMLInputElement;
        input.type = node.props.type || "text";
        input.value = node.props.value || "";
        if (node.props.placeholder) input.placeholder = node.props.placeholder;
        return input;
      }

      case "textarea": {
        const textarea = document.createElement("textarea") as HTMLTextAreaElement;
        textarea.value = node.props.value || "";
        if (node.props.placeholder) textarea.placeholder = node.props.placeholder;
        return textarea;
      }

      case "image":
        return document.createElement("img");

      case "video":
        // Bare mirror element: real playback happens in the paint system's
        // offscreen element, so this carries only semantics/geometry for AT
        // (no src — a second network fetch would be wasteful and audible).
        return document.createElement("video");

      case "heading": {
        // Use the derived level when known; fall back to a generic h2.
        const level = Math.min(6, Math.max(1, node.semantics?.level ?? 2));
        return document.createElement(`h${level}`);
      }

      case "text": {
        const span = document.createElement("span");
        span.textContent = String(node.props[0] || node.props.text || "");
        return span;
      }

      case "column":
      case "row":
      case "container":
      case "box":
        // Plain div — role="group" made browse mode announce "group" on
        // every layout container (the DOM renderer emits plain divs too).
        return document.createElement("div");

      default:
        return document.createElement("div");
    }
  }

  /**
   * Focus node in shadow DOM
   */
  focusNode(nodeId: string): void {
    if (!this.enabled) return;

    const element = this.nodeMap.get(nodeId);
    if (element) {
      element.focus();
    }
  }

  /**
   * Update single node
   */
  updateNode(node: VirtualNode): void {
    if (!this.enabled) return;

    const element = this.nodeMap.get(node.id);
    if (!element) return;

    const type = node.type.toLowerCase();

    // Update text content
    if (type === "text") {
      element.textContent = String(node.props[0] || node.props.text || "");
    }

    // Update input value. Guarded — assigning even an identical value can
    // collapse the browser's caret/selection in a focused mirror input.
    if (type === "input" || type === "textarea") {
      const input = element as HTMLInputElement | HTMLTextAreaElement;
      const value = node.props.value || "";
      if (input.value !== value) {
        input.value = value;
      }
      if (node.props.placeholder != null) {
        input.placeholder = node.props.placeholder;
      }
    }

    // Re-apply semantics: painted text is invisible to AT, so a reactively
    // changed accessible name/state only reaches screen readers through the
    // shadow node's ARIA attributes. `applyShadowSemantics` clears anything
    // it set previously that the current block no longer produces.
    applyShadowSemantics(element, node.semantics);

    this.syncVisibility(element, node);
  }

  /**
   * Get shadow element by node ID
   */
  getElement(nodeId: string): HTMLElement | undefined {
    return this.nodeMap.get(nodeId);
  }

  /** The fallback-content root element (for focus delegation wiring). */
  getRoot(): HTMLElement | null {
    return this.supported ? this.mirrorRoot : null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Enable or disable the mirror. Re-enabling rebuilds from the given
   * virtual tree (incremental sync has no history to replay).
   */
  setEnabled(enabled: boolean, root?: VirtualNode | null): void {
    const next = enabled && this.supported;
    if (next === this.enabled) return;
    this.enabled = next;

    if (!next) {
      this.unmount();
      this.nodeMap.clear();
    } else {
      this.mount();
      this.rebuild(root ?? null);
      this.syncPositions(root ?? null);
    }
  }

  /**
   * Cleanup
   */
  destroy(): void {
    if (this.supported) {
      this.unmount();
    }
    this.nodeMap.clear();
  }
}


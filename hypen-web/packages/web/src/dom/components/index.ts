/**
 * Component Registry
 *
 * Manages mappings from Hypen component types to DOM elements
 */

export interface ComponentHandler {
  /**
   * Build the host element.
   *
   * `props` carries the node's creation props so a handler whose *tag* depends
   * on a prop can pick the right one up front. It must not be relied on for
   * anything a later `applyProps` can set: a handler that swapped its element
   * out during `applyProps` would orphan the renderer's `nodes` map, since
   * `createElement` runs before the element is ever parented.
   */
  create(props?: Record<string, any>): HTMLElement;
  applyProps?(element: HTMLElement, props: Record<string, any>): void;
  /**
   * Called after the renderer changes this component's direct children.
   * Native container components can use this instead of depending on an
   * asynchronous MutationObserver to keep renderer-owned child state live.
   */
  onChildrenChanged?(element: HTMLElement): void;
  /**
   * Rebuild per-element state for a node the renderer materialized by CLONING
   * a registered template prototype (`registerTemplate` + `instantiate`, the
   * plannable-list-row path).
   *
   * `cloneNode` copies the DOM and nothing else: WeakMap entries keyed by the
   * element, event listeners and every other JS-side association belong to
   * the prototype alone. Handlers that keep such state MUST implement this
   * and rebuild it from markers their `create()`/`applyProps()` stamped into
   * the DOM (dataset/attributes, which do survive). Handlers whose state
   * lives entirely in the DOM need nothing.
   */
  adopt?(element: HTMLElement): void;
}

/**
 * Add a bare alias for every `<name>.0` key so handlers can read one spelling.
 *
 * The engine lowers applicators to `<name>.0` but leaves constructor arguments
 * bare, so `Slider(value: 5)` and `Slider().value(5)` arrive under different
 * keys. Aliasing is additive and non-destructive: the original `.0` key is
 * kept (handlers that already read it keep working), an existing bare key
 * always wins, and the caller's object is never mutated — the applicator pass
 * still sees the untouched props.
 */
export function aliasApplicatorSpellings(
  props: Record<string, any>
): Record<string, any> {
  let out: Record<string, any> | null = null;
  for (const key in props) {
    if (!key.endsWith(".0")) continue;
    const bare = key.slice(0, -2);
    if (!bare || bare in props) continue;
    if (out === null) out = { ...props };
    if (!(bare in out)) out[bare] = props[key];
  }
  return out ?? props;
}

/**
 * Coerce a wire value to a boolean.
 *
 * Bare `Boolean(v)` is wrong here: the remote protocol and Tailwind lowering
 * can both deliver a boolean as the *string* `"false"`, which is truthy.
 */
export function toBool(value: any): boolean {
  if (typeof value === "string") {
    const v = value.trim().toLowerCase();
    if (v === "false" || v === "0" || v === "") return false;
    return true;
  }
  return Boolean(value);
}

/**
 * True when `props` mentions `name` at all — an explicit `undefined` included.
 *
 * That distinction is the RemoveProp contract: the renderer re-applies a
 * node's remaining props with the removed key present but `undefined`, so a
 * handler guarding `props.x !== undefined` would skip it and leave the
 * attribute it last wrote in place. Guard on this instead and write the
 * prop's default for the `undefined` case.
 */
export function hasProp(props: Record<string, any>, name: string): boolean {
  return Object.prototype.hasOwnProperty.call(props, name);
}

export class ComponentRegistry {
  private handlers: Map<string, ComponentHandler> = new Map();

  constructor() {
    this.registerDefaults();
  }

  /**
   * Register a component handler
   */
  register(type: string, handler: ComponentHandler): void {
    this.handlers.set(type.toLowerCase(), handler);
  }

  /**
   * Get handler for a component type
   */
  get(type: string): ComponentHandler | undefined {
    if (!type) return undefined;
    return this.handlers.get(type.toLowerCase());
  }

  /**
   * Create element for a component type
   */
  createElement(type: string, props: Record<string, any> = {}): HTMLElement | null {
    if (!type) return null;
    const handler = this.get(type);
    if (!handler) return null;

    const withAliases = aliasApplicatorSpellings(props);
    const element = handler.create(withAliases);
    if (handler.applyProps) {
      handler.applyProps(element, withAliases);
    }
    return element;
  }

  /**
   * Notify a native component that its direct child list or a child's slot
   * assignment changed.
   */
  notifyChildrenChanged(element: HTMLElement): void {
    const type = element.dataset.hypenType;
    if (!type) return;
    this.get(type)?.onChildrenChanged?.(element);
  }

  /**
   * Let a component re-register the per-element state a `cloneNode`-built
   * template instance lost. No-op for handlers without an `adopt` hook.
   */
  adopt(element: HTMLElement): void {
    const type = element.dataset.hypenType;
    if (!type) return;
    this.get(type)?.adopt?.(element);
  }

  /**
   * Register all default Hypen components
   */
  private registerDefaults(): void {
    // Import and register all component handlers
    const { columnHandler } = require("./column.js");
    const { rowHandler } = require("./row.js");
    const { textHandler } = require("./text.js");
    const { imageHandler } = require("./image.js");
    const { buttonHandler } = require("./button.js");
    const { containerHandler } = require("./container.js");
    const { centerHandler } = require("./center.js");
    const { listHandler } = require("./list.js");
    const { inputHandler } = require("./input.js");
    const { linkHandler } = require("./link.js");
    const { textareaHandler } = require("./textarea.js");
    const { checkboxHandler } = require("./checkbox.js");
    const { selectHandler } = require("./select.js");
    const { spacerHandler } = require("./spacer.js");
    const { stackHandler } = require("./stack.js");
    const { dividerHandler } = require("./divider.js");
    const { gridHandler } = require("./grid.js");
    const { cardHandler } = require("./card.js");
    const { headingHandler } = require("./heading.js");
    const { switchHandler } = require("./switch.js");
    const { sliderHandler } = require("./slider.js");
    const { scrubberHandler } = require("./scrubber.js");
    const { spinnerHandler } = require("./spinner.js");
    const { badgeHandler } = require("./badge.js");
    const { avatarHandler } = require("./avatar.js");
    const { progressBarHandler } = require("./progressbar.js");
    const { videoHandler } = require("./video.js");
    const { audioHandler } = require("./audio.js");
    const { paragraphHandler } = require("./paragraph.js");
    const { routerHandler } = require("./router.js");
    const { routeHandler } = require("./route.js");
    const { hypenAppHandler } = require("./hypenapp.js");
    const { appHandler } = require("./app.js");
    const { iconHandler } = require("./icon.js");
    const { visuallyHiddenHandler } = require("./visuallyhidden.js");
    const { tabsHandler, tabHandler, tabPanelHandler, optionHandler } = require("./tabs.js");
    const { safeAreaHandler } = require("./safearea.js");

    this.register("app", appHandler);
    this.register("visuallyhidden", visuallyHiddenHandler);
    this.register("icon", iconHandler);
    this.register("column", columnHandler);
    this.register("row", rowHandler);
    this.register("text", textHandler);
    this.register("image", imageHandler);
    this.register("button", buttonHandler);
    this.register("container", containerHandler);
    this.register("box", containerHandler);
    this.register("center", centerHandler);
    this.register("list", listHandler);
    this.register("input", inputHandler);
    this.register("link", linkHandler);
    this.register("textarea", textareaHandler);
    this.register("checkbox", checkboxHandler);
    this.register("select", selectHandler);
    this.register("spacer", spacerHandler);
    this.register("stack", stackHandler);
    this.register("divider", dividerHandler);
    this.register("grid", gridHandler);
    this.register("card", cardHandler);
    this.register("heading", headingHandler);
    this.register("switch", switchHandler);
    this.register("slider", sliderHandler);
    this.register("scrubber", scrubberHandler);
    this.register("spinner", spinnerHandler);
    this.register("badge", badgeHandler);
    this.register("avatar", avatarHandler);
    this.register("progressbar", progressBarHandler);
    this.register("video", videoHandler);
    this.register("audio", audioHandler);
    this.register("paragraph", paragraphHandler);
    this.register("tabs", tabsHandler);
    this.register("tab", tabHandler);
    this.register("tabpanel", tabPanelHandler);
    this.register("option", optionHandler);
    this.register("router", routerHandler);
    this.register("route", routeHandler);
    this.register("hypenapp", hypenAppHandler);
    this.register("safearea", safeAreaHandler);
  }
}

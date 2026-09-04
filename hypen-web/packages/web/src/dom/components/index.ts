/**
 * Component Registry
 *
 * Manages mappings from Hypen component types to DOM elements
 */

export interface ComponentHandler {
  create(): HTMLElement;
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

    const element = handler.create();
    if (handler.applyProps) {
      handler.applyProps(element, props);
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
  }
}

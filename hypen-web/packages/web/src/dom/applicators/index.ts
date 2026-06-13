/**
 * Applicator Registry
 *
 * Handles style applicators (modifiers) for Hypen components
 */

// Re-export the type from types.ts to maintain API compatibility
export type { ApplicatorHandler } from "./types.js";
import type { ApplicatorHandler } from "./types.js";

// Static imports for all applicator handlers (avoids circular dependency)
import {
  paddingHandler,
  paddingTopHandler,
  paddingBottomHandler,
  paddingLeftHandler,
  paddingRightHandler,
  paddingHorizontalHandler,
  paddingVerticalHandler,
} from "./padding.js";
import {
  marginHandler,
  marginTopHandler,
  marginBottomHandler,
  marginLeftHandler,
  marginRightHandler,
  marginHorizontalHandler,
  marginVerticalHandler,
} from "./margin.js";
import { colorHandlers } from "./color.js";
import { borderHandlers } from "./border.js";
import { sizeHandlers } from "./size.js";
import { fontHandlers } from "./font.js";
import { layoutHandlers } from "./layout.js";
import { eventHandlers } from "./events.js";
import { typographyHandlers } from "./typography.js";
import { transformHandlers } from "./transform.js";
import { effectsHandlers } from "./effects.js";
import { advancedLayoutHandlers } from "./advanced-layout.js";
import { backgroundHandlers } from "./background.js";
import { displayHandlers } from "./display.js";
import { transitionHandlers } from "./transition.js";

/**
 * Tailwind breakpoint values for responsive variants
 */
const BREAKPOINTS: Record<string, string> = {
  sm: '640px',
  md: '768px',
  lg: '1024px',
  xl: '1280px',
  '2xl': '1536px',
};

/**
 * Singleton stylesheet for variant CSS rules
 */
let variantStyleSheet: CSSStyleSheet | null = null;

/**
 * Track inserted rules to avoid duplicates
 */
const insertedRules = new Set<string>();

/**
 * Get or create the variant stylesheet
 */
function getVariantStyleSheet(): CSSStyleSheet {
  if (!variantStyleSheet) {
    const style = document.createElement('style');
    style.id = 'hypen-variants';
    document.head.appendChild(style);
    variantStyleSheet = style.sheet as CSSStyleSheet;
  }
  return variantStyleSheet;
}

/**
 * Generate a simple hash for deduplication
 */
function hashValue(value: any): string {
  return String(value).replace(/[^a-zA-Z0-9]/g, '').slice(0, 8);
}

export class ApplicatorRegistry {
  private handlers: Map<string, ApplicatorHandler> = new Map();
  private elementState: WeakMap<HTMLElement, Map<string, any>> = new WeakMap();

  constructor() {
    this.registerDefaults();
  }

  /**
   * Register an applicator handler
   */
  register(name: string, handler: ApplicatorHandler): void {
    this.handlers.set(name, handler);
  }

  /**
   * Apply an applicator to an element
   */
  apply(element: HTMLElement, name: string, value: any): void {
    // Parse applicator metadata so we can normalize event arguments and retain legacy behavior
    const { handlerName, argKey, aggregate, fallbackName } = this.parseApplicatorName(name);

    const handler = this.handlers.get(handlerName);
    const state = this.getElementState(element);
    const previous = state.get(handlerName);

    if (aggregate && argKey !== null) {
      // Merge event payload updates with the previously applied arguments so handlers
      // always receive the full payload object (prevents stale dispatch data)
      const merged = this.mergeAggregateState(previous, argKey, this.normalizeValue(value));

      state.set(handlerName, merged);

      if (handler) {
        handler(element, merged);
      } else {
        // Fallback: set as CSS property using the original name if no handler exists
        this.setStyleProperty(element, fallbackName, value);
      }
      return;
    }

    if (handler) {
      if (this.isEventApplicator(handlerName)) {
        const normalizedValue = this.normalizeEventValue(previous, value);
        state.set(handlerName, normalizedValue);
        handler(element, normalizedValue);
      } else {
        state.set(handlerName, value);
        handler(element, value);
      }
    } else {
      // Fallback: set as CSS property
      this.setStyleProperty(element, handlerName, value);
    }
  }

  /**
   * Parse applicator name to handle indexed and event argument formats
   * e.g., "fontSize.0" -> { handlerName: "fontSize" }
   *       "onClick.id" -> { handlerName: "onClick", aggregate: true, argKey: "id" }
   * Keeps compound names like "padding.top" as-is so they can fall back to CSS.
   */
  private parseApplicatorName(name: string): {
    handlerName: string;
    argKey: string | null;
    aggregate: boolean;
    fallbackName: string;
  } {
    const dotIndex = name.indexOf('.');
    if (dotIndex === -1) {
      return { handlerName: name, argKey: null, aggregate: false, fallbackName: name };
    }

    const baseName = name.substring(0, dotIndex);
    const argKey = name.substring(dotIndex + 1);

    if (this.handlers.has(baseName) && this.isEventApplicator(baseName)) {
      return { handlerName: baseName, argKey, aggregate: true, fallbackName: name };
    }

    if (/^\d+$/.test(argKey)) {
      return { handlerName: baseName, argKey: null, aggregate: false, fallbackName: baseName };
    }

    return { handlerName: name, argKey: null, aggregate: false, fallbackName: name };
  }

  /**
   * Get or initialize per-element applicator state used for merging event payloads
   */
  private getElementState(element: HTMLElement): Map<string, any> {
    let state = this.elementState.get(element);
    if (!state) {
      state = new Map();
      this.elementState.set(element, state);
    }
    return state;
  }

  /**
   * Merge updated event argument into previously stored payload snapshot
   */
  private mergeAggregateState(previous: any, argKey: string, value: any): Record<string, any> {
    const base: Record<string, any> = this.cloneAggregateState(previous);

    if (value === undefined) {
      delete base[argKey];
    } else {
      base[argKey] = value;
    }

    return base;
  }

  /**
   * Convert stored state into a mutable payload object we can merge into
   */
  private cloneAggregateState(previous: any): Record<string, any> {
    if (previous && typeof previous === "object" && !Array.isArray(previous)) {
      return { ...previous };
    }

    if (typeof previous === "string") {
      return { "0": previous };
    }

    return {};
  }

  /**
   * Normalize event value updates so action payload arguments persist across SetProp orderings
   */
  private normalizeEventValue(previous: any, value: any): Record<string, any> {
    const normalizedInput = this.normalizeValue(value);
    const base = this.cloneAggregateState(previous);

    if (normalizedInput && typeof normalizedInput === "object" && !Array.isArray(normalizedInput)) {
      const next = { ...base, ...normalizedInput } as Record<string, any>;

      if (!Object.prototype.hasOwnProperty.call(next, "0") && base["0"] !== undefined) {
        next["0"] = base["0"];
      }

      return next;
    }

    if (normalizedInput !== undefined) {
      base["0"] = normalizedInput;
    }

    return base;
  }

  /**
   * Convert Maps (from WASM) and nested structures into plain JS values we can merge safely
   */
  private normalizeValue(value: any): any {
    if (value instanceof Map) {
      const obj: Record<string, any> = {};
      for (const [key, val] of value.entries()) {
        obj[key] = this.normalizeValue(val);
      }
      return obj;
    }

    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeValue(item));
    }

    if (value && typeof value === "object") {
      const obj: Record<string, any> = {};
      for (const [key, val] of Object.entries(value)) {
        obj[key] = this.normalizeValue(val);
      }
      return obj;
    }

    return value;
  }

  /**
   * Determine if a handler name follows the event applicator naming convention
   */
  private isEventApplicator(name: string): boolean {
    return /^on[A-Z]/.test(name);
  }

  /**
   * Apply multiple applicators
   */
  applyAll(element: HTMLElement, applicators: Record<string, any>): void {


    // Group applicators by their base name (treat applicators like components with arguments)
    // e.g., "onClick.0", "onClick.id", "onClick.title" -> onClick: {0: ..., id: ..., title: ...}
    const grouped = new Map<string, Record<string, any>>();

    for (const [name, value] of Object.entries(applicators)) {
      // Extract base name and argument key
      const dotIndex = name.indexOf('.');
      const baseName = dotIndex !== -1 ? name.substring(0, dotIndex) : name;
      const argKey = dotIndex !== -1 ? name.substring(dotIndex + 1) : null;

      if (!grouped.has(baseName)) {
        grouped.set(baseName, {});
      }

      const args = grouped.get(baseName)!;
      if (argKey !== null) {
        // This is an argument (e.g., "onClick.0" or "onClick.id")
        args[argKey] = value;
      } else {
        // This is a single-value applicator (e.g., "padding")
        args['__value'] = value;
      }
    }

    // Apply each applicator with its arguments
    for (const [baseName, args] of grouped.entries()) {
      // If it's a single value (either __value or just "0"), pass just the value
      if (Object.keys(args).length === 1) {
        if ('__value' in args) {
          this.apply(element, baseName, args['__value']);
        } else if ('0' in args) {
          // Single positional argument (e.g., padding.0 -> just pass the value)
          this.apply(element, baseName, args['0']);
        } else {
          // Single named argument? Pass the whole object
          this.apply(element, baseName, args);
        }
      } else {
        // Multiple arguments - pass the entire args object
        this.apply(element, baseName, args);
      }
    }
  }

  /**
   * Set a CSS property with automatic unit handling and variant support
   */
  private setStyleProperty(element: HTMLElement, name: string, value: any): void {
    const atIndex = name.indexOf('@');
    const colonIndex = name.indexOf(':');

    // Responsive variant: padding@md, width@lg, etc.
    if (atIndex !== -1) {
      const prop = name.slice(0, atIndex);
      const breakpoint = name.slice(atIndex + 1);
      const minWidth = BREAKPOINTS[breakpoint];

      if (minWidth) {
        const cssName = this.toKebabCase(prop);
        const cssValue = this.formatCssValue(cssName, value);
        const className = `hypen-${cssName.replace(/[^a-zA-Z0-9-]/g, '')}-${breakpoint}-${hashValue(value)}`;
        const ruleKey = `${className}:${cssValue}`;

        // Avoid duplicate rule insertion
        if (!insertedRules.has(ruleKey)) {
          const sheet = getVariantStyleSheet();
          sheet.insertRule(
            `@media (min-width: ${minWidth}) { .${className} { ${cssName}: ${cssValue}; } }`,
            sheet.cssRules.length
          );
          insertedRules.add(ruleKey);
        }

        element.classList.add(className);
      }
      return;
    }

    // State variant: background-color:hover, border-color:focus, etc.
    if (colonIndex !== -1) {
      const prop = name.slice(0, colonIndex);
      const state = name.slice(colonIndex + 1);

      // Only handle known CSS pseudo-states
      const validStates = ['hover', 'focus', 'active', 'disabled', 'focus-visible', 'focus-within'];
      if (validStates.includes(state)) {
        const cssName = this.toKebabCase(prop);
        const cssValue = this.formatCssValue(cssName, value);
        const className = `hypen-${cssName.replace(/[^a-zA-Z0-9-]/g, '')}-${state}-${hashValue(value)}`;
        const ruleKey = `${className}:${cssValue}`;

        // Avoid duplicate rule insertion
        if (!insertedRules.has(ruleKey)) {
          const sheet = getVariantStyleSheet();
          sheet.insertRule(
            `.${className}:${state} { ${cssName}: ${cssValue}; }`,
            sheet.cssRules.length
          );
          insertedRules.add(ruleKey);
        }

        element.classList.add(className);
      }
      return;
    }

    // Normal property: convert camelCase to kebab-case and apply
    const cssName = this.toKebabCase(name);
    element.style.setProperty(cssName, this.formatCssValue(cssName, value));
  }

  /**
   * Convert camelCase to kebab-case
   */
  private toKebabCase(name: string): string {
    return name.replace(/([A-Z])/g, "-$1").toLowerCase();
  }

  /**
   * Format a CSS value with automatic unit handling
   */
  private formatCssValue(cssName: string, value: any): string {
    if (typeof value === "number" && this.needsUnit(cssName)) {
      return `${value}px`;
    }
    return String(value);
  }

  /**
   * Check if a property needs a unit
   */
  private needsUnit(prop: string): boolean {
    const unitless = [
      "opacity",
      "z-index",
      "font-weight",
      "line-height",
      "flex",
      "flex-grow",
      "flex-shrink",
      "order",
    ];
    return !unitless.includes(prop);
  }

  /**
   * Register default applicator handlers
   * Uses statically imported handlers (defined at top of file) to avoid circular dependencies
   */
  private registerDefaults(): void {
    this.register("padding", paddingHandler);
    this.register("paddingTop", paddingTopHandler);
    this.register("paddingBottom", paddingBottomHandler);
    this.register("paddingLeft", paddingLeftHandler);
    this.register("paddingRight", paddingRightHandler);
    this.register("paddingHorizontal", paddingHorizontalHandler);
    this.register("paddingVertical", paddingVerticalHandler);
    this.register("margin", marginHandler);
    this.register("marginTop", marginTopHandler);
    this.register("marginBottom", marginBottomHandler);
    this.register("marginLeft", marginLeftHandler);
    this.register("marginRight", marginRightHandler);
    this.register("marginHorizontal", marginHorizontalHandler);
    this.register("marginVertical", marginVerticalHandler);

    for (const [name, handler] of Object.entries(colorHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }

    for (const [name, handler] of Object.entries(borderHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }

    for (const [name, handler] of Object.entries(sizeHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }

    for (const [name, handler] of Object.entries(fontHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }

    for (const [name, handler] of Object.entries(layoutHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }

    for (const [name, handler] of Object.entries(eventHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }

    for (const [name, handler] of Object.entries(typographyHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }

    for (const [name, handler] of Object.entries(transformHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }

    for (const [name, handler] of Object.entries(effectsHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }

    for (const [name, handler] of Object.entries(advancedLayoutHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }

    for (const [name, handler] of Object.entries(backgroundHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }

    for (const [name, handler] of Object.entries(displayHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }

    for (const [name, handler] of Object.entries(transitionHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }
  }
}

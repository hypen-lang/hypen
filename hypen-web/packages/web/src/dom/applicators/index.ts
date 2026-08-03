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
import { BREAKPOINTS as VARIANT_BREAKPOINTS, parseVariantKey } from "../../variants.js";
import { ariaHandlers } from "./aria.js";
import { frameworkLoggers } from "@hypen-space/core/logger";

const log = frameworkLoggers.renderer;

/**
 * Tailwind breakpoint values for responsive variants.
 * Derived from the shared `variants.ts` table (single source of truth across
 * DOM + Canvas renderers) and expressed as CSS `px` strings for media queries.
 */
const BREAKPOINTS: Record<string, string> = Object.fromEntries(
  Object.entries(VARIANT_BREAKPOINTS).map(([name, px]) => [name, `${px}px`]),
);

/**
 * Singleton stylesheet for variant CSS rules
 */
let variantStyleSheet: CSSStyleSheet | null = null;
let variantStyleElement: HTMLStyleElement | null = null;

/**
 * Track inserted rules to avoid duplicates. Keyed by full rule text and
 * cleared whenever the stylesheet is (re-)created, so the cache can never
 * suppress an insert into a *different* sheet than the one it was recorded
 * against (tests swap `document`; a host page may drop the style element).
 */
const insertedRules = new Set<string>();

/**
 * Get or create the variant stylesheet
 */
function getVariantStyleSheet(): CSSStyleSheet {
  const stale =
    !variantStyleSheet ||
    !variantStyleElement ||
    variantStyleElement.ownerDocument !== document ||
    (variantStyleElement as { isConnected?: boolean }).isConnected === false;

  if (stale) {
    const style = document.createElement('style');
    style.id = 'hypen-variants';
    document.head.appendChild(style);
    variantStyleElement = style;
    variantStyleSheet = style.sheet as CSSStyleSheet;
    insertedRules.clear();
  }
  return variantStyleSheet!;
}

/**
 * Class-name suffix identifying a declaration set.
 *
 * A readable prefix (first 8 alphanumerics) keeps generated classes greppable,
 * but it cannot stand alone: values are read back from the CSSOM already
 * normalized, so `#333333` and `#333334` both arrive as `rgb(51, 51, 5…` and
 * truncate to the SAME 8 characters. Two different values sharing a class
 * means one silently renders as the other, so a full-string djb2 is appended.
 */
function hashValue(value: any): string {
  const raw = String(value);
  let hash = 5381;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) + hash + raw.charCodeAt(i)) | 0;
  }
  return `${raw.replace(/[^a-zA-Z0-9]/g, '').slice(0, 8)}-${(hash >>> 0).toString(36)}`;
}

/**
 * Applicator bases whose inline styles are owned by the animator
 * (`dom/anim.ts` writes, captures and restores these longhands directly on
 * the element). Moving them into the variant stylesheet would put them back
 * behind the animator's inline writes — the exact shadowing this module
 * exists to prevent — so they are reported as not variant-expressible.
 */
const ANIMATOR_OWNED_BASES = new Set([
  "transition",
  "transitionProperty",
  "transitionDuration",
  "transitionTimingFunction",
  "transitionDelay",
  "animation",
  "animationName",
  "animationDuration",
  "animationTimingFunction",
  "animationDelay",
  "animationIterationCount",
  "animationDirection",
  "animationFillMode",
  "animationPlayState",
]);

/** A prop key split into its base name and (optional) variant qualifiers. */
interface VariantInfo {
  /** camelCase base applicator name, e.g. "opacity". */
  base: string;
  /** Breakpoint name (validated) or null. */
  breakpoint: string | null;
  /** Interaction state (validated) or null. */
  state: string | null;
  /** True when the key carries a breakpoint and/or a state. */
  qualified: boolean;
}

/** Declarations a value lowers to, or the reason it cannot be lowered. */
type Lowered =
  | { decls: Record<string, string>; dataset: Record<string, string>; reason?: undefined }
  | { reason: string; decls?: undefined; dataset?: undefined };

/** Per-element bookkeeping for props that participate in a variant group. */
interface VariantMeta {
  /** Bases with at least one variant-qualified sibling on this element. */
  bases: Set<string>;
  /** Qualified key (e.g. "opacity:hover", or "opacity" for the default) -> applied class. */
  classes: Map<string, string>;
  /** Bases already warned about, so the warning fires once per element+base. */
  warned: Set<string>;
}

export class ApplicatorRegistry {
  private handlers: Map<string, ApplicatorHandler> = new Map();
  private elementState: WeakMap<HTMLElement, Map<string, any>> = new WeakMap();
  /**
   * Variant bookkeeping, allocated lazily and ONLY for elements that actually
   * carry a variant-qualified prop — an element with plain props costs nothing.
   */
  private variantMeta: WeakMap<HTMLElement, VariantMeta> = new WeakMap();
  /** Detached element used to observe what a handler writes. See `lower()`. */
  private probe: HTMLElement | null = null;

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
   *
   * Variant contract: a prop that has ANY variant-qualified sibling on this
   * element (`opacity:hover`, `padding@md`, …) has its DEFAULT routed through
   * the same stylesheet mechanism as the variants, instead of through its
   * handler's inline write. Both then sit at the same specificity tier and the
   * normal CSS cascade decides — an inline default can no longer permanently
   * shadow every variant. Props with no variants are untouched: they still go
   * through their handler exactly as before.
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

    // Variant routing. A qualified key (`opacity:hover`) always becomes a rule;
    // an unqualified key becomes a rule too once the element is known to carry
    // variants for that base, so the default cannot shadow them inline.
    const variant = this.classifyVariant(handlerName);
    if (variant) {
      if (variant.qualified) {
        this.registerVariantBase(element, variant.base);
        this.applyVariantRule(element, handlerName, variant, value);
        return;
      }
      if (
        this.variantMeta.get(element)?.bases.has(variant.base) &&
        this.applyDefaultAsRule(element, variant.base, value)
      ) {
        state.set(handlerName, value);
        return;
      }
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

  // ==========================================================================
  // Variant routing
  // ==========================================================================

  /**
   * Split an already-arg-stripped applicator name into base + variant markers.
   *
   * Returns null for keys the variant machinery must not touch: event
   * applicators, compound named-arg keys (`padding.top`), and malformed
   * variants whose leftover base still contains an `@`/`:` (e.g.
   * `backgroundColor@bogus:hover` — an unknown breakpoint). Those keep their
   * pre-existing behaviour, which for a malformed variant is "apply nothing".
   */
  private classifyVariant(name: string): VariantInfo | null {
    if (this.isEventApplicator(name)) return null;

    const parsed = parseVariantKey(name);
    // A named-arg compound key (`padding.top`) is not a variant key.
    if (parsed.arg !== null) return null;

    const qualified = parsed.breakpoint !== null || parsed.state !== null;
    if (qualified && (parsed.base.includes("@") || parsed.base.includes(":"))) {
      return null;
    }

    return {
      base: parsed.base,
      breakpoint: parsed.breakpoint,
      state: parsed.state,
      qualified,
    };
  }

  private getVariantMeta(element: HTMLElement): VariantMeta {
    let meta = this.variantMeta.get(element);
    if (!meta) {
      meta = { bases: new Set(), classes: new Map(), warned: new Set() };
      this.variantMeta.set(element, meta);
    }
    return meta;
  }

  /**
   * Mark `base` as variant-bearing on this element. First time only, an
   * already-applied inline default is converted to a rule retroactively —
   * prop application order is not guaranteed, so the variant may well arrive
   * after the default has already been written inline by its handler.
   */
  private registerVariantBase(element: HTMLElement, base: string): void {
    const meta = this.getVariantMeta(element);
    if (meta.bases.has(base)) return;
    meta.bases.add(base);
    this.convertExistingDefault(element, base);
  }

  /**
   * Retroactively move an already-applied default off the inline style and
   * into a rule. The value is recovered from the per-element applicator state
   * (handler-backed props) or read straight back off the inline style (props
   * that took the CSS fallback) — no extra bookkeeping is kept for the far
   * more common variant-less element.
   */
  private convertExistingDefault(element: HTMLElement, base: string): void {
    if (this.handlers.has(base)) {
      const stored = this.getElementState(element).get(base);
      if (stored !== undefined) {
        this.applyDefaultAsRule(element, base, stored);
      }
      return;
    }

    // Handler-less default: `setStyleProperty` wrote it inline under kebab(base).
    const cssName = this.toKebabCase(base);
    const inline = element.style.getPropertyValue(cssName);
    if (!inline) return;

    const decls = { [cssName]: inline };
    element.style.removeProperty(cssName);
    this.emitRule(element, base, base, null, null, decls, true);
  }

  /**
   * Apply a variant-qualified prop as a pseudo-class / media-query rule.
   * Returns silently after warning when the prop cannot be expressed as a
   * standalone CSS declaration (see `lower`).
   */
  private applyVariantRule(
    element: HTMLElement,
    key: string,
    variant: VariantInfo,
    value: any,
  ): void {
    if (value === undefined) {
      this.setManagedClass(element, key, null);
      return;
    }

    const lowered = this.lower(variant.base, value);
    if (lowered.reason !== undefined) {
      this.warnUnexpressible(element, variant.base, key, lowered.reason);
      return;
    }

    Object.assign(element.dataset, lowered.dataset);
    this.emitRule(
      element,
      key,
      variant.base,
      variant.breakpoint,
      variant.state,
      lowered.decls,
      false,
    );
  }

  /**
   * Apply a base/default prop as an unqualified rule so its variants can win.
   * Returns false when the prop is not expressible as CSS declarations, in
   * which case the caller falls back to the handler (and the author has been
   * warned that the variants will not take effect).
   */
  private applyDefaultAsRule(element: HTMLElement, base: string, value: any): boolean {
    if (value === undefined) {
      this.setManagedClass(element, base, null);
      return true;
    }

    const lowered = this.lower(base, value);
    if (lowered.reason !== undefined) {
      this.warnUnexpressible(element, base, base, lowered.reason);
      return false;
    }

    // The default must not ALSO sit inline: inline beats every class rule, so
    // a leftover inline write here is exactly the bug this path fixes.
    for (const prop of Object.keys(lowered.decls)) {
      element.style.removeProperty(prop);
    }
    Object.assign(element.dataset, lowered.dataset);
    this.emitRule(element, base, base, null, null, lowered.decls, true);
    return true;
  }

  /**
   * Lower `value` for applicator `base` into the CSS declarations it produces,
   * by running the registered handler against a detached probe element and
   * reading back what it wrote. Using the handler itself keeps the variant and
   * the default byte-identical to the inline styling authors already get
   * (units, shorthands, `{top,right,…}` forms, font loading, …) rather than
   * re-deriving a second, divergent translation.
   *
   * Not expressible (returns a reason, caller warns):
   * - the handler writes no CSS at all (attribute-only, e.g. `.aria`)
   * - the handler composes into `style.transform` (`translateX`, `scale`,
   *   `rotate`, …): those share ONE property, so a per-variant rule would
   *   clobber every sibling transform contribution instead of composing
   * - the animator owns the property inline (`.transition` / `.animate`)
   */
  private lower(base: string, value: any): Lowered {
    const handler = this.handlers.get(base);

    if (!handler) {
      const cssName = this.toKebabCase(base);
      return { decls: { [cssName]: this.formatCssValue(cssName, value) }, dataset: {} };
    }

    if (ANIMATOR_OWNED_BASES.has(base)) {
      return {
        reason: "the animator owns this property's inline styles",
      };
    }

    const probe = this.getProbe();
    try {
      handler(probe, value);
    } catch {
      this.resetProbe(probe);
      return { reason: "its handler threw while lowering the value" };
    }

    const decls: Record<string, string> = {};
    for (const [prop, entry] of this.readInline(probe)) {
      decls[prop] = entry.value;
    }
    const dataset: Record<string, string> = { ...(probe.dataset as Record<string, string>) };
    this.resetProbe(probe);

    if (Object.keys(decls).length === 0) {
      return { reason: "its handler writes no CSS declarations" };
    }
    if ("transform" in decls && this.toKebabCase(base) !== "transform") {
      return {
        reason: "it composes into the shared `transform` property",
      };
    }

    return { decls, dataset };
  }

  /**
   * Detached element handlers are replayed against. Created lazily so the
   * registry can be constructed before a document exists.
   */
  private getProbe(): HTMLElement {
    if (!this.probe) {
      this.probe = document.createElement("div");
    }
    return this.probe;
  }

  private resetProbe(probe: HTMLElement): void {
    for (const [, entry] of this.readInline(probe)) {
      probe.style.removeProperty(entry.key);
    }
    for (const key of Object.keys(probe.dataset)) {
      delete (probe.dataset as Record<string, string>)[key];
    }
  }

  /**
   * Enumerate an element's inline declarations as `cssProp -> {key, value}`.
   *
   * Uses the standard indexed `CSSStyleDeclaration` interface. A style object
   * that does not implement it yields nothing, which surfaces to the caller as
   * "not expressible" (a warning) rather than as a silently empty rule.
   */
  private readInline(element: HTMLElement): Map<string, { key: string; value: string }> {
    const out = new Map<string, { key: string; value: string }>();
    const style = element.style as unknown as Record<string, unknown> & CSSStyleDeclaration;
    const length = style.length;
    if (typeof length !== "number") return out;

    for (let i = 0; i < length; i++) {
      const prop = style[i] as unknown as string;
      if (typeof prop !== "string" || prop === "") continue;
      const value = style.getPropertyValue(prop);
      if (!value) continue;
      out.set(prop, { key: prop, value: String(value) });
    }
    return out;
  }

  /**
   * Insert the rule for `decls` (deduplicated) and swap the class that carries
   * it onto the element.
   *
   * Unqualified (default) rules are inserted at the FRONT of the sheet: a
   * `@media` variant rule has the same specificity as the default's rule, so
   * source order is what makes the variant win. State variants carry a
   * pseudo-class and outrank both on specificity alone.
   */
  private emitRule(
    element: HTMLElement,
    key: string,
    base: string,
    breakpoint: string | null,
    state: string | null,
    decls: Record<string, string>,
    front: boolean,
  ): void {
    const cssName = this.toKebabCase(base).replace(/[^a-zA-Z0-9-]/g, '');
    const tier =
      breakpoint && state ? `${breakpoint}-${state}` : breakpoint ?? state ?? "base";
    const className = `hypen-${cssName}-${tier}-${hashValue(Object.values(decls).join('|'))}`;

    const body = Object.entries(decls)
      .map(([prop, value]) => `${prop}: ${value};`)
      .join(' ');
    const selector = state ? `.${className}:${state}` : `.${className}`;
    const minWidth = breakpoint ? BREAKPOINTS[breakpoint] : undefined;
    const rule = minWidth
      ? `@media (min-width: ${minWidth}) { ${selector} { ${body} } }`
      : `${selector} { ${body} }`;

    if (!insertedRules.has(rule)) {
      const sheet = getVariantStyleSheet();
      try {
        sheet.insertRule(rule, front ? 0 : sheet.cssRules.length);
        insertedRules.add(rule);
      } catch (error) {
        log.warn(`Could not insert variant rule for "${base}": ${rule}`, error);
        return;
      }
    }

    this.setManagedClass(element, key, className);
  }

  /**
   * Swap the class carrying `key`'s rule, dropping the previous one so a
   * changed value cannot leave two competing rules applied to the element.
   */
  private setManagedClass(element: HTMLElement, key: string, className: string | null): void {
    const meta = this.getVariantMeta(element);
    const previous = meta.classes.get(key);
    if (previous === className) return;
    if (previous) element.classList.remove(previous);
    if (className) {
      element.classList.add(className);
      meta.classes.set(key, className);
    } else {
      meta.classes.delete(key);
    }
  }

  /** Warn once per element+base that a variant group cannot be honoured. */
  private warnUnexpressible(
    element: HTMLElement,
    base: string,
    key: string,
    reason: string,
  ): void {
    const meta = this.getVariantMeta(element);
    if (meta.warned.has(base)) return;
    meta.warned.add(base);
    log.warn(
      `Variant "${key}" has no effect: ".${base}(...)" cannot be expressed as a ` +
        `standalone CSS rule because ${reason}. The default value still applies; ` +
        `the state/breakpoint variants are ignored.`,
    );
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

    // Register every variant base BEFORE anything is applied, so a default
    // that happens to come first in the props map is routed straight to the
    // stylesheet — no inline write to undo, and no flash of a default that
    // outranks the variant it was meant to be overridden by.
    for (const baseName of grouped.keys()) {
      const variant = this.classifyVariant(baseName);
      if (variant?.qualified) {
        this.registerVariantBase(element, variant.base);
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
   * Set a CSS property with automatic unit handling.
   *
   * WELL-FORMED variant keys never reach here — `apply()` routes them through
   * `applyVariantRule` (which lowers the value with the prop's own handler).
   * What is left is a key whose `@bp` / `:state` marker did not resolve to a
   * known breakpoint/state (`padding@invalid`, `padding:invalid`): those are
   * dropped rather than written as a nonsense inline property.
   */
  private setStyleProperty(element: HTMLElement, name: string, value: any): void {
    // Reserved double-underscore props (the `__anim.*` channels and any
    // future engine protocol props) are consumed by dedicated subsystems —
    // belt-and-braces: never leak them into inline CSS.
    if (name.startsWith("__")) return;

    // Unresolvable variant marker: apply nothing.
    if (name.includes('@') || name.includes(':')) return;

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

    for (const [name, handler] of Object.entries(ariaHandlers)) {
      this.register(name, handler as ApplicatorHandler);
    }
  }
}

/**
 * SafeArea Component
 *
 * Full-size vertical container that pads its content by the platform's
 * safe-area inset on each selected edge (notch, rounded corners, home
 * indicator, browser UI). The element itself stays full-bleed, so a
 * `.background(...)` on a SafeArea still paints under the insets.
 *
 * ```hypen
 * SafeArea { Column { ... } }
 * SafeArea(edges: ["top", "bottom"]) { ... }
 * ```
 */

import type { ComponentHandler } from "./index.js";
import {
  SAFE_AREA_EDGES,
  resolveSafeAreaEdges,
  safeAreaCssValue,
  type SafeAreaEdge,
  type SafeAreaInsetOverrides,
} from "../../safe-area.js";

/**
 * Write the inset padding for `edges`, clearing the edges left out.
 *
 * The declarations are marked `!important` on purpose. The renderer appends
 * a component's children straight into the handler's own element, so there
 * is no inner wrapper to carry the safe-area padding separately: the same
 * box holds both the inset padding and whatever the author's `.padding()`
 * applicator writes — and the applicators run AFTER `applyProps`, so a plain
 * inline longhand here would simply be clobbered by `style.padding`. An
 * important inline declaration beats a later non-important one regardless of
 * order, which makes safe-area padding win on the edges it covers (the
 * fallback the cross-renderer spec allows where additive combination is not
 * natural). Authored padding still applies on every other edge.
 */
function applySafeAreaPadding(
  el: HTMLElement,
  edges: Set<SafeAreaEdge>,
  overrides?: SafeAreaInsetOverrides | null,
): void {
  for (const edge of SAFE_AREA_EDGES) {
    const property = `padding-${edge}`;
    if (edges.has(edge)) {
      el.style.setProperty(property, safeAreaCssValue(edge, overrides), "important");
    } else {
      el.style.removeProperty(property);
    }
  }
}

/**
 * Build a SafeArea handler bound to one embedder's inset overrides.
 * `DOMRenderer` registers a bound handler when its options carry
 * `safeAreaInsets`; the default registration uses the browser's own
 * `env(safe-area-inset-*)` values.
 */
export function createSafeAreaHandler(
  overrides?: SafeAreaInsetOverrides | null,
): ComponentHandler {
  return {
    create(): HTMLElement {
      const el = document.createElement("div");
      el.style.display = "flex";
      el.style.flexDirection = "column";
      el.style.width = "100%";
      el.style.height = "100%";
      el.dataset.hypenType = "safearea";
      // A create without props (or with no `edges`) pads all four edges.
      applySafeAreaPadding(el, resolveSafeAreaEdges(undefined), overrides);
      return el;
    },

    applyProps(el: HTMLElement, props: Record<string, any>): void {
      const edges = props?.edges ?? props?.["edges.0"];
      applySafeAreaPadding(el, resolveSafeAreaEdges(edges), overrides);
    },
  };
}

export const safeAreaHandler: ComponentHandler = createSafeAreaHandler();

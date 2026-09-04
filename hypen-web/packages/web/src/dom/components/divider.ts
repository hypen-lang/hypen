/**
 * Divider Component - Visual separator
 */

import type { ComponentHandler } from "./index.js";

export const DIVIDER_DEFAULTS = {
  color: "#e0e0e0",
  thickness: "1px",
} as const;

function cssSize(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  return typeof value === "number" ? `${value}px` : String(value);
}

function firstProp(props: Record<string, any>, names: string[]): unknown {
  for (const name of names) {
    if (props[name] !== undefined) return props[name];
  }
  return undefined;
}

export const dividerHandler: ComponentHandler = {
  create(): HTMLElement {
    // A plain block avoids the browser-specific intrinsic margins and border
    // behavior of <hr>. Width stays auto so an inset/margin consumes the
    // available width instead of making a width:100% line overflow.
    const el = document.createElement("div");
    el.dataset.hypenType = "divider";
    el.dataset.hypenDividerOrientation = "horizontal";
    el.style.height = DIVIDER_DEFAULTS.thickness;
    el.style.backgroundColor = DIVIDER_DEFAULTS.color;
    el.style.margin = "0";
    el.style.flexShrink = "0";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const hasAny = (names: string[]) => names.some(name =>
      Object.prototype.hasOwnProperty.call(props, name)
    );
    const colorProps = ["color.0", "color", "backgroundColor.0", "backgroundColor"];
    const thicknessProps = ["height.0", "height", "thickness.0", "thickness"];
    const orientation = firstProp(props, ["orientation.0", "orientation"]);
    const color = firstProp(props, colorProps);
    const thickness = firstProp(props, thicknessProps);

    if (hasAny(colorProps)) {
      el.style.backgroundColor = color === undefined ? DIVIDER_DEFAULTS.color : String(color);
    }

    if (orientation === "vertical") {
      el.dataset.hypenDividerOrientation = "vertical";
      el.style.height = "100%";
      el.style.width = cssSize(thickness, DIVIDER_DEFAULTS.thickness);
      el.style.display = "inline-block";
    } else if (
      Object.prototype.hasOwnProperty.call(props, "orientation") ||
      Object.prototype.hasOwnProperty.call(props, "orientation.0")
    ) {
      el.dataset.hypenDividerOrientation = "horizontal";
      el.style.height = cssSize(thickness, DIVIDER_DEFAULTS.thickness);
      el.style.removeProperty("width");
      el.style.removeProperty("display");
    } else if (hasAny(thicknessProps)) {
      if (el.dataset.hypenDividerOrientation === "vertical") {
        el.style.width = cssSize(thickness, DIVIDER_DEFAULTS.thickness);
      } else {
        el.style.height = cssSize(thickness, DIVIDER_DEFAULTS.thickness);
      }
    }
  },
};

/**
 * Icon Component
 *
 * Renders SVG icons from pre-resolved path data injected by the engine.
 * The engine resolves Icon("heart") → SVG paths at render time and sends
 * the path data in the Create patch props. This handler just renders them.
 */

import type { ComponentHandler } from "./index.js";

const SVG_NS = "http://www.w3.org/2000/svg";

export const iconHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("span");
    el.style.display = "inline-flex";
    el.style.alignItems = "center";
    el.style.justifyContent = "center";
    el.style.verticalAlign = "middle";
    el.dataset.hypenType = "icon";
    return el;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    // Server-resolved icon data (from engine's ResourceRegistry)
    const paths: Array<{
      d: string;
      fill?: string;
      stroke?: string;
      strokeWidth?: number;
      strokeLinecap?: string;
      strokeLinejoin?: string;
    }> = props.__iconPaths;
    const viewBox: string = props.__iconViewBox || "0 0 24 24";

    // Size and color from DSL props
    const size = props.size || props["size.0"] || 24;
    const color = props.color || props["color.0"] || "currentColor";

    if (paths && Array.isArray(paths)) {
      // Render from pre-resolved SVG path data
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("xmlns", SVG_NS);
      svg.setAttribute("width", String(size));
      svg.setAttribute("height", String(size));
      svg.setAttribute("viewBox", viewBox);
      svg.setAttribute("fill", "none");
      svg.style.display = "block";

      for (const pathData of paths) {
        const path = document.createElementNS(SVG_NS, "path");
        path.setAttribute("d", pathData.d);
        path.setAttribute("fill", pathData.fill || "none");
        path.setAttribute(
          "stroke",
          (pathData.stroke || "currentColor") === "currentColor"
            ? color
            : pathData.stroke || color
        );
        if (pathData.strokeWidth != null) {
          path.setAttribute("stroke-width", String(pathData.strokeWidth));
        }
        if (pathData.strokeLinecap) {
          path.setAttribute("stroke-linecap", pathData.strokeLinecap);
        }
        if (pathData.strokeLinejoin) {
          path.setAttribute("stroke-linejoin", pathData.strokeLinejoin);
        }
        svg.appendChild(path);
      }

      el.innerHTML = "";
      el.appendChild(svg);
    } else {
      // Fallback: no resolved icon data — show placeholder
      const name = props["0"] || props.name || "?";
      el.textContent = name;
      el.style.width = `${size}px`;
      el.style.height = `${size}px`;
      el.style.fontSize = `${Math.round(Number(size) * 0.6)}px`;
      el.style.color = color;
    }
  },
};

/**
 * Canvas Component with Applicators
 *
 * Special handling for canvas rendering
 */

import type { ComponentHandler } from "../components/index.js";
import type { ApplicatorHandler } from "../applicators/index.js";

export const canvasHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("canvas");
    el.dataset.hypenType = "canvas";
    return el as any as HTMLElement;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const canvas = el as HTMLCanvasElement;

    if (props.width !== undefined) {
      canvas.width = Number(props.width);
    }

    if (props.height !== undefined) {
      canvas.height = Number(props.height);
    }
  },
};

/**
 * Canvas applicators - special drawing commands
 */
export const canvasApplicators: Record<string, ApplicatorHandler> = {
  // Fill style
  fillStyle: (el, value) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = String(value);
    }
  },

  // Stroke style
  strokeStyle: (el, value) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.strokeStyle = String(value);
    }
  },

  // Line width
  lineWidth: (el, value) => {
    const canvas = el as HTMLCanvasElement;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.lineWidth = Number(value);
    }
  },
};

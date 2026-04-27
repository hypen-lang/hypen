/**
 * Video Component
 */

import type { ComponentHandler } from "./index.js";

export const videoHandler: ComponentHandler = {
  create(doc: Document): HTMLElement {
    const el = doc.createElement("video");
    el.dataset.hypenType = "video";
    return el as any as HTMLElement;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const video = el as HTMLVideoElement;

    // Source
    const src = props["0"] || props.src;
    if (src !== undefined) {
      video.src = String(src);
    }

    // Controls
    if (props.controls !== undefined) {
      video.controls = Boolean(props.controls);
    }

    // Autoplay
    if (props.autoplay !== undefined) {
      video.autoplay = Boolean(props.autoplay);
    }

    // Loop
    if (props.loop !== undefined) {
      video.loop = Boolean(props.loop);
    }

    // Muted
    if (props.muted !== undefined) {
      video.muted = Boolean(props.muted);
    }

    // Poster
    if (props.poster !== undefined) {
      video.poster = String(props.poster);
    }
  },
};



/**
 * Audio Component
 */

import type { ComponentHandler } from "./index.js";

export const audioHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("audio");
    el.dataset.hypenType = "audio";
    // Audio is a player component, so its transport is visible by default on
    // every renderer. Authors can still opt into headless playback with
    // `controls: false`.
    el.controls = true;
    return el as any as HTMLElement;
  },

  applyProps(el: HTMLElement, props: Record<string, any>): void {
    const audio = el as HTMLAudioElement;

    // Source
    const src = props["0"] || props.src;
    if (src !== undefined) {
      audio.src = String(src);
    }

    // Controls
    if (props.controls !== undefined) {
      audio.controls = Boolean(props.controls);
    }

    // Autoplay
    if (props.autoplay !== undefined) {
      audio.autoplay = Boolean(props.autoplay);
    }

    // Loop
    if (props.loop !== undefined) {
      audio.loop = Boolean(props.loop);
    }

    // Muted
    if (props.muted !== undefined) {
      audio.muted = Boolean(props.muted);
    }
  },
};


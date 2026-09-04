/**
 * Audio Component
 */

import { hasProp, toBool, type ComponentHandler } from "./index.js";

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
    if (hasProp(props, "controls")) {
      // Removing the prop restores the visible transport `create` opts into;
      // it does not go headless.
      audio.controls = props.controls === undefined ? true : toBool(props.controls);
    }

    // Autoplay
    if (hasProp(props, "autoplay")) {
      audio.autoplay = toBool(props.autoplay);
    }

    // Loop
    if (hasProp(props, "loop")) {
      audio.loop = toBool(props.loop);
    }

    // Muted
    if (hasProp(props, "muted")) {
      audio.muted = toBool(props.muted);
    }
  },
};


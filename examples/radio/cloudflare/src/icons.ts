// Inline SVG icons for `Icon(@resources.<name>)`. Feather-style 24px strokes
// on `currentColor`, so `.color(...)` tints them.

const svg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${paths}</svg>`;
const stroke = (d: string) =>
  `<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
const fill = (d: string) => `<path d="${d}" fill="currentColor"/>`;

export const resources: Record<string, string> = {
  play: svg(fill("M7 4.5v15l13-7.5L7 4.5z")),
  stop: svg(fill("M6 6h12v12H6z")),
  heart: svg(stroke("M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z")),
  "heart-filled": svg(
    fill("M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8l1 1.1L12 21l7.8-7.5 1-1.1a5.5 5.5 0 0 0 0-7.8z"),
  ),
  search: svg(stroke("M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z") + stroke("M21 21l-4.35-4.35")),
  compass: svg(stroke("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z") + stroke("M16.2 7.8l-2.1 6.3-6.3 2.1 2.1-6.3 6.3-2.1z")),
  library: svg(stroke("M4 19.5A2.5 2.5 0 0 1 6.5 17H20") + stroke("M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z")),
  "chevron-left": svg(stroke("M15 18l-6-6 6-6")),
  "chevron-right": svg(stroke("M9 18l6-6-6-6")),
  "chevron-down": svg(stroke("M6 9l6 6 6-6")),
  volume: svg(stroke("M11 5L6 9H2v6h4l5 4V5z") + stroke("M19.07 4.93a10 10 0 0 1 0 14.14") + stroke("M15.54 8.46a5 5 0 0 1 0 7.07")),
  "volume-x": svg(stroke("M11 5L6 9H2v6h4l5 4V5z") + stroke("M23 9l-6 6") + stroke("M17 9l6 6")),
  radio: svg(
    stroke("M16.24 7.76a6 6 0 0 1 0 8.49") + stroke("M7.76 16.24a6 6 0 0 1 0-8.49") +
      stroke("M19.07 4.93a10 10 0 0 1 0 14.14") + stroke("M4.93 19.07a10 10 0 0 1 0-14.14") +
      stroke("M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"),
  ),
  globe: svg(stroke("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z") + stroke("M2 12h20") + stroke("M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z")),
  tag: svg(stroke("M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z") + stroke("M7 7h.01")),
  language: svg(stroke("M5 8l6 6") + stroke("M4 14l6-6 2-3") + stroke("M2 5h12") + stroke("M7 2h1") + stroke("M22 22l-5-10-5 10") + stroke("M14 18h6")),
  trending: svg(stroke("M23 6l-9.5 9.5-5-5L1 18") + stroke("M17 6h6v6")),
  flame: svg(stroke("M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z")),
  "map-pin": svg(stroke("M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z") + stroke("M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z")),
  external: svg(stroke("M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6") + stroke("M15 3h6v6") + stroke("M10 14L21 3")),
  x: svg(stroke("M18 6L6 18") + stroke("M6 6l12 12")),
  clock: svg(stroke("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z") + stroke("M12 6v6l4 2")),
  alert: svg(stroke("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z") + stroke("M12 8v4") + stroke("M12 16h.01")),
  music: svg(stroke("M9 18V5l12-2v13") + stroke("M6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z") + stroke("M18 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z")),
};

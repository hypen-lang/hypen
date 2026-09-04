// Inline SVG icon resources for the Hypeflix UI, rendered via `Icon(@resources.<name>)`.
// Feather-style 24px strokes on `currentColor`, so `.color(...)` tints them.

const iconSvg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${paths}</svg>`;

const stroke = (d: string) =>
  `<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

const fill = (d: string) => `<path d="${d}" fill="currentColor"/>`;

export const resources: Record<string, string> = {
  "play": iconSvg(fill("M7 4.5v15l13-7.5L7 4.5z")),
  "pause": iconSvg(fill("M7 4h3v16H7z") + fill("M14 4h3v16h-3z")),
  "expand": iconSvg(
    stroke("M15 3h6v6") + stroke("M9 21H3v-6") + stroke("M21 3l-7 7") + stroke("M3 21l7-7"),
  ),
  "shrink": iconSvg(
    stroke("M4 14h6v6") + stroke("M20 10h-6V4") + stroke("M14 10l7-7") + stroke("M3 21l7-7"),
  ),
  "fullscreen": iconSvg(
    stroke("M8 3H5a2 2 0 0 0-2 2v3") + stroke("M16 3h3a2 2 0 0 1 2 2v3") +
    stroke("M8 21H5a2 2 0 0 1-2-2v-3") + stroke("M16 21h3a2 2 0 0 0 2-2v-3"),
  ),
  "chevron-left": iconSvg(stroke("M15 18l-6-6 6-6")),
  "star": iconSvg(fill("M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z")),
  "plus": iconSvg(stroke("M12 5v14") + stroke("M5 12h14")),
  "check": iconSvg(stroke("M20 6L9 17l-5-5")),
  "alert": iconSvg(
    stroke("M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0") +
      stroke("M12 9v4") +
      stroke("M12 17h.01"),
  ),
  "film": iconSvg(
    stroke("M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2") +
      stroke("M8 3v18") +
      stroke("M16 3v18") +
      stroke("M2 9h20") +
      stroke("M2 15h20"),
  ),
  "queue": iconSvg(stroke("M3 6h13") + stroke("M3 12h13") + stroke("M3 18h9") + fill("M17 14l5 3-5 3v-6z")),
};

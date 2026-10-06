// Inline SVG icon resources for the Cinebox UI, rendered via `Icon(@resources.<name>)`.
// Feather-style 24px strokes on `currentColor`, so `.color(...)` tints them.

const iconSvg = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${paths}</svg>`;

const stroke = (d: string) =>
  `<path d="${d}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;

const fill = (d: string) => `<path d="${d}" fill="currentColor"/>`;

export const resources: Record<string, string> = {
  "home": iconSvg(stroke("M3 10.5L12 3l9 7.5") + stroke("M5 9.5V21h14V9.5") + stroke("M10 21v-6h4v6")),
  "search": iconSvg(stroke("M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16") + stroke("M21 21l-4.35-4.35")),
  "bookmark": iconSvg(stroke("M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16")),
  "user": iconSvg(stroke("M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2") + stroke("M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8")),
  "chevron-left": iconSvg(stroke("M15 18l-6-6 6-6")),
  "plus": iconSvg(stroke("M12 5v14") + stroke("M5 12h14")),
  "check": iconSvg(stroke("M20 6L9 17l-5-5")),
  "x": iconSvg(stroke("M18 6L6 18") + stroke("M6 6l12 12")),
  "star": iconSvg(fill("M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z")),
  "film": iconSvg(
    stroke("M4 3h16a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2") +
      stroke("M8 3v18") +
      stroke("M16 3v18") +
      stroke("M2 9h20") +
      stroke("M2 15h20"),
  ),
};

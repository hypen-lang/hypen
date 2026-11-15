// Inline SVG icons for the chrome, rendered with `Icon(@resources.<name>)`.
// 24px strokes on `currentColor`, so `.color(...)` tints them. Emoji stay
// emoji where they are content (reactions).

const icon = (paths: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">${paths}</svg>`;

const stroke = (d: string, width = 2.2) =>
  `<path d="${d}" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;

export const resources: Record<string, string> = {
  back: icon(stroke("M15 5l-7 7 7 7")),
  send: icon(stroke("M12 19V5") + stroke("M5.5 11.5L12 5l6.5 6.5")),
  plus: icon(stroke("M12 5v14") + stroke("M5 12h14")),
  close: icon(stroke("M18 6L6 18") + stroke("M6 6l12 12")),
  compose: icon(
    stroke("M12 20h8", 2) + stroke("M16.5 3.6a2.05 2.05 0 0 1 2.9 2.9L8 17.9 4 19l1.1-4z", 2),
  ),
  photo: icon(
    stroke("M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z", 2) +
      stroke("M3 16l5-5 4 4 3-3 6 6", 2) +
      stroke("M15.5 8.5h.01", 2.6),
  ),
  chat: icon(stroke("M20 12.2a7.8 7.8 0 0 1-11.4 6.9L4 20l1-4.3A7.8 7.8 0 1 1 20 12.2z", 2)),
};

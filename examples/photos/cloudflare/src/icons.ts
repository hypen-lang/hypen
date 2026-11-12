// SVG glyphs for `Icon(@resources.<name>)`. Stroke icons follow
// `currentColor`, so `.color()` tints them.

const svg = (body: string, fill = "none") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="${fill}">${body}</svg>`;

const stroke = (d: string, width = 2) =>
  `<path d="${d}" stroke="currentColor" stroke-width="${width}" stroke-linecap="round" stroke-linejoin="round"/>`;

export const resources: Record<string, string> = {
  camera: svg(
    stroke("M4 8.5A2.5 2.5 0 0 1 6.5 6h1.6l1.3-1.8a1 1 0 0 1 .8-.4h3.6a1 1 0 0 1 .8.4L15.9 6h1.6A2.5 2.5 0 0 1 20 8.5v8A2.5 2.5 0 0 1 17.5 19h-11A2.5 2.5 0 0 1 4 16.5v-8Z") +
      `<circle cx="12" cy="12.5" r="3.4" stroke="currentColor" stroke-width="2"/>`,
  ),
  gallery: svg(
    stroke("M5 4h14a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Z") +
      stroke("m4 16 4.5-4.5a1.5 1.5 0 0 1 2.1 0L16 17") +
      stroke("m14 15 1.5-1.5a1.5 1.5 0 0 1 2.1 0L20 16") +
      `<circle cx="15.5" cy="8.5" r="1.5" fill="currentColor"/>`,
  ),
  upload: svg(stroke("M12 15V4M7.5 8.5 12 4l4.5 4.5") + stroke("M5 14v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4")),
  download: svg(stroke("M12 4v11M7.5 10.5 12 15l4.5-4.5") + stroke("M5 19h14")),
  heart: svg(stroke("M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.3a4.4 4.4 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z")),
  "heart-fill": svg(
    `<path d="M12 20s-7.5-4.6-7.5-10.1A4.4 4.4 0 0 1 12 7.3a4.4 4.4 0 0 1 7.5 2.6C19.5 15.4 12 20 12 20Z" fill="currentColor"/>`,
  ),
  albums: svg(
    stroke("M7 7h12a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Z") +
      stroke("M4 16V5a1 1 0 0 1 1-1h11"),
  ),
  photos: svg(
    stroke("M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z"),
  ),
  plus: svg(stroke("M12 5v14M5 12h14")),
  "chevron-left": svg(stroke("M15 5l-7 7 7 7", 2.4)),
  "chevron-right": svg(stroke("M9 5l7 7-7 7", 2.4)),
  info: svg(`<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2"/>` + stroke("M12 11v5M12 8h.01")),
  trash: svg(stroke("M5 7h14M10 4h4M7 7l.8 11.2A2 2 0 0 0 9.8 20h4.4a2 2 0 0 0 2-1.8L17 7")),
  x: svg(stroke("M6 6l12 12M18 6 6 18")),
  check: svg(stroke("M5 12.5l4.5 4.5L19 7.5")),
  pin: svg(stroke("M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0c0 5.4-6.5 11-6.5 11Z") + `<circle cx="12" cy="10" r="2.3" stroke="currentColor" stroke-width="2"/>`),
  aperture: svg(
    `<circle cx="12" cy="12" r="8.5" stroke="currentColor" stroke-width="2"/>` +
      stroke("M14.3 3.8 9 13M19.6 9H9.3M17.6 18 12.6 9.3M9.7 20.2 15 11M4.4 15h10.3M6.4 6l5 8.7", 1.6),
  ),
  calendar: svg(stroke("M5 6h14a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM4 10h16M8 4v4M16 4v4")),
  "file-image": svg(stroke("M6.5 3h7.5L19 8v12a1 1 0 0 1-1 1H6.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z") + stroke("M14 3v5h5") + stroke("m8 17 2.5-3 2 2 1.5-1.5L16 17")),
};

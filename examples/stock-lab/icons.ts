const icon = (d: string) => `<svg viewBox="0 0 24 24"><path d="${d}" fill="none" stroke="#a8adae" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
export const icons = {
  dashboard: icon('M5 20V13M12 20V4M19 20V9'),
  markets: icon('M21 12A9 9 0 1 1 3 12A9 9 0 1 1 21 12M3 12H21M12 3C7 7 7 17 12 21M12 3C17 7 17 17 12 21'),
  portfolio: icon('M11 3A9 9 0 1 0 21 13H11ZM14 3V10H21A9 9 0 0 0 14 3Z'),
  watchlist: icon('M6 3H18V21L12 17L6 21Z'),
  search: icon('M17 10A7 7 0 1 1 3 10A7 7 0 1 1 17 10M15 15L21 21'),
  arrow: icon('M5 12H19M13 6L19 12L13 18'),
};

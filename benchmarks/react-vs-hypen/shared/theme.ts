/**
 * Design tokens shared by BOTH apps.
 *
 * The React app spreads these into inline `style` objects; the Hypen app
 * interpolates them into its DSL template string, which the DOM renderer
 * turns into the same inline styles. One source of truth means a colour or
 * spacing tweak can never drift between the two implementations — which is
 * the whole point of the "same UI, same style" constraint.
 */

export const T = {
  // Surfaces
  bg: "#0b0d12",
  surface: "#12151d",
  surfaceAlt: "#161a24",
  surfaceSelected: "#1d2433",
  border: "#222836",
  borderSelected: "#3b82f6",

  // Text
  text: "#e6e8ee",
  textMuted: "#8b93a7",
  textFaint: "#5c6478",

  // Accents
  accent: "#6366f1",
  accentText: "#ffffff",
  green: "#22c55e",
  amber: "#f59e0b",
  red: "#ef4444",
  blue: "#3b82f6",

  // Typography
  // Deliberately all-generic: Hypen's `fontFamily` applicator treats any
  // non-system family as a Google Font and injects a <link> for it, which
  // would be a network request the React side never makes.
  fontFamily: "ui-sans-serif, system-ui, -apple-system, sans-serif",
  fsXs: 11,
  fsSm: 12,
  fsMd: 14,
  fsLg: 18,
  fsXl: 26,

  // Spacing / shape
  gapXs: 4,
  gapSm: 8,
  gapMd: 12,
  gapLg: 20,
  padSm: 8,
  padMd: 12,
  padLg: 20,
  radiusSm: 6,
  radiusMd: 10,
  radiusLg: 14,

  // Fixed sizes (kept identical so layout is pixel-comparable)
  avatar: 38,
  rowHeight: 62,
  statusWidth: 92,
  valueWidth: 84,
} as const;

/** Status label -> colour, shared by both renderers. */
export const STATUS_COLOR: Record<string, string> = {
  Shipped: T.green,
  "In review": T.amber,
  Blocked: T.red,
  Planned: T.textMuted,
  Active: T.blue,
};

/** The four header stat cards. Static in both apps, so the counts match. */
export const STATS = [
  { label: "Throughput", value: "12,480", delta: "+8.2%", positive: true },
  { label: "Latency p95", value: "38 ms", delta: "-4.1%", positive: true },
  { label: "Error rate", value: "0.42%", delta: "+0.03%", positive: false },
  { label: "Active nodes", value: "128", delta: "+2", positive: true },
] as const;

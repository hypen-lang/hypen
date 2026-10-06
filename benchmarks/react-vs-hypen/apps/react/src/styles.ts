/**
 * Inline style objects that reproduce, exactly, what the Hypen DOM renderer
 * writes for the equivalent DSL node.
 *
 * The renderer's component handlers set a fixed set of base styles at element
 * creation (`Row` -> `display:flex; flex-direction:row; align-items:flex-start`,
 * `Text` -> `display:inline-block; line-height:1; …`, and so on — see
 * hypen-web/packages/web/src/dom/components/*.ts), then applicators layer the
 * authored styles on top. Every object here starts from the same base so the
 * two apps end up with identical *computed* styles, which is what the parity
 * checker compares.
 */

import type { CSSProperties } from "react";
import { T } from "../../../shared/theme";

/** `Row` handler base. */
export const rowBase: CSSProperties = {
  display: "flex",
  flexDirection: "row",
  alignItems: "flex-start",
};

/** `Column` handler base. */
export const colBase: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "stretch",
};

/** `Text` handler base. */
export const textBase: CSSProperties = {
  display: "inline-block",
  lineHeight: 1,
  verticalAlign: "top",
  margin: 0,
  padding: 0,
};

/** `Button` handler base (user-agent reset + flex container). */
export const buttonBase: CSSProperties = {
  border: "none",
  background: "none",
  padding: 0,
  margin: 0,
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
};

/** `List` handler base. */
export const listBase: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  alignItems: "flex-start",
  overflow: "auto",
};

/**
 * `.flex(n)` also pins `min-width`/`min-height` to 0 so flex children can
 * shrink below their intrinsic size — mirror that here.
 */
export const flex1: CSSProperties = { flex: "1", minWidth: 0, minHeight: 0 };

export const px = (n: number) => `${n}px`;

// ---------------------------------------------------------------------------
// App chrome
// ---------------------------------------------------------------------------

export const root: CSSProperties = {
  ...colBase,
  minHeight: "100vh",
  width: "100%",
  backgroundColor: T.bg,
  color: T.text,
  fontFamily: T.fontFamily,
};

export const header: CSSProperties = {
  ...rowBase,
  alignItems: "center",
  padding: px(T.padLg),
  gap: px(T.gapMd),
  borderBottom: `1px solid ${T.border}`,
  width: "100%",
};

export const brandCol: CSSProperties = { ...colBase, gap: px(T.gapXs) };

export const brand: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsLg),
  fontWeight: "700",
  color: T.text,
};

export const brandSub: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsXs),
  color: T.textMuted,
};

export const spacer: CSSProperties = { ...colBase, ...flex1 };

export const rowCount: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsSm),
  color: T.textMuted,
};

export const statsRow: CSSProperties = {
  ...rowBase,
  padding: px(T.padLg),
  gap: px(T.gapMd),
  width: "100%",
};

export const statCard: CSSProperties = {
  ...colBase,
  ...flex1,
  gap: px(T.gapXs),
  padding: px(T.padMd),
  backgroundColor: T.surface,
  border: `1px solid ${T.border}`,
  borderRadius: px(T.radiusMd),
};

export const statLabel: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsXs),
  color: T.textMuted,
};

export const statValue: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsXl),
  fontWeight: "600",
  color: T.text,
};

export const statDeltaUp: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsXs),
  color: T.green,
};

export const statDeltaDown: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsXs),
  color: T.red,
};

export const toolbar: CSSProperties = {
  ...rowBase,
  alignItems: "center",
  paddingLeft: px(T.padLg),
  paddingRight: px(T.padLg),
  gap: px(T.gapSm),
  flexWrap: "wrap",
  width: "100%",
};

export const toolButton: CSSProperties = {
  ...buttonBase,
  backgroundColor: T.surfaceAlt,
  border: `1px solid ${T.border}`,
  borderRadius: px(T.radiusSm),
  paddingTop: px(T.padSm),
  paddingBottom: px(T.padSm),
  paddingLeft: px(T.padMd),
  paddingRight: px(T.padMd),
  alignItems: "center",
};

export const toolButtonText: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsSm),
  color: T.text,
};

export const listWrap: CSSProperties = {
  ...colBase,
  padding: px(T.padLg),
  gap: px(T.gapSm),
  width: "100%",
};

export const list: CSSProperties = { ...listBase, gap: px(T.gapSm), width: "100%" };

// ---------------------------------------------------------------------------
// Row card
// ---------------------------------------------------------------------------

const cardBase: CSSProperties = {
  ...rowBase,
  alignItems: "center",
  width: "100%",
  gap: px(T.gapMd),
  padding: px(T.padSm),
  borderRadius: px(T.radiusMd),
};

export const card: CSSProperties = {
  ...cardBase,
  backgroundColor: T.surface,
  border: `1px solid ${T.border}`,
};

export const cardSelected: CSSProperties = {
  ...cardBase,
  backgroundColor: T.surfaceSelected,
  border: `1px solid ${T.borderSelected}`,
};

export const avatar: CSSProperties = {
  ...colBase,
  width: px(T.avatar),
  height: px(T.avatar),
  borderRadius: px(T.radiusSm),
  backgroundColor: T.surfaceAlt,
  alignItems: "center",
  justifyContent: "center",
};

export const avatarText: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsSm),
  fontWeight: "700",
  color: T.textMuted,
};

export const mainCol: CSSProperties = { ...colBase, ...flex1, gap: px(T.gapXs) };

export const nameText: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsMd),
  color: T.text,
};

export const metaRow: CSSProperties = {
  ...rowBase,
  alignItems: "center",
  gap: px(T.gapXs),
};

export const metaText: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsXs),
  color: T.textFaint,
};

export const statusCol: CSSProperties = { ...colBase, width: px(T.statusWidth) };

export const valueCol: CSSProperties = { ...colBase, width: px(T.valueWidth) };

export const valueText: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsSm),
  color: T.textMuted,
};

export const selectButton: CSSProperties = {
  ...buttonBase,
  backgroundColor: T.surfaceAlt,
  borderRadius: px(T.radiusSm),
  paddingTop: px(T.gapXs),
  paddingBottom: px(T.gapXs),
  paddingLeft: px(T.gapSm),
  paddingRight: px(T.gapSm),
  alignItems: "center",
};

export const selectButtonText: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsXs),
  color: T.text,
};

export const removeButton: CSSProperties = {
  ...buttonBase,
  backgroundColor: "transparent",
  borderRadius: px(T.radiusSm),
  paddingTop: px(T.gapXs),
  paddingBottom: px(T.gapXs),
  paddingLeft: px(T.gapSm),
  paddingRight: px(T.gapSm),
  alignItems: "center",
};

export const removeButtonText: CSSProperties = {
  ...textBase,
  fontSize: px(T.fsXs),
  color: T.textFaint,
};

/** Status text colour varies per row, so it is built per status once. */
export const statusTextFor = (color: string): CSSProperties => ({
  ...textBase,
  fontSize: px(T.fsXs),
  fontWeight: "600",
  color,
});

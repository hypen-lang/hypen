import type { VirtualNode } from "./types";

const ORIGIN = Object.freeze({ x: 0, y: 0 });

/** Normalize against the board's content box, never the item's own size. */
export function pinOffset(node: VirtualNode): { x: number; y: number } {
  if (node.props["__dnd.pinX"] == null && node.props["__dnd.pinY"] == null) return ORIGIN;
  let board = node.parent;
  while (board && !board.props["__dnd.pin"]) board = board.parent;
  const layout = board?.layout;
  const number = (value: unknown): number => typeof value === "number" && Number.isFinite(value) ? value : 0;
  return {
    x: number(node.props["__dnd.pinX"]) * (layout?.contentWidth ?? 0),
    y: number(node.props["__dnd.pinY"]) * (layout?.contentHeight ?? 0),
  };
}

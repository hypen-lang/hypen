/**
 * Text Geometry Tests
 *
 * Pure point↔offset↔rect math shared by static-text selection, input caret
 * placement, and selection/caret painting. Uses the same len*8 mock
 * measureText convention as the other canvas tests, so every expected
 * coordinate is exact.
 */

import { test, expect, describe } from "bun:test";
import {
  lineRanges,
  offsetToCaretRect,
  pointToOffset,
  rangeToRects,
  type TextGeometry,
} from "../packages/web/src/canvas/text-geometry.js";
import type { FontStyle } from "../packages/web/src/canvas/types.js";

class MockContext {
  font = "";
  private stack: string[] = [];
  save() {
    this.stack.push(this.font);
  }
  restore() {
    this.font = this.stack.pop() ?? this.font;
  }
  measureText(text: string) {
    return { width: text.length * 8 };
  }
}

const ctx = new MockContext() as unknown as CanvasRenderingContext2D;

const FONT: FontStyle = {
  fontSize: 16,
  fontWeight: "normal",
  fontFamily: "monospace-mock",
  lineHeight: 20,
};

function geometry(overrides: Partial<TextGeometry> = {}): TextGeometry {
  return {
    text: "hello world",
    font: FONT,
    textAlign: "left",
    verticalAlign: "top",
    contentX: 10,
    contentY: 5,
    contentWidth: 200,
    contentHeight: 40,
    wrapWidth: undefined,
    ...overrides,
  };
}

describe("lineRanges", () => {
  test("single line covers the whole text", () => {
    expect(lineRanges("abc", ["abc"])).toEqual([{ start: 0, end: 3, line: "abc" }]);
  });

  test("wrapped lines re-anchor past the eaten separator", () => {
    // "aaaa bbbb cccc" wrapped as ["aaaa bbbb", "cccc"] — the space at
    // index 9 is eaten by the wrap.
    const ranges = lineRanges("aaaa bbbb cccc", ["aaaa bbbb", "cccc"]);
    expect(ranges[0]).toEqual({ start: 0, end: 9, line: "aaaa bbbb" });
    expect(ranges[1]).toEqual({ start: 10, end: 14, line: "cccc" });
  });
});

describe("offsetToCaretRect", () => {
  test("caret x is contentX + 8 * offset on a single left-aligned line", () => {
    for (const offset of [0, 3, 11]) {
      const rect = offsetToCaretRect(ctx, geometry(), offset);
      expect(rect.x).toBe(10 + 8 * offset);
      expect(rect.y).toBe(5);
      expect(rect.height).toBe(20);
    }
  });

  test("offset is clamped to text length", () => {
    const rect = offsetToCaretRect(ctx, geometry(), 999);
    expect(rect.x).toBe(10 + 8 * "hello world".length);
  });

  test("wrap boundary keeps the caret at the end of the earlier line", () => {
    // wrapWidth 80 = 10 chars → ["aaaa bbbb", "cccc"]
    const g = geometry({ text: "aaaa bbbb cccc", wrapWidth: 80 });
    const atBoundary = offsetToCaretRect(ctx, g, 9);
    expect(atBoundary.y).toBe(5); // first line
    expect(atBoundary.x).toBe(10 + 8 * 9);

    const nextLine = offsetToCaretRect(ctx, g, 10);
    expect(nextLine.y).toBe(5 + 20); // second line
    expect(nextLine.x).toBe(10); // column 0
  });

  test("right alignment shifts the line start", () => {
    const g = geometry({ text: "abcd", textAlign: "right" });
    const rect = offsetToCaretRect(ctx, g, 0);
    // line width 32 → lineX = 10 + 200 - 32
    expect(rect.x).toBe(178);
  });

  test("single-line caret advances past a trailing space", () => {
    // Wrap layout engines strip trailing whitespace from line ends, which
    // pinned the caret before a just-typed space. Single-line geometry
    // (wrapWidth undefined) must use the raw text.
    const g = geometry({ text: "hi " });
    const rect = offsetToCaretRect(ctx, g, 3);
    expect(rect.x).toBe(10 + 8 * 3);
  });

  test("wrapped text: trailing space keeps the caret advancing", () => {
    const g = geometry({ text: "hi ", wrapWidth: 80 });
    expect(offsetToCaretRect(ctx, g, 3).x).toBe(10 + 8 * 3);
  });

  test("wrapped text: caret lands on the blank line a trailing newline created", () => {
    // Line layout drops trailing blank lines; the whitespace tail is
    // re-attached so Enter in a textarea moves the caret down immediately.
    const g = geometry({ text: "hi\n", wrapWidth: 80 });
    const rect = offsetToCaretRect(ctx, g, 3);
    expect(rect.y).toBe(5 + 20); // second line
    expect(rect.x).toBe(10); // column 0
  });

  test("wrapped text: caret after a space just before a newline", () => {
    const g = geometry({ text: "ab \nline2", wrapWidth: 200 });
    // Offset 3 = after the space, still on line 1.
    const afterSpace = offsetToCaretRect(ctx, g, 3);
    expect(afterSpace.y).toBe(5);
    expect(afterSpace.x).toBe(10 + 8 * 3);
    // Offset 4 = start of line 2.
    const line2 = offsetToCaretRect(ctx, g, 4);
    expect(line2.y).toBe(5 + 20);
    expect(line2.x).toBe(10);
  });

  test("wrapped text: consecutive newlines keep their blank line", () => {
    const g = geometry({ text: "a\n\nb", wrapWidth: 200 });
    // Offset 2 sits on the blank middle line.
    const blank = offsetToCaretRect(ctx, g, 2);
    expect(blank.y).toBe(5 + 20);
    expect(blank.x).toBe(10);
    // Offset 3 = start of "b" on line 3.
    expect(offsetToCaretRect(ctx, g, 3).y).toBe(5 + 40);
  });

  test("middle vertical alignment centers the block", () => {
    const g = geometry({ text: "abcd", verticalAlign: "middle" });
    const rect = offsetToCaretRect(ctx, g, 0);
    // one 20px line in a 40px content box → startY = 5 + 10
    expect(rect.y).toBe(15);
  });
});

describe("pointToOffset", () => {
  test("snaps to the nearer glyph edge", () => {
    // Between chars 3 (x=24) and 4 (x=32), closer to 3
    expect(pointToOffset(ctx, geometry(), { x: 10 + 27, y: 10 })).toBe(3);
    // Closer to 4
    expect(pointToOffset(ctx, geometry(), { x: 10 + 30, y: 10 })).toBe(4);
  });

  test("clicking past the end lands at text length", () => {
    expect(pointToOffset(ctx, geometry(), { x: 500, y: 10 })).toBe("hello world".length);
  });

  test("y picks the wrapped line, offset is text-absolute", () => {
    const g = geometry({ text: "aaaa bbbb cccc", wrapWidth: 80 });
    // Second line (y in [25, 45)), column 2 → absolute offset 12
    expect(pointToOffset(ctx, g, { x: 10 + 16, y: 30 })).toBe(12);
  });

  test("round-trips with offsetToCaretRect", () => {
    const g = geometry();
    for (const offset of [0, 2, 7, 11]) {
      const rect = offsetToCaretRect(ctx, g, offset);
      expect(pointToOffset(ctx, g, { x: rect.x, y: rect.y + 1 })).toBe(offset);
    }
  });
});

describe("rangeToRects", () => {
  test("single-line range", () => {
    const rects = rangeToRects(ctx, geometry(), 2, 6);
    expect(rects).toHaveLength(1);
    expect(rects[0]).toEqual({ x: 10 + 16, y: 5, width: 32, height: 20 });
  });

  test("range spanning a wrap produces one rect per line", () => {
    const g = geometry({ text: "aaaa bbbb cccc", wrapWidth: 80 });
    const rects = rangeToRects(ctx, g, 4, 12);
    expect(rects).toHaveLength(2);
    // Line 0: chars [4, 9) of "aaaa bbbb"
    expect(rects[0]).toEqual({ x: 10 + 32, y: 5, width: 40, height: 20 });
    // Line 1: chars [0, 2) of "cccc"
    expect(rects[1]).toEqual({ x: 10, y: 25, width: 16, height: 20 });
  });

  test("empty range yields no rects", () => {
    expect(rangeToRects(ctx, geometry(), 3, 3)).toHaveLength(0);
  });
});

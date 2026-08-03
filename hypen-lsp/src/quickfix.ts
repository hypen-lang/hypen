/**
 * Quick-fix edit computation for accessibility diagnostics.
 *
 * Pure text → edit functions, decoupled from the LSP connection so they are
 * testable in isolation. The a11y diagnostics (source `"hypen-a11y"`) underline
 * the element's NAME token; from that anchor each fix derives one insertion:
 *
 * - `missing-accessible-name` / `form-control-missing-label` → `.label("")`
 *   appended after the element's complete expression (arguments, children
 *   block, and any existing applicator chain).
 * - `image-missing-alt` → `alt: ""` added to the argument list.
 * - `heading-missing-level` → `level: 1` added to the argument list.
 *
 * The scanner is deliberately robust-simple: it walks forward over balanced
 * `()`/`{}` pairs and `.applicator(...)` links, honouring string literals
 * (both quote styles, `\` escapes) and `//` line comments — the same string
 * discipline as the formatter in server.ts. It does not attempt a full parse;
 * unbalanced source clamps to end-of-text, which at worst places the label at
 * the end of the fragment rather than corrupting it.
 */

/** LSP-style position: 0-based line, 0-based UTF-16 code-unit column. */
export interface QuickFixPosition {
  line: number;
  character: number;
}

/**
 * Diagnostic-like input. The anchor is the element name token, given either
 * as JS string offsets (`startOffset`/`endOffset`) or as an LSP `range`
 * (offsets win when both are present).
 */
export interface QuickFixInput {
  /** Kebab-case rule id from the diagnostic `code`. */
  code: string;
  startOffset?: number;
  endOffset?: number;
  range?: { start: QuickFixPosition; end: QuickFixPosition };
}

export interface QuickFixEdit {
  /** Human-readable action title (shown in the lightbulb menu). */
  title: string;
  /** Text to insert at `insertOffset` (pure insertion; nothing is replaced). */
  newText: string;
  /** JS string offset (UTF-16 code units) where `newText` is inserted. */
  insertOffset: number;
}

/** Convert an LSP position (UTF-16 columns) to a JS string offset. */
export function positionToOffset(text: string, pos: QuickFixPosition): number {
  let offset = 0;
  for (let line = 0; line < pos.line; line++) {
    const nl = text.indexOf("\n", offset);
    if (nl === -1) {
      return text.length;
    }
    offset = nl + 1;
  }
  return Math.min(offset + pos.character, text.length);
}

/** Index just past the closing quote of the string starting at `i`. */
function skipString(text: string, i: number): number {
  const quote = text[i];
  i++;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    i++;
  }
  return i;
}

/**
 * Skip whitespace and `//` line comments. Comments count as trivia so an
 * applicator chain interleaved with comments is still one expression.
 */
function skipTrivia(text: string, i: number): number {
  while (i < text.length) {
    const ch = text[i];
    if (ch === " " || ch === "\t" || ch === "\r" || ch === "\n") {
      i++;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
    } else {
      break;
    }
  }
  return i;
}

/**
 * `text[i]` is `(` or `{`; returns the index just past the matching close.
 * Strings and line comments inside the block are opaque. Unbalanced input
 * clamps to end-of-text.
 */
function skipBalanced(text: string, i: number): number {
  const open = text[i];
  const close = open === "(" ? ")" : "}";
  let depth = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '"' || ch === "'") {
      i = skipString(text, i);
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") {
        i++;
      }
      continue;
    }
    if (ch === open) {
      depth++;
    } else if (ch === close) {
      depth--;
      if (depth === 0) {
        return i + 1;
      }
    }
    i++;
  }
  return i;
}

/**
 * Given the offset just past an element's name token, return the offset just
 * past its complete expression: optional `(args)`, optional `{ children }`,
 * then any `.applicator(...)` chain. A bare element (e.g. `Spacer`) yields
 * `nameEnd` unchanged.
 */
export function findExpressionEnd(text: string, nameEnd: number): number {
  let end = nameEnd;

  let probe = skipTrivia(text, end);
  if (text[probe] === "(") {
    end = skipBalanced(text, probe);
  }

  probe = skipTrivia(text, end);
  if (text[probe] === "{") {
    end = skipBalanced(text, probe);
  }

  // Applicator chain: `.name(args)` links. Elements never start with `.`,
  // so a leading dot after trivia always continues this expression. A dot
  // not followed by an identifier + `(` is left alone (conservative stop).
  for (;;) {
    probe = skipTrivia(text, end);
    if (text[probe] !== ".") {
      break;
    }
    let j = probe + 1;
    if (!/[A-Za-z_]/.test(text[j] ?? "")) {
      break;
    }
    while (j < text.length && /[A-Za-z0-9_]/.test(text[j]!)) {
      j++;
    }
    const paren = skipTrivia(text, j);
    if (text[paren] !== "(") {
      break;
    }
    end = skipBalanced(text, paren);
  }

  return end;
}

/**
 * Insertion of a named argument into the element's argument list: prepends
 * to existing args (`Image(src…)` → `Image(alt: "", src…)`), fills empty
 * parens, or creates the list when the element has none.
 */
function argumentInsertion(
  text: string,
  nameEnd: number,
  argText: string,
): { newText: string; insertOffset: number } {
  const openParen = skipTrivia(text, nameEnd);
  if (text[openParen] === "(") {
    const firstArg = skipTrivia(text, openParen + 1);
    if (text[firstArg] === ")") {
      return { newText: argText, insertOffset: openParen + 1 };
    }
    return { newText: `${argText}, `, insertOffset: openParen + 1 };
  }
  // No argument list — create one flush against the name token so a
  // following children block stays untouched: `Image {` → `Image(alt: "") {`.
  return { newText: `(${argText})`, insertOffset: nameEnd };
}

/**
 * Compute the quick-fix edit for one a11y diagnostic, or `null` when the
 * rule has no automatic fix. Only inspects text at/after the name token, so
 * a stale diagnostic against edited text degrades to a misplaced insertion,
 * never an exception.
 */
export function computeQuickFix(
  text: string,
  input: QuickFixInput,
): QuickFixEdit | null {
  const nameEnd =
    input.endOffset ??
    (input.range ? positionToOffset(text, input.range.end) : null);
  if (nameEnd === null || nameEnd < 0 || nameEnd > text.length) {
    return null;
  }

  switch (input.code) {
    case "missing-accessible-name":
    case "form-control-missing-label": {
      return {
        title: 'Add .label("")',
        newText: '.label("")',
        insertOffset: findExpressionEnd(text, nameEnd),
      };
    }
    case "image-missing-alt": {
      const edit = argumentInsertion(text, nameEnd, 'alt: ""');
      return { title: 'Add alt: ""', ...edit };
    }
    case "heading-missing-level": {
      const edit = argumentInsertion(text, nameEnd, "level: 1");
      return { title: "Add level: 1", ...edit };
    }
    default:
      return null;
  }
}

//! Source spans carried from the parser into the IR.
//!
//! The parser records a byte range for every component name token
//! (`MetaData::name_range`). [`SourceSpan`] threads that range — unchanged —
//! onto [`crate::ir::Element`] so downstream passes (the accessibility
//! conformance checker, and eventually other lints) can point at the exact
//! source location of a finding.
//!
//! Spans are **byte offsets**, deliberately not line/column: the engine never
//! holds the source string, so it cannot (and should not) resolve lines.
//! Resolution happens exactly once, at the host boundary that owns the source
//! (`check_accessibility_source_located`, the CLI, the LSP), via
//! [`LineIndex`]. Line/column encoding differs per consumer — a human-facing
//! CLI wants 1-based codepoint columns, the LSP wants 0-based UTF-16 code
//! units — so [`LineIndex`] exposes both as distinct methods rather than
//! baking one consumer's encoding into shared data.
//!
//! Spans live only on `Element`, never on `Patch` — conformance walks the IR
//! tree, not the patch stream, so there is no wire-format or renderer change.

use serde::{Deserialize, Serialize};

/// Half-open byte range `[start, end)` into the component's source string.
/// Mirrors the parser's `Range<usize>` but is `Copy` and serde-friendly.
/// Line/column resolution happens at the host boundary that owns the source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceSpan {
    pub start: usize,
    pub end: usize,
}

impl SourceSpan {
    pub fn from_range(r: &std::ops::Range<usize>) -> Self {
        Self {
            start: r.start,
            end: r.end,
        }
    }
}

/// Precomputed line-start offsets for O(log n) byte→(line, col) lookup.
///
/// Build once per source string, then call [`locate`](Self::locate) (CLI:
/// 1-based line, 1-based codepoint column) or
/// [`locate_utf16`](Self::locate_utf16) (LSP: 0-based line, 0-based UTF-16
/// code-unit column) per span endpoint.
pub struct LineIndex<'a> {
    source: &'a str,
    /// Byte offset of the first byte of each line. `line_starts[0] == 0`.
    line_starts: Vec<usize>,
}

impl<'a> LineIndex<'a> {
    pub fn new(source: &'a str) -> Self {
        let mut line_starts = vec![0];
        line_starts.extend(
            source
                .char_indices()
                .filter_map(|(i, c)| (c == '\n').then_some(i + 1)),
        );
        Self {
            source,
            line_starts,
        }
    }

    /// The 0-based line containing `byte`, and that line's start offset.
    /// Offsets past the end of the source clamp to the last line.
    fn line_of(&self, byte: usize) -> (usize, usize) {
        let line = match self.line_starts.binary_search(&byte) {
            Ok(exact) => exact,
            Err(insertion) => insertion - 1,
        };
        (line, self.line_starts[line])
    }

    /// Resolve a byte offset to a **1-based line and 1-based column counted
    /// in Unicode codepoints** — the human-facing convention used by the CLI
    /// (matches how editors display cursor position for most text).
    pub fn locate(&self, byte: usize) -> (usize, usize) {
        let byte = byte.min(self.source.len());
        let (line, line_start) = self.line_of(byte);
        let col = self.source[line_start..byte].chars().count();
        (line + 1, col + 1)
    }

    /// Resolve a byte offset to a **0-based line and 0-based column counted
    /// in UTF-16 code units** — the LSP default `positionEncoding`. Using
    /// codepoints or bytes here would misplace squiggles on any line with a
    /// multi-byte character before the token.
    pub fn locate_utf16(&self, byte: usize) -> (usize, usize) {
        let byte = byte.min(self.source.len());
        let (line, line_start) = self.line_of(byte);
        let col = self.source[line_start..byte]
            .chars()
            .map(|c| c.len_utf16())
            .sum();
        (line, col)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_range_copies_endpoints() {
        let span = SourceSpan::from_range(&(3..9));
        assert_eq!(span, SourceSpan { start: 3, end: 9 });
    }

    #[test]
    fn locates_on_the_first_line() {
        let idx = LineIndex::new("Button(\"x\")");
        assert_eq!(idx.locate(0), (1, 1));
        assert_eq!(idx.locate(6), (1, 7));
    }

    #[test]
    fn locates_across_lines() {
        //           0123456 78901234 5
        let src = "Column {\n    Text\n}";
        let idx = LineIndex::new(src);
        assert_eq!(idx.locate(0), (1, 1));
        // byte 9 is the start of line 2 ("    Text")
        assert_eq!(idx.locate(9), (2, 1));
        // byte 13 is the 'T' of Text
        assert_eq!(idx.locate(13), (2, 5));
        // byte 18 is the '}' on line 3
        assert_eq!(idx.locate(18), (3, 1));
    }

    #[test]
    fn locates_at_line_boundaries() {
        let src = "a\nb\n";
        let idx = LineIndex::new(src);
        // The newline byte itself belongs to the line it terminates.
        assert_eq!(idx.locate(1), (1, 2));
        // The byte after a newline starts the next line.
        assert_eq!(idx.locate(2), (2, 1));
        // End-of-source (after trailing newline) is the start of a final
        // empty line.
        assert_eq!(idx.locate(4), (3, 1));
    }

    #[test]
    fn empty_source_locates_to_origin() {
        let idx = LineIndex::new("");
        assert_eq!(idx.locate(0), (1, 1));
        assert_eq!(idx.locate_utf16(0), (0, 0));
        // Past-the-end offsets clamp instead of panicking.
        assert_eq!(idx.locate(99), (1, 1));
    }

    #[test]
    fn utf8_codepoint_vs_utf16_unit_columns_diverge() {
        // "é" is 2 UTF-8 bytes / 1 codepoint / 1 UTF-16 unit.
        // "𝄞" (U+1D11E) is 4 UTF-8 bytes / 1 codepoint / 2 UTF-16 units.
        let src = "é𝄞X";
        let idx = LineIndex::new(src);
        let x_byte = src.find('X').unwrap(); // 6
                                             // Human column: 2 codepoints precede X → column 3 (1-based).
        assert_eq!(idx.locate(x_byte), (1, 3));
        // LSP column: 1 + 2 = 3 UTF-16 units precede X (0-based).
        assert_eq!(idx.locate_utf16(x_byte), (0, 3));
    }

    #[test]
    fn multibyte_before_token_on_a_later_line() {
        let src = "Text(\"héllo\")\nButton";
        let idx = LineIndex::new(src);
        let button_byte = src.find("Button").unwrap();
        assert_eq!(idx.locate(button_byte), (2, 1));
        assert_eq!(idx.locate_utf16(button_byte), (1, 0));
    }
}

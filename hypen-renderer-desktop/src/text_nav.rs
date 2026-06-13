//! Word- and line-boundary helpers for text editing.
//!
//! `Input`s use these for double-click / triple-click selection and
//! for `Ctrl/Cmd + ArrowLeft/Right` word-step navigation. Boundaries
//! are pure functions over UTF-8 byte offsets so they're easy to test
//! without spinning up an `App`.
//!
//! Word definition: a maximal run of "word" characters
//! (`char::is_alphanumeric` plus `_`). Matches what most desktop text
//! editors call "word" — locale-correct enough for the western
//! alphabets the bundled examples use, and decent for CJK ideographs
//! (`is_alphanumeric` returns `true` for them).

/// Whether `c` counts as part of a word for `Ctrl + Arrow` purposes.
fn is_word_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

/// Byte offset of the **start** of the word containing `byte`. If the
/// cursor sits on a non-word char, walks left to the previous word's
/// start; if there is no previous word, returns `0`.
///
/// Examples (`|` is the cursor):
///   "hello |world"        → 6   (already at start of "world")
///   "hello wo|rld"        → 6
///   "hello world|"        → 6   (right edge of "world")
///   "hello world  |"      → 12  (cursor in trailing whitespace → no
///                                preceding *word* end matches; treat
///                                the cursor itself as the start)
pub(crate) fn word_start(text: &str, byte: usize) -> usize {
    let byte = byte.min(text.len());
    // Step back over any non-word chars first to land inside a word.
    let mut i = byte;
    while i > 0 {
        let prev = text[..i].chars().next_back().unwrap();
        if is_word_char(prev) {
            break;
        }
        i -= prev.len_utf8();
    }
    // Now walk back while the previous char is a word char.
    while i > 0 {
        let prev = text[..i].chars().next_back().unwrap();
        if !is_word_char(prev) {
            break;
        }
        i -= prev.len_utf8();
    }
    i
}

/// Byte offset of the **end** of the word containing `byte`. If the
/// cursor sits on a non-word char, walks right to the next word's
/// end; if there is no next word, returns `text.len()`.
pub(crate) fn word_end(text: &str, byte: usize) -> usize {
    let byte = byte.min(text.len());
    let mut i = byte;
    // Step forward over any non-word chars to enter the next word.
    while i < text.len() {
        let next = text[i..].chars().next().unwrap();
        if is_word_char(next) {
            break;
        }
        i += next.len_utf8();
    }
    // Walk forward while the current char is a word char.
    while i < text.len() {
        let next = text[i..].chars().next().unwrap();
        if !is_word_char(next) {
            break;
        }
        i += next.len_utf8();
    }
    i
}

/// `(start, end)` byte offsets of the word **at** `byte`. When the
/// byte sits on a word char, the range covers the surrounding word.
/// When it sits on whitespace, the range covers the surrounding run
/// of whitespace (so double-clicking in whitespace selects that
/// whitespace, matching macOS / GNOME conventions).
pub(crate) fn word_range_at(text: &str, byte: usize) -> (usize, usize) {
    let byte = byte.min(text.len());
    if text.is_empty() {
        return (0, 0);
    }
    let on_word = match text[byte..].chars().next() {
        Some(c) => is_word_char(c),
        None => {
            // At end of string — treat as word if previous char was a word char.
            text[..byte]
                .chars()
                .next_back()
                .map(is_word_char)
                .unwrap_or(false)
        }
    };
    if on_word {
        let start = walk_back_while(text, byte, is_word_char);
        let end = walk_forward_while(text, byte, is_word_char);
        (start, end)
    } else {
        let start = walk_back_while(text, byte, |c| !is_word_char(c));
        let end = walk_forward_while(text, byte, |c| !is_word_char(c));
        (start, end)
    }
}

fn walk_back_while(text: &str, mut i: usize, pred: impl Fn(char) -> bool) -> usize {
    while i > 0 {
        let prev = text[..i].chars().next_back().unwrap();
        if !pred(prev) {
            break;
        }
        i -= prev.len_utf8();
    }
    i
}

fn walk_forward_while(text: &str, mut i: usize, pred: impl Fn(char) -> bool) -> usize {
    while i < text.len() {
        let next = text[i..].chars().next().unwrap();
        if !pred(next) {
            break;
        }
        i += next.len_utf8();
    }
    i
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn word_start_inside_word_walks_to_word_start() {
        // Cursor inside / at the right edge of "world" → 6.
        assert_eq!(word_start("hello world", 8), 6);
        assert_eq!(word_start("hello world", 11), 6);
        // Cursor exactly between space and "w" → previous word is
        // "hello", so jump to 0 (matches Ctrl+ArrowLeft semantics).
        assert_eq!(word_start("hello world", 6), 0);
    }

    #[test]
    fn word_start_in_whitespace_walks_past_to_previous_word() {
        // "hello world" — cursor at 5 (the space). Walking back: skip
        // the space, then walk back through "hello" → 0.
        assert_eq!(word_start("hello world", 5), 0);
    }

    #[test]
    fn word_start_at_zero_returns_zero() {
        assert_eq!(word_start("hello", 0), 0);
        assert_eq!(word_start("", 0), 0);
    }

    #[test]
    fn word_end_inside_word_walks_to_word_end() {
        assert_eq!(word_end("hello world", 0), 5);
        assert_eq!(word_end("hello world", 3), 5);
        assert_eq!(word_end("hello world", 5), 11);
    }

    #[test]
    fn word_end_at_string_end_stays_at_end() {
        let s = "hello";
        assert_eq!(word_end(s, s.len()), s.len());
    }

    #[test]
    fn word_range_at_word_char() {
        assert_eq!(word_range_at("hello world", 0), (0, 5));
        assert_eq!(word_range_at("hello world", 2), (0, 5));
        assert_eq!(word_range_at("hello world", 4), (0, 5));
        assert_eq!(word_range_at("hello world", 6), (6, 11));
    }

    #[test]
    fn word_range_at_whitespace_selects_whitespace_run() {
        // Two spaces between words — cursor in either should select
        // the whitespace run.
        assert_eq!(word_range_at("hi  there", 2), (2, 4));
        assert_eq!(word_range_at("hi  there", 3), (2, 4));
    }

    #[test]
    fn word_range_at_empty_string() {
        assert_eq!(word_range_at("", 0), (0, 0));
    }

    #[test]
    fn word_navigation_handles_multibyte_codepoints() {
        // CJK + ASCII mix. `is_alphanumeric` returns true for kanji,
        // so "今日hello" is one word from `is_word_char`'s view.
        let s = "今日hello world";
        let kanji_bytes = "今日".len(); // 6 bytes
        let after_hello = kanji_bytes + "hello".len(); // 11 bytes
                                                       // Cursor inside "world" → range covers "world".
        let world_start = after_hello + 1; // skip space
        assert_eq!(word_range_at(s, world_start + 2), (world_start, s.len()),);
        // Word_end starting in "今日hello" walks to the end of "hello".
        assert_eq!(word_end(s, 0), after_hello);
    }

    #[test]
    fn word_start_in_punctuation_treats_punct_as_non_word() {
        // "foo.bar" — cursor inside "bar". Walk back stops at the dot.
        assert_eq!(word_start("foo.bar", 5), 4);
        // Cursor on dot — walk back over dot, then through "foo".
        assert_eq!(word_start("foo.bar", 3), 0);
    }
}

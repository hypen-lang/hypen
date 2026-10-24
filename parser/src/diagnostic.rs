//! Turning parser errors into precise, readable diagnostics.
//!
//! This module is available in every build (CLI, WASM, engine) so all
//! consumers describe an error the same way:
//!
//! - [`describe_error`] renders one error as `expected X, Y or Z, found W`
//!   (or the custom message for errors such as an unclosed string).
//! - [`refine_errors`] post-processes a parse's errors: an error at end of
//!   input that is really "this delimiter was never closed" is re-targeted at
//!   the unclosed opener (pointing at the empty end of the file is useless),
//!   and duplicate errors are dropped.
//! - [`line_col`] converts a byte offset (all spans are UTF-8 byte offsets
//!   into the source) to a 1-based line and a 1-based column counted in
//!   Unicode scalar values (characters); [`lsp_position`] gives the 0-based
//!   line and UTF-16 column editors expect.

use chumsky::error::{Rich, RichPattern, RichReason};
use chumsky::span::SimpleSpan;

use crate::parser::CONTINUE_LABEL;

/// True for expectations that never help the reader: whitespace and comment
/// starts are allowed almost everywhere, "an identifier could continue here"
/// is always true right after an identifier, and "something else" carries no
/// information.
fn is_noise(pattern: &RichPattern<'_, char>) -> bool {
    match pattern {
        RichPattern::Token(t) => **t == '/',
        RichPattern::Label(l) => l == "whitespace" || l == CONTINUE_LABEL,
        RichPattern::SomethingElse | RichPattern::Any | RichPattern::EndOfInput => true,
        RichPattern::Identifier(_) => false,
    }
}

fn quote_char(c: char) -> String {
    match c {
        '\n' => "line break".to_string(),
        '\r' => "carriage return".to_string(),
        '\t' => "tab".to_string(),
        c => format!("'{c}'"),
    }
}

fn describe_pattern(pattern: &RichPattern<'_, char>) -> String {
    match pattern {
        RichPattern::Token(t) => quote_char(**t),
        RichPattern::Label(l) => l.to_string(),
        RichPattern::Identifier(k) => format!("'{k}'"),
        RichPattern::Any => "any character".to_string(),
        RichPattern::SomethingElse => "something else".to_string(),
        RichPattern::EndOfInput => "end of input".to_string(),
    }
}

/// `a`, `a or b`, `a, b or c`
fn join_alternatives(items: &[String]) -> String {
    match items {
        [] => String::new(),
        [one] => one.clone(),
        [init @ .., last] => format!("{} or {}", init.join(", "), last),
    }
}

/// The useful expectations of an error, deduplicated, in the order chumsky
/// recorded them.
fn expected_list(error: &Rich<'_, char>) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for pattern in error.expected() {
        if is_noise(pattern) {
            continue;
        }
        let text = describe_pattern(pattern);
        if !out.contains(&text) {
            out.push(text);
        }
    }
    out
}

/// One error as a sentence without position: `expected ')' or ',', found
/// '}'`, `unexpected '$'`, or the custom message.
pub fn describe_error(error: &Rich<'_, char>) -> String {
    match error.reason() {
        RichReason::Custom(msg) => msg.clone(),
        RichReason::ExpectedFound { found, .. } => {
            let found = match found {
                Some(c) => quote_char(**c),
                None => "end of input".to_string(),
            };
            let expected = expected_list(error);
            if expected.is_empty() {
                format!("unexpected {found}")
            } else {
                format!("expected {}, found {found}", join_alternatives(&expected))
            }
        }
    }
}

/// 1-based `(line, column)` of a UTF-8 byte offset, with the column counted
/// in characters (Unicode scalar values). Offsets past the end clamp to the
/// end; an offset inside a multi-byte character counts that character.
pub fn line_col(source: &str, byte_offset: usize) -> (usize, usize) {
    let mut line = 1;
    let mut col = 1;
    for (i, c) in source.char_indices() {
        if i >= byte_offset {
            break;
        }
        if c == '\n' {
            line += 1;
            col = 1;
        } else {
            col += 1;
        }
    }
    (line, col)
}

/// 0-based `(line, character)` of a UTF-8 byte offset with the character
/// counted in UTF-16 code units — the Language Server Protocol's default
/// position encoding (and JavaScript string indexing).
pub fn lsp_position(source: &str, byte_offset: usize) -> (usize, usize) {
    let mut line = 0;
    let mut character = 0;
    for (i, c) in source.char_indices() {
        if i >= byte_offset {
            break;
        }
        if c == '\n' {
            line += 1;
            character = 0;
        } else {
            character += c.len_utf16();
        }
    }
    (line, character)
}

/// What a lexical scan of a source prefix found.
struct Scan {
    /// Delimiters still open at the end, innermost last, as
    /// `(opener, byte offset)`.
    unclosed: Vec<(char, usize)>,
    /// Closed string literals as `(opening quote, closing quote)` offsets.
    strings: Vec<(usize, usize)>,
}

/// Scan `source` the way the parser lexes it: strings (with backslash
/// escapes) and line/nested block comments are skipped, `{ ( [` are matched
/// against `} ) ]`.
fn scan(source: &str) -> Scan {
    let mut unclosed: Vec<(char, usize)> = Vec::new();
    let mut strings = Vec::new();
    let mut chars = source.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match c {
            '"' | '\'' => {
                while let Some((j, d)) = chars.next() {
                    if d == '\\' {
                        chars.next();
                    } else if d == c {
                        strings.push((i, j));
                        break;
                    }
                }
            }
            '/' if matches!(chars.peek(), Some((_, '/'))) => {
                for (_, d) in chars.by_ref() {
                    if d == '\n' {
                        break;
                    }
                }
            }
            '/' if matches!(chars.peek(), Some((_, '*'))) => {
                chars.next();
                let mut depth = 1usize;
                let mut prev: Option<char> = None;
                for (_, d) in chars.by_ref() {
                    match (prev, d) {
                        (Some('/'), '*') => {
                            depth += 1;
                            prev = None;
                        }
                        (Some('*'), '/') => {
                            depth -= 1;
                            prev = None;
                            if depth == 0 {
                                break;
                            }
                        }
                        _ => prev = Some(d),
                    }
                }
            }
            '{' | '(' | '[' => unclosed.push((c, i)),
            '}' | ')' | ']' => {
                let open = match c {
                    '}' => '{',
                    ')' => '(',
                    _ => '[',
                };
                if unclosed.last().is_some_and(|(o, _)| *o == open) {
                    unclosed.pop();
                }
            }
            _ => {}
        }
    }
    Scan { unclosed, strings }
}

fn unclosed_delimiters(source: &str) -> Vec<(char, usize)> {
    scan(source).unclosed
}

/// A string that runs over a line break and is immediately followed by the
/// error almost always lost its closing quote: the next quote in the file
/// closed it, and the parser tripped over the code after that. Point at the
/// string's opening quote instead.
fn swallowed_by_string<'a>(source: &str, error: Rich<'a, char>) -> Rich<'a, char> {
    if !matches!(
        error.reason(),
        RichReason::ExpectedFound { found: Some(_), .. }
    ) {
        return error;
    }
    let offset = error.span().start;
    let Some(prefix) = source.get(..offset) else {
        return error;
    };
    let Some(&(open, close)) = scan(prefix).strings.last() else {
        return error;
    };
    let multi_line = source[open..close].contains('\n');
    let adjacent = source[close + 1..offset].chars().all(char::is_whitespace);
    if !(multi_line && adjacent) {
        return error;
    }
    let (line, col) = line_col(source, close);
    Rich::custom(
        SimpleSpan::new(open, open + 1),
        format!(
            "unclosed string literal? this string runs past the end of its line and is only closed by the quote at {line}:{col} ({})",
            describe_error(&error)
        ),
    )
}

/// When ')' is expected but the argument list started on an earlier line,
/// say where: the cause is usually a missing ')' on that line.
fn note_open_paren<'a>(source: &str, error: Rich<'a, char>) -> Rich<'a, char> {
    if !matches!(
        error.reason(),
        RichReason::ExpectedFound { found: Some(_), .. }
    ) || !expects_token(&error, ')')
    {
        return error;
    }
    let offset = error.span().start;
    let Some(prefix) = source.get(..offset) else {
        return error;
    };
    let Some(&(_, open_at)) = scan(prefix).unclosed.iter().rev().find(|(o, _)| *o == '(') else {
        return error;
    };
    let (open_line, open_col) = line_col(source, open_at);
    if open_line == line_col(source, offset).0 {
        return error;
    }
    Rich::custom(
        error.span().to_owned(),
        format!(
            "{} (the '(' at {open_line}:{open_col} is never closed)",
            describe_error(&error)
        ),
    )
}

fn closer_for(open: char) -> char {
    match open {
        '{' => '}',
        '(' => ')',
        _ => ']',
    }
}

/// True when the error lists `close` among its expectations.
fn expects_token(error: &Rich<'_, char>, close: char) -> bool {
    error.expected().any(|p| match p {
        RichPattern::Token(t) => **t == close,
        _ => false,
    })
}

/// A closing delimiter found where nothing it could close is open: say so
/// instead of only listing what was expected there.
fn unmatched_closer<'a>(source: &str, error: Rich<'a, char>) -> Rich<'a, char> {
    let RichReason::ExpectedFound {
        found: Some(found), ..
    } = error.reason()
    else {
        return error;
    };
    let close = **found;
    let open = match close {
        '}' => '{',
        ')' => '(',
        ']' => '[',
        _ => return error,
    };
    let offset = error.span().start;
    if expects_token(&error, close)
        || source
            .get(..offset)
            .is_none_or(|before| unclosed_delimiters(before).iter().any(|(o, _)| *o == open))
    {
        return error;
    }
    let expected = expected_list(&error);
    let mut msg = format!("unmatched '{close}': no '{open}' is open here");
    if !expected.is_empty() {
        msg.push_str(&format!(" (expected {})", join_alternatives(&expected)));
    }
    Rich::custom(error.span().to_owned(), msg)
}

/// Post-process the errors of one parse of `source` (see the module docs).
pub fn refine_errors<'a>(source: &str, errors: Vec<Rich<'a, char>>) -> Vec<Rich<'a, char>> {
    let mut out: Vec<Rich<'a, char>> = Vec::with_capacity(errors.len());
    for error in errors {
        let at_eof = matches!(
            error.reason(),
            RichReason::ExpectedFound { found: None, .. }
        );
        let error = if at_eof {
            match unclosed_delimiters(source).last() {
                Some(&(open, offset)) if expects_token(&error, closer_for(open)) => {
                    let close = closer_for(open);
                    Rich::custom(
                        SimpleSpan::new(offset, offset + 1),
                        format!(
                            "unclosed '{open}': expected a matching '{close}', found end of input"
                        ),
                    )
                }
                _ => error,
            }
        } else {
            error
        };
        let error = unmatched_closer(source, error);
        let error = swallowed_by_string(source, error);
        let error = note_open_paren(source, error);
        let duplicate = out
            .iter()
            .any(|e| e.span() == error.span() && describe_error(e) == describe_error(&error));
        if !duplicate {
            out.push(error);
        }
    }
    out
}

use ariadne::{Color, Label, Report, ReportKind, Source};
pub use chumsky::error::Rich;

use crate::diagnostic::describe_error;

/// A short fix-it suggestion for the common mistakes the parser recognises.
fn hint_for(message: &str) -> Option<&'static str> {
    if message.starts_with("unclosed string literal") {
        Some("add the closing quote to complete the string")
    } else if message.starts_with("unclosed '@{'") {
        Some("close the interpolation with '}' before the string's closing quote")
    } else if message.starts_with("unclosed '{'") {
        Some("add a closing '}' to complete the block")
    } else if message.starts_with("unclosed '('") {
        Some("add a closing ')' to complete the argument list")
    } else if message.starts_with("unclosed '['") {
        Some("add a closing ']' to complete the list")
    } else if message.starts_with("unclosed block comment") {
        Some("add '*/' to end the comment")
    } else if message.contains("found ','") {
        Some("remove the extra comma or add the missing value")
    } else {
        None
    }
}

/// Ariadne 0.4 indexes sources by character; parser spans are UTF-8 byte
/// offsets. Convert so labels land on the right column after non-ASCII text.
fn byte_to_char_offset(source: &str, byte: usize) -> usize {
    source.char_indices().take_while(|(i, _)| *i < byte).count()
}

fn build_report<'a>(
    filename: &'a str,
    source: &str,
    error: &Rich<char>,
) -> Report<'a, (&'a str, std::ops::Range<usize>)> {
    let bytes = error.span().into_range();
    let span = byte_to_char_offset(source, bytes.start)..byte_to_char_offset(source, bytes.end);
    let msg = describe_error(error);
    let mut report = Report::build(ReportKind::Error, filename, span.start)
        .with_message("Parse error")
        .with_label(
            Label::new((filename, span))
                .with_message(&msg)
                .with_color(Color::Red),
        );
    if let Some(hint) = hint_for(&msg) {
        report = report.with_help(hint);
    }
    report.finish()
}

/// Pretty-print parse errors using Ariadne
pub fn print_parse_errors(filename: &str, source: &str, errors: &[Rich<char>]) {
    for error in errors {
        build_report(filename, source, error)
            .print((filename, Source::from(source)))
            .unwrap();
    }
}

/// Format parse errors as a string without printing
pub fn format_parse_errors(filename: &str, source: &str, errors: &[Rich<char>]) -> String {
    let mut output = Vec::new();
    for error in errors {
        build_report(filename, source, error)
            .write((filename, Source::from(source)), &mut output)
            .unwrap();
    }
    String::from_utf8(output).unwrap()
}

/// One-line error for logs and engine error payloads:
/// `expected ')' or ',', found '}' at position 41`.
///
/// The position is the UTF-8 **byte** offset of the error in the source and
/// always ends the message (hosts such as `hypen dev` parse it with
/// `/ at position (\d+)$/` to print `file:line:col`).
pub fn format_error_simple(error: &Rich<char>) -> String {
    format!(
        "{} at position {}",
        describe_error(error),
        error.span().start
    )
}

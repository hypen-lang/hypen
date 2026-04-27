use ariadne::{Color, Label, Report, ReportKind, Source};
pub use chumsky::error::Rich;
use std::ops::Range;

/// Check if an expected pattern is noise that should be filtered out
fn is_noise_pattern(s: &str) -> bool {
    s.contains("whitespace")
        || s.contains("end of input")
        || s == "something else"
        || s.contains("'/'")
}

/// Find the position of the last unmatched opening delimiter
fn find_unmatched_opener(source: &str, open: char, close: char) -> Option<usize> {
    let mut stack = Vec::new();
    let chars: Vec<char> = source.chars().collect();
    let mut i = 0;
    let mut in_double_string = false;
    let mut in_single_string = false;

    // Build a byte offset map for char_indices parity
    let byte_offsets: Vec<usize> = source.char_indices().map(|(pos, _)| pos).collect();

    while i < chars.len() {
        let ch = chars[i];
        let in_string = in_double_string || in_single_string;

        if in_string && ch == '\\' {
            // Skip escaped character
            i += 2;
            continue;
        }

        if ch == '"' && !in_single_string {
            in_double_string = !in_double_string;
        } else if ch == '\'' && !in_double_string {
            in_single_string = !in_single_string;
        } else if !in_string {
            if ch == open {
                stack.push(byte_offsets[i]);
            } else if ch == close {
                stack.pop();
            }
        }

        i += 1;
    }

    stack.last().copied()
}

/// Find the position of an unclosed string literal
fn find_unclosed_string(source: &str) -> Option<usize> {
    let chars: Vec<char> = source.chars().collect();
    let byte_offsets: Vec<usize> = source.char_indices().map(|(pos, _)| pos).collect();
    let mut i = 0;
    let mut in_double_string = false;
    let mut in_single_string = false;
    let mut string_start = 0;

    while i < chars.len() {
        let ch = chars[i];
        let in_string = in_double_string || in_single_string;

        if in_string && ch == '\\' {
            // Skip escaped character
            i += 2;
            continue;
        }

        if ch == '"' && !in_single_string {
            if !in_double_string {
                in_double_string = true;
                string_start = byte_offsets[i];
            } else {
                in_double_string = false;
            }
        } else if ch == '\'' && !in_double_string {
            if !in_single_string {
                in_single_string = true;
                string_start = byte_offsets[i];
            } else {
                in_single_string = false;
            }
        }

        i += 1;
    }

    if in_double_string || in_single_string {
        Some(string_start)
    } else {
        None
    }
}

/// Detected error with message, hint, and source location
struct DetectedError {
    message: String,
    hint: Option<String>,
    span: Option<Range<usize>>,
}

/// Find pattern in source, returning position
fn find_pattern(source: &str, pattern: &str) -> Option<usize> {
    source.find(pattern)
}

/// Analyze source to detect common error patterns
fn detect_error(source: &str) -> Option<DetectedError> {
    // Priority 1: Unclosed string
    if let Some(pos) = find_unclosed_string(source) {
        return Some(DetectedError {
            message: "unclosed string literal".into(),
            hint: Some("add a closing '\"' to complete the string".into()),
            span: Some(pos..pos + 1),
        });
    }

    // Priority 2: Unclosed parentheses
    if let Some(pos) = find_unmatched_opener(source, '(', ')') {
        return Some(DetectedError {
            message: "unclosed parentheses".into(),
            hint: Some("add a closing ')' to complete the argument list".into()),
            span: Some(pos..pos + 1),
        });
    }

    // Priority 3: Unclosed braces
    if let Some(pos) = find_unmatched_opener(source, '{', '}') {
        return Some(DetectedError {
            message: "unclosed block".into(),
            hint: Some("add a closing '}' to complete the block".into()),
            span: Some(pos..pos + 1),
        });
    }

    // Priority 4: Unclosed brackets
    if let Some(pos) = find_unmatched_opener(source, '[', ']') {
        return Some(DetectedError {
            message: "unclosed list".into(),
            hint: Some("add a closing ']' to complete the list".into()),
            span: Some(pos..pos + 1),
        });
    }

    // Priority 5: Missing value after colon (e.g., "key: ,")
    if let Some(pos) = find_pattern(source, ": ,") {
        return Some(DetectedError {
            message: "missing value after ':'".into(),
            hint: Some("add a value after the colon".into()),
            span: Some(pos..pos + 3),
        });
    }

    // Priority 6: Double comma (e.g., "a, , b")
    if let Some(pos) = find_pattern(source, ", ,") {
        return Some(DetectedError {
            message: "unexpected ','".into(),
            hint: Some("remove the extra comma or add a value".into()),
            span: Some(pos + 2..pos + 3),
        });
    }

    // Priority 7: Comma at start of arguments (e.g., "(, a)")
    if let Some(pos) = find_pattern(source, "(,") {
        return Some(DetectedError {
            message: "unexpected ',' at start of arguments".into(),
            hint: Some("remove the leading comma".into()),
            span: Some(pos + 1..pos + 2),
        });
    }

    None
}

/// Format error from Chumsky's expected tokens (fallback when we can't detect the pattern)
fn format_from_expected(found: Option<&char>, expected: &[String]) -> String {
    let useful: Vec<_> = expected
        .iter()
        .filter(|s| !is_noise_pattern(s))
        .take(3)
        .collect();

    match found {
        Some(ch) if useful.is_empty() => format!("unexpected '{}'", ch),
        Some(ch) => format!(
            "unexpected '{}', expected {}",
            ch,
            useful
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(" or ")
        ),
        None if useful.is_empty() => "unexpected end of input".into(),
        None => format!(
            "unexpected end of input, expected {}",
            useful
                .iter()
                .map(|s| s.as_str())
                .collect::<Vec<_>>()
                .join(" or ")
        ),
    }
}

/// Pretty-print parse errors using Ariadne
pub fn print_parse_errors(filename: &str, source: &str, errors: &[Rich<char>]) {
    for error in errors {
        let default_span = error.span().into_range();

        // Try to detect the error pattern from source analysis
        let (msg, hint, span) = if let Some(detected) = detect_error(source) {
            (
                detected.message,
                detected.hint,
                detected.span.unwrap_or(default_span),
            )
        } else {
            // Fallback: use Chumsky's expected tokens
            let expected: Vec<String> = error.expected().map(|e| format!("{}", e)).collect();
            (
                format_from_expected(error.found(), &expected),
                None,
                default_span,
            )
        };

        let mut report = Report::build(ReportKind::Error, filename, span.start)
            .with_message("Parse error")
            .with_label(
                Label::new((filename, span))
                    .with_message(&msg)
                    .with_color(Color::Red),
            );

        if let Some(hint_msg) = hint {
            report = report.with_help(hint_msg);
        }

        report
            .finish()
            .print((filename, Source::from(source)))
            .unwrap();
    }
}

/// Format parse errors as a string without printing
pub fn format_parse_errors(filename: &str, source: &str, errors: &[Rich<char>]) -> String {
    let mut output = Vec::new();

    for error in errors {
        let default_span = error.span().into_range();

        let (msg, hint, span) = if let Some(detected) = detect_error(source) {
            (
                detected.message,
                detected.hint,
                detected.span.unwrap_or(default_span),
            )
        } else {
            let expected: Vec<String> = error.expected().map(|e| format!("{}", e)).collect();
            (
                format_from_expected(error.found(), &expected),
                None,
                default_span,
            )
        };

        let mut report = Report::build(ReportKind::Error, filename, span.start)
            .with_message("Parse error")
            .with_label(
                Label::new((filename, span))
                    .with_message(&msg)
                    .with_color(Color::Red),
            );

        if let Some(hint_msg) = hint {
            report = report.with_help(hint_msg);
        }

        report
            .finish()
            .write((filename, Source::from(source)), &mut output)
            .unwrap();
    }

    String::from_utf8(output).unwrap()
}

/// Simple error formatting without Ariadne (for tests and simple output)
pub fn format_error_simple(error: &Rich<char>) -> String {
    let expected: Vec<String> = error
        .expected()
        .map(|e| format!("{}", e))
        .filter(|s| !is_noise_pattern(s))
        .take(5)
        .collect();

    match error.found() {
        Some(ch) if expected.is_empty() => {
            format!("unexpected '{}' at position {}", ch, error.span().start)
        }
        Some(ch) => {
            format!(
                "unexpected '{}' at position {}, expected {}",
                ch,
                error.span().start,
                expected.join(" or ")
            )
        }
        None if expected.is_empty() => {
            format!("unexpected end of input at position {}", error.span().start)
        }
        None => {
            format!(
                "unexpected end of input at position {}, expected {}",
                error.span().start,
                expected.join(" or ")
            )
        }
    }
}

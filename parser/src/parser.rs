use chumsky::error::{LabelError, RichPattern};
use chumsky::prelude::*;

use crate::ast::*;

// ----------------------------------------------------------------------------
// Lexical primitives
//
// chumsky 1.0.0-alpha.8's `try_map` *discards* the pending "alternative"
// error when its mapper fails (`TryMap::go` takes `inp.errors.alt` and never
// restores it on the `Err` path). Every `text::*` helper (`whitespace`,
// `ascii::ident`, `keyword`, `int`, `digits`) is built on `try_map`, so the
// first time one of them failed — e.g. the comment/whitespace padding after a
// failed children block — the furthest error found so far was thrown away and
// the report fell back to the enclosing block: `module Home { Column {{{`
// was reported at the module's `{` instead of at the stray `{`.
//
// These replacements are built on `custom`, which records its failure through
// `add_alt_err` (furthest error wins, ties merge) and reports the character
// actually found. (`filter` would also keep the alt, but it records
// `found: None`, which then reads as "found end of input".)
// Do not reintroduce `text::*` helpers or `try_map` on a hot path.
// ----------------------------------------------------------------------------

type Extra<'a> = extra::Err<Rich<'a, char>>;

/// Label for "this token could continue here" (more identifier characters,
/// more digits, a decimal point). Always true right after such a token, so it
/// is never useful in a message and `diagnostic` filters it out.
pub(crate) const CONTINUE_LABEL: &str = "token continuation";

/// One character satisfying `pred`. On failure the error is labelled `label`
/// and carries the character found (or end of input) with its exact span.
fn char_where<'a>(
    label: &'static str,
    pred: fn(char) -> bool,
) -> impl Parser<'a, &'a str, char, Extra<'a>> + Clone {
    custom(
        move |inp: &mut chumsky::input::InputRef<'a, '_, &'a str, Extra<'a>>| {
            let before = inp.cursor();
            let found = inp.peek();
            match found {
                Some(c) if pred(c) => {
                    inp.skip();
                    Ok(c)
                }
                _ => {
                    let at = inp.span_since(&before).start;
                    let len = found.map_or(0, char::len_utf8);
                    Err(
                        <Rich<'a, char> as LabelError<'a, &'a str, _>>::expected_found(
                            [RichPattern::Label(label.into())],
                            found.map(chumsky::util::MaybeRef::Val),
                            SimpleSpan::new(at, at + len),
                        ),
                    )
                }
            }
        },
    )
}

/// ASCII identifier: `[A-Za-z_][A-Za-z0-9_]*` (same as `text::ascii::ident`).
fn ident<'a>() -> impl Parser<'a, &'a str, &'a str, Extra<'a>> + Clone {
    char_where("identifier", |c| c.is_ascii_alphabetic() || c == '_')
        .then(char_where(CONTINUE_LABEL, |c| c.is_ascii_alphanumeric() || c == '_').repeated())
        .to_slice()
}

/// A whole-word keyword (same as `text::keyword`): `modules` is not `module`.
fn keyword<'a>(kw: &'static str) -> impl Parser<'a, &'a str, &'a str, Extra<'a>> + Clone {
    custom(
        move |inp: &mut chumsky::input::InputRef<'a, '_, &'a str, Extra<'a>>| {
            let before = inp.cursor();
            let save = inp.save();
            let mut word = String::new();
            while let Some(c) = inp.peek() {
                let ok = if word.is_empty() {
                    c.is_ascii_alphabetic() || c == '_'
                } else {
                    c.is_ascii_alphanumeric() || c == '_'
                };
                if !ok {
                    break;
                }
                word.push(c);
                inp.skip();
            }
            if word == kw {
                return Ok(inp.slice_since(&before..));
            }
            let span = inp.span_since(&before);
            let found = inp.peek();
            inp.rewind(save);
            let found = if word.is_empty() {
                found
            } else {
                word.chars().next()
            };
            Err(
                <Rich<'a, char> as LabelError<'a, &'a str, _>>::expected_found(
                    [RichPattern::Identifier(kw.to_string())],
                    found.map(chumsky::util::MaybeRef::Val),
                    if word.is_empty() {
                        SimpleSpan::new(span.start, span.start + found.map_or(0, char::len_utf8))
                    } else {
                        span
                    },
                ),
            )
        },
    )
}

/// One or more whitespace characters.
fn whitespace1<'a>() -> impl Parser<'a, &'a str, (), Extra<'a>> + Clone {
    char_where("whitespace", char::is_whitespace)
        .repeated()
        .at_least(1)
}

/// One or more ASCII decimal digits (same as `text::digits(10)`).
fn digits<'a>() -> impl Parser<'a, &'a str, (), Extra<'a>> + Clone {
    char_where("digit", |c| c.is_ascii_digit())
        .repeated()
        .at_least(1)
}

/// Non-negative decimal integer without leading zeros (same as `text::int(10)`).
fn int<'a>() -> impl Parser<'a, &'a str, (), Extra<'a>> + Clone {
    char_where("digit", |c| c.is_ascii_digit() && c != '0')
        .then(char_where(CONTINUE_LABEL, |c| c.is_ascii_digit()).repeated())
        .ignored()
        .or(just('0').ignored())
}

/// The rest of a quoted string after its opening `quote` (lexed by hand).
///
/// Errors are positioned *after* the opening quote, so the labels of the
/// enclosing value/argument parsers (which start at the quote) do not
/// overwrite these messages:
/// - end of input before the closing quote: "unclosed string literal",
///   spanning the opening quote;
/// - a `@{` interpolation still open at the closing quote: spans the `@{`
///   (the engine would fail to evaluate it at runtime anyway).
fn string_body<'a>(quote: char) -> impl Parser<'a, &'a str, (), Extra<'a>> + Clone {
    custom(
        move |inp: &mut chumsky::input::InputRef<'a, '_, &'a str, Extra<'a>>| {
            let before = inp.cursor();
            let mut off = inp.span_since(&before).start;
            let open = off - quote.len_utf8();
            // Byte offset of the innermost unclosed `@{` and its brace depth.
            let mut interp: Option<usize> = None;
            let mut depth = 0u32;
            let mut prev_at = false;
            loop {
                let Some(c) = inp.peek() else {
                    return Err(Rich::custom(
                        SimpleSpan::new(open, open + quote.len_utf8()),
                        format!("unclosed string literal: missing closing quote {quote:?}"),
                    ));
                };
                inp.skip();
                if c == '\\' {
                    // Escape: the next character is taken literally.
                    off += 1;
                    if let Some(n) = inp.peek() {
                        inp.skip();
                        off += n.len_utf8();
                    }
                    prev_at = false;
                    continue;
                }
                if c == quote {
                    if let Some(at) = interp {
                        return Err(Rich::custom(
                            SimpleSpan::new(at, at + 2),
                            "unclosed '@{' interpolation: expected '}' before the closing quote",
                        ));
                    }
                    return Ok(());
                }
                match c {
                    '{' if interp.is_some() => depth += 1,
                    '{' if prev_at => {
                        interp = Some(off - 1);
                        depth = 1;
                    }
                    '}' if interp.is_some() => {
                        depth -= 1;
                        if depth == 0 {
                            interp = None;
                        }
                    }
                    _ => {}
                }
                prev_at = c == '@';
                off += c.len_utf8();
            }
        },
    )
}

/// Fails with a targeted message when a `@` is followed by `{` outside a
/// string (`Text(@{state.name})`); otherwise fails silently (no expectation).
fn interpolation_outside_string<'a>() -> impl Parser<'a, &'a str, &'a str, Extra<'a>> + Clone {
    custom(
        move |inp: &mut chumsky::input::InputRef<'a, '_, &'a str, Extra<'a>>| {
            let before = inp.cursor();
            let at = inp.span_since(&before).start;
            let found = inp.peek();
            Err(if found == Some('{') {
                Rich::custom(
                SimpleSpan::new(at - 1, at + 1),
                "'@{...}' interpolation is only allowed inside a string: write \"@{state.name}\" or the reference @state.name",
            )
            } else {
                <Rich<'a, char> as LabelError<'a, &'a str, RichPattern<'a, char>>>::expected_found(
                    [],
                    found.map(chumsky::util::MaybeRef::Val),
                    SimpleSpan::new(at, at + found.map_or(0, char::len_utf8)),
                )
            })
        },
    )
}

/// Parse a line comment: // ... until end of line
fn line_comment<'a>() -> impl Parser<'a, &'a str, (), extra::Err<Rich<'a, char>>> + Clone {
    just("//").then(none_of('\n').repeated()).ignored()
}

/// Parse a block comment: /* ... */ (supports nesting)
fn block_comment<'a>() -> impl Parser<'a, &'a str, (), Extra<'a>> + Clone {
    // The body is lexed by hand so that a comment left open reports
    // "unclosed block comment" at its `/*` instead of a generic error.
    just("/*").ignore_then(custom(
        |inp: &mut chumsky::input::InputRef<'a, '_, &'a str, Extra<'a>>| {
            let before = inp.cursor();
            let open = inp.span_since(&before).start - 2;
            let mut depth = 1usize;
            let mut prev: Option<char> = None;
            loop {
                let Some(c) = inp.next() else {
                    return Err(Rich::custom(
                        SimpleSpan::new(open, open + 2),
                        "unclosed block comment: missing '*/'",
                    ));
                };
                match (prev, c) {
                    (Some('/'), '*') => {
                        depth += 1;
                        prev = None;
                    }
                    (Some('*'), '/') => {
                        depth -= 1;
                        if depth == 0 {
                            return Ok(());
                        }
                        prev = None;
                    }
                    _ => prev = Some(c),
                }
            }
        },
    ))
}

/// Parse any comment (line or block)
fn comment<'a>() -> impl Parser<'a, &'a str, (), extra::Err<Rich<'a, char>>> + Clone {
    line_comment().or(block_comment())
}

/// Parse whitespace and comments (replaces .padded() for comment support)
fn ws<'a>() -> impl Parser<'a, &'a str, (), extra::Err<Rich<'a, char>>> + Clone {
    // Match zero or more of: (whitespace | comment)
    // This avoids generating confusing "expected '/'" errors
    choice((whitespace1(), comment())).repeated().ignored()
}

/// Extension trait to add comment-aware padding to parsers
trait PaddedWithComments<'a, O>: Parser<'a, &'a str, O, extra::Err<Rich<'a, char>>> + Sized {
    fn padded_with_comments(self) -> impl Parser<'a, &'a str, O, extra::Err<Rich<'a, char>>> + Clone
    where
        Self: Clone,
    {
        ws().ignore_then(self).then_ignore(ws())
    }
}

impl<'a, O, P> PaddedWithComments<'a, O> for P where
    P: Parser<'a, &'a str, O, extra::Err<Rich<'a, char>>>
{
}

/// Parse a Hypen value (string, number, boolean, reference, list, map)
fn value_parser<'a>() -> impl Parser<'a, &'a str, Value, extra::Err<Rich<'a, char>>> + Clone {
    recursive(|value| {
        // Double-quoted string with escape support: "hello \"world\""
        let dq_string = just('"')
            .then(string_body('"'))
            .to_slice()
            .map(|s: &str| Value::String(s.to_string()));

        // Single-quoted string: 'hello "world"'
        let sq_string = just('\'')
            .then(string_body('\''))
            .to_slice()
            .map(|s: &str| Value::String(s.to_string()));

        let string = dq_string.or(sq_string).labelled("string");

        // Boolean: true or false
        let boolean = keyword("true")
            .to(Value::Boolean(true))
            .or(keyword("false").to(Value::Boolean(false)))
            .labelled("boolean");

        // Number: 123, 123.45, -123, -123.45
        let number = just('-')
            .or_not()
            .then(int())
            .then(just('.').labelled(CONTINUE_LABEL).then(digits()).or_not())
            .to_slice()
            .try_map(|s: &str, span| {
                let n: f64 = s.parse().unwrap();
                if n.is_infinite() {
                    Err(Rich::custom(
                        span,
                        format!("number literal '{}' is too large", s),
                    ))
                } else {
                    Ok(Value::Number(n))
                }
            })
            .labelled("number");

        // Identifier that allows hyphens (for resource names like "plus-square")
        let hyphenated_ident = ident().then(just('-').then(ident()).repeated()).to_slice();

        // Reference: @state.user, @actions.login, @resources.plus-square
        let reference = just('@')
            .ignore_then(
                // The `@{` check goes first: when errors at the same position
                // merge, the first one's span is kept, and the custom message
                // should span both `@` and `{`.
                interpolation_outside_string().or(ident()
                    .labelled("reference path (e.g. state.user)")
                    .then(just('.').ignore_then(hyphenated_ident).repeated())
                    .to_slice()),
            )
            .map(|s: &str| Value::Reference(s.to_string()))
            .labelled("reference");

        // Data source references now use @ prefix like everything else.
        // e.g., @spacetime.messages, @firebase.user.name
        // They are parsed as Reference and the engine disambiguates based on
        // known prefixes (state, item, actions, resources) vs data source providers.

        // List: [item1, item2, item3]
        // The separator is padded so a trailing comma followed by
        // whitespace/newlines/comments still closes — element padding only
        // runs when an element is actually parsed, so "[1, 2,\n]" otherwise
        // left the '\n' unconsumed and failed on ']'. The closing bracket is
        // padded on its own so it is expected at the same position as an
        // element after the separator ("expected value or ']'").
        let list = value
            .clone()
            .padded_with_comments()
            .separated_by(just(',').padded_with_comments())
            .allow_trailing()
            .collect()
            .delimited_by(just('['), ws().ignore_then(just(']')))
            .map(Value::List)
            .labelled("list");

        // Map: {key1: value1, key2: value2}
        let map_entry = ident()
            .labelled("map key")
            .padded_with_comments()
            .then_ignore(just(':'))
            .then(value.clone().padded_with_comments());

        let map = map_entry
            .separated_by(just(',').padded_with_comments())
            .allow_trailing()
            .collect::<Vec<_>>()
            .delimited_by(just('{'), ws().ignore_then(just('}')))
            .map(|entries: Vec<(&str, Value)>| {
                Value::Map(
                    entries
                        .into_iter()
                        .map(|(k, v)| (k.to_string(), v))
                        .collect(),
                )
            })
            .labelled("map");

        // Bare identifier (unquoted string for simple cases)
        let identifier = ident().map(|s: &str| Value::String(s.to_string()));

        choice((string, reference, boolean, number, list, map, identifier)).labelled("value")
    })
}

/// Build an argument list from parsed `(key?, value)` pairs.
fn to_argument_list(args: Vec<(Option<String>, Value)>) -> ArgumentList {
    ArgumentList::new(
        args.into_iter()
            .enumerate()
            .map(|(i, (key, value))| match key {
                Some(k) => Argument::Named { key: k, value },
                None => Argument::Positioned { position: i, value },
            })
            .collect(),
    )
}

/// Parse a complete component with optional children
pub fn component_parser<'a>(
) -> impl Parser<'a, &'a str, ComponentSpecification, extra::Err<Rich<'a, char>>> + Clone {
    recursive(|component| {
        // Optional declaration keyword: "module" or "component". The keyword
        // token's start offset is captured (before padding, like the name
        // span) so `MetaData::expr_range` can begin at the keyword.
        let declaration_keyword = keyword("module")
            .to(DeclarationType::Module)
            .or(keyword("component").to(DeclarationType::ComponentKeyword))
            .map_with(|decl, e| {
                let span: chumsky::span::SimpleSpan = e.span();
                (decl, span.start)
            })
            .padded_with_comments()
            .or_not();

        // Component name (supports dot notation for applicators).
        // The name token's byte span is captured here (before padding) and
        // recorded as `MetaData::name_range` so downstream diagnostics can
        // point at file:line:col.
        let name = just('.')
            .or_not()
            // Only reachable after a leading '.', i.e. a folded applicator.
            .then(ident().labelled("applicator name"))
            .to_slice()
            .map_with(|s: &str, e| {
                let span: chumsky::span::SimpleSpan = e.span();
                (s.to_string(), span.into_range())
            })
            .labelled("component name")
            .padded_with_comments();

        // Parse single argument (named or positional)
        let value = value_parser();

        let arg = ident()
            .then_ignore(just(':').padded_with_comments())
            .then(value.clone())
            .map(|(key, value)| (Some(key.to_string()), value))
            .or(value.map(|value| (None, value)))
            .labelled("argument");

        // `( arg, arg, ... )`. The closing parenthesis is padded on its own
        // (rather than relying on the argument padding, which is rewound when
        // an argument fails) so that after `(` or `,` both an argument and
        // ')' are expected at the first non-blank character.
        let arg_list = arg
            .padded_with_comments()
            .separated_by(just(',').padded_with_comments())
            .allow_trailing()
            .collect::<Vec<_>>()
            .delimited_by(just('('), ws().ignore_then(just(')')))
            .map(to_argument_list);

        // Arguments are optional - either we have (...) or nothing.
        // We use and_is(just('(').not()) on the empty case so that if a '(' is
        // present, the parser must commit to parsing the argument list rather
        // than silently falling through. This ensures errors from inside
        // argument parsing (like unclosed strings) propagate correctly.
        // The closing-paren end offset is kept for `MetaData::expr_range`; it
        // is exact because the ')' delimiter carries no trailing padding.
        let args = arg_list
            .clone()
            .map_with(|args, e| {
                let span: chumsky::span::SimpleSpan = e.span();
                (args, Some(span.end))
            })
            .or(empty()
                .and_is(just('(').not())
                .to((ArgumentList::empty(), None)));

        // Applicator arguments are optional too: `.bold` == `.bold()`.
        let applicator_args = arg_list.or(empty().to(ArgumentList::empty()));

        // Children block: { child1 child2 child3 }
        // Parse explicitly to handle empty braces { }
        // The closing brace's end offset is captured before padding so
        // `MetaData::expr_range` ends at '}' rather than at whatever trailing
        // whitespace/comments the padding consumed.
        let children_block = just('{')
            .padded_with_comments()
            .ignore_then(
                component
                    .clone()
                    .padded_with_comments()
                    .repeated()
                    .collect::<Vec<_>>(),
            )
            .then(
                just('}')
                    .map_with(|_, e| {
                        let span: chumsky::span::SimpleSpan = e.span();
                        span.end
                    })
                    .padded_with_comments(),
            )
            .or_not();

        // Applicator children block: .states(...) { onState(a).size(48) }
        // Shares the recursive component parser with the component children
        // block above, so block entries are full component specifications
        // (with their own applicator chains, nesting, etc.). The leading
        // padding on '{' allows whitespace/newlines between ')' and '{'
        // exactly as for component blocks; the closing brace's end offset is
        // captured before padding so span accounting stays exact.
        let applicator_block = just('{')
            .padded_with_comments()
            .ignore_then(
                component
                    .clone()
                    .padded_with_comments()
                    .repeated()
                    .collect::<Vec<_>>(),
            )
            .then(just('}').map_with(|_, e| {
                let span: chumsky::span::SimpleSpan = e.span();
                span.end
            }));

        // Applicators: .applicator1() .applicator2(args) .applicator3(args) { children }
        // Each applicator's end offset is captured before padding (the block's
        // closing brace when present); the last one is where
        // `MetaData::expr_range` ends for an applicator chain. The chain may
        // continue after a block: .states(...) { ... }.padding(4).
        let applicators = just('.')
            .ignore_then(ident().labelled("applicator name"))
            .then(applicator_args)
            .map_with(|(name, args), e| {
                let span: chumsky::span::SimpleSpan = e.span();
                (name, args, span.end)
            })
            .then(applicator_block.or_not())
            .map(|((name, args, head_end), block)| {
                let (children, end) = match block {
                    Some((children, block_end)) => (fold_applicators(children), block_end),
                    None => (Vec::new(), head_end),
                };
                (
                    ApplicatorSpecification {
                        name: name.to_string(),
                        arguments: args,
                        children,
                        internal_id: String::new(),
                    },
                    end,
                )
            })
            .labelled("applicator (.name)")
            .padded_with_comments()
            .repeated()
            .collect::<Vec<_>>();

        declaration_keyword
            .then(name)
            .then(args)
            .then(children_block)
            .then(applicators)
            .map(
                |((((decl, (name, name_range)), (args, args_end)), children), applicators)| {
                    // Full-expression span, assembled from the pieces' unpadded
                    // end offsets (the raw combinator span would include trailing
                    // whitespace/comments consumed by padding, bleeding the range
                    // toward the next sibling's token).
                    let (children, children_end) = match children {
                        Some((children, end)) => (Some(children), Some(end)),
                        None => (None, None),
                    };
                    let expr_start = decl
                        .as_ref()
                        .map(|(_, start)| *start)
                        .unwrap_or(name_range.start);
                    let expr_end = applicators
                        .last()
                        .map(|(_, end)| *end)
                        .or(children_end)
                        .or(args_end)
                        .unwrap_or(name_range.end);
                    let decl_type = decl.map(|(decl_type, _)| decl_type);
                    let applicators: Vec<ApplicatorSpecification> =
                        applicators.into_iter().map(|(spec, _)| spec).collect();

                    // Fold applicators into the component hierarchy
                    let base_component = ComponentSpecification::new(
                        id_gen::NodeId::next().to_string(),
                        name.clone(),
                        args, // args is already an ArgumentList, not Option
                        vec![],
                        fold_applicators(children.unwrap_or_default()),
                        MetaData {
                            internal_id: String::new(),
                            name_range,
                            block_range: None,
                            expr_range: expr_start..expr_end,
                        },
                    )
                    .with_declaration_type(decl_type.unwrap_or(DeclarationType::Component));

                    // If there are applicators, add them to the component
                    if applicators.is_empty() {
                        base_component
                    } else {
                        ComponentSpecification {
                            applicators,
                            ..base_component
                        }
                    }
                },
            )
            .labelled("component")
    })
}

/// Fold applicators into component hierarchy
/// Components starting with '.' are treated as applicators of the previous component
fn fold_applicators(components: Vec<ComponentSpecification>) -> Vec<ComponentSpecification> {
    let mut result: Vec<ComponentSpecification> = Vec::new();

    for component in components {
        if component.name.starts_with('.') && !result.is_empty() {
            // This is an applicator - attach it to the previous component.
            // The owner's expression now extends through the folded
            // applicator's source text.
            let mut owner: ComponentSpecification = result.pop().unwrap();
            owner.metadata.expr_range.end = owner
                .metadata
                .expr_range
                .end
                .max(component.metadata.expr_range.end);
            owner.applicators.push(component.to_applicator());
            result.push(owner);
        } else {
            result.push(component);
        }
    }

    result
}

/// Parse an import statement
/// Syntax: import { Component1, Component2 } from "path"
///     or: import Component from "path"
pub fn import_parser<'a>(
) -> impl Parser<'a, &'a str, ImportStatement, extra::Err<Rich<'a, char>>> + Clone {
    // Parse import keyword
    let import_keyword = keyword("import")
        .labelled("'import' keyword")
        .padded_with_comments();

    // Parse a string literal for the source path (double or single quotes)
    let dq_path = just('"')
        .ignore_then(none_of('"').repeated().to_slice())
        .then_ignore(just('"').labelled("closing quote '\"'"))
        .map(|s: &str| s.to_string());
    let sq_path = just('\'')
        .ignore_then(none_of('\'').repeated().to_slice())
        .then_ignore(just('\'').labelled("closing quote \"'\""))
        .map(|s: &str| s.to_string());
    let string_literal = dq_path.or(sq_path).labelled("import path string");

    // Parse named imports: { Component1, Component2, ... }
    let named_imports = ident()
        .map(|s: &str| s.to_string())
        .labelled("component name")
        .padded_with_comments()
        .separated_by(just(','))
        .allow_trailing()
        .collect::<Vec<String>>()
        .delimited_by(
            just('{').padded_with_comments(),
            just('}').padded_with_comments(),
        )
        .map(ImportClause::Named)
        .labelled("named imports { ... }");

    // Parse default import: ComponentName
    let default_import = ident()
        .map(|s: &str| s.to_string())
        .map(ImportClause::Default)
        .labelled("default import name");

    // Import clause can be either named or default
    let import_clause = named_imports.or(default_import).padded_with_comments();

    // Parse "from" keyword
    let from_keyword = keyword("from")
        .labelled("'from' keyword")
        .padded_with_comments();

    // Parse the full import statement
    import_keyword
        .ignore_then(import_clause)
        .then_ignore(from_keyword)
        .then(string_literal.padded_with_comments())
        .map(|(clause, source_str)| {
            // Determine if source is a URL or local path
            let source = if source_str.starts_with("http://") || source_str.starts_with("https://")
            {
                ImportSource::Url(source_str)
            } else {
                ImportSource::Local(source_str)
            };
            ImportStatement::new(clause, source)
        })
        .labelled("import statement")
}

/// Parse a complete Hypen document with imports and components
pub fn document_parser<'a>(
) -> impl Parser<'a, &'a str, Document, extra::Err<Rich<'a, char>>> + Clone {
    // Parse imports (zero or more)
    let imports = import_parser()
        .padded_with_comments()
        .repeated()
        .collect::<Vec<ImportStatement>>();

    // Parse components (zero or more)
    let components = component_parser()
        .padded_with_comments()
        .repeated()
        .collect::<Vec<ComponentSpecification>>();

    // Combine imports and components into a document
    imports
        .then(components)
        .map(|(imports, components)| Document::new(imports, components))
}

/// Parse a list of components from text
pub fn parse_components(input: &str) -> Result<Vec<ComponentSpecification>, Vec<Rich<'_, char>>> {
    component_parser()
        .padded_with_comments()
        .repeated()
        .collect()
        .then_ignore(end())
        .parse(input)
        .into_result()
        .map_err(|errs| crate::diagnostic::refine_errors(input, errs))
}

/// Parse a single component from text
pub fn parse_component(input: &str) -> Result<ComponentSpecification, Vec<Rich<'_, char>>> {
    component_parser()
        .padded_with_comments()
        .then_ignore(end())
        .parse(input)
        .into_result()
        .map_err(|errs| crate::diagnostic::refine_errors(input, errs))
}

/// Parse a complete Hypen document (imports + components)
pub fn parse_document(input: &str) -> Result<Document, Vec<Rich<'_, char>>> {
    document_parser()
        .padded_with_comments()
        .then_ignore(end())
        .parse(input)
        .into_result()
        .map_err(|errs| crate::diagnostic::refine_errors(input, errs))
}

/// Parse a single import statement
pub fn parse_import(input: &str) -> Result<ImportStatement, Vec<Rich<'_, char>>> {
    import_parser()
        .padded_with_comments()
        .then_ignore(end())
        .parse(input)
        .into_result()
        .map_err(|errs| crate::diagnostic::refine_errors(input, errs))
}

// Simple sequential ID generator for AST nodes
mod id_gen {
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    pub struct NodeId(usize);

    impl NodeId {
        /// Generate the next sequential ID
        pub fn next() -> Self {
            NodeId(COUNTER.fetch_add(1, Ordering::SeqCst))
        }
    }

    impl std::fmt::Display for NodeId {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "id-{}", self.0)
        }
    }
}

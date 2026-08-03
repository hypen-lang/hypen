use chumsky::prelude::*;

use crate::ast::*;

/// Parse a line comment: // ... until end of line
fn line_comment<'a>() -> impl Parser<'a, &'a str, (), extra::Err<Rich<'a, char>>> + Clone {
    just("//").then(none_of('\n').repeated()).ignored()
}

/// Parse a block comment: /* ... */ (supports nesting)
fn block_comment<'a>() -> impl Parser<'a, &'a str, (), extra::Err<Rich<'a, char>>> + Clone {
    recursive(|nested_comment| {
        just("/*")
            .then(
                nested_comment
                    .ignored()
                    .or(any()
                        .and_is(just("*/").not())
                        .and_is(just("/*").not())
                        .ignored())
                    .repeated(),
            )
            .then(just("*/"))
            .ignored()
    })
}

/// Parse any comment (line or block)
fn comment<'a>() -> impl Parser<'a, &'a str, (), extra::Err<Rich<'a, char>>> + Clone {
    line_comment().or(block_comment())
}

/// Parse whitespace and comments (replaces .padded() for comment support)
fn ws<'a>() -> impl Parser<'a, &'a str, (), extra::Err<Rich<'a, char>>> + Clone {
    // Match zero or more of: (whitespace | comment)
    // This avoids generating confusing "expected '/'" errors
    choice((text::whitespace().at_least(1).ignored(), comment()))
        .repeated()
        .ignored()
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
        let dq_char = just('\\').ignore_then(any()).or(none_of('"'));
        let dq_string = just('"')
            .then(dq_char.repeated().collect::<Vec<_>>())
            .then(just('"').labelled("closing quote '\"'"))
            .to_slice()
            .map(|s: &str| Value::String(s.to_string()))
            .labelled("double-quoted string");

        // Single-quoted string: 'hello "world"'
        let sq_char = just('\\').ignore_then(any()).or(none_of('\''));
        let sq_string = just('\'')
            .then(sq_char.repeated().collect::<Vec<_>>())
            .then(just('\'').labelled("closing quote \"'\""))
            .to_slice()
            .map(|s: &str| Value::String(s.to_string()))
            .labelled("single-quoted string");

        let string = dq_string.or(sq_string).labelled("string literal");

        // Boolean: true or false
        let boolean = text::keyword("true")
            .to(Value::Boolean(true))
            .or(text::keyword("false").to(Value::Boolean(false)))
            .labelled("boolean (true or false)");

        // Number: 123, 123.45, -123, -123.45
        let number = just('-')
            .or_not()
            .then(text::int(10))
            .then(just('.').then(text::digits(10)).or_not())
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
        let hyphenated_ident = text::ascii::ident()
            .then(just('-').then(text::ascii::ident()).repeated())
            .to_slice();

        // Reference: @state.user, @actions.login, @resources.plus-square
        let reference = just('@')
            .ignore_then(
                text::ascii::ident()
                    .labelled("reference path (e.g., state.user)")
                    .then(just('.').ignore_then(hyphenated_ident).repeated())
                    .to_slice(),
            )
            .map(|s: &str| Value::Reference(s.to_string()))
            .labelled("reference (@state.*, @actions.*, @resources.*, @provider.*)");

        // Data source references now use @ prefix like everything else.
        // e.g., @spacetime.messages, @firebase.user.name
        // They are parsed as Reference and the engine disambiguates based on
        // known prefixes (state, item, actions, resources) vs data source providers.

        // List: [item1, item2, item3]
        let list = value
            .clone()
            .padded_with_comments()
            .separated_by(just(','))
            .allow_trailing()
            .collect()
            .delimited_by(just('['), just(']').labelled("closing bracket ']'"))
            .map(Value::List)
            .labelled("list [...]");

        // Map: {key1: value1, key2: value2}
        let map_entry = text::ascii::ident()
            .labelled("map key")
            .padded_with_comments()
            .then_ignore(just(':').labelled("':' after map key"))
            .then(value.clone().padded_with_comments().labelled("map value"));

        let map = map_entry
            .separated_by(just(','))
            .allow_trailing()
            .collect::<Vec<_>>()
            .delimited_by(just('{'), just('}').labelled("closing brace '}'"))
            .map(|entries: Vec<(&str, Value)>| {
                Value::Map(
                    entries
                        .into_iter()
                        .map(|(k, v)| (k.to_string(), v))
                        .collect(),
                )
            })
            .labelled("map {...}");

        // Bare identifier (unquoted string for simple cases)
        let identifier = text::ascii::ident()
            .map(|s: &str| Value::String(s.to_string()))
            .labelled("identifier");

        choice((string, reference, boolean, number, list, map, identifier)).labelled("value")
    })
}

/// Parse a complete component with optional children
pub fn component_parser<'a>(
) -> impl Parser<'a, &'a str, ComponentSpecification, extra::Err<Rich<'a, char>>> + Clone {
    recursive(|component| {
        // Optional declaration keyword: "module" or "component". The keyword
        // token's start offset is captured (before padding, like the name
        // span) so `MetaData::expr_range` can begin at the keyword.
        let declaration_keyword = text::keyword("module")
            .to(DeclarationType::Module)
            .or(text::keyword("component").to(DeclarationType::ComponentKeyword))
            .map_with(|decl, e| {
                let span: chumsky::span::SimpleSpan = e.span();
                (decl, span.start)
            })
            .labelled("declaration keyword (module or component)")
            .padded_with_comments()
            .or_not();

        // Component name (supports dot notation for applicators).
        // The name token's byte span is captured here (before padding) and
        // recorded as `MetaData::name_range` so downstream diagnostics can
        // point at file:line:col.
        let name = just('.')
            .or_not()
            .then(text::ascii::ident())
            .to_slice()
            .map_with(|s: &str, e| {
                let span: chumsky::span::SimpleSpan = e.span();
                (s.to_string(), span.into_range())
            })
            .labelled("component name")
            .padded_with_comments();

        // Parse single argument (named or positional)
        let value = value_parser();

        let arg = text::ascii::ident()
            .then_ignore(just(':').padded_with_comments())
            .then(value.clone())
            .map(|(key, value)| (Some(key.to_string()), value))
            .labelled("named argument (key: value)")
            .or(value
                .map(|value| (None, value))
                .labelled("positional argument"));

        // Arguments parser - only parses (arg1, arg2, ...) when present
        let args_with_parens = arg
            .clone()
            .padded_with_comments()
            .separated_by(just(',').labelled("',' between arguments"))
            .allow_trailing()
            .collect::<Vec<_>>()
            .delimited_by(
                just('(').labelled("'(' to start arguments"),
                just(')').labelled("closing parenthesis ')'"),
            )
            .map(|args| {
                let arguments = args
                    .into_iter()
                    .enumerate()
                    .map(|(i, (key, value))| match key {
                        Some(k) => Argument::Named { key: k, value },
                        None => Argument::Positioned { position: i, value },
                    })
                    .collect();
                ArgumentList::new(arguments)
            })
            .labelled("argument list (...)");

        // Arguments are optional - either we have (...) or nothing.
        // We use and_is(just('(').not()) on the empty case so that if a '(' is
        // present, the parser must commit to parsing args_with_parens rather than
        // silently falling through. This ensures errors from inside argument
        // parsing (like unclosed strings) propagate correctly.
        // The closing-paren end offset is kept for `MetaData::expr_range`; it
        // is exact because the '(' ... ')' delimiters carry no padding.
        let args = args_with_parens
            .map_with(|args, e| {
                let span: chumsky::span::SimpleSpan = e.span();
                (args, Some(span.end))
            })
            .or(empty()
                .and_is(just('(').not())
                .to((ArgumentList::empty(), None)));

        // Also keep arg_parser for applicators
        let arg_parser = arg
            .clone()
            .padded_with_comments()
            .separated_by(just(',').labelled("',' between arguments"))
            .allow_trailing()
            .collect::<Vec<_>>()
            .delimited_by(just('('), just(')').labelled("closing parenthesis ')'"))
            .map(|args| {
                let arguments = args
                    .into_iter()
                    .enumerate()
                    .map(|(i, (key, value))| match key {
                        Some(k) => Argument::Named { key: k, value },
                        None => Argument::Positioned { position: i, value },
                    })
                    .collect();
                ArgumentList::new(arguments)
            })
            .or(empty().to(ArgumentList::empty()));

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
                    .labelled("closing brace '}' for children block")
                    .map_with(|_, e| {
                        let span: chumsky::span::SimpleSpan = e.span();
                        span.end
                    })
                    .padded_with_comments(),
            )
            .labelled("children block {...}")
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
            .then(
                just('}')
                    .labelled("closing brace '}' for applicator block")
                    .map_with(|_, e| {
                        let span: chumsky::span::SimpleSpan = e.span();
                        span.end
                    }),
            )
            .labelled("applicator children block {...}");

        // Applicators: .applicator1() .applicator2(args) .applicator3(args) { children }
        // Each applicator's end offset is captured before padding (the block's
        // closing brace when present); the last one is where
        // `MetaData::expr_range` ends for an applicator chain. The chain may
        // continue after a block: .states(...) { ... }.padding(4).
        let applicators = just('.')
            .ignore_then(text::ascii::ident().labelled("applicator name"))
            .then(arg_parser.clone())
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
            .labelled("applicator (.name(...))")
            .padded_with_comments()
            .repeated()
            .collect::<Vec<_>>();

        declaration_keyword
            .then(name)
            .then(args)
            .then(children_block)
            .then(applicators)
            .map(|((((decl, (name, name_range)), (args, args_end)), children), applicators)| {
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
            })
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
    let import_keyword = text::keyword("import")
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
    let named_imports = text::ascii::ident()
        .map(|s: &str| s.to_string())
        .labelled("component name")
        .padded_with_comments()
        .separated_by(just(','))
        .allow_trailing()
        .collect::<Vec<String>>()
        .delimited_by(
            just('{').padded_with_comments(),
            just('}')
                .labelled("closing brace '}' for named imports")
                .padded_with_comments(),
        )
        .map(ImportClause::Named)
        .labelled("named imports { ... }");

    // Parse default import: ComponentName
    let default_import = text::ascii::ident()
        .map(|s: &str| s.to_string())
        .map(ImportClause::Default)
        .labelled("default import name");

    // Import clause can be either named or default
    let import_clause = named_imports.or(default_import).padded_with_comments();

    // Parse "from" keyword
    let from_keyword = text::keyword("from")
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
}

/// Parse a single component from text
pub fn parse_component(input: &str) -> Result<ComponentSpecification, Vec<Rich<'_, char>>> {
    component_parser()
        .padded_with_comments()
        .then_ignore(end())
        .parse(input)
        .into_result()
}

/// Parse a complete Hypen document (imports + components)
pub fn parse_document(input: &str) -> Result<Document, Vec<Rich<'_, char>>> {
    document_parser()
        .padded_with_comments()
        .then_ignore(end())
        .parse(input)
        .into_result()
}

/// Parse a single import statement
pub fn parse_import(input: &str) -> Result<ImportStatement, Vec<Rich<'_, char>>> {
    import_parser()
        .padded_with_comments()
        .then_ignore(end())
        .parse(input)
        .into_result()
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

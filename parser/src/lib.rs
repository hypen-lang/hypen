pub mod ast;
#[cfg(feature = "cli")]
pub mod error;
pub mod parser;
#[cfg(feature = "wasm")]
pub mod wasm;

pub use ast::{
    ApplicatorSpecification, Argument, ArgumentList, ComponentSpecification, DeclarationType,
    Document, ImportClause, ImportSource, ImportStatement, MetaData, Value,
};
#[cfg(feature = "cli")]
pub use error::{format_parse_errors, print_parse_errors};
pub use parser::{parse_component, parse_components, parse_document, parse_import};

#[cfg(test)]
mod tests;

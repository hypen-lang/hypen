//! WASM bindings for the Hypen parser
//!
//! This module provides JavaScript-callable functions for parsing Hypen documents.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

use crate::ast::{ComponentSpecification, Document};
use crate::parser::{parse_component, parse_components, parse_document};

/// Initialize panic hook for better error messages in browser console
#[wasm_bindgen(start)]
pub fn init() {
    console_error_panic_hook::set_once();
}

/// A parse error with location information.
///
/// `start`/`end` are UTF-8 **byte** offsets into the source (the same unit as
/// every AST span). `line` and `column` are the 0-based LSP position of
/// `start`, with `column` in UTF-16 code units (JavaScript string indices),
/// so non-ASCII text before the error does not shift it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseError {
    pub message: String,
    pub start: usize,
    pub end: usize,
    pub line: usize,
    pub column: usize,
}

/// Result of parsing a document
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseResult {
    pub success: bool,
    pub document: Option<Document>,
    pub components: Option<Vec<ComponentSpecification>>,
    pub errors: Vec<ParseError>,
}

/// Convert parser errors (byte spans) into serializable [`ParseError`]s.
fn to_parse_errors(source: &str, errors: &[chumsky::error::Rich<'_, char>]) -> Vec<ParseError> {
    errors
        .iter()
        .map(|e| {
            let span = e.span();
            let (line, column) = crate::diagnostic::lsp_position(source, span.start);
            ParseError {
                message: crate::diagnostic::describe_error(e),
                start: span.start,
                end: span.end,
                line,
                column,
            }
        })
        .collect()
}

/// Parse a Hypen document and return JSON result
#[wasm_bindgen]
pub fn parse_document_wasm(source: &str) -> JsValue {
    let result = match parse_document(source) {
        Ok(doc) => ParseResult {
            success: true,
            document: Some(doc),
            components: None,
            errors: vec![],
        },
        Err(errors) => {
            let parse_errors = to_parse_errors(source, &errors);
            ParseResult {
                success: false,
                document: None,
                components: None,
                errors: parse_errors,
            }
        }
    };

    serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
}

/// Parse multiple components and return JSON result
#[wasm_bindgen]
pub fn parse_components_wasm(source: &str) -> JsValue {
    let result = match parse_components(source) {
        Ok(components) => ParseResult {
            success: true,
            document: None,
            components: Some(components),
            errors: vec![],
        },
        Err(errors) => {
            let parse_errors = to_parse_errors(source, &errors);
            ParseResult {
                success: false,
                document: None,
                components: None,
                errors: parse_errors,
            }
        }
    };

    serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
}

/// Parse a single component and return JSON result
#[wasm_bindgen]
pub fn parse_component_wasm(source: &str) -> JsValue {
    let result = match parse_component(source) {
        Ok(component) => ParseResult {
            success: true,
            document: None,
            components: Some(vec![component]),
            errors: vec![],
        },
        Err(errors) => {
            let parse_errors = to_parse_errors(source, &errors);
            ParseResult {
                success: false,
                document: None,
                components: None,
                errors: parse_errors,
            }
        }
    };

    serde_wasm_bindgen::to_value(&result).unwrap_or(JsValue::NULL)
}

/// Get version info
#[wasm_bindgen]
pub fn parser_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

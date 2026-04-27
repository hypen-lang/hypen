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

/// A parse error with location information
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

/// Convert byte offset to line and column
fn offset_to_line_col(source: &str, offset: usize) -> (usize, usize) {
    let mut line = 0;
    let mut col = 0;
    for (i, c) in source.chars().enumerate() {
        if i >= offset {
            break;
        }
        if c == '\n' {
            line += 1;
            col = 0;
        } else {
            col += 1;
        }
    }
    (line, col)
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
            let parse_errors: Vec<ParseError> = errors
                .iter()
                .map(|e| {
                    let span = e.span();
                    let (line, column) = offset_to_line_col(source, span.start);
                    ParseError {
                        message: format!("{}", e),
                        start: span.start,
                        end: span.end,
                        line,
                        column,
                    }
                })
                .collect();
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
            let parse_errors: Vec<ParseError> = errors
                .iter()
                .map(|e| {
                    let span = e.span();
                    let (line, column) = offset_to_line_col(source, span.start);
                    ParseError {
                        message: format!("{}", e),
                        start: span.start,
                        end: span.end,
                        line,
                        column,
                    }
                })
                .collect();
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
            let parse_errors: Vec<ParseError> = errors
                .iter()
                .map(|e| {
                    let span = e.span();
                    let (line, column) = offset_to_line_col(source, span.start);
                    ParseError {
                        message: format!("{}", e),
                        start: span.start,
                        end: span.end,
                        line,
                        column,
                    }
                })
                .collect();
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

//! Minimal Tailwind CSS class parser for Hypen
//!
//! Parses Tailwind utility classes into structured CSS properties.
//! Handles variants (responsive, state, dark mode) by separating them out.
//!
//! # Example
//! ```
//! use hypen_tailwind_parse::{parse_classes, TailwindOutput};
//!
//! let output = parse_classes("p-4 md:p-8 text-blue-500 hover:bg-white");
//! // Returns structured props with variants separated
//! ```

mod backgrounds;
mod borders;
mod colors;
mod effects;
mod interactivity;
mod layout;
mod misc;
mod parser;
mod sizing;
mod spacing;
mod tables;
mod transforms;
mod typography;

pub use parser::{parse_class, parse_classes, CssProperty, TailwindOutput, Variant};

/// Re-export for convenience
pub use colors::COLORS;

# CLAUDE.md

This file provides guidance to Claude Code when working with hypen-tailwind-parse.

## Project Overview

`hypen-tailwind-parse` is a minimal Tailwind CSS class parser for Hypen. It converts Tailwind utility classes (e.g., `p-4 text-blue-500 rounded-xl`) into style property maps that the engine can apply.

## Module Structure

```
tailwind-parse/src/
├── lib.rs            # Public API — parse_classes() entry point
├── parser.rs         # Core tokenizer and class parser
├── colors.rs         # Tailwind color palette mappings
├── spacing.rs        # p-*, m-*, gap-* utilities
├── sizing.rs         # w-*, h-*, min-*, max-* utilities
├── typography.rs     # text-*, font-*, leading-* utilities
├── borders.rs        # border-*, rounded-* utilities
├── backgrounds.rs    # bg-* utilities
├── layout.rs         # flex, grid, display utilities (no positioning — see below)
├── transforms.rs     # rotate, scale, translate utilities
├── tables.rs         # Table-related utilities
├── effects.rs        # opacity, shadow, blur utilities
├── interactivity.rs  # cursor, select, scroll utilities
└── misc.rs           # Remaining utility classes
```

## Development Commands

```bash
cargo test              # Run all tests
cargo build             # Build
cargo clippy            # Lint
```

## Usage

Called by the engine when processing `.tw("...")` applicators in Hypen DSL:
```hypen
Text("Hello").tw("p-4 text-blue-500 rounded-xl bg-white")
```

The parser maps each class to CSS properties that get merged into the element's style.

## Hard errors

`parse_classes` returns `Result<TailwindOutput, TailwindError>`. Unknown classes are
dropped silently, but CSS positioning is rejected outright — Hypen has no positioning
model on native renderers: `static`/`fixed`/`absolute`/`relative`/`sticky`, the inset
utilities (`top-*`, `right-*`, `bottom-*`, `left-*`, `inset-*`, `start-*`, `end-*`) and
`sr-only`. The check lives in `parser::forbidden_utility_reason`; the engine turns the
error into an `__Error` element and the LSP (`hypen-lsp/src/tailwind.ts`) mirrors the
rule as a squiggle. Keep both in sync.

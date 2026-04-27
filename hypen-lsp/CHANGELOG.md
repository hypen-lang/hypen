# Changelog

All notable changes to the Hypen LSP extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2025-10-09

### Added
- Initial release of Hypen LSP
- Syntax highlighting for `.hypen` files
- Real-time error detection and diagnostics
- Auto-completion for components, applicators, and references
- Hover information for components and applicators
- Document symbols for outline view
- Document formatting with auto-indentation
- Support for module and component declarations
- Warning for lowercase component names
- Configuration options for diagnostics and formatting
- TextMate grammar for syntax highlighting
- Language configuration for brackets and auto-closing

### Parser Features
- Detection of unclosed braces, parentheses, and strings
- Component name recognition
- Applicator parsing
- Reference detection (@state, @actions)
- Balance checking for brackets

### IDE Features
- 12+ common component completions (Column, Row, Text, etc.)
- 20+ applicator completions (padding, color, fontSize, etc.)
- Context-aware completions (components, applicators, references)
- Snippet-based completions with placeholders
- Symbol navigation in outline view
- Format document command

### Documentation
- Comprehensive README with examples
- CLAUDE.md for AI agent guidelines
- Development and contribution guidelines
- Architecture documentation

## [Unreleased]

### Planned
- Integration with Rust WASM parser
- Go-to-definition support
- Find all references
- Rename symbol
- Code actions (quick fixes)
- Semantic highlighting
- Workspace symbols
- Better error recovery
- Multi-line formatting improvements



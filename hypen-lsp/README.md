# Hypen Language Server Protocol (LSP)

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![VS Code](https://img.shields.io/badge/VS%20Code-Extension-007ACC?logo=visualstudiocode)](https://code.visualstudio.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

A Language Server Protocol implementation for the [Hypen](https://github.com/hypen) declarative UI language, providing rich IDE support in VSCode, Cursor, and other LSP-compatible editors.

## Features

- **Syntax Highlighting** - Beautiful color themes for Hypen syntax
- **Error Detection** - Real-time syntax error detection and reporting
- **Auto-completion** - Intelligent code completion for:
  - Component names (Column, Row, Text, Button, etc.)
  - Applicators (.padding, .color, .fontSize, etc.)
  - References (@state, @actions)
- **Hover Information** - View component and applicator documentation on hover
- **Document Symbols** - Navigate component hierarchy in the outline view
- **Code Formatting** - Auto-format your Hypen files with proper indentation
- **Diagnostics** - Warnings for common mistakes (e.g., lowercase component names)

## Installation

### From VSIX (Recommended)

1. Download the latest `.vsix` file from releases
2. In VSCode/Cursor: Extensions → Install from VSIX
3. Select the downloaded file
4. Reload the window

### From Source

```bash
cd hypen-lsp
npm install
npm run compile
```

Then press F5 in VSCode to launch the extension in development mode.

### Building VSIX Package

```bash
npm install -g @vscode/vsce
npm run package
```

This creates a `.vsix` file you can install or distribute.

## Usage

Once installed, the extension automatically activates for `.hypen` files. Simply open or create a file with the `.hypen` extension and start coding!

### Example

```hypen
Column {
  Text("Hello, Hypen!")
    .fontSize(24)
    .color("blue")
    .padding(16)
    
  Button {
    Text("Click Me")
  }
    .onClick("@actions.handleClick")
    .backgroundColor("#667eea")
    .borderRadius(8)
}
```

### Features in Action

#### Auto-completion
- Type `Col` and press `Ctrl+Space` to see component suggestions
- Type `.` after a component to see applicator suggestions
- Type `@` to see state and action references

#### Error Detection
- Unclosed braces, parentheses, or strings are highlighted in red
- Invalid syntax is underlined with helpful error messages

#### Hover Information
- Hover over component names to see documentation
- Hover over applicators to see what they do

#### Formatting
- Right-click → Format Document (or `Shift+Alt+F`)
- Auto-indents nested components

## Configuration

Configure the extension in your VSCode settings:

```json
{
  "hypen.trace.server": "off",           // Debug LSP communication
  "hypen.maxNumberOfProblems": 100,      // Max diagnostics to show
  "hypen.formatting.enable": true        // Enable/disable formatting
}
```

## Language Features

### Components

Hypen supports three types of component declarations:

```hypen
// Regular component (stateless)
Text("Hello")

// Module declaration (stateful)
module ProfilePage(userId: 123) {
  Text("@state.userName")
}

// Component keyword (explicit stateless)
component Button(text: "Click") {
  Text(@state.text)
}
```

### Applicators

Style components using dot notation:

```hypen
Text("Styled")
  .fontSize(18)
  .color("blue")
  .padding(16)
  .backgroundColor("white")
  .borderRadius(8)
```

### Common Applicators

**Layout:**
- `padding`, `margin`, `width`, `height`
- `maxWidth`, `maxHeight`, `minWidth`, `minHeight`
- `verticalAlignment`, `horizontalAlignment`, `flexDirection`

**Typography:**
- `fontSize`, `fontWeight`, `fontStyle`
- `color`, `lineHeight`, `textAlign`

**Visual:**
- `backgroundColor`, `border`, `borderRadius`
- `boxShadow`, `opacity`

**Interactive:**
- `onClick`, `onHover`, `cursor`

### References

Reference state and actions using the `@` symbol:

```hypen
Text("@{state.username}")
  .onClick("@actions.handleClick")
```

## Architecture

The LSP consists of three main components:

1. **Language Server** (`src/server.ts`) - Core LSP implementation
2. **Extension Client** (`src/extension.ts`) - VSCode integration
3. **Parser** (`src/parser.ts`) - Hypen syntax parser

### Parser Integration

The current implementation uses a TypeScript-based parser for quick validation. For production use, it can be integrated with the Rust WASM parser from `hypen-rs/parser` for full-fidelity parsing:

```typescript
// Future integration (commented in parser.ts)
import * as wasmParser from "../../parser/pkg";
const result = wasmParser.parse_document(text);
```

## Development

### Project Structure

```
hypen-lsp/
├── src/
│   ├── server.ts              # LSP server implementation
│   ├── extension.ts           # VSCode extension client
│   └── parser.ts              # Hypen parser module
├── syntaxes/
│   └── hypen.tmLanguage.json  # TextMate grammar
├── package.json               # Extension manifest
├── tsconfig.json              # TypeScript config
└── README.md                  # This file
```

### Running Tests

```bash
npm test
```

### Debugging

1. Open the project in VSCode
2. Press `F5` to launch Extension Development Host
3. Open a `.hypen` file in the new window
4. Set breakpoints in `src/server.ts` or `src/extension.ts`

### Watch Mode

For continuous compilation during development:

```bash
npm run watch
```

## Contributing

Contributions welcome! Please follow these guidelines:

1. Follow the existing code style (2-space indentation, TypeScript strict mode)
2. Add tests for new features
3. Update documentation
4. Use conventional commits (`feat:`, `fix:`, `docs:`, etc.)

### Adding New Features

**To add a new component:**
1. Add to `commonComponents` array in `server.ts`

**To add a new applicator:**
1. Add to `commonApplicators` array in `server.ts`

**To enhance parsing:**
1. Update `parser.ts` or integrate with Rust WASM parser

## Roadmap

- [ ] Integration with Rust WASM parser for full parsing
- [ ] Go to definition for component references
- [ ] Find all references
- [ ] Rename symbol
- [ ] Code actions (quick fixes)
- [ ] Semantic highlighting
- [ ] Workspace symbols
- [ ] Call hierarchy
- [ ] Inline hints

## Requirements

- VSCode 1.75.0 or higher
- Node.js 16+ (for development)

## Known Issues

- Currently uses a simple regex-based parser; full Rust parser integration pending
- String interpolation inside `@{}` has limited support
- Multi-line component arguments may not be perfectly formatted

## License

Same as the parent Hypen project.

## Links

- [Hypen Repository](https://github.com/hypen)
- [VSCode LSP Guide](https://code.visualstudio.com/api/language-extensions/language-server-extension-guide)
- [Language Server Protocol](https://microsoft.github.io/language-server-protocol/)

## Support

For issues, questions, or feature requests, please open an issue in the Hypen monorepo.



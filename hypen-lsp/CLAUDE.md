# Hypen LSP - AI Agent Guidelines

## Project Overview

This is a Language Server Protocol (LSP) implementation for the Hypen declarative UI language. The LSP provides IDE support for Hypen in VSCode, Cursor, and other LSP-compatible editors.

## Architecture

### Core Components

1. **Language Server** (`src/server.ts`)
   - Implements the LSP protocol
   - Handles document validation, completions, hover, symbols, and formatting
   - Uses the parser module for syntax analysis

2. **Extension Client** (`src/extension.ts`)
   - VSCode extension entry point
   - Manages the language server lifecycle
   - Connects VSCode to the language server

3. **Parser Module** (`src/parser.ts`)
   - Provides Hypen syntax parsing
   - Currently uses regex-based parsing (lightweight)
   - Can be extended to use Rust WASM parser from `../parser/` for full-fidelity

4. **TextMate Grammar** (`syntaxes/hypen.tmLanguage.json`)
   - Defines syntax highlighting rules
   - Tokenizes Hypen code for colorization

## Development Workflow

### Setup
```bash
npm install      # Install dependencies
npm run compile  # Compile TypeScript to JavaScript
```

### Development
```bash
npm run watch    # Watch mode for continuous compilation
```

Press `F5` in VSCode to launch the extension in a new Extension Development Host window.

### Testing
```bash
npm test         # Run tests
```

### Packaging
```bash
npm run package  # Creates .vsix file for distribution
```

## Language Features

### Supported LSP Features

1. **Diagnostics** - Real-time error detection
   - Syntax errors (unclosed braces, strings, parentheses)
   - Invalid component names (lowercase warnings)
   - Balance checking for brackets

2. **Completion** - Context-aware suggestions
   - Components: `Column`, `Row`, `Text`, `Button`, etc.
   - Applicators: `.padding()`, `.color()`, `.fontSize()`, etc.
   - References: `@state`, `@actions`

3. **Hover** - Documentation on hover
   - Component descriptions
   - Applicator explanations

4. **Document Symbols** - Outline view
   - Lists all components in the document
   - Enables quick navigation

5. **Formatting** - Auto-format documents
   - Proper indentation based on nesting
   - Consistent spacing

### Hypen Syntax Supported

- **Components**: `Text("Hello")`, `Column { ... }`
- **Module declarations**: `module MyModule { ... }`
- **Component declarations**: `component MyComponent { ... }`
- **Applicators**: `.padding(16)`, `.color("blue")`
- **Arguments**: Positional and named (`Text("Hi")`, `Text(content: "Hi")`)
- **References**: `@state.value`, `@actions.onClick`
- **Value types**: strings, numbers, booleans, lists, maps

## Coding Guidelines

### TypeScript Style
- Use strict mode
- Prefer interfaces over types for object shapes
- Use explicit return types for public functions
- Keep functions focused and single-purpose

### LSP Patterns
- Validate documents asynchronously
- Cache settings per document URI
- Provide incremental text document sync
- Return empty arrays instead of null for optional results

### Parser Design
- Keep the parser pure (no side effects)
- Return structured errors with ranges
- Include both errors and warnings
- Make parsing incremental-friendly

## Extension Points

### Adding New Components
Add to `commonComponents` array in `server.ts`:
```typescript
const commonComponents = [
  "Column", "Row", "Text", "Button", "NewComponent"
];
```

### Adding New Applicators
Add to `commonApplicators` array in `server.ts`:
```typescript
const commonApplicators = [
  "padding", "margin", "newApplicator"
];
```

### Enhancing Parser
Update `src/parser.ts`:
- Add new syntax patterns
- Improve error detection
- Extract more semantic information

### Integrating Rust WASM Parser
Uncomment the stub in `parser.ts` and:
1. Build the Rust parser to WASM: `cd ../parser && cargo build --target wasm32-unknown-unknown`
2. Import the WASM module
3. Convert Rust AST to TypeScript interfaces

## Configuration

### Extension Settings
Defined in `package.json` under `contributes.configuration`:
- `hypen.trace.server` - Debug LSP communication
- `hypen.maxNumberOfProblems` - Limit diagnostics
- `hypen.formatting.enable` - Toggle formatting

### Language Configuration
Defined in `language-configuration.json`:
- Comment syntax
- Bracket pairs
- Auto-closing pairs
- Indentation rules

## Testing Strategy

### Manual Testing
1. Open a `.hypen` file
2. Verify syntax highlighting
3. Test completions (Ctrl+Space)
4. Verify error detection (introduce syntax error)
5. Test formatting (Shift+Alt+F)
6. Check hover information

### Automated Testing
Add tests in `src/test/`:
- Parser unit tests
- LSP feature integration tests
- Extension activation tests

## Common Tasks

### Debugging
1. Set breakpoints in `src/server.ts` or `src/extension.ts`
2. Press F5 to launch Extension Development Host
3. Breakpoints will hit when the feature is triggered

### Adding Snippets
Update `package.json` `contributes.snippets`:
```json
"contributes": {
  "snippets": [
    {
      "language": "hypen",
      "path": "./snippets/hypen.json"
    }
  ]
}
```

### Improving Syntax Highlighting
Edit `syntaxes/hypen.tmLanguage.json`:
- Add new patterns
- Define capture groups
- Assign scopes for colorization

## Future Enhancements

### High Priority
- [ ] Integrate Rust WASM parser for full parsing
- [ ] Add code actions (quick fixes)
- [ ] Implement go-to-definition

### Medium Priority
- [ ] Find all references
- [ ] Rename symbol
- [ ] Semantic tokens (better highlighting)
- [ ] Workspace symbols

### Nice to Have
- [ ] Call hierarchy
- [ ] Type hierarchy
- [ ] Inline hints
- [ ] Code lens

## Troubleshooting

### Extension doesn't activate
- Check `.hypen` file association in VSCode
- Verify `activationEvents` in `package.json`

### Completions not working
- Check console for errors (Help → Toggle Developer Tools)
- Verify `triggerCharacters` in server initialization

### Syntax highlighting broken
- Validate JSON syntax in `hypen.tmLanguage.json`
- Check scope names match VSCode theme

### Parser errors
- Test parser independently: `npm test`
- Add debug logging in `parser.ts`

## Resources

- [LSP Specification](https://microsoft.github.io/language-server-protocol/)
- [VSCode Extension API](https://code.visualstudio.com/api)
- [TextMate Grammars](https://macromates.com/manual/en/language_grammars)
- [Hypen Parser](../parser/README.md)

## Conventions

### Commits
Follow conventional commits:
- `feat(lsp): add go-to-definition`
- `fix(parser): handle nested braces correctly`
- `docs(readme): update installation steps`
- `chore(deps): update vscode-languageserver`

### Pull Requests
- Include description of changes
- Add screenshots/GIFs for visual changes
- Test in both VSCode and Cursor
- Update README if user-facing changes

## Notes for AI Agents

When working on this codebase:
1. Maintain LSP protocol compliance
2. Keep parser pure and testable
3. Prefer incremental improvements over rewrites
4. Document new features in README
5. Add tests for new functionality
6. Follow TypeScript strict mode
7. Keep extension lightweight (fast activation)



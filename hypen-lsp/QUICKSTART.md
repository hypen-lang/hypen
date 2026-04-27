# Hypen LSP - Quick Start Guide

Get the Hypen Language Server up and running in minutes!

## For Users

### Installation

1. **Download the Extension** (when published to VSCode Marketplace)
   ```
   Search "Hypen" in VSCode Extensions
   Click "Install"
   ```

2. **Or Install from VSIX**
   ```bash
   # Download the .vsix file, then:
   code --install-extension hypen-lsp-0.1.0.vsix
   ```

3. **Start Using**
   - Create a new file with `.hypen` extension
   - Start typing and enjoy auto-completion, error detection, and more!

### Try It Out

Open one of the example files:
- `examples/simple.hypen` - Basic component example
- `examples/module.hypen` - Stateful module with actions
- `examples/complex.hypen` - Full app structure

### Features to Try

1. **Auto-completion**: Type `Col` and press `Ctrl+Space`
2. **Applicators**: Type `.` after a component name
3. **Error Detection**: Remove a closing `}` and see the error
4. **Formatting**: Press `Shift+Alt+F` to format the document
5. **Hover Info**: Hover over component names
6. **Outline View**: Open the outline panel to see document structure

## For Developers

### Setup

```bash
# Clone the repo (if not already)
cd hypen-lsp

# Install dependencies
npm install

# Compile TypeScript
npm run compile
```

### Development

```bash
# Watch mode (auto-compile on save)
npm run watch
```

Then press `F5` in VSCode to launch the Extension Development Host.

### Testing

```bash
# Run tests
npm test

# Run linter
npm run lint
```

### Building

```bash
# Create VSIX package for distribution
npm run package

# This creates: hypen-lsp-0.1.0.vsix
```

### Project Structure

```
hypen-lsp/
├── src/
│   ├── server.ts          # Language server implementation
│   ├── extension.ts       # VSCode extension client
│   └── parser.ts          # Hypen parser
├── syntaxes/
│   └── hypen.tmLanguage.json  # Syntax highlighting
├── examples/              # Example .hypen files
├── package.json           # Extension manifest
└── README.md             # Full documentation
```

## Debugging

### Debug the Language Server

1. Open VSCode in the `hypen-lsp` folder
2. Press `F5` to launch Extension Development Host
3. Set breakpoints in `src/server.ts`
4. Open a `.hypen` file in the Extension Development Host
5. Breakpoints will hit when LSP features are triggered

### Debug the Extension Client

1. Same as above, but set breakpoints in `src/extension.ts`
2. Breakpoints hit during extension activation

### View LSP Communication

Add to your VSCode settings:
```json
{
  "hypen.trace.server": "verbose"
}
```

Then check the "Hypen Language Server" output panel.

## Common Issues

### Extension Not Activating
- Ensure file has `.hypen` extension
- Check Output panel for errors (View → Output → Hypen Language Server)

### Completions Not Working
- Try `Ctrl+Space` to manually trigger
- Check that you're not inside a string literal

### Syntax Highlighting Missing
- Reload VSCode window (Cmd+Shift+P → "Reload Window")
- Verify language is "Hypen" in bottom-right corner

## Next Steps

- Read the full [README.md](./README.md) for detailed documentation
- Check [CLAUDE.md](./CLAUDE.md) for development guidelines
- See [CHANGELOG.md](./CHANGELOG.md) for release notes
- Explore the `examples/` directory for Hypen syntax examples

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests
5. Submit a pull request

Follow conventional commits: `feat:`, `fix:`, `docs:`, `chore:`, etc.

## Support

For issues, questions, or feature requests:
- Open an issue in the Hypen monorepo
- Check existing issues for solutions
- Contribute fixes via pull requests

## Quick Commands

```bash
npm install           # Install dependencies
npm run compile       # Compile TypeScript
npm run watch         # Watch mode
npm test             # Run tests
npm run lint         # Run linter
npm run package      # Build VSIX

# In VSCode
F5                   # Launch extension development
Ctrl+Shift+P         # Command palette
Shift+Alt+F          # Format document
Ctrl+Space           # Trigger completion
```

Happy coding with Hypen! 🚀



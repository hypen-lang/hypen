# CLAUDE.md

This file provides guidance to Claude Code when working with the component gallery server.

## Project Overview

The component gallery server is a comprehensive showcase and testing tool for all Hypen components and applicators. It serves each component/applicator on a dedicated port via WebSocket, making it easy for native renderers (Android, iOS) to test individual components.

## Development Commands

```bash
bun run server.ts             # Start the gallery server
bun run test-all-components.ts  # Run all component tests
```

## Architecture

The server assigns each component and applicator its own port (starting at 4000). Native renderer apps connect to a specific port to render and test a single component in isolation.

### Key Files

- `server.ts` — main server, port-based routing
- `components.json` — component catalog with port assignments
- `applicators.json` — applicator catalog with port assignments
- `components/` — per-component example modules
- `applicators/` — per-applicator example modules
- `COMPONENTS.md` — documentation of all supported components
- `screenshot-tests/` — visual regression testing

### Adding a New Component Example

1. Add entry to `components.json` with name and port
2. Create component module in `components/` directory
3. The server auto-discovers and serves it on the assigned port
4. Test with native renderer apps or web preview

## Integration

Used by:
- `hypen-renderer-android` app — connects to gallery ports for component testing
- `hypen-renderer-swift` Gallery app — same approach for iOS
- `screenshot-tests/` — automated visual comparison across platforms

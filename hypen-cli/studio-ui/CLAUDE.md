# CLAUDE.md

This file provides guidance to Claude Code when working with Hypen Studio UI.

## Project Overview

Studio UI is the React-based local IDE for Hypen, launched via `hypen studio`. It provides a file browser, code editor, live preview, state inspector, and integrated terminal.

## Directory Structure

```
studio-ui/
├── src/
│   ├── index.tsx              # Bun.serve() app entry
│   ├── index.html             # HTML template
│   ├── frontend.tsx           # React mount point
│   ├── App.tsx                # Root component
│   ├── components/
│   │   ├── studio/            # Main IDE components
│   │   │   ├── Studio.tsx     # Layout & state management
│   │   │   ├── FileTree.tsx   # Project file browser
│   │   │   ├── EditorTabs.tsx # Multi-file editor tabs
│   │   │   ├── Preview.tsx    # Live Hypen component preview
│   │   │   ├── BottomPanel.tsx # State/actions/console panel
│   │   │   ├── TerminalPanel.tsx # xterm.js terminal
│   │   │   ├── Toolbar.tsx    # Top action bar
│   │   │   ├── CommandPalette.tsx # Cmd+K search
│   │   │   └── ResizeHandle.tsx # Draggable panel dividers
│   │   └── ui/                # Shadcn-style primitives
│   ├── lib/
│   │   ├── lsp-client.ts      # LSP client (WebSocket)
│   │   └── utils.ts           # Utilities (cn helper)
│   └── index.css              # Global styles
├── build.ts                   # Custom Bun build script
├── package.json
└── tsconfig.json
```

## Development Commands

```bash
bun install                       # Install dependencies
bun src/index.tsx                 # Run dev server directly
bun run build                     # Production build
bun test                          # Run tests
```

## Architecture

Studio UI is spawned as a child process by `hypen studio` (see `../src/studio/server.ts`). It receives project info via environment variables:

| Env Var | Purpose |
|---------|---------|
| `HYPEN_PROJECT_DIR` | Root of user's Hypen project |
| `HYPEN_COMPONENTS_DIR` | Component discovery path |
| `HYPEN_ENTRY` | Entry component name |
| `PORT` | Server port (default 5173) |
| `HYPEN_LSP_SERVER` | Path to LSP server binary |
| `HYPEN_REMOTE_URL` | WebSocket URL for native clients |

### Key Dependencies
- React 19, react-dom
- @radix-ui (accessible primitives)
- @xterm/xterm (terminal emulation)
- lucide-react (icons)
- Tailwind CSS v4

### Tooling
- Use `bun` for everything — runtime, tests, builds, package management
- Path alias: `@/*` → `./src/*`
- Bun auto-loads `.env` files

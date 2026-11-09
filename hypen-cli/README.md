# @hypen-space/cli

[![TypeScript](https://img.shields.io/badge/TypeScript-5.0+-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Bun](https://img.shields.io/badge/Bun-1.0+-f9f1e1?logo=bun)](https://bun.sh/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](../LICENSE)

Command-line interface for creating and managing Hypen applications.

## Installation

```bash
bun add -g @hypen-space/cli
```

Or use directly with bunx:

```bash
bunx @hypen-space/cli init my-app
```

## Commands

Run `hypen --help` for the overview and `hypen <command> --help` for a command's own flags. Inside a project, a global `hypen` hands off to the project's own `node_modules/@hypen-space/cli` (set `HYPEN_NO_LOCAL_CLI=1` to turn that off). The full reference is in the docs: [CLI](https://hypen.space/docs/tooling/cli).

| Command | What it does |
|---------|--------------|
| `hypen init [name]` | Scaffold a TypeScript, Go or Kotlin starter (file- or server-based) into a new or empty directory and install dependencies |
| `hypen dev` | Dev server: web client at `http://localhost:3000` plus a `ws://` endpoint for native runners, with hot reload |
| `hypen build` | Static production site in `dist/` (`node dist/server.js` serves it) |
| `hypen generate` | Write `.hypen/components.generated.ts` (imports for every discovered component) |
| `hypen check [path...]` | Accessibility checks over `.hypen` files (alias `hypen a11y`; exit 0 clean, 1 findings, 2 couldn't check) |
| `hypen studio` | Hypen Studio, the in-browser IDE |
| `hypen test` | Studio Test Mode: live DOM/Canvas previews and device mirrors |
| `hypen run <android\|ios\|desktop>` | Launch the app in the native runner on a device, simulator or desktop |

Common options:

- `dev`: `-p, --port <port>`, `-d, --debug`, `--a11y`
- `build`: `-o, --outDir <dir>`, `-m, --minify` / `--no-minify`, `-s, --sourcemap`
- `studio`: `-p, --port <port>` (Studio, default 5173), `--no-open`, `--session <id>`
- `test`: `-p, --port <port>` (preview server), `--studio-port <port>` (Studio, default 5173), `--no-open`
- `run`: `-p, --port`, `--url <ws://...>`, `--clean`, `--studio`, `--studio-port`, `--device <id>`, `--runner <path>`

In `hypen dev`, `hypen test` and `hypen run`, a `.hypen` file that doesn't parse is reported as `file:line:col` and connected clients keep the last good version until it is fixed; `hypen build` fails on it.

### Hypen Studio

`hypen studio` opens a local IDE with a file explorer, Monaco editor (with the Hypen language server), live preview, state inspector, action log, timeline and terminal. Edits are auto-saved and hot-reloaded. It requires the [Bun](https://bun.sh) runtime.

```bash
hypen studio --port 5180 --no-open
hypen test --studio-port 5180
```

## Project Structure

After running `hypen init`, your project will have this structure:

```
my-app/
├── hypen.json              # Hypen configuration
├── package.json
├── tsconfig.json
└── src/
    └── components/
        └── App/
            ├── component.ts    # Component logic/state
            └── component.hypen # Component UI
```

### hypen.json

Configuration file for your Hypen project:

```json
{
  "components": "./src/components",
  "entry": "App",
  "port": 3000,
  "outDir": "dist"
}
```

### Component Structure

Each component lives in its own directory with two files:

**component.ts** - State and logic:
```typescript
import { app } from "@hypen-space/core";

type AppState = {
  count: number;
};

export default app
  .defineState<AppState>({ count: 0 })
  .onAction("increment", ({ state }) => {
    state.count++;
  })
  .onAction("decrement", ({ state }) => {
    state.count--;
  })
  .build();
```

**component.hypen** - UI declaration:
```hypen
module App {
  Column {
    Text("Count: @{state.count}")

    Row {
      Button {
        Text("-")
      }
      .onClick("@actions.decrement")

      Button {
        Text("+")
      }
      .onClick("@actions.increment")
    }
  }
}
```

## Development

```bash
# Install dependencies
bun install

# Run CLI locally
bun bin/hypen.ts init test-project
bun bin/hypen.ts dev --port 3001
```

## License

MIT

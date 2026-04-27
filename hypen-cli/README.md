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

### `hypen init [name]`

Create a new Hypen project.

```bash
# With project name
hypen init my-app
```

### `hypen dev`

Start the development server with hot reload.

```bash
hypen dev
```

This will:
- Discover all components in `src/components/`
- Generate `components.generated.ts`
- Start a server at `http://localhost:3000`
- Watch for file changes and hot reload

Options:
- `--port <number>` - Server port (default: 3000)
- `--debug` - Enable debug logging

### `hypen build`

Build for production.

```bash
hypen build
```

Options:
- `--outDir <path>` - Output directory (default: dist)
- `--minify` - Enable minification
- `--sourcemap` - Generate source maps

### `hypen generate`

Generate component imports from discovered components.

```bash
hypen generate
```

### `hypen studio`

Open the Hypen Studio IDE — a local development environment with file browser, code editor, live preview, state inspector, and time-travel debugging.

> **Note:** Requires the [Bun](https://bun.sh) runtime.

```bash
hypen studio
```

Options:
- `--port <number>` - Studio server port (default: 5173)
- `--open` - Open browser automatically (default: true)
- `--session <id>` - Load a teleported session from hypen.space

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

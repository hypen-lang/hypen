# @hypen-space/web-engine

Browser engine for Hypen - WASM engine wrapper and orchestrator for building browser SPAs with Hypen's declarative UI.

## Installation

```bash
npm install @hypen-space/core @hypen-space/web @hypen-space/web-engine
# or
bun add @hypen-space/core @hypen-space/web @hypen-space/web-engine
```

## Quick Start

The simplest way to render a Hypen component in the browser:

```typescript
import { render } from "@hypen-space/web-engine";

await render("Counter", "#app");
```

## Hypen Orchestrator

For full control over initialization and rendering:

```typescript
import { Hypen } from "@hypen-space/web-engine";

const hypen = new Hypen({
  componentsDir: "./src/components",
  debug: false,
  wasmUrl: "/hypen_engine_bg.wasm",
  debugHeatmap: false,
});

await hypen.init();
await hypen.loadComponents();
await hypen.render("HomePage", "#app");

// Access runtime
const router = hypen.getRouter();
const context = hypen.getGlobalContext();
const state = hypen.getState();

// Cleanup
await hypen.unmount();
```

## Engine (Low-Level)

Use the `Engine` class directly for custom integrations. The `createHypenClient` helper from `@hypen-space/web/dom` (or `/canvas`) wires the renderer and the engine's patch callback in one call:

```typescript
import { Engine } from "@hypen-space/web-engine";
import { createHypenClient } from "@hypen-space/web/dom";

const engine = new Engine();
await engine.init({ wasmUrl: "/hypen_engine_bg.wasm" });

createHypenClient(document.getElementById("app")!, engine);

engine.renderSource(`
  Column {
    Text("Hello from the browser!")
  }
`);
```

## Render with Pre-Loaded Components

Skip discovery and pass components directly:

```typescript
import { renderWithComponents } from "@hypen-space/web-engine";

await renderWithComponents("Counter", "#app", {
  Counter: {
    template: 'Column { Text("Count: @{state.count}") }',
    module: counterModule,
  },
});
```

## Exports

| Export | Description |
|--------|-------------|
| `@hypen-space/web-engine` | Main - Hypen orchestrator, render, renderWithComponents, Engine |
| `@hypen-space/web-engine/engine` | Browser WASM engine wrapper |

## Requirements

- Browser with ES2020 support
- `@hypen-space/core` and `@hypen-space/web` peer dependencies

## License

MIT

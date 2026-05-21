# @hypen-space/web

Browser renderers for Hypen - DOM and Canvas rendering for web applications.

## Installation

```bash
npm install @hypen-space/core @hypen-space/web
# or
bun add @hypen-space/core @hypen-space/web
```

## Quick Start

The simplest way to use Hypen in the browser:

```typescript
import { render } from "@hypen-space/web-engine";

// Auto-discovers and loads components from ./src/components
await render("HomePage", "#app");
```

### With Explicit Configuration

```typescript
import { Hypen } from "@hypen-space/web-engine";

const hypen = new Hypen({
  componentsDir: "./src/components",
  debug: true,
  wasmUrl: "/hypen_engine_bg.wasm",
});

await hypen.init();
await hypen.loadComponents();
await hypen.render("HomePage", "#app");

// Access router and state
const router = hypen.getRouter();
const state = hypen.getState();

// Cleanup when done
await hypen.unmount();
```

### File-Based Components

Create components with `.hypen` templates and optional `.ts` modules:

```
src/components/
├── Counter/
│   ├── component.hypen    # UI template
│   └── component.ts       # State & actions (optional)
├── Header/
│   └── component.hypen    # Stateless component
└── ProductList/
    ├── component.hypen
    └── component.ts
```

**component.hypen:**
```hypen
Column.padding(16).gap(8) {
  Text("Count: @{state.count}")
    .fontSize(24)
  Row.gap(8) {
    Button(onClick: @actions.decrement) { Text("-") }
    Button(onClick: @actions.increment) { Text("+") }
  }
}
```

**component.ts:**
```typescript
import { app } from "@hypen-space/core";

export default app
  .defineState({ count: 0 })
  .onAction("increment", ({ state }) => state.count++)
  .onAction("decrement", ({ state }) => state.count--)
  .build();
```

## Hypen Class API

```typescript
import { Hypen } from "@hypen-space/web-engine";

const hypen = new Hypen({
  componentsDir: "./src/components", // Default
  debug: false,
  wasmUrl: "/hypen_engine_bg.wasm",
  debugHeatmap: false,               // Visualize re-renders
  heatmapIncrement: 5,               // % opacity per re-render
  heatmapFadeOut: 2000,              // ms fade duration
});

// Initialize WASM engine
await hypen.init();

// Auto-load components from directory
await hypen.loadComponents();
// Or load from custom path
await hypen.loadComponents("./custom/path");

// Render to DOM
await hypen.render("HomePage", "#app");
// Or use an element directly
await hypen.render("HomePage", document.getElementById("app"));

// Access runtime
const router = hypen.getRouter();
const context = hypen.getGlobalContext();
const state = hypen.getState();
const module = hypen.getModuleInstance();

// Debug tools
hypen.setDebugHeatmap(true);
hypen.resetDebugTracking();
const stats = hypen.getDebugStats();

// Cleanup
await hypen.unmount();
```

## DOM Renderer (Low-Level)

For custom integrations:

```typescript
import { app } from "@hypen-space/core";
import { Engine } from "@hypen-space/web-engine";
import { DOMRenderer } from "@hypen-space/web";

const engine = new Engine();
await engine.init({ wasmUrl: "/hypen_engine_bg.wasm" });

const renderer = new DOMRenderer(document.getElementById("app")!, engine, {
  enabled: true,
  showHeatmap: true,
});

engine.setRenderCallback((patches) => {
  renderer.applyPatches(patches);
});

engine.renderSource(`Column { Text("Hello!") }`);
```

## Custom Components

Register custom DOM components:

```typescript
const registry = renderer.getComponentRegistry();

registry.register("VideoPlayer", {
  create: () => {
    const video = document.createElement("video");
    video.controls = true;
    return video;
  },
  applyProps: (element, props) => {
    if (props.src) element.src = props.src;
    if (props.autoplay) element.autoplay = true;
  },
});

// Use in Hypen DSL:
// VideoPlayer(src: "video.mp4", autoplay: true)
```

## Custom Applicators

Register custom styling:

```typescript
const registry = renderer.getApplicatorRegistry();

registry.register("glassmorphism", (el, value) => {
  if (value) {
    el.style.background = "rgba(255, 255, 255, 0.1)";
    el.style.backdropFilter = "blur(10px)";
  }
});

// Use in Hypen DSL:
// Card.glassmorphism(true)
```

## Built-in Components

**Layout:** Column, Row, Container, Center, Stack, Grid, Spacer, Divider

**Text & Media:** Text, Heading, Paragraph, Image, Video, Audio

**Form:** Button, Input, Textarea, Select, Checkbox, Switch, Slider

**Navigation:** Link, Router, Route

**UI:** Card, Badge, Avatar, Spinner, ProgressBar, List

## Built-in Applicators

```hypen
Text("Hello")
  // Layout
  .padding(16)
  .margin(8)
  .width(200)
  .height(100)
  .weight(1)              // flex: 1 (cross-platform)
  .gap(8)

  // Alignment (works for both Row and Column)
  .horizontalAlignment(center)
  .verticalAlignment(spaceBetween)

  // Colors
  .color(blue)
  .backgroundColor(white)
  .borderColor(gray)

  // Typography
  .fontSize(18)
  .fontWeight(bold)
  .fontFamily("Inter")
  .textAlign(center)

  // Borders & Effects
  .borderRadius(8)
  .opacity(0.9)
  .boxShadow("0 2px 8px rgba(0,0,0,0.1)")

  // Events
  .onClick(@actions.handleClick)
```

## Canvas Renderer

Hardware-accelerated rendering:

```typescript
import { CanvasRenderer } from "@hypen-space/web";

const canvas = document.querySelector("canvas")!;
const renderer = new CanvasRenderer(canvas, engine, {
  devicePixelRatio: window.devicePixelRatio,
  enableAccessibility: true,
  enableHitTesting: true,
});

engine.setRenderCallback((patches) => {
  renderer.applyPatches(patches);
});
```

## Remote UI

Connect to a server-driven UI:

```typescript
import { RemoteEngine } from "@hypen-space/core";
import { DOMRenderer } from "@hypen-space/web";

const renderer = new DOMRenderer(document.getElementById("app")!, engine);
const remote = new RemoteEngine("ws://localhost:3000", {
  autoReconnect: true,
});

remote
  .onPatches((patches) => renderer.applyPatches(patches))
  .onStateUpdate((state) => renderer.updateState(state))
  .onConnect(() => console.log("Connected"));

await remote.connect();
remote.dispatchAction("login", { user: "admin" });
```

## Exports

| Export | Description |
|--------|-------------|
| `@hypen-space/web` | Main - DOMRenderer, CanvasRenderer, ComponentRegistry, ApplicatorRegistry |
| `@hypen-space/web/dom` | DOM renderer and utilities |
| `@hypen-space/web/canvas` | Canvas renderer |
| `@hypen-space/web-engine` | Hypen orchestrator, render, renderWithComponents, Engine (browser) |

## Requirements

- Browser with ES2020 support
- `@hypen-space/core` peer dependency

## License

MIT

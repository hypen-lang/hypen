# Canvas Renderer

Browser-only module for rendering Hypen UI to a `<canvas>` element.

## Overview

The Canvas Renderer is a complete alternative to the DOM renderer that draws all UI elements directly to a canvas using the Canvas 2D API. This provides:

- **Performance**: For very large UIs, canvas can be faster than DOM
- **Control**: Pixel-perfect control over rendering
- **Portability**: Can be adapted to other canvas-based platforms (WebGL, native canvas, etc.)
- **Consistency**: Same rendering behavior across all browsers

## Quick Start

`createHypenClient` is the recommended one-call wiring (constructs the renderer and subscribes to engine patches). `CanvasRenderer` is still exported directly for advanced setups.

```typescript
import { app } from "@hypen-space/core";
import { Engine } from "@hypen-space/web-engine";
import { createHypenClient } from "@hypen-space/web/canvas";

// Setup canvas
const canvas = document.getElementById("app") as HTMLCanvasElement;

// Initialize engine
const engine = new Engine();
await engine.init();

// Create canvas renderer + patch subscription in one call
createHypenClient(canvas, engine);

// Render UI
await engine.renderSource(`
  Column {
    Text("Hello, Canvas!")
    Button("@actions.click") { Text("Click me") }
  }
`);
```

## Architecture

```
┌─────────────────────────────────────────┐
│  CanvasRenderer                          │
│  - Orchestrates layout, paint, events   │
│  - Maintains virtual node tree          │
│  - Schedules redraws                    │
└─────────────────────────────────────────┘
           ↓         ↓         ↓
    ┌──────────┐ ┌──────┐ ┌───────┐
    │  Layout  │ │ Paint│ │Events │
    │  Engine  │ │System│ │Manager│
    └──────────┘ └──────┘ └───────┘
```

### Virtual Node Tree

Unlike the DOM renderer which creates real HTML elements, the canvas renderer maintains an internal virtual node tree:

```typescript
interface VirtualNode {
  id: string
  type: string
  props: Record<string, any>
  children: VirtualNode[]
  layout?: Layout        // Computed position/size
  visible: boolean
  opacity: number
  clickable: boolean
  hovered: boolean
  focused: boolean
}
```

## Core Systems

### 1. Layout Engine (`layout.ts`)

Implements a flexbox-like layout system:

- **Flexbox model**: Row/Column with `flex`, `gap`, alignment
- **Box model**: Margin, padding, border
- **Sizing**: width, height, min/max constraints
- **Text layout**: Automatic text measurement and wrapping

**Supported Properties:**
- `flexDirection`: "row" | "column"
- `verticalAlignment`: "start" | "center" | "end" | "space-between" | "space-around" (main axis for Column, cross axis for Row)
- `horizontalAlignment`: "start" | "center" | "end" | "space-between" | "space-around" (cross axis for Column, main axis for Row)
- `gap`: spacing between children
- `padding`, `margin`: box spacing
- `width`, `height`, `minWidth`, `maxWidth`, etc.

### 2. Paint System (`paint.ts`)

Draws virtual nodes to canvas:

- **Background**: solid colors, border radius
- **Border**: width, color, radius
- **Text**: font rendering with alignment and wrapping
- **Components**: Button, Input, Image, etc.

**Custom Painters:**
```typescript
renderer.registerPainter("MyComponent", (ctx, node) => {
  // Custom drawing code
  ctx.fillStyle = node.props.color;
  ctx.fillRect(
    node.layout!.x,
    node.layout!.y,
    node.layout!.width,
    node.layout!.height
  );
});
```

### 3. Event System (`events.ts`)

Maps canvas events to virtual nodes:

- **Hit Testing**: Determines which node was clicked/hovered
- **Mouse Events**: click, mousedown, mouseup, mouseenter, mouseleave
- **Keyboard Events**: keydown, keyup (for focused elements)
- **Hover States**: Automatic cursor changes and hover effects

**How It Works:**
1. Mouse event occurs on canvas
2. Convert to canvas coordinates
3. Walk virtual tree to find node at coordinates (back to front)
4. Dispatch action to engine if node has handler

### 4. Text System (`text.ts`)

Handles text measurement and rendering:

- **Text Measurement**: Accurate width/height calculation
- **Line Wrapping**: Automatic word wrapping to fit width
- **Font Loading**: Ensures fonts are loaded before rendering
- **Text Alignment**: left, center, right, top, middle, bottom
- **Caching**: Text metrics are cached for performance

### 5. Input Overlay (`input.ts`)

Since canvas can't handle text input natively, we use DOM overlays:

**Strategy:**
1. When canvas input is focused, create a real `<input>` element
2. Position it exactly over the canvas input (invisible to user)
3. Style it to match the canvas input appearance
4. Capture input and update state
5. Remove overlay when focus is lost

**Supports:**
- Single-line text input
- Multi-line textarea
- Number input
- Custom styling

### 6. Accessibility (`accessibility.ts`)

Maintains a shadow DOM tree for screen readers:

**Strategy:**
1. Create hidden DOM tree that mirrors canvas structure
2. Use semantic HTML (button, input, etc.)
3. Update shadow DOM when patches are applied
4. Support keyboard navigation
5. ARIA labels and roles

This makes the canvas renderer fully accessible without impacting visual rendering.

## Supported Components

All Hypen components work with the canvas renderer:

### Layout Components
- **Column**: Vertical flex container
- **Row**: Horizontal flex container
- **Container/Box**: Generic container

### Text Components
- **Text**: Text with automatic wrapping

### Interactive Components
- **Button**: Clickable button with hover states
- **Input**: Single-line text input
- **Textarea**: Multi-line text input (future)

### Media Components
- **Image**: Image rendering (basic support)

## Configuration Options

```typescript
const renderer = new CanvasRenderer(canvas, engine, {
  // Display
  devicePixelRatio: window.devicePixelRatio,  // HiDPI support
  backgroundColor: "#ffffff",                  // Canvas background
  
  // Features
  enableAccessibility: true,      // Shadow DOM for screen readers
  enableHitTesting: true,         // Mouse event handling
  enableInputOverlay: true,       // DOM overlays for text input
  
  // Performance (future)
  enableDirtyRects: false,        // Only redraw changed regions
  enableLayerCaching: false,      // Cache static subtrees
  maxLayerCacheSize: 10,          // Max cached layers
  
  // Debug
  showLayoutBounds: false,        // Draw red boxes around nodes
  showDirtyRects: false,          // Highlight redrawn regions
  logPerformance: false,          // Log FPS and render time
});
```

## Examples

See `examples/canvas-counter.ts` for a complete example.

### Running Examples

```bash
# Using Bun
bun examples/canvas-counter.ts

# Or open HTML file directly
open examples/canvas-counter.html
```

## Performance

### Current Performance
- **Typical UI**: 60fps with < 100 nodes
- **Layout**: ~2-5ms for moderate trees
- **Paint**: ~5-10ms for moderate trees
- **Text**: Cached measurements are nearly free

### Optimization Opportunities
- ✅ Text metrics caching (implemented)
- ⬜ Dirty rectangle tracking (planned)
- ⬜ Layer caching (planned)
- ⬜ Offscreen canvases (planned)
- ⬜ WebGL backend (future)

## Limitations

### Current Limitations
- ❌ No rich text (bold/italic within text)
- ❌ No text selection/copy
- ❌ No gradients
- ❌ No shadows
- ❌ No transforms (rotate/scale/skew)
- ❌ Limited image support

### Future Improvements
All of these are planned for future releases!

## Comparison: Canvas vs DOM

| Feature | Canvas Renderer | DOM Renderer |
|---------|----------------|--------------|
| Performance (large UIs) | ✅ Better | ⚠️ Slower |
| Text input | ⚠️ Overlay | ✅ Native |
| Accessibility | ⚠️ Shadow DOM | ✅ Native |
| Browser DevTools | ❌ No inspection | ✅ Full support |
| CSS styling | ❌ Props only | ✅ CSS support |
| Animations | ⚠️ Manual | ✅ CSS animations |
| Memory usage | ✅ Lower | ⚠️ Higher |
| Initial render | ✅ Faster | ⚠️ Slower |

## When to Use Canvas Renderer

**Use Canvas Renderer when:**
- Building dashboards with many elements (100+)
- Need consistent cross-browser rendering
- Building games or creative tools
- Performance is critical
- Building for canvas-based platforms

**Use DOM Renderer when:**
- Building standard web apps
- Need rich text formatting
- Need CSS animations
- Want browser DevTools support
- Accessibility is paramount

## API Reference

### CanvasRenderer

```typescript
class CanvasRenderer implements Renderer {
  constructor(
    canvas: HTMLCanvasElement,
    engine: Engine,
    options?: Partial<CanvasRendererOptions>
  )
  
  // Renderer interface
  applyPatches(patches: Patch[]): void
  getNode(id: string): VirtualNode | undefined
  clear(): void
  
  // Canvas-specific
  registerPainter(type: string, painter: PainterFunction): void
  setOptions(options: Partial<CanvasRendererOptions>): void
  destroy(): void
}
```

### Custom Painters

```typescript
type PainterFunction = (
  ctx: CanvasRenderingContext2D,
  node: VirtualNode
) => void;

renderer.registerPainter("Circle", (ctx, node) => {
  const layout = node.layout!;
  const radius = Math.min(layout.width, layout.height) / 2;
  const centerX = layout.x + layout.width / 2;
  const centerY = layout.y + layout.height / 2;
  
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fillStyle = node.props.color || "#000";
  ctx.fill();
});
```

## Testing

The canvas renderer includes comprehensive tests:

```bash
# Run tests
bun test src/canvas

# Run with coverage
bun test --coverage src/canvas
```

## Contributing

The canvas renderer is under active development. Contributions welcome!

**Current Priorities:**
1. Text selection support
2. Gradient/shadow support
3. Performance optimizations (dirty rects, layer caching)
4. Advanced text (rich text, ligatures)
5. More component painters

## See Also

- [Main README](../../README.md) - SDK documentation
- [DOM Renderer](../dom/README.md) - DOM renderer documentation
- [Plan](./plan.md) - Implementation plan and roadmap
- [Canvas API Docs](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API)












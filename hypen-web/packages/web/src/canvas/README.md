# Canvas Renderer

Browser-only module for rendering Hypen UI to a `<canvas>` element.

## Overview

The Canvas Renderer is a complete alternative to the DOM renderer that draws all UI elements directly to a canvas using the Canvas 2D API. This provides:

- **Performance**: For very large UIs, canvas can be faster than DOM
- **Control**: Pixel-perfect control over rendering
- **Portability**: Can be adapted to other canvas-based platforms (WebGL, native canvas, etc.)
- **Consistency**: Same rendering behavior across all browsers

## Quick Start

```typescript
import { app } from "@hypen-space/core";
import { Engine } from "@hypen-space/web-engine";
import { CanvasRenderer } from "@hypen-space/web/canvas";

// Setup canvas
const canvas = document.getElementById("app") as HTMLCanvasElement;

// Initialize engine
const engine = new Engine();
await engine.init();

// Create canvas renderer
const renderer = new CanvasRenderer(canvas, engine);

// Set render callback
engine.setRenderCallback((patches) => {
  renderer.applyPatches(patches);
});

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

### 5. Native Text Editing (`editing.ts`)

Text, caret, and selection inside `Input`/`Textarea` are painted **on the
canvas** — there is no visible DOM overlay. The browser does the actual
editing (typing, caret movement, word-jumps, select-all, clipboard, undo,
IME composition) in a single hidden **proxy textarea** positioned at the
caret (the Monaco/xterm.js approach); the `TextEditController` reads
`value`/`selectionStart`/`selectionEnd` after each event and the canvas
paints the result. Focus and accessibility stay on the node's mirror
element (below) — browsers won't run text editing on unrendered fallback
content, which is why the keystroke stream needs the proxy. Positioning the
proxy at the caret also puts the IME candidate window next to the painted
text.

**Editing visuals (painted in `paint.ts#paintInput`):**
- Selection highlight and blinking caret via shared `text-geometry.ts` math
- IME composition range underlined (dashed)
- Single-line inputs pan horizontally (`scrollX`) to keep the caret visible
- Click/drag on the canvas maps point → character offset → `setSelectionRange`

Two-way binding dispatches `__hypen_bind {path, value}` on input (suppressed
during IME composition; flushed at `compositionend`).

### 6. Accessibility & Focus (`accessibility.ts`, `focus.ts`)

A live DOM mirror of the virtual tree is rendered as a **transparent
positioned overlay** above the canvas (the Flutter-web approach), with every
element absolutely positioned at its painted bounds and `pointer-events:
none` so the canvas keeps all pointer interaction.

Canvas *fallback content* was evaluated first and rejected on evidence:
Chromium exposes fallback elements to the accessibility tree (names, roles,
focus, Tab order all work) but gives them **zero geometry** — and screen
reader browse modes (VoiceOver cursor, rotor, touch exploration) are
geometry-driven, so they skip boundless elements entirely.

**Strategy:**
1. Mirror elements use semantic HTML (button, input, h1-h6, ...) driven by
   the engine-derived `Semantics` block, invisibly rendered (transparent
   text/background; placeholders and selection suppressed via a shared
   stylesheet) so AT gets real boxes and native focus rings land exactly
   over the painted controls
2. The mirror is synced **incrementally** from the patch stream
   (create/insert/move/remove/detach/attach) — element identity survives
   re-renders and router navigation, so AT focus/virtual-cursor position
   is never destroyed by an update; element positions are refreshed after
   every canvas render
3. Real DOM focus on mirror elements is the **single source of truth** for
   focus: Tab/Shift+Tab work natively, `focusin`/`focusout` drive
   `node.focused` and the painted focus ring, and the canvas hit-test path
   funnels into the same place by focusing the node's mirror element
4. Enter/Space on a mirror `<button>` (or AT activation) dispatches the
   node's action — identical payload to a canvas click
5. The `<canvas>` itself is `aria-hidden` — the overlay carries all
   semantics

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
- **Video**: Inline playback via an offscreen `<video>` element drawn to the
  canvas each frame (see `hypen-docs/content/docs/guide/components.mdx` for the cross-platform
  contract). Supports `src`/`playlist` (auto-advance + `loop` wrap),
  `poster`, `autoplay` (with muted fallback), `muted`, `loop`, `preload`,
  `objectFit` (`contain` default, `cover`, `fill`), `headers`
  (fetch → Blob fallback), and the `onPlay`/`onPause`/`onEnded`/
  `onTrackChange`/`onError` action props. Controls are the canvas common
  denominator: **tap toggles play/pause** when `controls` is set — there is
  no scrubber/volume UI. Repaints are driven by a rAF loop that runs only
  while a video is actually playing. Note: the offscreen elements are keyed
  by node id in a module-level cache, so two `CanvasRenderer` instances on
  the same page should not share node ids.

## Configuration Options

```typescript
const renderer = new CanvasRenderer(canvas, engine, {
  // Display
  devicePixelRatio: window.devicePixelRatio,  // HiDPI support
  backgroundColor: "#ffffff",                  // Canvas background
  
  // Features
  enableAccessibility: true,      // Fallback-content mirror: screen readers,
                                  // Tab focus, and text-input editing
  enableHitTesting: true,         // Mouse event handling
  
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
- ⚠️ Video controls are tap-to-toggle only (no scrubber, volume, or
  fullscreen UI); HLS only where the browser decodes it natively (Safari)

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












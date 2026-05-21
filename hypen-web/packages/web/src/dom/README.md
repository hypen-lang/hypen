# DOM Renderer

Browser-only module for rendering Hypen UI to the DOM.

## Structure

```
src/dom/
├── index.ts                 # Main exports
├── renderer.ts              # DOMRenderer class
├── events.ts                # Event management
├── components/              # Component handlers
│   ├── index.ts            # Component registry
│   ├── column.ts
│   ├── row.ts
│   ├── text.ts
│   ├── image.ts
│   ├── button.ts
│   ├── container.ts
│   ├── center.ts
│   ├── list.ts
│   └── input.ts
├── applicators/             # Style applicators
│   ├── index.ts            # Applicator registry
│   ├── padding.ts
│   ├── margin.ts
│   ├── color.ts
│   ├── border.ts
│   ├── size.ts
│   ├── font.ts
│   └── layout.ts
└── canvas/                  # Canvas support
    └── index.ts            # Canvas component & applicators
```

## Usage

### Browser Import

```typescript
import { app, HypenModuleInstance } from "@hypen-space/core";
import { Engine } from "@hypen-space/web-engine";
import { DOMRenderer } from "@hypen-space/web";

const engine = new Engine();
await engine.init();

const renderer = new DOMRenderer(document.body, engine);
engine.setRenderCallback((patches) => {
  renderer.applyPatches(patches);
});
```

### Server Import

```typescript
// This will fail in Node.js/Bun (no DOM)
import { DOMRenderer } from "@hypen-space/web"; // ❌ Error (no DOM in Node.js)

// Use server-safe renderer instead
import { ConsoleRenderer } from "@hypen-space/core"; // ✅ Works
```

## Components

All components are registered by default:

- **Column** - Vertical flex container
- **Row** - Horizontal flex container
- **Text** - Text content
- **Image** - Image element
- **Button** - Button element
- **Container/Box** - Generic div
- **Center** - Centered content
- **List** - Scrollable stack with gap
- **Input** - Input field
- **Canvas** - Canvas element

### Custom Components

```typescript
const renderer = new DOMRenderer(document.body, engine);
const registry = renderer.getComponentRegistry();

registry.register("mycomponent", {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.classList.add("my-component");
    return el;
  },
  applyProps(el: HTMLElement, props: Record<string, any>): void {
    if (props.title) {
      el.setAttribute("title", props.title);
    }
  },
});
```

## Applicators

Style applicators are registered by default:

**Spacing:**
- `padding` - All sides or {left, right, top, bottom}
- `margin` - All sides or {left, right, top, bottom}
- `gap` - Flex/grid gap

**Colors:**
- `color` - Text color
- `backgroundColor` - Background color
- `borderColor` - Border color
- `opacity` - Opacity (0-1)

**Border:**
- `borderWidth` - Border width
- `borderStyle` - Border style (solid, dashed, etc.)
- `borderRadius` - Border radius

**Size:**
- `width`, `height` - Element size
- `minWidth`, `minHeight` - Minimum size
- `maxWidth`, `maxHeight` - Maximum size

**Font:**
- `fontSize` - Font size
- `fontWeight` - Font weight (normal, bold, 100-900)
- `fontFamily` - Font family
- `textAlign` - Text alignment
- `lineHeight` - Line height

**Layout (Flexbox):**
- `horizontalAlign` - justify-content
- `verticalAlign` - align-items
- `flex` - Flex shorthand
- `flexGrow`, `flexShrink` - Flex properties

**Misc:**
- `cursor` - Cursor style
- `overflow` - Overflow behavior

### Custom Applicators

```typescript
const renderer = new DOMRenderer(document.body, engine);
const applicators = renderer.getApplicatorRegistry();

applicators.register("shadow", (el, value) => {
  el.style.boxShadow = `0 ${value}px ${value * 2}px rgba(0,0,0,0.2)`;
});
```

## Events

Events are automatically wired up when patches include `attachEvent`:

```typescript
// Hypen DSL:
Button("@actions.increment") { Text("+") }

// Becomes:
// 1. Create button
// 2. Attach "click" event
// 3. On click, dispatch "increment" action to engine
```

Supported events:
- Mouse: `click`, `dblclick`, `mousedown`, `mouseup`, `mouseenter`, `mouseleave`
- Keyboard: `keydown`, `keyup`, `keypress`
- Input: `input`, `change`, `focus`, `blur`
- Form: `submit`
- Touch: `touchstart`, `touchend`, `touchmove`

Event data includes:
- `type` - Event type
- `timestamp` - When it occurred
- `clientX`, `clientY` - Mouse position (mouse events)
- `key`, `code` - Key info (keyboard events)
- `value` - Input value (form elements)

## Canvas

Canvas components have special applicators for drawing:

```typescript
// Register canvas applicators
const renderer = new DOMRenderer(document.body, engine);
const applicators = renderer.getApplicatorRegistry();

// Canvas-specific applicators
applicators.register("fillStyle", (el, value) => {
  const canvas = el as HTMLCanvasElement;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.fillStyle = value;
});
```

Built-in canvas applicators:
- `fillStyle` - Fill color
- `strokeStyle` - Stroke color
- `lineWidth` - Line width

## Extensibility

### Adding a New Component

1. Create `src/dom/components/mycomponent.ts`:

```typescript
import type { ComponentHandler } from "./index.js";

export const myComponentHandler: ComponentHandler = {
  create(): HTMLElement {
    const el = document.createElement("div");
    el.dataset.hypenType = "mycomponent";
    return el;
  },
  applyProps(el, props) {
    // Handle props
  },
};
```

2. Register in `src/dom/components/index.ts`:

```typescript
const { myComponentHandler } = require("./mycomponent.js");
this.register("mycomponent", myComponentHandler);
```

### Adding a New Applicator

1. Create `src/dom/applicators/myapplicator.ts`:

```typescript
import type { ApplicatorHandler } from "./index.js";

export const myApplicatorHandler: ApplicatorHandler = (el, value) => {
  el.style.someProperty = String(value);
};
```

2. Register in `src/dom/applicators/index.ts`:

```typescript
const { myApplicatorHandler } = require("./myapplicator.js");
this.register("myapplicator", myApplicatorHandler);
```

## Performance

- **Minimal DOM operations** - Only patches are applied
- **Efficient updates** - Only changed props are updated
- **Event delegation** - Events managed per-element
- **Keyed reconciliation** - Use `key` prop for lists

## Browser Support

- Modern browsers with ES6+ support
- Requires: `Proxy`, `Map`, `Set`, `Promise`
- No IE11 support (use Babel + polyfills if needed)

## See Also

- [Main README](../../README.md) - Full SDK documentation
- [REFACTORING.md](../../REFACTORING.md) - State management details
- [IMPLEMENTATION.md](../../IMPLEMENTATION.md) - Implementation guide

# Canvas Renderer Quick Start

Get started with the Hypen Canvas Renderer in 5 minutes.

## Installation

```bash
bun add @hypen-space/core @hypen-space/web @hypen-space/web-engine
```

## Basic Setup

### 1. Create HTML File

```html
<!DOCTYPE html>
<html>
<head>
  <title>My Canvas App</title>
</head>
<body>
  <canvas id="app" width="800" height="600"></canvas>
  <script type="module" src="./app.ts"></script>
</body>
</html>
```

### 2. Create App (`app.ts`)

```typescript
import { app, HypenModuleInstance } from "@hypen-space/core";
import { Engine } from "@hypen-space/web-engine";
import { CanvasRenderer } from "@hypen-space/web/canvas";

// Define state
type AppState = {
  count: number;
};

// Define module
const appModule = app
  .defineState<AppState>({ count: 0 })
  .onAction("increment", async ({ state }) => {
    state.count++;
  })
  .build();

// Setup
async function main() {
  // Get canvas
  const canvas = document.getElementById("app") as HTMLCanvasElement;

  // Initialize engine
  const engine = new Engine();
  await engine.init();

  // Create renderer
  const renderer = new CanvasRenderer(canvas, engine, {
    devicePixelRatio: window.devicePixelRatio,
    backgroundColor: "#ffffff",
  });

  // Connect renderer
  engine.setRenderCallback((patches) => {
    renderer.applyPatches(patches);
  });

  // Create module
  const instance = new HypenModuleInstance(engine, appModule);

  // Render UI
  await engine.renderSource(`
    Column {
      padding: 20
      gap: 10
      
      Text("Count: @{state.count}") {
        fontSize: 24
      }
      
      Button("@actions.increment") {
        padding: 10
        backgroundColor: #007bff
        borderRadius: 4
        
        Text("Increment") {
          color: white
        }
      }
    }
  `);
}

main();
```

### 3. Run

```bash
bun app.ts
```

Open `http://localhost:3000` (or your dev server) and you'll see your app!

## Features Overview

### Layouts

```typescript
// Vertical layout
Column {
  gap: 10
  padding: 20
  
  Text("Item 1")
  Text("Item 2")
}

// Horizontal layout
Row {
  gap: 5
  horizontalAlignment: center
  
  Text("Left")
  Text("Right")
}
```

### Styling

```typescript
Text("Styled Text") {
  fontSize: 18
  fontWeight: bold
  color: #333333
  padding: 10
  backgroundColor: #f0f0f0
  borderRadius: 4
}
```

### Buttons

```typescript
Button("@actions.save") {
  padding: 12
  backgroundColor: #28a745
  borderRadius: 6
  
  Text("Save") {
    color: white
    fontSize: 16
    fontWeight: 500
  }
}
```

### Inputs

```typescript
Input {
  value: "@{state.name}"
  placeholder: "Enter name"
  padding: 8
  fontSize: 14
}
```

## Common Patterns

### Counter

```typescript
Column {
  Row {
    gap: 10
    
    Button("@actions.decrement") {
      Text("-")
    }
    
    Text("@{state.count}") {
      fontSize: 24
    }
    
    Button("@actions.increment") {
      Text("+")
    }
  }
}
```

### Form

```typescript
Column {
  gap: 15
  padding: 20
  
  Text("Login") {
    fontSize: 24
    fontWeight: bold
  }
  
  Input {
    placeholder: "Username"
    value: "@{state.username}"
  }
  
  Input {
    placeholder: "Password"
    type: password
    value: "@{state.password}"
  }
  
  Button("@actions.login") {
    Text("Login")
  }
}
```

### Card

```typescript
Container {
  padding: 20
  backgroundColor: white
  borderRadius: 8
  borderWidth: 1
  borderColor: #e0e0e0
  
  Column {
    gap: 10
    
    Text("Card Title") {
      fontSize: 20
      fontWeight: bold
    }
    
    Text("Card content goes here")
    
    Button("@actions.action") {
      Text("Action")
    }
  }
}
```

## Configuration Options

```typescript
const renderer = new CanvasRenderer(canvas, engine, {
  // Display
  devicePixelRatio: window.devicePixelRatio,  // HiDPI support
  backgroundColor: "#ffffff",                  // Canvas background
  
  // Features
  enableAccessibility: true,      // Screen readers + Tab focus + text editing
  enableHitTesting: true,         // Mouse events
  
  // Debug
  showLayoutBounds: false,        // Show red boxes around elements
  logPerformance: false,          // Log FPS to console
});
```

## Custom Painters

Draw custom components:

```typescript
renderer.registerPainter("Circle", (ctx, node) => {
  const layout = node.layout!;
  const radius = Math.min(layout.width, layout.height) / 2;
  const centerX = layout.x + layout.width / 2;
  const centerY = layout.y + layout.height / 2;
  
  ctx.fillStyle = node.props.color || "#000";
  ctx.beginPath();
  ctx.arc(centerX, centerY, radius, 0, Math.PI * 2);
  ctx.fill();
});
```

Use in Hypen DSL:

```typescript
Circle {
  width: 100
  height: 100
  color: #ff0000
}
```

## Responsive Canvas

Make canvas responsive:

```typescript
function setupCanvas() {
  const canvas = document.getElementById("app") as HTMLCanvasElement;
  
  function resize() {
    const dpr = window.devicePixelRatio;
    canvas.width = window.innerWidth * dpr;
    canvas.height = window.innerHeight * dpr;
    canvas.style.width = `${window.innerWidth}px`;
    canvas.style.height = `${window.innerHeight}px`;
    
    // Trigger re-render
    engine.renderSource(ui);
  }
  
  window.addEventListener("resize", resize);
  resize();
  
  return canvas;
}
```

## Performance Tips

### 1. Batch Updates

```typescript
// Bad: Multiple updates trigger multiple renders
state.count = 1;
state.name = "Alice";
state.active = true;

// Good: Single update
Object.assign(state, {
  count: 1,
  name: "Alice",
  active: true,
});
```

### 2. Debounce Real-time Updates

```typescript
let timeoutId: number;

.onAction("search", async ({ action, state }) => {
  clearTimeout(timeoutId);
  timeoutId = setTimeout(() => {
    // Do expensive search
    state.results = search(action.query);
  }, 300);
})
```

### 3. Measure Performance

```typescript
const renderer = new CanvasRenderer(canvas, engine, {
  logPerformance: true,  // Logs FPS and frame times
});
```

## Troubleshooting

### Canvas is Blurry

Make sure to set `devicePixelRatio`:

```typescript
const renderer = new CanvasRenderer(canvas, engine, {
  devicePixelRatio: window.devicePixelRatio,
});
```

### Text Input Not Working

Text editing runs through the accessibility mirror (canvas fallback
content), so `enableAccessibility` must be true (the default):

```typescript
const renderer = new CanvasRenderer(canvas, engine, {
  enableAccessibility: true,
});
```

### Nothing Renders

1. Check canvas size is not 0x0
2. Ensure engine is initialized: `await engine.init()`
3. Check console for errors
4. Enable debug mode: `showLayoutBounds: true`

### Poor Performance

1. Enable performance logging: `logPerformance: true`
2. Check if too many elements (> 1000)
3. Reduce update frequency
4. Consider layer caching (future feature)

## Next Steps

- Read the [Canvas Renderer README](./README.md)
- Try the [example](../../examples/canvas-counter.ts)

## Getting Help

- Check the [main documentation](../../README.md)
- Look at [examples](../../examples/)
- File an issue on GitHub

Happy coding! 🎨










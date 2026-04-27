# Debug Mode - Re-render Heatmap

The Hypen renderer includes a built-in debug mode that visualizes re-renders with a heatmap overlay. This helps identify performance bottlenecks and unnecessary re-renders.

## Features

- **Visual Heatmap**: Each element gets a transparent red overlay that increases in opacity with each re-render
- **Re-render Counter**: Shows the number of times each element has been re-rendered
- **Patch Type Display**: Shows what type of patch caused the re-render (e.g., `setProp:text`, `setText`)
- **Statistics**: Track total re-renders, affected elements, and average re-renders per element

## Usage

### Enable at Initialization

```typescript
import { renderWithComponents } from "@hypen-space/web-engine";

const hypen = await renderWithComponents(
  components,
  "App",
  "#app",
  {
    debugHeatmap: true,       // Enable heatmap
    heatmapIncrement: 5,      // Opacity increase per re-render (default: 5%)
    heatmapFadeOut: 2000,     // Fade out duration in ms (default: 2000)
  }
);
```

### Toggle at Runtime

```typescript
// Enable debug mode
hypen.setDebugHeatmap(true);

// Disable debug mode
hypen.setDebugHeatmap(false);

// Reset tracking
hypen.resetDebugTracking();

// Get statistics
const stats = hypen.getDebugStats();
console.log(stats);
// {
//   totalRerenders: 42,
//   elementCount: 8,
//   avgRerenders: 5.25
// }
```

## Example: Debug Controls UI

The `example-bun` includes a debug control panel:

```html
<!-- Debug Controls -->
<div id="debug-controls">
  <h3>🐛 Debug Mode</h3>
  <label>
    <input type="checkbox" id="heatmap-toggle">
    <span>Show Re-render Heatmap</span>
  </label>
  <button id="reset-tracking">Reset Tracking</button>
  <button id="show-stats">Show Stats</button>
  <div id="debug-stats"></div>
</div>
```

Wire up the controls:

```typescript
function setupDebugControls(hypen: Hypen) {
  const heatmapToggle = document.getElementById("heatmap-toggle") as HTMLInputElement;
  const resetButton = document.getElementById("reset-tracking") as HTMLButtonElement;
  const statsButton = document.getElementById("show-stats") as HTMLButtonElement;
  const statsDiv = document.getElementById("debug-stats") as HTMLDivElement;

  // Toggle heatmap
  heatmapToggle.addEventListener("change", () => {
    hypen.setDebugHeatmap(heatmapToggle.checked);
  });

  // Reset tracking
  resetButton.addEventListener("click", () => {
    hypen.resetDebugTracking();
    statsDiv.textContent = "";
  });

  // Show stats
  statsButton.addEventListener("click", () => {
    const stats = hypen.getDebugStats();
    if (stats) {
      statsDiv.innerHTML = `
        <strong>Re-render Statistics:</strong><br>
        Total Re-renders: ${stats.totalRerenders}<br>
        Elements Tracked: ${stats.elementCount}<br>
        Avg Re-renders: ${stats.avgRerenders}
      `;
    }
  });
}
```

## How It Works

### Visual Overlay

Each element gets a positioned overlay div with:
- Transparent red background that increases opacity by 5% per re-render (up to 80% max)
- Text showing the re-render count and patch type (e.g., "3× setProp:text")
- Automatic fade-out after 2 seconds (configurable)

### Tracking

The `RerenderTracker` class monitors:
- `setProp` patches (property updates)
- `setText` patches (text content updates)

Each patch application increments the counter and updates the overlay.

### Configuration

```typescript
interface DebugConfig {
  enabled: boolean;           // Enable debug mode
  showHeatmap: boolean;       // Show visual overlays
  heatmapIncrement: number;   // Opacity increase per re-render (%)
  maxOpacity: number;         // Maximum overlay opacity (0-1)
  fadeOutDuration: number;    // Fade duration in ms (0 to disable)
}
```

## Performance Impact

Debug mode has minimal performance impact:
- Overlays are created lazily (only when needed)
- Tracking uses simple Map lookups
- Visual updates use CSS transitions

**Recommendation**: Disable debug mode in production builds.

## Troubleshooting

### Overlays not showing

1. Check that debug mode is enabled: `hypen.setDebugHeatmap(true)`
2. Verify the element has `position: relative` (automatically applied)
3. Check z-index conflicts with other fixed/absolute elements

### High re-render counts

Use the heatmap to identify problematic components:
- Elements with many re-renders appear darker red
- Check the patch type to understand what's changing
- Consider memoization or state optimization

### Overlays blocking interactions

Overlays have `pointer-events: none` and should not interfere with clicks. If they do:
- Check for CSS conflicts
- Temporarily disable debug mode for testing interactions

## Example Output

When debug mode is enabled, you'll see:

```
Console:
🐛 Heatmap enabled
📊 Debug stats: {
  totalRerenders: 42,
  elementCount: 8,
  avgRerenders: 5.25
}
```

Visual overlay on each element:
```
┌─────────────────────────┐
│ 5× setProp:text         │ <- Red overlay with counter
│                         │
│   Your Element Here     │
│                         │
└─────────────────────────┘
```

## API Reference

### Hypen Instance Methods

#### `setDebugHeatmap(enabled: boolean): void`
Enable or disable debug heatmap visualization.

#### `resetDebugTracking(): void`
Reset all re-render counters to zero and remove overlays.

#### `getDebugStats(): { totalRerenders, elementCount, avgRerenders } | null`
Get current debug statistics.

### DOMRenderer Methods

#### `setDebugConfig(config: Partial<DebugConfig>): void`
Update debug configuration.

#### `resetDebugTracking(): void`
Reset debug tracking.

#### `getDebugStats(): { totalRerenders, elementCount, avgRerenders }`
Get debug statistics.

## Related Files

- `src/dom/debug.ts` - Debug implementation
- `src/dom/renderer.ts` - Integration with renderer
- `src/hypen.ts` - Public API
- `example-bun/src/main.ts` - Example usage
- `example-bun/index.html` - Debug UI controls

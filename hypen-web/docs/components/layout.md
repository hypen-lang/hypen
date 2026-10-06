# Layout Components

Layout components help you structure and organize the visual hierarchy of your UI.

## Column

Vertical flex container that stacks children from top to bottom.

**Props:**
- None (use applicators for styling)

**Layout Applicators:**
- `.verticalAlignment(value)` - How children are distributed vertically (main axis)
- `.horizontalAlignment(value)` - How children are aligned horizontally (cross axis)
- `.scrollable(true)` - Enable vertical scrolling

**Values:** `start`, `end`, `center`, `spaceBetween`, `spaceAround`, `spaceEvenly`

**Example:**
```hypen
Column {
  Text("First item")
  Text("Second item")
  Text("Third item")
}
  .gap(16)
  .padding(20)
  .verticalAlignment(center)
  .horizontalAlignment(start)
```

**Scrollable Column:**
```hypen
Column {
  // Long content...
}
  .scrollable(true)
  .height(400)
```

**Rendered as:** `<div>` with `display: flex; flex-direction: column;`

---

## Row

Horizontal flex container that arranges children from left to right.

**Props:**
- None (use applicators for styling)

**Layout Applicators:**
- `.horizontalAlignment(value)` - How children are distributed horizontally (main axis)
- `.verticalAlignment(value)` - How children are aligned vertically (cross axis)
- `.scrollable(true)` - Enable horizontal scrolling

**Values:** `start`, `end`, `center`, `spaceBetween`, `spaceAround`, `spaceEvenly`

**Example:**
```hypen
Row {
  Image(src: "icon.png")
  Text("Logo text")
}
  .gap(8)
  .horizontalAlignment(spaceBetween)
  .verticalAlignment(center)
```

**Rendered as:** `<div>` with `display: flex; flex-direction: row;`

---

## Container

Generic container element with no default styling.

**Alias:** `Box`

**Props:**
- None (use applicators for styling)

**Example:**
```hypen
Container()
  .width(300)
  .height(200)
  .backgroundColor("#f0f0f0") {
  
  Text("Content inside container")
}
```

**Rendered as:** `<div>`

---

## Center

Centers children both horizontally and vertically using flexbox.

**Props:**
- None

**Example:**
```hypen
Center()
  .width("100%")
  .height("100vh") {
  
  Text("Perfectly centered content")
}
```

**Rendered as:** `<div>` with `display: flex; justify-content: center; align-items: center;`

---

## Stack

Overlays children on top of each other using absolute positioning. The first child is relatively positioned and determines the size, while subsequent children are absolutely positioned.

**Props:**
- None

**Example:**
```hypen
Stack {
  Image(src: "background.jpg")
  Column()
    .position("absolute")
    .bottom(0)
    .left(0)
    .padding(20) {
    
    Text("Overlay text")
  }
}
```

**Rendered as:** `<div>` with `position: relative;` and automatic positioning styles for children

---

## Grid

CSS Grid container for creating grid-based layouts.

**Props:**
- `columns` (Number | String): Number of columns or grid template string (e.g., `3` or `"1fr 2fr 1fr"`)
- `rows` (Number | String): Number of rows or grid template string
- `gap` (Number | String): Space between grid items

**Example:**
```hypen
Grid(columns: 3, gap: 16) {
  Card { Text("Item 1") }
  Card { Text("Item 2") }
  Card { Text("Item 3") }
  Card { Text("Item 4") }
  Card { Text("Item 5") }
  Card { Text("Item 6") }
}
```

**Rendered as:** `<div>` with `display: grid;`

---

## Spacer

Flexible space element that expands to fill available space in flex layouts. Useful for pushing elements apart.

**Props:**
- None

**Example:**
```hypen
Row {
  Text("Left")
  Spacer()
  Text("Right")
}
```

**Rendered as:** `<div>` with `flex: 1;`

---

## Divider

Visual separator line between content sections.

**Props:**
- `thickness` / `height` (Number | String): Line thickness (default: 1px)
- `color` / `backgroundColor` (String): Line color (default: `#e0e0e0`)
- `orientation` (String): `"horizontal"` (default). `"vertical"` is currently Web-only.

**Example:**
```hypen
Column {
  Text("Section A")
  Divider(thickness: 2)
  Text("Section B")
}
```

**Web-only vertical Divider:**
```hypen
Row()
  .height(100) {
  
  Text("Left panel")
  Divider(orientation: "vertical")
  Text("Right panel")
}
```

**Rendered as:** `<div>`

---

## SafeArea

Full-size vertical container whose content is padded by the device safe-area insets — the notch/status bar at the top, the home indicator at the bottom, and the rounded-corner/cutout gutters on the sides. Use it as the outermost container of a screen so content never lands under system chrome.

It fills its parent (100% width and height) and lays its children out as a vertical stack, exactly like `Column`. The safe-area padding is applied to the container itself, so a background set with applicators still extends full-bleed *under* the insets while content stays inside them.

**Props:**
- `edges` (List of String): Which edges to inset — any of `"top"`, `"right"`, `"bottom"`, `"left"`. Omitted, absent, or empty means **all four edges**. Unknown strings are ignored.

**Example:**
```hypen
SafeArea {
  Column {
    Text("Never under the notch")
  }
}
```

**Selected edges only:**
```hypen
SafeArea(edges: ["top"]) {
  Row()
    .padding(16)
    .backgroundColor("#111827") {
    Text("Header")
  }

  Container()
    .flex(1) {
    Text("Content runs to the bottom of the screen")
  }
}
```

Applicators still apply as they do on any container. Safe-area padding and a user `.padding()` combine additively — the safe-area inset is carried by the outer element and user styling flows normally inside it.

Nesting SafeAreas is allowed and simply applies the insets again on the inner one; there is no special-casing.

**Rendered as:** `<div>` with `display: flex; flex-direction: column;` and `padding` from `env(safe-area-inset-*, 0px)` on the selected edges.

### Overriding the insets

The *effective* inset for an edge is the embedder-supplied value for that edge if one was given, otherwise the platform default. Overrides are **per-edge and merge over the defaults** — passing `{ bottom: 0 }` zeroes only the bottom inset; top, left, and right still use the platform default.

| Renderer | Default insets | Embedder override |
|----------|----------------|-------------------|
| Web DOM | `env(safe-area-inset-*, 0px)` | `safeAreaInsets?: Partial<SafeAreaInsets>` option on the DOM renderer options (number of CSS px or a CSS length string per edge) |
| Web Canvas | probed once from `env(safe-area-inset-*)`; `0` where unsupported | same-named `safeAreaInsets` option on the Canvas renderer options (numbers, CSS px) |
| Android | `WindowInsets.safeDrawing` | `LocalHypenSafeAreaInsets` composition local, or the insets parameter on the `HypenApp` entry composable; `null` falls back to `safeDrawing` |
| iOS / SwiftUI | the hosting view's real safe area (`GeometryReader`) | `\.hypenSafeAreaInsets` environment value (`HypenSafeAreaInsets?`); `nil` falls back to the real safe area |
| Desktop | zeros, except under the macOS unified titlebar, where the window-controls bar (close/minimize/maximize, 28 logical px) drawn over the content becomes the top inset | `safe_area_insets` field on the renderer/app config struct |

Values are in each platform's logical unit: CSS px on web, dp on Android, points on iOS, logical px on desktop.

**Web caveat — iOS Safari:** `env(safe-area-inset-*)` resolves to `0` unless the page opts into the full viewport. Add `viewport-fit=cover` to the viewport meta tag or SafeArea will look like a plain `Column` on iOS:

```html
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
```

---

## Common Layout Patterns

### Sidebar Layout
```hypen
Row()
  .height("100vh") {
  
  Column()
    .width(250)
    .backgroundColor("#f5f5f5")
    .padding(20) {
    Text("Sidebar")
  }
  
  Column()
    .flex(1)
    .padding(20) {
    Text("Main content")
  }
}
```

### Header-Content-Footer
```hypen
Column()
  .height("100vh") {
  
  Row()
    .padding(16)
    .backgroundColor("#333")
    .color("#fff") {
    Text("Header")
  }
  
  Container()
    .flex(1)
    .padding(20) {
    Text("Main content")
  }
  
  Row()
    .padding(16)
    .backgroundColor("#f5f5f5") {
    Text("Footer")
  }
}
```

### Product Grid
```hypen
Grid()
  .gridColumns(3)
  .gap(16)
  .padding(20) {
  
  ForEach(items: @{state.products}) {
    Card {
      Image(src: @{item.image})
      Text(@{item.name})
    }
  }
}
```

## See Also
- [Layout Applicators](../applicators/layout.md) - Flexbox and grid styling
- [Spacing Applicators](../applicators/spacing.md) - Padding, margin, and gap


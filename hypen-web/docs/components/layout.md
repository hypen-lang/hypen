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

**Advanced Grid:**
```hypen
Grid()
  .gridTemplateColumns("200px 1fr 1fr")
  .gridTemplateRows("auto 1fr auto")
  .gap(20) {
  
  // Grid items with specific placement
  Box().gridColumn("1 / 4") { Text("Header") }
  Box().gridColumn("1 / 2") { Text("Sidebar") }
  Box().gridColumn("2 / 4") { Text("Main content") }
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
- `thickness` (Number | String): Line thickness (default: 1px)
- `orientation` (String): `"horizontal"` (default) or `"vertical"`

**Example:**
```hypen
Column {
  Text("Section A")
  Divider(thickness: 2)
  Text("Section B")
}
```

**Vertical Divider:**
```hypen
Row()
  .height(100) {
  
  Text("Left panel")
  Divider(orientation: "vertical")
  Text("Right panel")
}
```

**Rendered as:** `<hr>`

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

### Responsive Grid
```hypen
Grid()
  .gridTemplateColumns("repeat(auto-fit, minmax(250px, 1fr))")
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



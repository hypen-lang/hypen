# Hypen Component & Applicator Reference

Welcome to the Hypen component and applicator documentation. This reference guide covers all built-in components and styling applicators available in the Hypen framework.

## Table of Contents

### Components
- [Layout Components](./components/layout.md) - Row, Column, Container, Center, Stack, Grid, Spacer, Divider
- [Text Components](./components/text.md) - Text, Heading, Paragraph
- [Form Components](./components/forms.md) - Input, Button, Textarea, Checkbox, Select, Switch, Slider
- [Media Components](./components/media.md) - Image, Video, Audio, Icon
- [Display Components](./components/display.md) - Card, Badge, Avatar, ProgressBar, Spinner, List
- [Navigation Components](./components/navigation.md) - Link, Router, Route, HypenApp, App

### Applicators (Styling)
- [Layout Applicators](./applicators/layout.md) - Flexbox, Grid, Positioning
- [Size Applicators](./applicators/size.md) - Width, Height, Min/Max sizing
- [Spacing Applicators](./applicators/spacing.md) - Padding, Margin, Gap
- [Typography Applicators](./applicators/typography.md) - Text styling, fonts, alignment
- [Color Applicators](./applicators/color.md) - Colors, backgrounds, opacity
- [Border Applicators](./applicators/border.md) - Borders, radius, outlines
- [Transform Applicators](./applicators/transform.md) - Transforms, rotation, scale
- [Effects Applicators](./applicators/effects.md) - Shadows, filters, blend modes
- [Transition Applicators](./applicators/transition.md) - Animations, transitions
- [Display Applicators](./applicators/display.md) - Display modes, visibility, overflow
- [Event Applicators](./applicators/events.md) - Click, input, and other events

## Quick Start

### Using Components

```typescript
import { app, hypen } from "@hypen-space/core";

const MyComponent = app
  .defineState({})
  .ui(hypen`
    Column {
      Heading(level: 1, "Welcome to Hypen")
      Text("Build reactive UIs with ease")
      Button { Text("Get Started") }
    }
  `);
```

### Using Applicators

```typescript
const StyledComponent = app
  .defineState({})
  .ui(hypen`
    Column
      .padding(16)
      .gap(8)
      .backgroundColor("#f5f5f5")
      .borderRadius(8) {

      Text("Styled text")
        .fontSize(18)
        .fontWeight("bold")
        .color("#333")
    }
  `);
```

## Component Naming Convention

All component names use **PascalCase** (e.g., `Button`, `TextField`, `ProgressBar`).

## Applicator Naming Convention

All applicators use **camelCase** (e.g., `.padding()`, `.backgroundColor()`, `.fontSize()`).

## Type System

### Prop Types
- **String**: Text values, URLs, identifiers
- **Number**: Numeric values (automatically converted to `px` for size properties)
- **Boolean**: True/false values
- **Array**: Lists of items (for `ForEach`, `Select` options, etc.)
- **Object**: Complex structured data

### Value Units
- Numbers are automatically converted to pixels for size properties (width, height, padding, etc.)
- Strings can use any CSS unit: `"100%"`, `"10rem"`, `"50vh"`, etc.
- Colors accept any CSS color format: hex, rgb, rgba, named colors

## Browser Support

Hypen components compile to standard HTML/CSS and support:
- Modern evergreen browsers (Chrome, Firefox, Safari, Edge)
- ES6+ JavaScript features
- CSS3 properties

## Contributing

To add new components or applicators:
1. Create the handler in the appropriate directory (`src/dom/components/` or `src/dom/applicators/`)
2. Register it in the registry (`index.ts`)
3. Add documentation in this `docs/` folder
4. Update the relevant category file

## Next Steps

- Explore [Layout Components](./components/layout.md) to learn about containers and positioning
- Check out [Form Components](./components/forms.md) for interactive elements
- See [Applicators Overview](./applicators/README.md) for styling options



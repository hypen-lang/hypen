# Hypen Bun Example App

A modern example application demonstrating Hypen UI renderer with Bun runtime and proper component-based architecture.

## Features

- 🚀 **Bun Runtime** - Fast, modern JavaScript runtime
- 🎨 **Hypen Components** - Component-based architecture with `.hypen` DSL files
- 📦 **TypeScript** - Full type safety with component logic files
- 🔥 **Hot Reloading** - Instant feedback during development
- 🌐 **REST API** - Built-in API endpoints with Bun.serve
- 💅 **Modern Design** - Beautiful gradient UI with smooth animations
- ⚡ **Reactive State** - Built-in state management with observables

## Getting Started

### Prerequisites

- [Bun](https://bun.sh) installed on your system

### Installation

```bash
# Install dependencies
bun install
```

### Development

```bash
# Start development server with hot reloading
bun run dev
```

The app will be available at `http://localhost:3000`

### Production

```bash
# Build for production
bun run build

# Run production server
bun run start
```

## Project Structure

```
example-bun/
├── server.ts                 # Bun server with routes and API
├── index.html                # HTML entry point
├── src/
│   ├── main.ts              # Application initialization
│   └── components/          # Hypen components
│       └── HomePage/
│           ├── component.hypen  # UI definition (Hypen DSL)
│           └── component.ts     # Logic and state management
├── package.json
└── tsconfig.json
```

## Component Architecture

Each Hypen component consists of two files:

### 1. `component.hypen` - UI Definition

Declarative UI using Hypen DSL:

```dart
Column {
  Text("Hello, @{state.name}")
    .fontSize(24)
    .fontWeight("bold")

  Button {
    Text("Click Me")
  }
    .onClick("@actions.handleClick")
}
.padding(24)
```

### 2. `component.ts` - Logic and State

Component logic with state management:

```typescript
import { app } from "@hypen-space/core";

type MyComponentState = {
  name: string;
  count: number;
};

export default app
  .defineState<MyComponentState>({
    name: "World",
    count: 0,
  })
  .onCreated(async (state) => {
    console.log("Component initialized");
  })
  .onAction("handleClick", async ({ state }) => {
    state.count++;
  })
  .build();
```

## Hypen DSL Features

### Components

- `Column` - Vertical layout container
- `Row` - Horizontal layout container
- `Text` - Text display
- `Button` - Interactive button
- `Input` - Text input field
- `List` - Dynamic list rendering

### Applicators (Styling)

Apply styles using dot notation:

```dart
Text("Styled text")
  .fontSize(16)
  .color("#667eea")
  .padding(12)
  .margin(8)
  .backgroundColor("white")
  .borderRadius(8)
```

### State Binding

Reference state values with `@{state.property}`:

```dart
Text("Count: @{state.count}")
Text("@{state.loading ? 'Loading...' : 'Ready'}")
```

### Actions

Connect events to actions:

```dart
Button { Text("Click") }
  .onClick("@actions.handleClick")

Input("@state.text")
  .onInput("@actions.updateText")
```

## API Endpoints

- `GET /` - Main application
- `GET /api/quote` - Random quote API

## Adding New Components

1. Create a new component directory:
   ```bash
   mkdir -p src/components/MyComponent
   ```

2. Create the UI file (`component.hypen`):
   ```dart
   Column {
     Text("My Component")
   }
   ```

3. Create the logic file (`component.ts`):
   ```typescript
   import { app } from "@hypen-space/core";

   type MyComponentState = {
     // your state here
   };

   export default app
     .defineState<MyComponentState>({})
     .build();
   ```

## Tech Stack

- **Runtime**: Bun
- **Language**: TypeScript
- **UI Framework**: Hypen (Rust + WASM)
- **HTTP Client**: Axios
- **Server**: Bun.serve (built-in)

## Learn More

- [Hypen Repository](https://github.com/hypen-lang/hypen)
- [Bun Documentation](https://bun.sh/docs)
- [TypeScript Documentation](https://www.typescriptlang.org/docs/)

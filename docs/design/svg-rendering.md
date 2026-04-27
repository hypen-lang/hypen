# SVG Rendering & Icons — Design Document

## Status: Shipped (Approach 1) / Future (Approach 2–3)

## Problem

Hypen has no SVG or icon support. The Canvas renderer has a toy `paintIcon()` with ~6 hardcoded shapes. iOS supports SF Symbols via `Image(src: "system:...")` but this is platform-specific. There is no cross-platform icon story.

## Streaming UI Constraint

Hypen is a **streaming UI** system. The engine runs on the server, generates patches, and sends them over WebSocket to thin client renderers. This is the fundamental constraint that shapes every design decision:

```
Server (Engine)                        Client (Thin Renderer)
────────────────                       ──────────────────────
Hypen DSL → Parser → IR → Reconciler
              ↓
         Patches ──── WebSocket ────→  Apply patches to DOM/Canvas/Native
              ↓
         StateUpdate ─ WebSocket ──→   Interpolate @{state.xxx} templates

         ← DispatchAction ──────────   User events sent upstream
```

**The client is a dumb patch consumer.** It knows how to `Create`, `SetProp`, `Insert`, `Remove` — nothing else. It has no component knowledge, no state logic, no reconciliation.

This means:
1. **Icon resolution cannot happen client-side** — the thin client shouldn't need resource bundles
2. **SVG content must travel through the patch protocol** — patches must carry everything the client needs to render
3. **The engine must emit SVG data in a format all renderers understand** — DOM, Canvas, iOS, Android

---

## Core Tension

SVG is fundamentally a **tree of elements** (`<svg>`, `<path>`, `<circle>`, `<g>`, etc.). Hypen's patch system operates on a flat element-type model where each node maps to one platform primitive. This creates a design fork:

**Do we model SVG as an opaque leaf (like `Image`) or as a composable subtree (like `Column`)?**

In streaming UI, this question becomes: **Does the server send SVG as a blob prop, or does it emit individual patches for each SVG sub-element?**

---

## Approach 1: Server-Resolved `Icon` with SVG Data in Patches ⭐ Shipped

### DSL Syntax

```hypen
Icon("heart")
Icon(@resources.heart)
Icon(name: "arrow-right", size: 24, color: red)
```

Icon names are resolved against a flat resource registry owned by the server.
The `@resources.*` reference form is the canonical way to point at a registered
resource; the bare string form is equivalent.

### Architecture

The **server** resolves resource names to SVG path data at render time. The
resolved SVG content flows through patches as props. The thin client receives
everything it needs to render — no resource registry required client-side.

```
Server                                  Client
──────                                  ──────
Icon(@resources.heart)
    ↓
ResourceRegistry.resolve("heart")
    ↓
IconData { view_box, paths: [...] }
    ↓
Patch: Create { id: "5", elementType: "Icon", props: {
    __iconPaths: [{ d: "M20.84...", fill: "none", stroke: "currentColor", ... }],
    __iconViewBox: "0 0 24 24",
    size: 24,
    color: "red"
}}
    ↓ WebSocket
                                        Apply patch:
                                        - DOM: inject <svg><path d="..."/></svg>
                                        - Canvas: new Path2D("M20.84...")
                                        - iOS: UIBezierPath from SVG path
                                        - Android: PathParser.createPathFromPathData()
```

### Resource Registration on the Server

Resources live **server-side**, co-located with the engine. The SDK builder
exposes three methods, uniform across TypeScript, Kotlin, Swift, and Go:

| Method | Purpose |
| --- | --- |
| `resources(map)` | Core primitive — flat `name → raw SVG string` map |
| `resourcesFile(path)` | Load a JSON file shaped as `{"name": "<svg>..."}` |
| `resourcesDir(dir)` | Scan a directory of `.svg` files, key by filename without extension |

```typescript
// TypeScript
const server = new RemoteServer()
  .module("Counter", counterModule)
  .ui("Counter", counterUI);

await server.resourcesDir("./resources");
// or: server.resources({ heart: "<svg>...</svg>", send: "<svg>...</svg>" });

await server.listen(3000);
```

The engine parses each SVG **once** at registration time into an `IconData`
record (a `viewBox` plus a `Vec<IconPath>`) and stores it in a
`ResourceRegistry`: a flat `IndexMap<String, IconData>`. There is no pack
namespace — all resources share one name space. If you need to mix multiple
icon sources, use a userland prefix convention (e.g. `"lucide-heart"` and
`"material-heart"`).

When the engine encounters `Icon("heart")` or `Icon(@resources.heart)`:
1. IR expansion walks each `Icon` node and extracts the name.
2. `ResourceRegistry::resolve(name)` returns the parsed `IconData`.
3. The engine injects `__iconPaths` and `__iconViewBox` into the element's
   props before reconciliation.
4. The resulting `Create` patch carries pre-resolved SVG — the client just
   renders it.

### Wire Format

The `Create` patch for an Icon carries the resolved SVG data via two reserved
props, `__iconPaths` and `__iconViewBox`:

```json
{
  "type": "create",
  "id": "node_5",
  "elementType": "Icon",
  "props": {
    "__iconViewBox": "0 0 24 24",
    "__iconPaths": [
      {
        "d": "M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z",
        "fill": "none",
        "stroke": "currentColor",
        "strokeWidth": 2,
        "strokeLinecap": "round",
        "strokeLinejoin": "round"
      }
    ],
    "size": 24,
    "color": "red"
  }
}
```

The double-underscore prefix marks these as engine-injected; they aren't part
of the author-facing prop surface. User-facing props like `size` and `color`
ride alongside untouched and are applied by the renderer on top of the
pre-resolved path data.

### Platform Rendering

| Platform    | How it renders the `Icon` patch                                    |
| ----------- | ------------------------------------------------------------------ |
| **Web DOM** | Creates `<svg>` with `<path>` elements from `__iconPaths` array    |
| **Canvas**  | `new Path2D(d)` + `ctx.fill()` / `ctx.stroke()`                   |
| **iOS**     | `UIBezierPath` from SVG path data (or `CGPath`)                    |
| **Android** | `PathParser.createPathFromPathData(d)` + `Canvas.drawPath()`      |

All platforms already have SVG path parsing capabilities. The structured paths
array is the most cross-platform-friendly wire format.

### Implementation Summary

1. **Engine** (`hypen-engine-rs/`):
   - `"Icon"` lives in `DEFAULT_PRIMITIVES`.
   - `ResourceRegistry` in `src/ir/icon.rs` holds a flat
     `IndexMap<String, IconData>`. `register(name, svg)` and
     `register_map(map)` parse SVG input at registration time via `parse_svg`.
   - During IR expansion, `resolve_icons_in_ir` walks the tree, looks up each
     `Icon` element's name (either `Value::Resource` or `Value::Static`), and
     injects `__iconPaths` / `__iconViewBox` into props.

2. **Server SDKs** — builder methods `resources` / `resourcesFile` /
   `resourcesDir` on each SDK's server/builder type, wired through to the
   engine's resource registration FFI (`registerResources`, etc.). Identical
   surface across TypeScript, Kotlin, Swift, and Go.

3. **DOM renderer** (`hypen-web/packages/web/src/dom/components/icon.ts`):
   - Handler reads `__iconPaths` and `__iconViewBox`, builds an `<svg>` with
     `<path>` children. No client-side resource lookup.

4. **Canvas renderer** (`hypen-web/packages/web/src/canvas/paint.ts`):
   - Generic path renderer that consumes `__iconPaths` and issues `Path2D` +
     stroke/fill calls.

5. **Native renderers** — iOS and Android receive the same pre-resolved props
   and route to their platform path APIs.

### Pros

- **Streaming-native**: client receives everything in the patch, no local resource resolution.
- **Thin client stays thin**: no icon bundles shipped to the renderer.
- SVG parsing happens exactly once per resource, on the server, in Rust.
- Matches how Flutter/SwiftUI/Compose handle icons (platform resolves, not the view layer).
- Pluggable via `resourcesDir` — drop SVGs in a folder, they're available as `@resources.*`.

### Cons

- No ability to compose arbitrary SVG trees in the DSL (see Approaches 2/3).
- Icons are a closed set per running server.
- Slightly larger patch payloads (path data strings, typically 100–300 bytes per icon).
- Server must have resources registered; can't use client-only icon CSS fonts.

---

## Approach 2: SVG Subtree via Patch Protocol

### DSL Syntax

```hypen
Svg(viewBox: "0 0 24 24", width: 24, height: 24) {
    Path(d: "M12 2L2 22h20L12 2z", fill: "currentColor")
    Circle(cx: 12, cy: 12, r: 10, stroke: blue)
    G(transform: "translate(5, 5)") {
        Rect(width: 10, height: 10, fill: red)
    }
}
```

### Architecture in Streaming Context

SVG elements become first-class Hypen primitives. The engine emits **individual patches** for each SVG sub-element, just like it does for `Column` > `Text`:

```json
[
  { "type": "create", "id": "10", "elementType": "Svg", "props": { "viewBox": "0 0 24 24" } },
  { "type": "create", "id": "11", "elementType": "Path", "props": { "d": "M12 2L2...", "fill": "currentColor" } },
  { "type": "create", "id": "12", "elementType": "Circle", "props": { "cx": 12, "cy": 12, "r": 10 } },
  { "type": "insert", "parentId": "10", "id": "11", "beforeId": null },
  { "type": "insert", "parentId": "10", "id": "12", "beforeId": null },
  { "type": "insert", "parentId": "root", "id": "10", "beforeId": null }
]
```

This fits naturally with the streaming model — **the client doesn't need to know SVG is special.** It just creates elements and inserts them into parents. The only platform-specific part is how `Create` maps to a DOM/Canvas/native call.

### The `createElementNS` Problem (Web DOM)

Current `ComponentHandler`:
```typescript
interface ComponentHandler {
  create(): HTMLElement;  // ← SVG elements are NOT HTMLElement
}
```

SVG elements require `document.createElementNS("http://www.w3.org/2000/svg", "path")` which returns `SVGElement`, not `HTMLElement`.

**Resolution options:**
- **a)** Widen to `Element` (parent of both `HTMLElement` and `SVGElement`) — clean but ripples through the renderer
- **b)** Component handler returns `{ element, namespace?: string }` — renderer calls `createElementNS` when namespace is present
- **c)** SVG component handlers use `createElementNS` internally and cast to `HTMLElement` — hacky but works since we only use common `Element` methods

**Recommended: Option (a).** The renderer's `nodes` map becomes `Map<string, Element>`, and applicators work on `Element`. Since Hypen applicators use `element.style.*` (which exists on `HTMLElement` but not `SVGElement`), SVG applicators must use `setAttribute()` instead. This is a natural split — SVG attributes like `fill`, `stroke`, `d`, `cx` are attributes, not CSS properties.

### SVG Attribute Applicators

SVG elements use `setAttribute` for most properties, not `element.style`:

```typescript
// New: SVG-aware applicator
const svgApplicators = {
  d: (el, val) => el.setAttribute("d", val),
  fill: (el, val) => el.setAttribute("fill", val),
  stroke: (el, val) => el.setAttribute("stroke", val),
  cx: (el, val) => el.setAttribute("cx", String(val)),
  cy: (el, val) => el.setAttribute("cy", String(val)),
  r: (el, val) => el.setAttribute("r", String(val)),
  viewBox: (el, val) => el.setAttribute("viewBox", val),
  transform: (el, val) => el.setAttribute("transform", val),
  // ...
};
```

The applicator registry can detect SVG context by checking `element instanceof SVGElement` or by element type prefix.

### Naming Collision: `Text`

`Text` already exists as a Hypen primitive (renders `<span>`). SVG `<text>` is different.

**Recommended: `SvgText`** — it's unambiguous and requires no parser changes. In practice, `<text>` in SVG is rare compared to `<path>`, `<circle>`, `<rect>`.

### Reactive SVG in Streaming Context

This approach enables reactive bindings on individual SVG elements:

```hypen
Path(d: "@{state.morphPath}", fill: "@{state.color}")
Circle(r: "@{state.radius}")
```

The engine tracks dependencies on `state.morphPath`, `state.radius`, etc. When state changes, it emits `SetProp` patches for just the affected SVG attributes — sent over WebSocket to the client. The client applies them like any other `SetProp`. **This works identically to how text content updates work in streaming mode.**

### Changes Required

1. **Engine**: Add `"Svg"`, `"Path"`, `"Circle"`, `"Rect"`, `"Line"`, `"G"`, `"Polygon"`, `"Polyline"`, `"Ellipse"`, `"SvgText"` to primitives
2. **DOM renderer**: Widen `ComponentHandler` interface from `HTMLElement` to `Element`; SVG handlers use `createElementNS`
3. **DOM applicators**: SVG attribute applicators using `setAttribute` instead of `style.*`
4. **Canvas renderer**: SVG primitive painters using `Path2D`, `ctx.arc()`, `ctx.rect()`, etc.
5. **Native renderers**: Map SVG primitives to platform path/shape APIs

### Pros

- **Naturally streaming** — SVG sub-elements are just more patches, no special handling
- Full expressiveness — arbitrary vector graphics in the DSL
- Reactive bindings on individual SVG elements work through existing patch mechanism
- Enables data visualization, animated graphics, interactive SVGs

### Cons

- Significant surface area: ~10 new primitives across 4+ renderers
- `ComponentHandler` interface change (`HTMLElement` → `Element`)
- SVG applicators need separate path from CSS applicators
- More patches over the wire for complex SVGs (a 20-path icon = 40+ patches vs 1 patch in Approach 1)
- `Text` naming collision (resolved via `SvgText`)

---

## Approach 3: Hybrid — Server-Resolved `Icon` + `Svg` Subtree

### DSL Syntax

```hypen
// Simple icon usage (90% of cases) — server resolves, sends as blob
Icon("heart", size: 24, color: red)

// Composable SVG (10% of cases) — full subtree in patches
Svg(viewBox: "0 0 24 24", width: 200, height: 200) {
    Circle(cx: "@{state.x}", cy: "@{state.y}", r: 20, fill: blue)
    Path(d: "@{state.chartPath}", stroke: green)
}
```

### How It Fits Streaming

- **`Icon`** = Approach 1. Server resolves icon name → sends path data as a single `Create` patch with `paths` prop. Client renders from pre-resolved data. Optimized for the common case.
- **`Svg` subtree** = Approach 2. Engine emits individual `Create`/`Insert` patches for each SVG element. Enables reactive bindings. Used when you need composable, dynamic vector graphics.

The distinction matters for **wire efficiency**:

| Scenario | Icon (Approach 1) | SVG Subtree (Approach 2) |
| -------- | ------------------ | ------------------------ |
| Lucide heart icon (1 path) | 1 patch | 3 patches (Svg + Path + Insert) |
| Complex logo (20 paths) | 1 patch | 41 patches |
| Animated chart | N/A (static) | Incremental `SetProp` patches on path `d` |
| Reactive color | `SetProp` on `color` | `SetProp` on `fill` per element |

### Pros

- Best of both worlds: efficient icons + expressive SVG
- `Icon` keeps wire overhead minimal for the common case
- `Svg` subtree enables data-viz and animation use cases
- Both are streaming-native

### Cons

- Two SVG systems to maintain
- More total surface area than either approach alone

---

## Architectural Decisions

### Q1: Where does icon resolution happen?

**Answer: Server-side.** In streaming UI, the engine is the authority. The
server resolves names to SVG path data through a `ResourceRegistry`. Path data
flows through patches to the client. The thin client never needs resource
bundles.

**Fallback for client-only mode:** When Hypen runs entirely in the browser (no
server), the `web-engine` package registers resources against the in-browser
WASM engine. The resolution still happens at the engine level, not the
renderer level — it's just that the engine is now in-browser.

### Q2: Resources — format and distribution?

**Input format:** flat `name → raw SVG string` maps. The engine owns SVG
parsing and normalizes input into internal `IconData` records at registration
time. Users never construct `IconData` or `IconPath` directly; those are
engine-internal types.

**Distribution:** three equivalent entry points per SDK:
- `resources(map)` — inline, useful for tests and small sets.
- `resourcesFile(path)` — load a JSON map from disk.
- `resourcesDir(dir)` — scan a directory of `.svg` files; each filename
  (minus the extension) becomes a resource name.

There is no "pack" concept and no namespace. If multiple sources need to
coexist, prefix keys in userland (e.g. `"lucide-heart"` vs `"material-heart"`).

### Q3: Wire format for SVG path data?

**Structured paths array** carried as the `__iconPaths` prop on the `Create`
patch, alongside `__iconViewBox`:

```json
{
  "__iconViewBox": "0 0 24 24",
  "__iconPaths": [
    { "d": "M20.84...", "fill": "none", "stroke": "currentColor", "strokeWidth": 2, "strokeLinecap": "round", "strokeLinejoin": "round" },
    { "d": "M5 12h14",  "fill": "none", "stroke": "currentColor", "strokeWidth": 2, "strokeLinecap": "round", "strokeLinejoin": "round" }
  ]
}
```

Why structured over raw SVG markup:
- Canvas renderer can directly use `d` with `Path2D` — no XML parsing.
- iOS/Android can directly use `d` with their path APIs — no SVG DOM parsing.
- Web DOM constructs `<path>` elements from the data — trivial.
- Smaller than full SVG markup (no `<svg>`, `xmlns`, redundant attributes).
- Engine resolves root-element inheritance (Heroicons-style bare `<path>`s
  under a styled `<svg>` root) once during parse, so every renderer sees the
  same fully-resolved presentation attributes.

### Q4: How does `Icon` color/size reactivity work in streaming?

If `Icon` color is state-bound (`Icon("heart", color: "@{state.themeColor}")`):
1. Engine tracks dependency on `state.themeColor`.
2. On state change, engine emits `SetProp { id: "5", name: "color", value: "blue" }`.
3. Client receives patch, updates the rendered SVG's `stroke` attribute.
4. **The `__iconPaths` data doesn't need to be re-sent** — only the changed prop.

This is identical to how any other prop update works in streaming.

### Q5: SVG path parser for Canvas/native?

Only the server parses SVG (once, at registration). Renderers only consume
`d` strings:
- **Canvas**: `Path2D` constructor accepts SVG `d` strings natively.
- **iOS**: uses a small path-data parser to feed `UIBezierPath` / `CGPath`.
- **Android**: `PathParser.createPathFromPathData()` handles SVG `d` natively.

---

## Recommendation

**Phase 1: Approach 1 — Server-Resolved `Icon` Primitive (shipped)**

Solves the immediate need (icons in UI) with streaming-native design:
- Server resolves resource name → parsed SVG path data at registration time.
- Single `Create` patch carries all rendering data via `__iconPaths` / `__iconViewBox`.
- Client renders from pre-resolved props — no resource registry needed client-side.
- Works for DOM, Canvas, iOS, Android with no SVG parsing on the client.

Shipped surface:
- Engine: `"Icon"` in `DEFAULT_PRIMITIVES` + `ResourceRegistry` in `src/ir/icon.rs`.
- Server SDKs: `resources` / `resourcesFile` / `resourcesDir` on all four SDK builders.
- DOM: `icon.ts` component handler.
- Canvas: generic path renderer replacing the previous hardcoded `paintIcon`.

**Phase 2: Approach 2 — `Svg` Subtree (if needed)**

When users need composable, reactive SVG (data-viz, animations, morphing):
- SVG elements as first-class primitives with individual patches
- Enables `Path(d: "@{state.chartPath}")` reactive bindings
- Requires `ComponentHandler` interface change (`HTMLElement` → `Element`)
- SVG attribute applicators

**Why not Phase 2 first?** For the 90% case (icons), emitting 40+ patches for a 20-path icon when 1 patch suffices is wasteful over the wire. `Icon` with server-resolved path data is the right primitive for streaming UI. `Svg` subtree is for when you genuinely need per-element reactivity.

Each phase is independently shippable and backwards-compatible.

---

## Migration from the Old API

The initial implementation shipped with an `IconPack` / `IconRegistry` model
and per-SDK `.icons()` / `.iconsFromDir()` / `.iconFromFile()` builder
methods, plus a bundled `@hypen-space/icons-lucide` NPM package. That surface
has been removed. The DSL (`Icon("heart")`, `Icon(@resources.heart)`) is
unchanged — only server-side registration moved.

### TypeScript

```typescript
// Before
import lucideIcons from "@hypen-space/icons-lucide";
server.icons(lucideIcons);
server.iconsFromDir("./icons");

// After
server.resources({ heart: "<svg>...</svg>", send: "<svg>...</svg>" });
await server.resourcesDir("./resources");
```

### Kotlin

```kotlin
// Before
HypenServer { icons(lucidePack); iconsFromDir("./icons") }

// After
val server = HypenServer {
    module("App", instagramModule)
    route("/", "App")
    resourcesDir("./resources")
}
```

### Swift

```swift
// Before
_ = try? server.icons(lucidePack)
_ = try? server.iconsFromDir("./icons")

// After
_ = try? server.resourcesDir("./resources")
```

### Go

```go
// Before
server.Icons(lucidePack)
server.IconsFromDir("./icons")

// After
server.ResourcesDir("./resources")
```

**What's gone:**

- `IconPack`, `IconRegistry` (type alias), and the public `IconData` /
  `IconPath` exports. `IconData` and `IconPath` still exist inside the engine
  crate as internal types used by `ResourceRegistry` and `parse_svg`, but are
  no longer part of any SDK's public surface — you never construct them.
- `Engine::register_icon_pack`, `parse_svg_to_json`, `load_icons_from_dir`,
  `load_icon_from_file`, the UniFFI `register_icon_pack` /
  `register_resources_from_dir` entry points, WASM `registerIconPack`, and
  the WASI `hypen_register_icon_pack` symbol.
- `.icons()`, `.iconsFromDir()`, `.iconFromFile()` on every SDK's server
  builder.
- The standalone per-SDK SVG parsers (`SvgParser.kt`, `SvgParser.swift`,
  `svg.ts`, `svg.go`) — the engine is now the single source of truth for SVG
  parsing.
- The `@hypen-space/icons-lucide` NPM package.

# Architecture Internals

This document describes the internal architecture of the Hypen Engine, including the reactive system, reconciliation algorithm, IR expansion, and patch generation.

## Table of Contents

- [System Overview](#system-overview)
- [IR System](#ir-system)
- [Reactive System](#reactive-system)
- [Reconciliation Algorithm](#reconciliation-algorithm)
- [Patch Generation](#patch-generation)
- [Instance Tree](#instance-tree)
- [Component Resolution](#component-resolution)
- [State Management](#state-management)

---

## System Overview

The engine follows a unidirectional data flow:

```
Hypen DSL Source
      │
      ▼
┌─────────────┐
│   Parser    │  Chumsky combinator parser
│  (AST)      │  ComponentSpecification → arguments, applicators, children
└──────┬──────┘
       │ ast_to_ir_node()
       ▼
┌─────────────┐
│   IR        │  Element / IRNode (ForEach, Conditional, Router)
│  Expansion  │  Component registry, slot resolution, Tailwind expansion
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Reactive   │  DependencyGraph: path → NodeId mapping
│  System     │  Prefix index for O(log n) affected-node lookup
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Reconciler │  Keyed diffing with LIS algorithm
│  (diff.rs)  │  InstanceTree management
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Patches    │  Create, SetProp, SetText, Insert, Move, Remove
│  (output)   │  Platform-agnostic mutation instructions
└──────┬──────┘
       │
       ▼
┌─────────────┐
│  Renderer   │  DOM, Canvas, iOS, Android, Remote UI
│  (platform) │  Applies patches to platform objects
└─────────────┘
```

## IR System

### Source Files

- `src/ir/node.rs` — Core types: `IRNode`, `Element`, `Value`, `Props`
- `src/ir/expand.rs` — AST-to-IR lowering, Tailwind expansion, binding extraction
- `src/ir/component.rs` — Component registry, resolution, passthrough/lazy components

### IRNode Enum

Control flow is represented as first-class IR nodes:

```rust
pub enum IRNode {
    Element(Element),           // Regular UI element
    ForEach { ... },            // Iteration construct
    Conditional { ... },        // When/If construct
    Router { ... },             // URL-based routing with Route children
}
```

This design enables exhaustive pattern matching in the reconciler, so the compiler catches any missing control flow handling.

### Value Types

Props can hold five types of values:

```rust
pub enum Value {
    Static(serde_json::Value),       // Literal: "hello", 42, true
    Binding(Binding),                 // @{state.user.name}
    TemplateString {                  // "Count: @{state.count}"
        template: String,
        bindings: Vec<Binding>,
    },
    Action(String),                   // @actions.signIn
    Resource(String),                 // @resources.heart (resolved via ResourceRegistry)
}
```

### Props (Arc-Wrapped)

Props use `Arc<IndexMap<String, Value>>` for O(1) cloning during reconciliation:

```rust
pub struct Props(Arc<PropsMap>);
```

Copy-on-write semantics: calling `make_mut()` clones the inner map only if there are multiple references. This means cloning an element during reconciliation is nearly free, while mutations only pay the cost when necessary.

### AST-to-IR Conversion

The `ast_to_ir_node()` function detects control flow components by name:

```
"ForEach"    → IRNode::ForEach { source, item_name, key_path, template, props }
"When"       → IRNode::Conditional { value, branches, fallback }
"If"         → IRNode::Conditional { value, [true-branch], fallback }
"Router"     → IRNode::Router { location, routes, fallback }
"List"/"Grid" → IRNode::Element wrapping an IRNode::ForEach child (so the
                renderer keeps the container element type for native list
                virtualization while iteration goes through ForEach semantics)
other        → IRNode::Element(element)
```

During conversion:
1. Arguments are mapped to props (named or positional)
2. Applicators become props with dotted keys (e.g., `.fontSize(18)` → `fontSize.0: 18`)
3. `.tw()` applicators are expanded to individual CSS properties via `hypen-tailwind-parse`
4. `@{state.xxx}` strings are parsed into `Value::Binding`
5. `@actions.xxx` strings become `Value::Action`
6. Template strings with mixed bindings become `Value::TemplateString`

---

## Reactive System

### Source Files

- `src/reactive/binding.rs` — Binding parsing and representation
- `src/reactive/graph.rs` — Dependency graph with prefix index

### Binding Model

Bindings represent reactive references to state paths:

```rust
pub struct Binding {
    pub source: BindingSource,  // State, Item, or DataSource(provider)
    pub path: Vec<String>,      // ["user", "name"]
}
```

Three sources:
- `BindingSource::State` — `@{state.user.name}` references module state
- `BindingSource::Item` — `@{item.name}` references the current iteration item in a ForEach
- `BindingSource::DataSource(provider)` — `@spacetime.messages` references a registered data-source context, populated by the host via `set_context(name, data)`. Note: data-source bindings use the `@provider.path` syntax (no `@{...}` wrapper); the parser rejects `@{provider.path}` to prevent typos from silently becoming data-source references.

Module scope is **not** a binding source — it's an orthogonal `module_scope: Option<String>` field on `Element` and control-flow nodes, applied at reconcile time. See ENGINE_CONTRACT.md §11 for the full namespacing rules.

### Dependency Graph

The `DependencyGraph` maps state paths to the nodes that depend on them:

```rust
pub struct DependencyGraph {
    dependencies: IndexMap<String, IndexSet<NodeId>>,     // path → nodes
    node_bindings: IndexMap<NodeId, IndexSet<String>>,    // node → paths
    prefix_index: BTreeMap<String, IndexSet<String>>,     // prefix → full paths
}
```

#### Registration

When a node with bindings is created, each binding's path is registered:

```
Text("@{state.user.name}")
  → registers dependency: "user.name" → node_42
  → prefix index entries: "user" → {"user.name"}, "user.name" → {"user.name"}
```

#### Affected Node Lookup

When a state path changes, `get_affected_nodes(changed_path)` finds all nodes that need re-rendering using three strategies:

1. **Exact match**: Nodes depending on exactly `changed_path`
2. **Parent paths**: Nodes depending on any prefix of `changed_path`
   - If `"user.name"` changes, nodes depending on `"user"` are affected
3. **Child paths**: Nodes depending on any path starting with `changed_path`
   - If `"user"` changes, nodes depending on `"user.name"` and `"user.email"` are affected

The prefix index (`BTreeMap`) makes child-path lookups O(log n) instead of O(n).

#### Example

```
Dependencies registered:
  node_1 → "user"
  node_2 → "user.name"
  node_3 → "user.email"
  node_4 → "posts"

State change: "user" changed
  → Exact match: node_1
  → Child paths: node_2, node_3 (via prefix index)
  → Result: {node_1, node_2, node_3}

State change: "user.name" changed
  → Exact match: node_2
  → Parent paths: node_1 (depends on "user", a prefix of "user.name")
  → Result: {node_1, node_2}

State change: "user.email" changed
  → Exact match: node_3
  → Parent paths: node_1
  → Result: {node_1, node_3}
```

### Path-Based (Not Value-Based)

The engine tracks **which paths changed**, not **what values changed**. The dependency graph maps paths to nodes, and once a path is in the dirty set the engine re-resolves every dependent binding regardless of whether the new value differs from the old one.

How that interacts with value-deduplication depends on which API the host uses:

- **`Engine::update_state(scope, patch)`** — the engine merges the patch into the slot's state, then compares the new state to the previous one (`engine_core.rs::update_state`) and returns `false` (no-op, no render) if nothing actually changed. Setting `state.count = 5` when it's already 5 via this path is a no-op.
- **`Engine::notify_state_change(&change)`** — the host has already mutated its observable state and pre-computed which paths it touched. The engine trusts the path list and dirties whatever's bound to it; there is no value comparison. Setting `state.count = 5` when it's already 5 via this path **does** trigger a re-render. This is correct for hosts whose proxy/observer may fire multiple times for the same write.
- **`Engine::update_state_sparse(scope, paths, values)`** — same value-comparison semantics as `update_state`: returns `false` if the merged state matches the previous state.

Hosts that need strict no-op behavior should either use the `update_state` family or implement their own write-coalescing layer above `notify_state_change`. See ENGINE_CONTRACT.md §5 for the full method contracts.

---

## Reconciliation Algorithm

### Source Files

- `src/reconcile/diff.rs` — Core diffing algorithm (~1900 lines)
- `src/reconcile/tree.rs` — Instance tree data structure
- `src/reconcile/patch.rs` — Patch type definitions

### Overview

Reconciliation compares the new IR tree against the existing instance tree and generates the minimal set of patches to bring the instance tree up to date.

Single entry point: `reconcile_ir(tree, ir_node, parent_id, state, deps)` for
`IRNode`-based trees (first-class control flow). The legacy `Element`-based
`reconcile()` was deleted; tests that need to reconcile a bare `Element` must
wrap it in `IRNode::Element(...)` and call `reconcile_ir`. See `reconcile/diff.rs`.

### Keyed Children Diffing

The algorithm for reconciling children with keys:

**Phase 1: Match children**
```
Old children: [A, B, C, D, E]  (by key)
New children: [B, D, A, F]     (by key)

Build maps:
  old_keyed: { A→node1, B→node2, C→node3, D→node4, E→node5 }

For each new child:
  B → found in old_keyed → reconcile node2, remove from map
  D → found in old_keyed → reconcile node4, remove from map
  A → found in old_keyed → reconcile node1, remove from map
  F → not found → create new node
```

**Phase 2: Minimize moves with LIS**

The Longest Increasing Subsequence algorithm determines which nodes are already in correct relative order and don't need Move patches.

```
New children: [B, D, A, F]
Old positions: [1, 3, 0, None]  (None = newly created)

LIS of old positions: [1, 3]  → indices 0, 1 (B, D are in order)

Nodes NOT in LIS need Move patches:
  A (index 2) → Move
  F (index 3) → Insert (new)
```

**Phase 3: Cleanup**

Unused old children (C, E) are removed with `Remove` patches and their dependencies are cleaned from the graph.

### Control Flow Reconciliation

ForEach and Conditional nodes have special reconciliation paths:

**ForEach:**
1. Re-evaluate the source binding to get the current array
2. For each item, replace `@{item.*}` bindings with actual values
3. Generate keys using `key_path` or default `{item_name}-{index}`
4. Reconcile generated children against existing children using keyed diffing

**Conditional:**
1. Re-evaluate the condition value
2. Match against branch patterns
3. If the matching branch changed, remove old branch children and create new ones
4. If the same branch matches, reconcile children in place

### Transparent Control Flow Nodes

Control flow nodes (`__ForEach`, `__Conditional`) exist in the instance tree but are **transparent** to the DOM. Their children render directly into the control flow node's parent. This means:

```hypen
Column {
    ForEach(items: @{state.items}) {
        Text(@{item.name})
    }
}
```

Results in the DOM structure:
```
Column
├── Text("Alice")   ← direct child of Column, not of __ForEach
├── Text("Bob")
└── Text("Charlie")
```

---

## Patch Generation

### Patch Types

```rust
pub enum Patch {
    Create { id, element_type, props },   // Create a new node
    SetProp { id, name, value },          // Update a single property
    RemoveProp { id, name },              // Drop a property from a node
    SetText { id, text },                 // Update text content (reserved; not currently emitted)
    Insert { parent_id, id, before_id },  // Insert into parent
    Move { parent_id, id, before_id },    // Move to new position
    Remove { id },                        // Remove from tree
}
```

Note: text changes are emitted as `SetProp { name: "0", … }` on the
primary path; `SetText` is reserved for renderers that distinguish
text-nodes from prop updates and is not currently emitted by the
reconciler. See ENGINE_CONTRACT.md §10.1 for the wire-format details.

All patches use string IDs (serialized `NodeId`). `before_id` is `Option<String>` — `None` means append to end.

### Serialization

Patches are serialized as JSON with `camelCase` tag names:

```json
[
    { "type": "create", "id": "n1", "elementType": "Text", "props": { "text": "Hello" } },
    { "type": "insert", "parentId": "root", "id": "n1", "beforeId": null },
    { "type": "setProp", "id": "n1", "name": "text", "value": "World" }
]
```

### Event Handling

Event handling (click, input, etc.) is **not** part of the patch system. Events are managed at the renderer level. The engine passes event-related props (e.g., `onClick: @actions.increment`) as regular props, and the renderer is responsible for attaching event listeners.

---

## Instance Tree

### Source File

- `src/reconcile/tree.rs`

### Structure

The instance tree is a SlotMap-based tree of `InstanceNode` values:

```rust
pub struct InstanceTree {
    nodes: SlotMap<NodeId, InstanceNode>,
    root: Option<NodeId>,
}

pub struct InstanceNode {
    pub id: NodeId,
    pub element_type: String,
    pub props: ResolvedProps,                            // Arc<IndexMap<String, Value>> — O(1) clone into Create patches
    pub raw_props: Props,                                // Unresolved (with bindings)
    pub ir_node_template: Option<Arc<IRNode>>,           // For ForEach/Conditional re-rendering
    pub control_flow: Option<ControlFlowKind>,
    pub key: Option<String>,
    pub parent: Option<NodeId>,
    pub children: im::Vector<NodeId>,
}
```

Key properties:
- `props` contains **resolved** values (bindings evaluated against state)
- `raw_props` contains **unresolved** values (with `Binding` variants intact) for change detection
- `ir_node_template` stores the original IRNode for control flow nodes so they can be re-rendered on state change
- `children` uses `im::Vector` for O(1) structural sharing during clones

### NodeId

`NodeId` is a SlotMap key, providing:
- Stable identity across re-renders
- O(1) lookup
- Automatic reuse of removed slots
- Type-safe (can't mix up with other IDs)

---

## Component Resolution

### Source File

- `src/ir/component.rs`

### Component Types

| Type | Behavior |
|------|----------|
| **Regular** | Template function expands props into an element tree |
| **Passthrough** | Props preserved, children expanded, no template transform |
| **Lazy** | Children not expanded until explicitly requested |

### Resolution Flow

```
Component name ("ProfileCard")
      │
      ▼
  ComponentRegistry.resolve()
      │
      ├── Found in registry? → Use registered component
      │
      └── Not found? → Call ComponentResolver callback
            │
            ├── Resolver returns source code → Parse & expand
            │
            └── Resolver returns None → Keep as-is (primitive)
```

The `ComponentResolver` is a callback set by the host that resolves component names to source code. This enables file-based component discovery and lazy loading:

```typescript
engine.setComponentResolver((name, context) => {
    const source = readComponentFile(name);
    return source ? { source, path: `/components/${name}`, passthrough: false, lazy: false } : null;
});
```

---

## State Management

### Source Files

- `src/state.rs` — StateChange type and tracking
- `src/engine.rs` — State update orchestration

### Update Flow

```
Host calls engine.updateState({ count: 42 })
      │
      ▼
  Merge state patch into current state
      │
      ▼
  Extract changed paths: ["count"]
      │
      ▼
  DependencyGraph.get_affected_nodes("count")
      │
      ▼
  Re-reconcile affected nodes
      │
      ▼
  Generate and emit patches
```

### Multi-Module with Engine-Native Scoping

The engine supports multiple named modules alongside a primary module. When the engine renders a `module Search { ... }` component, it automatically scopes `@{state.xxx}` bindings inside that subtree to the Search module's state.

State, the instance tree, and the dependency graph all live on `EngineCore` (`engine_core.rs`), which is the shared core wrapped by every binding (native `Engine`, `WasmEngine`, `WasiEngine`, UniFFI `HypenEngine`):

```rust
pub(crate) struct EngineCore {
    pub module: Option<ModuleInstance>,                  // Primary slot
    pub modules: IndexMap<String, ModuleInstance>,       // Named slots (lowercased keys)
    pub action_module_map: IndexMap<String, Option<String>>,  // action → owning scope
    // tree, dependencies, scheduler, data_sources, registries, …
}
```

`action_module_map` records which slot owns each action: `None` for primary-slot actions (installed via `set_module`), `Some(name)` for named-slot actions (installed via `register_module`). Both methods evict their previous entries on re-installation to prevent stale routing. The shared `action_scope_for(name)` lookup flattens both "primary slot" and "unknown action" to `None`, which is the right default for follow-up `update_state` calls.

Register named modules via `engine.register_module("search", instance)`. The component expansion detects `module X { ... }` declarations and propagates `module_scope` to all descendant elements. During reconciliation, the engine swaps the state context for scoped elements. Cross-module communication uses `GlobalContext` at the SDK layer. See ENGINE_CONTRACT.md §4 for the full slot semantics.

### Revision Tracking

Each state update increments a revision counter. This is used by the Remote UI protocol to ensure patches are applied in order:

```rust
pub fn revision(&self) -> u64
```

The serialization layer can include revision numbers and optional integrity hashes for clients to verify patch ordering.

# Hypen Engine Contract

Canonical reference for SDK implementors porting or debugging a Hypen engine
binding. Authoritative source: `hypen-engine-rs/src/`. Citations are given as
`path:line` relative to the repo root.

This document describes the contract that every binding (native Rust, JS,
WASI, UniFFI, and future ports) must honor. When a binding disagrees with this
document, the source code wins — file a bug.

---

## 1. Overview

The Hypen engine is a reactive reconciler. It **owns**:

- The intermediate-representation (IR) pipeline: AST → IR expansion, icon
  resolution, and component resolution.
- The per-render-cycle virtual instance tree (`InstanceTree`) and its keyed
  diffing algorithm.
- A path-based dependency graph that maps state / data-source paths to the
  nodes that read them.
- A single shared state tree expressed as `serde_json::Value`, partitioned
  across one optional "primary" module slot and a map of "named" module slots.
- A scheduler that turns dirty-node sets into minimal patch batches.

The engine does **not** own:

- **User action handler logic.** `Action { name, payload }` routing is the
  engine's job; running the handler is the host SDK's job. The engine never
  mutates state on its own.
- **State shape / typing.** All state is `serde_json::Value`. Typed
  wrappers live in SDKs.
- **A render loop / event loop.** Each binding is pulled by the host (via
  callback, JSON buffer, or UniFFI `Vec<Patch>` return).
- **The lifecycle of module *instances*.** `ModuleInstance` stores an
  `on_created`/`on_destroyed` callback pair, but the engine never calls them.
  The host is responsible for `mount()` / `unmount()`.
- **Renderer semantics.** Patches are a flat wire format; how they become
  pixels is the renderer's problem.

---

## 2. Data flow

```
                ┌────────────────────────────────────┐
                │          Host / SDK                │
                │                                    │
                │  ┌── ComponentResolver (cb) ──┐    │
                │  │   (name, ctx_path) ->      │    │
                │  │    ResolvedComponent       │    │
                │  └────────────────────────────┘    │
                │  ┌── Data sources ────────────┐    │
                │  │   set_context(name, json)  │    │
                │  └────────────────────────────┘    │
                │  ┌── Module state / actions ──┐    │
                │  │   set_module,               │   │
                │  │   register_module,          │   │
                │  │   update_state[/_sparse],   │   │
                │  │   dispatch_action           │   │
                │  └────────────────────────────┘    │
                └──────────────┬─────────────────────┘
                               │
 Hypen DSL ──► hypen_parser ──►│
                               ▼
                    ComponentSpecification (AST)
                               │
                      ir::expand::ast_to_ir_node
                               ▼
                            IRNode
           ┌───────────────────┼────────────────────┐
           ▼                                        ▼
   ComponentRegistry                       ResourceRegistry
   .expand_ir_node (                       .resolve_icons_in_ir
   component templates,                    (injects __iconPaths /
   module_scope propagation)               __iconViewBox)
           │                                        │
           └───────────────────┬────────────────────┘
                               ▼
              auto_register_scoped_modules
              (engine_core.rs:450)
                               ▼
                reconcile::diff::reconcile_ir_with_ds
                ├─► rebuilds InstanceTree
                ├─► rebuilds DependencyGraph
                └─► emits Vec<Patch>
                               ▼
                       Patch[]  ─►  Renderer
```

On subsequent state updates the flow is shorter:

```
host.update_state(scope, patch)
        │
        ▼
EngineCore::schedule_dirty_for_paths (engine_core.rs:232)
        │
        ▼
render::render_dirty_nodes_full (render.rs:46)
  (per-node: prop re-resolve, or
   reconcile_ir_node_impl for control-flow / list nodes)
        │
        ▼
      Patch[]  ─►  Renderer
```

Host injection points (marked ▲ in the flow above):

| Where | How | Code |
|-------|-----|------|
| Components | `set_component_resolver` + `register_component` | `engine_core.rs:76`, `engine_core.rs:71` |
| Resources (SVG icons) | `register_resource[s]` | `engine_core.rs:85` |
| Primary module state | `set_module` + `update_state(None, …)` | `engine_core.rs:103`, `engine_core.rs:162` |
| Named module state | `register_module` + `update_state(Some(name), …)` | `engine_core.rs:122`, `engine_core.rs:162` |
| Data sources | `set_context` / `remove_context` | `engine_core.rs:273`, `engine_core.rs:318` |
| Actions | bindings: `on_action` (js) / `register_action` (wasi, uniffi) / `on_action` (native) | `wasm/js.rs:776`, `wasm/wasi.rs:748`, `uniffi/mod.rs:437`, `engine.rs:167` |

---

## 3. The shared core (`EngineCore`)

`hypen-engine-rs/src/engine_core.rs` defines the struct wrapped by every
binding (`Engine`, `WasmEngine`, `WasiEngine`, `HypenEngine`). All state-,
module-, and render-management lives here; the wrappers add only the binding-
specific plumbing (callbacks, buffers, locks).

### 3.1 Fields (`engine_core.rs:22`)

```rust
pub(crate) struct EngineCore {
    pub component_registry: ComponentRegistry,
    pub resource_registry: ResourceRegistry,
    pub module: Option<ModuleInstance>,                        // primary slot
    pub modules: IndexMap<String, ModuleInstance>,             // named slots (lowercased keys)
    pub tree: InstanceTree,
    pub dependencies: DependencyGraph,
    pub scheduler: Scheduler,
    pub revision: u64,
    pub data_sources: IndexMap<String, serde_json::Value>,
    pub action_module_map: IndexMap<String, Option<String>>,   // action name -> owning scope
    pub registered_actions: Vec<String>,                       // used by polling bindings only
}
```

`action_module_map` value semantics: `None` means the action is owned by the
primary slot (installed via `set_module`); `Some(name)` means it's owned by
the named module under that lowercased key. `action_scope_for` flattens both
"unknown action" and "primary-slot action" to `None` externally — see §4.5.

### 3.2 Methods

#### `new() -> Self`
Construct an empty core. No modules, no tree, revision = 0. Inexpensive.

#### `register_component(&mut self, component)` — `engine_core.rs:71`
Insert into the component registry. Purely additive; existing entries with
the same qualified key are overwritten. No side effects on the tree or
dependencies.

#### `set_component_resolver<F>(&mut self, resolver)` — `engine_core.rs:76`
Stores a resolver `Arc<dyn Fn(&str, Option<&str>) -> Option<ResolvedComponent>>`.
Called on demand during `expand_ir_node` when a name is not a primitive and
not already registered. Resolvers **must be idempotent** — the registry caches
both successes and failures, but only per `(context_path, name)` key
(`ir/component.rs:214`).

#### `register_resource(&mut self, name, svg)` / `register_resources(&mut self, map)` — `engine_core.rs:85`, `engine_core.rs:90`
Parse raw SVG and store in `ResourceRegistry`. The engine owns SVG parsing;
SDKs must pass raw SVG strings (see `ir/icon.rs:136`).

#### `set_module(&mut self, module: ModuleInstance)` — `engine_core.rs:103`
Installs the **primary** module instance into `self.module`. Also:
- Walks `module.module.actions` and inserts each action name into
  `action_module_map` with a `None` scope (meaning "primary slot").
- Evicts any previous primary-slot entries from `action_module_map`
  (`retain(|_, scope| scope.is_some())`) so a re-`set_module` doesn't
  leak stale routing. Named-module entries are left intact.
- Does **not** touch `self.modules`.
- Does **not** trigger a re-render.

Called exactly once per engine lifetime in the common case. Calling it again
replaces the primary module and re-keys the action map cleanly.

#### `register_module(&mut self, name, module)` — `engine_core.rs:122`
Installs a **named** module. The behavior:
1. Lowercases `name`.
2. Evicts any existing entries in `action_module_map` whose value is
   `Some(name)` — prevents stale routing across re-registrations.
3. Iterates `module.module.actions` and writes each into `action_module_map`
   with `Some(lowercased_name)` as the value.
4. Inserts into `self.modules[lowercased_name]`.

Registering twice with the same name overwrites the action map entries for
that scope and the `modules` entry. Cross-module collisions (two different
modules declaring the same action name) silently overwrite — see §15 for the
known gap.

#### `get_module_state(&self, name) -> Option<&serde_json::Value>` — `engine_core.rs:135`
Caller must pass the already-lowercased name. No case canonicalization here.

#### `update_state(&mut self, scope: Option<&str>, patch) -> bool` — `engine_core.rs:162`
Deep-merge a JSON patch into the target module's state. See §5.

Return `false` (no-op) when:
- `scope` points to a module not present in `self.modules` — returns `false`,
  **no re-render**. Silent drop.
- `scope` is `None` and `self.module` is `None`.
- Deep-merged state is bitwise-equal to the previous state (Arc pointer
  comparison is *not* used; the check is `*module.get_state() != *old`).

Returns `true` after scheduling dirty nodes. Does **not** itself emit patches —
the caller must invoke `render_dirty`.

#### `update_state_sparse(&mut self, scope, paths, values) -> bool` — `engine_core.rs:197`
Same contract as `update_state` but operates on dotted-path → value pairs. The
merge semantics are "set each path directly"; see `lifecycle/module.rs:257`
for the path walker. Unlike `update_state`, the dirty-scheduling loop iterates
exactly the caller-supplied path list rather than walking the patch
recursively.

#### `schedule_dirty_for_paths<'p>(scope, paths)` — `engine_core.rs:232`
Private. For each path, namespaces it (`"mod:<scope>:<path>"` or raw) and
looks up affected nodes in the dependency graph. Marks them all dirty.

#### `schedule_from_state_change(&mut self, change)` — `engine_core.rs:250`
Wraps `schedule_dirty_for_paths(None, change.paths())`. Used by
`Engine::notify_state_change` when the host owns a proxy that mutated state
outside `update_state`.

#### `set_context(&mut self, name, data)` — `engine_core.rs:273`
See §7. Writes to `data_sources` and schedules every node bound to any
`ds:<name>*` key as dirty (via `get_data_source_affected_nodes`). Does not
itself render.

#### `build_data_source_action(&self, name, payload) -> Option<serde_json::Value>` — `engine_core.rs:298`
If `name` contains a `.` and the prefix is a registered data-source provider,
returns `{ provider, method, payload }`. Otherwise `None`. This is the shared
logic every binding calls before giving up on an unknown action name.

#### `remove_context(&mut self, name)` — `engine_core.rs:318`
Removes the provider and marks bound nodes dirty via
`DependencyGraph::get_data_source_affected_nodes`.

#### `render_ir_node(&mut self, ir_node) -> Vec<Patch>` — `engine_core.rs:333`
The full-render entry point. Order:
1. `component_registry.expand_ir_node(ir_node)` — resolves components,
   replaces `Children()` placeholders, propagates `module_scope` to
   descendants of `is_module` components.
2. `resolve_icons_in_ir` — injects `__iconPaths` / `__iconViewBox` (iff the
   resource registry is non-empty).
3. `auto_register_scoped_modules(&expanded)` — creates placeholder modules
   for any `module_scope` value found in the IR that isn't already
   registered, except the first unmatched scope when the primary module's
   name is "anonymous" (see §4.4).
4. Clears the dependency graph (`self.dependencies.clear()`).
5. Calls `reconcile_ir_with_ds`, writing into `self.tree` and rebuilding
   the dependency graph.
6. Increments `self.revision`.
7. Returns the patch batch.

`render_ir_node` is called for every full render (initial render or
`renderSource`/`renderInto` at the binding level). Incremental updates use
`render_dirty`.

#### `render_dirty(&mut self) -> Vec<Patch>` — `engine_core.rs:377`
Delegates to `render::render_dirty_nodes_full`. Returns an empty vec when the
scheduler has no dirty nodes. Increments `revision` only if the result is
non-empty.

#### `filter_spurious_removes(patches)` — `engine_core.rs:407`
Static helper. Drops `Remove` patches whose `id` appears in a `Create` patch
in the same batch. Every binding calls this on its emit path to work around
conditional re-reconciliation of module-scoped children (see the code
comment for the specific bug).

#### `action_scope_for(&self, action_name) -> Option<String>` — `engine_core.rs:439`
Lookup in `action_module_map` (typed `IndexMap<String, Option<String>>`)
followed by `.cloned().flatten()`. Returns:
- `Some(name)` — action is owned by a named module registered via
  `register_module`. Caller should route follow-up `update_state` calls
  with that scope.
- `None` — action is either owned by the primary module (installed via
  `set_module`, stored as `Some(None)` in the map and flattened away
  here) or unknown. In both cases callers should route follow-up updates
  to the primary slot, which is the correct default.

The collapse is intentional — see §4.5 for the rationale.

#### `auto_register_scoped_modules(&mut self, ir_node)` — `engine_core.rs:450`
Walks the expanded IR, collects every `module_scope` value, and inserts a
placeholder `ModuleInstance` (with empty JSON-object state) for each scope
not already in `self.modules`. Skips:
- The scope whose lowercased name matches `self.module.as_ref().unwrap().module.name`.
- If the primary module's name doesn't match any scope, the *first* scope
  that isn't already a registered named module (this treats the primary
  module as "anonymous" and attributes the first scope to it).

This is why "dropping a module DSL into a fresh engine just works": the
reconciler sees the scoped elements, the auto-register hook creates empty
state slots so the scope filter can fire, and the primary slot silently
owns the outermost `module X { ... }` declaration.

---

## 4. Module slots

> **The most important part of this contract.** Getting this wrong is the
> single biggest source of cross-SDK drift.

### 4.1 Two slots, one engine

`EngineCore` has two separate module-instance stores:

```rust
pub module: Option<ModuleInstance>,                 // primary
pub modules: IndexMap<String, ModuleInstance>,      // named (lowercased keys)
```

Both slots hold JSON state and share the same `InstanceTree`,
`DependencyGraph`, and `Scheduler`. They are **not** alternative routing
strategies — they coexist, and a multi-module app uses both.

- **Primary slot**: set via `set_module`. Intended for single-module apps, or
  for the "root" module of a multi-module app that has one obvious owner.
- **Named slots**: registered via `register_module`. Intended for sibling /
  child modules in a multi-module app; each gets a lowercase-name prefix.

### 4.2 Scope canonicalization

`EngineCore::canon_scope` (`engine_core.rs:144`) is the single place where
scope strings are normalized:

```rust
fn canon_scope(scope: Option<&str>) -> Option<String> {
    scope.filter(|s| !s.is_empty()).map(|s| s.to_lowercase())
}
```

Rules:
- `None` or `Some("")` both collapse to `None` (meaning "primary slot").
- Any other value is **lowercased** before use. SDKs may pass the host-
  preferred casing; the engine stores under the lowercased key.

### 4.3 The `effective_scope` filter

During reconciliation, the IR carries `module_scope: Option<String>` on every
`Element`, `ForEach`, `Conditional`, and `Router`. But the *raw* scope on the
IR is not automatically "this module owns this subtree"; it has to pass the
`ReconcileCtx::effective_scope` filter (`reconcile/diff.rs:36`):

```rust
fn effective_scope<'s>(&self, raw: Option<&'s str>) -> Option<&'s str> {
    raw.filter(|scope| {
        self.modules.map(|m| m.contains_key(*scope)).unwrap_or(false)
    })
}
```

When the raw scope is `Some("search")` but no module is registered under
`"search"`, `effective_scope` returns `None`. Consequences:

1. State bindings in that subtree resolve against the **primary** module's
   state (via `effective_state` on the next line).
2. Dependency registrations use raw paths instead of `mod:search:<path>`.
3. A later `update_state(Some("search"), …)` returns `false` and no dirty
   nodes are scheduled for that subtree — because the dependencies were
   registered under the primary namespace, and `update_state_sparse` /
   `update_state` namespace changes under the scope the host passed.

This is the "legacy wrap-your-DSL-in-`module App { ... }`" path: the primary
module swallows the scope invisibly.

### 4.4 Auto-registration of placeholder modules

`EngineCore::auto_register_scoped_modules` runs inside every full render
(`engine_core.rs:342`, invoked by `render_ir_node`). It scans the expanded
IR for `module_scope` annotations and fills in missing named slots with
empty-state placeholders.

The rationale is that component-module sources like `module Search { ... }`
tag their descendants with `module_scope = Some("search")` during expansion
(`ir/component.rs:471`, `ir/expand.rs:763`), and the reconciler needs a
registered module for `effective_scope` to route correctly. Without the
auto-register pass you'd have to register every module before the first
render — which is impractical for hot-reloaded SDKs where the component tree
changes at runtime.

Selection rule for the "primary" scope to *skip*:
1. If the primary module's lowercased name matches any scope in the IR, skip
   that one.
2. Otherwise, pick the first scope in the IR that is not already a named
   module and treat it as the primary's scope.

The result is that an SDK can `set_module(AppModule)` and register `Search`,
`Profile`, etc. via `register_module` — or register *nothing* and still have
modules auto-materialize when their IR is first rendered. Placeholder
modules have `ModuleInstance::from_config("Search", [], [], json!({}))`-style
empty state, so any `@{state.…}` binding in them resolves to `null` until
the host pushes real state with `update_state(Some("search"), …)`.

### 4.5 Action routing via `action_module_map`

Both `set_module` and `register_module` populate `action_module_map` for
their declared actions. The map's value type is `Option<String>`:

- `None` → action is owned by the primary slot
- `Some(lowercased_name)` → action is owned by that named module

The polling bindings (WASI, UniFFI) and `Engine::action_scope_for` read this
map for two purposes:

1. **Pre-flight**: binding knows which module's state to target before
   invoking its host-side handler.
2. **Post-flight routing**: after an action runs, the host calls
   `update_state` and needs to pass a scope. The binding consults
   `action_scope_for(name)` and forwards the result.

`action_scope_for` (`engine_core.rs:439`) flattens the lookup:

```rust
self.action_module_map.get(action_name).cloned().flatten()
```

So the externally-visible contract is:
- `Some(name)` — action belongs to a named module; route updates with that scope
- `None` — action belongs to the primary slot **or** is unknown; either way,
  callers should route follow-up updates to the primary slot, which is the
  correct default

This collapse is intentional: the WASI `active_action_scope` latch and
UniFFI's polling pattern both treat "primary slot" and "unknown action" the
same way (route to `update_state(None, …)`), so the engine doesn't make
hosts disambiguate.

Cross-module collisions: if two `register_module` calls declare the same
action name, the second wins (`IndexMap::insert` overwrites). SDKs must
enforce action-name uniqueness themselves if they care — see §15.

### 4.6 Where state actually lives

| Situation | `update_state` scope | Storage location |
|-----------|-----------------------|------------------|
| Single-module app using `set_module` | `None` or `""` | `core.module` |
| Multi-module app, update *named* module | `Some("search")` | `core.modules["search"]` |
| Multi-module app, update *primary* module | `None` / `""` | `core.module` |
| DSL `module Search { ... }` rendered before `register_module("search", …)` | — | auto-registered placeholder at `core.modules["search"]` (empty state) |

Historical note: `hypen-sdk-rs::ModuleInstance::sync_state_to_engine` used to
pass `Some(&self.definition.name)` as the scope even though it registers
via `engine.set_module(…)`. Under the rules above, that silently dropped
every state update because `canon_scope(Some("Counter"))` → `Some("counter")`,
which was not a key in `self.modules` — `update_state` returned `false`. The
SDK now passes `None`, which routes correctly to the primary slot. The
incorrect comment that previously claimed `effective_scope` rescued this has
been removed; `effective_scope` is a *read-side* filter only, not a write-
side router on `update_state`.

---

## 5. State updates and dependency invalidation

There are two symmetric paths:

### 5.1 `update_state(scope, patch)` — `engine_core.rs:162`

1. Canonicalize `scope`.
2. Look up the target slot (`self.module` or `self.modules[name]`). Missing
   slot → return `false`.
3. `module.update_state(patch.clone())` → performs a **deep merge** into the
   slot's JSON state (`lifecycle/module.rs:193`). `Arc::make_mut` gives COW
   semantics — if the Arc is sole-owned it mutates in place.
4. Compare new state against old state. Bitwise equal → return `false`.
5. `StateChange::from_json(&patch)` — walks the patch and extracts **every**
   path present in its object tree (`state.rs:69`). Arrays are leaves; see
   `state.rs:169` for the exact rule.
6. `schedule_dirty_for_paths(scope, change.paths())`.
7. Return `true`.

Path extraction caveats:
- A patch `{"user": {"name": "A"}}` produces both `"user"` and `"user.name"`.
- A patch `{"items": [1, 2, 3]}` produces only `"items"` (the array is a
  leaf).
- The engine does **not** enumerate array indices, so reactive dependencies
  on `items.0.title` are not auto-invalidated by a whole-array patch. Use
  `update_state_sparse(..., ["items.0.title"], ...)` when the host knows the
  specific indices.

### 5.2 `update_state_sparse(scope, paths, values)` — `engine_core.rs:197`

1. Canonicalize `scope`; look up target slot.
2. `module.update_state_sparse(paths, values)` where `values` is expected to
   be a JSON *object* keyed by path (`lifecycle/module.rs:203`). Each path's
   value is set at that dotted path via `set_value_at_path`, which creates
   intermediate objects and extends arrays as needed (`lifecycle/module.rs:257`).
3. Compare new state against old. Equal → return `false`.
4. Schedule dirty for the caller-supplied path list (not for paths extracted
   from the value object).
5. Return `true`.

Sparse updates are the preferred path for hosts whose SDK already tracks
which paths mutated (TypeScript Proxy, Kotlin/Swift observable state). They
avoid the full-tree walk of `StateChange::from_json`.

### 5.3 Namespacing

Inside `schedule_dirty_for_paths`:

```rust
let key = match scope {
    Some(name) => format!("mod:{}:{}", name, path),
    None       => path.to_string(),
};
affected_nodes.extend(self.dependencies.get_affected_nodes(&key));
```

The dependency graph stores keys under the same convention — so the lookup
matches exactly what `DependencyGraph::add_dependency` registered when the
tree was built. See §11 for the full namespacing rules.

### 5.4 `render_dirty`

After a successful state update, the host must invoke
`render_dirty_nodes_full` (via `EngineCore::render_dirty`). The Rust
`Engine::update_state` wrapper does this automatically
(`engine.rs:228`); the JS, WASI, and UniFFI bindings also do it internally.
A direct `EngineCore` consumer must not forget it.

`render_dirty_nodes_full` (`render.rs:46`) dispatches per dirty node:

- **Control-flow node** (`ir_node_template.is_some()`): re-run
  `reconcile_ir_node_impl` against the stored IR template.
- **List node** (`raw_props["0"] is Binding && element_template.is_some()`):
  re-evaluate the source binding and re-run `reconcile_iterable_children`.
- **Plain element**: re-resolve props via `update_props[_with_data_sources]`,
  diff against the previous props, emit SetProp/RemoveProp.

Dirty-node renders do **not** clear the dependency graph — they additively
re-register bindings on whichever nodes they touch. The graph is only
wiped inside `render_ir_node`.

### 5.5 `notify_state_change` for hosts with observable state

Most SDK hosts have their own reactive state machinery — TypeScript's
`Proxy`-based `ObservableState`, Kotlin/Swift `Observable` types, the Go
SDK's `ObservableState` change notifier — and the host has *already*
mutated its in-memory state by the time the engine learns about it. For
these hosts, `update_state(scope, patch)` is the *wrong* path: it would
re-merge a JSON patch into a state slot the host has already updated and
diff against the previous engine-side snapshot, paying for double the
work and possibly producing duplicate notifications.

The native Rust `Engine` exposes `notify_state_change(&StateChange)`
(`engine.rs:204`) for this case:

```rust
pub fn notify_state_change(&mut self, change: &StateChange);
```

What it does:

1. Compares the primary module's state Arc pointer to the last-render
   pointer (`engine.rs:206-214`). If unchanged and at least one render
   has happened (`self.core.revision > 0`), this call is a no-op. The
   guard catches duplicate notifications from a host whose Proxy
   microtask fires *after* an explicit `update_state` already processed
   the same change — without it, the engine would re-render twice.
2. Calls `EngineCore::schedule_from_state_change(change)`
   (`engine_core.rs:250`), which walks `change.paths()` and dirties
   every node in the dependency graph that subscribes to one of those
   paths. Uses the **primary** scope (no `mod:name:` prefix). For named
   modules, host SDKs construct a `StateChange` with paths already
   namespaced and call the `EngineCore`-level helpers directly — see
   the Go SDK's `NotifyStateChange(scope, paths, values)` (with a
   non-empty `scope`) for the reference shape.
3. Calls `render_dirty()` and pushes patches through the host's render
   callback.

When to use which path:

| Situation | Method | Why |
|-----------|--------|-----|
| Host has no observable state of its own; engine owns the state slot | `update_state(scope, patch)` | Engine performs the merge, path extraction, dirty marking, and render in one call. |
| Host has observable state and already mutated its in-memory copy; just wants the engine to invalidate | `notify_state_change(&change)` | Skips the redundant merge. Host pre-computed which paths changed via its proxy/observer. |
| Host has observable state with explicit per-path callbacks (sparse) | `update_state_sparse(scope, paths, values)` | Same shape as the sparse path but goes through the engine merge. Use when the host wants the engine to be the source of truth even though it tracks paths separately. |

The path SDK authors most commonly miss: a host with its own Proxy
should call `notify_state_change`, **not** `update_state`. The `Engine`
is shared between SDK frontends and engine-state apps, so both methods
exist; the SDK author has to pick the right one for the host's
architecture.

---

## 6. Action dispatch

### 6.1 Action shape

```rust
pub struct Action {
    pub name: String,
    pub payload: Option<serde_json::Value>,
    pub sender: Option<String>,
}
```

Source: `dispatch/action.rs:23`. `sender` is currently unused by the engine;
SDKs may populate it for observability.

### 6.2 What the engine does with an action

**Nothing by itself.** `ActionDispatcher::dispatch` (`dispatch/action.rs:86`)
looks up a handler by exact-match name and invokes it. If the handler is
host-registered (JS via `on_action`, native via `Engine::on_action`), the
host runs its logic, then calls back into the engine with `update_state`.

Per binding:

| Binding | Handler mechanism | Routing precedence |
|---------|-------------------|--------------------|
| Native `Engine` | `on_action(name, closure)` populates `ActionDispatcher` | Exact match only, via `engine.rs:247` |
| `WasmEngine` (JS) | `onAction(name, jsFn)` stores closure map | Exact match, then `build_data_source_action` fallback to `onDataSourceAction` (`wasm/js.rs:740`) |
| `WasiEngine` | `hypen_register_action(name)` pushes to `registered_actions`; the host polls `ACTION_BUFFER` | Exact match, then `build_data_source_action` fallback (`wasm/wasi.rs:795`) |
| `HypenEngine` (UniFFI) | `register_action(name)` pushes to `registered_actions`; the host polls `get_pending_actions` | Exact match only (`uniffi/mod.rs:454`) |

The shared rule all bindings follow:

1. Set `active_action_scope` (WASI only — see below).
2. Try exact-match handler / registered action list.
3. Fall back to `EngineCore::build_data_source_action` and forward the
   `{provider, method, payload}` envelope to the data-source handler.
4. If both miss, the action is dropped (or in native Rust, returns
   `EngineError::ActionNotFound`).

### 6.3 `action_module_map` routing

Covered in §4.5. `register_module` populates the map; `dispatch_action` reads
`action_scope_for` to know which named module's state the host's handler
should mutate.

### 6.4 WASI `active_action_scope`

`wasm/wasi.rs:67` adds one field WASI-specific:

```rust
active_action_scope: Option<String>,
```

Set inside `hypen_dispatch_action` (`wasm/wasi.rs:792`) by calling
`core.action_scope_for(action_name)`. Consumed and cleared by the next
`hypen_update_state` / `hypen_update_state_sparse` call (`wasm/wasi.rs:460`,
`wasm/wasi.rs:549`):

```rust
let scope = engine.active_action_scope.take();
engine.core.update_state(scope.as_deref(), patch);
```

Why only WASI: WASI hosts talk to the engine via a flat C FFI and cannot
plumb a structured "owner" through their action-handling code. The transient
scope latch lets them dispatch an action, run their handler, and call
`hypen_update_state` without knowing which module owns the state. JS
(closure-based handlers) and UniFFI (explicit `scope` parameter on
`update_state`) don't need this.

**Positive example: the Go SDK.** `hypen-golang` is built on the WASI binding
and uses the latch correctly. `ModuleInstance` (in `app.go`) installs each
module's `OnChange` callback so that primary-slot mutations call
`engine.NotifyStateChange("", paths, values)` with an empty scope sentinel,
while nested-slot mutations call `engine.NotifyStateChange(scope, paths, values)`
with the module name as scope. The latch then routes follow-up updates from
inside an action handler to whichever module owns the action — the host never
has to track ownership manually. This is what the latch is designed for, and
SDKs porting to WASI should mirror this pattern rather than working around it.

### 6.5 Data-source actions

A name of the form `<provider>.<method>` is classified as a data-source
action when `<provider>` is a registered data source. The engine does not
run it; it builds an envelope via `build_data_source_action`:

```json
{
  "provider": "<name>",
  "method":   "<method>",
  "payload":  <original payload>
}
```

and forwards it to the binding's data-source handler (JS callback, WASI
action buffer, UniFFI pending-actions queue).

---

## 7. Data sources

### 7.1 API

- `set_context(&mut self, name, data: serde_json::Value)` — `engine_core.rs:273`
- `remove_context(&mut self, name)` — `engine_core.rs:318`
- `data_sources()` read accessor

Provider names are **case-sensitive** at the `set_context` boundary. The
engine stores the provider under exactly the string the host passed. All
lookups (binding resolution, dependency graph, data-source action routing)
use the same string.

### 7.2 Dirty propagation on `set_context`

When `set_context(name, data)` is called:

1. Register the provider name in `DependencyGraph::registered_providers`
   (so unknown-provider warnings aren't fired for this name anymore).
2. Look up **every** node bound to anything under `ds:{name}` or
   `ds:{name}:*` via `DependencyGraph::get_data_source_affected_nodes`
   (`reactive/graph.rs:187`). This is the same helper `remove_context`
   uses, and it correctly catches deep paths like `ds:spacetime:user.name`
   that the older per-top-level-key scan missed.
3. Store `data_sources[name] = data`.
4. Mark all collected nodes dirty. Caller must then call `render_dirty`.

Note: this replaces the entire provider blob, so we invalidate every
subscriber regardless of which nested key changed — there is no sparse
diff. Hosts that want granular invalidation should construct their own
patch strategy at the SDK layer.

### 7.3 `remove_context`

Removes the provider from `data_sources`, then calls
`DependencyGraph::get_data_source_affected_nodes(name)` (`reactive/graph.rs:187`)
which scans all dependency keys for `ds:<name>` or `ds:<name>:*` and
collects the affected nodes. Dirty-marks them. Caller must render.

### 7.4 Bindings (see also §11)

`Binding::data_source(provider, path)` produces a binding with
`BindingSource::DataSource(provider)`. The parser emits these from the
`@provider.path` syntax (not from `@{provider.path}` template-string
syntax, which is rejected; see `reactive/binding.rs:144`).

At reconcile time, data-source bindings are resolved against
`data_sources[provider]` via the same path walker used for state bindings
(`reconcile/resolve.rs:94`). If the provider is missing or the path doesn't
resolve, the value is `null`.

---

## 8. Components and resources

### 8.1 `ComponentRegistry`

Source: `ir/component.rs`.

- `register(component: Component)` — inserts under both the qualified key
  (`"path:name"`) and the bare name (`"name"`), so `get("Header",
  Some("/pages/Home.hypen"))` falls back to the bare entry when there's no
  qualified match.
- `register_primitive(name)` — marks a name as a primitive. Primitives are
  **never** resolved as components, regardless of whether a resolver is set
  (`ir/component.rs:202`). This is a security property: a user component
  named `Text` cannot shadow the renderer's primitive Text element.
- `register_default_primitives()` — registers the set in `DEFAULT_PRIMITIVES`
  (`ir/component.rs:11`): `Text`, `Column`, `Row`, `Button`, `Input`,
  `Textarea`, `Image`, `Container`, `Box`, `Center`, `List`, `Spacer`,
  `Stack`, `Divider`, `Grid`, `Card`, `Heading`, `Checkbox`, `Select`,
  `Switch`, `Slider`, `Spinner`, `Badge`, `Avatar`, `ProgressBar`, `Video`,
  `Audio`, `Paragraph`, `Icon`.
- `set_resolver(resolver)` — installs the fallback lookup closure.
- `clear_resolved()` — drops all resolved components and cache entries, but
  **preserves** primitives and the resolver (for hot-reload).

### 8.2 `ResolvedComponent`

```rust
pub struct ResolvedComponent {
    pub source:      String, // DSL source for the component
    pub path:        String, // logical file path (context for nested resolution)
    pub passthrough: bool,
    pub lazy:        bool,
}
```

(And the WASM FFI variant adds `is_module: bool` at `wasm/ffi.rs:79`. The
native type uses a separate `Component::is_module` flag instead.)

Field semantics:

| Field | When true |
|-------|-----------|
| `passthrough` | Component is a transparent wrapper. Its template is never instantiated; instead, the engine keeps the original element, recursively expands its children in the component's source-path context, and preserves its props. Used for primitives like `Router`/`Route` that render as containers. See `ir/component.rs:385`. |
| `lazy` | Component's children are kept as IR references instead of being expanded up front. The element gets a `__lazy` prop and (if its first child is an element) a `__lazy_child` prop naming the next component. The renderer can fetch children on demand via `expand_children`. See `ir/component.rs:360`. |

Setting both `passthrough` and `lazy` is undefined — the registry checks
`lazy` first and returns early.

### 8.3 Module-typed components (`is_module`)

When `try_resolve` parses a component source and finds
`DeclarationType::Module`, it marks the registered component with
`is_module = true` and `module_name = Some(name.to_lowercase())`
(`ir/component.rs:290`). At expansion time:

```rust
if comp_is_module {
    if let Some(ref scope) = comp_module_name {
        super::expand::propagate_module_scope_element(&mut expanded, scope);
    }
}
```

— every descendant element's `module_scope` is set to the lowercased module
name. This is the IR-level signal the reconciler reads for scope routing.

Module components are the mechanism by which "drop a file named
`Search.hypen` that starts with `module Search { ... }` and have its state
automatically isolated" works across SDKs. The host only needs a resolver
that returns the component source; the engine does the rest.

### 8.4 `ResourceRegistry`

Source: `ir/icon.rs:62`.

- `register(name, svg)` — parses raw SVG and stores `IconData` under `name`.
- `register_map(map)` — bulk register from `IndexMap<String, String>`.
- `resolve(name) -> Option<&IconData>` — lookup.
- `to_props(icon)` — converts `IconData` to a `serde_json::Value` with
  `paths` (array of `{d, fill, stroke, strokeWidth, strokeLinecap,
  strokeLinejoin}`) and `viewBox`.

The engine owns SVG parsing — SDKs must pass raw SVG strings, not pre-parsed
structures.

### 8.5 Icon resolution side effect on patches

`resolve_icons_in_ir` (`ir/icon.rs:417`) walks the expanded IR and, for
every `Element` with `element_type == "Icon"`:

1. Extracts the icon name from prop `"0"` (positional) or `"name"`,
   accepting both `Value::Static(String)` and `Value::Resource(String)`.
2. Looks the name up in the resource registry.
3. Injects two new props on the element:
   - `__iconPaths` → the `paths` array (as `Value::Static`)
   - `__iconViewBox` → the `viewBox` string (as `Value::Static`)

These props flow through the normal patch pipeline, so the `Create` patch
for the `Icon` node carries pre-resolved SVG data. Renderers must treat
`__iconPaths` and `__iconViewBox` as reserved prop names.

### 8.6 Resolver cycle prevention

When the JS binding's `resolve_imports` walks a document's `import`
declarations, it tracks visited imports in `WasmEngine::import_visited`
(`wasm/js.rs:105`) — a `HashSet<String>` keyed by `"<source_path>:<name>"`.
Before invoking the host resolver for an import, it checks the set; if
the key is present, it skips the call (`wasm/js.rs:355`). The set is
cleared at the start of every `render_source` (`wasm/js.rs:162`) and on
`reset` (`wasm/js.rs:236`), so it scopes per-render-cycle, not for the
lifetime of the engine.

This means:

- **SDK authors writing a custom resolver do not need to implement their
  own cycle detection.** Two components that import each other (`A.hypen`
  imports `B`, `B.hypen` imports `A`) will not produce an infinite
  resolver loop — the second visit short-circuits.
- **The visited set is per-render, not global.** A component resolved on
  one render cycle is *not* in the visited set on the next, so the
  resolver is consulted again. The component registry's separate cache
  (`ir/component.rs`) handles cross-render memoization; the visited set
  only prevents recursion within a single render.
- **Cache invalidation is the resolver's job for the registry.** Use
  `clear_resolved_components` (`wasm/js.rs:200`) on hot reload to drop
  the registry cache. The visited set is reset implicitly on the next
  `render_source`.
- **The cycle guard is on the JS binding only.** WASI and UniFFI hosts
  don't currently implement an equivalent — they rely on the host
  language's resolver to be terminating. If a future binding wants to
  match the JS guarantee, mirror the `import_visited` pattern.

The tradeoff: cycle prevention is per-render, so a component that fails
to resolve on one render is retried on the next (which is what you
want — failed resolutions can become successful when the host registers
a previously-missing component). The component registry caches *successful*
resolutions across renders; failed attempts are not negatively cached
inside the registry, only inside the per-render visited set.

---

## 9. The reconcile contract

### 9.1 Entry points

- `reconcile_ir(tree, ir_node, parent_id, state, deps) -> Vec<Patch>`
  — `reconcile/diff.rs:63`. Thin alias for `reconcile_ir_with_ds` with no
  data sources or modules.
- `reconcile_ir_with_ds(tree, ir_node, parent_id, state, deps, ds, modules)
  -> Vec<Patch>` — `reconcile/diff.rs:74`. The canonical entry used by
  `EngineCore::render_ir_node`.

Both functions distinguish "initial render" (`tree.root().is_none()`) from
"incremental update" (`tree.root().is_some()`):

- **Initial**: build the tree from scratch via `create_ir_node_tree_impl`.
  Emits Create + Insert patches for every node.
- **Incremental**: call `reconcile_ir_node_impl` against the existing root,
  which walks both the old tree and the new IR in lockstep and produces
  Create/Move/Remove/SetProp/RemoveProp as needed.

### 9.2 Dependency graph lifecycle

The dependency graph is **cleared by `render_ir_node` only**
(`engine_core.rs:350`). Within a single full render, every `add_dependency`
call adds to a fresh graph. Within a dirty-node render (`render_dirty`), the
graph is not cleared — new bindings discovered during re-reconciliation of
control-flow subtrees are merged into the existing graph.

A node removal via `remove_subtree` calls
`DependencyGraph::remove_node(id)` to drop its bindings
(`reconcile/diff.rs:1112`). This is the only dependency-cleanup path other
than a full clear.

### 9.3 `InstanceTree` invariants

`InstanceTree` (`reconcile/tree.rs`) maintains the virtual DOM. Invariants
every mutation must preserve:

1. **Unique `NodeId`**. Every node has a fresh SlotMap key; serialization
   uses `node_id_str` (`reconcile/patch.rs`), which returns the key's
   `KeyData::as_ffi()` as a decimal string. Stable and unique per NodeId
   within a process; do not assume stability across engine instances or
   across engine versions.
2. **Parent/child consistency**. `node.children` is an ordered `Vector`
   (from `im::Vector`) of child IDs; every child's `.parent` points back to
   the parent. `add_child` / `remove_child` / `remove` keep this in sync.
3. **Key uniqueness within a parent** is assumed for keyed reconciliation
   (lists / ForEach). It is not checked; the keyed diff algorithm produces
   subtly wrong output if duplicate keys exist. SDKs should not rely on the
   engine to validate.
4. **`element_template` and `ir_node_template`** are stashed on List and
   control-flow container nodes respectively, so dirty-node re-reconciliation
   can re-evaluate the template without re-running the full IR expand.
5. **`module_scope`** on a stored node is set by the creator and inherited
   through `ctx.state` during reconciliation. Dirty-node rendering reads it
   back to pick the correct state slot (`render.rs:111`).

### 9.4 Full vs dirty distinction

| | Full (`render_ir_node`) | Dirty (`render_dirty_nodes_full`) |
|---|---|---|
| Expand components | yes | no |
| Resolve icons | yes | no |
| Auto-register modules | yes | no |
| Clear dependency graph | yes | no |
| Walks whole IR | yes | touches only dirty nodes |
| Increments `revision` | always | only if patches non-empty |

### 9.5 "Spurious removes" filter

`EngineCore::filter_spurious_removes` (`engine_core.rs:407`) is run by every
binding before emitting patches. It drops `Remove { id }` patches when `id`
is also a `Create { id, … }` in the same batch. This works around a bug
where a conditional re-reconciles module-scoped children whose stored
template doesn't carry `module_scope`, causing the engine to think an
existing element needs replacement. Removing the filter reintroduces a
"phantom flash" in affected renderers.

---

## 10. The patch wire format

Source: `reconcile/patch.rs`. Serialization uses `#[serde(tag = "type",
rename_all = "camelCase")]`, with `rename_all = "camelCase"` **repeated on
each variant** (the test at `wasm/ffi.rs:754` is load-bearing — drop that
duplication and field names revert to snake_case).

### 10.1 Variants

#### `Create`
```json
{ "type": "create",
  "id": "<string>",
  "elementType": "<string>",
  "props": { "<key>": <json>, ... } }
```
Allocate a new element instance keyed by `id`. `elementType` is the bare
name (e.g., `"Text"`, `"Column"`). `props` is the full resolved prop map
(see §10.3). The node is **not yet attached** — a subsequent `Insert`
places it in the tree.

Renderers may assume: `id` is unique at the time the patch is emitted and
the element did not previously exist in their state. Re-creating an
existing ID is undefined.

#### `SetProp`
```json
{ "type": "setProp", "id": "...", "name": "<propName>", "value": <json> }
```
Update exactly one prop on the node. Renderers should overwrite the
previous value.

#### `RemoveProp`
```json
{ "type": "removeProp", "id": "...", "name": "<propName>" }
```
The prop no longer appears in the resolved prop map. Renderers should
revert to whatever default the prop has.

#### `SetText`
```json
{ "type": "setText", "id": "...", "text": "<string>" }
```
Replaces the node's text content. Note: the current engine emits text
changes via `SetProp { name: "0", value: "..." }` for most cases (since
text is stored as positional prop `"0"`); `SetText` is reserved for
renderers that distinguish text-nodes from prop updates and is not
currently emitted on the primary path. SDKs should still implement
`SetText` to remain forward-compatible.

#### `Insert`
```json
{ "type": "insert",
  "parentId": "<string>" | "root",
  "id": "...",
  "beforeId": "<string>" | null }
```
Attach node `id` as a child of `parentId`. If `beforeId` is non-null, insert
before that sibling; if null, append.

The special `parentId == "root"` value is used for the root element of the
UI. Renderers must treat `"root"` as their root container (document body,
stack root, scene root, etc.), not as a node ID to look up in their map.

#### `Move`
```json
{ "type": "move",
  "parentId": "...",
  "id": "...",
  "beforeId": "..." | null }
```
Re-parent an **already-inserted** node to a new position. Emitted only by
the keyed reconciler when a list re-order happens; never for new nodes
(use `Insert` for those).

#### `Remove`
```json
{ "type": "remove", "id": "..." }
```
Detach and deallocate the node. Renderers should drop their reference to
it.

### 10.2 Ordering guarantees

Within a single patch batch (one `emit_patches` call):

1. For a newly created node, `Create` precedes any `Insert` or `SetProp`
   referencing it.
2. For a moved node, `Move` is emitted against an already-present node —
   the renderer can assume `id` exists in its map.
3. For a removed node, `Remove` is the last patch mentioning that `id`.
4. There is no cross-subtree ordering guarantee. Parents and children are
   created in structural order, but sibling subtrees may interleave in
   complex re-reconciliations.

A renderer that applies patches in the emission order is correct. A
renderer that reorders patches (e.g., batching all Creates first, then
all Inserts) is **not** correct without additional analysis — a `Create`
followed by `SetProp` followed by `Insert` is safe to apply in that
order, but splitting SetProps out of their structural context is not.

### 10.3 Resolved values only

`Create.props` and `SetProp.value` carry **fully resolved**
`serde_json::Value`s, never `Binding` or `TemplateString`. All template
evaluation, state binding lookup, data-source resolution, and data-source
action serialization happens inside the reconciler before patches are
emitted. Renderers never need access to the IR or the binding parser.

Special prop names that the renderer should know about:

- `"0"` — positional argument; by convention the text content for
  `Text`, the URL for `Image`, etc.
- `"key.0"` — list key prop; present on iterable containers (List, Grid,
  ForEach container).
- `"slot.0"` — slot name for `Children().slot("name")` matching.
- `"__lazy"` — element is a lazy component; children will arrive later.
- `"__lazy_child"` — name of the first child component to resolve on
  activation.
- `"__iconPaths"` / `"__iconViewBox"` — pre-resolved SVG data for `Icon`
  elements.
- `"__condition"` / `"__location"` — internal, on control-flow containers.
  The reconciler emits these onto `__Conditional` / `__Router` container
  nodes, which renderers typically never receive because control-flow
  children are rendered against the container's parent.

### 10.4 Control-flow container patches

The reconciler internally creates `__ForEach`, `__Conditional`, and
`__Router` container nodes but emits Insert patches for their children
against the container's **grandparent**, not the container itself. This
means renderers do not see `__ForEach` / `__Conditional` / `__Router`
element types in the wire format under normal operation. If you ever see
one, treat it as a plain container element — but you shouldn't.

### 10.5 Responsive / state variant prop keys

Applicators can carry **variant** information — a responsive breakpoint
and/or an interaction state — encoded directly into the prop key. Both the
Tailwind path (`.tw("p-4 md:p-8 hover:bg-white")`) and the value-map path
(`.padding({ default: 8, md: 16, hover: "x" })`) lower to the same key
shape, so renderers handle a single uniform format.

**Canonical key format:**

```text
<camelBase><variant?><argSuffix>
```

* `camelBase` — camelCase applicator name, e.g. `padding`, `backgroundColor`.
* `variant` (optional) — `@<bp>` and/or `:<state>`, in that order when
  combined:
  * `bp` ∈ `{ sm, md, lg, xl, 2xl }` with min-widths `640 / 768 / 1024 /
    1280 / 1536` px.
  * `state` ∈ `{ hover, focus, active, disabled, focus-visible,
    focus-within }`.
  * Combined example `backgroundColor@md:hover` applies only when BOTH the
    breakpoint is active (viewport width ≥ its min-width) AND the state is
    active.
* `argSuffix` — `.<index>` (almost always `.0`) or `.<name>` for named args.

Examples emitted by the engine: `padding.0`, `padding@md.0`,
`backgroundColor:hover.0`, `backgroundColor@md:hover.0`, `padding.top`.

> Value-maps express a **single** variant axis per entry — a map key is one
> token (`default` / a breakpoint / a state). Combined `@bp:state` keys are only
> producible via the Tailwind path (`.tw("md:hover:bg-white")`); a value-map
> cannot emit them.

> The variant marker sits **between** the base and the trailing `.arg`
> suffix. A lookup that forgets the `.arg` suffix (e.g. building `padding@md`
> and looking it up directly) MISSES the real key `padding@md.0`.

**Resolution precedence** (lowest → highest; later overrides earlier):

```text
base
  < breakpoints in ascending min-width order (sm<md<lg<xl<2xl, only those
    whose min-width <= current viewport width)
  < disabled < hover < focus < active
```

This mirrors the iOS reference
`StateAwareModifier.computeEffectiveModifier` in
`hypen-renderer-swift/Sources/HypenSwift/Render/VariantSupport.swift`.

**Resolution is renderer-side, not engine-side.** The engine emits all
variant keys verbatim; each renderer picks the effective value for the
current viewport width and active interaction states at paint time. The
shared parser/resolver lives in `crate::portable::variant`
(`hypen_engine::portable::variant`) — the single source of truth that
every SDK should call rather than reimplementing the split/precedence:

* `parse_prop_key(key) -> ParsedKey { base, breakpoint, state, arg }`
* `pick_variant_base(base, candidate_keys, viewport_w, active_states) ->
  Option<String>` — returns the winning **variant-decorated base WITHOUT
  the arg suffix** (e.g. `"padding@md"`), so callers append `.0` (or the
  named arg) with their existing prop getters. This is the mechanism that
  fixes the `.0` mismatch bug.
* predicates `is_breakpoint`, `is_state`, `is_variant_token`,
  `breakpoint_min_width`.

**Reserved value-map key namespace.** The value-map lowering in
`ir/expand.rs` reinterprets a single positional `Map` argument as variants
**only when every key is a variant token** — i.e. one of `default`, the
breakpoints `sm / md / lg / xl / 2xl`, or the states `hover / focus /
active / disabled / focus-visible / focus-within`. A map keyed *entirely*
by those names is always treated as a variant map; any other key makes the
whole map pass through unchanged as a literal `name.0` value. Applicators
that legitimately take a literal map must therefore avoid map literals whose
key set is drawn *solely* from this reserved namespace (mix in any other
key, or pass the map through a non-map argument, to opt out).

---

## 11. Bindings and the dependency graph keying convention

### 11.1 `BindingSource` variants

Source: `reactive/binding.rs:5`.

```rust
pub enum BindingSource {
    State,                    // @{state.user.name}
    Item,                     // @{item.name} — ForEach iteration
    DataSource(String),       // @spacetime.messages — provider.path
}
```

There are three variants, not four. `Item` bindings are handled entirely
by the ForEach scope at reconcile time; they do not enter the dependency
graph at all.

`parse_binding` (`reactive/binding.rs:123`) only recognizes `@{state.*}`
and `@{item.*}` in template strings. Data-source bindings must use the
parser's `@provider.path` syntax (not `@{provider.path}`), to prevent
typos from silently becoming data-source bindings.

### 11.2 Dependency key namespacing

Source: `reactive/graph.rs:51`.

| Binding | Module scope | Key stored |
|---------|-------------|------------|
| State | `None` (primary) | `<path>` (e.g., `"user.name"`) |
| State | `Some("search")` | `"mod:search:<path>"` (e.g., `"mod:search:query"`) |
| Item | any | **not stored** (returned early in `add_dependency`) |
| DataSource(provider) | any | `"ds:<provider>:<path>"` (e.g., `"ds:spacetime:messages"`) |
| DataSource, whole-provider | | `"ds:<provider>"` (used by `set_context` / `remove_context`) |

Module scope on data-source bindings is ignored — data sources are always
global.

The namespacing is a **flat string key** in `IndexMap<String, IndexSet<NodeId>>`.
There is no structured scope object, just these four well-known prefixes:
- `<path>` (no prefix) — primary state
- `mod:<name>:<path>` — named module state
- `ds:<name>` — whole provider
- `ds:<name>:<path>` — provider sub-path

The prefix index (for efficient prefix lookups on state changes) uses
`.` as its separator, which is why the `ds:` namespace needs a separate
`get_data_source_affected_nodes` method (`reactive/graph.rs:187`) that
scans linearly instead of using the prefix index.

### 11.3 `get_affected_nodes(changed_path)`

For a **state** change, the engine needs to find nodes bound to:
- The exact path (`"user.name"`)
- Any parent prefix (`"user"` — because a subscriber to `user` cares when
  `user.name` changes)
- Any child path (all paths starting with `"user.name."` — because a
  whole-object change invalidates every leaf subscriber)

This is implemented via `prefix_index: BTreeMap<String, IndexSet<String>>`
in `DependencyGraph`, keyed by path prefix. The same mechanism works for
module-scoped state paths because the `mod:<name>:<path>` key is still
dot-separated after the prefix, and a whole-module-state change (empty
path) isn't something the engine computes — `update_state` always sees
individual leaf paths in its change set.

### 11.4 Item bindings

Item bindings (`BindingSource::Item`) are resolved per-iteration in
`replace_ir_node_item_bindings` (`reconcile/item_bindings.rs`), which
rewrites the IR with the item value substituted in before reconciliation.
The dependency graph never sees them; re-renders happen only when the
*source array* of the ForEach changes (via the ForEach's dependency on
`source`).

Consequence: mutating `items.3.name` without invalidating `items` itself
will **not** re-render the ForEach child that reads `@{item.name}`. Use
`update_state_sparse(None, ["items.3.name"], …)` or explicitly patch
`{"items": [...]}` to force the re-render.

---

## 12. The three FFI binding contracts

### 12.1 `wasm/js.rs` — wasm-bindgen (browser, Node.js, Bun, Deno)

Wire format: **native JS values**. Structs are serialized via
`serde-wasm-bindgen` directly into JS objects — no JSON-string trampoline.
Callbacks are real `js_sys::Function`s.

Public surface (see `wasm/js.rs` for full list; names given in JS form):

| JS name | Rust handler | Contract |
|---------|---------------|----------|
| `new WasmEngine()` | `new` | Allocate empty core. |
| `renderSource(src)` | `render_source` | Parse, resolve imports, render first component. Throws structured JS error on parse failure. |
| `renderInto(src, parentId, state)` | `render_into` | Subtree render for lazy routes. |
| `renderLazyComponent(src)` | | Alias for `renderSource`. |
| `setRenderCallback(fn)` | | Host receives `Patch[]` per batch. |
| `setComponentResolver(fn)` | | Fn `(name, ctxPath) -> ResolvedComponent | null`. |
| `registerPrimitive(name)` / `registerDefaultPrimitives()` | | |
| `clearResolvedComponents()` | | Hot reload. Preserves primitives and resolver. |
| `registerResources(map)` | | `Record<string, string>` of SVG sources. |
| `setModule(name, actions, stateKeys, initialState)` | | Primary slot. |
| `registerModule(name, actions, stateKeys, initialState)` | | Named slot. |
| `updateState(scope, patch)` | | `scope`: `string | null | undefined`. Empty string is treated as `null`. |
| `updateStateSparse(scope, paths, values)` | | |
| `setContext(name, data)` / `removeContext(name)` | | Data sources. |
| `dispatchAction(name, payload)` | | Exact-match handler, then DS-action fallback. |
| `onAction(name, fn)` | | Handler stored in closure map. |
| `onDataSourceAction(fn)` | | Fallback handler for classified DS actions. |
| `clearTree()` | | Nuke the instance tree (no Remove patches). |
| `reset()` | | Clear tree + revision. |
| `getRevision()` | | |
| `currentState()` | | JSON snapshot of primary module state. |
| `treeSize()` | | |
| `validate()` | | |

Quirks:
- `updateState` accepts `null`, `undefined`, or empty string for the
  primary slot (`wasm/js.rs:674`). The engine sees `None`.
- `dispatchAction` runs the handler **synchronously** via
  `js_sys::Function.call1`. There is no await / async fan-out in the
  engine; host must use JS async inside its handler if needed.
- Errors are `structuredError` objects with `{type, message}` fields —
  not plain strings — so JS consumers can `switch` on `error.type`
  (`wasm/js.rs:27`).

### 12.2 `wasm/wasi.rs` — C ABI (Go, Python, Rust wasmtime, embedded)

Wire format: **ptr + length pairs with JSON byte buffers**. Host allocates
via `wasi_alloc`, writes JSON, passes `(ptr, len)`. Reads via
`hypen_get_patches` / `hypen_get_action` / `hypen_get_last_error` (also
ptr-based, returning byte counts).

Functions are `#[no_mangle] pub extern "C"` — see `wasm/wasi.rs` for the
full list.

Naming convention: `hypen_<action>`. Return value: `i32` (0 = success,
non-zero = error code; detail string via `hypen_get_last_error`).

| C function | Input JSON shape | Notes |
|------------|------------------|-------|
| `hypen_init()` / `hypen_destroy()` | — | Thread-local `WasiEngine`. |
| `hypen_get_revision()` | — | Returns u64. |
| `hypen_render_source(src, len)` | UTF-8 DSL source | Stores imports in `IMPORT_BUFFER`. |
| `hypen_render_into(src, parent_id, state)` | DSL + parent ID + JSON state | |
| `hypen_update_state(patch)` | JSON patch | Consumes `active_action_scope`. |
| `hypen_update_state_sparse(update)` | `{paths, values}` (`SparseStateUpdate`) | Consumes `active_action_scope`. |
| `hypen_update_module_state(config)` | `{name, state}` | Bypasses the active scope; explicit named-module update. |
| `hypen_set_context(name, data)` / `hypen_remove_context(name)` | | |
| `hypen_set_module(config)` / `hypen_register_module(config)` | `ModuleConfig` JSON | |
| `hypen_register_action(name)` | UTF-8 name | Pushes to `registered_actions`. |
| `hypen_dispatch_action(action)` | `ActionPayload` JSON | Sets `active_action_scope`; writes serialized action to `ACTION_BUFFER`. |
| `hypen_register_primitive(name)` / `hypen_register_default_primitives()` | | |
| `hypen_register_component(name, source, path)` | | |
| `hypen_register_resources(json_map)` | `{name: svg, ...}` | |
| `hypen_get_patches(out, len)` / `hypen_get_patches_len()` / `hypen_clear_patches()` | — | Drain the patch buffer. |
| `hypen_get_action(out, len)` / `hypen_get_action_len()` / `hypen_clear_action()` | — | Drain the action buffer. |
| `hypen_get_last_error(out, len)` / `hypen_get_last_error_len()` / `hypen_clear_last_error()` | — | Drain the error buffer. |

Quirks:
- **Single-threaded only.** State is stored in `thread_local!` RefCells
  (`wasm/wasi.rs:42`). Multi-threaded runtimes must ensure all calls go to
  the same thread.
- **`active_action_scope` latch.** Between a `hypen_dispatch_action` and
  the next `hypen_update_state[_sparse]`, the active scope is buffered in
  the WasiEngine. The host must call `hypen_update_state` *before* it
  dispatches another action if it wants the state update routed to the
  first action's module. Concurrent or reordered dispatches are not
  supported.
- **Patches are serialized as JSON into `PATCH_BUFFER`** (`wasm/wasi.rs:82`
  via `emit_patches_internal`). The host polls `hypen_get_patches_len`,
  allocates, copies, and clears.
- **Node-ID index.** `WasiEngine::node_id_index` is populated on every
  Create patch so `hypen_render_into` can map an opaque ID string back to
  a `NodeId` without scanning the tree.

### 12.3 `uniffi/mod.rs` — UniFFI Records (Kotlin, Swift, Python, Ruby)

Wire format: **UniFFI-generated Records with JSON-string fields** for
complex data. Simple fields (names, booleans, ints) are native types.

```rust
#[uniffi::Record]
pub struct Patch {
    pub patch_type: PatchType,
    pub id: String,
    pub element_type: Option<String>,
    pub props_json: Option<String>,     // serde_json::to_string of props
    pub name: Option<String>,
    pub value_json: Option<String>,
    pub text: Option<String>,
    pub parent_id: Option<String>,
    pub before_id: Option<String>,
}
```

The `InternalPatch` → UniFFI `Patch` conversion at `uniffi/mod.rs:62` stringifies
the `props` and `value` fields so the host language can decode them with its
own JSON library (avoids UniFFI's generic-type limitations).

Public methods on `HypenEngine` (all `#[uniffi::export]`):

| Method | Signature | Behavior |
|--------|-----------|----------|
| `new()` | `-> Arc<Self>` | Constructor. |
| `parse_to_json(source)` | | Debug helper. |
| `render_source(source)` | `-> Vec<Patch>` | Returns patches directly. Stores imports in `pending_imports`. |
| `update_state(scope, state_json)` | `-> Vec<Patch>` | Empty-string scope = primary. |
| `update_state_sparse(scope, paths_json, values_json)` | `-> Vec<Patch>` | Paths and values are both JSON strings. |
| `set_module(config)` / `register_module(config)` | | `ModuleConfig` with `initial_state_json: String`. |
| `register_action(name)` | | Pushes to `registered_actions`. |
| `dispatch_action(name, payload_json)` | | Queues into `pending_actions` **if the action is in `registered_actions`**. Hosts call `action_scope_for` separately to learn which module owns the action. |
| `action_scope_for(action_name)` | `-> Option<String>` | Returns `Some(name)` for named-module actions, `None` for primary-slot or unknown. Mirrors the engine's flattened `Option<String>` semantics (§4.5). |
| `get_pending_actions()` | `-> Vec<Action>` | Drains the queue. |
| `get_pending_imports()` | `-> Vec<ImportInfo>` | Drains imports from last render. |
| `set_context(name, data_json)` | `-> Result<Vec<Patch>, HypenError>` | Parses JSON, calls `core.set_context`, then `core.render_dirty()`, returns the resulting patch batch. Mirrors the auto-render semantics of `wasm/js.rs::set_context` and `wasm/wasi.rs::hypen_set_context`. |
| `remove_context(name)` | `-> Result<Vec<Patch>, HypenError>` | Same auto-render shape as `set_context`. |
| `register_resource(name, svg)` / `register_resources(json)` | | |
| `register_primitive(name)` / `register_default_primitives()` | | |
| `get_default_primitives()` | `-> Vec<String>` | Snapshot of the constant. |
| `register_component(def: ComponentDef)` | | `ComponentDef { name, source, path }`. |
| `clear_tree()` | | |
| `get_revision()` | `-> u64` | |

Quirks:
- **No `active_action_scope` latch.** Unlike WASI, the UniFFI binding does
  not buffer the action's owning scope between `dispatch_action` and the
  next `update_state`. Hosts call `action_scope_for(action_name)`
  themselves to learn the scope and pass it explicitly to `update_state`.
  This is fine because UniFFI hosts (Kotlin/Swift) typically have their
  own action handler dispatch infrastructure that can carry the scope
  through their own state machine.
- **`set_context` / `remove_context` auto-render.** Both methods call
  `render_dirty()` internally and return the resulting patch batch — same
  shape as `update_state`. This matches the JS and WASI patterns and
  diverges from raw `EngineCore`, which requires the caller to invoke
  `render_dirty` separately.
- **Mutex serialization.** All `HypenEngine` methods take the state mutex;
  no reentrancy. Calling back into the engine from inside a UniFFI
  callback will deadlock.

---

## 13. Invariants every SDK must respect

1. **`register_module` before `dispatch_action`.** Actions declared by a
   module are only routed via `action_module_map` after `register_module`
   populates the map. Dispatching before registration yields no-op
   scope lookups.
2. **Scope strings are case-insensitive at the engine boundary** (§4.2).
   SDKs may store display-casing but must not assume the engine preserves
   it — internal keys are always lowercased.
3. **Data-source provider names are case-sensitive.** `set_context("X",
   …)` and `set_context("x", …)` are two different providers.
4. **Don't mutate state outside `update_state` / `update_state_sparse`**
   if you want the dependency graph to be consistent. The engine does
   not observe mutations; it only reacts to the paths you pass in.
   (Exception: the native `Engine::notify_state_change` hook accepts a
   pre-computed `StateChange` for hosts that own their own observable
   state.)
5. **Call `render_dirty` after `update_state`** — or rely on the binding
   wrapper to do so. The raw `EngineCore::update_state` does not render.
6. **Register primitives** before rendering. Primitives that aren't
   registered will hit the component resolver and may fail with a
   "component not found" error if the resolver doesn't know about them.
7. **Call `register_default_primitives` once** during engine init unless
   you're intentionally subsetting the primitive list.
8. **Clear the instance tree before re-rendering a whole new UI.** A new
   `render_ir_node` call will attempt to reconcile the new IR against
   the existing tree, which is usually correct but can produce surprising
   cross-subtree moves if the new IR has nothing in common with the old.
   Explicit `clear_tree()` guarantees a clean slate at the cost of more
   Create/Insert patches.
9. **Don't rely on serialized node IDs being stable across engine
   instances.** They're monotonic integers in a process-global counter.
10. **Filter spurious removes on the emit path.** Every binding calls
    `EngineCore::filter_spurious_removes` before forwarding patches to
    the host. New bindings must do the same.
11. **The prop `"0"` is reserved for positional arguments.** Renderers
    should not allow users to name their own prop `"0"`.
12. **`__iconPaths`, `__iconViewBox`, `__lazy`, `__lazy_child`,
    `__condition`, `__location` are reserved prop names.** The engine
    injects them; renderers must handle them if present. User components
    must not emit them.
13. **Always pass data sources by whole-object replacement.** The engine
    does not diff nested data-source updates — the host is responsible
    for constructing the new provider state and calling `set_context`
    with the full JSON blob. Sparse merging, if desired, is an SDK-level
    concern.
14. **Re-emitting a full render wipes the dependency graph.** Any dirty
    flags scheduled but not yet rendered are lost.
15. **`__hypen_bind` is a reserved action name.** SDKs that intend `.bind()`
    on form controls (Input, Textarea, Checkbox, Switch, Select, Slider) to
    work must auto-register a handler for this action that writes
    `payload.value` into module state at the dotted path `payload.path`.
    The renderer dispatches `__hypen_bind` with `{path: string, value: any}`
    on every form-control change; without the SDK-side handler the engine
    drops the action with `ActionNotFound` and two-way binding silently
    fails. Reference implementations:
    - TypeScript: `hypen-web/packages/core/src/app.ts:691`
    - Go: `hypen-golang/app.go` (in the shared `newModuleInstance` body)
    - Kotlin: `hypen-kotlin/src/main/kotlin/space/hypen/core/BaseModuleInstance.kt:135`
    - Swift: `hypen-server-swift/Sources/HypenServer/ModuleInstance.swift:46,85`
    - Rust: `hypen-sdk-rs/src/module.rs::ModuleInstance::handle_bind_action`
      (typed-state SDKs round-trip through JSON to validate the bind path
      exists on the user's state struct; binds to non-existent fields
      surface as `SdkError::StateSerde`)

---

## 14. Things the engine intentionally does NOT do

- **Does not run action handlers.** The host's handler (JS closure, native
  `Fn`, WASI polled action buffer, UniFFI `get_pending_actions` consumer)
  runs the logic. The engine just routes the name.
- **Does not own a render loop.** There is no `tick` method, no frame
  scheduler. The host pulls patches after each `update_state` /
  `render_source` by reading its binding's patch sink.
- **Does not own the module lifecycle.** `ModuleInstance::mount` and
  `unmount` (`lifecycle/module.rs:168`, `lifecycle/module.rs:179`) fire
  `on_created` / `on_destroyed` callbacks stored on the instance, but no
  path inside `EngineCore` calls them. Mounting modules is the host's
  responsibility. The JS, WASI, and UniFFI bindings never call mount at
  all — they assume the host has already synchronized lifecycle with its
  own state machine.
- **Does not validate state shapes.** State is `serde_json::Value`
  end-to-end. Type checking happens at the host language boundary
  (TypeScript types, Kotlin/Swift typed DSL, etc.) and is not enforced by
  the engine.
- **Does not persist state.** `Module::persist` is a boolean hint that
  SDKs may act on; the engine does not serialize anything to disk.
- **Does not validate DSL source.** `hypen_parser` produces the AST; any
  error is bubbled up as an engine error. The engine does not do a
  semantic pass beyond AST → IR conversion.
- **Does not resolve URL imports.** `ImportSource::Url` is forwarded to
  the binding's import-handling layer (JS's `resolveImports`, Kotlin/Swift
  via `get_pending_imports`), which must fetch the remote content and
  feed it back through `register_component`.
- **Does not track file dependencies for hot reload.** The host watches
  files and calls `clear_resolved_components` + re-render when they
  change.
- **Does not enforce action-name uniqueness across modules.** If two
  `register_module` calls declare the same action name, the second wins
  in `action_module_map` and the first module's routing breaks silently.
- **Does not emit events for state changes.** There is no observer API;
  the only output is the patch stream.
- **Does not version the patch wire format.** Bindings talk to the engine
  in-process; wire compatibility is a same-build guarantee. The Remote UI
  protocol in `serialize/remote.rs` layers a revision field on top for
  out-of-process transport.

---

## 15. Known gaps and contradictions

This section is for the SDK author to validate and fix before relying on
the contract above. See the "Recently fixed" footer for items that were
gaps when this document was first written and have since been resolved.

1. **`register_module` does not track per-action ownership conflicts.**
   Two modules declaring the same action silently overwrite each other
   in `action_module_map`. The second `register_module` call wins; the
   first module's routing for that action breaks silently. Consider
   erroring on collision (preferred) or at least logging a warning.

2. **`Binding` variants as described by some early task specs.** Some
   external descriptions mention a fourth `BindingSource::Module(name)`
   variant. The engine code has only three variants: `State`, `Item`,
   `DataSource`. There is no `Module` variant. Module scope is an
   *orthogonal* `module_scope: Option<String>` field on `Element` /
   control-flow nodes, applied at reconcile time (not a binding source).
   Documenting here so the next person who reads "module bindings" in
   an old design note doesn't go looking for a variant that never
   existed.

3. **Dirty renders do not clear the dependency graph.** If a control-
   flow subtree shrinks during a dirty render (e.g., a `When` branch
   becomes inactive), the orphaned dependencies remain in the graph
   until the next full `render_ir_node`. They're functionally dead
   because their node IDs are removed via `remove_subtree`, but the
   graph's `dependencies` map keeps empty `IndexSet<NodeId>` entries.

4. **`Patch::SetText` is defined but not emitted on the primary path.**
   The reconciler uses `SetProp` for positional text changes
   (`Text("Hello") → SetProp { name: "0", value: "Hello" }`). Renderers
   must still handle `SetText` to be forward-compatible. The variant
   carries a clarifying doc comment in `reconcile/patch.rs` so future
   readers don't get confused. Decision about whether to start emitting
   it (or remove it) is deferred.

5. **Component resolution caching conflates the "context path" key
   with a failure marker** (`ir/component.rs:214`). SDKs that
   aggressively manipulate context paths should be aware that failed
   resolutions are cached under the exact `(path, name)` key and won't
   retry even if the resolver behavior changes at runtime. Use
   `clear_resolved()` to blow the cache.

---

### Recently fixed

The following gaps were identified in an earlier version of this document
and have since been resolved. Listed here so SDK authors reviewing the
changelog know what changed:

- **`hypen-sdk-rs::sync_state_to_engine` silent state-update drop.** The
  SDK installed its module via `engine.set_module(...)` (primary slot) but
  then called `engine.update_state(Some(&self.definition.name), patch)`
  with a non-empty scope. Under `canon_scope` the lookup missed the named
  modules map and `update_state` returned `false` — every state update was
  silently dropped. **Fix:** the SDK now passes `None` as the scope. The
  pre-existing `test_patches_emitted_on_state_change` regression test now
  passes against the fix.

- **`set_module` did not populate `action_module_map`.** Primary-module
  actions were unreachable through `action_scope_for`. **Fix:** the map's
  value type is now `IndexMap<String, Option<String>>` where `None` =
  primary slot, `Some(name)` = named module. Both `set_module` and
  `register_module` populate the map with eviction on re-installation so
  stale routing can't leak across replacements. `action_scope_for`
  flattens the lookup so the externally-visible "primary or unknown →
  None" contract is preserved.

- **UniFFI missing `set_context` / `remove_context`.** Added as
  auto-rendering methods that return `Result<Vec<Patch>, HypenError>`,
  matching the JS and WASI conventions.

- **UniFFI missing `action_scope_for`.** Added as a thin delegate to
  `core.action_scope_for` returning `Option<String>`.

- **`set_context` only scanned top-level keys for dirty propagation.**
  `set_context` now uses `DependencyGraph::get_data_source_affected_nodes`
  (the same helper `remove_context` already used) so deeply-nested data-
  source bindings (`@spacetime.user.name`) are correctly invalidated on
  whole-provider replacement. The per-top-level-key loop has been
  removed.

---

## Appendix A: File map

| File | Purpose |
|------|---------|
| `hypen-engine-rs/src/engine.rs` | Native Rust embedding (`Engine`) |
| `hypen-engine-rs/src/engine_core.rs` | Shared core wrapped by every binding |
| `hypen-engine-rs/src/state.rs` | `StateChange` path extraction |
| `hypen-engine-rs/src/render.rs` | Dirty-node rendering |
| `hypen-engine-rs/src/lifecycle/module.rs` | `Module`, `ModuleInstance`, merge / sparse-set |
| `hypen-engine-rs/src/dispatch/action.rs` | `Action`, `ActionDispatcher` |
| `hypen-engine-rs/src/reactive/binding.rs` | `Binding`, `BindingSource`, template-string parse |
| `hypen-engine-rs/src/reactive/graph.rs` | `DependencyGraph` and key namespacing |
| `hypen-engine-rs/src/reactive/scheduler.rs` | Dirty-node set |
| `hypen-engine-rs/src/ir/node.rs` | `IRNode`, `Element`, `Value` |
| `hypen-engine-rs/src/ir/component.rs` | `Component`, `ComponentRegistry`, resolver |
| `hypen-engine-rs/src/ir/expand.rs` | AST → IR lowering and scope propagation |
| `hypen-engine-rs/src/ir/icon.rs` | SVG parsing and icon resolution |
| `hypen-engine-rs/src/reconcile/diff.rs` | Reconcile entry points |
| `hypen-engine-rs/src/reconcile/patch.rs` | Patch enum and node-ID serialization |
| `hypen-engine-rs/src/reconcile/resolve.rs` | Binding and template resolution |
| `hypen-engine-rs/src/reconcile/tree.rs` | `InstanceTree`, `InstanceNode` |
| `hypen-engine-rs/src/reconcile/keyed.rs` | Keyed-list diff |
| `hypen-engine-rs/src/reconcile/conditionals.rs` | When/If branch matching |
| `hypen-engine-rs/src/reconcile/item_bindings.rs` | ForEach item substitution |
| `hypen-engine-rs/src/wasm/ffi.rs` | Shared FFI types (`ModuleConfig`, `ActionPayload`, `SparseStateUpdate`, `ResolvedComponent`, `FfiResult`) |
| `hypen-engine-rs/src/wasm/js.rs` | wasm-bindgen `WasmEngine` |
| `hypen-engine-rs/src/wasm/wasi.rs` | C ABI `WasiEngine` |
| `hypen-engine-rs/src/uniffi/mod.rs` | UniFFI `HypenEngine` |
| `hypen-engine-rs/src/serialize/remote.rs` | Remote UI wire protocol (`RemoteMessage`, revision tracking) |

---

## Appendix B: Engine error types

`EngineError` (`hypen-engine-rs/src/error.rs`) is the canonical error type
for every operation surfaced through the native `Engine` API. SDK authors
catching engine errors should pattern-match on these variants — see the
inline rustdoc on each variant for details.

| Variant | Carries | Emitted by | When |
|---------|---------|-----------|------|
| `ParseError { source, message }` | input text (truncated to 80 chars) and parser message | `render_source`, `render_into`, `register_component` | DSL source fails to tokenize/parse via `hypen_parser`. `source` is a prefix of the offending input for context. |
| `ComponentNotFound(name)` | component name | `expand_ir_node`, transitively from any render | A referenced component was not registered as a primitive, not present in the registry, and not resolvable by the resolver. |
| `RenderError(message)` | free-form message | `reconcile_ir`, `render_dirty`, internal reconciler paths | Reconciliation produced an inconsistent tree state, or an internal invariant tripped. The `From<String> for EngineError` impl maps bare string errors to this variant — treat it as the catch-all. |
| `ActionNotFound(name)` | action name | `Engine::dispatch_action` (`engine.rs:247`) | The native action dispatcher tried to invoke a handler for a name that was never registered via `Engine::on_action`. **Not** emitted by the JS/WASI/UniFFI bindings — those silently drop unknown actions or queue them depending on their dispatch model. |
| `StateError(message)` | free-form message | `update_state`, `update_state_sparse`, sparse-update path walker | A state patch could not be merged (deserialization failure, invalid path, type collision in `set_value_at_path`, etc.). |
| `ExpressionError(message)` | exprimo error message | `evaluate_template_string`, `evaluate_expression` | A `@{...}` expression failed to evaluate — usually because a referenced state path is missing, the expression has a type error, or exprimo's parser rejected it. The reconciler swallows these into the result `null`/empty-string in most code paths, but they surface as `EngineError::ExpressionError` when the host calls `evaluate_template_string` directly. |

### Cross-binding error mapping

Each binding wraps `EngineError` differently:

| Binding | Wrapped as | Detail |
|---------|-----------|--------|
| Native `Engine` | `EngineError` directly | `Result<T, EngineError>` |
| `WasmEngine` (JS) | `JsValue` via `structuredError(type, message)` (`wasm/js.rs:27`) | `error.type` is the variant name in lowercase camelCase (`"parseError"`, `"componentNotFound"`, etc.) |
| `WasiEngine` | byte buffer in `LAST_ERROR_BUFFER`, plus a non-zero return code from the C function | Host reads via `hypen_get_last_error`. The error message is the `Display` impl on `EngineError`. Variant tagging is not preserved across the C boundary — hosts must parse the message string. |
| `HypenEngine` (UniFFI) | `HypenError` enum (`uniffi/mod.rs:184`) with variants `ParseError`, `RenderError`, `StateError`, `ActionError`, `ComponentError`, `InitializationError` | The `From<EngineError> for HypenError` impl (`uniffi/mod.rs:199`) does the variant mapping. Note: `ExpressionError` collapses into `RenderError` because UniFFI doesn't expose expression evaluation. |

### Variant defaults SDK authors should know

- **`ParseError::source` is truncated** to 60 characters in the `Display`
  impl (`error.rs:73`) but stored in full on the variant. Pattern-matching
  hosts should use the field directly, not the formatted string, for full
  context.
- **`From<String> for EngineError`** maps bare strings to `RenderError`
  (`error.rs:97`). This is a backwards-compat shim from before the
  structured-error refactor — internal engine code that returns
  `Result<_, String>` becomes `RenderError` automatically. New code
  should use the structured variants directly.
- **The `EngineError` enum is `Clone + PartialEq`** (`error.rs:41`).
  Tests that assert on specific error variants can compare for equality.
- **`EngineError` does not preserve a backtrace** — it's a value type.
  If your host language needs stack traces, capture them at the dispatch
  site before the error reaches the SDK boundary.

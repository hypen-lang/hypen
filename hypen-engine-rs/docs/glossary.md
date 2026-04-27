# Glossary

Key terms and concepts used throughout the Hypen Engine documentation and codebase.

---

| Term | Definition |
|------|------------|
| **Action** | A named event dispatched from UI to module logic via `@actions.xxx` syntax. Actions carry an optional payload and are handled by module action handlers. |
| **Applicator** | A chained method call on a component (e.g., `.fontSize(18)`, `.padding(16)`) that sets styling or behavioral properties. Converted to props during IR expansion. |
| **Binding** | A reactive reference to state, an iteration item, or a data-source context. Written as `@{state.xxx}`, `@{item.xxx}`, or `@provider.xxx`. Bindings are tracked by the dependency graph and trigger re-renders when their path changes. |
| **BindingSource** | The origin of a binding — `State` (module state), `Item` (current iteration item in a ForEach), or `DataSource(provider)` (a host-registered data-source context). Module scope is **not** a binding source — it's an orthogonal `module_scope` field on `Element` and control-flow nodes. |
| **Component** | A reusable UI building block. Can be a template function (regular), a passthrough container (Router/Route), or a lazy-loaded component. |
| **ComponentResolver** | A host-provided callback that resolves component names to source code. Enables file-based component discovery and lazy loading. |
| **Conditional** | An `IRNode` variant representing `When` or `If` control flow. Contains branches with patterns and an optional fallback. |
| **Control Flow** | First-class IR constructs (`ForEach`, `When`/`If`) that manage iteration and conditional rendering. Transparent in the DOM — their children render directly into the parent. |
| **DependencyGraph** | The reactive tracking structure that maps state paths to dependent node IDs. Uses a prefix index (BTreeMap) for efficient affected-node lookups. |
| **Element** | The core IR type representing a UI component instance. Contains `element_type`, `props`, `children`, and an optional `key`. |
| **ForEach** | An `IRNode` variant for iterating over arrays from state. Renders template children for each item with optional keyed reconciliation. |
| **IR** | Intermediate Representation — the canonical form after parsing. The engine operates on IR nodes, not raw AST. |
| **IRNode** | A union type: `Element`, `ForEach`, `Conditional`, or `Router`. The type system ensures exhaustive handling in the reconciler. |
| **Instance Tree** | The virtual representation of the current UI state. A SlotMap-based tree of `InstanceNode` values that the reconciler diffs against new IR to generate patches. |
| **InstanceNode** | A concrete node in the instance tree. Contains resolved props, raw props (with bindings), optional control flow metadata, parent/child relationships, and an optional key. |
| **Key** | A unique identifier assigned to list items for stable reconciliation. Enables the LIS algorithm to minimize DOM moves. Set via `key` prop in ForEach or `.key()` applicator. |
| **Lazy Component** | A component whose children are not expanded during the initial pass. Expansion is deferred until `renderLazyComponent()` is called. Used for code splitting. |
| **LIS** | Longest Increasing Subsequence — the algorithm used during keyed reconciliation to determine which children are already in correct relative order and don't need Move patches. |
| **Module** | A stateful controller that manages data and responds to events. Defines state shape, action handlers, and lifecycle hooks. The engine maintains one optional **primary** module slot (installed via `set_module`) and a map of **named** modules (installed via `register_module`); they coexist and a multi-module app uses both. See ENGINE_CONTRACT.md §4 for the slot semantics. |
| **ModuleInstance** | A runtime instance of a Module with actual state data. Created when a module is mounted. |
| **NodeId** | A SlotMap key that provides stable, unique identification for nodes in the instance tree. O(1) lookup, type-safe, and automatically reuses removed slots. |
| **Passthrough Component** | A component (like Router/Route) that preserves its props and expands its children, but skips template transformation. The engine passes it through to the renderer as-is. |
| **Patch** | A single mutation instruction for renderers. Seven variants: `Create`, `SetProp`, `RemoveProp`, `SetText`, `Insert`, `Move`, `Remove`. Platform-agnostic — all renderers receive the same format. Note: `SetText` is reserved for future use; the reconciler currently emits text changes as `SetProp { name: "0", … }`. |
| **Prefix Index** | A `BTreeMap<String, IndexSet<String>>` in the dependency graph that maps path prefixes to full paths. Enables O(log n) child-path lookups instead of O(n) scans. |
| **Primitive** | An element type registered with the engine that should be passed through to the renderer without resolution (e.g., `Text`, `Column`, `Button`). |
| **Props** | An `Arc<IndexMap<String, Value>>` map of properties on an element. Arc-wrapped for O(1) clone with copy-on-write semantics via `make_mut()`. |
| **Reconciliation** | The process of diffing the old instance tree against new IR to generate the minimal set of patches. Uses keyed children matching and the LIS algorithm for efficient updates. |
| **Remote UI** | A protocol for client-server UI streaming where the engine runs on a server and patches are sent to a client renderer over WebSocket or similar transport. |
| **Revision** | A monotonically increasing counter incremented on each state update. Used by the Remote UI protocol to ensure patches are applied in order. |
| **Slot** | A named insertion point in a component template where parent children can be placed. Set via the `.slot("name")` applicator. |
| **State** | The reactive data managed by a module. Accessed in DSL via `@{state.xxx}` bindings. Mutations are tracked by the host via Proxy (TypeScript) or equivalent. |
| **StateChange** | A notification that specific state paths have changed, triggering re-rendering of affected nodes. |
| **Template String** | A string value containing embedded bindings: `"Count: @{state.count}"`. The engine extracts all bindings for dependency tracking while preserving the template for runtime evaluation. |
| **Transparent Node** | A control flow node (`__ForEach`, `__Conditional`) that exists in the instance tree for bookkeeping but does not produce a DOM element. Its children render directly into its parent. |
| **Value** | The IR value type with four variants: `Static` (literal), `Binding` (reactive reference), `TemplateString` (mixed text and bindings), and `Action` (event handler reference). |

---

## Binding Syntax Reference

| Syntax | Type | Example | Description |
|--------|------|---------|-------------|
| `@{state.xxx}` | State binding | `@{state.user.name}` | References module state |
| `@{item.xxx}` | Item binding | `@{item.id}` | References current ForEach item |
| `@{item}` | Bare item | `@{item}` | References the entire item object |
| `@state.xxx` | State reference | `@state.user` | Alternative syntax for state binding |
| `@item.xxx` | Item reference | `@item.name` | Alternative syntax for item binding |
| `@item` | Bare item ref | `@item` | Alternative syntax for entire item |
| `@actions.xxx` | Action | `@actions.signIn` | References a module action handler |
| `"text @{state.x}"` | Template | `"Hello @{state.name}"` | Embedded binding in string |

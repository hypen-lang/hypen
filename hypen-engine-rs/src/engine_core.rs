//! Shared engine core logic extracted from `Engine` and `WasmEngine`.
//!
//! `EngineCore` owns the fields and methods that are identical across the
//! native Rust engine and the WASM engine, eliminating duplication in
//! module registration, state updates, data-source context management,
//! and dirty-node rendering.

use crate::{
    ir::{ComponentRegistry, IRNode, ResourceRegistry},
    lifecycle::{Module, ModuleInstance},
    reactive::{DependencyGraph, Scheduler},
    reconcile::{reconcile_ir_with_ds, InstanceTree, Patch},
    state::StateChange,
};
use indexmap::IndexMap;
use std::collections::HashSet;

/// Static null value to avoid cloning state when no module exists.
static NULL_STATE: serde_json::Value = serde_json::Value::Null;

/// Shared fields and methods for all engine variants (native, WASM, UniFFI).
pub(crate) struct EngineCore {
    pub component_registry: ComponentRegistry,
    pub resource_registry: ResourceRegistry,
    pub module: Option<ModuleInstance>,
    pub modules: IndexMap<String, ModuleInstance>,
    pub tree: InstanceTree,
    pub dependencies: DependencyGraph,
    pub scheduler: Scheduler,
    pub revision: u64,
    pub data_sources: IndexMap<String, serde_json::Value>,
    /// Maps action name → owning module scope. `None` = primary slot
    /// (installed via [`set_module`]); `Some(name)` = named module (installed
    /// via [`register_module`]). This lets [`action_scope_for`] return the
    /// correct scope for both primary and named modules without a sentinel
    /// string collision.
    /// Action name -> every scope that declared it, in registration order.
    ///
    /// A plain `name -> scope` map loses information the moment two modules
    /// declare the same action name (`submit` is the obvious one): the second
    /// registration overwrote the first, so unregistering the second deleted
    /// the name outright and the first module's still-live action stopped being
    /// listed and stopped dispatching. Keeping the owners lets a scope be
    /// removed without disturbing a sibling that shares the name.
    ///
    /// The *last* owner wins for routing, preserving the previous behaviour of
    /// [`action_scope_for`] — the flat dispatcher still holds one handler per
    /// name, so last-registered is who actually runs.
    pub action_module_map: IndexMap<String, Vec<Option<String>>>,
    /// Action names that actually have a handler installed.
    ///
    /// Every binding now records here, not just the polling ones: declaring an
    /// action and installing its handler are separate steps, and remote or
    /// discovered module definitions can declare names whose handler lives on
    /// another peer. Without this the external listing advertised actions that
    /// `dispatch_external` then refused — and the WASI binding, which already
    /// gated on it, disagreed with the others.
    pub registered_actions: Vec<String>,
    /// Normalized batch-animation spec stored by an `update_state` /
    /// `update_state_sparse` call that carried an animation context (Option
    /// D cheap subset). Consumed (taken) by the NEXT [`render_dirty`] cycle:
    /// if that cycle produced patches, `Patch::BatchAnimation` is prepended
    /// as the batch's first patch; if it produced none, the stamp is
    /// discarded silently — no stamp without patches.
    pub pending_animation: Option<serde_json::Value>,
    /// Declared navigation targets, keyed by declaring scope **and** by the
    /// template that declared them. Union of the values is what the external
    /// surface reports.
    ///
    /// Accumulated per template rather than held as one last-rendered tree.
    /// A single `root_ir` was the obvious design and it was wrong: every SDK's
    /// `ManagedRouter` calls `render_ir_node` again on each navigation, and a
    /// whole-tree replace meant the shell's `Router` vanished the moment the
    /// agent navigated into a route — so `hypen.navigate` worked exactly once
    /// and then reported no routes at all.
    ///
    /// Keying by scope alone fixed that only where the templates differed in
    /// scope. Two templates under the *same* scope — a shell and a route body
    /// both written inside `module App`, or both written with no module at all
    /// — still clobbered each other, which is exactly the shape the scope fix
    /// was meant to protect. The template id makes each render replace only
    /// what that same template said last time.
    pub declared_routes: IndexMap<DeclarationKey, Vec<crate::agent::AgentRoute>>,

    /// Declared writable inputs, keyed by declaring scope and template. Same
    /// accumulation rule and same reason as [`declared_routes`](Self::declared_routes).
    pub declared_bindings: IndexMap<DeclarationKey, Vec<crate::agent::BoundInput>>,

    /// State paths the templates actually reference, keyed by scope and
    /// template. This is the external **read** surface: a path the UI renders
    /// is already on the user's screen, and a path it never mentions stays
    /// unreadable.
    pub declared_state_refs: IndexMap<DeclarationKey, Vec<String>>,

    /// Where the templates invoke each action, and with which arguments, keyed
    /// by scope and template. Same accumulation rule as the tables above.
    ///
    /// This does not widen anything: `action_module_map` still decides what may
    /// be dispatched. It only says how a listed action is meant to be *called*,
    /// which a bare name cannot — `addToCart` alone never told a caller it
    /// takes a `sku`.
    pub declared_call_sites: IndexMap<DeclarationKey, Vec<crate::agent_core::CallSite>>,

    /// Scopes whose only module is the hollow placeholder
    /// [`auto_register_scoped_modules`](Self::auto_register_scoped_modules)
    /// invents for a `module X { … }` wrapper the host never installed a module
    /// under.
    ///
    /// Recorded because a placeholder is indistinguishable from a real module
    /// by inspection — both are a `ModuleInstance` in `modules` — and the
    /// external surface has to tell them apart. A placeholder holds `{}`
    /// forever, so a read addressed at one always comes back empty, and
    /// publishing its scope as a module both advertises reads that cannot
    /// serve and hides the fact that the real state is in the primary slot.
    /// See `agent_core::primary_scope`.
    pub placeholder_scopes: HashSet<String>,

    /// Scopes that have had a template's declarations evicted by the
    /// [`MAX_TEMPLATES_PER_SCOPE`] backstop.
    ///
    /// An eviction silently un-declares part of a live app, so it is recorded
    /// and surfaced in the manifest's `degraded` list. Reaching it at all means
    /// something is generating templates without bound.
    pub evicted_templates: HashSet<Option<String>>,
}

/// Declaring module scope plus the id of the template that declared it.
///
/// The scope half is what a module owns and what destroying it removes; the
/// template half is what a re-render replaces.
pub type DeclarationKey = (Option<String>, u64);

/// How many distinct templates one scope may hold declarations for.
///
/// A backstop against pathological growth, not a working limit. Re-rendering a
/// template replaces its own entry, so this counts DISTINCT templates — for a
/// real app, roughly its component count — and only unbounded template
/// generation can reach it.
///
/// It was 64, which a component library alone exceeds, and eviction is
/// oldest-first: a shell that mounts once and never re-renders is the oldest
/// entry there is, so it was evicted first while still on screen. Its routes
/// stopped being navigable and the paths it renders stopped being readable,
/// purely because the user had visited enough screens. Raised far above any
/// real app, and an eviction is now recorded rather than silent — see
/// `evicted_templates`.
const MAX_TEMPLATES_PER_SCOPE: usize = 4096;

impl EngineCore {
    pub fn new() -> Self {
        Self {
            component_registry: ComponentRegistry::new(),
            resource_registry: ResourceRegistry::new(),
            module: None,
            modules: IndexMap::new(),
            tree: InstanceTree::new(),
            dependencies: DependencyGraph::new(),
            scheduler: Scheduler::new(),
            revision: 0,
            data_sources: IndexMap::new(),
            action_module_map: IndexMap::new(),
            registered_actions: Vec::new(),
            pending_animation: None,
            declared_routes: IndexMap::new(),
            declared_bindings: IndexMap::new(),
            declared_state_refs: IndexMap::new(),
            evicted_templates: HashSet::new(),
            declared_call_sites: IndexMap::new(),
            placeholder_scopes: HashSet::new(),
        }
    }

    // ── Component & Resource Registration ──────────────────────────────

    /// Register a custom component.
    pub fn register_component(&mut self, component: crate::ir::Component) {
        self.component_registry.register(component);
    }

    /// Set the component resolver for dynamic component loading.
    pub fn set_component_resolver<F>(&mut self, resolver: F)
    where
        F: Fn(&str, Option<&str>) -> Option<crate::ir::ResolvedComponent> + Send + Sync + 'static,
    {
        self.component_registry
            .set_resolver(std::sync::Arc::new(resolver));
    }

    /// Register a single resource from raw SVG content.
    pub fn register_resource(&mut self, name: &str, svg: &str) {
        self.resource_registry.register(name, svg);
    }

    /// Register multiple resources from a name -> SVG map.
    pub fn register_resources(&mut self, map: IndexMap<String, String>) {
        self.resource_registry.register_map(map);
    }

    // ── Module Management ──────────────────────────────────────────────

    /// Set the primary module instance (backward-compatible single-module API).
    ///
    /// Also registers the module's declared actions in `action_module_map`
    /// with a `None` scope so that [`action_scope_for`] resolves primary-slot
    /// actions for polling bindings (WASI/UniFFI). If a primary module was
    /// already installed, any of its action entries in the map are evicted
    /// first so stale routing can't leak across replacements.
    pub fn set_module(&mut self, module: ModuleInstance) {
        // Drop this scope's previous claims, keeping every other owner's.
        self.evict_action_scope(&None);
        // A new primary instance never inherits exit completions owed to
        // whatever was installed before it.
        self.tree.retain_exit_tombstones(|_| false);
        for action in &module.module.actions {
            self.action_module_map
                .entry(action.clone())
                .or_default()
                .push(None);
        }
        self.module = Some(module);
    }

    /// Register a named module for multi-module apps.
    ///
    /// Also registers the module's declared actions in the action->module map
    /// so that `update_state` after `dispatch_action` automatically routes
    /// to the correct module. If a named module with this key was already
    /// registered, its previous action entries are evicted first to prevent
    /// stale routing.
    pub fn register_module(&mut self, name: impl Into<String>, module: ModuleInstance) {
        let name = name.into().to_lowercase();
        // Evict any existing claims by this scope before re-registering, while
        // leaving intact any other module that declares the same action name.
        let scope = Some(name.clone());
        self.evict_action_scope(&scope);
        // A real module now backs this scope, whatever the render-time
        // placeholder was.
        self.placeholder_scopes.remove(&name);
        // A fresh instance under this scope must not receive the previous
        // instance's in-flight `.exit` completions.
        self.tree
            .retain_exit_tombstones(|t| t.scope.as_deref() != Some(name.as_str()));
        for action in &module.module.actions {
            self.action_module_map
                .entry(action.clone())
                .or_default()
                .push(scope.clone());
        }
        self.modules.insert(name, module);
    }

    /// Get a named module's state (for reconciler lookups).
    pub fn get_module_state(&self, name: &str) -> Option<&serde_json::Value> {
        self.modules.get(name).map(|m| m.get_state())
    }

    // ── State Updates ──────────────────────────────────────────────────

    /// Canonicalize a scope: returns `None` for the primary slot, otherwise
    /// the lowercased module name. Lets callers pass scopes in any case
    /// without worrying about matching the engine's internal convention.
    fn canon_scope(scope: Option<&str>) -> Option<String> {
        scope.filter(|s| !s.is_empty()).map(|s| s.to_lowercase())
    }

    /// Apply a state patch and schedule affected nodes for re-render.
    ///
    /// `scope` selects which module's state slot is updated:
    /// - `None` → primary module (`self.module`)
    /// - `Some(name)` → named module in `self.modules`. Case is normalized
    ///   to match the lowercased key used by [`register_module`], so callers
    ///   can pass any casing.
    ///
    /// Returns `true` if state actually changed (so callers can skip
    /// rendering when the patch was a no-op). Affected nodes are looked up
    /// using the same scope: primary updates invalidate raw paths, named
    /// updates invalidate `mod:name:path`.
    ///
    /// `animation` is the optional batch-animation context (Option D cheap
    /// subset): a spec object or bare curve string. When the update actually
    /// changed state, the normalized spec is stored as pending and the next
    /// [`render_dirty`](Self::render_dirty) cycle emits it as a
    /// `Patch::BatchAnimation` prelude. A no-op update never stamps.
    pub fn update_state(
        &mut self,
        scope: Option<&str>,
        patch: serde_json::Value,
        animation: Option<serde_json::Value>,
    ) -> bool {
        let scope = Self::canon_scope(scope);

        // Derive the changed paths *before* handing the patch to the module —
        // `from_json` only needs a borrow, so doing it first lets the patch be
        // moved into the merge instead of deep-cloned. For a wholesale list
        // update that payload is the entire array.
        let change = StateChange::from_json(&patch);

        // `update_state` reports whether it actually wrote anything, comparing
        // at the leaves the patch touches. Never snapshot the state Arc around
        // this call: a live second reference makes `Arc::make_mut` deep-clone
        // the whole tree on every update.
        let changed = match scope.as_deref() {
            Some(name) => match self.modules.get_mut(name) {
                Some(module) => module.update_state(patch),
                None => return false,
            },
            None => match &mut self.module {
                Some(module) => module.update_state(patch),
                None => return false,
            },
        };

        if !changed {
            return false;
        }

        self.stamp_pending_animation(animation);

        self.schedule_dirty_for_paths(scope.as_deref(), change.paths());
        true
    }

    /// Apply a sparse state patch (path-value pairs) and schedule re-render.
    ///
    /// See [`update_state`] for `scope` and `animation` semantics. Sparse
    /// updates only touch the listed paths, which is more efficient than
    /// passing a deep clone of the full state when only a few leaves changed.
    pub fn update_state_sparse(
        &mut self,
        scope: Option<&str>,
        paths: &[String],
        values: &serde_json::Value,
        animation: Option<serde_json::Value>,
    ) -> bool {
        let scope = Self::canon_scope(scope);
        // See `update_state`: the mutation reports change at the written
        // leaves, so there is no state snapshot and no whole-tree compare.
        let changed = match scope.as_deref() {
            Some(name) => match self.modules.get_mut(name) {
                Some(module) => module.update_state_sparse(paths, values),
                None => return false,
            },
            None => match &mut self.module {
                Some(module) => module.update_state_sparse(paths, values),
                None => return false,
            },
        };

        if !changed {
            return false;
        }

        self.stamp_pending_animation(animation);

        self.schedule_dirty_for_paths(scope.as_deref(), paths.iter().map(|s| s.as_str()));
        true
    }

    /// Loosely validate and normalize a host-supplied animation context and
    /// store it as the pending batch stamp. Called only after an update
    /// actually changed state — a no-op dispatch never stamps. An invalid
    /// spec warns (inside the normalizer) and leaves the engine unstamped.
    fn stamp_pending_animation(&mut self, animation: Option<serde_json::Value>) {
        if let Some(spec) = animation.and_then(crate::ir::anim::normalize_batch_animation) {
            self.pending_animation = Some(spec);
        }
    }

    /// Mark every node bound to one of `paths` (under `scope`) as dirty.
    ///
    /// Each path is recorded with its marking (`mark_dirty_for_path`) so the
    /// renderer can narrow iterable re-reconciliation to touched indices.
    fn schedule_dirty_for_paths<'p>(
        &mut self,
        scope: Option<&str>,
        paths: impl IntoIterator<Item = &'p str>,
    ) {
        for path in paths {
            let key = match scope {
                Some(name) => format!("mod:{}:{}", name, path),
                None => path.to_string(),
            };
            let affected = self.dependencies.get_affected_nodes(&key);
            self.scheduler
                .mark_dirty_for_path(&key, affected.iter().copied());
        }
    }

    /// Schedule dirty nodes from a `StateChange` (primary module paths).
    pub fn schedule_from_state_change(&mut self, change: &StateChange) {
        for path in change.paths() {
            let affected = self.dependencies.get_affected_nodes(path);
            self.scheduler
                .mark_dirty_for_path(path, affected.iter().copied());
        }
    }

    // ── Data Source Context ────────────────────────────────────────────

    /// Set (or replace) a named data source context.
    ///
    /// Registers the provider in the dependency graph (if not already known),
    /// stores the data, and marks **every** node bound to anything under
    /// `ds:{name}:…` (including deeply nested paths like
    /// `ds:spacetime:user.name`) as dirty. The caller must call
    /// `render_dirty()` afterwards.
    ///
    /// Note: this replaces the entire provider blob, so we invalidate every
    /// subscriber regardless of which nested key changed — there is no sparse
    /// diff. Hosts that want granular invalidation should construct their
    /// own patch strategy at the SDK layer.
    pub fn set_context(&mut self, name: &str, data: serde_json::Value) {
        self.dependencies.register_data_source_provider(name);

        let affected = self.dependencies.get_data_source_affected_nodes(name);

        self.data_sources.insert(name.to_string(), data);

        if !affected.is_empty() {
            self.scheduler.mark_many_dirty(affected.iter().copied());
        }
    }

    /// Classify an action name as a data-source action and build the
    /// `{provider, method, payload}` envelope all FFI bindings forward to
    /// their data-source action handler.
    ///
    /// Returns `None` when `name` doesn't contain a `.`, or when the prefix
    /// before the `.` isn't a registered data-source provider. Bindings call
    /// this on the fall-through path of `dispatch_action` after exact-match
    /// handler lookup fails, so the same routing rules live in one place.
    #[cfg_attr(
        not(all(target_arch = "wasm32", any(feature = "js", feature = "wasi"))),
        allow(dead_code)
    )]
    pub fn build_data_source_action(
        &self,
        name: &str,
        payload: serde_json::Value,
    ) -> Option<serde_json::Value> {
        let dot = name.find('.')?;
        let provider = &name[..dot];
        if !self.data_sources.contains_key(provider) {
            return None;
        }
        let method = &name[dot + 1..];
        Some(serde_json::json!({
            "provider": provider,
            "method": method,
            "payload": payload,
        }))
    }

    /// Remove a data source context entirely and mark bound nodes dirty.
    /// The caller must call `render_dirty()` afterwards.
    pub fn remove_context(&mut self, name: &str) {
        self.data_sources.shift_remove(name);

        let affected = self.dependencies.get_data_source_affected_nodes(name);
        if !affected.is_empty() {
            self.scheduler.mark_many_dirty(affected.iter().copied());
        }
    }

    /// Fold one expanded template's declarations into the per-template tables.
    ///
    /// `template` identifies the template being rendered, so only what *this*
    /// template said last time is replaced. That is the whole point: a router
    /// re-rendering one route must not erase the shell's route table, nor
    /// another route's bound inputs — and, since a shell and a route body
    /// routinely share a scope, scope alone cannot tell them apart.
    fn absorb_declarations(&mut self, expanded: &IRNode, template: u64) {
        use indexmap::IndexMap as Map;

        // Retire everything this template said last time, *then* record what it
        // says now. Inserting alone left behind exactly what the developer had
        // deleted: a template that no longer declares a `Route` or a `.bind()`
        // produces no entry to overwrite the old one with, so the route stayed
        // navigable and the field stayed writable for the life of the process —
        // the `hypen dev` hot-reload loop, failing the rule in the one
        // direction that matters.
        //
        // Keyed on the template id alone, across every scope: this retires only
        // what *this* template declared, so a shell and the route body inside it
        // — two templates under one scope — still both contribute, and a
        // template that moved its declarations from one scope to another leaves
        // nothing behind under the old one.
        self.declared_routes.retain(|(_, t), _| *t != template);
        self.declared_bindings.retain(|(_, t), _| *t != template);
        self.declared_state_refs.retain(|(_, t), _| *t != template);
        self.declared_call_sites.retain(|(_, t), _| *t != template);

        let mut routes: Map<Option<String>, Vec<crate::agent::AgentRoute>> = Map::new();
        for route in crate::agent_core::extract_routes(expanded) {
            routes
                .entry(route.module_scope.clone())
                .or_default()
                .push(route);
        }
        for (scope, list) in routes {
            self.declared_routes.insert((scope.clone(), template), list);
            bound_scope(
                &mut self.declared_routes,
                &scope,
                &mut self.evicted_templates,
            );
        }

        let mut binds: Map<Option<String>, Vec<crate::agent::BoundInput>> = Map::new();
        for input in crate::agent_core::extract_bindings(expanded) {
            binds
                .entry(input.module_scope.clone())
                .or_default()
                .push(input);
        }
        for (scope, list) in binds {
            self.declared_bindings
                .insert((scope.clone(), template), list);
            bound_scope(
                &mut self.declared_bindings,
                &scope,
                &mut self.evicted_templates,
            );
        }

        // State references are grouped by the scope of the node that owns each
        // binding — never by the template's first scope, which filed every path
        // against whichever module appeared first and made a second module's
        // paths readable in the first module's state.
        let mut refs: Map<Option<String>, Vec<String>> = Map::new();
        for (scope, path) in crate::agent_core::extract_state_refs(expanded) {
            refs.entry(scope).or_default().push(path);
        }
        for (scope, list) in refs {
            self.declared_state_refs
                .insert((scope.clone(), template), list);
            bound_scope(
                &mut self.declared_state_refs,
                &scope,
                &mut self.evicted_templates,
            );
        }

        // Call sites key by template scope for the same reason as state refs:
        // a call site names an action, and an action name carries no scope of
        // its own — `action_module_map` is what resolves it to an owner.
        let sites = crate::agent_core::extract_call_sites(expanded);
        if !sites.is_empty() {
            let scope = template_scope(expanded);
            self.declared_call_sites
                .insert((scope.clone(), template), sites);
            bound_scope(
                &mut self.declared_call_sites,
                &scope,
                &mut self.evicted_templates,
            );
        }
    }

    // ── Rendering ──────────────────────────────────────────────────────

    /// Expand components, resolve icons, and reconcile an IR node against the
    /// current tree, returning the resulting patches. Clears and rebuilds the
    /// dependency graph.
    pub fn render_ir_node(&mut self, ir_node: &IRNode) -> Vec<Patch> {
        let mut expanded = self.component_registry.expand_ir_node(ir_node);

        if !self.resource_registry.is_empty() {
            crate::ir::resolve_icons_in_ir(&self.resource_registry, &mut expanded);
        }

        // Auto-register placeholder modules for any module_scope values
        // found in the expanded IR that aren't already registered.
        self.auto_register_scoped_modules(&expanded);

        // Harvest what this template *declares* — routes and writable inputs —
        // for the external capability surface. Done here, once per render,
        // rather than by walking the tree on every listing call.
        //
        // Templates absent from this render keep whatever they declared
        // before; this one is replaced wholesale, so a re-render cannot leave
        // its own stale entries behind. Identity comes from the node the
        // caller handed us, before component expansion: expansion pulls in
        // whatever the registry currently resolves to, so hashing the expanded
        // tree would give one template two identities the moment a component
        // it uses is re-registered.
        self.absorb_declarations(&expanded, template_id(ir_node));

        let state: &serde_json::Value = self
            .module
            .as_ref()
            .map(|m| m.get_state())
            .unwrap_or(&NULL_STATE);

        self.dependencies.clear();

        let ds = if self.data_sources.is_empty() {
            None
        } else {
            Some(&self.data_sources)
        };
        let mods = if self.modules.is_empty() {
            None
        } else {
            Some(&self.modules)
        };
        let patches = reconcile_ir_with_ds(
            &mut self.tree,
            &expanded,
            None,
            state,
            &mut self.dependencies,
            ds,
            mods,
        );

        self.revision += 1;
        patches
    }

    /// Render only dirty nodes and return the resulting patches.
    ///
    /// Consumes the pending batch-animation stamp (if any): a cycle that
    /// produced patches gets `Patch::BatchAnimation` prepended as its FIRST
    /// patch; a cycle that produced none discards the stamp silently — a
    /// stamped update whose diff is empty must not leak the stamp into a
    /// later, unrelated render.
    pub fn render_dirty(&mut self) -> Vec<Patch> {
        let animation = self.pending_animation.take();
        let ds = if self.data_sources.is_empty() {
            None
        } else {
            Some(&self.data_sources)
        };
        let mods = if self.modules.is_empty() {
            None
        } else {
            Some(&self.modules)
        };
        let mut patches = crate::render::render_dirty_nodes_full(
            &mut self.scheduler,
            &mut self.tree,
            self.module.as_ref(),
            &mut self.dependencies,
            ds,
            mods,
        );

        if !patches.is_empty() {
            self.revision += 1;
            if let Some(spec) = animation {
                patches.insert(0, Patch::batch_animation(spec));
            }
        }

        patches
    }

    /// Filter out Remove patches for elements that were Created in the same
    /// batch. This happens when a conditional re-reconciles module-scoped
    /// children whose stored template doesn't carry module_scope.
    ///
    /// An `Instantiate` creates every id in its `nodes` list, so those ids
    /// count as created too — the filter must behave identically whether a
    /// boundary expands template patches before or after it runs.
    pub fn filter_spurious_removes(patches: &mut Vec<Patch>) {
        // Removes are the small side of any batch — one per removed subtree
        // root, against every id a Create or Instantiate mints (a 1,000-row
        // replace carries ~1,000 Removes and ~17,000 created ids; a create
        // carries no Removes at all). Hash the Removes and probe the
        // creations against them, never the reverse — and hash nothing at
        // all unless the batch has both kinds.
        let (mut removes, mut creates) = (false, false);
        for p in patches.iter() {
            match p {
                Patch::Remove { .. } => removes = true,
                Patch::Create { .. } | Patch::Instantiate { .. } => creates = true,
                _ => {}
            }
        }
        if !(removes && creates) {
            return;
        }
        let removed: std::collections::HashSet<&std::sync::Arc<str>> = patches
            .iter()
            .filter_map(|p| match p {
                Patch::Remove { id, .. } => Some(id),
                _ => None,
            })
            .collect();
        let spurious: std::collections::HashSet<std::sync::Arc<str>> = patches
            .iter()
            .flat_map(|p| match p {
                Patch::Create { id, .. } => std::slice::from_ref(id),
                Patch::Instantiate { nodes, .. } => nodes.as_slice(),
                _ => &[],
            })
            .filter(|id| removed.contains(id))
            .cloned()
            .collect();
        if spurious.is_empty() {
            return;
        }
        patches.retain(|p| !matches!(p, Patch::Remove { id, .. } if spurious.contains(id)));
    }

    /// Look up which named module owns an action and return its scope, if any.
    ///
    /// Returns:
    /// - `Some(name)` — action is owned by a named module registered via
    ///   [`register_module`]. Polling bindings route follow-up `update_state`
    ///   calls to that module.
    /// - `None` — action is either owned by the primary module (installed via
    ///   [`set_module`]) or not registered at all. In both cases polling
    ///   bindings should route follow-up updates to the primary slot, which
    ///   is the correct default.
    pub fn action_scope_for(&self, action_name: &str) -> Option<String> {
        if let Some((scope, _)) = crate::action_routing::split_scoped_action(action_name) {
            return (!scope.is_empty()).then(|| scope.to_string());
        }
        // Last owner wins: the dispatcher holds one handler per name, so the
        // most recent registrant is the one that actually runs.
        self.action_module_map
            .get(action_name)
            .and_then(|owners| owners.last())
            .cloned()
            .flatten()
    }

    /// Record that a handler now exists for `name`. Idempotent.
    pub fn note_handler(&mut self, name: &str) {
        if !self.registered_actions.iter().any(|a| a == name) {
            self.registered_actions.push(name.to_string());
        }
    }

    /// Remove one scope's claim on every action, dropping names nobody owns.
    ///
    /// Shared by registration (re-registering a scope) and by
    /// `agent_core::unregister_module` (destroying one), so both agree on what
    /// "this scope no longer declares that" means.
    pub fn evict_action_scope(&mut self, scope: &Option<String>) {
        for owners in self.action_module_map.values_mut() {
            owners.retain(|o| o != scope);
        }
        self.action_module_map
            .retain(|_, owners| !owners.is_empty());
    }

    /// Scan an expanded IR tree for `module_scope` values and auto-register
    /// placeholder modules for any scopes not already in `self.modules`.
    /// Skips scopes that match the primary module (by name, or the first scope
    /// when the primary module has a generic/anonymous name).
    pub fn auto_register_scoped_modules(&mut self, ir_node: &IRNode) {
        let mut scopes = HashSet::new();
        collect_module_scopes_ir(ir_node, &mut scopes);

        if scopes.is_empty() {
            return;
        }

        // Determine which scope belongs to the primary module.
        // If the primary module's name matches a scope, skip it.
        // If the primary module has an anonymous/generic name, the FIRST scope
        // in the expanded IR (typically the root `module X {}` declaration)
        // is assumed to be the primary module.
        let primary_name = self.module.as_ref().map(|m| m.module.name.to_lowercase());

        let primary_scope: Option<String> = if let Some(ref name) = primary_name {
            if scopes.contains(name.as_str()) {
                Some(name.clone())
            } else {
                // Primary module name doesn't match any scope — it's anonymous/generic.
                // Find the first scope that isn't already a registered named module.
                scopes
                    .iter()
                    .find(|s| !self.modules.contains_key(s.as_str()))
                    .cloned()
            }
        } else {
            None
        };

        for scope in scopes {
            if self.modules.contains_key(&scope) {
                continue;
            }
            if primary_scope.as_deref() == Some(scope.as_str()) {
                continue;
            }
            let module = Module::new(&scope);
            let instance = ModuleInstance::new(module, serde_json::json!({}));
            self.placeholder_scopes.insert(scope.clone());
            self.modules.insert(scope, instance);
        }
    }
}

fn collect_module_scopes_ir(node: &IRNode, scopes: &mut HashSet<String>) {
    crate::ir::walk::walk_ir(node, &mut |n| {
        if let IRNode::Element(element) = n {
            if let Some(ref scope) = element.module_scope {
                scopes.insert(scope.clone());
            }
        }
    });
}

impl Default for EngineCore {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn declarations_are_bounded_per_scope_oldest_first() {
        // The tables are append-only across a session, so a router app that
        // visits enough screens would otherwise retain every template it ever
        // rendered. Distinct templates, one scope, one route each.
        let mut core = EngineCore::new();
        let overflow = MAX_TEMPLATES_PER_SCOPE + 6;
        for i in 0..overflow {
            let source =
                format!(r#"module App {{ Router {{ Route(path: "/r{i}") {{ Text("x") }} }} }}"#);
            let doc = hypen_parser::parse_document(&source).expect("parse");
            let ir = crate::ir::ast_to_ir_node(doc.components.first().expect("component"));
            core.render_ir_node(&ir);
        }

        let scope = Some("app".to_string());
        let kept: Vec<&(Option<String>, u64)> = core
            .declared_routes
            .keys()
            .filter(|(s, _)| *s == scope)
            .collect();
        assert_eq!(kept.len(), MAX_TEMPLATES_PER_SCOPE);

        let paths: Vec<String> = crate::agent_core::list_routes(&core)
            .into_iter()
            .map(|r| r.path)
            .collect();
        assert!(!paths.contains(&"/r0".to_string()), "oldest goes first");
        assert!(
            paths.contains(&format!("/r{}", overflow - 1)),
            "newest stays"
        );
    }

    #[test]
    fn filter_spurious_removes_drops_flagged_remove_for_created_id() {
        let mut patches = vec![
            Patch::Create {
                id: "7".into(),
                element_type: "Row".to_string(),
                props: Arc::new(IndexMap::new()),
                semantics: None,
            },
            Patch::Remove {
                id: "7".into(),
                transition: true,
            },
            Patch::Remove {
                id: "9".into(),
                transition: true,
            },
        ];

        EngineCore::filter_spurious_removes(&mut patches);

        // The created-in-batch Remove is dropped — its exit flag goes with
        // the pair. The unrelated flagged Remove survives intact.
        assert_eq!(patches.len(), 2);
        assert!(matches!(&patches[0], Patch::Create { id, .. } if id.as_ref() == "7"));
        assert!(
            matches!(&patches[1], Patch::Remove { id, transition: true } if id.as_ref() == "9"),
            "unrelated flagged Remove must keep its transition flag: {:?}",
            patches[1]
        );
    }

    #[test]
    fn filter_spurious_removes_leaves_batch_animation_untouched() {
        // The batch-animation prelude is batch metadata, not a node op —
        // the spurious-remove filter must pass it through in position
        // (FIRST), even when the filter actually drops a Create/Remove pair.
        let spec = serde_json::json!({"curve": "spring", "duration": 250});
        let mut patches = vec![
            Patch::batch_animation(spec.clone()),
            Patch::Create {
                id: "7".into(),
                element_type: "Row".to_string(),
                props: Arc::new(IndexMap::new()),
                semantics: None,
            },
            Patch::Remove {
                id: "7".into(),
                transition: false,
            },
        ];

        EngineCore::filter_spurious_removes(&mut patches);

        assert_eq!(patches.len(), 2);
        assert!(
            matches!(&patches[0], Patch::BatchAnimation { spec: s } if *s == spec),
            "BatchAnimation must survive the filter as the first patch: {:?}",
            patches[0]
        );
        assert!(matches!(&patches[1], Patch::Create { id, .. } if id.as_ref() == "7"));
    }

    #[test]
    fn filter_spurious_removes_counts_instantiate_nodes_as_created() {
        // Ids minted inside an Instantiate are creations: a same-batch
        // Remove targeting one of them is exactly as spurious as one
        // targeting a plain Create, on boundaries that expand after the
        // filter (js, native) no less than ones that expand before (wasi).
        let mut patches = vec![
            Patch::Instantiate {
                template_id: "t0.0".to_string(),
                parent_id: "3".into(),
                before_id: None,
                nodes: vec!["10".into(), "11".into()],
                subs: vec![],
                semantics: vec![],
            },
            Patch::Remove {
                id: "11".into(),
                transition: false,
            },
            Patch::Remove {
                id: "9".into(),
                transition: false,
            },
        ];

        EngineCore::filter_spurious_removes(&mut patches);

        assert_eq!(patches.len(), 2);
        assert!(matches!(&patches[0], Patch::Instantiate { .. }));
        assert!(
            matches!(&patches[1], Patch::Remove { id, .. } if id.as_ref() == "9"),
            "only the instantiated-in-batch Remove is dropped: {:?}",
            patches[1]
        );
    }
}

/// Keep one scope's declarations bounded, dropping the oldest template first.
fn bound_scope<T>(
    map: &mut IndexMap<DeclarationKey, T>,
    scope: &Option<String>,
    evicted: &mut HashSet<Option<String>>,
) {
    while map.keys().filter(|(s, _)| s == scope).count() > MAX_TEMPLATES_PER_SCOPE {
        let Some(oldest) = map.keys().find(|(s, _)| s == scope).cloned() else {
            return;
        };
        // `shift_remove`, not `swap_remove`: insertion order *is* the FIFO
        // order this eviction reads back.
        map.shift_remove(&oldest);
        // Never silent. An eviction un-declares part of an app that may still
        // be on screen, so the manifest reports the scope as degraded rather
        // than simply offering less than it should.
        evicted.insert(scope.clone());
    }
}

/// Structural id of a template, stable across renders of the same source.
///
/// Hashes the serialized IR rather than deriving `Hash`: `IRNode` carries
/// `serde_json::Value` throughout, which is not `Hash`, and a hand-rolled
/// field-by-field hash would silently stop distinguishing whatever field
/// someone later adds and forgets to feed it. Serialization covers the tree by
/// construction. The hash need only be stable within a process — nothing
/// persists it — so `DefaultHasher` is fine, and the bytes go straight into it
/// rather than through an intermediate `String`.
fn template_id(node: &IRNode) -> u64 {
    use std::hash::Hasher;

    struct HashSink<'a>(&'a mut std::collections::hash_map::DefaultHasher);
    impl std::io::Write for HashSink<'_> {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0.write(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    // Serializing an IRNode cannot fail for any tree the engine can hold; a
    // partial write still hashed whatever it managed, which is as good an id.
    let _ = serde_json::to_writer(HashSink(&mut hasher), node);
    hasher.finish()
}

/// The module scope a template's bindings resolve against.
///
/// Bindings carry no scope of their own — they resolve against the enclosing
/// `module X { … }`. Takes the first scope the tree declares, which is the
/// enclosing module for anything rendered through `render_ir_node`.
fn template_scope(root: &IRNode) -> Option<String> {
    let mut found = None;
    crate::ir::walk::walk_ir(root, &mut |node| {
        if found.is_some() {
            return;
        }
        found = match node {
            IRNode::Element(e) => e.module_scope.clone(),
            IRNode::Conditional { module_scope, .. } | IRNode::Router { module_scope, .. } => {
                module_scope.clone()
            }
            IRNode::ForEach { .. } => None,
        };
    });
    found
}

//! Theming and design tokens.
//!
//! One [`Theme`] per app (per session for Remote UI) owns the design tokens
//! and the active color scheme, and publishes them to the engine as two
//! data-source contexts:
//!
//! - `theme` — the resolved tokens: the base set with the active scheme's
//!   overrides merged on top. Templates read `.color(@theme.color.primary)`,
//!   `.padding(@theme.space.md)`, `Text("@{theme.font.body}")`.
//! - `appearance` — `{ scheme, preference, system, schemes }`, read as
//!   `@appearance.scheme` (e.g. to pick an icon).
//!
//! Switching scheme republishes `theme`; the engine diffs it against the
//! previous value and re-renders only the nodes bound to tokens whose value
//! actually changed.
//!
//! A token value may be an alias of another token, written
//! `"{color.blue.500}"` (the whole string). Aliases are resolved after the
//! scheme merge, so a semantic token defined once in the base set
//! (`primary: "{color.brand}"`) follows a scheme that overrides
//! `color.brand`.
//!
//! ```rust
//! use hypen_server::theme::Theme;
//! use serde_json::json;
//!
//! let theme = Theme::builder()
//!     .tokens(json!({ "color": { "brand": "#0066ff", "primary": "{color.brand}" } }))
//!     .scheme_tokens("dark", json!({ "color": { "brand": "#66a3ff" } }))
//!     .build();
//!
//! assert_eq!(theme.token("color.primary"), Some(json!("#0066ff")));
//! theme.set_scheme("dark").unwrap();
//! assert_eq!(theme.token("color.primary"), Some(json!("#66a3ff")));
//! ```
//!
//! A `Theme` is a cheap handle (`Clone`, `Send + Sync`); clones are the same
//! theme. It is safe to call from action and lifecycle handlers: engines are
//! reached through [`ContextSink`]s, which defer to the end of the running
//! dispatch — the point at which a handler's state changes are applied too.

use std::collections::HashSet;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};

use indexmap::IndexMap;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::data_source::ContextSink;
use crate::error::{Result, SdkError};

/// Reserved data-source provider carrying the resolved tokens.
pub const THEME_TOKENS_PROVIDER: &str = "theme";
/// Reserved data-source provider carrying `{ scheme, preference, … }`.
pub const THEME_META_PROVIDER: &str = "appearance";
/// The preference that follows the platform's color scheme.
pub const SYSTEM_SCHEME: &str = "system";

/// Longest alias chain followed before giving up (a cycle is reported earlier).
const MAX_ALIAS_DEPTH: usize = 32;

/// A color scheme the platform itself can report.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SystemScheme {
    #[default]
    Light,
    Dark,
}

impl SystemScheme {
    pub fn as_str(self) -> &'static str {
        match self {
            SystemScheme::Light => "light",
            SystemScheme::Dark => "dark",
        }
    }
}

impl fmt::Display for SystemScheme {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Snapshot published as the `appearance` data source.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ThemeMeta {
    /// The scheme in effect (never `"system"`).
    pub scheme: String,
    /// What was asked for: a scheme name or `"system"`.
    pub preference: String,
    /// The platform's scheme as last reported.
    pub system: SystemScheme,
    /// Scheme names that have overrides defined.
    pub schemes: Vec<String>,
}

type MissingTokenFn = Arc<dyn Fn(&str, &str) + Send + Sync>;
type ChangeFn = Arc<dyn Fn(&ThemeMeta) + Send + Sync>;

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/// A segment a template reference (`@theme.a.b`) can address.
fn is_referenceable_key(key: &str) -> bool {
    !key.is_empty() && key.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_')
}

/// The path inside a whole-string `"{a.b.c}"` alias.
fn alias_target(value: &Value) -> Option<&str> {
    let path = value.as_str()?.strip_prefix('{')?.strip_suffix('}')?;
    path.split('.').all(is_referenceable_key).then_some(path)
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(map) => map,
        Value::Null => Map::new(),
        other => {
            log::warn!("Theme tokens must be a JSON object, got {other}; ignored");
            Map::new()
        }
    }
}

/// Deep-merge `primary` over `fallback`.
fn merge_tokens(
    fallback: Option<&Map<String, Value>>,
    primary: &Map<String, Value>,
) -> Map<String, Value> {
    let mut out = fallback.cloned().unwrap_or_default();
    for (key, value) in primary {
        let merged = match value {
            Value::Object(group) => {
                Value::Object(merge_tokens(out.get(key).and_then(Value::as_object), group))
            }
            leaf => leaf.clone(),
        };
        out.insert(key.clone(), merged);
    }
    out
}

fn lookup<'a>(tokens: &'a Map<String, Value>, path: &str) -> Option<&'a Value> {
    let mut segments = path.split('.');
    let mut current = tokens.get(segments.next()?)?;
    for segment in segments {
        current = current.as_object()?.get(segment)?;
    }
    (!current.is_null()).then_some(current)
}

/// Copy of `tokens` with every `"{path}"` alias replaced by the value it
/// points at (a leaf or a whole group). An alias that is missing or part of
/// a cycle is reported through `report` and left as written. A non-object
/// `tokens` is returned unchanged.
pub fn resolve_token_aliases(tokens: &Value, report: &mut dyn FnMut(String)) -> Value {
    match tokens {
        Value::Object(map) => Value::Object(resolve_aliases(map, report)),
        other => other.clone(),
    }
}

fn resolve_aliases(
    tokens: &Map<String, Value>,
    report: &mut dyn FnMut(String),
) -> Map<String, Value> {
    fn follow<'a>(
        tokens: &'a Map<String, Value>,
        value: &'a Value,
        at: &str,
        report: &mut dyn FnMut(String),
    ) -> &'a Value {
        let mut seen = vec![at];
        let mut current = value;
        for _ in 0..MAX_ALIAS_DEPTH {
            let Some(target) = alias_target(current) else {
                return current;
            };
            let inside_target = at
                .strip_prefix(target)
                .is_some_and(|rest| rest.starts_with('.'));
            if seen.contains(&target) || inside_target {
                seen.push(target);
                report(format!("Token alias cycle: {}", seen.join(" -> ")));
                return value;
            }
            let Some(next) = lookup(tokens, target) else {
                report(format!(
                    "Token \"{at}\" aliases \"{target}\", which is not defined"
                ));
                return value;
            };
            seen.push(target);
            current = next;
        }
        report(format!(
            "Token \"{at}\" has an alias chain longer than {MAX_ALIAS_DEPTH}"
        ));
        value
    }

    fn walk(
        tokens: &Map<String, Value>,
        group: &Map<String, Value>,
        prefix: &str,
        depth: usize,
        report: &mut dyn FnMut(String),
    ) -> Map<String, Value> {
        let mut out = Map::new();
        for (key, value) in group {
            let at = if prefix.is_empty() {
                key.clone()
            } else {
                format!("{prefix}.{key}")
            };
            let resolved = if value.is_object() {
                value
            } else {
                follow(tokens, value, &at, report)
            };
            // A group reached through an alias can itself hold aliases (and
            // could alias back into its own parent), hence the depth bound.
            let resolved = match resolved {
                Value::Object(inner) if depth < MAX_ALIAS_DEPTH => {
                    Value::Object(walk(tokens, inner, &at, depth + 1, report))
                }
                other => other.clone(),
            };
            out.insert(key.clone(), resolved);
        }
        out
    }

    walk(tokens, tokens, "", 0, report)
}

fn warn_unreferenceable_keys(
    tokens: &Map<String, Value>,
    prefix: &str,
    warned: &mut HashSet<String>,
) {
    for (key, value) in tokens {
        let at = if prefix.is_empty() {
            key.clone()
        } else {
            format!("{prefix}.{key}")
        };
        if !is_referenceable_key(key) && warned.insert(at.clone()) {
            log::warn!(
                "Token key \"{at}\" cannot be referenced from a template; use letters, digits and \"_\" only"
            );
        }
        if let Value::Object(group) = value {
            warn_unreferenceable_keys(group, &at, warned);
        }
    }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/// Builder for a [`Theme`]. Start with [`Theme::builder`].
#[derive(Default)]
pub struct ThemeOptions {
    tokens: Map<String, Value>,
    schemes: IndexMap<String, Map<String, Value>>,
    scheme: Option<String>,
    system_scheme: SystemScheme,
    on_missing_token: Option<MissingTokenFn>,
}

impl ThemeOptions {
    pub fn new() -> Self {
        Self::default()
    }

    /// Tokens shared by every scheme: a (nested) JSON object whose leaves
    /// are strings, numbers or booleans.
    pub fn tokens(mut self, tokens: Value) -> Self {
        self.tokens = object(tokens);
        self
    }

    /// Overrides merged over the base tokens while scheme `name` is active.
    /// `light` and `dark` are what `"system"` resolves to; any other name is
    /// a scheme selected explicitly with [`Theme::set_scheme`].
    pub fn scheme_tokens(mut self, name: impl Into<String>, tokens: Value) -> Self {
        self.schemes.insert(name.into(), object(tokens));
        self
    }

    /// Every scheme's overrides at once: `{ "dark": { … }, "sepia": { … } }`.
    pub fn schemes(mut self, schemes: Value) -> Self {
        for (name, tokens) in object(schemes) {
            self.schemes.insert(name, object(tokens));
        }
        self
    }

    /// Which scheme to use: a scheme name, or `"system"` (the default) to
    /// follow the platform. An unknown name is logged and follows the system.
    pub fn scheme(mut self, preference: impl Into<String>) -> Self {
        self.scheme = Some(preference.into());
        self
    }

    /// What `"system"` resolves to until the platform reports otherwise
    /// ([`Theme::set_system_scheme`]). Defaults to light.
    pub fn system_scheme(mut self, scheme: SystemScheme) -> Self {
        self.system_scheme = scheme;
        self
    }

    /// Called with `(path, scheme)` the first time each missing token is
    /// looked up via [`Theme::token`].
    pub fn on_missing_token<F>(mut self, handler: F) -> Self
    where
        F: Fn(&str, &str) + Send + Sync + 'static,
    {
        self.on_missing_token = Some(Arc::new(handler));
        self
    }

    pub fn build(self) -> Theme {
        Theme::new(self)
    }
}

// ---------------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------------

/// The token store shared by a theme and its forks.
struct Store {
    base: Map<String, Value>,
    schemes: IndexMap<String, Map<String, Value>>,
}

impl Store {
    fn selectable(&self) -> Vec<String> {
        let mut names = vec!["light".to_string(), "dark".to_string()];
        for name in self.schemes.keys() {
            if !names.contains(name) {
                names.push(name.clone());
            }
        }
        names
    }

    fn is_selectable(&self, preference: &str) -> bool {
        preference == SYSTEM_SCHEME
            || preference == "light"
            || preference == "dark"
            || self.schemes.contains_key(preference)
    }
}

struct Current {
    preference: String,
    system: SystemScheme,
    resolved: Map<String, Value>,
    problems: Vec<String>,
    warned: HashSet<String>,
    /// Bumped on every publish; orders snapshots handed to sinks.
    version: u64,
}

impl Current {
    fn scheme(&self) -> &str {
        if self.preference == SYSTEM_SCHEME {
            self.system.as_str()
        } else {
            &self.preference
        }
    }
}

struct SinkEntry {
    id: u64,
    sink: Arc<dyn ContextSink>,
    /// The newest snapshot version handed to this sink.
    published: AtomicU64,
}

struct Inner {
    store: Arc<Mutex<Store>>,
    // Lock order: `current`, then `store`. Neither is held while a sink or
    // a listener runs.
    current: Mutex<Current>,
    sinks: Mutex<Vec<Arc<SinkEntry>>>,
    listeners: Mutex<Vec<(u64, ChangeFn)>>,
    on_missing_token: Option<MissingTokenFn>,
    next_id: AtomicU64,
}

struct Snapshot {
    version: u64,
    meta: ThemeMeta,
    tokens: Value,
}

/// Design tokens plus the active color scheme. See the [module docs](self).
#[derive(Clone)]
pub struct Theme {
    inner: Arc<Inner>,
}

impl fmt::Debug for Theme {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Theme").field("meta", &self.meta()).finish()
    }
}

impl Default for Theme {
    fn default() -> Self {
        Theme::new(ThemeOptions::default())
    }
}

impl Theme {
    /// Start building a theme.
    pub fn builder() -> ThemeOptions {
        ThemeOptions::new()
    }

    /// Create the app's theme from `options`.
    pub fn new(options: ThemeOptions) -> Self {
        let mut warned = HashSet::new();
        warn_unreferenceable_keys(&options.tokens, "", &mut warned);
        for tokens in options.schemes.values() {
            warn_unreferenceable_keys(tokens, "", &mut warned);
        }
        let store = Arc::new(Mutex::new(Store {
            base: options.tokens,
            schemes: options.schemes,
        }));
        Self::with_store(
            store,
            options.scheme,
            options.system_scheme,
            options.on_missing_token,
            warned,
        )
    }

    fn with_store(
        store: Arc<Mutex<Store>>,
        scheme: Option<String>,
        system: SystemScheme,
        on_missing_token: Option<MissingTokenFn>,
        warned: HashSet<String>,
    ) -> Self {
        let preference = match scheme {
            Some(name) if store.lock().unwrap().is_selectable(&name) => name,
            Some(name) => {
                log::warn!("Unknown color scheme \"{name}\"; following the system scheme");
                SYSTEM_SCHEME.to_string()
            }
            None => SYSTEM_SCHEME.to_string(),
        };
        let theme = Theme {
            inner: Arc::new(Inner {
                store,
                current: Mutex::new(Current {
                    preference,
                    system,
                    resolved: Map::new(),
                    problems: Vec::new(),
                    warned,
                    version: 0,
                }),
                sinks: Mutex::new(Vec::new()),
                listeners: Mutex::new(Vec::new()),
                on_missing_token,
                next_id: AtomicU64::new(1),
            }),
        };
        theme.rebuild(&mut theme.inner.current.lock().unwrap());
        theme
    }

    /// The scheme in effect: the preference, or the system scheme when the
    /// preference is `"system"`.
    pub fn scheme(&self) -> String {
        self.inner.current.lock().unwrap().scheme().to_string()
    }

    /// What was asked for: a scheme name or `"system"`.
    pub fn preference(&self) -> String {
        self.inner.current.lock().unwrap().preference.clone()
    }

    /// The platform's scheme as last reported.
    pub fn system_scheme(&self) -> SystemScheme {
        self.inner.current.lock().unwrap().system
    }

    /// Scheme names that have overrides defined, in definition order.
    pub fn schemes(&self) -> Vec<String> {
        self.inner
            .store
            .lock()
            .unwrap()
            .schemes
            .keys()
            .cloned()
            .collect()
    }

    /// The `appearance` data-source payload.
    pub fn meta(&self) -> ThemeMeta {
        self.meta_of(&self.inner.current.lock().unwrap())
    }

    /// The resolved tokens currently published as `theme`.
    pub fn tokens(&self) -> Value {
        Value::Object(self.inner.current.lock().unwrap().resolved.clone())
    }

    /// Alias problems (missing target, cycle) in the active scheme's tokens.
    pub fn problems(&self) -> Vec<String> {
        self.inner.current.lock().unwrap().problems.clone()
    }

    /// Select a scheme by name, or `"system"` to follow the platform, then
    /// republish to every attached engine.
    ///
    /// # Errors
    ///
    /// [`SdkError::Other`] for a name that is neither `light` / `dark` /
    /// `"system"` nor defined in the theme's schemes; nothing changes.
    pub fn set_scheme(&self, preference: &str) -> Result<()> {
        let snapshot = {
            let mut current = self.inner.current.lock().unwrap();
            {
                let store = self.inner.store.lock().unwrap();
                if !store.is_selectable(preference) {
                    let mut known = vec![SYSTEM_SCHEME.to_string()];
                    known.extend(store.selectable());
                    return Err(SdkError::Other(format!(
                        "Unknown color scheme \"{preference}\". Known: {}",
                        known.join(", ")
                    )));
                }
            }
            if current.preference == preference {
                return Ok(());
            }
            let before = current.scheme().to_string();
            current.preference = preference.to_string();
            self.changed(&mut current, &before)
        };
        self.publish(snapshot);
        Ok(())
    }

    /// Flip between `light` and `dark`, starting from whichever is in effect.
    pub fn toggle(&self) {
        let snapshot = {
            let mut current = self.inner.current.lock().unwrap();
            let before = current.scheme().to_string();
            let next = if before == "dark" { "light" } else { "dark" };
            if current.preference == next {
                return;
            }
            current.preference = next.to_string();
            self.changed(&mut current, &before)
        };
        self.publish(snapshot);
    }

    /// Report the platform's scheme. Takes effect immediately when the
    /// preference is `"system"`; otherwise it is remembered for when it is.
    pub fn set_system_scheme(&self, scheme: SystemScheme) {
        let snapshot = {
            let mut current = self.inner.current.lock().unwrap();
            if current.system == scheme {
                return;
            }
            let before = current.scheme().to_string();
            current.system = scheme;
            self.changed(&mut current, &before)
        };
        self.publish(snapshot);
    }

    /// Merge more tokens in — into the base set (`scheme: None`), or into
    /// one scheme's overrides — and republish. This is how a component
    /// package contributes defaults.
    ///
    /// Forks share the token store, but a fork picks the new tokens up the
    /// next time it resolves (its own `extend` or an effective scheme
    /// change), not at once.
    pub fn extend(&self, tokens: Value, scheme: Option<&str>) {
        let tokens = object(tokens);
        let snapshot = {
            let mut current = self.inner.current.lock().unwrap();
            warn_unreferenceable_keys(&tokens, "", &mut current.warned);
            {
                let mut store = self.inner.store.lock().unwrap();
                match scheme {
                    None => store.base = merge_tokens(Some(&store.base), &tokens),
                    Some(name) => {
                        let merged = merge_tokens(store.schemes.get(name), &tokens);
                        store.schemes.insert(name.to_string(), merged);
                    }
                }
            }
            if scheme.is_some_and(|name| name != current.scheme()) {
                return;
            }
            self.rebuild(&mut current);
            self.snapshot(&mut current)
        };
        self.publish(snapshot);
    }

    /// Whether `path` (e.g. `"color.primary"`) resolves in the active scheme.
    pub fn has(&self, path: &str) -> bool {
        lookup(&self.inner.current.lock().unwrap().resolved, path).is_some()
    }

    /// A token's value in the active scheme (a leaf or a whole group), for
    /// use in handlers. A missing token returns `None`, and the first lookup
    /// of each missing path is logged and reported to `on_missing_token`.
    pub fn token(&self, path: &str) -> Option<Value> {
        let scheme = {
            let mut current = self.inner.current.lock().unwrap();
            if let Some(value) = lookup(&current.resolved, path) {
                return Some(value.clone());
            }
            if !current.warned.insert(format!("missing:{path}")) {
                return None;
            }
            current.scheme().to_string()
        };
        log::warn!("Missing theme token \"{path}\" for scheme \"{scheme}\"");
        if let Some(handler) = &self.inner.on_missing_token {
            handler(path, &scheme);
        }
        None
    }

    /// Publish `theme` and `appearance` to `sink` now and on every change.
    /// The returned handle stops publishing (it does not remove the
    /// contexts); dropping it without calling
    /// [`detach`](ThemeAttachment::detach) leaves the sink attached.
    ///
    /// A sink is an engine handle:
    /// [`ModuleInstance::context_sink`](crate::module::ModuleInstance::context_sink)
    /// or [`RemoteSession::context_sink`](crate::remote::RemoteSession::context_sink)
    /// — though `ModuleInstance::attach_theme` and `RemoteSession::with_theme`
    /// are the usual way in.
    pub fn attach(&self, sink: Arc<dyn ContextSink>) -> ThemeAttachment {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let entry = Arc::new(SinkEntry {
            id,
            sink,
            published: AtomicU64::new(0),
        });
        let snapshot = {
            let mut current = self.inner.current.lock().unwrap();
            self.inner.sinks.lock().unwrap().push(Arc::clone(&entry));
            self.snapshot(&mut current)
        };
        publish_to(&entry, &snapshot);
        ThemeAttachment(Registration {
            theme: Arc::downgrade(&self.inner),
            id,
        })
    }

    /// Listen for scheme / token changes. Listeners hear about a change at
    /// once, on the thread that made it, before engines are updated.
    pub fn on_change<F>(&self, listener: F) -> ThemeSubscription
    where
        F: Fn(&ThemeMeta) + Send + Sync + 'static,
    {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        self.inner
            .listeners
            .lock()
            .unwrap()
            .push((id, Arc::new(listener)));
        ThemeSubscription(Registration {
            theme: Arc::downgrade(&self.inner),
            id,
        })
    }

    /// A new theme with its own scheme preference that shares this one's
    /// tokens — one per Remote UI session. `None` starts from this theme's
    /// preference; the system scheme is copied; engines and listeners are
    /// not.
    pub fn fork(&self, preference: Option<&str>) -> Theme {
        let (preference, system) = {
            let current = self.inner.current.lock().unwrap();
            (
                preference.map_or_else(|| current.preference.clone(), str::to_string),
                current.system,
            )
        };
        Theme::with_store(
            Arc::clone(&self.inner.store),
            Some(preference),
            system,
            self.inner.on_missing_token.clone(),
            HashSet::new(),
        )
    }

    // ---- internals ----

    fn meta_of(&self, current: &Current) -> ThemeMeta {
        ThemeMeta {
            scheme: current.scheme().to_string(),
            preference: current.preference.clone(),
            system: current.system,
            schemes: self.schemes(),
        }
    }

    fn changed(&self, current: &mut Current, scheme_before: &str) -> Snapshot {
        if current.scheme() != scheme_before {
            self.rebuild(current);
        }
        self.snapshot(current)
    }

    fn rebuild(&self, current: &mut Current) {
        let merged = {
            let store = self.inner.store.lock().unwrap();
            match store.schemes.get(current.scheme()) {
                Some(overrides) => merge_tokens(Some(&store.base), overrides),
                None => store.base.clone(),
            }
        };
        let mut problems = Vec::new();
        current.resolved = resolve_aliases(&merged, &mut |problem| problems.push(problem));
        for problem in &problems {
            if current.warned.insert(problem.clone()) {
                log::warn!("{problem}");
            }
        }
        current.problems = problems;
    }

    fn snapshot(&self, current: &mut Current) -> Snapshot {
        current.version += 1;
        Snapshot {
            version: current.version,
            meta: self.meta_of(current),
            tokens: Value::Object(current.resolved.clone()),
        }
    }

    fn publish(&self, snapshot: Snapshot) {
        let listeners: Vec<ChangeFn> = self
            .inner
            .listeners
            .lock()
            .unwrap()
            .iter()
            .map(|(_, listener)| Arc::clone(listener))
            .collect();
        for listener in listeners {
            listener(&snapshot.meta);
        }

        let sinks: Vec<Arc<SinkEntry>> = {
            let mut sinks = self.inner.sinks.lock().unwrap();
            sinks.retain(|entry| !entry.sink.is_closed());
            sinks.clone()
        };
        for entry in sinks {
            publish_to(&entry, &snapshot);
        }
    }
}

fn publish_to(entry: &SinkEntry, snapshot: &Snapshot) {
    // Two threads changing the theme at once may reach a sink out of order;
    // a snapshot older than one the sink already took is dropped.
    if entry
        .published
        .fetch_max(snapshot.version, Ordering::SeqCst)
        >= snapshot.version
    {
        return;
    }
    let meta = serde_json::to_value(&snapshot.meta).expect("ThemeMeta serializes");
    entry.sink.set_contexts(vec![
        (THEME_META_PROVIDER.to_string(), meta),
        (THEME_TOKENS_PROVIDER.to_string(), snapshot.tokens.clone()),
    ]);
}

struct Registration {
    theme: Weak<Inner>,
    id: u64,
}

/// Returned by [`Theme::attach`]; stops publishing to that sink.
pub struct ThemeAttachment(Registration);

impl ThemeAttachment {
    /// Stop publishing to the sink. Its `theme` / `appearance` contexts keep
    /// their last value.
    pub fn detach(self) {
        if let Some(theme) = self.0.theme.upgrade() {
            theme.sinks.lock().unwrap().retain(|e| e.id != self.0.id);
        }
    }
}

/// Returned by [`Theme::on_change`]; removes that listener.
pub struct ThemeSubscription(Registration);

impl ThemeSubscription {
    pub fn unsubscribe(self) {
        if let Some(theme) = self.0.theme.upgrade() {
            theme
                .listeners
                .lock()
                .unwrap()
                .retain(|(id, _)| *id != self.0.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::atomic::AtomicUsize;

    fn make() -> Theme {
        Theme::builder()
            .tokens(json!({
                "color": { "brand": "#0066ff", "primary": "{color.brand}", "surface": "#ffffff" },
                "space": { "md": 16 }
            }))
            .schemes(json!({
                "dark": { "color": { "brand": "#66a3ff", "surface": "#111111" } },
                "sepia": { "color": { "surface": "#f4ecd8" } }
            }))
            .build()
    }

    #[derive(Default)]
    struct Recorder(Mutex<Vec<(String, Value)>>);

    impl ContextSink for Recorder {
        fn set_context(&self, name: &str, data: Value) {
            self.0.lock().unwrap().push((name.to_string(), data));
        }

        fn is_closed(&self) -> bool {
            false
        }
    }

    #[test]
    fn theme_is_send_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Theme>();
        assert_send_sync::<ThemeAttachment>();
        assert_send_sync::<ThemeSubscription>();
    }

    #[test]
    fn defaults_to_following_the_system_scheme() {
        let theme = make();
        assert_eq!(theme.preference(), "system");
        assert_eq!(theme.scheme(), "light");
        assert_eq!(theme.token("color.surface"), Some(json!("#ffffff")));

        theme.set_system_scheme(SystemScheme::Dark);
        assert_eq!(theme.scheme(), "dark");
        assert_eq!(theme.token("color.surface"), Some(json!("#111111")));
        assert_eq!(theme.token("color.primary"), Some(json!("#66a3ff")));
        assert_eq!(theme.token("space.md"), Some(json!(16)));
        assert_eq!(
            theme.meta(),
            ThemeMeta {
                scheme: "dark".into(),
                preference: "system".into(),
                system: SystemScheme::Dark,
                schemes: vec!["dark".into(), "sepia".into()],
            }
        );
        assert_eq!(
            serde_json::to_value(theme.meta()).unwrap(),
            json!({ "scheme": "dark", "preference": "system", "system": "dark", "schemes": ["dark", "sepia"] })
        );
    }

    #[test]
    fn explicit_preference_wins_and_the_system_scheme_is_remembered() {
        let theme = make();
        theme.set_scheme("sepia").unwrap();
        theme.set_system_scheme(SystemScheme::Dark);
        assert_eq!(theme.scheme(), "sepia");
        assert_eq!(theme.system_scheme(), SystemScheme::Dark);
        theme.set_scheme("system").unwrap();
        assert_eq!(theme.scheme(), "dark");
    }

    #[test]
    fn toggle_flips_between_light_and_dark() {
        let theme = make();
        theme.toggle();
        assert_eq!(theme.preference(), "dark");
        theme.toggle();
        assert_eq!(theme.preference(), "light");
        theme.set_scheme("sepia").unwrap();
        theme.toggle();
        assert_eq!(theme.scheme(), "dark");
    }

    #[test]
    fn unknown_scheme_is_an_error_and_falls_back_at_construction() {
        let theme = make();
        let err = theme.set_scheme("neon").unwrap_err().to_string();
        assert!(
            err.contains("neon") && err.contains("system, light, dark, sepia"),
            "{err}"
        );
        assert_eq!(theme.preference(), "system");

        let fallback = Theme::builder().scheme("neon").build();
        assert_eq!(fallback.preference(), "system");
    }

    #[test]
    fn token_reports_a_missing_token_once() {
        let missing = Arc::new(Mutex::new(Vec::new()));
        let seen = Arc::clone(&missing);
        let theme = Theme::builder()
            .tokens(json!({ "a": 1 }))
            .on_missing_token(move |path, scheme| {
                seen.lock().unwrap().push(format!("{path}@{scheme}"))
            })
            .build();
        assert!(theme.has("a"));
        assert!(!theme.has("nope.deeper"));
        assert_eq!(theme.token("nope"), None);
        assert_eq!(theme.token("nope"), None);
        assert_eq!(*missing.lock().unwrap(), vec!["nope@light"]);
    }

    #[test]
    fn extend_merges_into_the_base_set_or_one_scheme() {
        let theme = make();
        let sink = Arc::new(Recorder::default());
        theme.attach(sink.clone());
        sink.0.lock().unwrap().clear();

        theme.extend(json!({ "space": { "lg": 24 } }), None);
        assert_eq!(theme.token("space.lg"), Some(json!(24)));
        assert_eq!(theme.token("space.md"), Some(json!(16)));
        assert_eq!(sink.0.lock().unwrap().len(), 2);

        // An inactive scheme: stored, nothing republished.
        theme.extend(json!({ "space": { "lg": 32 } }), Some("compact"));
        assert_eq!(sink.0.lock().unwrap().len(), 2);
        assert_eq!(theme.schemes(), vec!["dark", "sepia", "compact"]);
        theme.set_scheme("compact").unwrap();
        assert_eq!(theme.token("space.lg"), Some(json!(32)));
    }

    #[test]
    fn on_change_fires_on_effective_changes_and_unsubscribes() {
        let theme = make();
        let calls = Arc::new(AtomicUsize::new(0));
        let n = Arc::clone(&calls);
        let sub = theme.on_change(move |_| {
            n.fetch_add(1, Ordering::SeqCst);
        });
        theme.set_scheme("dark").unwrap();
        theme.set_scheme("dark").unwrap(); // same preference: silent
        theme.set_system_scheme(SystemScheme::Light); // unchanged: silent
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        sub.unsubscribe();
        theme.set_scheme("light").unwrap();
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn attach_publishes_now_and_on_change_until_detached() {
        let theme = make();
        let sink = Arc::new(Recorder::default());
        let attachment = theme.attach(sink.clone());
        {
            let got = sink.0.lock().unwrap();
            assert_eq!(got[0].0, THEME_META_PROVIDER);
            assert_eq!(got[0].1["scheme"], "light");
            assert_eq!(got[1].0, THEME_TOKENS_PROVIDER);
            assert_eq!(got[1].1["color"]["primary"], "#0066ff");
        }
        theme.set_scheme("dark").unwrap();
        assert_eq!(sink.0.lock().unwrap().len(), 4);
        assert_eq!(sink.0.lock().unwrap()[3].1["color"]["primary"], "#66a3ff");
        attachment.detach();
        theme.set_scheme("light").unwrap();
        assert_eq!(sink.0.lock().unwrap().len(), 4);
    }

    #[test]
    fn fork_has_its_own_preference_over_shared_tokens() {
        let theme = make();
        theme.set_system_scheme(SystemScheme::Dark);
        let a = theme.fork(None);
        let b = theme.fork(Some("sepia"));
        assert_eq!(a.preference(), "system");
        assert_eq!(a.scheme(), "dark");
        assert_eq!(b.scheme(), "sepia");

        a.set_scheme("light").unwrap();
        assert_eq!(theme.scheme(), "dark");
        assert_eq!(b.scheme(), "sepia");

        // Shared store: tokens added through the parent reach a fork when it
        // next resolves.
        theme.extend(json!({ "space": { "xl": 40 } }), None);
        b.set_scheme("dark").unwrap();
        assert_eq!(b.token("space.xl"), Some(json!(40)));
        assert_eq!(b.schemes(), theme.schemes());
    }

    #[test]
    fn non_object_tokens_are_ignored() {
        let theme = Theme::builder().tokens(json!([1, 2])).build();
        assert_eq!(theme.tokens(), json!({}));
        let mut problems = Vec::new();
        assert_eq!(
            resolve_token_aliases(&json!({ "a": "{b}", "b": [1] }), &mut |p| problems.push(p)),
            json!({ "a": [1], "b": [1] })
        );
        assert!(problems.is_empty());
    }
}

//! Layered prop maps: a shared base plus a small per-node overlay.
//!
//! Every `InstanceNode` carries two prop maps — the resolved props the
//! renderer sees and the raw props (bindings intact) the engine re-resolves
//! from — and for list rows built from a prototype the two are *almost*
//! identical across rows: the static and state-bound props resolve the same
//! way for every row of a pass, and only the item-dependent props differ.
//! Materializing a flat `IndexMap` per node per row cloned every key and
//! every static value (~150 allocations per 17-node row) only to overwrite
//! one or two entries, then freed all of it again at teardown.
//!
//! [`LayeredProps`] stores the shared base behind an `Arc` and keeps just
//! the per-node overrides in a tiny overlay. Its observable behaviour is
//! defined to be exactly that of the flat `IndexMap` the overlay would
//! produce if applied with `IndexMap::insert` / `shift_remove` semantics:
//!
//! * a key that exists in the base keeps the base's position (the overlay
//!   value *shadows* the base value in place);
//! * a key absent from the base is appended after every base key, in
//!   overlay insertion order;
//! * `shift_remove` preserves the relative order of the remaining keys.
//!
//! Lookups, iteration order, `len` and `keys` therefore match the flat map
//! byte-for-byte, so reconciliation, patch emission and semantics
//! resolution cannot observe the layering. Operations the overlay cannot
//! express cheaply (removing a base key) *flatten* the map first — the
//! same deep clone the old representation paid unconditionally, now paid
//! only on that rare path.

use crate::ir::semantics::PropLookup;
use crate::ir::{Props, Value};
use indexmap::IndexMap;
use std::sync::Arc;

#[derive(Debug, Clone)]
struct OverlayEntry<V> {
    key: Arc<str>,
    value: V,
    /// `true` when `key` also exists in the base: the entry replaces the
    /// base value *in place*. `false` when the key is new: the entry sits
    /// after every base key, in overlay order.
    shadows_base: bool,
}

/// A prop map as a shared base plus per-node overrides. See the module
/// docs for the exact equivalence with a flat `IndexMap<String, V>`.
#[derive(Debug, Clone)]
pub struct LayeredProps<V> {
    base: Arc<IndexMap<String, V>>,
    overlay: Vec<OverlayEntry<V>>,
    /// Number of overlay entries with `shadows_base == false`. Kept so
    /// `len()` and the in-place insert check are O(1).
    appended: usize,
}

impl<V> LayeredProps<V> {
    /// A map with no overlay: behaves exactly like the wrapped `IndexMap`.
    pub fn flat(base: Arc<IndexMap<String, V>>) -> Self {
        Self {
            base,
            overlay: Vec::new(),
            appended: 0,
        }
    }

    /// `base` with `overlay` applied on top, entry by entry, with
    /// `IndexMap::insert` semantics (see the module docs).
    pub fn layered(base: Arc<IndexMap<String, V>>, overlay: Vec<(Arc<str>, V)>) -> Self {
        let mut this = Self {
            base,
            overlay: Vec::with_capacity(overlay.len()),
            appended: 0,
        };
        for (key, value) in overlay {
            this.insert_arc(key, value);
        }
        this
    }

    /// `true` when nothing is layered over the base.
    pub fn is_flat(&self) -> bool {
        self.overlay.is_empty()
    }

    fn overlay_index(&self, key: &str) -> Option<usize> {
        // The overlay holds the handful of props that differ from the
        // shared base — a linear scan beats hashing at that size.
        self.overlay.iter().position(|e| &*e.key == key)
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        match self.overlay_index(key) {
            Some(i) => Some(&self.overlay[i].value),
            None => self.base.get(key),
        }
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.overlay_index(key).is_some() || self.base.contains_key(key)
    }

    pub fn len(&self) -> usize {
        self.base.len() + self.appended
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Entries in the flat map's order: base keys first (shadowed values
    /// substituted in place), then the appended overlay keys.
    pub fn iter(&self) -> impl Iterator<Item = (&str, &V)> + '_ {
        let has_shadows = self.overlay.len() > self.appended;
        self.base
            .iter()
            .map(move |(k, v)| {
                if has_shadows {
                    if let Some(i) = self.overlay_index(k) {
                        return (k.as_str(), &self.overlay[i].value);
                    }
                }
                (k.as_str(), v)
            })
            .chain(
                self.overlay
                    .iter()
                    .filter(|e| !e.shadows_base)
                    .map(|e| (&*e.key, &e.value)),
            )
    }

    pub fn keys(&self) -> impl Iterator<Item = &str> + '_ {
        self.iter().map(|(k, _)| k)
    }

    /// Insert with `IndexMap::insert` semantics: an existing key keeps its
    /// position, a new key goes last. Writes straight into the base when
    /// that is unshared and the order stays unaffected; otherwise the
    /// override lands in the overlay.
    pub fn insert(&mut self, key: &str, value: V) {
        if let Some(i) = self.overlay_index(key) {
            self.overlay[i].value = value;
            return;
        }
        if self.base.contains_key(key) {
            if let Some(map) = Arc::get_mut(&mut self.base) {
                if let Some(slot) = map.get_mut(key) {
                    *slot = value;
                    return;
                }
            }
            self.overlay.push(OverlayEntry {
                key: Arc::from(key),
                value,
                shadows_base: true,
            });
            return;
        }
        // A new key must follow every appended overlay key; only when
        // there are none may it go straight into an unshared base.
        if self.appended == 0 {
            if let Some(map) = Arc::get_mut(&mut self.base) {
                map.insert(key.to_string(), value);
                return;
            }
        }
        self.overlay.push(OverlayEntry {
            key: Arc::from(key),
            value,
            shadows_base: false,
        });
        self.appended += 1;
    }

    /// [`insert`](Self::insert) for callers that already hold the key as
    /// an `Arc<str>` (the prototype path shares one per template prop), so
    /// pushing to the overlay allocates nothing for the key.
    pub fn insert_arc(&mut self, key: Arc<str>, value: V) {
        if let Some(i) = self.overlay_index(&key) {
            self.overlay[i].value = value;
            return;
        }
        if self.base.contains_key(&*key) {
            if let Some(map) = Arc::get_mut(&mut self.base) {
                if let Some(slot) = map.get_mut(&*key) {
                    *slot = value;
                    return;
                }
            }
            self.overlay.push(OverlayEntry {
                key,
                value,
                shadows_base: true,
            });
            return;
        }
        if self.appended == 0 {
            if let Some(map) = Arc::get_mut(&mut self.base) {
                map.insert(key.to_string(), value);
                return;
            }
        }
        self.overlay.push(OverlayEntry {
            key,
            value,
            shadows_base: false,
        });
        self.appended += 1;
    }

    /// Remove with `IndexMap::shift_remove` semantics (later keys keep
    /// their relative order). Removing a base key flattens first.
    pub fn shift_remove(&mut self, key: &str) -> Option<V>
    where
        V: Clone,
    {
        if let Some(i) = self.overlay_index(key) {
            if !self.overlay[i].shadows_base {
                self.appended -= 1;
                return Some(self.overlay.remove(i).value);
            }
        } else if !self.base.contains_key(key) {
            return None;
        }
        self.flatten();
        Arc::make_mut(&mut self.base).shift_remove(key)
    }

    /// Fold the overlay into the base (cloning the base if shared) so the
    /// map is flat again. Order is preserved by construction.
    pub fn flatten(&mut self)
    where
        V: Clone,
    {
        if self.overlay.is_empty() {
            return;
        }
        let map = Arc::make_mut(&mut self.base);
        for entry in self.overlay.drain(..) {
            map.insert(entry.key.to_string(), entry.value);
        }
        self.appended = 0;
    }

    /// The equivalent flat map. An `Arc::clone` when nothing is layered.
    pub fn to_flat(&self) -> Arc<IndexMap<String, V>>
    where
        V: Clone,
    {
        if self.overlay.is_empty() {
            return Arc::clone(&self.base);
        }
        let mut map = (*self.base).clone();
        for entry in &self.overlay {
            map.insert(entry.key.to_string(), entry.value.clone());
        }
        Arc::new(map)
    }
}

impl<V> Default for LayeredProps<V> {
    fn default() -> Self {
        Self::flat(Arc::new(IndexMap::new()))
    }
}

impl<V> From<Arc<IndexMap<String, V>>> for LayeredProps<V> {
    fn from(base: Arc<IndexMap<String, V>>) -> Self {
        Self::flat(base)
    }
}

impl From<Props> for LayeredProps<Value> {
    fn from(props: Props) -> Self {
        Self::flat(props.into_arc())
    }
}

impl PropLookup for LayeredProps<serde_json::Value> {
    fn lookup(&self, key: &str) -> Option<&serde_json::Value> {
        self.get(key)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn base() -> Arc<IndexMap<String, serde_json::Value>> {
        let mut m = IndexMap::new();
        m.insert("a".to_string(), json!(1));
        m.insert("b".to_string(), json!(2));
        m.insert("c".to_string(), json!(3));
        Arc::new(m)
    }

    fn flat_of(l: &LayeredProps<serde_json::Value>) -> Vec<(String, serde_json::Value)> {
        l.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
    }

    /// Reference model: the same operations on a plain IndexMap.
    fn model(
        ops: &[(&str, Option<serde_json::Value>)],
    ) -> (
        LayeredProps<serde_json::Value>,
        IndexMap<String, serde_json::Value>,
    ) {
        let shared = base();
        let _keep_shared = Arc::clone(&shared); // force the overlay path
        let mut layered = LayeredProps::flat(shared);
        let mut flat = (*base()).clone();
        for (k, v) in ops {
            match v {
                Some(v) => {
                    layered.insert(k, v.clone());
                    flat.insert(k.to_string(), v.clone());
                }
                None => {
                    assert_eq!(layered.shift_remove(k), flat.shift_remove(*k));
                }
            }
        }
        (layered, flat)
    }

    fn assert_equivalent(
        layered: &LayeredProps<serde_json::Value>,
        flat: &IndexMap<String, serde_json::Value>,
    ) {
        let l: Vec<_> = flat_of(layered);
        let f: Vec<_> = flat.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
        assert_eq!(l, f, "iteration order/content differs");
        assert_eq!(layered.len(), flat.len());
        assert_eq!(
            layered.keys().collect::<Vec<_>>(),
            flat.keys().map(String::as_str).collect::<Vec<_>>()
        );
        for (k, v) in flat {
            assert_eq!(layered.get(k), Some(v));
            assert!(layered.contains_key(k));
        }
        assert_eq!(layered.get("zzz"), None);
        assert!(!layered.contains_key("zzz"));
        assert_eq!(&*layered.to_flat(), flat);
    }

    #[test]
    fn shadow_keeps_position_and_append_goes_last() {
        let (l, f) = model(&[("b", Some(json!(20))), ("x", Some(json!(9)))]);
        assert!(!l.is_flat());
        assert_equivalent(&l, &f);
        assert_eq!(
            l.keys().collect::<Vec<_>>(),
            vec!["a", "b", "c", "x"],
            "shadowed key stays in place, new key appends"
        );
    }

    #[test]
    fn reinserting_overlay_keys_replaces_in_place() {
        let (l, f) = model(&[
            ("x", Some(json!(1))),
            ("y", Some(json!(2))),
            ("x", Some(json!(3))),
            ("b", Some(json!(4))),
            ("b", Some(json!(5))),
        ]);
        assert_equivalent(&l, &f);
    }

    #[test]
    fn shift_remove_matches_indexmap() {
        // Removing appended keys.
        let (l, f) = model(&[
            ("x", Some(json!(1))),
            ("y", Some(json!(2))),
            ("z", Some(json!(3))),
            ("y", None),
        ]);
        assert_equivalent(&l, &f);
        assert!(!l.is_flat());

        // Removing a shadowed base key flattens.
        let (l, f) = model(&[("b", Some(json!(20))), ("x", Some(json!(1))), ("b", None)]);
        assert_equivalent(&l, &f);
        assert!(l.is_flat());

        // Removing a plain base key.
        let (l, f) = model(&[("x", Some(json!(1))), ("a", None)]);
        assert_equivalent(&l, &f);

        // Removing a missing key is a no-op.
        let (mut l, mut f) = model(&[("x", Some(json!(1)))]);
        assert_eq!(l.shift_remove("nope"), None);
        assert_eq!(f.shift_remove("nope"), None);
        assert_equivalent(&l, &f);
    }

    #[test]
    fn unshared_base_is_written_in_place() {
        let mut l = LayeredProps::flat(base());
        l.insert("b", json!(20));
        l.insert("x", json!(1));
        assert!(l.is_flat(), "unique base takes writes directly");
        assert_eq!(l.keys().collect::<Vec<_>>(), vec!["a", "b", "c", "x"]);
        assert_eq!(l.get("b"), Some(&json!(20)));
    }

    #[test]
    fn layered_constructor_matches_sequential_inserts() {
        let shared = base();
        let l = LayeredProps::layered(
            Arc::clone(&shared),
            vec![
                (Arc::from("c"), json!(30)),
                (Arc::from("q"), json!(1)),
                (Arc::from("a"), json!(10)),
            ],
        );
        let mut f = (*shared).clone();
        f.insert("c".to_string(), json!(30));
        f.insert("q".to_string(), json!(1));
        f.insert("a".to_string(), json!(10));
        assert_equivalent(&l, &f);
        // The shared base itself is untouched.
        assert_eq!(shared.get("a"), Some(&json!(1)));
        assert_eq!(shared.len(), 3);
    }

    #[test]
    fn flatten_preserves_order_and_drops_overlay() {
        let (mut l, f) = model(&[("b", Some(json!(20))), ("x", Some(json!(1)))]);
        l.flatten();
        assert!(l.is_flat());
        assert_equivalent(&l, &f);
    }

    #[test]
    fn insert_after_append_keeps_new_keys_ordered_even_when_unique() {
        // Base is shared at first (forces an appended overlay entry), then
        // becomes unique; a later new key must still land after `x`.
        let shared = base();
        let mut l = LayeredProps::flat(Arc::clone(&shared));
        l.insert("x", json!(1));
        drop(shared);
        l.insert("y", json!(2));
        assert_eq!(l.keys().collect::<Vec<_>>(), vec!["a", "b", "c", "x", "y"]);
        // A shadowing insert on the now-unique base goes in place.
        l.insert("a", json!(10));
        assert_eq!(l.get("a"), Some(&json!(10)));
        assert_eq!(l.keys().collect::<Vec<_>>(), vec!["a", "b", "c", "x", "y"]);
    }
}

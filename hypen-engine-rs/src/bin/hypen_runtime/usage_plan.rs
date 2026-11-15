//! Per-usage-site instantiation planning.
//!
//! The engine scopes a module's bindings by its *declaration name*
//! (`module Counter` → scope `counter`). To give `Counter(start: 5)` and
//! `Counter(start: 9)` separate state without touching the engine, the runtime
//! plans one wasm instance per **distinct effective config** and rewrites the
//! templates so each config resolves to its own declaration name: extra
//! configs get a synthetic component (`Counter__a` → scope `counter__a`)
//! whose source is the backing template with its root declaration renamed.
//!
//! This module is pure: template sources in, a [`UsagePlan`] out.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::ops::Range;

use hypen_parser::{ComponentSpecification, DeclarationType};
use serde_json::Value;

use crate::template::{self, Config};

/// A module as the planner sees it.
#[derive(Debug, Clone, Copy)]
pub struct PlanModule<'a> {
    /// Component name used in templates.
    pub name: &'a str,
    /// Whether the module has a wasm instance (stateless components are only
    /// scanned for references to stateful ones).
    pub stateful: bool,
}

/// One planned wasm instance.
#[derive(Debug, Clone, PartialEq)]
pub struct PlannedInstance {
    /// State scope it registers under: the module's own lowercased name for
    /// the first config, `name__<letters>` for each further one.
    pub scope: String,
    /// The module (by component name) whose `.wasm` / capabilities back it.
    pub backing: String,
    /// The config passed to `init`.
    pub config: Value,
}

#[derive(Debug, Clone, Default, PartialEq)]
pub struct UsagePlan {
    pub instances: Vec<PlannedInstance>,
    /// Template source by component name, as the engine should see it: base
    /// templates with references renamed, plus one synthetic source per
    /// synthetic scope.
    pub sources: HashMap<String, String>,
}

/// A reference to a stateful module inside some template.
#[derive(Clone)]
struct RefSite {
    /// Component name of the template containing the reference.
    template: String,
    /// Byte range of the reference's name token (for renaming).
    name_range: Range<usize>,
    usage: Config,
}

impl RefSite {
    /// The effective config (declaration default overridden by the usage
    /// args, minus `key:`) and the key that tells instances apart.
    fn resolve(&self, default: &Config) -> (Config, String) {
        let (overrides, key) = split_usage_key(&self.usage);
        let mut effective = default.clone();
        effective.extend(overrides);
        let distinct = distinct_key(&effective, key.as_deref());
        (effective, distinct)
    }

    /// Whether this is a plain reference that changes nothing — it shares the
    /// module's default instance.
    fn uses_default(&self, default: &Config) -> bool {
        let (overrides, key) = split_usage_key(&self.usage);
        let mut effective = default.clone();
        effective.extend(overrides);
        key.is_none() && effective == *default
    }
}

/// Plan one instance per distinct usage config across all templates, and
/// rewrite the templates to match.
///
/// For each stateful module the first needed config takes the base scope —
/// the declaration default when the module is the entry, is referenced
/// without (effective) args, or is not referenced at all; otherwise the first
/// configured reference — so the common single-config case stays at the clean
/// base scope. The same config referenced twice shares one instance; a
/// reference forces its own instance with a `key:` argument, which separates
/// instances without reaching the module's `init` config.
pub fn plan(modules: &[PlanModule<'_>], entry: &str, raw: &HashMap<String, String>) -> UsagePlan {
    let stateful: HashSet<&str> =
        modules.iter().filter(|m| m.stateful).map(|m| m.name).collect();

    // Parse each template once.
    let roots: HashMap<&str, Vec<ComponentSpecification>> = modules
        .iter()
        .filter_map(|m| {
            let doc = hypen_parser::parse_document(raw.get(m.name)?).ok()?;
            Some((m.name, doc.components))
        })
        .collect();

    let mut sites: HashMap<String, Vec<RefSite>> = HashMap::new();
    for m in modules {
        for component in roots.get(m.name).into_iter().flatten() {
            collect_ref_sites(component, m.name, &stateful, &mut sites);
        }
    }

    let mut plan = UsagePlan::default();
    let mut renames: HashMap<String, Vec<(Range<usize>, String)>> = HashMap::new();
    // (synthetic component name, backing component name)
    let mut synthetic: Vec<(String, &str)> = Vec::new();

    for m in modules.iter().filter(|m| m.stateful) {
        let name = m.name;
        let default: Config = roots
            .get(name)
            .and_then(|components| components.first())
            .map(template::declaration_config)
            .unwrap_or_default();
        let module_sites = sites.get(name).map(Vec::as_slice).unwrap_or_default();

        // Distinct effective configs, in first-use order; the default goes
        // first when something needs it.
        let mut configs: Vec<Config> = Vec::new();
        let mut index_of: HashMap<String, usize> = HashMap::new();
        let needs_default = name == entry
            || module_sites.is_empty()
            || module_sites.iter().any(|s| s.uses_default(&default));
        if needs_default {
            index_of.insert(distinct_key(&default, None), 0);
            configs.push(default.clone());
        }
        for site in module_sites {
            let (effective, distinct) = site.resolve(&default);
            let index = *index_of.entry(distinct).or_insert_with(|| {
                configs.push(effective);
                configs.len() - 1
            });
            // References to a non-base config are renamed to its synthetic
            // component.
            if index > 0 {
                renames
                    .entry(site.template.clone())
                    .or_default()
                    .push((site.name_range.clone(), synthetic_name(name, index)));
            }
        }

        for (index, config) in configs.into_iter().enumerate() {
            let scope = if index == 0 {
                name.to_lowercase()
            } else {
                let component = synthetic_name(name, index);
                let scope = component.to_lowercase();
                synthetic.push((component, name));
                scope
            };
            plan.instances.push(PlannedInstance {
                scope,
                backing: name.to_string(),
                config: Value::Object(config),
            });
        }
    }

    for m in modules {
        let source = raw.get(m.name).map(String::as_str).unwrap_or_default();
        let rewritten = match renames.get(m.name) {
            Some(edits) => template::splice(source, edits),
            None => source.to_string(),
        };
        plan.sources.insert(m.name.to_string(), rewritten);
    }
    for (component, backing) in synthetic {
        let base = plan.sources.get(backing).map(String::as_str).unwrap_or_default();
        let source = template::rename_root(base, &component);
        plan.sources.insert(component, source);
    }
    plan
}

/// Recursively collect references to stateful modules in one template tree.
/// A `module X` *declaration* node is the module itself, not a usage.
fn collect_ref_sites(
    component: &ComponentSpecification,
    template: &str,
    stateful: &HashSet<&str>,
    out: &mut HashMap<String, Vec<RefSite>>,
) {
    let is_declaration = component.declaration_type == DeclarationType::Module;
    if !is_declaration && stateful.contains(component.name.as_str()) {
        out.entry(component.name.clone()).or_default().push(RefSite {
            template: template.to_string(),
            name_range: component.metadata.name_range.clone(),
            usage: template::component_args(component),
        });
    }
    for child in &component.children {
        collect_ref_sites(child, template, stateful, out);
    }
}

/// The synthetic component name for a module's `index`-th extra config.
fn synthetic_name(module: &str, index: usize) -> String {
    format!("{module}__{}", alpha_suffix(index))
}

/// `1 → a`, `2 → b`, … `27 → aa`. Letters only, deliberately: the parser
/// rejects a component name ending in a digit.
fn alpha_suffix(mut n: usize) -> String {
    let mut s = String::new();
    while n > 0 {
        n -= 1;
        s.insert(0, (b'a' + (n % 26) as u8) as char);
        n /= 26;
    }
    s
}

/// Split usage args into (config overrides, optional `key:` disambiguator).
/// A non-string `key` is stringified.
fn split_usage_key(usage: &Config) -> (Config, Option<String>) {
    let mut config = usage.clone();
    let key = config.remove("key").map(|v| match v {
        Value::String(s) => s,
        other => other.to_string(),
    });
    (config, key)
}

/// What makes two instances of one module distinct: the config (independent
/// of key order) plus the usage-site `key:`, if any.
fn distinct_key(config: &Config, key: Option<&str>) -> String {
    let sorted: BTreeMap<&String, &Value> = config.iter().collect();
    // Serialising a map of JSON values cannot fail; an empty key would only
    // merge instances, never panic.
    let canonical = serde_json::to_string(&sorted).unwrap_or_default();
    match key {
        Some(k) => format!("{canonical}\u{0}key={k}"),
        None => canonical,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const COUNTER: &str = "module Counter(start: 0) {\n  Text(\"Count: @{state.count}\")\n}\n";

    fn modules() -> [PlanModule<'static>; 3] {
        [
            PlanModule { name: "App", stateful: true },
            PlanModule { name: "Counter", stateful: true },
            PlanModule { name: "Banner", stateful: false },
        ]
    }

    fn plan_app(app: &str) -> UsagePlan {
        let raw = HashMap::from([
            ("App".to_string(), app.to_string()),
            ("Counter".to_string(), COUNTER.to_string()),
            ("Banner".to_string(), "Row { Counter(start: 3) }".to_string()),
        ]);
        plan(&modules(), "App", &raw)
    }

    fn scopes(plan: &UsagePlan) -> Vec<(&str, &Value)> {
        plan.instances.iter().map(|i| (i.scope.as_str(), &i.config)).collect()
    }

    #[test]
    fn argless_references_share_the_base_scope() {
        let raw = HashMap::from([
            ("App".to_string(), "module App { Column { Counter() Counter() } }".to_string()),
            ("Counter".to_string(), COUNTER.to_string()),
        ]);
        let p = plan(&modules()[..2], "App", &raw);
        assert_eq!(
            scopes(&p),
            vec![("app", &json!({})), ("counter", &json!({ "start": 0 }))]
        );
        assert_eq!(p.sources["App"], raw["App"], "nothing to rewrite");
        assert_eq!(p.sources.len(), 2, "no synthetic sources");
    }

    #[test]
    fn distinct_configs_get_synthetic_scopes_and_renamed_references() {
        // Banner (stateless) references Counter(start: 3) too.
        let p = plan_app("module App { Column { Counter() Counter(start: 5) Banner() } }");
        assert_eq!(
            scopes(&p),
            vec![
                ("app", &json!({})),
                ("counter", &json!({ "start": 0 })),
                ("counter__a", &json!({ "start": 5 })),
                ("counter__b", &json!({ "start": 3 })),
            ]
        );
        assert_eq!(
            p.sources["App"],
            "module App { Column { Counter() Counter__a(start: 5) Banner() } }"
        );
        assert_eq!(p.sources["Banner"], "Row { Counter__b(start: 3) }");
        assert!(p.sources["Counter__a"].starts_with("module Counter__a(start: 0)"));
        assert!(p.sources["Counter__b"].starts_with("module Counter__b(start: 0)"));
        assert!(p.instances.iter().skip(1).all(|i| i.backing == "Counter"));
    }

    #[test]
    fn a_single_configured_reference_takes_the_base_scope() {
        let raw = HashMap::from([
            ("App".to_string(), "module App { Counter(start: 5) }".to_string()),
            ("Counter".to_string(), COUNTER.to_string()),
        ]);
        let p = plan(&modules()[..2], "App", &raw);
        assert_eq!(
            scopes(&p),
            vec![("app", &json!({})), ("counter", &json!({ "start": 5 }))]
        );
        assert_eq!(p.sources["App"], raw["App"]);
    }

    #[test]
    fn same_config_is_shared_regardless_of_argument_order() {
        let raw = HashMap::from([
            (
                "App".to_string(),
                "module App { Column { Counter(start: 5, step: 2) Counter(step: 2, start: 5) } }"
                    .to_string(),
            ),
            ("Counter".to_string(), COUNTER.to_string()),
        ]);
        let p = plan(&modules()[..2], "App", &raw);
        assert_eq!(p.instances.len(), 2, "app + one shared counter: {:?}", p.instances);
    }

    #[test]
    fn key_forces_distinct_instances_without_reaching_init() {
        let raw = HashMap::from([
            (
                "App".to_string(),
                "module App { Column { Counter(start: 5, key: \"a\") Counter(start: 5, key: \"b\") } }"
                    .to_string(),
            ),
            ("Counter".to_string(), COUNTER.to_string()),
        ]);
        let p = plan(&modules()[..2], "App", &raw);
        assert_eq!(
            scopes(&p),
            vec![
                ("app", &json!({})),
                ("counter", &json!({ "start": 5 })),
                ("counter__a", &json!({ "start": 5 })),
            ]
        );
    }

    #[test]
    fn a_keyed_default_reference_is_not_the_default_instance() {
        let raw = HashMap::from([
            ("App".to_string(), "module App { Column { Counter() Counter(key: \"x\") } }".to_string()),
            ("Counter".to_string(), COUNTER.to_string()),
        ]);
        let p = plan(&modules()[..2], "App", &raw);
        assert_eq!(p.instances.len(), 3, "{:?}", p.instances);
        assert_eq!(p.instances[2].scope, "counter__a");
        assert_eq!(p.instances[2].config, json!({ "start": 0 }));
    }

    #[test]
    fn the_entry_always_keeps_its_default_at_the_base_scope() {
        // The entry referencing itself with args still boots its default.
        let raw = HashMap::from([(
            "App".to_string(),
            "module App(theme: \"dark\") { Text(\"x\") }".to_string(),
        )]);
        let p = plan(&modules()[..1], "App", &raw);
        assert_eq!(scopes(&p), vec![("app", &json!({ "theme": "dark" }))]);
    }

    #[test]
    fn unparseable_and_missing_templates_still_plan_a_default_instance() {
        let raw = HashMap::from([("App".to_string(), "module App {".to_string())]);
        let p = plan(&modules()[..2], "App", &raw);
        assert_eq!(scopes(&p), vec![("app", &json!({})), ("counter", &json!({}))]);
        assert_eq!(p.sources["App"], "module App {");
        assert_eq!(p.sources["Counter"], "");
    }

    #[test]
    fn planning_is_stable_across_replans() {
        let app = "module App { Column { Counter() Counter(start: 5) } }";
        assert_eq!(plan_app(app), plan_app(app));
    }

    #[test]
    fn suffixes_are_letters_only() {
        assert_eq!(alpha_suffix(1), "a");
        assert_eq!(alpha_suffix(26), "z");
        assert_eq!(alpha_suffix(27), "aa");
        assert_eq!(alpha_suffix(52), "az");
        assert_eq!(alpha_suffix(53), "ba");
    }
}

//! Internationalisation support: the reserved `t` message provider and the
//! pure `fmt()` / `plural()` expression builtins.
//!
//! ## Transport
//!
//! Translated strings reach the engine as an ordinary data-source context
//! under the reserved provider name [`I18N_PROVIDER`] (`"t"`). The SDK
//! (`createI18n` in `@hypen-space/core`) merges the active locale's catalog
//! over the fallback locale's and pushes it with `setContext("t", catalog)`;
//! switching locale is one more `setContext`, which marks every node bound to
//! `t.*` dirty. Templates read `Text(@t.cart.title)` or
//! `Text("@{t.cart.title}")`. A second provider, `i18n`, carries
//! `{ locale, dir, … }` and is a plain data source with no engine-side
//! special casing.
//!
//! ## Missing keys
//!
//! A `t.*` path that the active catalog does not contain renders as the key
//! path itself (`"cart.missing"`) — never an empty string, `null`, or the
//! raw template — and the engine logs a warning once per key. This only
//! applies once a `t` context exists, so an app without i18n is unaffected.
//!
//! ## Purity
//!
//! `fmt` and `plural` are pure functions of their arguments, which keeps the
//! context-free template memo in `expression.rs` sound. Locale-correct plural
//! category selection is data, not code: the SDK annotates every plural
//! message object with a [`PLURAL_RULE_KEY`] string computed from the host's
//! CLDR rules (`Intl.PluralRules` on the web), so the engine never hard-codes
//! a language's plural rules.

use exprimo::{CustomFuncError, CustomFunction};
use serde_json::Value;
use std::borrow::Cow;

/// Reserved data-source provider name for the active message catalog.
pub const I18N_PROVIDER: &str = "t";

/// Key the SDK adds to each plural message object, holding the active
/// locale's plural-category table (see [`plural_category`]).
pub const PLURAL_RULE_KEY: &str = "__plural";

/// Number of leading integer slots (0..=199) in a plural rule table.
const PLURAL_TABLE_INTS: usize = 200;

/// The CLDR plural categories, in the order the one-letter codes are listed.
const CATEGORIES: [(char, &str); 6] = [
    ('z', "zero"),
    ('o', "one"),
    ('t', "two"),
    ('f', "few"),
    ('m', "many"),
    ('x', "other"),
];

/// Pick the CLDR plural category of a non-negative integer from a rule table.
///
/// The table is a string of single-letter category codes (`z o t f m x` for
/// zero/one/two/few/many/other): positions `0..=199` give the category of
/// that integer, and position `200` the category of positive multiples of
/// 1,000,000. Every CLDR integer rule is a function of the exact value for
/// small numbers and of `n % 10` / `n % 100` beyond them, plus the
/// `n % 1000000 == 0` "many" case of the Romance languages, so for `n ≥ 200`
/// the category of `100 + n % 100` is the category of `n`. The SDK derives
/// the table from the platform's own plural rules and the cross-check test
/// in `hypen-web/tests/i18n.test.ts` verifies the extrapolation for every
/// locale `Intl.PluralRules` supports.
fn plural_category(n: u64, table: &str) -> Option<&'static str> {
    let bytes = table.as_bytes();
    let idx = if (n as usize) < PLURAL_TABLE_INTS && n < PLURAL_TABLE_INTS as u64 {
        n as usize
    } else if n.is_multiple_of(1_000_000) {
        PLURAL_TABLE_INTS
    } else {
        100 + (n % 100) as usize
    };
    let code = *bytes.get(idx)? as char;
    CATEGORIES
        .iter()
        .find(|(c, _)| *c == code)
        .map(|(_, name)| *name)
}

/// Render a value the way template interpolation does: strings verbatim,
/// integral floats without a trailing `.0` (exprimo computes in f64),
/// `null` as `"null"`, containers as JSON.
pub fn display_value(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Number(n) => match n.as_f64() {
            Some(f)
                if n.as_i64().is_none()
                    && n.as_u64().is_none()
                    && f.is_finite()
                    && f.fract() == 0.0
                    && f.abs() < 9_007_199_254_740_992.0 =>
            {
                format!("{}", f as i64)
            }
            _ => n.to_string(),
        },
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_string(),
        _ => serde_json::to_string(value).unwrap_or_default(),
    }
}

/// Substitute `{0}`, `{1}`, … with positional arguments and `{name}` with
/// the `name` field of any object argument (first object wins). Unknown
/// placeholders are left intact so a missing argument is visible, and text
/// that is not a well-formed `{identifier}` (e.g. a stray `{`) is copied
/// through unchanged.
fn substitute(message: &str, args: &[Value], named: &[(&str, &Value)]) -> String {
    let mut out = String::with_capacity(message.len());
    let mut rest = message;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after = &rest[open + 1..];
        let close = after.find('}');
        let name = close.map(|c| &after[..c]);
        let replacement = match name {
            Some(name)
                if !name.is_empty()
                    && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') =>
            {
                if let Ok(i) = name.parse::<usize>() {
                    args.get(i).map(display_value)
                } else {
                    named
                        .iter()
                        .find(|(k, _)| *k == name)
                        .map(|(_, v)| display_value(v))
                        .or_else(|| {
                            args.iter().find_map(|a| match a {
                                Value::Object(map) => map.get(name).map(display_value),
                                _ => None,
                            })
                        })
                }
            }
            _ => None,
        };
        match (replacement, close) {
            (Some(r), Some(c)) => {
                out.push_str(&r);
                rest = &after[c + 1..];
            }
            _ => {
                out.push('{');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

/// `fmt(message, arg0, arg1, …)` — fill `{0}` / `{1}` / `{name}`
/// placeholders. A non-string message (a missing key already rendered as its
/// path, a number, …) is displayed as-is, then substituted.
#[derive(Debug)]
pub(crate) struct FmtFn;

impl CustomFunction for FmtFn {
    fn call(&self, args: &[Value]) -> Result<Value, CustomFuncError> {
        let Some((message, rest)) = args.split_first() else {
            return Err(CustomFuncError::ArityError {
                expected: 1,
                got: 0,
            });
        };
        let message = match message {
            Value::String(s) => Cow::Borrowed(s.as_str()),
            other => Cow::Owned(display_value(other)),
        };
        Ok(Value::String(substitute(&message, rest, &[])))
    }
}

/// Coerce a count argument to a number (numbers, numeric strings, bools).
fn as_count(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Null => Some(0.0),
        _ => None,
    }
}

/// Select the plural form of `forms` for `count`.
///
/// Order: an exact `"=N"` key, then the CLDR category from the
/// [`PLURAL_RULE_KEY`] table, then `other`. Non-integer counts skip the
/// table (CLDR fraction rules need the visible-digit operands the table
/// does not encode) and use `other`.
pub fn select_plural_form(count: f64, forms: &serde_json::Map<String, Value>) -> Option<&Value> {
    if count.is_finite() && count.fract() == 0.0 {
        let exact = format!("={}", count as i64);
        if let Some(v) = forms.get(&exact) {
            return Some(v);
        }
        if let Some(Value::String(table)) = forms.get(PLURAL_RULE_KEY) {
            if let Some(cat) = plural_category(count.abs() as u64, table) {
                if let Some(v) = forms.get(cat) {
                    return Some(v);
                }
            }
        }
    }
    forms.get("other")
}

/// `plural(count, forms, arg0, …)` — pick the locale-correct plural form of
/// a catalog entry and substitute `{count}` plus any `{0}`… arguments.
///
/// `forms` is normally `t.some.key`, an object of CLDR categories. A plain
/// string (a non-plural message, or a missing key rendered as its path) is
/// formatted directly, so a typo never throws.
#[derive(Debug)]
pub(crate) struct PluralFn;

impl CustomFunction for PluralFn {
    fn call(&self, args: &[Value]) -> Result<Value, CustomFuncError> {
        if args.len() < 2 {
            return Err(CustomFuncError::ArityError {
                expected: 2,
                got: args.len(),
            });
        }
        let count_value = &args[0];
        let count = as_count(count_value).ok_or_else(|| {
            CustomFuncError::ArgumentError(format!(
                "plural() expects a numeric count; got {}",
                count_value
            ))
        })?;
        let extra = &args[2..];
        let message = match &args[1] {
            Value::Object(forms) => match select_plural_form(count, forms) {
                Some(Value::String(s)) => Cow::Borrowed(s.as_str()),
                Some(other) => Cow::Owned(display_value(other)),
                None => Cow::Owned(String::new()),
            },
            Value::String(s) => Cow::Borrowed(s.as_str()),
            other => Cow::Owned(display_value(other)),
        };
        // `{count}` shows the number as given (string counts verbatim).
        let count_display = match count_value {
            Value::String(_) | Value::Number(_) => count_value.clone(),
            _ => serde_json::json!(count),
        };
        Ok(Value::String(substitute(
            &message,
            extra,
            &[("count", &count_display)],
        )))
    }
}

/// Look up a `t.*` path in the catalog. `None` (or JSON `null`) is a miss.
pub fn lookup_message<'a, S: AsRef<str>>(catalog: &'a Value, path: &[S]) -> Option<&'a Value> {
    let mut current = catalog;
    for segment in path {
        current = current.get(segment.as_ref())?;
    }
    if current.is_null() {
        None
    } else {
        Some(current)
    }
}

/// Record a missing key; logs a warning the first time each key is seen
/// (per thread, which is per engine host in practice).
pub fn report_missing_key(path: &str) {
    use std::cell::RefCell;
    use std::collections::HashSet;
    thread_local! {
        static WARNED: RefCell<HashSet<String>> = RefCell::new(HashSet::new());
    }
    let first = WARNED.with(|w| {
        let mut w = w.borrow_mut();
        if w.contains(path) {
            false
        } else {
            w.insert(path.to_string());
            true
        }
    });
    if first {
        crate::log_warn!(
            crate::logger::LogScope::Reconciler,
            "i18n: missing message key \"{}\" — rendering the key path",
            path
        );
    }
}

/// Resolve a `@t.path` binding: the message, or the key path on a miss.
pub fn resolve_message_binding(catalog: &Value, path: &[String]) -> Value {
    match lookup_message(catalog, path) {
        Some(v) => v.clone(),
        None => {
            let key = path.join(".");
            report_missing_key(&key);
            Value::String(key)
        }
    }
}

/// Rewrite every `t.<path>` reference inside the template's `@{…}`
/// expressions whose path is missing from `catalog` into a string literal of
/// the key path, so an expression like `fmt(t.missing, state.x)` renders
/// `"missing"` instead of failing (exprimo errors on a property of `null`).
///
/// Returns `None` when nothing needed rewriting (the common case), so the
/// caller evaluates the original template without an allocation. String
/// literals inside the expression are skipped, and a `t` that is part of a
/// longer identifier or member chain (`state.t.x`, `at.x`) is not a
/// reference.
pub fn rewrite_missing_keys(template: &str, catalog: &Value) -> Option<String> {
    if !template.contains("t.") {
        return None;
    }
    let mut out: Option<String> = None;
    let bytes = template.as_bytes();
    let mut copied = 0; // bytes of `template` already copied into `out`
    let mut i = 0;
    let mut depth = 0usize; // > 0 while inside an `@{…}` expression
    let mut quote: Option<u8> = None;

    while i < bytes.len() {
        let b = bytes[i];
        if depth == 0 {
            if b == b'@' && bytes.get(i + 1) == Some(&b'{') {
                depth = 1;
                i += 2;
            } else {
                i += 1;
            }
            continue;
        }
        if let Some(q) = quote {
            if b == b'\\' {
                i += 2;
                continue;
            }
            if b == q {
                quote = None;
            }
            i += 1;
            continue;
        }
        match b {
            b'\'' | b'"' | b'`' => {
                quote = Some(b);
                i += 1;
            }
            b'{' => {
                depth += 1;
                i += 1;
            }
            b'}' => {
                depth -= 1;
                i += 1;
            }
            b't' if bytes.get(i + 1) == Some(&b'.') && {
                let prev = if i > 0 { bytes[i - 1] } else { b' ' };
                !(prev.is_ascii_alphanumeric() || prev == b'_' || prev == b'.' || prev == b'$')
            } =>
            {
                let path_start = i + 2;
                let mut end = path_start;
                while end < bytes.len()
                    && (bytes[end].is_ascii_alphanumeric()
                        || bytes[end] == b'_'
                        || bytes[end] == b'.')
                {
                    end += 1;
                }
                let path = template[path_start..end].trim_end_matches('.');
                let path_end = path_start + path.len();
                if !path.is_empty() {
                    let segments: Vec<&str> = path.split('.').collect();
                    if lookup_message(catalog, &segments).is_none() {
                        report_missing_key(path);
                        let buf =
                            out.get_or_insert_with(|| String::with_capacity(template.len() + 8));
                        buf.push_str(&template[copied..i]);
                        buf.push('\'');
                        buf.push_str(path);
                        buf.push('\'');
                        copied = path_end;
                    }
                }
                i = path_end.max(i + 2);
            }
            _ => i += 1,
        }
    }

    out.map(|mut buf| {
        buf.push_str(&template[copied..]);
        buf
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::reactive::{build_evaluator, evaluate_template_string};
    use indexmap::IndexMap;
    use serde_json::json;

    /// English-like table: 1 → one, everything else → other.
    fn en_table() -> String {
        let mut s = String::new();
        for n in 0..200 {
            s.push(if n == 1 { 'o' } else { 'x' });
        }
        s.push('x');
        s
    }

    /// Croatian/Russian-like table built from the CLDR integer rule
    /// (one: n%10=1 ∧ n%100≠11; few: n%10∈2..4 ∧ n%100∉12..14; else other).
    fn hr_table() -> String {
        let cat = |n: u64| {
            let (m10, m100) = (n % 10, n % 100);
            if m10 == 1 && m100 != 11 {
                'o'
            } else if (2..=4).contains(&m10) && !(12..=14).contains(&m100) {
                'f'
            } else {
                'x'
            }
        };
        let mut s: String = (0..200).map(cat).collect();
        s.push(cat(1_000_000));
        s
    }

    fn eval(template: &str, state: Value, catalog: Value) -> String {
        let mut ds = IndexMap::new();
        ds.insert(I18N_PROVIDER.to_string(), catalog);
        let ev = build_evaluator(&state, None, Some(&ds));
        evaluate_template_string(template, &ev).unwrap()
    }

    #[test]
    fn fmt_positional_and_named() {
        let cat = json!({ "greet": "Hello, {0}! You have {1} messages.", "hi": "Hi {name}" });
        let state = json!({ "user": { "name": "Ana" }, "n": 3 });
        assert_eq!(
            eval(
                "@{fmt(t.greet, state.user.name, state.n)}",
                state.clone(),
                cat.clone()
            ),
            "Hello, Ana! You have 3 messages."
        );
        assert_eq!(eval("@{fmt(t.hi, state.user)}", state, cat), "Hi Ana");
    }

    #[test]
    fn fmt_leaves_unknown_and_malformed_placeholders() {
        let state = json!({});
        let cat = json!({ "m": "a {0} b {1} c {x y} d {" });
        assert_eq!(
            eval("@{fmt(t.m, 'X')}", state, cat),
            "a X b {1} c {x y} d {"
        );
    }

    #[test]
    fn fmt_arity() {
        let ev = build_evaluator(&json!({}), None, None);
        assert!(evaluate_template_string("@{fmt()}", &ev).is_err());
    }

    #[test]
    fn plural_selects_english_categories_from_table() {
        let cat = json!({ "items": { "one": "{count} item", "other": "{count} items", PLURAL_RULE_KEY: en_table() } });
        for (n, expected) in [
            (0, "0 items"),
            (1, "1 item"),
            (2, "2 items"),
            (101, "101 items"),
        ] {
            assert_eq!(
                eval(
                    "@{plural(state.n, t.items)}",
                    json!({ "n": n }),
                    cat.clone()
                ),
                expected
            );
        }
    }

    #[test]
    fn plural_selects_slavic_categories_from_table() {
        let forms = json!({
            "one": "{count} stavka",
            "few": "{count} stavke",
            "other": "{count} stavki",
            PLURAL_RULE_KEY: hr_table(),
        });
        let cat = json!({ "items": forms });
        let cases = [
            (1, "1 stavka"),
            (2, "2 stavke"),
            (5, "5 stavki"),
            (11, "11 stavki"),
            (12, "12 stavki"),
            (21, "21 stavka"),
            (22, "22 stavke"),
            (111, "111 stavki"),
            (1001, "1001 stavka"),
            (1_234_563, "1234563 stavke"),
            (2_000_000, "2000000 stavki"),
        ];
        for (n, expected) in cases {
            assert_eq!(
                eval(
                    "@{plural(state.n, t.items)}",
                    json!({ "n": n }),
                    cat.clone()
                ),
                expected,
                "n = {n}"
            );
        }
    }

    #[test]
    fn plural_exact_match_and_extra_args() {
        let cat = json!({ "cart": {
            "=0": "{0}, your cart is empty",
            "one": "{0}, {count} item",
            "other": "{0}, {count} items",
            PLURAL_RULE_KEY: en_table(),
        }});
        let state = json!({ "n": 0, "name": "Ana" });
        assert_eq!(
            eval("@{plural(state.n, t.cart, state.name)}", state, cat.clone()),
            "Ana, your cart is empty"
        );
        let state = json!({ "n": 1, "name": "Ana" });
        assert_eq!(
            eval("@{plural(state.n, t.cart, state.name)}", state, cat),
            "Ana, 1 item"
        );
    }

    #[test]
    fn plural_without_rule_table_uses_other_and_fractions_use_other() {
        let cat = json!({ "items": { "one": "one", "other": "other" } });
        assert_eq!(eval("@{plural(1, t.items)}", json!({}), cat), "other");
        let cat = json!({ "items": { "one": "one", "other": "{count} other", PLURAL_RULE_KEY: en_table() } });
        assert_eq!(eval("@{plural(1.5, t.items)}", json!({}), cat), "1.5 other");
    }

    #[test]
    fn plural_on_plain_string_formats_it() {
        let cat = json!({ "s": "{count} things" });
        assert_eq!(eval("@{plural(4, t.s)}", json!({}), cat), "4 things");
    }

    #[test]
    fn plural_rejects_non_numeric_count() {
        let mut ds = IndexMap::new();
        ds.insert("t".to_string(), json!({ "s": { "other": "x" } }));
        let ev = build_evaluator(&json!({ "o": [1] }), None, Some(&ds));
        assert!(evaluate_template_string("@{plural(state.o, t.s)}", &ev).is_err());
    }

    #[test]
    fn rewrite_missing_keys_only_touches_missing_t_refs() {
        let cat = json!({ "a": { "b": "AB" } });
        assert_eq!(rewrite_missing_keys("@{t.a.b}", &cat), None);
        assert_eq!(
            rewrite_missing_keys("x @{fmt(t.a.zz, state.t.q)} y", &cat).as_deref(),
            Some("x @{fmt('a.zz', state.t.q)} y")
        );
        // Outside `@{…}` and inside string literals: untouched.
        assert_eq!(rewrite_missing_keys("t.nope @{'t.nope'}", &cat), None);
        // Part of a longer identifier: not a reference.
        assert_eq!(rewrite_missing_keys("@{at.nope + cat.x}", &cat), None);
        // A missing intermediate segment.
        assert_eq!(
            rewrite_missing_keys("@{t.zz.yy}", &cat).as_deref(),
            Some("@{'zz.yy'}")
        );
    }

    #[test]
    fn resolve_message_binding_falls_back_to_key_path() {
        let cat = json!({ "a": { "b": "AB" } });
        assert_eq!(
            resolve_message_binding(&cat, &["a".into(), "b".into()]),
            json!("AB")
        );
        assert_eq!(
            resolve_message_binding(&cat, &["a".into(), "c".into()]),
            json!("a.c")
        );
    }

    #[test]
    fn plural_category_extrapolation() {
        let t = hr_table();
        assert_eq!(plural_category(1, &t), Some("one"));
        assert_eq!(plural_category(211, &t), Some("other"));
        assert_eq!(plural_category(221, &t), Some("one"));
        assert_eq!(plural_category(3_000_000, &t), Some("other"));
        assert_eq!(plural_category(5, ""), None);
    }
}

//! URL path matcher.
//!
//! Given a pattern (`"/users/:id"`, `"/api/*"`, `"/dashboard"`) and a
//! path (`"/users/42"`), return `Some(RouteMatch { params })` on a
//! successful match, `None` otherwise.

use std::collections::BTreeMap;

/// Result of a successful [`match_path`] call.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RouteMatch {
    /// Named parameters extracted from `:name` segments, in insertion
    /// order. `BTreeMap` gives deterministic iteration for tests and
    /// fixture comparison.
    pub params: BTreeMap<String, String>,
}

/// Match `pattern` against `path`.
///
/// # Pattern syntax
///
/// * Exact: `/dashboard` matches only `/dashboard`.
/// * Parameter: `/users/:id` matches `/users/42` with `params["id"] = "42"`.
/// * Trailing wildcard: `/api/*` matches `/api`, `/api/users`, and
///   `/api/users/42`. The wildcard must be the final segment.
///
/// Leading and trailing slashes are normalised by splitting on `/` and
/// discarding empty segments, so `"/users/42"` and `"users/42/"` behave
/// identically.
pub fn match_path(pattern: &str, path: &str) -> Option<RouteMatch> {
    let pattern_parts: Vec<&str> = pattern.split('/').filter(|s| !s.is_empty()).collect();
    let path_parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    // Trailing wildcard: /prefix/* matches /prefix and anything under it.
    if pattern_parts.last() == Some(&"*") {
        let prefix = &pattern_parts[..pattern_parts.len() - 1];
        if path_parts.len() < prefix.len() {
            return None;
        }
        let mut params = BTreeMap::new();
        for (pp, rp) in prefix.iter().zip(path_parts.iter()) {
            if let Some(name) = pp.strip_prefix(':') {
                params.insert(name.to_string(), rp.to_string());
            } else if pp != rp {
                return None;
            }
        }
        return Some(RouteMatch { params });
    }

    if pattern_parts.len() != path_parts.len() {
        return None;
    }

    let mut params = BTreeMap::new();
    for (pp, rp) in pattern_parts.iter().zip(path_parts.iter()) {
        if let Some(name) = pp.strip_prefix(':') {
            params.insert(name.to_string(), rp.to_string());
        } else if pp != rp {
            return None;
        }
    }
    Some(RouteMatch { params })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pattern: &str, path: &str) -> Option<Vec<(String, String)>> {
        match_path(pattern, path).map(|m| m.params.into_iter().collect())
    }

    #[test]
    fn exact_match() {
        assert_eq!(m("/dashboard", "/dashboard"), Some(vec![]));
        assert_eq!(m("/dashboard", "/other"), None);
    }

    #[test]
    fn single_param() {
        assert_eq!(
            m("/users/:id", "/users/42"),
            Some(vec![("id".into(), "42".into())])
        );
    }

    #[test]
    fn multiple_params() {
        assert_eq!(
            m("/users/:id/posts/:postId", "/users/42/posts/99"),
            Some(vec![
                ("id".into(), "42".into()),
                ("postId".into(), "99".into()),
            ])
        );
    }

    #[test]
    fn wildcard_matches_prefix_and_descendants() {
        assert!(match_path("/api/*", "/api").is_some());
        assert!(match_path("/api/*", "/api/users").is_some());
        assert!(match_path("/api/*", "/api/users/42").is_some());
        assert!(match_path("/api/*", "/other").is_none());
    }

    #[test]
    fn wildcard_preserves_leading_params() {
        // A pattern can combine params and a trailing wildcard.
        let matched = match_path("/users/:id/*", "/users/42/posts/99").unwrap();
        assert_eq!(matched.params.get("id"), Some(&"42".to_string()));
    }

    #[test]
    fn rejects_length_mismatch() {
        assert!(match_path("/users/:id", "/users").is_none());
        assert!(match_path("/users/:id", "/users/42/extra").is_none());
    }

    #[test]
    fn trailing_slash_is_ignored() {
        assert!(match_path("/users/:id", "/users/42/").is_some());
        assert!(match_path("/users/:id/", "/users/42").is_some());
    }

    #[test]
    fn root_matches() {
        // Both `""` and `"/"` collapse to zero segments after splitting.
        assert!(match_path("/", "/").is_some());
        assert!(match_path("", "/").is_some());
    }
}

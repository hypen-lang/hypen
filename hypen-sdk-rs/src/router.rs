use std::collections::HashMap;
use std::sync::Mutex;

use crate::events::EventEmitter;

/// Result of matching a URL path against a route pattern.
#[derive(Debug, Clone, PartialEq)]
pub struct RouteMatch {
    /// Extracted parameters (e.g., `{":id": "123"}`).
    pub params: HashMap<String, String>,
    /// Parsed query parameters.
    pub query: HashMap<String, String>,
    /// The matched path.
    pub path: String,
}

/// Current route state.
#[derive(Debug, Clone)]
pub struct RouteState {
    pub current_path: String,
    pub params: HashMap<String, String>,
    pub query: HashMap<String, String>,
    pub previous_path: Option<String>,
}

/// A URL pattern-based router with history and parameter extraction.
///
/// # Pattern syntax
///
/// - Exact: `/dashboard`
/// - Wildcard: `/dashboard/*`
/// - Parameter: `/users/:id`
/// - Multiple params: `/users/:id/posts/:postId`
///
/// # Example
///
/// ```rust
/// use hypen_server::router::HypenRouter;
///
/// let router = HypenRouter::new();
///
/// // Navigate
/// router.push("/users/42?tab=profile");
///
/// let state = router.state();
/// assert_eq!(state.current_path, "/users/42");
/// assert_eq!(state.query.get("tab").map(String::as_str), Some("profile"));
///
/// // Match against a pattern
/// let m = router.match_path("/users/:id", "/users/42").unwrap();
/// assert_eq!(m.params["id"], "42");
/// ```
pub struct HypenRouter {
    inner: Mutex<RouterInner>,
    events: EventEmitter,
}

struct RouterInner {
    current_path: String,
    params: HashMap<String, String>,
    query: HashMap<String, String>,
    previous_path: Option<String>,
    history: Vec<String>,
}

impl HypenRouter {
    pub fn new() -> Self {
        Self {
            inner: Mutex::new(RouterInner {
                current_path: "/".to_string(),
                params: HashMap::new(),
                query: HashMap::new(),
                previous_path: None,
                history: vec!["/".to_string()],
            }),
            events: EventEmitter::new(),
        }
    }

    /// Navigate to a path, adding to history.
    pub fn push(&self, path: &str) {
        let (clean_path, query) = parse_path_and_query(path);
        let mut inner = self.inner.lock().unwrap();
        let prev = inner.current_path.clone();
        inner.previous_path = Some(prev);
        inner.current_path = clean_path.clone();
        inner.query = query;
        inner.params.clear();
        inner.history.push(clean_path);
        drop(inner);

        self.events.emit(
            crate::events::framework::ROUTE_CHANGED,
            &serde_json::json!({
                "path": path,
            }),
        );
    }

    /// Replace the current path without adding to history.
    pub fn replace(&self, path: &str) {
        let (clean_path, query) = parse_path_and_query(path);
        let mut inner = self.inner.lock().unwrap();
        inner.current_path = clean_path.clone();
        inner.query = query;
        inner.params.clear();
        if let Some(last) = inner.history.last_mut() {
            *last = clean_path;
        }
        drop(inner);

        // Match TS / Go / Swift / Kotlin: replace emits ROUTE_CHANGED so
        // any [`ManagedRouter`](crate::managed_router::ManagedRouter) /
        // direct subscriber sees the URL update.
        self.events.emit(
            crate::events::framework::ROUTE_CHANGED,
            &serde_json::json!({ "path": path }),
        );
    }

    /// Pop the current path off history, restoring the previous one.
    /// No-op when history has fewer than two entries.
    pub fn back(&self) {
        let prev = {
            let mut inner = self.inner.lock().unwrap();
            if inner.history.len() < 2 {
                return;
            }
            inner.history.pop();
            let prev = inner.history.last().cloned().unwrap();
            inner.previous_path = Some(inner.current_path.clone());
            inner.current_path = prev.clone();
            inner.query.clear();
            inner.params.clear();
            prev
        };
        self.events.emit(
            crate::events::framework::ROUTE_CHANGED,
            &serde_json::json!({ "path": prev }),
        );
    }

    /// Cancel a subscription returned by [`on_navigate`](Self::on_navigate).
    pub fn off(&self, id: crate::events::SubscriptionId) {
        self.events.off(id);
    }

    /// Get the current route state.
    pub fn state(&self) -> RouteState {
        let inner = self.inner.lock().unwrap();
        RouteState {
            current_path: inner.current_path.clone(),
            params: inner.params.clone(),
            query: inner.query.clone(),
            previous_path: inner.previous_path.clone(),
        }
    }

    /// Get the current path.
    pub fn current_path(&self) -> String {
        self.inner.lock().unwrap().current_path.clone()
    }

    /// Get current query parameters.
    pub fn query(&self) -> HashMap<String, String> {
        self.inner.lock().unwrap().query.clone()
    }

    /// Match a pattern against a given path.
    ///
    /// Returns `None` if the pattern doesn't match.
    pub fn match_path(&self, pattern: &str, path: &str) -> Option<RouteMatch> {
        let (clean_path, query) = parse_path_and_query(path);
        hypen_engine::match_path(pattern, &clean_path).map(|m| RouteMatch {
            params: m.params.into_iter().collect(),
            query,
            path: clean_path,
        })
    }

    /// Check if a pattern matches the current route.
    pub fn is_active(&self, pattern: &str) -> bool {
        let inner = self.inner.lock().unwrap();
        hypen_engine::match_path(pattern, &inner.current_path).is_some()
    }

    /// Subscribe to route changes.
    pub fn on_navigate<F>(&self, handler: F) -> crate::events::SubscriptionId
    where
        F: Fn(&serde_json::Value) + Send + Sync + 'static,
    {
        self.events
            .on(crate::events::framework::ROUTE_CHANGED, handler)
    }

    /// Build a URL from a path and query parameters.
    ///
    /// Delegates to [`hypen_engine::build_url`]; this thin wrapper only
    /// exists to translate the SDK's `HashMap` return shape into the
    /// `BTreeMap` the engine takes.
    pub fn build_url(path: &str, query: &HashMap<String, String>) -> String {
        let sorted: std::collections::BTreeMap<String, String> = query
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();
        hypen_engine::build_url(path, &sorted)
    }
}

impl Default for HypenRouter {
    fn default() -> Self {
        Self::new()
    }
}

/// Split `/path?k=v` into `(clean_path, query_map)` by delegating to
/// [`hypen_engine::parse_query`]. The engine returns a `BTreeMap`; we
/// widen to `HashMap` to match the surrounding SDK shape.
fn parse_path_and_query(full_path: &str) -> (String, HashMap<String, String>) {
    let (path, btree) = hypen_engine::parse_query(full_path);
    (path, btree.into_iter().collect())
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_push_and_state() {
        let router = HypenRouter::new();
        router.push("/users/42?tab=profile");

        let state = router.state();
        assert_eq!(state.current_path, "/users/42");
        assert_eq!(state.query.get("tab").map(String::as_str), Some("profile"));
        assert_eq!(state.previous_path, Some("/".to_string()));
    }

    #[test]
    fn test_replace() {
        let router = HypenRouter::new();
        router.push("/page1");
        router.replace("/page2");

        let state = router.state();
        assert_eq!(state.current_path, "/page2");
        // previous_path should still be "/" (from before push), not "page1"
        // because replace doesn't update previous_path
        assert_eq!(state.previous_path, Some("/".to_string()));
    }

    #[test]
    fn test_match_exact() {
        let router = HypenRouter::new();
        let m = router.match_path("/dashboard", "/dashboard");
        assert!(m.is_some());
        assert!(m.unwrap().params.is_empty());
    }

    #[test]
    fn test_match_params() {
        let router = HypenRouter::new();
        let m = router
            .match_path("/users/:id/posts/:postId", "/users/42/posts/99")
            .unwrap();
        assert_eq!(m.params["id"], "42");
        assert_eq!(m.params["postId"], "99");
    }

    #[test]
    fn test_match_wildcard() {
        let router = HypenRouter::new();
        assert!(router.match_path("/api/*", "/api/users/list").is_some());
        assert!(router.match_path("/api/*", "/api").is_some());
        assert!(router.match_path("/api/*", "/other").is_none());
    }

    #[test]
    fn test_no_match() {
        let router = HypenRouter::new();
        assert!(router.match_path("/users/:id", "/posts/42").is_none());
        assert!(router.match_path("/users/:id", "/users/42/extra").is_none());
    }

    #[test]
    fn test_is_active() {
        let router = HypenRouter::new();
        router.push("/users/42");

        assert!(router.is_active("/users/:id"));
        assert!(!router.is_active("/posts/:id"));
    }

    #[test]
    fn test_query_parsing() {
        let (path, query) = parse_path_and_query("/search?q=hello&page=2");
        assert_eq!(path, "/search");
        assert_eq!(query["q"], "hello");
        assert_eq!(query["page"], "2");
    }

    #[test]
    fn test_build_url() {
        let mut query = HashMap::new();
        query.insert("tab".to_string(), "profile".to_string());

        let url = HypenRouter::build_url("/users/42", &query);
        assert_eq!(url, "/users/42?tab=profile");
    }

    #[test]
    fn test_build_url_no_query() {
        let url = HypenRouter::build_url("/home", &HashMap::new());
        assert_eq!(url, "/home");
    }

    #[test]
    fn test_build_url_encodes_special_chars() {
        let mut query = HashMap::new();
        query.insert("msg".to_string(), "hello world".to_string());
        query.insert("a&b".to_string(), "1=2".to_string());

        let url = HypenRouter::build_url("/search", &query);
        // Both keys and values must be percent-encoded
        assert!(url.contains("msg=hello%20world"));
        assert!(url.contains("a%26b=1%3D2"));
        assert!(url.starts_with("/search?"));
    }

    #[test]
    fn test_parse_decodes_encoded_query() {
        let (path, query) = parse_path_and_query("/search?msg=hello%20world&a%26b=1%3D2");
        assert_eq!(path, "/search");
        assert_eq!(query.get("msg").map(String::as_str), Some("hello world"));
        assert_eq!(query.get("a&b").map(String::as_str), Some("1=2"));
    }

    #[test]
    fn test_plus_decodes_to_space() {
        let (path, query) = parse_path_and_query("/search?q=hello+world");
        assert_eq!(path, "/search");
        assert_eq!(query.get("q").map(String::as_str), Some("hello world"));
    }

    #[test]
    fn test_on_navigate() {
        use std::sync::atomic::{AtomicI32, Ordering};
        use std::sync::Arc;

        let router = HypenRouter::new();
        let count = Arc::new(AtomicI32::new(0));
        let count_clone = count.clone();

        router.on_navigate(move |_| {
            count_clone.fetch_add(1, Ordering::SeqCst);
        });

        router.push("/a");
        router.push("/b");

        assert_eq!(count.load(Ordering::SeqCst), 2);
    }
}

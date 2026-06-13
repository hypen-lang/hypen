//! Persistent storage for the browser's "Last opened" grid.
//!
//! Mirrors the contract of the Android gallery's `AppStorage` (URL +
//! display name + last-connected timestamp) and writes a JSON document
//! into the user's local data directory. We never hold the file open —
//! every save rewrites the file atomically via a tempfile + rename so a
//! crashed write can't corrupt the cache.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// One entry in the recent-apps grid.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct RecentApp {
    /// Stable identifier (used as ForEach key in the home grid).
    pub id: String,
    /// Human label — falls back to the host portion of the URL.
    pub name: String,
    /// Full WebSocket URL (`ws://…` / `wss://…`).
    pub url: String,
    /// Unix milliseconds of the last successful connect.
    pub last_connected: u64,
}

/// Persistent recent-apps cache, backed by a single JSON file in the
/// user's local data directory.
pub struct Storage {
    path: PathBuf,
    apps: Vec<RecentApp>,
}

/// The browser shows a 6-cell "Last opened" grid; persist the same
/// count so the cache doesn't keep growing forever.
const MAX_RECENT: usize = 6;

impl Storage {
    /// Load (or create-empty) the recent-apps store at the platform's
    /// standard location. Failure to read parses the file as missing.
    pub fn load() -> Self {
        let path = default_store_path();
        let apps = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<RecentApp>>(&s).ok())
            .unwrap_or_default();
        Self { path, apps }
    }

    /// Tests use this to point the store at a temp file.
    #[cfg(test)]
    pub fn at_path(path: PathBuf) -> Self {
        let apps = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Vec<RecentApp>>(&s).ok())
            .unwrap_or_default();
        Self { path, apps }
    }

    pub fn recent(&self) -> &[RecentApp] {
        &self.apps
    }

    /// Add (or move-to-top) the entry for `url`. Truncates to
    /// `MAX_RECENT` and persists immediately so a crash can't lose the
    /// just-opened app.
    pub fn record_visit(&mut self, name: &str, url: &str) {
        let now = now_millis();
        // De-dupe by URL so reopening the same app keeps a single slot.
        self.apps.retain(|a| a.url != url);
        self.apps.insert(
            0,
            RecentApp {
                id: stable_id_for(url),
                name: name.to_string(),
                url: url.to_string(),
                last_connected: now,
            },
        );
        self.apps.truncate(MAX_RECENT);
        if let Err(e) = self.save() {
            log::warn!("hypen-browser: failed to persist recent apps: {e}");
        }
    }

    /// Remove the recent entry with the given URL. No-op if the URL
    /// isn't in the store. Persists on success.
    pub fn remove_by_url(&mut self, url: &str) {
        let len_before = self.apps.len();
        self.apps.retain(|a| a.url != url);
        if self.apps.len() != len_before {
            if let Err(e) = self.save() {
                log::warn!("hypen-browser: failed to persist removal: {e}");
            }
        }
    }

    fn save(&self) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let serialised = serde_json::to_string_pretty(&self.apps)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        // Tempfile + rename keeps the on-disk file consistent if the
        // process is killed mid-write.
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, serialised)?;
        std::fs::rename(&tmp, &self.path)?;
        Ok(())
    }
}

/// Stable per-URL id used as the ForEach key. We don't need
/// cryptographic uniqueness — a 64-bit FNV-1a hash is fine for the at
/// most six entries we display.
fn stable_id_for(url: &str) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    for b in url.as_bytes() {
        hash ^= *b as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn default_store_path() -> PathBuf {
    // `data_local_dir` is `~/.local/share` on Linux, `~/Library/Application
    // Support` on macOS, `%LOCALAPPDATA%` on Windows — exactly where a
    // user-visible cache like "recent browser history" belongs.
    let base = dirs::data_local_dir()
        .or_else(dirs::home_dir)
        .unwrap_or_else(|| Path::new(".").to_path_buf());
    base.join("hypen-browser").join("recent.json")
}

/// Pretty-print a URL for the recent grid. Strips the protocol and any
/// trailing slash so a long `ws://example.com:3000/` shows as
/// `example.com:3000`. Mirrors the Android gallery's
/// `extractNameFromUrl`.
pub fn pretty_name(url: &str) -> String {
    let host = url
        .strip_prefix("wss://")
        .or_else(|| url.strip_prefix("ws://"))
        .or_else(|| url.strip_prefix("https://"))
        .or_else(|| url.strip_prefix("http://"))
        .unwrap_or(url);
    let host = host.split('/').next().unwrap_or(host);
    let bare = host.split(':').next().unwrap_or(host);
    match bare {
        "localhost" | "127.0.0.1" => "Localhost".to_string(),
        "" => "Hypen app".to_string(),
        h => h.to_string(),
    }
}

/// Normalise a URL the user typed into the address bar:
///
/// - bare host (`localhost:3000`) → `ws://localhost:3000`
/// - `http(s)://…` → `ws(s)://…`
/// - `ws(s)://…` → unchanged
///
/// We accept both http and ws so the user can paste either; behind the
/// scenes Hypen's `RemoteServer` only speaks WebSocket.
pub fn normalize_url(input: &str) -> String {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if let Some(rest) = trimmed.strip_prefix("https://") {
        return format!("wss://{rest}");
    }
    if let Some(rest) = trimmed.strip_prefix("http://") {
        return format!("ws://{rest}");
    }
    if trimmed.starts_with("ws://") || trimmed.starts_with("wss://") {
        return trimmed.to_string();
    }
    format!("ws://{trimmed}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalize_url_promotes_http_to_ws() {
        assert_eq!(normalize_url("http://x"), "ws://x");
        assert_eq!(normalize_url("https://x"), "wss://x");
        assert_eq!(normalize_url("ws://x"), "ws://x");
        assert_eq!(normalize_url("wss://x"), "wss://x");
        assert_eq!(normalize_url("localhost:3000"), "ws://localhost:3000");
        assert_eq!(normalize_url(" localhost "), "ws://localhost");
        assert_eq!(normalize_url(""), "");
    }

    #[test]
    fn pretty_name_strips_protocol_and_port() {
        assert_eq!(pretty_name("ws://localhost:3000"), "Localhost");
        assert_eq!(pretty_name("wss://example.com:3000/app"), "example.com");
        assert_eq!(pretty_name("example.com"), "example.com");
        assert_eq!(pretty_name("127.0.0.1"), "Localhost");
    }

    #[test]
    fn remove_by_url_drops_matching_entry_and_persists() {
        let dir =
            std::env::temp_dir().join(format!("hypen-browser-remove-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("recent.json");

        let mut s = Storage::at_path(path.clone());
        s.record_visit("A", "ws://a.test");
        s.record_visit("B", "ws://b.test");
        s.record_visit("C", "ws://c.test");
        assert_eq!(s.recent().len(), 3);

        s.remove_by_url("ws://b.test");
        let urls: Vec<&str> = s.recent().iter().map(|a| a.url.as_str()).collect();
        assert_eq!(urls, vec!["ws://c.test", "ws://a.test"]);

        // Reload to confirm persistence.
        let s2 = Storage::at_path(path);
        let urls2: Vec<&str> = s2.recent().iter().map(|a| a.url.as_str()).collect();
        assert_eq!(urls2, vec!["ws://c.test", "ws://a.test"]);

        // Removing an unknown URL is a no-op.
        let mut s3 = s2;
        s3.remove_by_url("ws://nope");
        assert_eq!(s3.recent().len(), 2);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn record_visit_dedupes_and_caps_at_six() {
        let dir = std::env::temp_dir().join(format!("hypen-browser-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("recent.json");

        let mut s = Storage::at_path(path.clone());
        for i in 0..10 {
            s.record_visit(&format!("App{i}"), &format!("ws://h{i}.test"));
        }
        assert_eq!(s.recent().len(), 6);
        // Most recent first.
        assert_eq!(s.recent()[0].url, "ws://h9.test");

        // Re-recording an existing URL bumps it to the top instead of
        // appending a duplicate.
        s.record_visit("App5 again", "ws://h5.test");
        assert_eq!(s.recent().len(), 6);
        assert_eq!(s.recent()[0].url, "ws://h5.test");
        assert!(
            s.recent()
                .iter()
                .filter(|a| a.url == "ws://h5.test")
                .count()
                == 1
        );

        // Reload from disk to confirm persistence.
        let s2 = Storage::at_path(path);
        assert_eq!(s2.recent()[0].url, "ws://h5.test");

        let _ = std::fs::remove_dir_all(&dir);
    }
}

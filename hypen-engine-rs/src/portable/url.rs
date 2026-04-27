//! URL helpers — percent-encoding, query-string parsing, URL building.
//!
//! Pure functions shared by every host router:
//!
//! * [`encode_uri_component`] / [`decode_uri_component`]
//! * [`parse_query`] — split `"/search?q=hi&page=2"` into `("/search", {"q": "hi", "page": "2"})`
//! * [`build_url`]   — reverse of `parse_query`, with keys sorted for determinism

use std::collections::BTreeMap;

const HEX: &[u8; 16] = b"0123456789ABCDEF";

/// Percent-encode a string per RFC 3986 unreserved set + the
/// characters with special meaning in a query component (space, `&`,
/// `=`, `?`, `#`, `%`, `+`).
///
/// Unreserved characters (`A–Z`, `a–z`, `0–9`, `-`, `_`, `.`, `~`)
/// pass through unchanged; everything else becomes `%XX`.
pub fn encode_uri_component(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for &byte in input.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push('%');
                out.push(HEX[(byte >> 4) as usize] as char);
                out.push(HEX[(byte & 0x0F) as usize] as char);
            }
        }
    }
    out
}

/// Decode a percent-encoded string. `+` decodes to a space (for
/// compatibility with `application/x-www-form-urlencoded` query
/// strings). Invalid `%XX` sequences are passed through verbatim.
pub fn decode_uri_component(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(input.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex_val(bytes[i + 1]), hex_val(bytes[i + 2])) {
                out.push((hi << 4) | lo);
                i += 3;
                continue;
            }
        }
        if bytes[i] == b'+' {
            out.push(b' ');
        } else {
            out.push(bytes[i]);
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'A'..=b'F' => Some(b - b'A' + 10),
        b'a'..=b'f' => Some(b - b'a' + 10),
        _ => None,
    }
}

/// Split `full_path` into `(clean_path, query_params)`. The separator
/// is the first `?`; if none is present, the query map is empty.
///
/// Query keys and values are percent-decoded so the returned map
/// contains the original characters. Returned map is sorted (`BTreeMap`)
/// so iteration is deterministic across hosts.
pub fn parse_query(full_path: &str) -> (String, BTreeMap<String, String>) {
    if let Some((path, q)) = full_path.split_once('?') {
        let map = q
            .split('&')
            .filter_map(|pair| {
                let (k, v) = pair.split_once('=')?;
                Some((decode_uri_component(k), decode_uri_component(v)))
            })
            .collect();
        (path.to_string(), map)
    } else {
        (full_path.to_string(), BTreeMap::new())
    }
}

/// Build `"<path>?<k1>=<v1>&<k2>=<v2>"` with each key/value
/// percent-encoded. Keys are emitted in sorted order for deterministic
/// output (makes golden-fixture comparisons possible).
pub fn build_url(path: &str, query: &BTreeMap<String, String>) -> String {
    if query.is_empty() {
        return path.to_string();
    }
    let encoded: Vec<String> = query
        .iter()
        .map(|(k, v)| format!("{}={}", encode_uri_component(k), encode_uri_component(v)))
        .collect();
    format!("{path}?{}", encoded.join("&"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encode_preserves_unreserved() {
        assert_eq!(encode_uri_component("hello-World_1.~"), "hello-World_1.~");
    }

    #[test]
    fn encode_percent_encodes_special() {
        assert_eq!(encode_uri_component("hello world"), "hello%20world");
        assert_eq!(encode_uri_component("a&b=c"), "a%26b%3Dc");
        assert_eq!(encode_uri_component("#frag"), "%23frag");
    }

    #[test]
    fn decode_percent_sequences() {
        assert_eq!(decode_uri_component("hello%20world"), "hello world");
        assert_eq!(decode_uri_component("a%26b%3Dc"), "a&b=c");
    }

    #[test]
    fn decode_plus_to_space() {
        assert_eq!(decode_uri_component("hello+world"), "hello world");
    }

    #[test]
    fn decode_invalid_percent_passthrough() {
        assert_eq!(decode_uri_component("%ZZ"), "%ZZ");
    }

    #[test]
    fn roundtrip_preserves_weird_chars() {
        let raw = "hello world&foo=bar?baz#qux";
        assert_eq!(decode_uri_component(&encode_uri_component(raw)), raw);
    }

    #[test]
    fn parse_query_basic() {
        let (p, q) = parse_query("/search?q=hi&page=2");
        assert_eq!(p, "/search");
        assert_eq!(q.get("q"), Some(&"hi".to_string()));
        assert_eq!(q.get("page"), Some(&"2".to_string()));
    }

    #[test]
    fn parse_query_empty() {
        let (p, q) = parse_query("/home");
        assert_eq!(p, "/home");
        assert!(q.is_empty());
    }

    #[test]
    fn parse_query_decodes_values() {
        let (_, q) = parse_query("/s?msg=hello%20world&a%26b=1%3D2");
        assert_eq!(q.get("msg"), Some(&"hello world".to_string()));
        assert_eq!(q.get("a&b"), Some(&"1=2".to_string()));
    }

    #[test]
    fn build_url_sorts_keys() {
        let mut q = BTreeMap::new();
        q.insert("tab".to_string(), "profile".to_string());
        q.insert("id".to_string(), "42".to_string());
        assert_eq!(build_url("/users", &q), "/users?id=42&tab=profile");
    }

    #[test]
    fn build_url_no_query() {
        assert_eq!(build_url("/home", &BTreeMap::new()), "/home");
    }

    #[test]
    fn build_url_percent_encodes() {
        let mut q = BTreeMap::new();
        q.insert("msg".to_string(), "hello world".to_string());
        q.insert("a&b".to_string(), "1=2".to_string());
        let url = build_url("/s", &q);
        // Keys sorted: "a&b" before "msg"
        assert_eq!(url, "/s?a%26b=1%3D2&msg=hello%20world");
    }

    #[test]
    fn build_then_parse_roundtrip() {
        let mut q = BTreeMap::new();
        q.insert("x".to_string(), "hello world".to_string());
        q.insert("y".to_string(), "a&b=c".to_string());
        let url = build_url("/p", &q);
        let (p, parsed) = parse_query(&url);
        assert_eq!(p, "/p");
        assert_eq!(parsed, q);
    }
}

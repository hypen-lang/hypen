//! Web fonts for named `fontFamily` entries, mirroring the DOM renderer.
//!
//! The web renderer's `fontFamily` applicator (`hypen-web` `font.ts`)
//! links every family in the list that is not a system keyword to Google
//! Fonts (`fonts.googleapis.com/css2?family=<name>:wght@100;…;900`), so a
//! `.fontFamily("-apple-system, …, Roboto, Inter, sans-serif")` draws in
//! Roboto in every browser, installed or not. Without the same faces the
//! desktop renderer drew those apps in the generic fallback — wider text,
//! different wrapping and ellipsis.
//!
//! # Opting out
//!
//! On by default for windowed apps, like the DOM renderer. Off with
//! [`crate::DesktopApp::web_fonts`]`(false)`, or with the environment
//! variable `HYPEN_WEB_FONTS=0` (`off` / `false` / `no`), which overrides
//! the builder either way (`HYPEN_WEB_FONTS=1` forces it on). With it
//! off nothing is ever fetched and lists resolve to installed families
//! and their generic keyword. Tests and headless measurement never fetch.
//!
//! # Bounds
//!
//! Font names come from app content — remote modules and `HypenApp`
//! embeds included — so a page cycling `fontFamily` names must not be
//! able to exhaust threads, memory or the network:
//!
//! * a fixed pool of [`WORKERS`] fetch threads fed by a queue, instead of
//!   a thread per family;
//! * at most [`MAX_FAMILIES`] distinct families per process (later names
//!   are ignored, and the list resolves past them as if not served);
//!   names longer than [`MAX_NAME_LEN`] or with characters no Google
//!   family uses are never requested;
//! * per origin: CSS only from `fonts.googleapis.com`, font files only
//!   from `fonts.gstatic.com` (a URL anywhere else in the CSS is
//!   ignored), at most [`MAX_FILES_PER_FAMILY`] files per family;
//! * at most [`MAX_FILE_BYTES`] per file and [`MAX_TOTAL_BYTES`] of font
//!   data per process — a family that would cross it is dropped whole.
//!
//! Each family is fetched once per process; the CSS is asked for with a
//! non-browser user agent, for which Google serves one static TrueType
//! file per weight. Landed faces are kept here and merged into each
//! [`crate::text::TextEngine`]'s font database by
//! [`crate::text::TextEngine::sync_web_fonts`], under the family name
//! [`web_family_name`] so the text engine can prefer them over an
//! installed family of the same name — Chrome's `@font-face` rules win
//! over local fonts. While a family is loading (or when it is not a
//! Google family) the list resolves past it, like `font-display: swap`.

use std::collections::{HashSet, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex, OnceLock};
use std::time::Duration;

static ENABLED: AtomicBool = AtomicBool::new(false);
/// Bumped every time faces land; engines compare it with what they merged.
static GENERATION: AtomicU64 = AtomicU64::new(0);

/// Fetch threads shared by every request.
pub const WORKERS: usize = 2;
/// Distinct families requested per process.
pub const MAX_FAMILIES: usize = 24;
/// Longest family name ever requested.
pub const MAX_NAME_LEN: usize = 64;
/// Font files fetched per family (Google serves one per weight × style).
pub const MAX_FILES_PER_FAMILY: usize = 18;
/// Bytes of one font file.
pub const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
/// Bytes of web-font data kept per process.
pub const MAX_TOTAL_BYTES: u64 = 48 * 1024 * 1024;

const CSS_ORIGIN: &str = "https://fonts.googleapis.com/";
const FONT_ORIGIN: &str = "https://fonts.gstatic.com/";

/// The environment switch (see the module docs).
pub const ENV_VAR: &str = "HYPEN_WEB_FONTS";

type Waker = Box<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct Registry {
    /// Lower-cased family names already requested (loaded, loading or
    /// failed). Never more than [`MAX_FAMILIES`].
    requested: HashSet<String>,
    /// Families waiting for a worker.
    queue: VecDeque<String>,
    /// Workers started so far (at most [`WORKERS`]).
    workers: usize,
    /// Every landed face, in arrival order, already carrying the
    /// [`web_family_name`] and the weight its `@font-face` declared.
    faces: Vec<fontdb::FaceInfo>,
    /// Font bytes held by `faces` (shared files counted once).
    bytes: u64,
    /// Set once the family cap has been hit and logged.
    cap_logged: bool,
    waker: Option<Waker>,
}

fn registry() -> &'static (Mutex<Registry>, Condvar) {
    static REGISTRY: OnceLock<(Mutex<Registry>, Condvar)> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

fn lock() -> std::sync::MutexGuard<'static, Registry> {
    registry().0.lock().expect("web font registry poisoned")
}

/// Whether web fonts are on, given the app's builder choice: the
/// `HYPEN_WEB_FONTS` environment variable wins when it is set to a
/// recognised value, otherwise `builder` decides.
pub fn allowed(builder: bool) -> bool {
    match std::env::var(ENV_VAR) {
        Ok(v) => parse_switch(&v).unwrap_or(builder),
        Err(_) => builder,
    }
}

fn parse_switch(value: &str) -> Option<bool> {
    match value.trim().to_ascii_lowercase().as_str() {
        "0" | "off" | "false" | "no" => Some(false),
        "1" | "on" | "true" | "yes" => Some(true),
        _ => None,
    }
}

/// Allow web-font requests. `waker` is called (from a worker thread)
/// whenever faces land, so the window can relayout with them.
pub fn enable(waker: impl Fn() + Send + Sync + 'static) {
    lock().waker = Some(Box::new(waker));
    ENABLED.store(true, Ordering::Release);
}

pub(crate) fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

/// Faces that landed after the first `skip`.
pub(crate) fn faces_since(skip: usize) -> Vec<fontdb::FaceInfo> {
    lock().faces.iter().skip(skip).cloned().collect()
}

/// The family name a landed web font is registered under in the text
/// engine's database: distinct from any installed family, so an
/// installed "Roboto" and the `@font-face` "Roboto" can both be present
/// and the engine can prefer the latter, as Chrome does.
pub(crate) fn web_family_name(name: &str) -> String {
    format!("hypen-web-font:{}", name.trim().to_ascii_lowercase())
}

/// The DOM applicator's `isSystemFont`, as it actually behaves: it
/// lower-cases the name before looking it up in a keyword set whose
/// mixed-case entries (`"Georgia"`, `"Segoe UI"`, `"Helvetica"`, …) can
/// therefore never match. So only the lower-case CSS keywords, and names
/// starting with `-` or `ui-`, are skipped — and Chrome does fetch
/// Georgia, Times New Roman, Helvetica, Verdana… from Google Fonts,
/// which serves them (News draws its titles in that Georgia).
fn is_system_font(name: &str) -> bool {
    const KEYWORDS: &[&str] = &[
        "default",
        "system",
        "system-ui",
        "inherit",
        "initial",
        "unset",
        "serif",
        "sans-serif",
        "monospace",
        "cursive",
        "fantasy",
        "-apple-system",
    ];
    let lower = name.trim().to_lowercase();
    KEYWORDS.contains(&lower.as_str()) || lower.starts_with('-') || lower.starts_with("ui-")
}

/// A name a Google Fonts family could have: letters, digits, spaces and
/// a few joiners, at most [`MAX_NAME_LEN`] bytes. Anything else is never
/// sent anywhere.
fn plausible_family_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= MAX_NAME_LEN
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || matches!(c, ' ' | '-' | '_' | '.' | '&'))
}

/// Ask for family `name` as a web font (no-op unless [`enable`]d, for
/// system names, implausible names, once [`MAX_FAMILIES`] are requested,
/// or when already requested). Returns immediately: the family is queued
/// for the worker pool.
pub(crate) fn request(name: &str) {
    if !ENABLED.load(Ordering::Acquire) {
        return;
    }
    let mut guard = lock();
    if !admit(&mut guard, name) {
        return;
    }
    if guard.workers < WORKERS {
        let spawned = std::thread::Builder::new()
            .name("hypen-web-font".into())
            .spawn(worker);
        match spawned {
            Ok(_) => guard.workers += 1,
            Err(err) => log::warn!("web font worker: {err}"),
        }
    }
    drop(guard);
    registry().1.notify_one();
}

/// Queue `name` unless it is a system / implausible name, already
/// requested, or over the [`MAX_FAMILIES`] cap. `true` when queued.
fn admit(registry: &mut Registry, name: &str) -> bool {
    let name = name.trim();
    if is_system_font(name) || !plausible_family_name(name) {
        return false;
    }
    let key = name.to_ascii_lowercase();
    if registry.requested.contains(&key) {
        return false;
    }
    if registry.requested.len() >= MAX_FAMILIES {
        if !registry.cap_logged {
            registry.cap_logged = true;
            log::warn!(
                "web fonts: {MAX_FAMILIES}-family cap reached; {name:?} and later families are not fetched"
            );
        }
        return false;
    }
    registry.requested.insert(key);
    registry.queue.push_back(name.to_string());
    true
}

/// One pool thread: fetch queued families until the process ends.
fn worker() {
    let (mutex, ready) = registry();
    loop {
        let name = {
            let mut registry = mutex.lock().expect("web font registry poisoned");
            loop {
                if let Some(name) = registry.queue.pop_front() {
                    break name;
                }
                registry = ready.wait(registry).expect("web font registry poisoned");
            }
        };
        let budget = {
            let registry = mutex.lock().expect("web font registry poisoned");
            MAX_TOTAL_BYTES.saturating_sub(registry.bytes)
        };
        let (faces, bytes) = fetch_family(&name, budget);
        if faces.is_empty() {
            log::debug!("web font {name:?}: not available");
            continue;
        }
        let mut registry = mutex.lock().expect("web font registry poisoned");
        if registry.bytes + bytes > MAX_TOTAL_BYTES {
            log::warn!("web font {name:?}: dropped, over the {MAX_TOTAL_BYTES}-byte budget");
            continue;
        }
        log::debug!("web font {name:?}: {} faces, {bytes} bytes", faces.len());
        registry.bytes += bytes;
        registry.faces.extend(faces);
        GENERATION.fetch_add(1, Ordering::AcqRel);
        if let Some(wake) = registry.waker.as_ref() {
            wake();
        }
    }
}

/// One `@font-face` rule of the Google Fonts CSS.
#[derive(Debug, PartialEq)]
struct FaceRule {
    weight: u16,
    italic: bool,
    url: String,
}

/// Fetch one family's faces within `budget` bytes. Returns the faces
/// (named [`web_family_name`]) and the bytes they hold; empty when the
/// family is not served, a request fails, or the budget would be crossed.
fn fetch_family(name: &str, budget: u64) -> (Vec<fontdb::FaceInfo>, u64) {
    let css_url = format!(
        "{CSS_ORIGIN}css2?family={}:wght@100;200;300;400;500;600;700;800;900&display=swap",
        encode_family(name)
    );
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        .redirects(0)
        // Not a browser: Google answers with plain TrueType files.
        .user_agent("hypen-renderer-desktop")
        .build();
    let Some(css) = agent
        .get(&css_url)
        .call()
        .ok()
        .and_then(|response| read_capped(response, 512 * 1024))
        .and_then(|bytes| String::from_utf8(bytes).ok())
    else {
        return (Vec::new(), 0);
    };
    let family = web_family_name(name);
    let mut fetched: Vec<(String, Arc<Vec<u8>>)> = Vec::new();
    let mut total: u64 = 0;
    let mut faces = Vec::new();
    for rule in parse_font_faces(&css) {
        let data = match fetched.iter().find(|(url, _)| *url == rule.url) {
            Some((_, data)) => Arc::clone(data),
            None => {
                if fetched.len() >= MAX_FILES_PER_FAMILY {
                    break;
                }
                let Some(data) = fetch_bytes(&agent, &rule.url) else {
                    continue;
                };
                total += data.len() as u64;
                if total > budget {
                    return (Vec::new(), 0);
                }
                let data = Arc::new(data);
                fetched.push((rule.url.clone(), Arc::clone(&data)));
                data
            }
        };
        let mut scratch = fontdb::Database::new();
        scratch.load_font_source(fontdb::Source::Binary(data));
        for face in scratch.faces() {
            let mut face = face.clone();
            // The `@font-face` descriptors, not the file's own names,
            // decide what the face answers to — as in a browser.
            face.families = vec![(family.clone(), fontdb::Language::English_UnitedStates)];
            face.weight = fontdb::Weight(rule.weight);
            face.style = if rule.italic {
                fontdb::Style::Italic
            } else {
                fontdb::Style::Normal
            };
            faces.push(face);
        }
    }
    (faces, total)
}

fn read_capped(response: ureq::Response, cap: u64) -> Option<Vec<u8>> {
    use std::io::Read;
    let mut bytes = Vec::new();
    response
        .into_reader()
        .take(cap + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    // Over the cap: refuse rather than keep a truncated file.
    (!bytes.is_empty() && bytes.len() as u64 <= cap).then_some(bytes)
}

fn fetch_bytes(agent: &ureq::Agent, url: &str) -> Option<Vec<u8>> {
    if !url.starts_with(FONT_ORIGIN) {
        return None;
    }
    read_capped(agent.get(url).call().ok()?, MAX_FILE_BYTES)
}

fn encode_family(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    for byte in name.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// The `@font-face` rules of a Google Fonts stylesheet: weight, style
/// and the first `url(…)` of each `src`.
fn parse_font_faces(css: &str) -> Vec<FaceRule> {
    let mut rules = Vec::new();
    for block in css.split("@font-face").skip(1) {
        let Some(body) = block.split('}').next() else {
            continue;
        };
        let mut weight = 400;
        let mut italic = false;
        let mut url = None;
        for declaration in body
            .trim_start_matches(|c: char| c.is_whitespace() || c == '{')
            .split(';')
        {
            let Some((property, value)) = declaration.split_once(':') else {
                continue;
            };
            let value = value.trim();
            match property.trim() {
                "font-weight" => {
                    weight = value
                        .split_whitespace()
                        .next()
                        .and_then(|w| w.parse().ok())
                        .unwrap_or(400)
                }
                "font-style" => italic = value != "normal",
                "src" => {
                    url = value
                        .split_once("url(")
                        .and_then(|(_, rest)| rest.split_once(')'))
                        .map(|(u, _)| u.trim_matches(|c| c == '"' || c == '\'').to_string())
                }
                _ => {}
            }
        }
        // Per-origin limit: font files come from Google's font CDN only.
        if let Some(url) = url.filter(|u| u.starts_with(FONT_ORIGIN)) {
            rules.push(FaceRule {
                weight,
                italic,
                url,
            });
        }
    }
    rules
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_google_fonts_css() {
        let css = "@font-face {\n  font-family: 'Roboto';\n  font-style: normal;\n  font-weight: 100;\n  font-stretch: normal;\n  font-display: swap;\n  src: url(https://fonts.gstatic.com/s/roboto/v51/a.ttf) format('truetype');\n}\n@font-face {\n  font-family: 'Roboto';\n  font-style: italic;\n  font-weight: 700;\n  src: url(https://fonts.gstatic.com/s/roboto/v51/b.ttf) format('truetype');\n}\n";
        assert_eq!(
            parse_font_faces(css),
            vec![
                FaceRule {
                    weight: 100,
                    italic: false,
                    url: "https://fonts.gstatic.com/s/roboto/v51/a.ttf".into()
                },
                FaceRule {
                    weight: 700,
                    italic: true,
                    url: "https://fonts.gstatic.com/s/roboto/v51/b.ttf".into()
                },
            ]
        );
        assert!(parse_font_faces("not css").is_empty());
    }

    #[test]
    fn system_names_are_never_fetched_like_the_dom_applicator() {
        for name in [
            "serif",
            "Sans-Serif",
            "system-ui",
            "-apple-system",
            "ui-monospace",
        ] {
            assert!(is_system_font(name), "{name}");
        }
        // Mixed-case "system" names are fetched by the DOM renderer too.
        for name in [
            "Roboto",
            "Inter",
            "JetBrains Mono",
            "Georgia",
            "Segoe UI",
            "BlinkMacSystemFont",
        ] {
            assert!(!is_system_font(name), "{name}");
        }
        assert_eq!(encode_family("Inter Display"), "Inter%20Display");
    }

    #[test]
    fn the_switch_parses_and_the_env_var_overrides_the_builder() {
        assert_eq!(parse_switch("0"), Some(false));
        assert_eq!(parse_switch(" Off "), Some(false));
        assert_eq!(parse_switch("no"), Some(false));
        assert_eq!(parse_switch("1"), Some(true));
        assert_eq!(parse_switch("on"), Some(true));
        assert_eq!(parse_switch("maybe"), None);
        // Unset (the test environment does not set it): the builder wins.
        if std::env::var(ENV_VAR).is_err() {
            assert!(allowed(true));
            assert!(!allowed(false));
        }
    }

    #[test]
    fn only_plausible_family_names_are_ever_requested() {
        for ok in [
            "Roboto",
            "Inter",
            "JetBrains Mono",
            "Noto Sans JP",
            "M PLUS 1p",
        ] {
            assert!(plausible_family_name(ok), "{ok}");
        }
        let long = "A".repeat(MAX_NAME_LEN + 1);
        for bad in [
            "",
            "a/b",
            "x?y=z",
            "evil\nname",
            "url(http://x)",
            long.as_str(),
        ] {
            assert!(!plausible_family_name(bad), "{bad}");
        }
    }

    #[test]
    fn font_files_come_from_the_font_cdn_only() {
        let css = "@font-face { font-weight: 400; src: url(http://127.0.0.1:8080/x.ttf); }\n@font-face { font-weight: 700; src: url(https://evil.example/y.ttf); }\n@font-face { font-weight: 500; src: url(https://fonts.gstatic.com/s/a.ttf); }";
        let rules = parse_font_faces(css);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].url, "https://fonts.gstatic.com/s/a.ttf");
        let agent = ureq::AgentBuilder::new().build();
        assert!(fetch_bytes(&agent, "http://localhost/x.ttf").is_none());
    }

    #[test]
    fn cycling_family_names_cannot_grow_the_queue_past_the_cap() {
        let mut registry = Registry::default();
        for i in 0..10_000 {
            admit(&mut registry, &format!("Family {i}"));
            admit(&mut registry, "Roboto");
        }
        assert_eq!(registry.requested.len(), MAX_FAMILIES);
        assert_eq!(registry.queue.len(), MAX_FAMILIES);
        assert!(registry.cap_logged);
        // A repeat of an admitted name is never queued twice.
        assert_eq!(registry.queue.iter().filter(|n| *n == "Roboto").count(), 1);
    }

    #[test]
    fn web_faces_get_a_name_no_installed_family_has() {
        assert_eq!(web_family_name(" Roboto "), "hypen-web-font:roboto");
        assert_ne!(web_family_name("Roboto"), "Roboto");
    }

    #[test]
    fn requests_are_inert_until_enabled() {
        // Tests never enable the fetcher: a request must not register.
        request("Roboto");
        assert!(!ENABLED.load(Ordering::Acquire));
        assert!(faces_since(0).is_empty());
    }
}

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
//! Requests are made only once [`enable`] has been called (the windowed
//! app does, with a waker), never from tests or headless measurement.
//! Each family is fetched once per process on a background thread; the
//! CSS is asked for with a non-browser user agent, for which Google
//! serves one static TrueType file per weight. Landed faces are kept here
//! and merged into each [`crate::text::TextEngine`]'s font database by
//! [`crate::text::TextEngine::sync_web_fonts`]. While a family is loading
//! (or when it is not a Google family) the list resolves past it, like a
//! browser's `font-display: swap`.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

static ENABLED: AtomicBool = AtomicBool::new(false);
/// Bumped every time faces land; engines compare it with what they merged.
static GENERATION: AtomicU64 = AtomicU64::new(0);

type Waker = Box<dyn Fn() + Send + Sync>;

#[derive(Default)]
struct Registry {
    /// Lower-cased family names already requested (loaded, loading or failed).
    requested: HashSet<String>,
    /// Every landed face, in arrival order, already carrying the
    /// requested family name and the weight its `@font-face` declared.
    faces: Vec<fontdb::FaceInfo>,
    waker: Option<Waker>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(Default::default)
}

/// Allow web-font requests. `waker` is called (from a worker thread)
/// whenever faces land, so the window can relayout with them.
pub fn enable(waker: impl Fn() + Send + Sync + 'static) {
    registry().lock().expect("web font registry poisoned").waker = Some(Box::new(waker));
    ENABLED.store(true, Ordering::Release);
}

pub(crate) fn generation() -> u64 {
    GENERATION.load(Ordering::Acquire)
}

/// Faces that landed after the first `skip`.
pub(crate) fn faces_since(skip: usize) -> Vec<fontdb::FaceInfo> {
    let registry = registry().lock().expect("web font registry poisoned");
    registry.faces.iter().skip(skip).cloned().collect()
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

/// Ask for family `name` as a web font (no-op unless [`enable`]d, for
/// system names, or when already requested). Returns immediately.
pub(crate) fn request(name: &str) {
    if !ENABLED.load(Ordering::Acquire) || is_system_font(name) || name.trim().is_empty() {
        return;
    }
    let name = name.trim().to_string();
    {
        let mut registry = registry().lock().expect("web font registry poisoned");
        if !registry.requested.insert(name.to_ascii_lowercase()) {
            return;
        }
    }
    let spawned = std::thread::Builder::new()
        .name("hypen-web-font".into())
        .spawn(move || {
            let faces = fetch_family(&name);
            if faces.is_empty() {
                log::debug!("web font {name:?}: not available");
                return;
            }
            log::debug!("web font {name:?}: {} faces", faces.len());
            let registry = &mut *registry().lock().expect("web font registry poisoned");
            registry.faces.extend(faces);
            GENERATION.fetch_add(1, Ordering::AcqRel);
            if let Some(wake) = registry.waker.as_ref() {
                wake();
            }
        });
    if let Err(err) = spawned {
        log::warn!("web font thread: {err}");
    }
}

/// One `@font-face` rule of the Google Fonts CSS.
#[derive(Debug, PartialEq)]
struct FaceRule {
    weight: u16,
    italic: bool,
    url: String,
}

fn fetch_family(name: &str) -> Vec<fontdb::FaceInfo> {
    let css_url = format!(
        "https://fonts.googleapis.com/css2?family={}:wght@100;200;300;400;500;600;700;800;900&display=swap",
        encode_family(name)
    );
    let agent = ureq::AgentBuilder::new()
        .timeout(Duration::from_secs(15))
        // Not a browser: Google answers with plain TrueType files.
        .user_agent("hypen-renderer-desktop")
        .build();
    let Some(css) = agent
        .get(&css_url)
        .call()
        .ok()
        .and_then(|response| response.into_string().ok())
    else {
        return Vec::new();
    };
    let mut fetched: Vec<(String, Arc<Vec<u8>>)> = Vec::new();
    let mut faces = Vec::new();
    for rule in parse_font_faces(&css) {
        let data = match fetched.iter().find(|(url, _)| *url == rule.url) {
            Some((_, data)) => Arc::clone(data),
            None => {
                let Some(data) = fetch_bytes(&agent, &rule.url) else {
                    continue;
                };
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
            face.families = vec![(name.to_string(), fontdb::Language::English_UnitedStates)];
            face.weight = fontdb::Weight(rule.weight);
            face.style = if rule.italic {
                fontdb::Style::Italic
            } else {
                fontdb::Style::Normal
            };
            faces.push(face);
        }
    }
    faces
}

fn fetch_bytes(agent: &ureq::Agent, url: &str) -> Option<Vec<u8>> {
    const MAX_FONT_BYTES: u64 = 16 * 1024 * 1024;
    let response = agent.get(url).call().ok()?;
    let mut bytes = Vec::new();
    use std::io::Read;
    response
        .into_reader()
        .take(MAX_FONT_BYTES)
        .read_to_end(&mut bytes)
        .ok()?;
    (!bytes.is_empty()).then_some(bytes)
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
        for declaration in body.trim_start_matches(|c: char| c.is_whitespace() || c == '{').split(';') {
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
        if let Some(url) = url.filter(|u| u.starts_with("https://")) {
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
        for name in ["serif", "Sans-Serif", "system-ui", "-apple-system", "ui-monospace"] {
            assert!(is_system_font(name), "{name}");
        }
        // Mixed-case "system" names are fetched by the DOM renderer too.
        for name in ["Roboto", "Inter", "JetBrains Mono", "Georgia", "Segoe UI", "BlinkMacSystemFont"] {
            assert!(!is_system_font(name), "{name}");
        }
        assert_eq!(encode_family("Inter Display"), "Inter%20Display");
    }

    #[test]
    fn requests_are_inert_until_enabled() {
        // Tests never enable the fetcher: a request must not register.
        request("Roboto");
        assert!(!ENABLED.load(Ordering::Acquire));
        assert!(faces_since(0).is_empty());
    }
}

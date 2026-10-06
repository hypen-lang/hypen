//! Native file dialogs for the desktop device drivers (`file.pick`,
//! `gallery.pick`, `file.save`), plus the content-type table they share.
//!
//! The system dialog is the per-use consent gate (RFC 001 §3: "picker is the
//! gate" for the pickers, "destination picker" for `file.save`): nothing is
//! read or written before the user chooses in it, and dismissing it is
//! `cancelled`. Its title names the authenticated app origin, which is host
//! text, never server-supplied text.
//!
//! [`NativeFileDialogs`] uses `rfd` (GTK-free XDG desktop portal on Linux,
//! `NSOpenPanel`/`NSSavePanel` on macOS, the common item dialogs on
//! Windows). Tests inject their own [`FileDialogs`].

use std::path::{Path, PathBuf};

/// A file-open dialog request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickDialog {
    /// Host-owned title naming the requesting origin.
    pub title: String,
    /// `(label, extensions without dots)`; empty = any file.
    pub filters: Vec<(String, Vec<String>)>,
    /// Allow choosing several files.
    pub multiple: bool,
}

/// A file-save dialog request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SaveDialog {
    /// Host-owned title naming the requesting origin and the file.
    pub title: String,
    /// Suggested file name (the server's `name`, reduced to a base name).
    pub file_name: String,
    pub filters: Vec<(String, Vec<String>)>,
}

/// Why a dialog could not be shown at all (maps to `unavailable`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DialogUnavailable(pub String);

/// The dialogs the desktop drivers present. Calls block until the user
/// answers; the host runs them off the socket worker. `Ok(None)` means the
/// user dismissed the dialog (`cancelled`).
pub trait FileDialogs: Send + Sync + 'static {
    /// Whether dialogs can be presented on this machine at all (a display /
    /// dialog backend exists). The advertisement rule (§2.2): a capability
    /// whose gate cannot be shown is not advertised.
    fn available(&self) -> bool {
        true
    }

    fn pick_files(&self, request: &PickDialog) -> Result<Option<Vec<PathBuf>>, DialogUnavailable>;

    fn save_file(&self, request: &SaveDialog) -> Result<Option<PathBuf>, DialogUnavailable>;
}

/// The operating system's dialogs, through `rfd`.
///
/// `rfd`'s async dialogs are used and driven to completion on the calling
/// (blocking) thread: on macOS they are dispatched to the main thread, whose
/// run loop the winit event loop keeps spinning; on Linux they talk to the
/// XDG desktop portal over D-Bus; on Windows they run a modal loop on the
/// calling thread.
#[derive(Debug, Default, Clone, Copy)]
pub struct NativeFileDialogs;

/// Whether a display (and so a dialog or an in-window host UI) can exist:
/// on Linux / BSD a Wayland or X11 display must be set; macOS and Windows
/// always have one for a desktop session.
pub fn display_present() -> bool {
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        std::env::var_os("WAYLAND_DISPLAY").is_some() || std::env::var_os("DISPLAY").is_some()
    }
    #[cfg(not(all(unix, not(target_os = "macos"))))]
    {
        true
    }
}

impl NativeFileDialogs {
    fn display_present() -> bool {
        display_present()
    }
}

impl FileDialogs for NativeFileDialogs {
    fn available(&self) -> bool {
        Self::display_present()
    }

    fn pick_files(&self, request: &PickDialog) -> Result<Option<Vec<PathBuf>>, DialogUnavailable> {
        if !Self::display_present() {
            return Err(DialogUnavailable("no-display".into()));
        }
        let mut dialog = rfd::AsyncFileDialog::new().set_title(request.title.as_str());
        for (label, exts) in &request.filters {
            dialog = dialog.add_filter(label.as_str(), exts);
        }
        let picked = if request.multiple {
            pollster::block_on(dialog.pick_files())
                .map(|files| files.into_iter().map(|f| f.path().to_path_buf()).collect())
        } else {
            pollster::block_on(dialog.pick_file()).map(|f| vec![f.path().to_path_buf()])
        };
        Ok(picked)
    }

    fn save_file(&self, request: &SaveDialog) -> Result<Option<PathBuf>, DialogUnavailable> {
        if !Self::display_present() {
            return Err(DialogUnavailable("no-display".into()));
        }
        let mut dialog = rfd::AsyncFileDialog::new()
            .set_title(request.title.as_str())
            .set_file_name(request.file_name.as_str());
        for (label, exts) in &request.filters {
            dialog = dialog.add_filter(label.as_str(), exts);
        }
        Ok(pollster::block_on(dialog.save_file()).map(|f| f.path().to_path_buf()))
    }
}

// ---------------------------------------------------------------------------
// Content types
// ---------------------------------------------------------------------------

/// Extension → media type. Bare types (no parameters), as the protocol wants.
const TYPES: &[(&str, &str)] = &[
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("png", "image/png"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
    ("heic", "image/heic"),
    ("heif", "image/heif"),
    ("avif", "image/avif"),
    ("bmp", "image/bmp"),
    ("tif", "image/tiff"),
    ("tiff", "image/tiff"),
    ("svg", "image/svg+xml"),
    ("mp4", "video/mp4"),
    ("m4v", "video/x-m4v"),
    ("mov", "video/quicktime"),
    ("webm", "video/webm"),
    ("mkv", "video/x-matroska"),
    ("avi", "video/x-msvideo"),
    ("mp3", "audio/mpeg"),
    ("m4a", "audio/mp4"),
    ("wav", "audio/wav"),
    ("ogg", "audio/ogg"),
    ("flac", "audio/flac"),
    ("txt", "text/plain"),
    ("md", "text/markdown"),
    ("csv", "text/csv"),
    ("html", "text/html"),
    ("htm", "text/html"),
    ("css", "text/css"),
    ("js", "text/javascript"),
    ("json", "application/json"),
    ("xml", "application/xml"),
    ("pdf", "application/pdf"),
    ("zip", "application/zip"),
    ("gz", "application/gzip"),
    ("tar", "application/x-tar"),
    ("doc", "application/msword"),
    (
        "docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ),
    ("xls", "application/vnd.ms-excel"),
    (
        "xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ),
];

/// The media type of `path` by its extension; `application/octet-stream`
/// when unknown.
pub fn content_type_for(path: &Path) -> &'static str {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    ext.and_then(|e| TYPES.iter().find(|(x, _)| *x == e).map(|(_, t)| *t))
        .unwrap_or("application/octet-stream")
}

/// Extensions whose media type starts with `prefix` (e.g. `image/`).
pub fn extensions_with_prefix(prefix: &str) -> Vec<String> {
    TYPES
        .iter()
        .filter(|(_, t)| t.starts_with(prefix))
        .map(|(x, _)| x.to_string())
        .collect()
}

/// Dialog filters for an HTML-style `accept` list (`.pdf`, `image/*`,
/// `application/json`); empty when nothing maps (any file). `accept` is
/// advisory, as in a browser: it shapes the dialog, it does not police the
/// user's choice.
pub fn filters_for_accept(accept: &[String]) -> Vec<(String, Vec<String>)> {
    let mut exts: Vec<String> = Vec::new();
    for entry in accept {
        let e = entry.trim().to_ascii_lowercase();
        if let Some(x) = e.strip_prefix('.') {
            if !x.is_empty() {
                exts.push(x.to_string());
            }
        } else if let Some(major) = e.strip_suffix("/*") {
            exts.extend(extensions_with_prefix(&format!("{major}/")));
        } else {
            exts.extend(
                TYPES
                    .iter()
                    .filter(|(_, t)| *t == e)
                    .map(|(x, _)| x.to_string()),
            );
        }
    }
    exts.sort();
    exts.dedup();
    if exts.is_empty() {
        Vec::new()
    } else {
        vec![("Accepted files".to_string(), exts)]
    }
}

/// A server-supplied file name reduced to a safe base name for a dialog
/// suggestion (no directories, no control characters, never empty).
pub fn sanitize_file_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or("");
    let cleaned: String = base
        .chars()
        .filter(|c| !c.is_control() && !matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();
    let cleaned = cleaned.trim().trim_start_matches('.').to_string();
    if cleaned.is_empty() {
        "download".to_string()
    } else {
        cleaned
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_types_by_extension() {
        assert_eq!(content_type_for(Path::new("a/B.JPG")), "image/jpeg");
        assert_eq!(content_type_for(Path::new("clip.mov")), "video/quicktime");
        assert_eq!(
            content_type_for(Path::new("noext")),
            "application/octet-stream"
        );
    }

    #[test]
    fn accept_lists_map_to_dialog_filters() {
        let f = filters_for_accept(&[".PDF".into(), "image/*".into(), "application/json".into()]);
        let exts = &f[0].1;
        assert!(exts.contains(&"pdf".to_string()));
        assert!(exts.contains(&"png".to_string()));
        assert!(exts.contains(&"json".to_string()));
        assert!(!exts.contains(&"mp4".to_string()));
        assert!(filters_for_accept(&[]).is_empty());
        assert!(filters_for_accept(&["x-unknown/thing".into()]).is_empty());
    }

    #[test]
    fn server_file_names_are_reduced_to_base_names() {
        assert_eq!(sanitize_file_name("../../etc/passwd"), "passwd");
        assert_eq!(sanitize_file_name("C:\\x\\report.pdf"), "report.pdf");
        assert_eq!(sanitize_file_name(".bashrc"), "bashrc");
        assert_eq!(sanitize_file_name("  "), "download");
        assert_eq!(sanitize_file_name("a\u{0}b?.txt"), "ab.txt");
    }
}

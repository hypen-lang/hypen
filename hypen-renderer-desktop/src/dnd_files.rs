//! Files from the OS — the desktop consumer of `.dropZone(files: true,
//! accept:)` (`hypen-web/docs/dnd.md`, "Files from the OS").
//!
//! The engine lowers a files zone to the ordinary `__dnd.zone` channel plus
//! `"files": true` and `"accept": string|null`. While files dragged in from
//! the OS hover an enabled files zone, the runtime applies the same `over`
//! pose an in-app drag would ([`DesktopDnd::apply_pose`]), fires the zone's
//! `.onFileDragEnter` once per entry, and clears everything on leave,
//! release, or cancel. The files themselves are never opened, read, or
//! described to the module: only their COUNT crosses the boundary.
//! `.onFileDragEnter` fires under exactly the condition that lights `over`
//! — the zone is enabled AND the drag matches its `accept` — so an app never
//! opens a picker for the wrong types.
//!
//! # What winit (0.30) delivers
//!
//! * `HoveredFile(PathBuf)` once per file when the drag enters the window
//!   (macOS: `draggingEntered:`; Windows: `IDropTarget::DragEnter`; X11:
//!   the first `XdndPosition`). Wayland: no file DnD at all.
//! * `HoveredFileCancelled` when the drag leaves the window or is cancelled.
//! * `DroppedFile(PathBuf)` once per file on release — no cancel follows.
//! * **No position** on any of them, and no `draggingUpdated:` /
//!   `DragOver` forwarding. macOS and X11 deliver no `CursorMoved` while an
//!   OS drag is in flight either (the drag session owns the pointer).
//!
//! # Where the drag is
//!
//! The window feeds [`DesktopDnd::file_hover_update`] the freshest position
//! it can get: a `CursorMoved` that does arrive mid-hover, else a poll of
//! the OS cursor (`os_cursor`: macOS `mouseLocationOutsideOfEventStream`,
//! Windows `GetCursorPos` + `ScreenToClient`) from the idle loop at ~60 Hz
//! while a hover is live. When the position is unknown (X11, a failed
//! query) the rule is conservative: if EXACTLY ONE enabled files zone is
//! laid out, it is the target (when its `accept` matches); otherwise no zone
//! lights up — never a guessed one. A position captured before the hover
//! began is never trusted.
//!
//! # `accept`
//!
//! Desktop drags carry PATHS, so types are guessed from the extension only
//! (a small built-in table): `.ext` tokens compare the extension, `type/*`
//! the guessed major type, a full MIME the guessed type. An extension the
//! table doesn't know (or none — a folder) counts as a match against MIME
//! tokens ("types the platform can't tell before the drop count as a
//! match"). The path is reduced to `(extension, mime)` on entry and
//! dropped; nothing else is retained.

use super::*;
use std::path::Path;

/// Event-prop name of the files signal.
pub const ON_FILE_DRAG_ENTER: &str = "onFileDragEnter";

/// One hovered OS item reduced to what `accept` needs — the lowercase
/// extension and a MIME guessed from it. The path itself is not kept.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HoveredKind {
    ext: Option<String>,
    mime: Option<&'static str>,
}

impl HoveredKind {
    pub fn from_path(path: &Path) -> Self {
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .map(str::to_ascii_lowercase)
            .filter(|e| !e.is_empty());
        let mime = ext.as_deref().and_then(mime_from_ext);
        Self { ext, mime }
    }
}

/// MIME guess for a lowercase extension (no dot). `None` = unknown.
pub fn mime_from_ext(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "png" => "image/png",
        "jpg" | "jpeg" | "jpe" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "svg" => "image/svg+xml",
        "ico" => "image/x-icon",
        "tif" | "tiff" => "image/tiff",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "avif" => "image/avif",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "flac" => "audio/flac",
        "txt" | "text" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "html" | "htm" => "text/html",
        "css" => "text/css",
        "js" | "mjs" => "text/javascript",
        "xml" => "application/xml",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "tar" => "application/x-tar",
        "rtf" => "application/rtf",
        "wasm" => "application/wasm",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        _ => return None,
    })
}

fn token_matches(token: &str, kind: &HoveredKind) -> bool {
    if let Some(ext) = token.strip_prefix('.') {
        return kind.ext.as_deref() == Some(ext);
    }
    if token == "*" || token == "*/*" {
        return true;
    }
    // A type the platform can't tell before the drop counts as a match.
    let Some(mime) = kind.mime else {
        return true;
    };
    match token.strip_suffix("/*") {
        Some(major) => mime.split('/').next() == Some(major),
        None => mime == token,
    }
}

/// Does an `<input accept>` filter admit the hovered items? At least one
/// item must match one comma-separated token. No filter, an empty filter,
/// or no items known ⇒ match.
pub fn accept_matches(accept: Option<&str>, kinds: &[HoveredKind]) -> bool {
    let tokens: Vec<String> = accept
        .unwrap_or("")
        .split(',')
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    if tokens.is_empty() || kinds.is_empty() {
        return true;
    }
    kinds
        .iter()
        .any(|k| tokens.iter().any(|t| token_matches(t, k)))
}

/// A live OS file hover over the window.
#[derive(Debug, Default)]
pub(crate) struct FileHover {
    kinds: Vec<HoveredKind>,
    /// Physical px, window space. Only positions observed DURING the hover.
    pos: Option<(f32, f32)>,
    /// The zone currently wearing the `over` pose for this hover.
    over: Option<String>,
    /// Matching files zones the drag is inside (outer → inner): each fired
    /// its `.onFileDragEnter` on joining and won't again until it leaves.
    entered: Vec<String>,
    /// An `.onFileDragEnter` was queued since the last
    /// [`DesktopDnd::take_file_drag_signal`].
    signalled: bool,
}

impl DesktopDnd {
    /// winit `HoveredFile` — one call per file. Starts a hover on the first
    /// file; resolution waits for [`Self::file_hover_update`] so a
    /// multi-file burst is counted whole before anything dispatches.
    pub fn file_hover_enter(&mut self, path: &Path) {
        self.file_hover
            .get_or_insert_with(FileHover::default)
            .kinds
            .push(HoveredKind::from_path(path));
    }

    /// An OS file drag is hovering the window.
    pub fn is_file_hovering(&self) -> bool {
        self.file_hover.is_some()
    }

    /// The zone wearing the `over` pose for the OS file hover (tests,
    /// diagnostics).
    pub fn file_hover_zone(&self) -> Option<&str> {
        self.file_hover.as_ref().and_then(|h| h.over.as_deref())
    }

    /// Whether an `.onFileDragEnter` was dispatched since the last call —
    /// the app may be about to ask for a pick (the window tells the device
    /// host, which then offers its drop surface).
    pub fn take_file_drag_signal(&mut self) -> bool {
        self.file_hover
            .as_mut()
            .is_some_and(|h| std::mem::take(&mut h.signalled))
    }

    /// A host modal (the device overlay) covers the app: the hover keeps
    /// going but no app zone is under it — clear the `over` pose and the
    /// entries, so a zone fires again once the modal is gone and the drag
    /// re-enters it.
    pub fn file_hover_suspend(&mut self, tree: &mut Tree) {
        let Some(hover) = self.file_hover.as_mut() else {
            return;
        };
        hover.entered.clear();
        if let Some(zone) = hover.over.take() {
            self.clear_over(tree, &zone);
        }
    }

    /// winit `HoveredFileCancelled` / `DroppedFile` (and teardown): clear
    /// the `over` pose and forget the hover. A drop delivers nothing.
    pub fn file_hover_end(&mut self, tree: &mut Tree) {
        let Some(hover) = self.file_hover.take() else {
            return;
        };
        if let Some(zone) = hover.over {
            self.clear_over(tree, &zone);
        }
    }

    /// Re-resolve the hovered zone. `pos` (physical px, window space) is
    /// the freshest drag position if the window has one — `None` keeps the
    /// last position seen during this hover. Without a layout nothing is
    /// resolved (the previous zone holds until the next call).
    pub fn file_hover_update(
        &mut self,
        tree: &mut Tree,
        layout: Option<&LayoutPass>,
        pos: Option<(f64, f64)>,
    ) {
        let Some(hover) = self.file_hover.as_mut() else {
            return;
        };
        if let Some((x, y)) = pos {
            hover.pos = Some((x as f32, y as f32));
        }
        // An in-app drag owns the `over` label; OS file drags can't
        // coexist with one in practice, so simply stand aside.
        if self.is_active() {
            return;
        }
        let Some(layout) = layout else {
            return;
        };
        let hover = self.file_hover.as_ref().expect("checked above");
        let (next_over, next_entered) =
            self.resolve_file_zones(tree, layout, hover.pos, &hover.kinds);
        let items = hover.kinds.len();
        let prev_over = hover.over.clone();
        let prev_entered = hover.entered.clone();

        if next_over != prev_over {
            if let Some(prev) = prev_over.as_deref() {
                self.clear_over(tree, prev);
            }
            if let Some(next) = next_over.as_deref() {
                self.apply_pose(tree, next, LABEL_OVER);
            }
        }
        for zone in &next_entered {
            if !prev_entered.contains(zone) {
                self.dispatch_file_drag_enter(tree, zone, items);
            }
        }
        let hover = self.file_hover.as_mut().expect("checked above");
        hover.over = next_over;
        hover.entered = next_entered;
    }

    fn clear_over(&mut self, tree: &mut Tree, zone: &str) {
        if self.nodes.get(zone).and_then(|n| n.pose_label.as_deref()) == Some(LABEL_OVER) {
            self.clear_pose(tree, zone);
        }
    }

    /// `(innermost zone, every matching zone under the drag outer → inner)`.
    /// See the module header for the unknown-position fallback.
    fn resolve_file_zones(
        &self,
        tree: &Tree,
        layout: &LayoutPass,
        pos: Option<(f32, f32)>,
        kinds: &[HoveredKind],
    ) -> (Option<String>, Vec<String>) {
        // Enabled files zones that are laid out with a real area.
        let mut visible: Vec<(&String, &ZoneSpec)> = self
            .nodes
            .iter()
            .filter(|(_, n)| n.zone_enabled)
            .filter_map(|(id, n)| n.zone.as_ref().filter(|z| z.files).map(|z| (id, z)))
            .filter(|(id, _)| {
                layout
                    .item_by_id(id)
                    .is_some_and(|it| it.rect.w > 0.0 && it.rect.h > 0.0)
            })
            .collect();
        let Some((x, y)) = pos else {
            if let [(id, zone)] = visible.as_slice() {
                if accept_matches(zone.accept.as_deref(), kinds) {
                    return (Some((*id).clone()), vec![(*id).clone()]);
                }
            }
            return (None, Vec::new());
        };
        visible.retain(|(id, zone)| {
            accept_matches(zone.accept.as_deref(), kinds)
                && layout
                    .item_by_id(id)
                    .is_some_and(|it| it.hit_contains(x, y))
        });
        let mut hits: Vec<(usize, String)> = visible
            .into_iter()
            .map(|(id, _)| (depth_of(tree, id), id.clone()))
            .collect();
        hits.sort();
        let over = hits.last().map(|(_, id)| id.clone());
        (over, hits.into_iter().map(|(_, id)| id).collect())
    }

    /// `.onFileDragEnter` on `zone`, if wired: `{type, timestamp, items}`,
    /// or the author's named arguments in its place. Never names or paths.
    fn dispatch_file_drag_enter(&mut self, tree: &Tree, zone: &str, items: usize) {
        let Some(node) = tree.get(zone) else {
            return;
        };
        let Some((action, args)) =
            crate::layout::resolve_named_event_action(node, ON_FILE_DRAG_ENTER)
        else {
            return;
        };
        let payload = match args {
            Value::Object(m) if !m.is_empty() => Value::Object(m),
            _ => {
                let timestamp = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0);
                json!({ "type": "filedragenter", "timestamp": timestamp, "items": items })
            }
        };
        self.pending.push(DndDispatch {
            action: hypen_engine::action_routing::UI_ACTION.into(),
            payload: json!({ "node": zone, "fromNode": Value::Null, "action": action, "payload": payload }),
        });
        if let Some(h) = self.file_hover.as_mut() {
            h.signalled = true;
        }
    }
}

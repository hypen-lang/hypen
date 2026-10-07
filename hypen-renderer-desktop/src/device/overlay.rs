//! The in-window device overlay: how the renderer window presents the
//! [`OverlayHub`]'s surfaces (RFC 001 §2.6, §5).
//!
//! It is drawn by the renderer after every app item (the app's patch tree
//! cannot cover, restyle or hide it), takes input before the app does, and
//! is published to assistive tech next to the app's nodes:
//!
//! - **Modal surfaces** (consent dialog, camera capture panel, Bluetooth
//!   chooser) dim the window behind a scrim and take every pointer and key
//!   event while shown; app clicks and keys never reach the app meanwhile,
//!   and none of them can activate the surface either.
//! - **Indicators** (microphone recording, BLE scan) are pills stacked in
//!   the window's top-right corner with the origin, the activity, the
//!   elapsed time and a Stop button, for the whole activity.
//!
//! Input protection mirrors the web host: an activating control (Continue,
//! Capture, Record, Stop, a chooser row) is disabled for
//! [`super::ui::ARMING_DELAY`] after it appears or the window regains
//! focus, and only a press that *started* on the enabled control (or a
//! fresh, non-repeated Enter/Space on the focused control) activates it.
//! Nothing is focused on a positive control automatically: a modal opens
//! with focus on Cancel.
//!
//! Keyboard: Tab / Shift+Tab move between a modal's controls, Enter or
//! Space activates, Up / Down move through the chooser list, Escape cancels
//! (a consent dialog's Escape is abandonment, not a refusal). Without a
//! modal, F6 moves focus into the indicators (Tab cycles their Stop
//! buttons, Escape or F6 returns to the app). Screen readers see each
//! modal as a `Dialog` (modal) with its text, list and buttons, and each
//! indicator as a `Status` with a Stop button; AccessKit Click / Focus
//! actions work like the pointer and keyboard (and respect the arming
//! delay).
//!
//! Everything here is plain data: [`OverlayController::layout`] produces a
//! display list ([`OverlayLayout`]) the Vello painter draws, and the same
//! geometry drives hit-testing and accessibility bounds, so the model is
//! tested without a GPU or a window.

use std::hash::{Hash, Hasher};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use accesskit::{Action, Node, NodeId, Rect as AkRect, Role};

use super::ui::{
    CameraPhase, OverlayHub, PreviewFrame, Surface, SurfaceId, SurfaceState, UiAction,
};
use crate::layout::Rect;
use crate::style::Rgba;

/// A control inside a surface.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum Control {
    Continue,
    Cancel,
    Capture,
    Record,
    Stop,
    /// A chooser row (the device's opaque id).
    Device(String),
    /// An indicator's Stop.
    IndicatorStop,
}

#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ControlKey {
    pub surface: SurfaceId,
    pub control: Control,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ButtonStyle {
    Primary,
    Secondary,
    Danger,
    Row,
}

/// A laid-out control.
#[derive(Debug, Clone, PartialEq)]
pub struct ControlBox {
    pub key: ControlKey,
    pub rect: Rect,
    pub label: String,
    /// Accessible description (e.g. a chooser row's signal).
    pub description: Option<String>,
    /// Armed (input protection elapsed) — disabled controls ignore input.
    pub enabled: bool,
    pub style: ButtonStyle,
}

/// One drawing operation, in physical pixels.
#[derive(Debug, Clone, PartialEq)]
pub enum DrawOp {
    Fill {
        rect: Rect,
        color: Rgba,
        radius: f32,
    },
    Stroke {
        rect: Rect,
        color: Rgba,
        radius: f32,
        width: f32,
    },
    Text {
        x: f32,
        y: f32,
        text: String,
        size: f32,
        weight: u16,
        color: Rgba,
        wrap: Option<f32>,
    },
    /// A camera preview, letterboxed into `rect`.
    Image { rect: Rect, frame: PreviewFrame },
}

/// Something assistive tech should hear besides the controls.
#[derive(Debug, Clone, PartialEq)]
pub struct A11yText {
    pub surface: SurfaceId,
    pub role: Role,
    pub text: String,
    pub rect: Rect,
}

/// A laid-out surface container.
#[derive(Debug, Clone, PartialEq)]
pub struct A11yGroup {
    pub surface: SurfaceId,
    pub role: Role,
    pub label: String,
    pub rect: Rect,
    pub modal: bool,
}

/// The overlay's display list and geometry for one frame.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct OverlayLayout {
    pub ops: Vec<DrawOp>,
    pub controls: Vec<ControlBox>,
    /// The modal panel (the scrim covers the whole viewport).
    pub modal: Option<Rect>,
    /// Indicator pills.
    pub indicators: Vec<Rect>,
    /// The chooser list box (wheel target).
    pub list: Option<Rect>,
    /// The file drop surface's drop area (OS file drops land here).
    pub drop_area: Option<Rect>,
    pub groups: Vec<A11yGroup>,
    pub texts: Vec<A11yText>,
}

/// Keys the overlay understands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OverlayKey {
    Tab { shift: bool },
    Enter,
    Space,
    Escape,
    Up,
    Down,
    F6,
    Other,
}

const INK: Rgba = Rgba(0x11, 0x11, 0x14, 0xff);
const MUTED: Rgba = Rgba(0x55, 0x58, 0x60, 0xff);
const PANEL: Rgba = Rgba(0xff, 0xff, 0xff, 0xff);
const SCRIM: Rgba = Rgba(0x00, 0x00, 0x00, 0x73);
const PRIMARY: Rgba = Rgba(0x25, 0x63, 0xeb, 0xff);
const SECONDARY: Rgba = Rgba(0xea, 0xeb, 0xee, 0xff);
const DANGER: Rgba = Rgba(0xdc, 0x26, 0x26, 0xff);
const PILL: Rgba = Rgba(0x18, 0x18, 0x1b, 0xf0);
const WHITE: Rgba = Rgba(0xff, 0xff, 0xff, 0xff);
const FOCUS: Rgba = Rgba(0x25, 0x63, 0xeb, 0xff);
const ROW_HOVER: Rgba = Rgba(0xf1, 0xf5, 0xff, 0xff);
const DROP_HOT: Rgba = Rgba(0xe0, 0xe9, 0xff, 0xff);

/// Chooser rows visible at once.
const LIST_ROWS: usize = 6;

fn fade(c: Rgba, alpha: u8) -> Rgba {
    Rgba(c.0, c.1, c.2, alpha)
}

/// `mm:ss` (or `h:mm:ss`).
pub fn clock(ms: u128) -> String {
    let s = (ms / 1000) as u64;
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s / 60) % 60, s % 60)
    } else {
        format!("{}:{:02}", s / 60, s % 60)
    }
}

/// A coarse, stable signal label for an RSSI.
pub fn signal_label(rssi: i16) -> &'static str {
    match rssi {
        r if r >= -60 => "strong signal",
        r if r >= -75 => "medium signal",
        _ => "weak signal",
    }
}

fn node_id(surface: SurfaceId, what: &str) -> NodeId {
    crate::accessibility::ak_node_id(&format!("__hypen_device__/{surface}/{what}"))
}

fn control_node_id(key: &ControlKey) -> NodeId {
    let what = match &key.control {
        Control::Device(id) => format!("device:{id}"),
        other => format!("{other:?}"),
    };
    node_id(key.surface, &what)
}

fn ak_rect(r: Rect) -> AkRect {
    AkRect {
        x0: r.x as f64,
        y0: r.y as f64,
        x1: (r.x + r.w) as f64,
        y1: (r.y + r.h) as f64,
    }
}

fn offset(r: Rect, dy: f32) -> Rect {
    Rect {
        x: r.x,
        y: r.y + dy,
        w: r.w,
        h: r.h,
    }
}

fn action_for(control: &Control) -> UiAction {
    match control {
        Control::Continue => UiAction::Continue,
        Control::Cancel => UiAction::Cancel,
        Control::Capture => UiAction::Capture,
        Control::Record => UiAction::Record,
        Control::Stop | Control::IndicatorStop => UiAction::Stop,
        Control::Device(id) => UiAction::Choose(id.clone()),
    }
}

/// Positive controls are input-protected; Cancel never is (cancelling is
/// always safe).
fn protected(control: &Control) -> bool {
    !matches!(control, Control::Cancel)
}

/// Text measurement: `(text, size, wrap width, weight) → (w, h)`.
pub type Measure<'a> = dyn FnMut(&str, f32, Option<f32>, u16) -> (f32, f32) + 'a;

/// The window's view of the hub: input state + the last layout.
pub struct OverlayController {
    hub: Arc<OverlayHub>,
    generation: u64,
    surfaces: Vec<SurfaceState>,
    focus: Option<ControlKey>,
    /// Keyboard focus is inside the overlay (a modal, or F6 into the
    /// indicators).
    keyboard: bool,
    pressed: Option<ControlKey>,
    hovered: Option<ControlKey>,
    list_offset: usize,
    layout: Option<Arc<OverlayLayout>>,
    /// The OS file drag was last seen over the drop area.
    drag_inside: bool,
    /// The OS file drag ENTERED the drop area while it was armed (and
    /// hasn't left since): only then does a release there count.
    drag_entered: bool,
}

impl std::fmt::Debug for OverlayController {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OverlayController")
            .field("surfaces", &self.surfaces.len())
            .field("focus", &self.focus)
            .finish()
    }
}

impl OverlayController {
    pub fn new(hub: Arc<OverlayHub>) -> Self {
        OverlayController {
            hub,
            generation: u64::MAX,
            surfaces: Vec::new(),
            focus: None,
            keyboard: false,
            pressed: None,
            hovered: None,
            list_offset: 0,
            layout: None,
            drag_inside: false,
            drag_entered: false,
        }
    }

    pub fn hub(&self) -> &Arc<OverlayHub> {
        &self.hub
    }

    /// Pull the hub's state. Returns whether anything changed.
    pub fn sync(&mut self) -> bool {
        let generation = self.hub.generation();
        if generation == self.generation {
            return false;
        }
        let (generation, surfaces) = self.hub.snapshot();
        let had_modal = self.modal().map(|s| s.id);
        self.generation = generation;
        self.surfaces = surfaces;
        let modal = self.modal().map(|s| s.id);
        if modal != had_modal {
            self.list_offset = 0;
            self.pressed = None;
            self.drag_inside = false;
            self.drag_entered = false;
            // A new modal opens with focus on its (unprotected) Cancel.
            self.focus = modal.map(|surface| ControlKey {
                surface,
                control: Control::Cancel,
            });
            self.keyboard = modal.is_some();
        }
        // Focus / press on a control that no longer exists is dropped.
        let alive = |k: &ControlKey| self.surfaces.iter().any(|s| s.id == k.surface);
        if self.focus.as_ref().is_some_and(|k| !alive(k)) {
            self.focus = None;
            self.keyboard = self.modal().is_some();
        }
        if self.pressed.as_ref().is_some_and(|k| !alive(k)) {
            self.pressed = None;
        }
        if !self
            .surfaces
            .iter()
            .any(|s| matches!(s.surface, Surface::Indicator(_)))
            && self.modal().is_none()
        {
            self.keyboard = false;
        }
        true
    }

    /// Nothing to show.
    pub fn is_empty(&self) -> bool {
        self.surfaces.is_empty()
    }

    pub fn modal(&self) -> Option<&SurfaceState> {
        self.surfaces.iter().rev().find(|s| s.surface.is_modal())
    }

    pub fn is_modal(&self) -> bool {
        self.modal().is_some()
    }

    /// Keyboard input goes to the overlay, not the app.
    pub fn has_keyboard(&self) -> bool {
        self.is_modal() || (self.keyboard && self.focus.is_some())
    }

    /// Content that changes with time alone (clock, arming): the window
    /// should keep repainting while this is true.
    pub fn animating(&self, now: Instant) -> bool {
        self.surfaces.iter().any(|s| {
            !s.is_armed(now)
                || matches!(s.surface, Surface::Indicator(_))
                || matches!(s.phase, CameraPhase::Recording { .. })
        })
    }

    pub fn focus(&self) -> Option<&ControlKey> {
        self.focus.as_ref()
    }

    pub fn last_layout(&self) -> Option<&Arc<OverlayLayout>> {
        self.layout.as_ref()
    }

    /// A change fingerprint for the accessibility publisher.
    pub fn fingerprint(&self, now: Instant) -> u64 {
        let mut h = std::collections::hash_map::DefaultHasher::new();
        self.generation.hash(&mut h);
        self.focus.hash(&mut h);
        self.keyboard.hash(&mut h);
        self.drag_entered.hash(&mut h);
        // Armed state flips with time alone.
        for s in &self.surfaces {
            s.is_armed(now).hash(&mut h);
        }
        if let Some(l) = &self.layout {
            for c in &l.controls {
                (
                    c.rect.x as i32,
                    c.rect.y as i32,
                    c.rect.w as i32,
                    c.rect.h as i32,
                )
                    .hash(&mut h);
            }
        }
        h.finish()
    }

    // ---- layout -------------------------------------------------------------

    /// Lay the overlay out for a `viewport` (physical px) at `scale`.
    /// `None` when nothing is shown.
    pub fn layout(
        &mut self,
        viewport: (u32, u32),
        scale: f32,
        now: Instant,
        measure: &mut Measure<'_>,
    ) -> Option<Arc<OverlayLayout>> {
        if self.surfaces.is_empty() {
            self.layout = None;
            return None;
        }
        let mut out = OverlayLayout::default();
        let (vw, vh) = (viewport.0 as f32, viewport.1 as f32);
        let s = scale.max(0.5);

        // Indicators: pills in the top-right corner.
        let mut y = 8.0 * s;
        for st in self.surfaces.iter().filter(|st| !st.surface.is_modal()) {
            let Surface::Indicator(spec) = &st.surface else {
                continue;
            };
            let elapsed = clock(now.saturating_duration_since(st.shown_at).as_millis());
            let label = format!("{} · {} · {}", spec.activity, spec.origin, elapsed);
            let max_w = (vw - 16.0 * s).max(120.0 * s);
            let stop_label = "Stop";
            let (bw, _) = measure(stop_label, 13.0 * s, None, 600);
            let button_w = bw + 24.0 * s;
            let text_max = (max_w - button_w - 40.0 * s).max(40.0 * s);
            let (tw, th) = measure(&label, 13.0 * s, Some(text_max), 500);
            let h = (th + 16.0 * s).max(34.0 * s);
            let w = (tw + button_w + 40.0 * s).min(max_w);
            let pill = Rect {
                x: (vw - 8.0 * s - w).max(8.0 * s),
                y,
                w,
                h,
            };
            out.ops.push(DrawOp::Fill {
                rect: pill,
                color: PILL,
                radius: h / 2.0,
            });
            let dot = 8.0 * s;
            out.ops.push(DrawOp::Fill {
                rect: Rect {
                    x: pill.x + 12.0 * s,
                    y: pill.y + (h - dot) / 2.0,
                    w: dot,
                    h: dot,
                },
                color: DANGER,
                radius: dot / 2.0,
            });
            out.ops.push(DrawOp::Text {
                x: pill.x + 28.0 * s,
                y: pill.y + (h - th) / 2.0,
                text: label.clone(),
                size: 13.0 * s,
                weight: 500,
                color: WHITE,
                wrap: Some(text_max),
            });
            let bh = 24.0 * s;
            let button = Rect {
                x: pill.x + w - button_w - 6.0 * s,
                y: pill.y + (h - bh) / 2.0,
                w: button_w,
                h: bh,
            };
            let key = ControlKey {
                surface: st.id,
                control: Control::IndicatorStop,
            };
            self.push_button(
                &mut out,
                key,
                button,
                stop_label,
                bw,
                None,
                st.is_armed(now),
                ButtonStyle::Danger,
                s,
            );
            out.indicators.push(pill);
            out.groups.push(A11yGroup {
                surface: st.id,
                role: Role::Status,
                label,
                rect: pill,
                modal: false,
            });
            y += h + 6.0 * s;
        }

        // The modal panel.
        if let Some(st) = self.modal().cloned() {
            out.ops.push(DrawOp::Fill {
                rect: Rect {
                    x: 0.0,
                    y: 0.0,
                    w: vw,
                    h: vh,
                },
                color: SCRIM,
                radius: 0.0,
            });
            let pw = (440.0 * s).min(vw - 32.0 * s).max(200.0 * s);
            let px = ((vw - pw) / 2.0).max(0.0);
            let pad = 20.0 * s;
            let cw = pw - 2.0 * pad;
            let cx = px + pad;
            // Build with y relative to the panel top, then shift.
            let mut panel = OverlayLayout::default();
            let mut cy = pad;
            let mut text = |panel: &mut OverlayLayout,
                            t: String,
                            size: f32,
                            weight: u16,
                            color: Rgba,
                            cy: &mut f32,
                            role: Role| {
                let (_, h) = measure(&t, size, Some(cw), weight);
                panel.ops.push(DrawOp::Text {
                    x: cx,
                    y: *cy,
                    text: t.clone(),
                    size,
                    weight,
                    color,
                    wrap: Some(cw),
                });
                panel.texts.push(A11yText {
                    surface: st.id,
                    role,
                    text: t,
                    rect: Rect {
                        x: cx,
                        y: *cy,
                        w: cw,
                        h,
                    },
                });
                *cy += h;
            };
            text(
                &mut panel,
                "DEVICE ACCESS".into(),
                11.0 * s,
                700,
                MUTED,
                &mut cy,
                Role::Label,
            );
            cy += 6.0 * s;
            let (title, details): (String, Vec<String>) = match &st.surface {
                Surface::Consent(p) => (
                    format!("{} wants to {}.", p.origin, p.operation),
                    p.details.clone(),
                ),
                Surface::FileDrop(p) => (
                    format!("{} wants to {}.", p.origin, p.operation),
                    p.details.clone(),
                ),
                Surface::Camera(p) => (
                    format!(
                        "{} wants to {}.",
                        p.origin,
                        if p.video {
                            "record a video with your camera"
                        } else {
                            "take a photo with your camera"
                        }
                    ),
                    Vec::new(),
                ),
                Surface::Chooser(p) => (
                    format!("{} wants to connect to a Bluetooth device.", p.origin),
                    p.filters.clone(),
                ),
                Surface::Indicator(_) => (String::new(), Vec::new()),
            };
            text(
                &mut panel,
                title.clone(),
                16.0 * s,
                600,
                INK,
                &mut cy,
                Role::Label,
            );
            for d in details {
                cy += 6.0 * s;
                text(&mut panel, d, 13.0 * s, 400, MUTED, &mut cy, Role::Label);
            }
            cy += 16.0 * s;

            let armed = st.is_armed(now);
            let mut buttons: Vec<(Control, &str, ButtonStyle)> = Vec::new();
            match &st.surface {
                Surface::Consent(_) => {
                    buttons.push((Control::Cancel, "Cancel", ButtonStyle::Secondary));
                    buttons.push((Control::Continue, "Continue", ButtonStyle::Primary));
                }
                Surface::FileDrop(p) => {
                    // The drop area: disarmed (input protection) → armed →
                    // hot (the drag entered it armed; a release counts).
                    let area = Rect {
                        x: cx,
                        y: cy,
                        w: cw,
                        h: 96.0 * s,
                    };
                    let hot = armed && self.drag_entered;
                    if hot {
                        panel.ops.push(DrawOp::Fill {
                            rect: area,
                            color: DROP_HOT,
                            radius: 8.0 * s,
                        });
                    }
                    panel.ops.push(DrawOp::Stroke {
                        rect: area,
                        color: if armed { PRIMARY } else { fade(MUTED, 0x70) },
                        radius: 8.0 * s,
                        width: if hot { 2.0 * s } else { 1.5 * s },
                    });
                    let label = if p.multiple {
                        "Drop files here, or Continue to browse"
                    } else {
                        "Drop a file here, or Continue to browse"
                    };
                    let (tw, th) = measure(label, 14.0 * s, Some(cw - 24.0 * s), 500);
                    panel.ops.push(DrawOp::Text {
                        x: cx + ((cw - tw) / 2.0).max(12.0 * s),
                        y: cy + (area.h - th) / 2.0,
                        text: label.into(),
                        size: 14.0 * s,
                        weight: 500,
                        color: if armed { INK } else { fade(MUTED, 0x70) },
                        wrap: Some(cw - 24.0 * s),
                    });
                    panel.texts.push(A11yText {
                        surface: st.id,
                        role: Role::Label,
                        text: label.into(),
                        rect: area,
                    });
                    panel.drop_area = Some(area);
                    cy += area.h + 16.0 * s;
                    buttons.push((Control::Cancel, "Cancel", ButtonStyle::Secondary));
                    buttons.push((Control::Continue, "Continue", ButtonStyle::Primary));
                }
                Surface::Camera(p) => {
                    let max_h = (vh * 0.5).max(120.0 * s);
                    let aspect = st
                        .preview
                        .as_ref()
                        .map(|f| f.height as f32 / f.width.max(1) as f32)
                        .unwrap_or(0.75);
                    let ph = (cw * aspect).min(max_h);
                    let preview = Rect {
                        x: cx,
                        y: cy,
                        w: cw,
                        h: ph,
                    };
                    panel.ops.push(DrawOp::Fill {
                        rect: preview,
                        color: Rgba(0, 0, 0, 0xff),
                        radius: 6.0 * s,
                    });
                    if let Some(frame) = &st.preview {
                        panel.ops.push(DrawOp::Image {
                            rect: preview,
                            frame: frame.clone(),
                        });
                    }
                    panel.texts.push(A11yText {
                        surface: st.id,
                        role: Role::Image,
                        text: "Camera preview".into(),
                        rect: preview,
                    });
                    cy += ph + 10.0 * s;
                    let (status, color) = match &st.phase {
                        CameraPhase::Starting => ("Starting the camera…".to_string(), MUTED),
                        CameraPhase::Live => (
                            if p.video {
                                match p.max_duration_ms {
                                    Some(ms) => {
                                        format!("Ready to record (up to {})", clock(u128::from(ms)))
                                    }
                                    None => "Ready to record".to_string(),
                                }
                            } else {
                                "Ready".to_string()
                            },
                            MUTED,
                        ),
                        CameraPhase::Recording { since } => (
                            format!(
                                "● Recording {}",
                                clock(now.saturating_duration_since(*since).as_millis())
                            ),
                            DANGER,
                        ),
                        CameraPhase::Busy(t) => (t.clone(), MUTED),
                    };
                    text(
                        &mut panel,
                        status,
                        13.0 * s,
                        600,
                        color,
                        &mut cy,
                        Role::Status,
                    );
                    cy += 16.0 * s;
                    buttons.push((Control::Cancel, "Cancel", ButtonStyle::Secondary));
                    match (&st.phase, p.video) {
                        (CameraPhase::Live, false) => {
                            buttons.push((Control::Capture, "Capture", ButtonStyle::Primary))
                        }
                        (CameraPhase::Live, true) => {
                            buttons.push((Control::Record, "Record", ButtonStyle::Danger))
                        }
                        (CameraPhase::Recording { .. }, _) => {
                            buttons.push((Control::Stop, "Stop", ButtonStyle::Danger))
                        }
                        _ => {}
                    }
                }
                Surface::Chooser(_) => {
                    let row_h = 40.0 * s;
                    let rows = st.devices.len().clamp(1, LIST_ROWS);
                    let list = Rect {
                        x: cx,
                        y: cy,
                        w: cw,
                        h: row_h * rows as f32,
                    };
                    panel.ops.push(DrawOp::Stroke {
                        rect: list,
                        color: SECONDARY,
                        radius: 6.0 * s,
                        width: 1.0 * s,
                    });
                    if st.devices.is_empty() {
                        panel.ops.push(DrawOp::Text {
                            x: cx + 12.0 * s,
                            y: cy + (row_h - 14.0 * s) / 2.0,
                            text: "Searching for devices…".into(),
                            size: 13.0 * s,
                            weight: 400,
                            color: MUTED,
                            wrap: None,
                        });
                        panel.texts.push(A11yText {
                            surface: st.id,
                            role: Role::Status,
                            text: "Searching for devices…".into(),
                            rect: list,
                        });
                    }
                    let offset_rows = self
                        .list_offset
                        .min(st.devices.len().saturating_sub(LIST_ROWS));
                    for (i, d) in st
                        .devices
                        .iter()
                        .enumerate()
                        .skip(offset_rows)
                        .take(LIST_ROWS)
                    {
                        let row = Rect {
                            x: cx,
                            y: cy + row_h * (i - offset_rows) as f32,
                            w: cw,
                            h: row_h,
                        };
                        let name = d.name.clone().unwrap_or_else(|| "Unknown device".into());
                        let key = ControlKey {
                            surface: st.id,
                            control: Control::Device(d.id.clone()),
                        };
                        self.push_button(
                            &mut panel,
                            key,
                            row,
                            &name,
                            0.0,
                            Some(signal_label(d.rssi).to_string()),
                            armed,
                            ButtonStyle::Row,
                            s,
                        );
                    }
                    panel.list = Some(list);
                    cy += list.h + 16.0 * s;
                    buttons.push((Control::Cancel, "Cancel", ButtonStyle::Secondary));
                }
                Surface::Indicator(_) => {}
            }

            // Buttons, right-aligned.
            let bh = 36.0 * s;
            let mut bx = cx + cw;
            for (control, label, style) in buttons.iter().rev() {
                let (tw, _) = measure(label, 14.0 * s, None, 600);
                let w = tw + 32.0 * s;
                bx -= w;
                let rect = Rect {
                    x: bx,
                    y: cy,
                    w,
                    h: bh,
                };
                let key = ControlKey {
                    surface: st.id,
                    control: control.clone(),
                };
                let enabled = armed || !protected(control);
                self.push_button(&mut panel, key, rect, label, tw, None, enabled, *style, s);
                bx -= 8.0 * s;
            }
            cy += bh + pad;

            let ph = cy;
            let py = ((vh - ph) / 2.0).max(8.0 * s);
            let panel_rect = Rect {
                x: px,
                y: py,
                w: pw,
                h: ph,
            };
            out.ops.push(DrawOp::Fill {
                rect: panel_rect,
                color: PANEL,
                radius: 12.0 * s,
            });
            for op in panel.ops {
                out.ops.push(match op {
                    DrawOp::Fill {
                        rect,
                        color,
                        radius,
                    } => DrawOp::Fill {
                        rect: offset(rect, py),
                        color,
                        radius,
                    },
                    DrawOp::Stroke {
                        rect,
                        color,
                        radius,
                        width,
                    } => DrawOp::Stroke {
                        rect: offset(rect, py),
                        color,
                        radius,
                        width,
                    },
                    DrawOp::Text {
                        x,
                        y,
                        text,
                        size,
                        weight,
                        color,
                        wrap,
                    } => DrawOp::Text {
                        x,
                        y: y + py,
                        text,
                        size,
                        weight,
                        color,
                        wrap,
                    },
                    DrawOp::Image { rect, frame } => DrawOp::Image {
                        rect: offset(rect, py),
                        frame,
                    },
                });
            }
            for mut c in panel.controls {
                c.rect = offset(c.rect, py);
                out.controls.push(c);
            }
            for mut t in panel.texts {
                t.rect = offset(t.rect, py);
                out.texts.push(t);
            }
            out.list = panel.list.map(|l| offset(l, py));
            out.drop_area = panel.drop_area.map(|r| offset(r, py));
            out.modal = Some(panel_rect);
            out.groups.push(A11yGroup {
                surface: st.id,
                role: Role::Dialog,
                label: title,
                rect: panel_rect,
                modal: true,
            });
        }

        // Focus ring last, on top.
        if self.has_keyboard() {
            if let Some(c) = self
                .focus
                .as_ref()
                .and_then(|f| out.controls.iter().find(|c| &c.key == f))
            {
                let r = c.rect;
                let g = 2.0 * s;
                out.ops.push(DrawOp::Stroke {
                    rect: Rect {
                        x: r.x - g,
                        y: r.y - g,
                        w: r.w + 2.0 * g,
                        h: r.h + 2.0 * g,
                    },
                    color: FOCUS,
                    radius: 8.0 * s,
                    width: 2.0 * s,
                });
            }
        }
        let layout = Arc::new(out);
        self.layout = Some(Arc::clone(&layout));
        Some(layout)
    }

    #[allow(clippy::too_many_arguments)]
    fn push_button(
        &self,
        out: &mut OverlayLayout,
        key: ControlKey,
        rect: Rect,
        label: &str,
        label_w: f32,
        description: Option<String>,
        enabled: bool,
        style: ButtonStyle,
        s: f32,
    ) {
        let hovered = self.hovered.as_ref() == Some(&key) || self.pressed.as_ref() == Some(&key);
        let (bg, fg) = match style {
            ButtonStyle::Primary => (PRIMARY, WHITE),
            ButtonStyle::Secondary => (SECONDARY, INK),
            ButtonStyle::Danger => (DANGER, WHITE),
            ButtonStyle::Row => (if hovered { ROW_HOVER } else { PANEL }, INK),
        };
        let alpha = if enabled { 0xff } else { 0x70 };
        out.ops.push(DrawOp::Fill {
            rect,
            color: fade(
                bg,
                if style == ButtonStyle::Row {
                    bg.3
                } else {
                    alpha
                },
            ),
            radius: if style == ButtonStyle::Row {
                0.0
            } else {
                8.0 * s
            },
        });
        let size = if style == ButtonStyle::Danger && rect.h < 30.0 * s {
            13.0
        } else {
            14.0
        } * s;
        let weight = if style == ButtonStyle::Row { 500 } else { 600 };
        let text_y = rect.y + (rect.h - size * 1.2) / 2.0;
        let x = if style == ButtonStyle::Row {
            rect.x + 12.0 * s
        } else {
            rect.x + ((rect.w - label_w) / 2.0).max(0.0)
        };
        out.ops.push(DrawOp::Text {
            x,
            y: text_y,
            text: label.to_string(),
            size,
            weight,
            color: fade(fg, alpha),
            wrap: None,
        });
        if let (ButtonStyle::Row, Some(d)) = (style, &description) {
            out.ops.push(DrawOp::Text {
                x: rect.x + rect.w - 120.0 * s,
                y: rect.y + (rect.h - 12.0 * s * 1.2) / 2.0,
                text: d.clone(),
                size: 12.0 * s,
                weight: 400,
                color: fade(MUTED, alpha),
                wrap: None,
            });
        }
        out.controls.push(ControlBox {
            key,
            rect,
            label: label.to_string(),
            description,
            enabled,
            style,
        });
    }

    // ---- input ----------------------------------------------------------------

    fn control_at(&self, x: f32, y: f32) -> Option<&ControlBox> {
        self.layout
            .as_ref()?
            .controls
            .iter()
            .find(|c| c.rect.contains(x, y))
    }

    /// Whether a point is covered by the overlay (modal: everywhere).
    pub fn covers(&self, x: f32, y: f32) -> bool {
        if self.is_modal() {
            return true;
        }
        self.layout
            .as_ref()
            .is_some_and(|l| l.indicators.iter().any(|r| r.contains(x, y)))
    }

    fn surface(&self, id: SurfaceId) -> Option<&SurfaceState> {
        self.surfaces.iter().find(|s| s.id == id)
    }

    fn enabled(&self, key: &ControlKey, now: Instant) -> bool {
        self.surface(key.surface)
            .is_some_and(|s| !protected(&key.control) || s.is_armed(now))
    }

    fn activate(&mut self, key: &ControlKey, now: Instant) -> bool {
        if !self.enabled(key, now) {
            return false;
        }
        if self.surface(key.surface).is_none() {
            return false;
        }
        self.hub.activate(key.surface, action_for(&key.control));
        true
    }

    /// Pointer moved; returns whether the overlay covers the point (the
    /// app must not see hover there).
    pub fn pointer_move(&mut self, x: f32, y: f32) -> bool {
        let hovered = self.control_at(x, y).map(|c| c.key.clone());
        self.hovered = hovered;
        self.covers(x, y)
    }

    /// Primary button pressed at `(x, y)`; `true` = consumed.
    pub fn pointer_down(&mut self, x: f32, y: f32, now: Instant) -> bool {
        if !self.covers(x, y) {
            return false;
        }
        // Only a press that starts on an enabled control can activate it.
        self.pressed = self
            .control_at(x, y)
            .map(|c| c.key.clone())
            .filter(|k| self.enabled(k, now));
        true
    }

    /// Primary button released; `true` = consumed.
    pub fn pointer_up(&mut self, x: f32, y: f32, now: Instant) -> bool {
        let pressed = self.pressed.take();
        let covered = self.covers(x, y);
        if let Some(key) = pressed {
            if self.control_at(x, y).map(|c| &c.key) == Some(&key) {
                self.activate(&key, now);
            }
            return true;
        }
        covered
    }

    /// Wheel over the chooser list scrolls it; any wheel over a modal is
    /// consumed.
    pub fn wheel(&mut self, x: f32, y: f32, dy: f32) -> bool {
        if !self.covers(x, y) {
            return false;
        }
        if self
            .layout
            .as_ref()
            .and_then(|l| l.list)
            .is_some_and(|l| l.contains(x, y))
        {
            let n = self.modal().map(|s| s.devices.len()).unwrap_or(0);
            let max = n.saturating_sub(LIST_ROWS);
            if dy > 0.0 {
                self.list_offset = (self.list_offset + 1).min(max);
            } else if dy < 0.0 {
                self.list_offset = self.list_offset.saturating_sub(1);
            }
        }
        true
    }

    // ---- OS file drags (the file drop surface) ---------------------------------

    /// The armed file drop surface's drop area, if one is up and laid out.
    fn drop_target(&self) -> Option<(SurfaceId, Rect)> {
        let m = self.modal()?;
        if !matches!(m.surface, Surface::FileDrop(_)) {
            return None;
        }
        Some((m.id, self.layout.as_ref()?.drop_area?))
    }

    /// An OS file drag is at `pos` (physical px; `None` = unknown). Tracks
    /// whether it ENTERED the drop area while armed, like the web host's
    /// drop zone: a drag already over the area when the surface popped up
    /// (or arrived during input protection) must leave and come back.
    /// Returns whether the drop area's look changed.
    pub fn file_drag_move(&mut self, pos: Option<(f32, f32)>, now: Instant) -> bool {
        let before = self.drag_entered;
        let Some((id, area)) = self.drop_target() else {
            self.drag_inside = false;
            self.drag_entered = false;
            return before;
        };
        let armed = self.surface(id).is_some_and(|s| s.is_armed(now));
        let inside = pos.is_some_and(|(x, y)| area.contains(x, y));
        if !inside || !armed {
            // Leaving, or input protection restarted (focus regained):
            // the drag must enter the armed area afresh.
            self.drag_entered = false;
        } else if !self.drag_inside && armed {
            self.drag_entered = true;
        }
        self.drag_inside = inside;
        before != self.drag_entered
    }

    /// The OS file drag left the window (or was cancelled).
    pub fn file_drag_left(&mut self) -> bool {
        let before = self.drag_entered;
        self.drag_inside = false;
        self.drag_entered = false;
        before
    }

    /// Files were released at `pos`. They count only on the file drop
    /// surface's drop area, armed, entered while armed (an earlier
    /// [`Self::file_drag_move`] — the release itself is never the entry) —
    /// then the driver gets them as [`UiAction::Dropped`]. Returns whether
    /// they were taken; anything else is ignored (the surface stays up).
    pub fn file_drop(&mut self, paths: Vec<PathBuf>, pos: Option<(f32, f32)>, now: Instant) -> bool {
        let taken = match self.drop_target() {
            Some((id, area)) => {
                let armed = self.surface(id).is_some_and(|s| s.is_armed(now));
                let over = pos.is_some_and(|(x, y)| area.contains(x, y));
                if armed && over && self.drag_entered && !paths.is_empty() {
                    self.hub.activate(id, UiAction::Dropped(paths));
                    true
                } else {
                    false
                }
            }
            None => false,
        };
        self.drag_inside = false;
        self.drag_entered = false;
        taken
    }

    fn keyboard_controls(&self) -> Vec<ControlKey> {
        let Some(l) = &self.layout else {
            return Vec::new();
        };
        match self.modal() {
            Some(m) => l
                .controls
                .iter()
                .filter(|c| c.key.surface == m.id)
                .map(|c| c.key.clone())
                .collect(),
            None => l
                .controls
                .iter()
                .filter(|c| c.key.control == Control::IndicatorStop)
                .map(|c| c.key.clone())
                .collect(),
        }
    }

    fn move_focus(&mut self, step: isize) {
        let keys = self.keyboard_controls();
        if keys.is_empty() {
            return;
        }
        let at = self
            .focus
            .as_ref()
            .and_then(|f| keys.iter().position(|k| k == f));
        let n = keys.len() as isize;
        let next = match at {
            Some(i) => (i as isize + step).rem_euclid(n),
            None => 0,
        } as usize;
        self.focus = Some(keys[next].clone());
        self.scroll_focus_into_view();
    }

    fn scroll_focus_into_view(&mut self) {
        let Some(Control::Device(id)) = self.focus.as_ref().map(|f| f.control.clone()) else {
            return;
        };
        let Some(i) = self
            .modal()
            .and_then(|m| m.devices.iter().position(|d| d.id == id))
        else {
            return;
        };
        if i < self.list_offset {
            self.list_offset = i;
        } else if i >= self.list_offset + LIST_ROWS {
            self.list_offset = i + 1 - LIST_ROWS;
        }
    }

    /// A key; `true` = consumed (the app must not see it).
    pub fn key(&mut self, key: OverlayKey, pressed: bool, repeat: bool, now: Instant) -> bool {
        let modal = self.is_modal();
        if !modal {
            let has_indicators = self
                .surfaces
                .iter()
                .any(|s| matches!(s.surface, Surface::Indicator(_)));
            if !self.keyboard {
                if key == OverlayKey::F6 && pressed && has_indicators {
                    self.keyboard = true;
                    self.focus = None;
                    self.move_focus(1);
                    return true;
                }
                return false;
            }
            if !has_indicators {
                self.keyboard = false;
                return false;
            }
        }
        if !pressed {
            return modal || self.keyboard;
        }
        match key {
            OverlayKey::Tab { shift } => self.move_focus(if shift { -1 } else { 1 }),
            OverlayKey::Up | OverlayKey::Down => {
                let devices: Vec<String> = self
                    .modal()
                    .map(|m| m.devices.iter().map(|d| d.id.clone()).collect())
                    .unwrap_or_default();
                if let Some(m) = self.modal().map(|m| m.id) {
                    if !devices.is_empty() {
                        let cur = match self.focus.as_ref().map(|f| &f.control) {
                            Some(Control::Device(id)) => devices.iter().position(|d| d == id),
                            _ => None,
                        };
                        let next = match (cur, key) {
                            (None, _) => 0,
                            (Some(i), OverlayKey::Down) => (i + 1).min(devices.len() - 1),
                            (Some(i), _) => i.saturating_sub(1),
                        };
                        self.focus = Some(ControlKey {
                            surface: m,
                            control: Control::Device(devices[next].clone()),
                        });
                        self.scroll_focus_into_view();
                    }
                }
            }
            OverlayKey::Enter | OverlayKey::Space => {
                // A held key's auto-repeat is not a new activation.
                if !repeat {
                    if let Some(f) = self.focus.clone() {
                        self.activate(&f, now);
                    }
                }
            }
            OverlayKey::Escape => {
                if let Some(m) = self.modal() {
                    let action = match m.surface {
                        Surface::Consent(_) | Surface::FileDrop(_) => UiAction::Dismiss,
                        _ => UiAction::Cancel,
                    };
                    let id = m.id;
                    self.hub.activate(id, action);
                } else {
                    self.keyboard = false;
                    self.focus = None;
                }
            }
            OverlayKey::F6 if !modal => {
                self.keyboard = false;
                self.focus = None;
            }
            _ => {}
        }
        true
    }

    // ---- accessibility ----------------------------------------------------------

    /// AccessKit nodes for the overlay (children of the window root) and
    /// the node that should have focus, if the overlay has the keyboard.
    pub fn a11y_nodes(&self) -> (Vec<(NodeId, Node)>, Vec<NodeId>, Option<NodeId>) {
        let Some(l) = &self.layout else {
            return (Vec::new(), Vec::new(), None);
        };
        let mut nodes = Vec::new();
        let mut roots = Vec::new();
        for g in &l.groups {
            let gid = node_id(g.surface, "group");
            let mut group = Node::new(g.role);
            group.set_label(g.label.clone());
            group.set_bounds(ak_rect(g.rect));
            if g.modal {
                group.set_modal();
            }
            let mut children = Vec::new();
            for (i, t) in l
                .texts
                .iter()
                .filter(|t| t.surface == g.surface)
                .enumerate()
            {
                let tid = node_id(g.surface, &format!("text:{i}"));
                let mut n = Node::new(t.role);
                n.set_label(t.text.clone());
                n.set_bounds(ak_rect(t.rect));
                nodes.push((tid, n));
                children.push(tid);
            }
            let controls: Vec<&ControlBox> = l
                .controls
                .iter()
                .filter(|c| c.key.surface == g.surface)
                .collect();
            let rows: Vec<&&ControlBox> = controls
                .iter()
                .filter(|c| c.style == ButtonStyle::Row)
                .collect();
            if let Some(list) = l.list.filter(|_| !rows.is_empty() && g.modal) {
                let lid = node_id(g.surface, "list");
                let mut ln = Node::new(Role::ListBox);
                ln.set_label("Nearby Bluetooth devices");
                ln.set_bounds(ak_rect(list));
                let mut row_ids = Vec::new();
                for c in &rows {
                    let rid = control_node_id(&c.key);
                    let mut rn = Node::new(Role::ListBoxOption);
                    rn.set_label(c.label.clone());
                    if let Some(d) = &c.description {
                        rn.set_description(d.clone());
                    }
                    rn.set_bounds(ak_rect(c.rect));
                    rn.add_action(Action::Click);
                    rn.add_action(Action::Focus);
                    rn.set_selected(self.focus.as_ref() == Some(&c.key));
                    if !c.enabled {
                        rn.set_disabled();
                    }
                    nodes.push((rid, rn));
                    row_ids.push(rid);
                }
                ln.set_children(row_ids);
                nodes.push((lid, ln));
                children.push(lid);
            }
            for c in controls.iter().filter(|c| c.style != ButtonStyle::Row) {
                let cid = control_node_id(&c.key);
                let mut bn = Node::new(Role::Button);
                let label = match c.key.control {
                    Control::IndicatorStop => format!("Stop: {}", g.label),
                    _ => c.label.clone(),
                };
                bn.set_label(label);
                bn.set_bounds(ak_rect(c.rect));
                bn.add_action(Action::Click);
                bn.add_action(Action::Focus);
                if !c.enabled {
                    bn.set_disabled();
                }
                nodes.push((cid, bn));
                children.push(cid);
            }
            group.set_children(children);
            nodes.push((gid, group));
            roots.push(gid);
        }
        let focus = if self.has_keyboard() {
            self.focus.as_ref().map(control_node_id)
        } else {
            None
        };
        (nodes, roots, focus)
    }

    /// An AccessKit action aimed at an overlay node; `true` when it was one.
    pub fn a11y_action(&mut self, target: NodeId, click: bool, now: Instant) -> bool {
        let Some(key) = self
            .layout
            .as_ref()
            .and_then(|l| {
                l.controls
                    .iter()
                    .find(|c| control_node_id(&c.key) == target)
            })
            .map(|c| c.key.clone())
        else {
            return false;
        };
        self.focus = Some(key.clone());
        self.keyboard = true;
        if click {
            self.activate(&key, now);
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::super::ui::{
        ActionSink, CameraPrompt, ChooserEntry, ChooserPrompt, ConsentPrompt, DeviceUi,
        IndicatorKind, IndicatorSpec, SurfaceUpdate, ARMING_DELAY,
    };
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    fn measure() -> impl FnMut(&str, f32, Option<f32>, u16) -> (f32, f32) {
        |t: &str, size: f32, wrap: Option<f32>, _w: u16| {
            let w = t.chars().count() as f32 * size * 0.5;
            match wrap {
                Some(max) if w > max => (max, size * 1.2 * (w / max).ceil()),
                _ => (w, size * 1.2),
            }
        }
    }

    fn rig() -> (
        Arc<OverlayHub>,
        OverlayController,
        Arc<Mutex<Vec<(u64, UiAction)>>>,
    ) {
        let hub = Arc::new(OverlayHub::new());
        hub.attach_window(Arc::new(|| {}));
        let ctl = OverlayController::new(Arc::clone(&hub));
        (hub, ctl, Arc::new(Mutex::new(Vec::new())))
    }

    fn sink(tag: u64, seen: &Arc<Mutex<Vec<(u64, UiAction)>>>) -> ActionSink {
        let seen = Arc::clone(seen);
        Arc::new(move |a| seen.lock().unwrap().push((tag, a)))
    }

    fn consent() -> Surface {
        Surface::Consent(ConsentPrompt {
            origin: "wss://app.example".into(),
            capability: "mic.record".into(),
            operation: "record audio from your microphone".into(),
            details: vec!["Format: PCM16 · 16000 Hz · mono".into()],
        })
    }

    fn lay(ctl: &mut OverlayController, now: Instant) -> Arc<OverlayLayout> {
        ctl.sync();
        ctl.layout((1200, 800), 1.0, now, &mut measure())
            .expect("layout")
    }

    fn center(l: &OverlayLayout, c: &Control) -> (f32, f32) {
        let b = l
            .controls
            .iter()
            .find(|b| &b.key.control == c)
            .expect("control");
        (b.rect.x + b.rect.w / 2.0, b.rect.y + b.rect.h / 2.0)
    }

    #[test]
    fn a_modal_blocks_the_app_and_its_continue_is_armed_late() {
        let (hub, mut ctl, seen) = rig();
        let now = Instant::now();
        hub.show(consent(), sink(1, &seen)).unwrap();
        let l = lay(&mut ctl, now);
        assert!(ctl.is_modal() && ctl.has_keyboard());
        assert!(ctl.covers(1.0, 1.0), "the scrim covers the whole window");
        // Focus starts on Cancel, never on the positive control.
        assert_eq!(ctl.focus().unwrap().control, Control::Cancel);
        // A click on Continue before the arming delay does nothing.
        let (x, y) = center(&l, &Control::Continue);
        assert!(ctl.pointer_down(x, y, now));
        assert!(ctl.pointer_up(x, y, now));
        assert!(seen.lock().unwrap().is_empty());
        // Enter before arming does nothing either (focus moved to Continue).
        ctl.key(OverlayKey::Tab { shift: false }, true, false, now);
        assert_eq!(ctl.focus().unwrap().control, Control::Continue);
        ctl.key(OverlayKey::Enter, true, false, now);
        assert!(seen.lock().unwrap().is_empty());
        // After the delay: a press that started earlier does not count...
        let later = now + ARMING_DELAY + Duration::from_millis(10);
        let l = lay(&mut ctl, later);
        let (x, y) = center(&l, &Control::Continue);
        ctl.pointer_down(x, y, now);
        ctl.pointer_up(x, y, later);
        assert!(
            seen.lock().unwrap().is_empty(),
            "the press began while disarmed"
        );
        // ...a fresh press does; auto-repeat never does.
        ctl.key(OverlayKey::Enter, true, true, later);
        assert!(seen.lock().unwrap().is_empty());
        ctl.pointer_down(x, y, later);
        ctl.pointer_up(x, y, later);
        assert_eq!(*seen.lock().unwrap(), [(1, UiAction::Continue)]);
    }

    #[test]
    fn escape_on_consent_is_dismissal_and_cancel_is_never_protected() {
        let (hub, mut ctl, seen) = rig();
        let now = Instant::now();
        hub.show(consent(), sink(1, &seen)).unwrap();
        let l = lay(&mut ctl, now);
        assert!(ctl.key(OverlayKey::Escape, true, false, now));
        let (x, y) = center(&l, &Control::Cancel);
        ctl.pointer_down(x, y, now);
        ctl.pointer_up(x, y, now);
        assert_eq!(
            *seen.lock().unwrap(),
            [(1, UiAction::Dismiss), (1, UiAction::Cancel)]
        );
    }

    #[test]
    fn indicators_are_non_modal_pills_with_a_keyboard_reachable_stop() {
        let (hub, mut ctl, seen) = rig();
        let spec = IndicatorSpec {
            origin: "wss://app.example".into(),
            kind: IndicatorKind::Microphone,
            activity: "Recording audio from your microphone".into(),
        };
        hub.show(Surface::Indicator(spec), sink(7, &seen)).unwrap();
        let now = hub.snapshot().1[0].shown_at;
        let l = lay(&mut ctl, now + Duration::from_secs(65));
        assert!(!ctl.is_modal() && !ctl.has_keyboard());
        assert_eq!(l.indicators.len(), 1);
        let pill = l.indicators[0];
        assert!(
            pill.x + pill.w <= 1200.0 && pill.y < 60.0,
            "top-right corner"
        );
        assert!(!ctl.covers(10.0, 700.0), "the app below stays usable");
        let text = l.ops.iter().find_map(|o| match o {
            DrawOp::Text { text, .. } if text.contains("Recording") => Some(text.clone()),
            _ => None,
        });
        assert!(text.unwrap().ends_with("1:05"), "elapsed time");
        // Keys go to the app until F6 moves focus into the indicators.
        assert!(!ctl.key(OverlayKey::Enter, true, false, now));
        assert!(ctl.key(OverlayKey::F6, true, false, now));
        assert_eq!(ctl.focus().unwrap().control, Control::IndicatorStop);
        let armed = now + ARMING_DELAY + Duration::from_millis(50);
        ctl.key(OverlayKey::Space, true, false, armed);
        assert_eq!(*seen.lock().unwrap(), [(7, UiAction::Stop)]);
        assert!(ctl.key(OverlayKey::Escape, true, false, armed));
        assert!(!ctl.has_keyboard(), "Escape returns to the app");
        // Screen readers: a Status group with a Stop button.
        let (nodes, roots, _) = ctl.a11y_nodes();
        assert_eq!(roots.len(), 1);
        let status = nodes.iter().find(|(id, _)| *id == roots[0]).unwrap();
        assert_eq!(status.1.role(), Role::Status);
        assert!(nodes.iter().any(|(_, n)| n.role() == Role::Button
            && n.label().is_some_and(|l| l.starts_with("Stop: Recording"))));
    }

    #[test]
    fn the_chooser_lists_rows_that_keyboard_and_screen_readers_can_choose() {
        let (hub, mut ctl, seen) = rig();
        let now = Instant::now();
        let id = hub
            .show(
                Surface::Chooser(ChooserPrompt {
                    origin: "wss://app.example".into(),
                    filters: vec!["Name starts with: Polar".into()],
                }),
                sink(3, &seen),
            )
            .unwrap();
        let devices: Vec<ChooserEntry> = (0..8)
            .map(|i| ChooserEntry {
                id: format!("dev-{i}"),
                name: (i != 2).then(|| format!("Polar {i}")),
                rssi: -50 - i as i16 * 5,
            })
            .collect();
        hub.update(id, SurfaceUpdate::Devices(devices));
        let l = lay(&mut ctl, now);
        let rows = l
            .controls
            .iter()
            .filter(|c| c.style == ButtonStyle::Row)
            .count();
        assert_eq!(rows, LIST_ROWS, "the list scrolls beyond six rows");
        assert!(l.controls.iter().any(|c| c.label == "Unknown device"));
        let armed = now + ARMING_DELAY + Duration::from_millis(50);
        // The first Down enters the list; seven more reach the last device,
        // scrolling the list.
        for _ in 0..8 {
            ctl.key(OverlayKey::Down, true, false, armed);
        }
        assert_eq!(
            ctl.focus().unwrap().control,
            Control::Device("dev-7".into())
        );
        let l = lay(&mut ctl, armed);
        assert!(l
            .controls
            .iter()
            .any(|c| c.key.control == Control::Device("dev-7".into())));
        ctl.key(OverlayKey::Enter, true, false, armed);
        assert_eq!(
            *seen.lock().unwrap(),
            [(3, UiAction::Choose("dev-7".into()))]
        );
        // AccessKit: a modal dialog containing a list box of options.
        let (nodes, _, focus) = ctl.a11y_nodes();
        assert!(nodes
            .iter()
            .any(|(_, n)| n.role() == Role::Dialog && n.is_modal()));
        assert!(nodes.iter().any(|(_, n)| n.role() == Role::ListBox));
        let option = nodes
            .iter()
            // (the list scrolled: rows 2..=7 are the visible options)
            .find(|(_, n)| n.role() == Role::ListBoxOption && n.label() == Some("Polar 5"))
            .unwrap()
            .0;
        assert!(focus.is_some());
        assert!(ctl.a11y_action(option, true, armed));
        assert_eq!(
            seen.lock().unwrap().last(),
            Some(&(3, UiAction::Choose("dev-5".into())))
        );
    }

    #[test]
    fn the_camera_panel_shows_the_preview_and_the_mode_controls() {
        let (hub, mut ctl, seen) = rig();
        let now = Instant::now();
        let id = hub
            .show(
                Surface::Camera(CameraPrompt {
                    origin: "wss://app.example".into(),
                    video: true,
                    max_duration_ms: Some(30_000),
                }),
                sink(5, &seen),
            )
            .unwrap();
        let l = lay(&mut ctl, now);
        assert!(
            !l.controls.iter().any(|c| c.key.control == Control::Record),
            "no Record before the camera is live"
        );
        hub.update(id, SurfaceUpdate::CameraPhase(CameraPhase::Live));
        hub.update(
            id,
            SurfaceUpdate::Preview(PreviewFrame {
                width: 4,
                height: 3,
                rgba: Arc::new(vec![0; 48]),
            }),
        );
        let l = lay(&mut ctl, now);
        assert!(l.ops.iter().any(|o| matches!(o, DrawOp::Image { .. })));
        assert!(l.controls.iter().any(|c| c.key.control == Control::Record));
        hub.update(
            id,
            SurfaceUpdate::CameraPhase(CameraPhase::Recording { since: now }),
        );
        let l = lay(&mut ctl, now + Duration::from_secs(12));
        assert!(l.controls.iter().any(|c| c.key.control == Control::Stop));
        assert!(l
            .ops
            .iter()
            .any(|o| matches!(o, DrawOp::Text { text, .. } if text == "● Recording 0:12")));
        assert!(ctl.animating(now));
    }

    fn file_drop_prompt() -> Surface {
        Surface::FileDrop(super::super::ui::FileDropPrompt {
            origin: "wss://files.example".into(),
            capability: "file.pick".into(),
            operation: "choose up to 16 files".into(),
            multiple: true,
            details: vec![],
        })
    }

    fn mid(r: Rect) -> (f32, f32) {
        (r.x + r.w / 2.0, r.y + r.h / 2.0)
    }

    #[test]
    fn the_file_drop_surface_lays_out_a_drop_area_with_cancel_and_continue() {
        let (hub, mut ctl, seen) = rig();
        let now = Instant::now();
        hub.show(file_drop_prompt(), sink(1, &seen)).unwrap();
        let l = lay(&mut ctl, now);
        let area = l.drop_area.expect("drop area");
        let panel = l.modal.expect("modal panel");
        assert!(panel.contains(area.x, area.y) && area.w > 0.0 && area.h > 0.0);
        let mut labels: Vec<&str> = l.controls.iter().map(|c| c.label.as_str()).collect();
        labels.sort();
        assert_eq!(labels, ["Cancel", "Continue"]);
        // Continue is input-protected like the consent dialog's.
        assert!(!l.controls.iter().find(|c| c.label == "Continue").unwrap().enabled);
        assert!(l.texts.iter().any(|t| t.text == "Drop files here, or Continue to browse"));
        assert!(l
            .texts
            .iter()
            .any(|t| t.text == "wss://files.example wants to choose up to 16 files."));
        // Escape is abandonment, like the consent dialog's.
        ctl.key(OverlayKey::Escape, true, false, now);
        assert_eq!(*seen.lock().unwrap(), [(1, UiAction::Dismiss)]);
    }

    #[test]
    fn a_file_drop_counts_only_armed_entered_and_over_the_drop_area() {
        let (hub, mut ctl, seen) = rig();
        let files = || vec![PathBuf::from("/tmp/a.txt")];
        hub.show(file_drop_prompt(), sink(1, &seen)).unwrap();
        let now = Instant::now();
        let area = lay(&mut ctl, now).drop_area.unwrap();
        let inside = Some(mid(area));
        let outside = Some((area.x + area.w / 2.0, area.y - 40.0));

        // The surface popped up under a drag already over it, and the user
        // let go at once: too early — ignored, the surface stays.
        ctl.file_drag_move(inside, now);
        assert!(!ctl.file_drop(files(), inside, now));
        assert!(seen.lock().unwrap().is_empty());

        // Armed now, but the drag never left since it was disarmed: it
        // never ENTERED the armed area — still ignored.
        let later = now + ARMING_DELAY + Duration::from_millis(10);
        lay(&mut ctl, later);
        ctl.file_drag_move(inside, now);
        ctl.file_drag_move(inside, later);
        assert!(!ctl.file_drop(files(), inside, later));
        assert!(seen.lock().unwrap().is_empty());

        // Leave and come back while armed; release outside the area: no.
        ctl.file_drag_move(outside, later);
        ctl.file_drag_move(inside, later);
        assert!(!ctl.file_drop(files(), outside, later));
        // An unknown release position never counts either.
        ctl.file_drag_move(outside, later);
        ctl.file_drag_move(inside, later);
        assert!(!ctl.file_drop(files(), None, later));
        assert!(seen.lock().unwrap().is_empty());

        // Entered armed and released over it: the per-use choice.
        ctl.file_drag_move(outside, later);
        assert!(ctl.file_drag_move(inside, later), "the area lights up");
        assert!(ctl.file_drop(files(), inside, later));
        assert_eq!(*seen.lock().unwrap(), [(1, UiAction::Dropped(files()))]);
    }

    #[test]
    fn leaving_the_window_or_regaining_focus_requires_a_fresh_entry() {
        let (hub, mut ctl, seen) = rig();
        let files = || vec![PathBuf::from("/tmp/a.txt")];
        hub.show(file_drop_prompt(), sink(1, &seen)).unwrap();
        let now = Instant::now() + ARMING_DELAY + Duration::from_millis(10);
        let area = lay(&mut ctl, now).drop_area.unwrap();
        let inside = Some(mid(area));
        ctl.file_drag_move(None, now);
        ctl.file_drag_move(inside, now);
        // The drag left the window and the files are released elsewhere.
        assert!(ctl.file_drag_left());
        assert!(!ctl.file_drop(files(), inside, now));
        // Input protection restarts (focus regained): an entry made before
        // it re-arms doesn't count.
        ctl.file_drag_move(None, now);
        ctl.file_drag_move(inside, now);
        hub.rearm();
        ctl.sync();
        let soon = Instant::now();
        ctl.file_drag_move(inside, soon);
        assert!(!ctl.file_drop(files(), inside, soon));
        assert!(seen.lock().unwrap().is_empty());
        // Not on another kind of modal.
        let (hub, mut ctl, seen) = rig();
        hub.show(consent(), sink(2, &seen)).unwrap();
        lay(&mut ctl, now);
        ctl.file_drag_move(Some((600.0, 400.0)), now);
        assert!(!ctl.file_drop(files(), Some((600.0, 400.0)), now));
        assert!(seen.lock().unwrap().is_empty());
    }
}

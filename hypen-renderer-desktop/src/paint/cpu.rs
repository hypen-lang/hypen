//! CPU painter — tiny-skia + cosmic-text.
//!
//! Phase 3: reads style props off the layout items (`color`,
//! `backgroundColor`, `fontSize`, ...) and applies hover/press tints
//! supplied by the window event loop.

use crate::layout::{ItemKind, LayoutPass};
use crate::painter::{PaintTarget, Painter};
use crate::style::Rgba;
use crate::text::TextEngine;
use crate::tree::Tree;
use std::collections::HashSet;
use tiny_skia::{
    Color, FillRule, Paint, PathBuilder, Pixmap, PremultipliedColorU8, Rect, Stroke, Transform,
};

/// Per-frame interaction state passed in by the window. Empty defaults
/// give the original (Phase 2) look.
#[derive(Default, Debug)]
pub struct InteractionState {
    pub hovered: HashSet<String>,
    pub pressed: HashSet<String>,
    /// Renderer node id of the keyboard-focused element, if any (Button
    /// or Input alike).
    pub focused: Option<String>,
    /// Per-Input selection (anchor + head byte offsets), mirrored from
    /// `App` so the painter can place the caret + highlight band
    /// without owning the editor state. Collapsed selection means just
    /// a caret; otherwise a translucent range is painted.
    pub input_selections: std::collections::HashMap<String, crate::window::Selection>,
    /// Active IME preedit composition: `(focused_input_id, text)`.
    /// While composing, the text is rendered inline at the caret with
    /// an underline to show it isn't committed yet — `__hypen_bind`
    /// dispatch is suppressed until the user commits or cancels.
    pub ime_preedit: Option<(String, String)>,
}

pub struct CpuPainter {
    text: TextEngine,
    interaction: InteractionState,
    /// Reusable pixmap buffer. Reallocated only when the surface size
    /// changes — avoids ~10MB+ per-frame allocs on resize.
    pixmap: Option<Pixmap>,
    /// Pre-rasterised icon pixmaps. Same idea as the text raster
    /// cache: the slow op (path tessellation + per-pixel coverage)
    /// runs once per `(shape, size, tint)` tuple instead of per
    /// frame.
    icon_cache: crate::paint::icon::IconRasterCache,
    /// Pre-scaled + masked Image tiles, keyed on
    /// `(src, target_w, target_h, fit, radius)`. Each post body
    /// image runs the (decode → scale → mask) pipeline once and
    /// then becomes a single `draw_pixmap` per frame, even during
    /// scroll bursts.
    image_cache: crate::paint::image::ImageRenderCache,
}

impl CpuPainter {
    pub fn new() -> Self {
        Self {
            text: TextEngine::new(),
            interaction: InteractionState::default(),
            pixmap: None,
            icon_cache: crate::paint::icon::IconRasterCache::new(),
            image_cache: crate::paint::image::ImageRenderCache::new(),
        }
    }

    pub fn text_engine_mut(&mut self) -> &mut TextEngine {
        &mut self.text
    }

    pub fn interaction_mut(&mut self) -> &mut InteractionState {
        &mut self.interaction
    }
}

impl Default for CpuPainter {
    fn default() -> Self {
        Self::new()
    }
}

impl Painter for CpuPainter {
    fn paint(&mut self, tree: &Tree, target: PaintTarget<'_>) {
        self.paint_with_scroll(tree, target, 0.0);
    }
}

impl CpuPainter {
    /// Same as [`Painter::paint`] but takes an extra `scroll_y` offset
    /// (physical pixels) that's subtracted from every item's `y`. The
    /// painter additionally renders a thin scrollbar indicator on the
    /// right edge whenever content overflows the viewport.
    pub fn paint_with_scroll(&mut self, tree: &Tree, target: PaintTarget<'_>, scroll_y: f32) {
        self.paint_with_scrolls(tree, target, scroll_y, &std::collections::HashMap::new());
    }

    /// Same as [`Self::paint_with_scroll`] but additionally honours
    /// per-Container scroll offsets. Returns the layout it computed
    /// so the caller can reuse it (e.g. App.layout) instead of
    /// recomputing — Phase 16 perf.
    pub fn paint_with_scrolls(
        &mut self,
        tree: &Tree,
        target: PaintTarget<'_>,
        scroll_y: f32,
        scrolls: &std::collections::HashMap<String, f32>,
    ) -> LayoutPass {
        let layout = LayoutPass::compute_with_scrolls(
            tree,
            &mut self.text,
            (target.width, target.height),
            target.scale_factor,
            scroll_y,
            scrolls,
        );
        self.paint_layout(&layout, target, scroll_y);
        layout
    }

    /// Paint a precomputed layout. Used by callers that already have
    /// a `LayoutPass` and want to avoid the double-compute cost.
    /// `scroll_y` is the page-level offset, used only to size the
    /// scrollbar indicator (the layout already bakes scroll into its
    /// item rects).
    pub fn paint_layout(&mut self, layout: &LayoutPass, target: PaintTarget<'_>, scroll_y: f32) {
        self.paint_layout_with_damage(layout, target, scroll_y, None);
    }

    /// Same as [`Self::paint_layout`] but only repaints inside the
    /// `damage` rect (physical pixels). Items whose rect doesn't
    /// intersect the damage are skipped, and the page-background fill
    /// is scoped to the damage rect — the rest of the previous
    /// frame's pixels are kept (the painter retains its `Pixmap` from
    /// frame to frame). `None` falls back to a full repaint.
    pub fn paint_layout_with_damage(
        &mut self,
        layout: &LayoutPass,
        target: PaintTarget<'_>,
        scroll_y: f32,
        damage: Option<crate::layout::Rect>,
    ) {
        let PaintTarget {
            width,
            height,
            scale_factor,
            ..
        } = target;

        let need_realloc = self
            .pixmap
            .as_ref()
            .map(|p| p.width() != width || p.height() != height)
            .unwrap_or(true);
        // A reallocation throws away the previous frame's pixels, so
        // a "damage rect only" repaint becomes a full repaint
        // automatically — the rest of the surface would otherwise be
        // garbage / zeroed.
        let damage = if need_realloc { None } else { damage };
        if need_realloc {
            self.pixmap = Some(Pixmap::new(width, height).expect("pixmap alloc"));
        }
        let pixmap = self.pixmap.as_mut().expect("pixmap set");
        let bg = Color::from_rgba8(0xfb, 0xfb, 0xfd, 0xff);
        if let Some(d) = damage {
            // Clear only the damaged area to the page background; the
            // rest of the surface keeps the previous frame's content.
            let mut paint = Paint::default();
            paint.set_color(bg);
            if let Some(rect) = tiny_skia::Rect::from_xywh(d.x, d.y, d.w.max(1.0), d.h.max(1.0)) {
                pixmap.fill_rect(rect, &paint, Transform::identity(), None);
            }
        } else {
            pixmap.fill(bg);
        }

        // Viewport cull rect — items fully outside the surface
        // contribute nothing, and on a long feed they outnumber
        // visible items 5×+. Skipping their composites turns
        // "paint scales with feed length" into "paint scales with
        // visible posts".
        let viewport = crate::layout::Rect {
            x: 0.0,
            y: 0.0,
            w: width as f32,
            h: height as f32,
        };
        for item in &layout.items {
            if !crate::damage::rects_intersect(item.rect, viewport) {
                continue;
            }
            if let Some(d) = damage {
                if !crate::damage::rects_intersect(item.rect, d) {
                    continue;
                }
            }
            // Background and border apply to every element type. Two
            // overlays compose here, in order:
            //   1. Explicit paint-time state variants
            //      (`backgroundColor:hover.0`, `borderColor@md:active.0`,
            //      ...) resolved via the shared precedence rules from the
            //      node's live interaction state. These are authoritative
            //      when present.
            //   2. The legacy hover/press TINT on Buttons — only applied
            //      as a fallback for whichever channel the state variants
            //      did NOT override, so we never double-apply.
            let hovered = self.interaction.hovered.contains(&item.node_id);
            let pressed = self.interaction.pressed.contains(&item.node_id);
            let focused = self.interaction.focused.as_deref() == Some(&item.node_id);
            let mut background = item.background;
            let mut border_color = item.border.color;
            let mut bg_from_variant = false;
            let mut border_from_variant = false;
            // Resolve background / border / foreground state variants in one
            // pass. `active_states` is computed once and reused for all three.
            // `fg_override` is the foreground `color` variant (Text / Icon /
            // Input glyph colour); `None` → use the base colour baked into the
            // ItemKind.
            let fg_override = if item.state_variants.is_empty() {
                None
            } else {
                let states = item.state_variants.active_states(hovered, pressed, focused);
                if let Some(c) = item.state_variants.background_color_for(&states) {
                    background = Some(c);
                    bg_from_variant = true;
                }
                if let Some(c) = item.state_variants.border_color_for(&states) {
                    border_color = c;
                    border_from_variant = true;
                }
                item.state_variants.color_for(&states)
            };
            if matches!(item.kind, ItemKind::Button) {
                if pressed {
                    if !bg_from_variant {
                        if let Some(bg) = background.as_mut() {
                            *bg = darken(*bg, 0.85);
                        }
                    }
                    if !border_from_variant {
                        border_color = darken(border_color, 0.7);
                    }
                } else if hovered && !bg_from_variant {
                    if let Some(bg) = background.as_mut() {
                        *bg = lighten(*bg, 1.05);
                    }
                }
            }

            let radius = item.border.radius * scale_factor;
            if let Some(bg) = background {
                fill_rect(pixmap, item.rect, bg, radius);
            }
            if item.border.is_visible() {
                if item.border.is_partial() {
                    // tw `border-b` etc. — stroke only the requested
                    // sides as thin un-rounded fill rects. Skips
                    // corner rounding on partial borders for now;
                    // most tw usage is single-side dividers where
                    // straight corners look right.
                    paint_partial_border(
                        pixmap,
                        item.rect,
                        border_color,
                        item.border.width * scale_factor,
                        item.border.sides,
                    );
                } else {
                    stroke_rect(
                        pixmap,
                        item.rect,
                        border_color,
                        radius,
                        item.border.width * scale_factor,
                    );
                }
            }

            match &item.kind {
                ItemKind::Image { src, fit } => {
                    crate::paint::image::paint_image_cached(
                        pixmap,
                        item.rect,
                        src.as_deref(),
                        scale_factor,
                        item.border.radius * scale_factor,
                        *fit,
                        &mut self.image_cache,
                    );
                }
                ItemKind::Icon {
                    paths,
                    view_box,
                    tint,
                } => {
                    crate::paint::icon::paint_icon_cached(
                        pixmap,
                        item.rect,
                        paths,
                        *view_box,
                        fg_override.or(*tint),
                        &mut self.icon_cache,
                    );
                }
                ItemKind::Text {
                    content,
                    font_size,
                    color,
                    align,
                    max_lines: _,
                    padding: _,
                } => {
                    // Pre-measure the line so right/center alignment
                    // can offset within the laid-out rect. Wrap width
                    // is the full rect for alignment purposes — long
                    // text still wraps at the rect edge.
                    let scaled_size = *font_size * scale_factor;
                    let (line_w, _) = self.text.measure_weighted(
                        content,
                        scaled_size,
                        Some(item.rect.w),
                        item.font_weight,
                    );
                    let dx = match align {
                        crate::layout::TextAlign::Start => 0.0,
                        crate::layout::TextAlign::Center => ((item.rect.w - line_w).max(0.0)) * 0.5,
                        crate::layout::TextAlign::End => (item.rect.w - line_w).max(0.0),
                    };
                    self.text.draw_text_cached_weighted(
                        pixmap,
                        content,
                        item.rect.x + dx,
                        item.rect.y,
                        scaled_size,
                        fg_override.unwrap_or(*color),
                        Some(item.rect.w),
                        item.font_weight,
                    );
                }
                ItemKind::Input {
                    value,
                    placeholder,
                    font_size,
                    color,
                    ..
                } => {
                    let pad_x = 12.0 * scale_factor;
                    let pad_y = 8.0 * scale_factor;
                    let inner_w = (item.rect.w - 2.0 * pad_x).max(0.0);
                    let text_x = item.rect.x + pad_x;
                    let text_y = item.rect.y + pad_y;
                    if value.is_empty() {
                        if let Some(p) = placeholder.as_deref() {
                            // Placeholder is muted gray; engine doesn't
                            // resolve a separate `placeholderColor` yet.
                            self.text.draw_text_cached_weighted(
                                pixmap,
                                p,
                                text_x,
                                text_y,
                                *font_size * scale_factor,
                                Rgba(0x90, 0x96, 0xa1, 0xff),
                                Some(inner_w),
                                item.font_weight,
                            );
                        }
                    } else {
                        self.text.draw_text_cached_weighted(
                            pixmap,
                            value,
                            text_x,
                            text_y,
                            *font_size * scale_factor,
                            fg_override.unwrap_or(*color),
                            Some(inner_w),
                            item.font_weight,
                        );
                    }

                    // Selection / caret / IME preedit when this input
                    // is focused.
                    if self.interaction.focused.as_deref() == Some(&item.node_id) {
                        let sel = self
                            .interaction
                            .input_selections
                            .get(&item.node_id)
                            .copied()
                            .unwrap_or_else(|| crate::window::Selection::caret(value.len()))
                            .clamped(value.len());
                        let h_px = *font_size * 1.2 * scale_factor;
                        let preedit = self
                            .interaction
                            .ime_preedit
                            .as_ref()
                            .filter(|(id, _)| id == &item.node_id)
                            .map(|(_, t)| t.as_str());

                        if !sel.is_collapsed() && preedit.is_none() {
                            // Translucent accent-blue selection band
                            // running from the leading edge of the
                            // selected range to its trailing edge.
                            let (lead_w, _) = self.text.measure(
                                &value[..sel.min()],
                                *font_size * scale_factor,
                                None,
                            );
                            let (sel_w, _) = self.text.measure(
                                &value[sel.min()..sel.max()],
                                *font_size * scale_factor,
                                None,
                            );
                            let band = crate::layout::Rect {
                                x: text_x + lead_w,
                                y: text_y,
                                w: sel_w.max(2.0 * scale_factor),
                                h: h_px,
                            };
                            fill_rect(pixmap, band, Rgba(0x00, 0x7a, 0xff, 0x55), 0.0);
                        } else {
                            // Caret. Width of the leading substring up
                            // to `head` tells us the x position. When
                            // composing, the caret sits at the *end* of
                            // the preedit so it visually leads the
                            // composition like every native input.
                            let (caret_w, _) = self.text.measure(
                                &value[..sel.head],
                                *font_size * scale_factor,
                                None,
                            );
                            let mut caret_x = text_x + caret_w;
                            if let Some(pre) = preedit {
                                let (pre_w, _) =
                                    self.text.measure(pre, *font_size * scale_factor, None);
                                // Paint preedit inline at caret_x in the
                                // text colour, then a thin underline to
                                // show it isn't committed yet.
                                self.text.draw_text_colored(
                                    pixmap,
                                    pre,
                                    caret_x,
                                    text_y,
                                    *font_size * scale_factor,
                                    *color,
                                    None,
                                );
                                let underline = crate::layout::Rect {
                                    x: caret_x,
                                    y: text_y + h_px - 1.0 * scale_factor,
                                    w: pre_w,
                                    h: 1.0 * scale_factor,
                                };
                                fill_rect(pixmap, underline, Rgba(0x00, 0x7a, 0xff, 0xff), 0.0);
                                caret_x += pre_w;
                            }
                            let caret = crate::layout::Rect {
                                x: caret_x,
                                y: text_y,
                                w: 1.5 * scale_factor,
                                h: h_px,
                            };
                            fill_rect(pixmap, caret, Rgba(0x00, 0x7a, 0xff, 0xff), 0.0);
                        }
                    }
                }
                _ => {}
            }
        }

        // Focus ring on top of everything else so it isn't occluded by
        // overlapping rects from later-painted items.
        if let Some(focus_id) = self.interaction.focused.clone() {
            if let Some(item) = layout
                .items
                .iter()
                .find(|it| it.node_id == focus_id && it.action.is_some())
            {
                draw_focus_ring(pixmap, item.rect, scale_factor);
            }
        }

        // Scrollbar indicator: thin track + a thumb sized in
        // proportion to the visible fraction of the content. Drawn
        // last so it sits above any content. Hidden when content fits.
        let viewport_h = height as f32;
        let content_h = layout.content_size.1 + scroll_y; // un-shifted height
        if content_h > viewport_h {
            let track_w = 4.0 * scale_factor;
            let track_x = width as f32 - track_w - 2.0 * scale_factor;
            let visible_frac = (viewport_h / content_h).clamp(0.05, 1.0);
            let thumb_h = (viewport_h * visible_frac).max(20.0 * scale_factor);
            let max_scroll = (content_h - viewport_h).max(1.0);
            let progress = (scroll_y / max_scroll).clamp(0.0, 1.0);
            let thumb_y = progress * (viewport_h - thumb_h);
            fill_rect(
                pixmap,
                crate::layout::Rect {
                    x: track_x,
                    y: thumb_y,
                    w: track_w,
                    h: thumb_h,
                },
                Rgba(0x80, 0x80, 0x80, 0x80),
                track_w * 0.5,
            );
        }

        // No surface-sized copy here: the GPU upload path reads
        // `pixmap.data()` directly via `pixmap_data()` after the
        // paint returns. Saves `width * height * 4` bytes of
        // memcpy per frame (~10 MB at 1440p HiDPI).
    }

    /// Borrow the painter's pixmap bytes for GPU upload. Valid
    /// until the next `paint_layout*` call (which may grow the
    /// buffer on resize). Returns `None` only before the first
    /// paint when no pixmap is allocated yet.
    pub fn pixmap_data(&self) -> Option<&[u8]> {
        self.pixmap.as_ref().map(|p| p.data())
    }

    /// Width of the current pixmap in physical pixels.
    pub fn pixmap_size(&self) -> Option<(u32, u32)> {
        self.pixmap.as_ref().map(|p| (p.width(), p.height()))
    }
}

// ---------------------------------------------------------------------------
// Drawing primitives.
// ---------------------------------------------------------------------------

fn fill_rect(pixmap: &mut Pixmap, rect: crate::layout::Rect, color: Rgba, radius: f32) {
    if color.3 == 0 {
        return;
    }
    let mut paint = Paint::default();
    let [r, g, b, a] = color.premultiplied();
    paint.set_color(
        Color::from_rgba(
            r as f32 / 255.0,
            g as f32 / 255.0,
            b as f32 / 255.0,
            a as f32 / 255.0,
        )
        .unwrap_or(Color::BLACK),
    );
    paint.anti_alias = true;
    if let Some(path) = rounded_rect_path(rect.x, rect.y, rect.w, rect.h, radius) {
        pixmap.fill_path(
            &path,
            &paint,
            FillRule::Winding,
            Transform::identity(),
            None,
        );
    }
}

/// Stroke just the sides flagged in `sides` as thin straight fill
/// rects. Used for tw `border-b` / `border-t` etc. — single-side
/// dividers where corner rounding is irrelevant.
fn paint_partial_border(
    pixmap: &mut Pixmap,
    rect: crate::layout::Rect,
    color: Rgba,
    width: f32,
    sides: u8,
) {
    use crate::style::{BORDER_SIDE_BOTTOM, BORDER_SIDE_LEFT, BORDER_SIDE_RIGHT, BORDER_SIDE_TOP};
    if color.3 == 0 || width <= 0.0 {
        return;
    }
    if sides & BORDER_SIDE_TOP != 0 {
        fill_rect(
            pixmap,
            crate::layout::Rect {
                x: rect.x,
                y: rect.y,
                w: rect.w,
                h: width,
            },
            color,
            0.0,
        );
    }
    if sides & BORDER_SIDE_BOTTOM != 0 {
        fill_rect(
            pixmap,
            crate::layout::Rect {
                x: rect.x,
                y: rect.y + rect.h - width,
                w: rect.w,
                h: width,
            },
            color,
            0.0,
        );
    }
    if sides & BORDER_SIDE_LEFT != 0 {
        fill_rect(
            pixmap,
            crate::layout::Rect {
                x: rect.x,
                y: rect.y,
                w: width,
                h: rect.h,
            },
            color,
            0.0,
        );
    }
    if sides & BORDER_SIDE_RIGHT != 0 {
        fill_rect(
            pixmap,
            crate::layout::Rect {
                x: rect.x + rect.w - width,
                y: rect.y,
                w: width,
                h: rect.h,
            },
            color,
            0.0,
        );
    }
}

fn stroke_rect(
    pixmap: &mut Pixmap,
    rect: crate::layout::Rect,
    color: Rgba,
    radius: f32,
    width: f32,
) {
    if color.3 == 0 || width <= 0.0 {
        return;
    }
    let mut paint = Paint::default();
    let [r, g, b, a] = color.premultiplied();
    paint.set_color(
        Color::from_rgba(
            r as f32 / 255.0,
            g as f32 / 255.0,
            b as f32 / 255.0,
            a as f32 / 255.0,
        )
        .unwrap_or(Color::BLACK),
    );
    paint.anti_alias = true;
    let stroke = Stroke {
        width,
        ..Default::default()
    };
    if let Some(path) = rounded_rect_path(rect.x, rect.y, rect.w, rect.h, radius) {
        pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
    }
}

/// Outset accent-coloured ring around the focused element. ~3px outset,
/// ~2px stroke at 1x scale; slightly thicker corners than the button
/// border so it reads above interior chrome.
fn draw_focus_ring(pixmap: &mut Pixmap, rect: crate::layout::Rect, scale: f32) {
    let inset = -3.0 * scale; // negative inset = outset
    let ring_rect = crate::layout::Rect {
        x: rect.x + inset,
        y: rect.y + inset,
        w: rect.w - 2.0 * inset,
        h: rect.h - 2.0 * inset,
    };
    let radius = 11.0 * scale;
    let mut paint = Paint::default();
    // Standard system-accent blue. Phase 5 will read this from theme.
    paint.set_color(Color::from_rgba8(0x00, 0x7a, 0xff, 0xcc));
    paint.anti_alias = true;
    let stroke = Stroke {
        width: 2.0 * scale,
        ..Default::default()
    };
    if let Some(path) =
        rounded_rect_path(ring_rect.x, ring_rect.y, ring_rect.w, ring_rect.h, radius)
    {
        pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
    }
}

fn rounded_rect_path(x: f32, y: f32, w: f32, h: f32, r: f32) -> Option<tiny_skia::Path> {
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let rect = Rect::from_xywh(x, y, w, h)?;
    if r <= 0.0 {
        let mut pb = PathBuilder::new();
        pb.push_rect(rect);
        return pb.finish();
    }
    // CSS-correct rounded rect: when the requested radius would
    // otherwise clamp to `min(w, h) / 2` AND the shape isn't square,
    // expand to elliptical corners (`rx = w/2, ry = h/2`) so the
    // overall shape is a true ellipse rather than a stadium /
    // capsule. Without this, `rounded-full` on a non-square element
    // produced a "stretched" border along the long axis.
    const K: f32 = 0.5522847498307936;
    let max_corner = w.min(h) * 0.5;
    let (rx, ry) = if r >= max_corner {
        (w * 0.5, h * 0.5)
    } else {
        (r, r)
    };
    let cx = rx * K;
    let cy = ry * K;
    let mut pb = PathBuilder::new();
    pb.move_to(x + rx, y);
    pb.line_to(x + w - rx, y);
    pb.cubic_to(x + w - rx + cx, y, x + w, y + ry - cy, x + w, y + ry);
    pb.line_to(x + w, y + h - ry);
    pb.cubic_to(
        x + w,
        y + h - ry + cy,
        x + w - rx + cx,
        y + h,
        x + w - rx,
        y + h,
    );
    pb.line_to(x + rx, y + h);
    pb.cubic_to(x + rx - cx, y + h, x, y + h - ry + cy, x, y + h - ry);
    pb.line_to(x, y + ry);
    pb.cubic_to(x, y + ry - cy, x + rx - cx, y, x + rx, y);
    pb.close();
    pb.finish()
}

// ---------------------------------------------------------------------------
// Hover / press colour math.
// ---------------------------------------------------------------------------

fn lighten(c: Rgba, factor: f32) -> Rgba {
    let f = factor.max(0.0);
    Rgba(
        ((c.0 as f32 * f).min(255.0)) as u8,
        ((c.1 as f32 * f).min(255.0)) as u8,
        ((c.2 as f32 * f).min(255.0)) as u8,
        c.3,
    )
}

fn darken(c: Rgba, factor: f32) -> Rgba {
    let f = factor.clamp(0.0, 1.0);
    Rgba(
        (c.0 as f32 * f) as u8,
        (c.1 as f32 * f) as u8,
        (c.2 as f32 * f) as u8,
        c.3,
    )
}

// PremultipliedColorU8 is unused after the rewrite — keep the import path
// alive for tests downstream.
#[allow(dead_code)]
fn _premul_keepalive() -> Option<PremultipliedColorU8> {
    PremultipliedColorU8::from_rgba(0, 0, 0, 0)
}

#[cfg(test)]
mod tests {
    use super::{darken, fill_rect, lighten, rounded_rect_path, stroke_rect};
    use crate::layout::Rect;
    use crate::style::Rgba;
    use tiny_skia::Pixmap;

    #[test]
    fn lighten_factor_one_is_identity() {
        let input = Rgba(120, 80, 40, 255);
        assert_eq!(lighten(input, 1.0), input);
    }

    #[test]
    fn lighten_clamps_at_255() {
        let result = lighten(Rgba(200, 0, 0, 255), 2.0);
        assert_eq!(result, Rgba(255, 0, 0, 255));
    }

    #[test]
    fn lighten_preserves_alpha() {
        assert_eq!(lighten(Rgba(10, 20, 30, 0x80), 1.0).3, 0x80);
        assert_eq!(lighten(Rgba(10, 20, 30, 0x80), 2.0).3, 0x80);
        assert_eq!(lighten(Rgba(10, 20, 30, 0x80), 0.0).3, 0x80);
    }

    #[test]
    fn darken_factor_one_is_identity() {
        let input = Rgba(120, 80, 40, 255);
        assert_eq!(darken(input, 1.0), input);
    }

    #[test]
    fn darken_factor_zero_is_black_keeping_alpha() {
        let result = darken(Rgba(200, 100, 50, 0xAB), 0.0);
        assert_eq!(result, Rgba(0, 0, 0, 0xAB));
    }

    #[test]
    fn darken_factor_negative_clamps_to_zero() {
        let result = darken(Rgba(200, 100, 50, 255), -1.0);
        assert_eq!(result, Rgba(0, 0, 0, 255));
    }

    #[test]
    fn darken_factor_above_one_clamps_to_one() {
        let input = Rgba(200, 100, 50, 255);
        assert_eq!(darken(input, 5.0), input);
    }

    #[test]
    fn darken_half_halves_channels() {
        let result = darken(Rgba(200, 100, 50, 255), 0.5);
        assert_eq!(result, Rgba(100, 50, 25, 255));
    }

    // -----------------------------------------------------------------
    // Path / fill / stroke primitives
    // -----------------------------------------------------------------

    #[test]
    fn rounded_rect_path_returns_none_for_zero_size() {
        // Zero-area rect can't produce a stroked or filled path.
        assert!(rounded_rect_path(0.0, 0.0, 0.0, 0.0, 0.0).is_none());
    }

    #[test]
    fn rounded_rect_path_clamps_radius_to_half_smaller_side() {
        // 10x100 rect with a radius of 50 — radius > w/2, so it should
        // clamp to 5 internally and not panic. We just verify a path
        // came back (no panic, no None).
        let path = rounded_rect_path(0.0, 0.0, 10.0, 100.0, 50.0);
        assert!(
            path.is_some(),
            "expected a Some(path) even with oversized radius"
        );
    }

    /// Helper: build a fresh white pixmap and capture its initial bytes.
    fn fresh_white(w: u32, h: u32) -> (Pixmap, Vec<u8>) {
        let mut pm = Pixmap::new(w, h).expect("pixmap alloc");
        pm.fill(tiny_skia::Color::from_rgba8(0xff, 0xff, 0xff, 0xff));
        let snapshot = pm.data().to_vec();
        (pm, snapshot)
    }

    #[test]
    fn fill_rect_skips_transparent_color() {
        let (mut pm, baseline) = fresh_white(32, 32);
        let rect = Rect {
            x: 4.0,
            y: 4.0,
            w: 16.0,
            h: 16.0,
        };
        // alpha 0 — fill_rect must early-return without touching pixels.
        fill_rect(&mut pm, rect, Rgba(0xff, 0, 0, 0), 0.0);
        assert_eq!(
            pm.data(),
            baseline.as_slice(),
            "fill_rect with zero-alpha colour must leave pixmap unchanged",
        );
    }

    #[test]
    fn fill_rect_writes_pixels_for_opaque() {
        let (mut pm, baseline) = fresh_white(32, 32);
        let rect = Rect {
            x: 4.0,
            y: 4.0,
            w: 16.0,
            h: 16.0,
        };
        fill_rect(&mut pm, rect, Rgba(0xff, 0, 0, 0xff), 0.0);
        assert_ne!(
            pm.data(),
            baseline.as_slice(),
            "fill_rect with opaque red should mutate the pixmap",
        );
        // At least one pixel inside the rect should be red-tinted (R > G).
        let mut found_red = false;
        for py in 4..20 {
            for px in 4..20 {
                if let Some(p) = pm.pixel(px, py) {
                    if p.red() > p.green() && p.red() > p.blue() {
                        found_red = true;
                        break;
                    }
                }
            }
            if found_red {
                break;
            }
        }
        assert!(
            found_red,
            "expected at least one red-tinted pixel in the filled rect"
        );
    }

    #[test]
    fn stroke_rect_skips_zero_width() {
        let (mut pm, baseline) = fresh_white(32, 32);
        let rect = Rect {
            x: 4.0,
            y: 4.0,
            w: 16.0,
            h: 16.0,
        };
        stroke_rect(&mut pm, rect, Rgba(0xff, 0, 0, 0xff), 0.0, 0.0);
        assert_eq!(
            pm.data(),
            baseline.as_slice(),
            "stroke_rect with zero width must leave pixmap unchanged",
        );
    }
}

#[cfg(test)]
mod paint_variant_tests {
    //! End-to-end paint coverage: drive a real `Tree` through the CPU
    //! painter and read back a pixel, proving interaction-state variants
    //! actually reach the painted output (not just the resolver). The
    //! Vello painter shares the same resolution path; only the raster
    //! backend differs, so the CPU painter is the testable proxy.
    use super::CpuPainter;
    use crate::painter::PaintTarget;
    use crate::tree::{Tree, ROOT_ID};
    use hypen_engine::Patch;
    use indexmap::IndexMap;
    use serde_json::{json, Value};
    use std::sync::Arc;

    fn props(entries: &[(&str, Value)]) -> Arc<IndexMap<String, Value>> {
        let mut m = IndexMap::new();
        for (k, v) in entries {
            m.insert((*k).to_string(), v.clone());
        }
        Arc::new(m)
    }

    /// A 100×100 Container with a base + hover + md-breakpoint background.
    fn tree_with_variant_box() -> Tree {
        let mut tree = Tree::new();
        tree.apply(&Patch::Create {
            id: "box".to_string(),
            element_type: "Container".to_string(),
            props: props(&[
                ("width", json!(100)),
                ("height", json!(100)),
                ("backgroundColor.0", json!("#ff0000")), // base: red
                ("backgroundColor:hover.0", json!("#0000ff")), // hover: blue
                ("backgroundColor@md.0", json!("#00ff00")), // md: green
            ]),
            semantics: None,
        });
        tree.apply(&Patch::Insert {
            parent_id: ROOT_ID.to_string(),
            id: "box".to_string(),
            before_id: None,
        });
        tree
    }

    /// Read pixel (x, y) as (r, g, b). tiny-skia stores premultiplied RGBA;
    /// for the opaque (alpha = 255) fills here that equals straight RGB.
    /// Sample a point inside the top-left 100×100 box (so it's box-interior
    /// regardless of viewport width, unlike the pixmap center).
    fn box_rgb(painter: &CpuPainter) -> (u8, u8, u8) {
        let (w, _h) = painter.pixmap_size().expect("pixmap allocated");
        let data = painter.pixmap_data().expect("pixmap data");
        let (x, y) = (50u32, 50u32);
        let i = ((y * w + x) * 4) as usize;
        (data[i], data[i + 1], data[i + 2])
    }

    #[test]
    fn hover_state_variant_changes_painted_background() {
        let tree = tree_with_variant_box();
        let mut painter = CpuPainter::new();

        // Narrow viewport (md inactive), not hovered → base red.
        painter.paint_with_scroll(&tree, PaintTarget::new(100, 100, 1.0), 0.0);
        assert_eq!(
            box_rgb(&painter),
            (0xff, 0x00, 0x00),
            "base background should be red"
        );

        // Hover the box → blue variant wins (state outranks breakpoint).
        painter.interaction_mut().hovered.insert("box".to_string());
        painter.paint_with_scroll(&tree, PaintTarget::new(100, 100, 1.0), 0.0);
        assert_eq!(
            box_rgb(&painter),
            (0x00, 0x00, 0xff),
            "hover background should be blue"
        );

        // Stop hovering → back to base red (variant is reversible per frame).
        painter.interaction_mut().hovered.clear();
        painter.paint_with_scroll(&tree, PaintTarget::new(100, 100, 1.0), 0.0);
        assert_eq!(
            box_rgb(&painter),
            (0xff, 0x00, 0x00),
            "clearing hover should restore the base background"
        );
    }

    #[test]
    fn breakpoint_variant_changes_painted_background_at_width() {
        let tree = tree_with_variant_box();
        let mut painter = CpuPainter::new();

        // The viewport width feeds breakpoint resolution. The box is a fixed
        // 100px, but a wide surface makes @md (>=768) active.
        painter.paint_with_scroll(&tree, PaintTarget::new(800, 100, 1.0), 0.0);
        assert_eq!(
            box_rgb(&painter),
            (0x00, 0xff, 0x00),
            "at width >= 768 the @md background (green) should win"
        );
    }
}

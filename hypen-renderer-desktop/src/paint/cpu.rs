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
}

impl CpuPainter {
    pub fn new() -> Self {
        Self {
            text: TextEngine::new(),
            interaction: InteractionState::default(),
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
    pub fn paint_with_scroll(
        &mut self,
        tree: &Tree,
        target: PaintTarget<'_>,
        scroll_y: f32,
    ) {
        let PaintTarget {
            pixels,
            width,
            height,
            scale_factor,
        } = target;

        let mut pixmap = Pixmap::new(width, height).expect("pixmap alloc");
        pixmap.fill(Color::from_rgba8(0xfb, 0xfb, 0xfd, 0xff));

        let layout = LayoutPass::compute_with_scroll(
            tree,
            &mut self.text,
            (width, height),
            scale_factor,
            scroll_y,
        );

        for item in &layout.items {
            // Background and border apply to every element type. Buttons
            // additionally tint based on hover/press state.
            let mut background = item.background;
            let mut border_color = item.border.color;
            if matches!(item.kind, ItemKind::Button) {
                if self.interaction.pressed.contains(&item.node_id) {
                    if let Some(bg) = background.as_mut() {
                        *bg = darken(*bg, 0.85);
                    }
                    border_color = darken(border_color, 0.7);
                } else if self.interaction.hovered.contains(&item.node_id) {
                    if let Some(bg) = background.as_mut() {
                        *bg = lighten(*bg, 1.05);
                    }
                }
            }

            let radius = item.border.radius * scale_factor;
            if let Some(bg) = background {
                fill_rect(&mut pixmap, item.rect, bg, radius);
            }
            if item.border.is_visible() {
                stroke_rect(
                    &mut pixmap,
                    item.rect,
                    border_color,
                    radius,
                    item.border.width * scale_factor,
                );
            }

            match &item.kind {
                ItemKind::Text {
                    content,
                    font_size,
                    color,
                } => {
                    self.text.draw_text_colored(
                        &mut pixmap,
                        content,
                        item.rect.x,
                        item.rect.y,
                        *font_size * scale_factor,
                        *color,
                        Some(item.rect.w),
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
                            self.text.draw_text_colored(
                                &mut pixmap,
                                p,
                                text_x,
                                text_y,
                                *font_size * scale_factor,
                                Rgba(0x90, 0x96, 0xa1, 0xff),
                                Some(inner_w),
                            );
                        }
                    } else {
                        self.text.draw_text_colored(
                            &mut pixmap,
                            value,
                            text_x,
                            text_y,
                            *font_size * scale_factor,
                            *color,
                            Some(inner_w),
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
                            fill_rect(&mut pixmap, band, Rgba(0x00, 0x7a, 0xff, 0x55), 0.0);
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
                                let (pre_w, _) = self.text.measure(
                                    pre,
                                    *font_size * scale_factor,
                                    None,
                                );
                                // Paint preedit inline at caret_x in the
                                // text colour, then a thin underline to
                                // show it isn't committed yet.
                                self.text.draw_text_colored(
                                    &mut pixmap,
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
                                fill_rect(
                                    &mut pixmap,
                                    underline,
                                    Rgba(0x00, 0x7a, 0xff, 0xff),
                                    0.0,
                                );
                                caret_x += pre_w;
                            }
                            let caret = crate::layout::Rect {
                                x: caret_x,
                                y: text_y,
                                w: 1.5 * scale_factor,
                                h: h_px,
                            };
                            fill_rect(
                                &mut pixmap,
                                caret,
                                Rgba(0x00, 0x7a, 0xff, 0xff),
                                0.0,
                            );
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
                draw_focus_ring(&mut pixmap, item.rect, scale_factor);
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
                &mut pixmap,
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

        let src = pixmap.data();
        debug_assert_eq!(src.len(), pixels.len());
        pixels.copy_from_slice(src);
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
    if let Some(path) = rounded_rect_path(ring_rect.x, ring_rect.y, ring_rect.w, ring_rect.h, radius) {
        pixmap.stroke_path(&path, &paint, &stroke, Transform::identity(), None);
    }
}

fn rounded_rect_path(x: f32, y: f32, w: f32, h: f32, r: f32) -> Option<tiny_skia::Path> {
    if w <= 0.0 || h <= 0.0 {
        return None;
    }
    let r = r.min(w * 0.5).min(h * 0.5).max(0.0);
    let rect = Rect::from_xywh(x, y, w, h)?;
    if r <= 0.0 {
        let mut pb = PathBuilder::new();
        pb.push_rect(rect);
        return pb.finish();
    }
    let mut pb = PathBuilder::new();
    pb.move_to(x + r, y);
    pb.line_to(x + w - r, y);
    pb.quad_to(x + w, y, x + w, y + r);
    pb.line_to(x + w, y + h - r);
    pb.quad_to(x + w, y + h, x + w - r, y + h);
    pb.line_to(x + r, y + h);
    pb.quad_to(x, y + h, x, y + h - r);
    pb.line_to(x, y + r);
    pb.quad_to(x, y, x + r, y);
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
        assert!(path.is_some(), "expected a Some(path) even with oversized radius");
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
        assert!(found_red, "expected at least one red-tinted pixel in the filled rect");
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

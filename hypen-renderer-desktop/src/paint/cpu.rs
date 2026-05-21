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
    /// Renderer node id of the keyboard-focused actionable, if any.
    pub focused: Option<String>,
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
        let PaintTarget {
            pixels,
            width,
            height,
            scale_factor,
        } = target;

        let mut pixmap = Pixmap::new(width, height).expect("pixmap alloc");
        pixmap.fill(Color::from_rgba8(0xfb, 0xfb, 0xfd, 0xff));

        let layout = LayoutPass::compute(tree, &mut self.text, (width, height), scale_factor);

        for item in &layout.items {
            match &item.kind {
                ItemKind::Container { background } => {
                    if let Some(bg) = background {
                        fill_rect(&mut pixmap, item.rect, *bg, 0.0);
                    }
                }
                ItemKind::Text {
                    content,
                    font_size,
                    color,
                } => {
                    // Re-shape with the rect's width so wrapped lines
                    // paint exactly where the layout placed them.
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
                ItemKind::Button { background, border } => {
                    let mut bg = *background;
                    let mut br = *border;
                    if self.interaction.pressed.contains(&item.node_id) {
                        bg = darken(bg, 0.85);
                        br = darken(br, 0.7);
                    } else if self.interaction.hovered.contains(&item.node_id) {
                        bg = lighten(bg, 1.05);
                    }
                    fill_rect(&mut pixmap, item.rect, bg, 8.0 * scale_factor);
                    stroke_rect(&mut pixmap, item.rect, br, 8.0 * scale_factor, scale_factor);
                }
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
    scale: f32,
) {
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
    let stroke = Stroke {
        width: 1.0 * scale,
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
    use super::{darken, lighten};
    use crate::style::Rgba;

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
}

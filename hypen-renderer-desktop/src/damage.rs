//! Per-frame damage tracking.
//!
//! Drives both CPU paint scoping (skip items that don't intersect the
//! damage rect; clear only that rect with the page background) and
//! GPU upload scoping (`queue.write_texture` a sub-region of the
//! upload texture instead of the whole surface).
//!
//! Hover and press transitions are the high-frequency callers — every
//! mouse move that walks across button boundaries used to repaint and
//! upload the full surface; with `Damage::Region`, only the union of
//! the old and new button rects gets touched.

use crate::layout::Rect;

#[derive(Debug, Clone, Copy)]
pub(crate) enum Damage {
    /// No damage queued. A redraw with this state should still paint —
    /// winit asked us to. Treated as `Full` defensively.
    None,
    /// One bounding rect (in physical pixels). High-frequency events
    /// accumulate into this by union with the existing region.
    Region(Rect),
    /// Whole surface needs repaint. Sticky once set: any further
    /// `add_region` keeps `Full`.
    Full,
}

impl Damage {
    pub(crate) fn add_region(&mut self, rect: Rect) {
        *self = match *self {
            Damage::None => Damage::Region(rect),
            Damage::Region(prev) => Damage::Region(union_rect(prev, rect)),
            Damage::Full => Damage::Full,
        };
    }

    pub(crate) fn add_full(&mut self) {
        *self = Damage::Full;
    }
}

pub(crate) fn union_rect(a: Rect, b: Rect) -> Rect {
    let x0 = a.x.min(b.x);
    let y0 = a.y.min(b.y);
    let x1 = (a.x + a.w).max(b.x + b.w);
    let y1 = (a.y + a.h).max(b.y + b.h);
    Rect {
        x: x0,
        y: y0,
        w: (x1 - x0).max(0.0),
        h: (y1 - y0).max(0.0),
    }
}

pub(crate) fn rects_intersect(a: Rect, b: Rect) -> bool {
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: f32, y: f32, w: f32, h: f32) -> Rect {
        Rect { x, y, w, h }
    }

    #[test]
    fn damage_default_is_none() {
        let d = Damage::None;
        assert!(matches!(d, Damage::None));
    }

    #[test]
    fn damage_add_region_unions_with_existing() {
        let mut d = Damage::None;
        d.add_region(rect(0.0, 0.0, 10.0, 10.0));
        d.add_region(rect(20.0, 30.0, 5.0, 5.0));
        match d {
            Damage::Region(r) => {
                assert!(r.x <= 0.0 && r.y <= 0.0);
                assert!((r.x + r.w) >= 25.0);
                assert!((r.y + r.h) >= 35.0);
            }
            _ => panic!("expected Damage::Region"),
        }
    }

    #[test]
    fn damage_full_overrides_region() {
        let mut d = Damage::None;
        d.add_region(rect(0.0, 0.0, 10.0, 10.0));
        d.add_full();
        assert!(matches!(d, Damage::Full));
    }

    #[test]
    fn damage_region_does_not_downgrade_full() {
        let mut d = Damage::Full;
        d.add_region(rect(0.0, 0.0, 10.0, 10.0));
        assert!(matches!(d, Damage::Full));
    }

    #[test]
    fn rects_intersect_overlapping_returns_true() {
        assert!(rects_intersect(
            rect(0.0, 0.0, 10.0, 10.0),
            rect(5.0, 5.0, 10.0, 10.0)
        ));
    }

    #[test]
    fn rects_intersect_disjoint_returns_false() {
        assert!(!rects_intersect(
            rect(0.0, 0.0, 10.0, 10.0),
            rect(20.0, 20.0, 5.0, 5.0)
        ));
    }

    #[test]
    fn rects_intersect_touching_edges_returns_false() {
        // Half-open semantics: edge-touching counts as non-overlap so
        // borders of adjacent items don't double-paint.
        assert!(!rects_intersect(
            rect(0.0, 0.0, 10.0, 10.0),
            rect(10.0, 0.0, 10.0, 10.0)
        ));
    }

    #[test]
    fn union_rect_covers_both_inputs() {
        let u = union_rect(
            rect(0.0, 0.0, 10.0, 10.0),
            rect(20.0, 30.0, 5.0, 5.0),
        );
        assert_eq!(u.x, 0.0);
        assert_eq!(u.y, 0.0);
        assert_eq!(u.x + u.w, 25.0);
        assert_eq!(u.y + u.h, 35.0);
    }
}

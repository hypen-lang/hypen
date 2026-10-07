//! Multi-line (`Textarea`) text geometry: soft-wrapped visual lines,
//! caret placement, hit-testing, vertical caret movement, selection
//! bands, and inner-scroll math.
//!
//! `Textarea` shares `ItemKind::Input` (with `multiline: true`) and every
//! editing path with `Input` — value / selection state, `__hypen_bind`
//! write-back, IME, clipboard. What differs is geometry: an Input is one
//! unwrapped run, so a prefix-width measure places its caret. A Textarea
//! wraps to its content width and honours hard newlines, so caret math
//! has to go through the same cosmic-text layout the painter draws with.
//! [`crate::text::TextEngine::visual_lines`] produces that layout as
//! plain data ([`VisualLine`]); everything in this module is pure over
//! it, so it is unit-testable without a window.
//!
//! All coordinates are relative to the text origin (content-box top-left,
//! before inner scroll) in the same units the lines were laid out in
//! (physical pixels at every call site).

/// One shaped glyph cluster on a visual line. `start..end` are GLOBAL
/// byte offsets into the laid-out string.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GlyphBox {
    pub start: usize,
    pub end: usize,
    pub x: f32,
    pub w: f32,
}

/// One visual (soft-wrapped) line.
#[derive(Clone, Debug, PartialEq)]
pub struct VisualLine {
    /// Global byte offset of the first character on this line.
    pub start: usize,
    /// Global byte offset just past the last character on this line
    /// (never includes the paragraph's hard newline).
    pub end: usize,
    pub top: f32,
    pub height: f32,
    /// True when this is the last visual line of its paragraph — the
    /// caret at `end` then belongs here, not on the following line.
    pub para_end: bool,
    /// Glyph clusters in visual (left-to-right) order.
    pub glyphs: Vec<GlyphBox>,
}

impl VisualLine {
    /// Right edge of the line's ink (0 for an empty line).
    pub fn width(&self) -> f32 {
        self.glyphs.iter().map(|g| g.x + g.w).fold(0.0, f32::max)
    }
}

/// Total laid-out height of `lines`.
pub fn content_height(lines: &[VisualLine]) -> f32 {
    lines.last().map(|l| l.top + l.height).unwrap_or(0.0)
}

/// Index of the visual line that owns a caret at byte `b`.
///
/// A byte strictly inside a line belongs to it. At a soft-wrap boundary
/// (`b == end` of a non-final line, which is also the next line's
/// `start`) the caret goes to the start of the NEXT line, matching the
/// DOM. At a paragraph end it stays on that paragraph's last line.
pub fn line_index_for_offset(lines: &[VisualLine], b: usize) -> usize {
    if lines.is_empty() {
        return 0;
    }
    for (i, line) in lines.iter().enumerate() {
        if b >= line.start && (b < line.end || (b == line.end && line.para_end)) {
            return i;
        }
    }
    // Past the end, or inside a hard newline (impossible for a
    // char-boundary caret): pin to the nearest line before `b`.
    lines.iter().rposition(|l| l.start <= b).unwrap_or(0)
}

/// Caret x for byte `b` measured on `line` (no line resolution).
pub fn x_in_line(line: &VisualLine, b: usize) -> f32 {
    for g in &line.glyphs {
        if b <= g.start {
            return g.x;
        }
        if b < g.end {
            // Inside a multi-byte cluster (ligature / combining mark):
            // interpolate so the caret still lands within the cluster.
            let t = (b - g.start) as f32 / (g.end - g.start).max(1) as f32;
            return g.x + g.w * t;
        }
    }
    line.glyphs.last().map(|g| g.x + g.w).unwrap_or(0.0)
}

/// `(x, line_top, line_height)` of the caret at byte `b`.
pub fn caret_position(lines: &[VisualLine], b: usize) -> (f32, f32, f32) {
    match lines.get(line_index_for_offset(lines, b)) {
        Some(line) => (x_in_line(line, b), line.top, line.height),
        None => (0.0, 0.0, 0.0),
    }
}

/// Byte offset under the local point `(x, y)` — click-to-place-caret
/// and drag-select. Points above the first / below the last line clamp
/// to that line, like a native textarea.
pub fn offset_at_point(lines: &[VisualLine], x: f32, y: f32) -> usize {
    let Some(first) = lines.first() else {
        return 0;
    };
    let i = if y < first.top {
        0
    } else {
        lines
            .iter()
            .position(|l| y < l.top + l.height)
            .unwrap_or(lines.len() - 1)
    };
    offset_in_line(lines, i, x)
}

/// Byte offset at horizontal position `x` on `lines[i]`.
fn offset_in_line(lines: &[VisualLine], i: usize, x: f32) -> usize {
    let line = &lines[i];
    for g in &line.glyphs {
        if x < g.x + g.w * 0.5 {
            return g.start;
        }
    }
    soft_line_end(lines, i)
}

/// Where "end of visual line `i`" puts the caret. cosmic-text drops
/// the break space from a soft-wrapped line, so `end` (just before that
/// space) still renders on this line. Only when the next line starts
/// exactly at `end` (a word longer than the box broken mid-glyph run)
/// would `end` jump to the next line — step back one cluster then.
fn soft_line_end(lines: &[VisualLine], i: usize) -> usize {
    let line = &lines[i];
    if line.para_end || lines.get(i + 1).is_none_or(|next| next.start > line.end) {
        return line.end;
    }
    match line.glyphs.iter().max_by_key(|g| g.end) {
        Some(last) if last.end == line.end && last.start > line.start => last.start,
        _ => line.end,
    }
}

/// ArrowUp / ArrowDown: move the caret to the adjacent visual line,
/// keeping its x. From the first line Up goes to offset 0; from the
/// last line Down goes to `text_len` (macOS / DOM textarea behaviour).
pub fn vertical_move(lines: &[VisualLine], b: usize, down: bool, text_len: usize) -> usize {
    if lines.is_empty() {
        return if down { text_len } else { 0 };
    }
    let i = line_index_for_offset(lines, b);
    let x = x_in_line(&lines[i], b);
    if down {
        match lines.get(i + 1) {
            Some(_) => offset_in_line(lines, i + 1, x),
            None => text_len,
        }
    } else if i == 0 {
        0
    } else {
        offset_in_line(lines, i - 1, x)
    }
}

/// Home on a Textarea: start of the caret's visual line.
pub fn line_home(lines: &[VisualLine], b: usize) -> usize {
    lines
        .get(line_index_for_offset(lines, b))
        .map(|l| l.start)
        .unwrap_or(0)
}

/// End on a Textarea: end of the caret's visual line.
pub fn line_end(lines: &[VisualLine], b: usize, text_len: usize) -> usize {
    if lines.is_empty() {
        return text_len;
    }
    soft_line_end(lines, line_index_for_offset(lines, b))
}

/// Selection highlight bands `(x0, top, x1, height)` for the byte range
/// `lo..hi`, one per visual line it touches. A band that continues past
/// a line's end extends a few pixels (`newline_w`) so a selected hard
/// newline / empty line stays visible, like native text views.
pub fn selection_bands(
    lines: &[VisualLine],
    lo: usize,
    hi: usize,
    newline_w: f32,
) -> Vec<(f32, f32, f32, f32)> {
    let mut out = Vec::new();
    if lo >= hi {
        return out;
    }
    for (i, line) in lines.iter().enumerate() {
        // A line covers [start, next_start); skip lines outside lo..hi.
        let next_start = lines.get(i + 1).map(|l| l.start).unwrap_or(usize::MAX);
        if hi <= line.start || lo >= next_start.max(line.end + 1) {
            continue;
        }
        let x0 = if lo <= line.start {
            0.0
        } else {
            x_in_line(line, lo)
        };
        let x1 = if hi > line.end {
            let w = line.width();
            if line.para_end {
                w + newline_w
            } else {
                w
            }
        } else {
            x_in_line(line, hi)
        };
        if x1 > x0 {
            out.push((x0, line.top, x1, line.height));
        }
    }
    out
}

/// Clamp an inner scroll offset to `[0, content_h - view_h]`.
pub fn clamp_scroll(scroll: f32, content_h: f32, view_h: f32) -> f32 {
    scroll.min((content_h - view_h).max(0.0)).max(0.0)
}

/// Smallest scroll change that keeps the caret line
/// `[caret_top, caret_top + caret_h)` inside a `view_h`-tall viewport.
pub fn scroll_to_reveal(scroll: f32, caret_top: f32, caret_h: f32, view_h: f32) -> f32 {
    if view_h <= 0.0 {
        return scroll;
    }
    if caret_top < scroll {
        caret_top
    } else if caret_top + caret_h > scroll + view_h {
        caret_top + caret_h - view_h
    } else {
        scroll
    }
}

/// Text for a paste / IME commit into a field. A Textarea keeps line
/// breaks (normalised to `\n`, which is what Enter inserts); a
/// single-line Input folds them to spaces as before.
pub fn normalize_inserted_text(text: &str, multiline: bool) -> String {
    if multiline {
        text.replace("\r\n", "\n").replace('\r', "\n")
    } else {
        text.replace(['\n', '\r'], " ")
    }
}

/// Physical-pixel text frame of an `ItemKind::Input` item — where its
/// text is drawn and how it is shaped. The painter and the window's
/// caret / hit-test / scroll code both derive from this, so glyphs and
/// caret can never disagree.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FieldFrame {
    /// Text origin (content-box top-left, before inner scroll).
    pub text_x: f32,
    pub text_y: f32,
    /// Content-box width — the Textarea's soft-wrap width.
    pub inner_w: f32,
    /// Visible height of the text viewport (padding box minus the
    /// top/bottom padding) — what inner scroll reveals into.
    pub view_h: f32,
    /// Vertical clip `[clip_top, clip_bottom)` — the padding box.
    pub clip_top: f32,
    pub clip_bottom: f32,
    pub font_px: f32,
    pub line_px: f32,
    pub weight: u16,
    pub multiline: bool,
}

impl FieldFrame {
    /// `Some` for Input / Textarea items. `scale` is the window scale
    /// factor (item rect + padding are already physical; font size and
    /// line height are logical).
    pub fn of(item: &crate::layout::LayoutItem, scale: f32) -> Option<Self> {
        let crate::layout::ItemKind::Input {
            font_size,
            line_height,
            multiline,
            padding,
            ..
        } = &item.kind
        else {
            return None;
        };
        let (pad_l, pad_t, pad_r, pad_b) = *padding;
        let rect = item.rect;
        // Single-line Inputs keep their historical origin (border not
        // inset); a Textarea insets by its drawn top/bottom border like
        // the DOM box model, so text clears a `border-t` hairline.
        let side = |bit: u8| {
            let b = item.border;
            if *multiline && b.is_visible() && b.sides & bit != 0 {
                b.width * scale
            } else {
                0.0
            }
        };
        let border_t = side(crate::style::BORDER_SIDE_TOP);
        let border_b = side(crate::style::BORDER_SIDE_BOTTOM);
        let border_l = side(crate::style::BORDER_SIDE_LEFT);
        let border_r = side(crate::style::BORDER_SIDE_RIGHT);
        let text_x = rect.x + border_l + pad_l;
        let text_y = rect.y + border_t + pad_t;
        let inner_w = (rect.w - border_l - border_r - pad_l - pad_r).max(0.0);
        let clip_top = rect.y + border_t;
        let clip_bottom = (rect.y + rect.h - border_b).max(clip_top);
        let view_h = (clip_bottom - clip_top - pad_t - pad_b).max(0.0);
        Some(Self {
            text_x,
            text_y,
            inner_w,
            view_h,
            clip_top,
            clip_bottom,
            font_px: font_size * scale,
            line_px: line_height * scale,
            weight: item.font_weight,
            multiline: *multiline,
        })
    }

    /// Lay `text` out as this field paints it (Textarea only — an Input
    /// never wraps).
    pub fn lines(&self, engine: &mut crate::text::TextEngine, text: &str) -> Vec<VisualLine> {
        engine.visual_lines(
            text,
            self.font_px,
            Some(self.inner_w),
            self.weight,
            self.line_px,
        )
    }

    /// Clamped inner-scroll offset for `text` given a stored `scroll`.
    pub fn clamp_scroll_for(
        &self,
        engine: &mut crate::text::TextEngine,
        text: &str,
        scroll: f32,
    ) -> f32 {
        if scroll <= 0.0 {
            return 0.0;
        }
        let (_, h) = engine.measure_weighted_line_height(
            text,
            self.font_px,
            Some(self.inner_w),
            self.weight,
            self.line_px,
        );
        clamp_scroll(scroll, h, self.view_h)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::text::TextEngine;

    const FONT: f32 = 16.0;
    const LINE: f32 = 20.0;

    fn lines(engine: &mut TextEngine, text: &str, wrap: f32) -> Vec<VisualLine> {
        engine.visual_lines(text, FONT, Some(wrap), 400, LINE)
    }

    #[test]
    fn hard_newlines_make_paragraph_lines_with_global_offsets() {
        let mut e = TextEngine::new();
        let ls = lines(&mut e, "ab\ncd", 500.0);
        assert_eq!(ls.len(), 2);
        assert_eq!((ls[0].start, ls[0].end), (0, 2));
        assert_eq!((ls[1].start, ls[1].end), (3, 5));
        assert!(ls[0].para_end && ls[1].para_end);
        assert_eq!(ls[1].top, LINE);
        assert_eq!(content_height(&ls), 2.0 * LINE);
    }

    #[test]
    fn trailing_newline_and_blank_lines_are_caret_lines() {
        let mut e = TextEngine::new();
        let ls = lines(&mut e, "ab\n\n", 500.0);
        assert_eq!(ls.len(), 3, "{ls:?}");
        assert_eq!((ls[1].start, ls[1].end), (3, 3));
        assert_eq!((ls[2].start, ls[2].end), (4, 4));
        // Caret after the trailing newline sits on the new empty line.
        let (x, top, _) = caret_position(&ls, 4);
        assert_eq!((x, top), (0.0, 2.0 * LINE));
        let (_, top, _) = caret_position(&ls, 3);
        assert_eq!(top, LINE);
    }

    #[test]
    fn soft_wrap_splits_a_paragraph_into_contiguous_lines() {
        let mut e = TextEngine::new();
        let text = "alpha beta gamma delta epsilon zeta";
        let ls = lines(&mut e, text, 90.0);
        assert!(ls.len() >= 3, "{ls:?}");
        assert_eq!(ls[0].start, 0);
        for pair in ls.windows(2) {
            // The break space sits between the two lines, on neither.
            assert!(pair[0].end <= pair[1].start && pair[1].start <= pair[0].end + 1);
            assert!(!pair[0].para_end);
        }
        // End on a wrapped line stays on it (before the break space).
        let end0 = line_end(&ls, 0, text.len());
        assert_eq!(end0, ls[0].end);
        assert_eq!(line_index_for_offset(&ls, end0), 0);
        assert_eq!(ls.last().unwrap().end, text.len());
        assert!(ls.last().unwrap().para_end);
        // At a soft-wrap boundary the caret belongs to the NEXT line.
        let boundary = ls[1].start;
        assert_eq!(line_index_for_offset(&ls, boundary), 1);
        assert_eq!(caret_position(&ls, boundary).0, 0.0);
    }

    #[test]
    fn up_down_move_between_lines_keeping_x() {
        let mut e = TextEngine::new();
        let text = "hello world\nhi\nanother line";
        let ls = lines(&mut e, text, 500.0);
        // From "hel|lo" down → line 2 is only "hi", caret clamps to its end.
        let down = vertical_move(&ls, 3, true, text.len());
        assert_eq!(down, 14, "end of `hi` (offset 12..14)");
        // From the end of `hi` down → same x on "another line".
        let down2 = vertical_move(&ls, 14, true, text.len());
        assert!(down2 > 15 && down2 < 19, "x preserved on line 3: {down2}");
        // Up from line 3 back to line 2, then to line 1.
        let up = vertical_move(&ls, 15, false, text.len());
        assert_eq!(up, 12);
        let up2 = vertical_move(&ls, 13, false, text.len());
        assert!(up2 <= 2, "{up2}");
        // Up on the first line → start; Down on the last → end.
        assert_eq!(vertical_move(&ls, 4, false, text.len()), 0);
        assert_eq!(vertical_move(&ls, 20, true, text.len()), text.len());
    }

    #[test]
    fn click_maps_to_line_and_column() {
        let mut e = TextEngine::new();
        let text = "abc\ndefgh";
        let ls = lines(&mut e, text, 500.0);
        assert_eq!(offset_at_point(&ls, 0.0, LINE * 1.5), 4, "start of line 2");
        assert_eq!(offset_at_point(&ls, 1000.0, LINE * 1.5), text.len());
        assert_eq!(offset_at_point(&ls, 1000.0, 2.0), 3, "end of line 1");
        // Below the last line clamps to it; above the first to it.
        assert_eq!(offset_at_point(&ls, 0.0, 999.0), 4);
        assert_eq!(offset_at_point(&ls, 0.0, -50.0), 0);
        // Home / End are visual-line relative.
        assert_eq!(line_home(&ls, 7), 4);
        assert_eq!(line_end(&ls, 1, text.len()), 3);
    }

    #[test]
    fn selection_spanning_lines_paints_one_band_per_line() {
        let mut e = TextEngine::new();
        let ls = lines(&mut e, "abc\ndef\nghi", 500.0);
        let bands = selection_bands(&ls, 1, 9, 4.0);
        assert_eq!(bands.len(), 3, "{bands:?}");
        assert!(bands[0].0 > 0.0, "starts mid-line");
        assert_eq!(bands[1].0, 0.0, "middle line fully selected");
        assert!(bands[1].2 > ls[1].width(), "selected newline is visible");
        assert_eq!(bands[2].0, 0.0);
        assert!(selection_bands(&ls, 2, 2, 4.0).is_empty());
    }

    #[test]
    fn inner_scroll_reveals_the_caret_line() {
        // View shows 2 lines (40px) of a 5-line text.
        assert_eq!(
            scroll_to_reveal(0.0, 60.0, 20.0, 40.0),
            40.0,
            "line 4 → scroll down"
        );
        assert_eq!(
            scroll_to_reveal(40.0, 20.0, 20.0, 40.0),
            20.0,
            "line 2 → scroll up"
        );
        assert_eq!(
            scroll_to_reveal(20.0, 30.0, 10.0, 40.0),
            20.0,
            "visible: unchanged"
        );
        assert_eq!(clamp_scroll(500.0, 100.0, 40.0), 60.0);
        assert_eq!(clamp_scroll(-5.0, 100.0, 40.0), 0.0);
        assert_eq!(
            clamp_scroll(10.0, 30.0, 40.0),
            0.0,
            "no overflow, no scroll"
        );
    }

    #[test]
    fn pasted_newlines_survive_only_in_a_textarea() {
        assert_eq!(normalize_inserted_text("a\r\nb\rc\nd", true), "a\nb\nc\nd");
        assert_eq!(normalize_inserted_text("a\nb", false), "a b");
    }
}

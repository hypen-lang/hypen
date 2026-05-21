//! Tests for `crate::window`. Lives in its own file via `#[path]` so
//! `window.rs` itself stays focused on App / event-loop wiring
//! without ~200 lines of pure-helper test fixtures.

use super::*;

    fn pos(x: f64, y: f64) -> winit::dpi::PhysicalPosition<f64> {
        winit::dpi::PhysicalPosition::new(x, y)
    }

    #[test]
    fn next_click_count_first_click_is_one() {
        let now = std::time::Instant::now();
        assert_eq!(next_click_count(0, None, now, pos(0.0, 0.0), pos(10.0, 10.0)), 1);
    }

    #[test]
    fn next_click_count_close_in_time_and_space_increments() {
        let t0 = std::time::Instant::now();
        let t1 = t0 + std::time::Duration::from_millis(100);
        // 1 → 2 → 3 → wraps back to 1.
        assert_eq!(next_click_count(1, Some(t0), t1, pos(50.0, 50.0), pos(51.0, 51.0)), 2);
        assert_eq!(next_click_count(2, Some(t0), t1, pos(50.0, 50.0), pos(51.0, 51.0)), 3);
        assert_eq!(next_click_count(3, Some(t0), t1, pos(50.0, 50.0), pos(51.0, 51.0)), 1);
    }

    #[test]
    fn next_click_count_far_in_space_resets_to_one() {
        let t0 = std::time::Instant::now();
        let t1 = t0 + std::time::Duration::from_millis(50);
        assert_eq!(next_click_count(1, Some(t0), t1, pos(0.0, 0.0), pos(50.0, 50.0)), 1);
    }

    #[test]
    fn next_click_count_far_in_time_resets_to_one() {
        let t0 = std::time::Instant::now();
        let t1 = t0 + std::time::Duration::from_millis(700);
        assert_eq!(next_click_count(1, Some(t0), t1, pos(50.0, 50.0), pos(51.0, 50.0)), 1);
    }

    #[test]
    fn prev_boundary_steps_back_one_ascii_char() {
        assert_eq!(prev_char_boundary("hello", 5), 4);
        assert_eq!(prev_char_boundary("hello", 1), 0);
        assert_eq!(prev_char_boundary("hello", 0), 0);
    }

    #[test]
    fn prev_boundary_steps_over_multibyte() {
        let s = "é";
        assert_eq!(s.len(), 2);
        assert_eq!(prev_char_boundary(s, 2), 0);
    }

    #[test]
    fn next_boundary_steps_forward_one_ascii_char() {
        assert_eq!(next_char_boundary("hello", 0), 1);
        assert_eq!(next_char_boundary("hello", 4), 5);
        assert_eq!(next_char_boundary("hello", 5), 5);
    }

    #[test]
    fn next_boundary_steps_over_multibyte() {
        let s = "é";
        assert_eq!(next_char_boundary(s, 0), 2);
    }

    #[test]
    fn boundary_helpers_handle_emoji_correctly() {
        let s = "ab😀cd";
        assert_eq!(next_char_boundary(s, 2), 6);
        assert_eq!(prev_char_boundary(s, 6), 2);
    }

    #[test]
    fn clamp_scroll_pins_to_zero_when_content_fits() {
        assert_eq!(clamp_scroll(0.0, 100.0, 600.0), 0.0);
        assert_eq!(clamp_scroll(50.0, 100.0, 600.0), 0.0);
    }

    #[test]
    fn clamp_scroll_caps_at_max_offset() {
        assert_eq!(clamp_scroll(0.0, 1200.0, 600.0), 0.0);
        assert_eq!(clamp_scroll(300.0, 1200.0, 600.0), 300.0);
        assert_eq!(clamp_scroll(600.0, 1200.0, 600.0), 600.0);
        assert_eq!(clamp_scroll(900.0, 1200.0, 600.0), 600.0);
    }

    #[test]
    fn clamp_scroll_rejects_negative() {
        assert_eq!(clamp_scroll(-10.0, 1200.0, 600.0), 0.0);
    }

    // ---------------------------------------------------------------
    // Selection helpers
    // ---------------------------------------------------------------

    #[test]
    fn selection_caret_collapses_anchor_and_head() {
        let s = Selection::caret(5);
        assert_eq!(s.anchor, 5);
        assert_eq!(s.head, 5);
        assert!(s.is_collapsed());
        assert_eq!(s.min(), 5);
        assert_eq!(s.max(), 5);
    }

    #[test]
    fn selection_range_min_max_normalise_order() {
        let forward = Selection::range(2, 7);
        assert_eq!(forward.min(), 2);
        assert_eq!(forward.max(), 7);
        assert!(!forward.is_collapsed());

        let backward = Selection::range(7, 2);
        assert_eq!(backward.min(), 2);
        assert_eq!(backward.max(), 7);
        assert!(!backward.is_collapsed());
    }

    #[test]
    fn selection_clamped_pins_each_field_to_max() {
        assert_eq!(
            Selection::range(5, 100).clamped(10),
            Selection::range(5, 10),
        );
        assert_eq!(
            Selection::range(20, 30).clamped(10),
            Selection::range(10, 10),
        );
        assert!(Selection::range(20, 30).clamped(10).is_collapsed());
    }

    // ---------------------------------------------------------------
    // replace_selection_with
    // ---------------------------------------------------------------

    #[test]
    fn replace_inserts_at_caret_when_collapsed() {
        let (new, sel) = App::replace_selection_with("hello", Selection::caret(5), " world");
        assert_eq!(new, "hello world");
        assert_eq!(sel, Selection::caret(11));
    }

    #[test]
    fn replace_at_zero_prepends() {
        let (new, sel) = App::replace_selection_with("world", Selection::caret(0), "hello ");
        assert_eq!(new, "hello world");
        assert_eq!(sel, Selection::caret(6));
    }

    #[test]
    fn replace_substitutes_a_range() {
        let (new, sel) =
            App::replace_selection_with("hello world", Selection::range(0, 5), "yo");
        assert_eq!(new, "yo world");
        assert_eq!(sel, Selection::caret(2));
    }

    #[test]
    fn replace_handles_reversed_anchor_head() {
        let (new, sel) =
            App::replace_selection_with("hello world", Selection::range(11, 6), "");
        assert_eq!(new, "hello ");
        assert_eq!(sel, Selection::caret(6));
    }

    #[test]
    fn replace_with_empty_deletes_the_selected_range() {
        let (new, sel) =
            App::replace_selection_with("abcde", Selection::range(1, 4), "");
        assert_eq!(new, "ae");
        assert_eq!(sel, Selection::caret(1));
    }

    #[test]
    fn replace_clamps_indices_past_value_length() {
        // Defensive against external state changes that shrank the
        // value before the editor caught up — past-the-end indices
        // collapse to value.len() and the replacement appends.
        let (new, sel) =
            App::replace_selection_with("abc", Selection::range(10, 20), "xy");
        assert_eq!(new, "abcxy");
        assert_eq!(sel, Selection::caret(5));
    }

    #[test]
    fn replace_handles_multibyte_correctly() {
        // "héllo" — h(1) é(2) l(1) l(1) o(1) = 6 bytes.
        // Selecting the "é" (bytes 1..3) and replacing with "i".
        let (new, sel) =
            App::replace_selection_with("héllo", Selection::range(1, 3), "i");
        assert_eq!(new, "hillo");
        assert_eq!(sel, Selection::caret(2));
    }

    // -----------------------------------------------------------------

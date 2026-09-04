//! Geometry of the island chrome — one source of truth for "how much of
//! the window does the browser's own UI cover?".
//!
//! # Why this exists
//!
//! The shell's DSL is a `Stack` whose FIRST child is the viewport
//! `Container` (full-bleed, `x=0 y=0 w=window h=window`) and whose
//! SECOND child is the island chrome, also pinned at `y=0`. The chrome
//! is a true **overlay**: the hosted app's subtree is re-rooted into the
//! viewport container, so an app opened in a tab starts at `y=0`
//! *underneath* the toolbar and tab strip. Nothing offsets it.
//!
//! The chrome is deliberately NOT declared as a safe-area inset for
//! hosted apps. It is transient floating UI — it collapses to a small
//! pill on `Esc`/hover-out — and reserving its expanded height would
//! permanently push every hosted app's content down for chrome that is
//! usually not there. Hosted apps draw under the island by design, the
//! same way web pages draw under a browser's autohiding UI. The only
//! safe-area inset in the browser window is the one the desktop
//! renderer itself installs for the macOS unified titlebar: the
//! window-controls bar (close / minimize / maximize) is drawn over the
//! content, so `SafeArea { ... }` content clears the traffic lights
//! automatically (`hypen_renderer_desktop::WINDOW_CONTROLS_BAR_HEIGHT`,
//! installed via `DesktopApp::unified_titlebar` in `main.rs`).
//!
//! # The heights
//!
//! The chrome has no fixed height in the DSL — it is content-sized, and
//! which parts are visible depends on shell state:
//!
//! | state                                    | measured height |
//! |------------------------------------------|-----------------|
//! | expanded toolbar, no tabs (home screen)   | 63 px           |
//! | expanded toolbar + tab strip (app open)   | 90 px           |
//! | collapsed pill (`Esc` / hover-out)        | 51 px           |
//!
//! Those numbers come from `chrome_height_matches_measured_layout`
//! below, which lays the real shell tree out through the desktop
//! renderer's own Taffy pass. They shift by a few px with the platform
//! text metrics (the renderer shapes with system fonts), so the
//! constants here are the measured values rounded up to a tidy grid and
//! the test asserts agreement within a tolerance rather than exactly.
//!
//! # Scoping: no `SafeArea` in the shell's own DSL
//!
//! The browser forwards ONE merged tree (shell chrome + the active
//! tab's app), so shell UI positions itself relative to the chrome with
//! plain padding — derived from the constants below (see `shell_ui()`)
//! instead of hand-tuned magic numbers, so chrome geometry has one
//! definition.

use crate::shell::ShellState;

/// Height of the expanded toolbar row (home / refresh, URL input,
/// debug + pin buttons) including the island's 1px border. Measured 63.
pub const TOOLBAR_HEIGHT: f32 = 64.0;

/// Extra height the tab strip adds under the toolbar when at least one
/// tab is open. Measured 90 - 63 = 27.
pub const TAB_STRIP_HEIGHT: f32 = 28.0;

/// Height of the collapsed island — the pill showing either the active
/// tab's URL and status or the Home label. Measured 51.
pub const COLLAPSED_PILL_HEIGHT: f32 = 52.0;

/// Logical-px height the island chrome occupies at the top of the
/// window for `state`.
///
/// Mirrors the two `If` gates in the shell DSL exactly: the toolbar is
/// expanded only while the island is expanded, and the tab strip renders
/// alongside it only when there are tabs. Every collapsed state uses the
/// pill, including the first-open Home screen.
pub fn chrome_height(state: &ShellState) -> f32 {
    if state.island_expanded {
        let strip = if state.has_tabs {
            TAB_STRIP_HEIGHT
        } else {
            0.0
        };
        TOOLBAR_HEIGHT + strip
    } else {
        COLLAPSED_PILL_HEIGHT
    }
}

/// The tallest the chrome ever gets: expanded toolbar plus tab strip,
/// which is also the configuration a hosted app is normally viewed in
/// (an app implies an open tab, and the island is pinned open by
/// default).
pub fn max_chrome_height() -> f32 {
    chrome_height(&ShellState {
        island_expanded: true,
        has_tabs: true,
        ..ShellState::default()
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shell::{build_shell_module, TabInfo};
    use hypen_engine::Patch;
    use hypen_renderer_desktop::layout::LayoutPass;
    use hypen_renderer_desktop::text::TextEngine;
    use hypen_renderer_desktop::Tree;
    use hypen_server::prelude::*;
    use std::sync::{mpsc, Arc, Mutex};

    /// The window size `main.rs` opens with — the layout probe below
    /// measures at the same viewport the browser actually runs at.
    const VIEWPORT: (u32, u32) = (1024, 720);

    fn state(island_expanded: bool, has_tabs: bool) -> ShellState {
        ShellState {
            island_expanded,
            has_tabs,
            ..ShellState::default()
        }
    }

    #[test]
    fn expanded_toolbar_alone_covers_the_toolbar_height() {
        assert_eq!(chrome_height(&state(true, false)), TOOLBAR_HEIGHT);
    }

    #[test]
    fn tab_strip_stacks_under_the_toolbar() {
        assert_eq!(
            chrome_height(&state(true, true)),
            TOOLBAR_HEIGHT + TAB_STRIP_HEIGHT
        );
    }

    #[test]
    fn collapsed_island_only_covers_the_pill() {
        assert_eq!(chrome_height(&state(false, true)), COLLAPSED_PILL_HEIGHT);
    }

    #[test]
    fn collapsing_with_no_tabs_shows_the_home_pill() {
        assert_eq!(chrome_height(&state(false, false)), COLLAPSED_PILL_HEIGHT);
    }

    #[test]
    fn max_chrome_height_is_the_maximum_over_every_state() {
        let max = [
            state(true, true),
            state(true, false),
            state(false, true),
            state(false, false),
        ]
        .iter()
        .map(chrome_height)
        .fold(f32::MIN, f32::max);
        assert_eq!(max_chrome_height(), max);
    }

    /// Lay the real shell tree out through the desktop renderer's own
    /// layout pass and check [`chrome_height`] against the measured
    /// height of the chrome node in each state.
    ///
    /// This is also the assertion that the *hosting* model hasn't
    /// changed underneath us: it verifies the viewport container still
    /// starts at `y=0` and spans the whole window, i.e. that a hosted
    /// app really does run under the chrome rather than below it —
    /// the overlay model the module docs describe. If the shell ever
    /// offsets the viewport instead, this fails and the shell paddings
    /// derived from these constants need a rethink.
    #[test]
    fn chrome_height_matches_measured_layout() {
        let (tx, _rx) = mpsc::channel();
        let definition = build_shell_module(tx, vec![]);
        let instance = Arc::new(
            HypenApp::default()
                .instantiate(Arc::new(definition))
                .expect("shell module instantiates"),
        );
        let tree = Arc::new(Mutex::new(Tree::new()));
        let sink = Arc::clone(&tree);
        instance.on_patches(move |patches: &[Patch]| {
            sink.lock().expect("tree poisoned").apply_batch(patches);
        });
        instance.mount();

        let mut text = TextEngine::new();
        // Measured geometry of the shell's two root-level children:
        // (viewport container rect, chrome height).
        let measure = |text: &mut TextEngine| -> (hypen_renderer_desktop::layout::Rect, f32) {
            let tree = tree.lock().expect("tree poisoned");
            let pass = LayoutPass::compute(&tree, text, VIEWPORT, 1.0);
            let root = tree.root_children().first().expect("root Stack").clone();
            let children = tree.children_of(&root).to_vec();
            let rect = |id: &str| pass.item_by_id(id).expect("laid out").rect;
            (rect(&children[0]), rect(&children[1]).h)
        };

        let (viewport, toolbar_only) = measure(&mut text);
        assert_eq!(
            (viewport.x, viewport.y),
            (0.0, 0.0),
            "the hosted app's viewport must start at the window origin, under the chrome",
        );
        assert_eq!(
            (viewport.w, viewport.h),
            (VIEWPORT.0 as f32, VIEWPORT.1 as f32),
            "the viewport must be full-bleed — the chrome is an overlay, not a header",
        );

        instance
            .dispatch_action("island_hover", Some(serde_json::json!({"hovered": false})))
            .expect("home hover-out collapses");
        let (_, collapsed_home) = measure(&mut text);

        instance
            .dispatch_action("island_hover", Some(serde_json::json!({"hovered": true})))
            .expect("home hover-in expands");
        crate::shell::push_tabs(
            &instance,
            vec![TabInfo {
                id: "t-1".into(),
                url: "ws://localhost:3000".into(),
                name: "Localhost".into(),
                status: "connected".into(),
                status_message: String::new(),
            }],
            Some("t-1".into()),
        );
        // Publishing the first active tab intentionally auto-collapses the
        // chrome. Reopen it so this probe measures the distinct expanded
        // toolbar + tab-strip state named below, rather than relabelling the
        // collapsed pill's geometry.
        instance
            .dispatch_action("focus_url", None)
            .expect("reopen toolbar with active tab");
        let (_, with_tab_strip) = measure(&mut text);

        instance
            .dispatch_action("esc", None)
            .expect("esc collapses");
        let (_, collapsed) = measure(&mut text);

        // Text shaping uses system fonts, so the exact pixel height
        // moves a little between platforms; the constants are the
        // measured values rounded onto a 4px grid. A failure here means
        // the chrome's real height has drifted far enough that the
        // shell paddings derived from these constants would visibly
        // over- or under-shoot.
        for (label, declared, measured) in [
            (
                "toolbar only",
                chrome_height(&state(true, false)),
                toolbar_only,
            ),
            (
                "collapsed home pill",
                chrome_height(&state(false, false)),
                collapsed_home,
            ),
            (
                "toolbar + tab strip",
                chrome_height(&state(true, true)),
                with_tab_strip,
            ),
            (
                "collapsed pill",
                chrome_height(&state(false, true)),
                collapsed,
            ),
        ] {
            assert!(
                (declared - measured).abs() <= 12.0,
                "{label}: declared {declared} px vs measured {measured} px — \
                 update the constants in chrome.rs",
            );
        }
    }
}

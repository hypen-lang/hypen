//! The browser "shell" — a local Hypen module that renders:
//!
//! * the home page (URL bar + 6-cell "Last opened" grid), AND
//! * a floating island overlay with a tab strip and address bar that
//!   collapses to a small pill on hover-out.
//!
//! The shell runs against its own [`hypen_server::ModuleInstance`]; each
//! open tab gets a separate [`hypen_renderer_desktop::RemoteModule`].
//! [`crate::browser::BrowserModule`] merges every patch stream so a
//! single window shows the shell on top of the active tab's app.

use crate::storage::{pretty_name, RecentApp};
use hypen_server::prelude::*;
use serde::{Deserialize, Serialize};
use std::sync::mpsc::Sender;

/// One open tab in the browser shell. Mirrors the data the UI needs to
/// render the tab strip — the `RemoteModule` lives in the
/// [`crate::browser::BrowserModule`], keyed by `id`.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TabInfo {
    pub id: String,
    pub url: String,
    pub name: String,
    /// Latest [`hypen_renderer_desktop::ConnectionStatus`] for this
    /// tab, stringified for the DSL (`"connecting"`, `"connected"`,
    /// `"reconnecting"`, `"failed"`, `"closed"`).
    pub status: String,
    /// Human-readable detail for `failed` / `reconnecting` (e.g.
    /// `"attempt 3"` or `"could not connect to ws://x"`). Empty
    /// otherwise.
    pub status_message: String,
}

/// Reactive state for the shell module.
///
/// Field names are deliberately distinctive (`url_input`, `tabs`,
/// `recents`, etc.) so the BrowserModule can route `__hypen_bind`
/// dispatches based on the bind path without ambiguity against a
/// connected remote app's state.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ShellState {
    /// Address-bar input (two-way bound to the URL `Input`).
    pub url_input: String,
    /// `true` when the floating island shows the full URL bar +
    /// tab strip; `false` when it's collapsed to the active-tab chip.
    pub island_expanded: bool,
    /// Recent visits, capped at 6 by [`crate::storage::Storage`].
    pub recents: Vec<RecentApp>,
    /// Open tabs in display order. Empty when no app is open — the
    /// home screen renders in that case.
    pub tabs: Vec<TabInfo>,
    /// The currently-visible tab's id. `None` when `tabs` is empty.
    pub active_tab_id: String,
}

impl ShellState {
    pub fn home(recents: Vec<RecentApp>) -> Self {
        Self {
            url_input: String::new(),
            island_expanded: true,
            recents,
            tabs: Vec::new(),
            active_tab_id: String::new(),
        }
    }
}

/// Commands the shell dispatches back to the binary so it can spin
/// up / tear down [`hypen_renderer_desktop::RemoteModule`]s for each
/// tab. Sent over an mpsc channel; [`crate::browser::BrowserModule`]
/// drains it after every action.
#[derive(Debug, Clone)]
pub enum ShellCommand {
    /// Open a new tab connected to `url`. The browser will assign the
    /// tab id and call back into the shell via `__add_tab` once the
    /// `RemoteModule` exists.
    OpenTab { url: String, name: String },
    /// Drop the active tab's connection and start a fresh one to the
    /// same URL — what Cmd+R / the refresh button do.
    Refresh,
    /// Close a tab by id. If it was active, the browser picks the
    /// next tab as active (or goes home if it was the last).
    CloseTab { tab_id: String },
    /// Switch the active tab. The browser swaps which RemoteModule's
    /// patches reach the viewport.
    SwitchTab { tab_id: String },
    /// Close every tab and return to the home screen.
    GoHome,
    /// Drop a recent-apps entry by URL.
    DeleteRecent { url: String },
}

/// Build the shell module: state + handlers + UI source. Captures
/// `cmd_tx` so every navigation action can ask the outer browser to
/// spin tabs up / down.
pub fn build_shell_module(
    cmd_tx: Sender<ShellCommand>,
    recents: Vec<RecentApp>,
) -> ModuleDefinition<ShellState> {
    let tx_connect = cmd_tx.clone();
    let tx_recent = cmd_tx.clone();
    let tx_home = cmd_tx.clone();
    let tx_refresh = cmd_tx.clone();
    let tx_close = cmd_tx.clone();
    let tx_switch = cmd_tx.clone();
    let tx_delete = cmd_tx;

    HypenApp::module::<ShellState>("Shell")
        .state(ShellState::home(recents))
        .ui(SHELL_UI)
        .on_action::<()>("connect", move |state, _payload, _ctx| {
            let raw = state.url_input.trim().to_string();
            if raw.is_empty() {
                return;
            }
            let normalized = crate::storage::normalize_url(&raw);
            let name = pretty_name(&normalized);
            state.island_expanded = false;
            // Optimistic clear — once the tab exists the user can type
            // a new URL in for the next tab.
            state.url_input.clear();
            let _ = tx_connect.send(ShellCommand::OpenTab {
                url: normalized,
                name,
            });
        })
        .on_action::<ConnectRecentPayload>("connect_recent", move |state, payload, _ctx| {
            let url = crate::storage::normalize_url(&payload.url);
            let display = payload.name.unwrap_or_else(|| pretty_name(&url));
            state.island_expanded = false;
            state.url_input.clear();
            let _ = tx_recent.send(ShellCommand::OpenTab {
                url,
                name: display,
            });
        })
        .on_action::<()>("go_home", move |state, _payload, _ctx| {
            state.island_expanded = true;
            let _ = tx_home.send(ShellCommand::GoHome);
        })
        .on_action::<()>("refresh", move |_state, _payload, _ctx| {
            let _ = tx_refresh.send(ShellCommand::Refresh);
        })
        .on_action::<CloseTabPayload>("close_tab", move |_state, payload, _ctx| {
            let _ = tx_close.send(ShellCommand::CloseTab { tab_id: payload.tab_id });
        })
        .on_action::<SwitchTabPayload>("switch_tab", move |state, payload, _ctx| {
            // Optimistic: flip the active tab in the UI immediately so
            // the strip highlight tracks the click without waiting for
            // the wrapper's patches to redraw.
            state.active_tab_id = payload.tab_id.clone();
            let _ = tx_switch.send(ShellCommand::SwitchTab { tab_id: payload.tab_id });
        })
        .on_action::<DeleteRecentPayload>("delete_recent", move |state, payload, _ctx| {
            state.recents.retain(|r| r.url != payload.url);
            let _ = tx_delete.send(ShellCommand::DeleteRecent { url: payload.url });
        })
        .on_action::<()>("toggle_island", |state, _payload, _ctx| {
            state.island_expanded = !state.island_expanded;
        })
        .on_action::<HoverPayload>("island_hover", |state, payload, _ctx| {
            // Hover-driven expand: pointer over the island chip
            // expands the bar; leaving collapses it. Click `toggle`
            // still works as a touchpad-friendly fallback.
            state.island_expanded = payload.hovered;
        })
        .on_action::<()>("focus_url", |state, _payload, _ctx| {
            // Cmd+L: bring the island up so the URL bar is visible
            // and editable. (Programmatic Input focus isn't a
            // renderer primitive yet — for now, expanding is the
            // closest equivalent.)
            state.island_expanded = true;
        })
        .on_action::<()>("esc", |state, _payload, _ctx| {
            // Esc collapses the expanded island chrome to its chip.
            if state.island_expanded {
                state.island_expanded = false;
            }
        })
        // Internal reducer that the wrapper fires after a successful
        // connect so the next visit to the home screen reflects the
        // freshest history.
        .on_action::<RecentsPayload>("__set_recents", |state, payload, _ctx| {
            state.recents = payload.recents;
        })
        // Internal: wrapper-side updates after a tab is created / its
        // status changes / it's removed. Lets the strip render the
        // latest `connecting → connected → failed` for each tab
        // without the shell having to know about RemoteModules.
        .on_action::<TabsUpdatePayload>("__set_tabs", |state, payload, _ctx| {
            state.tabs = payload.tabs;
            state.active_tab_id = payload.active_tab_id;
        })
        .build()
}

/// Push a freshly-loaded recents list into the shell instance.
pub fn push_recents(
    instance: &ModuleInstance<ShellState>,
    recents: Vec<RecentApp>,
) {
    let payload = serde_json::to_value(RecentsPayload { recents }).ok();
    if let Err(e) = instance.dispatch_action("__set_recents", payload) {
        log::warn!("hypen-browser: failed to refresh recents: {e:?}");
    }
}

/// Push the latest tab list + active id from the BrowserModule into
/// the shell state. Called after every connect / refresh / close /
/// switch and on every per-tab connection-status change.
pub fn push_tabs(
    instance: &ModuleInstance<ShellState>,
    tabs: Vec<TabInfo>,
    active_tab_id: Option<String>,
) {
    let payload = serde_json::to_value(TabsUpdatePayload {
        tabs,
        active_tab_id: active_tab_id.unwrap_or_default(),
    })
    .ok();
    if let Err(e) = instance.dispatch_action("__set_tabs", payload) {
        log::warn!("hypen-browser: failed to refresh tabs: {e:?}");
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct ConnectRecentPayload {
    pub url: String,
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CloseTabPayload {
    #[serde(rename = "tabId", alias = "tab_id")]
    pub tab_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SwitchTabPayload {
    #[serde(rename = "tabId", alias = "tab_id")]
    pub tab_id: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct DeleteRecentPayload {
    pub url: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct HoverPayload {
    #[serde(default)]
    pub hovered: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RecentsPayload {
    pub recents: Vec<RecentApp>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TabsUpdatePayload {
    pub tabs: Vec<TabInfo>,
    #[serde(default, rename = "activeTabId", alias = "active_tab_id")]
    pub active_tab_id: String,
}

/// The shell's DSL.
///
/// Structure:
/// ```text
/// Stack {                       // root — children-after-first overlay
///     Container { viewport }    // BASE: home screen (no tabs) or empty
///                               // pad for the active tab's remote app
///     Column { island }         // OVERLAY: floating chrome bar; hides
///                               // entirely when no tabs are open
/// }
/// ```
const SHELL_UI: &str = r##"
Stack {
    Container {
        If(condition: "@{length(state.tabs) == 0}") {
            Column {
                Text("Hypen Browser")
                    .fontSize(40)
                    .color("#0f172a")
                Text("Open any Hypen app over WebSocket — no installs, no servers.")
                    .fontSize(15)
                    .color("#475569")
                    .marginTop(8)
                Row {
                    Input(placeholder: "ws://localhost:3000")
                        .bind(@state.url_input)
                        .backgroundColor("white")
                        .borderWidth(1)
                        .borderColor("#cbd5f5")
                        .borderRadius(10)
                        .padding(14)
                        .fontSize(15)
                        .width(440)
                    Button("@actions.connect") {
                        Text("Open")
                            .color("white")
                            .fontSize(15)
                    }
                        .backgroundColor("#3554d1")
                        .borderWidth(0)
                        .borderRadius(10)
                        .padding(14)
                }
                    .gap(8)
                    .marginTop(20)

                Text("Last opened")
                    .fontSize(18)
                    .color("#0f172a")
                    .marginTop(36)

                If(condition: "@{length(state.recents) == 0}") {
                    Text("No apps opened yet. Paste a Hypen RemoteServer URL above and press Open.")
                        .fontSize(13)
                        .color("#64748b")
                        .marginTop(8)
                }

                If(condition: "@{length(state.recents) > 0}") {
                    Column {
                        ForEach(items: @state.recents, key: "id") {
                            Row {
                                Button {
                                    Column {
                                        Text("@{item.name}")
                                            .fontSize(15)
                                            .color("#0f172a")
                                        Text("@{item.url}")
                                            .fontSize(12)
                                            .color("#64748b")
                                            .marginTop(4)
                                    }
                                }
                                    .backgroundColor("white")
                                    .borderWidth(0)
                                    .padding(16)
                                    .width(500)
                                    .onClick(@actions.connect_recent, url: "@{item.url}", name: "@{item.name}")
                                Button {
                                    Text("×")
                                        .color("#94a3b8")
                                        .fontSize(18)
                                }
                                    .backgroundColor("white")
                                    .borderWidth(0)
                                    .padding(16)
                                    .onClick(@actions.delete_recent, url: "@{item.url}")
                            }
                                .backgroundColor("white")
                                .borderWidth(1)
                                .borderColor("#e2e8f0")
                                .borderRadius(12)
                                .marginTop(10)
                        }
                    }
                        .marginTop(8)
                }
            }
                .padding(56)
        }
    }
        .backgroundColor("#f1f5f9")

    Column {
        If(condition: "@{length(state.tabs) > 0}") {
            If(condition: "@{!state.island_expanded}") {
                Row {
                    Button {
                        Row {
                            Text("●")
                                .color("#34d399")
                                .fontSize(10)
                            Text("@{length(state.tabs)} tab(s)")
                                .color("white")
                                .fontSize(13)
                                .marginLeft(8)
                            Text("▾")
                                .color("#cbd5f5")
                                .fontSize(11)
                                .marginLeft(8)
                        }
                    }
                        .backgroundColor("#0f172a")
                        .borderWidth(0)
                        .borderRadius(999)
                        .padding(10)
                        .onClick(@actions.toggle_island)
                        .onHover(@actions.island_hover)
                }
                    .gap(8)
            }
            If(condition: "@{state.island_expanded}") {
                Column {
                    Row {
                        ForEach(items: @state.tabs, key: "id") {
                            Row {
                                Button {
                                    Row {
                                        Text("@{item.name}")
                                            .color("white")
                                            .fontSize(12)
                                    }
                                }
                                    .backgroundColor("#1e293b")
                                    .borderWidth(0)
                                    .borderRadius(8)
                                    .padding(8)
                                    .onClick(@actions.switch_tab, tabId: "@{item.id}")
                                Button {
                                    Text("×")
                                        .color("#94a3b8")
                                        .fontSize(12)
                                }
                                    .backgroundColor("#1e293b")
                                    .borderWidth(0)
                                    .borderRadius(8)
                                    .padding(8)
                                    .onClick(@actions.close_tab, tabId: "@{item.id}")
                            }
                                .gap(2)
                        }
                    }
                        .gap(6)
                    Row {
                        Button {
                            Text("⌂")
                                .color("white")
                                .fontSize(15)
                        }
                            .backgroundColor("#1e293b")
                            .borderWidth(0)
                            .borderRadius(999)
                            .padding(10)
                            .onClick(@actions.go_home)
                        Button {
                            Text("⟳")
                                .color("white")
                                .fontSize(15)
                        }
                            .backgroundColor("#1e293b")
                            .borderWidth(0)
                            .borderRadius(999)
                            .padding(10)
                            .onClick(@actions.refresh)
                        Input(placeholder: "ws://…")
                            .bind(@state.url_input)
                            .backgroundColor("#1e293b")
                            .color("white")
                            .borderWidth(0)
                            .borderRadius(10)
                            .padding(10)
                            .fontSize(13)
                            .width(320)
                        Button("@actions.connect") {
                            Text("Go")
                                .color("white")
                                .fontSize(13)
                        }
                            .backgroundColor("#3554d1")
                            .borderWidth(0)
                            .borderRadius(10)
                            .padding(10)
                        Button {
                            Text("—")
                                .color("white")
                                .fontSize(13)
                        }
                            .backgroundColor("#1e293b")
                            .borderWidth(0)
                            .borderRadius(999)
                            .padding(10)
                            .onClick(@actions.toggle_island)
                    }
                        .gap(6)
                        .marginTop(8)
                }
                    .padding(8)
                    .backgroundColor("#0f172a")
                    .borderRadius(14)
                    .onHover(@actions.island_hover)
            }
        }
    }
        .marginTop(14)
}
"##;

/// Action names the shell handles. Used by the BrowserModule to
/// decide whether an inbound action belongs to the shell or should
/// be forwarded to the active tab's remote app.
pub const SHELL_ACTIONS: &[&str] = &[
    "connect",
    "connect_recent",
    "go_home",
    "refresh",
    "close_tab",
    "switch_tab",
    "delete_recent",
    "toggle_island",
    "island_hover",
    "focus_url",
    "esc",
    "__set_recents",
    "__set_tabs",
];

/// State paths the shell owns. Used to route `__hypen_bind`. Anything
/// outside this set is forwarded to the active tab's remote app.
pub const SHELL_BIND_PATHS: &[&str] = &[
    "url_input",
    "island_expanded",
    "recents",
    "tabs",
    "active_tab_id",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn build_instance() -> (
        std::sync::Arc<ModuleInstance<ShellState>>,
        mpsc::Receiver<ShellCommand>,
    ) {
        let (tx, rx) = mpsc::channel::<ShellCommand>();
        let def = build_shell_module(tx, vec![]);
        let app = HypenApp::default();
        let instance = std::sync::Arc::new(
            app.instantiate(std::sync::Arc::new(def))
                .expect("shell module instantiates — DSL must parse and build"),
        );
        instance.mount();
        (instance, rx)
    }

    #[test]
    fn shell_module_instantiates_with_initial_state() {
        let (instance, _rx) = build_instance();
        let state = instance.get_state();
        assert!(state.tabs.is_empty(), "no tabs open at startup");
        assert!(state.active_tab_id.is_empty());
        assert!(state.island_expanded);
    }

    #[test]
    fn connect_action_emits_open_tab_command() {
        let (instance, rx) = build_instance();
        instance
            .dispatch_action(
                "__hypen_bind",
                Some(serde_json::json!({
                    "path": "url_input",
                    "value": "localhost:3000",
                })),
            )
            .expect("bind");
        instance.dispatch_action("connect", None).expect("connect");

        match rx.try_recv() {
            Ok(ShellCommand::OpenTab { url, name }) => {
                assert_eq!(url, "ws://localhost:3000");
                assert_eq!(name, "Localhost");
            }
            other => panic!("expected OpenTab, got {other:?}"),
        }
        // url_input cleared so the next tab starts fresh.
        let state = instance.get_state();
        assert!(state.url_input.is_empty(), "url_input must clear after Open");
        assert!(!state.island_expanded);
    }

    #[test]
    fn connect_with_empty_url_is_a_noop() {
        let (instance, rx) = build_instance();
        instance.dispatch_action("connect", None).unwrap();
        assert!(
            rx.try_recv().is_err(),
            "empty URL must NOT produce an OpenTab command",
        );
    }

    #[test]
    fn refresh_action_emits_refresh_command() {
        let (instance, rx) = build_instance();
        instance.dispatch_action("refresh", None).unwrap();
        assert!(matches!(rx.try_recv(), Ok(ShellCommand::Refresh)));
    }

    #[test]
    fn close_tab_action_emits_close_command_with_id() {
        let (instance, rx) = build_instance();
        instance
            .dispatch_action(
                "close_tab",
                Some(serde_json::json!({"tabId": "t-1"})),
            )
            .unwrap();
        match rx.try_recv() {
            Ok(ShellCommand::CloseTab { tab_id }) => assert_eq!(tab_id, "t-1"),
            other => panic!("expected CloseTab, got {other:?}"),
        }
    }

    #[test]
    fn switch_tab_action_updates_active_id_optimistically() {
        let (instance, rx) = build_instance();
        instance
            .dispatch_action(
                "switch_tab",
                Some(serde_json::json!({"tabId": "t-2"})),
            )
            .unwrap();
        assert_eq!(instance.get_state().active_tab_id, "t-2");
        assert!(matches!(
            rx.try_recv(),
            Ok(ShellCommand::SwitchTab { tab_id }) if tab_id == "t-2"
        ));
    }

    #[test]
    fn delete_recent_drops_local_state_and_emits_command() {
        let (tx, rx) = mpsc::channel::<ShellCommand>();
        let def = build_shell_module(
            tx,
            vec![
                RecentApp {
                    id: "1".into(),
                    name: "A".into(),
                    url: "ws://a".into(),
                    last_connected: 0,
                },
                RecentApp {
                    id: "2".into(),
                    name: "B".into(),
                    url: "ws://b".into(),
                    last_connected: 0,
                },
            ],
        );
        let app = HypenApp::default();
        let instance = app.instantiate(std::sync::Arc::new(def)).unwrap();
        instance.mount();

        instance
            .dispatch_action(
                "delete_recent",
                Some(serde_json::json!({"url": "ws://a"})),
            )
            .unwrap();

        let urls: Vec<String> = instance
            .get_state()
            .recents
            .iter()
            .map(|r| r.url.clone())
            .collect();
        assert_eq!(urls, vec!["ws://b".to_string()]);
        assert!(matches!(
            rx.try_recv(),
            Ok(ShellCommand::DeleteRecent { url }) if url == "ws://a"
        ));
    }

    #[test]
    fn island_hover_action_drives_expanded_state() {
        let (instance, _rx) = build_instance();
        instance
            .dispatch_action(
                "island_hover",
                Some(serde_json::json!({"hovered": false})),
            )
            .unwrap();
        assert!(!instance.get_state().island_expanded);
        instance
            .dispatch_action(
                "island_hover",
                Some(serde_json::json!({"hovered": true})),
            )
            .unwrap();
        assert!(instance.get_state().island_expanded);
    }

    #[test]
    fn esc_collapses_expanded_island_only() {
        let (instance, _rx) = build_instance();
        // Already expanded — esc collapses.
        instance.dispatch_action("esc", None).unwrap();
        assert!(!instance.get_state().island_expanded);
        // Idempotent when collapsed.
        instance.dispatch_action("esc", None).unwrap();
        assert!(!instance.get_state().island_expanded);
    }

    #[test]
    fn focus_url_expands_collapsed_island() {
        let (instance, _rx) = build_instance();
        instance.dispatch_action("toggle_island", None).unwrap();
        assert!(!instance.get_state().island_expanded);
        instance.dispatch_action("focus_url", None).unwrap();
        assert!(instance.get_state().island_expanded);
    }

    #[test]
    fn push_tabs_publishes_strip_to_shell_state() {
        let (instance, _rx) = build_instance();
        push_tabs(
            &instance,
            vec![TabInfo {
                id: "t-1".into(),
                url: "ws://a".into(),
                name: "A".into(),
                status: "connected".into(),
                status_message: String::new(),
            }],
            Some("t-1".into()),
        );
        let state = instance.get_state();
        assert_eq!(state.tabs.len(), 1);
        assert_eq!(state.active_tab_id, "t-1");
        assert_eq!(state.tabs[0].status, "connected");
    }
}

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
    /// `true` when the user has pinned the island open via the caret
    /// button. Pinned bars ignore hover-out so they don't collapse
    /// while you're working in them; unpinned bars follow the pointer.
    pub island_pinned: bool,
    /// Recent visits, capped at 6 by [`crate::storage::Storage`].
    pub recents: Vec<RecentApp>,
    /// Open tabs in display order. Empty when no app is open — the
    /// home screen renders in that case.
    pub tabs: Vec<TabInfo>,
    /// The currently-visible tab's id. `None` when `tabs` is empty.
    pub active_tab_id: String,
    /// Derived: `true` iff `tabs` is non-empty.
    pub has_tabs: bool,
    /// Derived: `true` iff `active_tab_id` resolves to a tab.
    /// Gates the home / loading / error overlays — they replace
    /// the active tab's content, and we want the home page back
    /// when the user clicks `+` (which clears `active_tab_id`
    /// without dropping the background tabs).
    pub has_active_tab: bool,
    /// Derived: connection status of the active tab — one of
    /// `""`, `"connecting"`, `"reconnecting"`, `"connected"`,
    /// `"failed"`, `"closed"`. Drives the loading / error overlay.
    pub active_status: String,
    /// Derived: detail line shown under the spinner / error
    /// (e.g. `"attempt 3"` or `"could not connect to ws://..."`).
    pub active_status_message: String,
    /// Derived: the active tab's URL — shown in the loading screen.
    pub active_url: String,
    /// `true` when the patch debug console is open (the `{ }` toolbar
    /// button). Off by default.
    pub debug_open: bool,
    /// Most-recent patch/action traffic for the debug console, as one
    /// newline-joined block (newest last). Pushed by the BrowserModule
    /// via `__set_debug_log`.
    pub debug_log: String,
}

impl ShellState {
    pub fn home(recents: Vec<RecentApp>) -> Self {
        Self {
            url_input: String::new(),
            island_expanded: true,
            island_pinned: false,
            recents,
            tabs: Vec::new(),
            active_tab_id: String::new(),
            has_tabs: false,
            has_active_tab: false,
            active_status: String::new(),
            active_status_message: String::new(),
            active_url: String::new(),
            debug_open: false,
            debug_log: String::new(),
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
    /// Navigate the currently-active tab to `url` — drops its
    /// connection and reconnects to the new URL in the same tab
    /// slot. Acts like `Refresh` but with a new destination.
    NavigateActive { url: String, name: String },
    /// Deselect the active tab so the home / address bar surfaces.
    /// Existing background tabs stay open; the next `OpenTab` will
    /// append a fresh slot. This is what the `+` button does.
    NewTab,
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
    /// The user toggled the patch debug console. The browser uses this
    /// to start/stop capturing tab traffic into the console.
    SetDebug(bool),
    /// Serialise the current UI tree into the debug console.
    DumpTree,
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
    let tx_delete = cmd_tx.clone();
    let tx_debug = cmd_tx.clone();
    let tx_tree = cmd_tx.clone();
    let tx_new_tab = cmd_tx;

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
            // If a tab is currently active, reuse it — pressing →
            // navigates the existing slot. The user opens a fresh
            // tab by clicking the `+` first (which clears
            // `active_tab_id`).
            let cmd = if state.has_active_tab {
                ShellCommand::NavigateActive {
                    url: normalized,
                    name,
                }
            } else {
                ShellCommand::OpenTab {
                    url: normalized,
                    name,
                }
            };
            let _ = tx_connect.send(cmd);
        })
        .on_action::<ConnectRecentPayload>("connect_recent", move |state, payload, _ctx| {
            let url = crate::storage::normalize_url(&payload.url);
            let display = payload.name.unwrap_or_else(|| pretty_name(&url));
            state.url_input = url.clone();
            let cmd = if state.has_active_tab {
                ShellCommand::NavigateActive {
                    url,
                    name: display,
                }
            } else {
                ShellCommand::OpenTab {
                    url,
                    name: display,
                }
            };
            let _ = tx_recent.send(cmd);
        })
        .on_action::<()>("new_tab", move |state, _payload, _ctx| {
            // Surface the home / address bar so the next `connect`
            // appends a new tab instead of navigating the active one.
            // Background tabs stay around in `state.tabs`.
            state.active_tab_id.clear();
            state.has_active_tab = false;
            state.active_status.clear();
            state.active_status_message.clear();
            state.active_url.clear();
            state.url_input.clear();
            let _ = tx_new_tab.send(ShellCommand::NewTab);
        })
        .on_action::<()>("go_home", move |state, _payload, _ctx| {
            state.url_input.clear();
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
        .on_action::<()>("toggle_debug", move |state, _payload, _ctx| {
            state.debug_open = !state.debug_open;
            if !state.debug_open {
                state.debug_log.clear();
            }
            // Tell the browser to start / stop capturing tab traffic.
            let _ = tx_debug.send(ShellCommand::SetDebug(state.debug_open));
        })
        .on_action::<DebugLogPayload>("__set_debug_log", |state, payload, _ctx| {
            state.debug_log = payload.text;
        })
        .on_action::<()>("dump_tree", move |state, _payload, _ctx| {
            // Open the console (so the dump is visible) and ask the
            // browser to serialise the live UI tree into it.
            state.debug_open = true;
            let _ = tx_tree.send(ShellCommand::DumpTree);
        })
        .on_action::<()>("toggle_pin", |state, _payload, _ctx| {
            // The caret button is a sticky toggle. Pinning keeps the
            // bar open regardless of hover; unpinning collapses it (so
            // it doubles as "minimize"). While unpinned the bar follows
            // the pointer via `island_hover`.
            state.island_pinned = !state.island_pinned;
            state.island_expanded = state.island_pinned;
        })
        .on_action::<HoverPayload>("island_hover", |state, payload, _ctx| {
            // Hover-driven expand: pointer over the island chip expands
            // the bar; leaving collapses it. Skipped while pinned so a
            // pinned bar never collapses out from under the user.
            if !state.island_pinned {
                state.island_expanded = payload.hovered;
            }
        })
        .on_action::<()>("focus_url", |state, _payload, _ctx| {
            // Cmd+L: bring the island up so the URL bar is visible and
            // editable, and pin it so it stays put while you type.
            state.island_expanded = true;
            state.island_pinned = true;
        })
        .on_action::<()>("esc", |state, _payload, _ctx| {
            // Esc collapses + unpins the expanded island chrome.
            if state.island_expanded {
                state.island_expanded = false;
                state.island_pinned = false;
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
            state.active_tab_id = payload.active_tab_id.clone();
            state.has_tabs = !state.tabs.is_empty();
            let active = state
                .tabs
                .iter()
                .find(|t| t.id == state.active_tab_id);
            state.has_active_tab = active.is_some();
            state.active_status = active
                .map(|t| t.status.clone())
                .unwrap_or_default();
            state.active_status_message = active
                .map(|t| t.status_message.clone())
                .unwrap_or_default();
            state.active_url = active
                .map(|t| t.url.clone())
                .unwrap_or_default();
        })
        .build()
}

/// Push a freshly-loaded recents list into the shell instance.
pub fn push_recents(instance: &ModuleInstance<ShellState>, recents: Vec<RecentApp>) {
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

/// Push the latest patch/action traffic lines into the shell so the
/// debug console re-renders. No-op cost when the console is closed —
/// the BrowserModule only calls this while `debug_open` is set.
pub fn push_debug_log(instance: &ModuleInstance<ShellState>, text: String) {
    let payload = serde_json::to_value(DebugLogPayload { text }).ok();
    if let Err(e) = instance.dispatch_action("__set_debug_log", payload) {
        log::warn!("hypen-browser: failed to push debug log: {e:?}");
    }
}

/// Payload for `__set_debug_log` — newline-joined, newest line last.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DebugLogPayload {
    pub text: String,
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
/// Stack {                       // root — fills the window
///     Container { viewport }    // BASE: full-bleed; renders home
///                               // when no tabs, hosts active tab's
///                               // app subtree otherwise. The wrapper
///                               // finds this node (first child of
///                               // root) as the `viewport_id`.
///     Row { chrome }            // OVERLAY: pinned to top:0/left:0,
///                               // full window width, fixed height.
/// }
/// ```
///
/// The home content is padded so it doesn't sit under the chrome bar.
const SHELL_UI: &str = r##"
Stack {
    Container {
        If(condition: "@{!state.has_active_tab}") {
            Column {
                Text("Hypen Browser")
                    .fontSize(40)
                    .color("#0f172a")
                Text("Open any Hypen app over WebSocket — no installs, no servers.")
                    .fontSize(15)
                    .color("#64748b")
                    .marginTop(8)

                Text("Last opened")
                    .fontSize(13)
                    .color("#94a3b8")
                    .marginTop(40)

                If(condition: "@{length(state.recents) == 0}") {
                    Text("No apps opened yet. Type a URL above and press →.")
                        .fontSize(13)
                        .color("#94a3b8")
                        .marginTop(8)
                }

                If(condition: "@{length(state.recents) > 0}") {
                    Column {
                        ForEach(items: @state.recents, key: "id") {
                            Row {
                                Button {
                                    Column {
                                        Text("@{item.name}")
                                            .fontSize(14)
                                            .color("#0f172a")
                                        Text("@{item.url}")
                                            .fontSize(12)
                                            .color("#94a3b8")
                                            .marginTop(2)
                                    }
                                }
                                    .backgroundColor("white")
                                    .borderWidth(0)
                                    .padding(14)
                                    .flex(1)
                                    .onClick(@actions.connect_recent, url: "@{item.url}", name: "@{item.name}")
                                Button {
                                    Text("×")
                                        .color("#cbd5e1")
                                        .fontSize(16)
                                }
                                    .backgroundColor("white")
                                    .borderWidth(0)
                                    .padding(14)
                                    .onClick(@actions.delete_recent, url: "@{item.url}")
                            }
                                .backgroundColor("white")
                                .borderWidth(1)
                                .borderColor("#e2e8f0")
                                .borderRadius(10)
                                .marginTop(8)
                        }
                    }
                        .marginTop(8)
                        .width("100%")
                        .maxWidth(640)
                }
            }
                .padding(56)
                .paddingTop(96)
                .width("100%")
                .height("100%")
                .alignItems("center")
                .justifyContent("center")
        }

        If(condition: "@{state.has_active_tab && (state.active_status == 'connecting' || state.active_status == 'reconnecting')}") {
            Column {
                Text("●")
                    .fontSize(28)
                    .color("#3554d1")
                Text("Connecting…")
                    .fontSize(15)
                    .color("#0f172a")
                    .marginTop(12)
                Text("@{state.active_url}")
                    .fontSize(13)
                    .color("#64748b")
                    .marginTop(6)
                If(condition: "@{state.active_status_message != ''}") {
                    Text("@{state.active_status_message}")
                        .fontSize(12)
                        .color("#94a3b8")
                        .marginTop(8)
                }
            }
                .width("100%")
                .height("100%")
                .padding(56)
                .paddingTop(120)
                .alignItems("center")
                .backgroundColor("#f8fafc")
        }

        If(condition: "@{state.has_active_tab && state.active_status == 'failed'}") {
            Column {
                Text("⚠")
                    .fontSize(36)
                    .color("#ef4444")
                Text("Couldn't connect")
                    .fontSize(16)
                    .color("#0f172a")
                    .marginTop(12)
                Text("@{state.active_url}")
                    .fontSize(13)
                    .color("#64748b")
                    .marginTop(6)
                Text("@{state.active_status_message}")
                    .fontSize(12)
                    .color("#94a3b8")
                    .marginTop(8)
                Row {
                    Button("@actions.refresh") {
                        Text("Try again")
                            .color("white")
                            .fontSize(13)
                    }
                        .backgroundColor("#3554d1")
                        .borderWidth(0)
                        .borderRadius(8)
                        .padding(10)
                    Button("@actions.go_home") {
                        Text("Home")
                            .color("#475569")
                            .fontSize(13)
                    }
                        .backgroundColor("#e2e8f0")
                        .borderWidth(0)
                        .borderRadius(8)
                        .padding(10)
                }
                    .gap(8)
                    .marginTop(16)
            }
                .width("100%")
                .height("100%")
                .padding(56)
                .paddingTop(120)
                .alignItems("center")
                .backgroundColor("#f8fafc")
        }
    }
        .width("100%")
        .height("100%")
        .backgroundColor("#f1f5f9")

    Column {
        // Toolbar is expanded when (a) there's no tab open (so the
        // user can always type a URL) or (b) the user hasn't
        // collapsed it. Collapsing without an open tab leaves an
        // empty pill that's confusing — gate it on `has_tabs`.
        If(condition: "@{state.island_expanded || !state.has_tabs}") {
            Column {
                Row {
                    Button {
                        Text("⌂")
                            .color("#475569")
                            .fontSize(13)
                    }
                        .backgroundColor("#ffffff")
                        .borderWidth(1)
                        .borderColor("#e2e8f0")
                        .borderRadius(8)
                        .padding(6)
                        .onClick(@actions.go_home)
                    Button {
                        Text("⟳")
                            .color("#475569")
                            .fontSize(13)
                    }
                        .backgroundColor("#ffffff")
                        .borderWidth(1)
                        .borderColor("#e2e8f0")
                        .borderRadius(8)
                        .padding(6)
                        .onClick(@actions.refresh)

                    Row {
                        Input(placeholder: "Enter a URL — e.g. localhost:3000")
                            .bind(@state.url_input)
                            .backgroundColor("transparent")
                            .color("#0f172a")
                            .borderWidth(0)
                            .padding(6)
                            .fontSize(13)
                            .flex(1)
                        Button("@actions.connect") {
                            Text("→")
                                .color("white")
                                .fontSize(14)
                        }
                            .backgroundColor("#3554d1")
                            .borderWidth(0)
                            .borderRadius(999)
                            .padding(6)
                    }
                        .flex(1)
                        .backgroundColor("#ffffff")
                        .borderWidth(1)
                        .borderColor("#e2e8f0")
                        .borderRadius(999)
                        .padding(2)
                        .alignItems("center")

                    Button {
                        Text("{ }")
                            .color("@{state.debug_open ? '#3554d1' : '#94a3b8'}")
                            .fontSize(13)
                    }
                        .backgroundColor("transparent")
                        .borderWidth(0)
                        .borderRadius(8)
                        .padding(6)
                        .onClick(@actions.toggle_debug)
                    Button {
                        Text("⊞")
                            .color("#94a3b8")
                            .fontSize(13)
                    }
                        .backgroundColor("transparent")
                        .borderWidth(0)
                        .borderRadius(8)
                        .padding(6)
                        .onClick(@actions.dump_tree)
                    Button {
                        Text("@{state.island_pinned ? '⌃' : '⌄'}")
                            .color("@{state.island_pinned ? '#3554d1' : '#94a3b8'}")
                            .fontSize(13)
                    }
                        .backgroundColor("@{state.island_pinned ? '#eef2ff' : 'transparent'}")
                        .borderWidth(0)
                        .borderRadius(8)
                        .padding(6)
                        .onClick(@actions.toggle_pin)
                }
                    .width("100%")
                    .padding(8)
                    // Clear the macOS traffic lights (unified title bar):
                    // the toolbar shares the top row with them, so inset
                    // the left edge past the ~70px light cluster.
                    .paddingLeft(82)
                    .gap(8)
                    .alignItems("center")

                If(condition: "@{state.has_tabs}") {
                    Row {
                        ForEach(items: @state.tabs, key: "id") {
                            Row {
                                Button {
                                    Row {
                                        If(condition: "@{item.status == 'connecting' || item.status == 'reconnecting'}") {
                                            Text("◐")
                                                .color("#94a3b8")
                                                .fontSize(11)
                                        }
                                        If(condition: "@{item.status == 'connected'}") {
                                            Text("●")
                                                .color("#22c55e")
                                                .fontSize(10)
                                        }
                                        If(condition: "@{item.status == 'failed' || item.status == 'closed'}") {
                                            Text("●")
                                                .color("#ef4444")
                                                .fontSize(10)
                                        }
                                        Text("@{item.name}")
                                            .color("#0f172a")
                                            .fontSize(12)
                                            .marginLeft(6)
                                    }
                                        .alignItems("center")
                                }
                                    .backgroundColor("transparent")
                                    .borderWidth(0)
                                    .padding(6)
                                    .onClick(@actions.switch_tab, tabId: "@{item.id}")
                                Button {
                                    Text("×")
                                        .color("#94a3b8")
                                        .fontSize(13)
                                }
                                    .backgroundColor("transparent")
                                    .borderWidth(0)
                                    .padding(6)
                                    .onClick(@actions.close_tab, tabId: "@{item.id}")
                            }
                                .backgroundColor("#ffffff")
                                .borderWidth(1)
                                .borderColor("#e2e8f0")
                                .borderRadius(8)
                                .gap(0)
                        }

                        Button {
                            Text("+")
                                .color("#475569")
                                .fontSize(14)
                        }
                            .backgroundColor("transparent")
                            .borderWidth(0)
                            .borderRadius(8)
                            .padding(6)
                            .onClick(@actions.new_tab)
                    }
                        .width("100%")
                        .gap(4)
                        .padding(6)
                        .paddingTop(0)
                        .alignItems("center")
                }
            }
                .width("100%")
                .linearGradient("to bottom", ["#fbfcfd", "#e9ebef"])
                .borderWidth(1)
                .borderColor("#d8dade")
                .onHover(@actions.island_hover)
        }

        // Collapsed pill — only shown when a tab is open, so the
        // pill always has a meaningful label (active URL + status).
        If(condition: "@{!state.island_expanded && state.has_tabs}") {
            Row {
                Row {
                    If(condition: "@{state.active_status == 'connecting' || state.active_status == 'reconnecting'}") {
                        Text("◐")
                            .color("#94a3b8")
                            .fontSize(10)
                    }
                    If(condition: "@{state.active_status == 'connected'}") {
                        Text("●")
                            .color("#22c55e")
                            .fontSize(10)
                    }
                    If(condition: "@{state.active_status == 'failed' || state.active_status == 'closed'}") {
                        Text("●")
                            .color("#ef4444")
                            .fontSize(10)
                    }
                    Text("@{state.active_url}")
                        .color("#0f172a")
                        .fontSize(12)
                        .marginLeft(8)
                    Text("▾")
                        .color("#94a3b8")
                        .fontSize(10)
                        .marginLeft(8)
                }
                    .alignItems("center")
                    .backgroundColor("#ffffff")
                    .borderWidth(1)
                    .borderColor("#d8dade")
                    .borderRadius(999)
                    .padding(8)
                    .onClick(@actions.toggle_pin)
                    .onHover(@actions.island_hover)
            }
                .width("100%")
                .padding(8)
                .justifyContent("center")
        }
    }
        .width("100%")

    // Devtools: a right-docked, full-height vertical pane (a third
    // Stack overlay). Full-window Row that right-aligns a fixed-width
    // dark pane; `paddingTop` clears the top toolbar so its buttons
    // (including the `{ }` toggle) stay clickable above the pane.
    If(condition: "@{state.debug_open}") {
        Row {
            Column {
                Text("Patch console")
                    .color("#e2e8f0")
                    .fontSize(12)
                    .marginBottom(2)
                Text("▶ out (actions) · ◀ in (patches) · · logs")
                    .color("#94a3b8")
                    .fontSize(10)
                    .marginBottom(8)
                Text("@{state.debug_log}")
                    .color("#e2e8f0")
                    .fontSize(11)
            }
                .width(440)
                .height("100%")
                .padding(12)
                .backgroundColor("#0f172a")
                .borderColor("#1e293b")
                .borderWidth(1)
                .scrollable("vertical")
        }
            .width("100%")
            .height("100%")
            .paddingTop(52)
            .justifyContent("flex-end")
    }
}
    .width("100%")
    .height("100%")
"##;

/// Action names the shell handles. Used by the BrowserModule to
/// decide whether an inbound action belongs to the shell or should
/// be forwarded to the active tab's remote app.
pub const SHELL_ACTIONS: &[&str] = &[
    "connect",
    "connect_recent",
    "new_tab",
    "go_home",
    "refresh",
    "close_tab",
    "switch_tab",
    "delete_recent",
    "toggle_island",
    "toggle_pin",
    "toggle_debug",
    "dump_tree",
    "island_hover",
    "focus_url",
    "esc",
    "__set_recents",
    "__set_tabs",
    "__set_debug_log",
];

/// State paths the shell owns. Used to route `__hypen_bind`. Anything
/// outside this set is forwarded to the active tab's remote app.
pub const SHELL_BIND_PATHS: &[&str] = &[
    "url_input",
    "island_expanded",
    "island_pinned",
    "recents",
    "tabs",
    "active_tab_id",
    "has_tabs",
    "has_active_tab",
    "active_status",
    "active_status_message",
    "active_url",
    "debug_open",
    "debug_log",
];

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
        // url_input is preserved so the address bar still reflects
        // the opened URL — the user can edit it for the next nav.
        let state = instance.get_state();
        assert_eq!(state.url_input, "localhost:3000");
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
            .dispatch_action("close_tab", Some(serde_json::json!({"tabId": "t-1"})))
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
            .dispatch_action("switch_tab", Some(serde_json::json!({"tabId": "t-2"})))
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
            .dispatch_action("delete_recent", Some(serde_json::json!({"url": "ws://a"})))
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
            .dispatch_action("island_hover", Some(serde_json::json!({"hovered": false})))
            .unwrap();
        assert!(!instance.get_state().island_expanded);
        instance
            .dispatch_action("island_hover", Some(serde_json::json!({"hovered": true})))
            .unwrap();
        assert!(instance.get_state().island_expanded);
    }

    #[test]
    fn toggle_debug_flips_state_and_emits_command() {
        let (instance, rx) = build_instance();
        assert!(!instance.get_state().debug_open);

        instance.dispatch_action("toggle_debug", None).unwrap();
        assert!(
            instance.get_state().debug_open,
            "first toggle opens console"
        );
        assert!(
            matches!(rx.try_recv(), Ok(ShellCommand::SetDebug(true))),
            "opening emits SetDebug(true)",
        );

        // Push a log line, then toggle off — closing clears it and
        // emits SetDebug(false).
        push_debug_log(&instance, "◀ in  1 patches · 1 SetProp".into());
        assert!(!instance.get_state().debug_log.is_empty());
        instance.dispatch_action("toggle_debug", None).unwrap();
        assert!(!instance.get_state().debug_open);
        assert!(
            instance.get_state().debug_log.is_empty(),
            "closing clears the log"
        );
        assert!(matches!(rx.try_recv(), Ok(ShellCommand::SetDebug(false))));
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
    fn toggle_pin_makes_island_sticky_against_hover() {
        let (instance, _rx) = build_instance();
        // Pin open.
        instance.dispatch_action("toggle_pin", None).unwrap();
        assert!(instance.get_state().island_pinned);
        assert!(instance.get_state().island_expanded);
        // Hover-out must NOT collapse a pinned bar.
        instance
            .dispatch_action("island_hover", Some(json!({"hovered": false})))
            .unwrap();
        assert!(
            instance.get_state().island_expanded,
            "pinned bar ignores hover-out"
        );
        // Unpin collapses it; now hover-out works again.
        instance.dispatch_action("toggle_pin", None).unwrap();
        assert!(!instance.get_state().island_pinned);
        assert!(!instance.get_state().island_expanded);
        instance
            .dispatch_action("island_hover", Some(json!({"hovered": true})))
            .unwrap();
        assert!(
            instance.get_state().island_expanded,
            "unpinned bar follows hover"
        );
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

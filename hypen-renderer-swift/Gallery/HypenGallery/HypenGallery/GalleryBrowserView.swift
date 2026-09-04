//
//  GalleryBrowserView.swift
//  HypenGallery
//
//  Top-level browser shell: persistent toolbar + Home / App content switch.
//  Mirrors hypen-renderer-android/app/.../MainActivity.kt's GalleryBrowser.
//

import SwiftUI
import UIKit
import HypenSwift

/// Which screen is currently shown in the browser shell.
enum BrowserScreen: Equatable {
    case home
    case app(url: String)
}

struct GalleryBrowserView: View {
    @Binding var deepLinkItem: GalleryItem?
    @Binding var previewUrl: String?

    @StateObject private var storage = HypenAppStorage()
    @State private var currentScreen: BrowserScreen = .home
    @State private var history: [BrowserScreen] = []
    @State private var isConnected: Bool = false
    @State private var isLoading: Bool = false
    @State private var isFullscreen: Bool = false
    /// Bumped when the user taps refresh — used as part of the HypenView `.id`
    /// to force a fresh WebSocket connection (same pattern as Android's
    /// `refreshKey`).
    @State private var refreshKey: Int = 0

    /// Present the legacy component gallery as a sheet.
    @State private var showComponentGallery: Bool = false
    @State private var componentPath = NavigationPath()

    private var currentUrl: String {
        if case .app(let url) = currentScreen { return url }
        return ""
    }

    private var canGoBack: Bool { !history.isEmpty }

    var body: some View {
        // Toolbar is pinned to the top safe-area via `safeAreaInset`
        // instead of being a sibling in a top-down VStack. Reason:
        // when the URL TextField gains focus the iOS keyboard
        // appears and SwiftUI, by default, shifts the entire scene
        // up to keep the focused field visible above the keyboard
        // — which dragged the toolbar (and its URL pill) up under
        // the Dynamic Island. `safeAreaInset(edge: .top)` declares
        // the toolbar as a fixed-position inset of the surrounding
        // content; SwiftUI keeps it locked above the top safe-area
        // regardless of the keyboard's bottom inset, and adjusts
        // the content's bottom inset instead. Net effect: the URL
        // pill never enters the unsafe Island region.
        content
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            // The `ShapeStyle` overload already bleeds into every safe-area
            // edge (`ignoresSafeAreaEdges` defaults to `.all`), which is what
            // edge-to-edge hosting needs: the backdrop reaches the screen
            // edges even where the hosted app doesn't paint its own.
            .background(Color(.systemBackground))
            .safeAreaInset(edge: .top, spacing: 0) {
                if !isFullscreen {
                    BrowserToolbar(
                        currentUrl: currentUrl,
                        isConnected: isConnected,
                        isLoading: isLoading,
                        canGoBack: canGoBack,
                        isFullscreen: isFullscreen,
                        onUrlSubmit: { submitted in connect(to: submitted) },
                        onBackTap: goBack,
                        onHomeTap: goHome,
                        onRefreshTap: refresh,
                        onFullscreenToggle: { isFullscreen.toggle() }
                    )
                    .transition(.move(edge: .top).combined(with: .opacity))
                }
            }
            .animation(.easeInOut(duration: 0.2), value: isFullscreen)
        .sheet(isPresented: $showComponentGallery) {
            NavigationStack(path: $componentPath) {
                ComponentListView(onItemSelected: { item in
                    componentPath.append(item)
                })
                .navigationDestination(for: GalleryItem.self) { item in
                    ComponentPreviewView(item: item)
                }
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") { showComponentGallery = false }
                    }
                }
            }
        }
        .onChange(of: deepLinkItem) { _, newValue in
            presentGalleryItem(newValue)
        }
        .onAppear {
            // onChange does not fire for a value supplied during process launch.
            // Route launch arguments as soon as the root browser is mounted.
            presentGalleryItem(deepLinkItem)
        }
        .onChange(of: previewUrl) { _, newValue in
            if let url = newValue {
                connect(to: url)
                previewUrl = nil
            }
        }
    }

    // MARK: - Content

    /// Edges the hosted Hypen content is allowed to bleed into.
    ///
    /// The bottom and the sides always bleed, so a hosted app reaches under
    /// the home indicator (and under the landscape side insets) exactly like a
    /// mobile browser's viewport — that is what makes a `SafeArea` demo show
    /// real padding instead of nothing.
    ///
    /// The top only bleeds in fullscreen. While the browser toolbar is visible
    /// it already sits between the notch and the content, so the content
    /// starts below it and there is nothing left at the top for a `SafeArea`
    /// element to clear — the shell's chrome has already accounted for it, and
    /// `hypenEdgeToEdgeHost` therefore reports a top inset of zero. Letting the
    /// content bleed *under* the toolbar instead (and feeding the toolbar's
    /// measured height back as the top inset) would look identical for
    /// `SafeArea` apps while hiding the top ~110pt of every app that doesn't
    /// use `SafeArea` behind the chrome, so we don't.
    private var contentBleedEdges: Edge.Set {
        isFullscreen ? .all : [.bottom, .horizontal]
    }

    @ViewBuilder
    private var content: some View {
        switch currentScreen {
        case .home:
            GalleryHomeScreen(
                storage: storage,
                onAppTap: { app in connect(to: app.url, name: app.name) },
                onComponentGalleryTap: { showComponentGallery = true }
            )
        case .app(let url):
            HypenView(
                url: url,
                loadingContent: {
                    VStack(spacing: 16) {
                        ProgressView().scaleEffect(1.5)
                        Text("Connecting to \(url)...")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                },
                errorContent: { message in
                    VStack(spacing: 12) {
                        Image(systemName: "wifi.exclamationmark")
                            .font(.system(size: 48))
                            .foregroundStyle(.red)
                        Text("Connection Error")
                            .font(.headline)
                            .foregroundStyle(.red)
                        Text(message)
                            .font(.body)
                            .multilineTextAlignment(.center)
                            .padding(.horizontal, 24)
                        Text("Make sure the Hypen server is running")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(.top, 8)
                    }
                    .padding(.vertical, 24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .onAppear {
                        isConnected = false
                        isLoading = false
                    }
                }
            )
            // A composite id forces HypenView to tear down and reconnect on
            // refresh, without us having to touch HypenView internals.
            .id("\(url)-\(refreshKey)")
            // Host the app edge-to-edge and hand the renderer the insets it is
            // bleeding under, so `SafeArea` elements pad themselves correctly.
            .hypenEdgeToEdgeHost(edges: contentBleedEdges)
            .onAppear {
                isLoading = true
                // HypenView doesn't expose a connection callback, so we flip
                // to "connected" after a short delay — the errorContent will
                // reset the flags if the connection actually fails.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) {
                    if case .app = currentScreen {
                        isLoading = false
                        isConnected = true
                    }
                }
            }
        }
    }

    // MARK: - Navigation

    private func presentGalleryItem(_ item: GalleryItem?) {
        guard let item else { return }
        componentPath = NavigationPath()
        componentPath.append(item)
        showComponentGallery = true
        deepLinkItem = nil
    }

    private func connect(to rawUrl: String, name: String? = nil) {
        let normalized = normalizeUrl(rawUrl)
        guard !normalized.isEmpty else { return }
        let entryName = name ?? extractNameFromUrl(normalized)
        storage.addOrUpdate(name: entryName, url: normalized)
        navigate(to: .app(url: normalized))
        isLoading = true
        isConnected = false
    }

    private func navigate(to screen: BrowserScreen) {
        if currentScreen != .home {
            history.append(currentScreen)
        }
        currentScreen = screen
    }

    private func goBack() {
        guard let previous = history.popLast() else {
            goHome()
            return
        }
        currentScreen = previous
    }

    private func goHome() {
        history.removeAll()
        currentScreen = .home
        isLoading = false
        isConnected = false
    }

    private func refresh() {
        guard case .app = currentScreen else { return }
        isConnected = false
        isLoading = true
        refreshKey &+= 1
    }
}

// MARK: - Edge-to-edge Hypen hosting

extension View {
    /// Host Hypen content edge-to-edge and publish the insets it is bleeding
    /// under, so `SafeArea` elements can pad themselves correctly.
    ///
    /// - Parameter edges: the edges the content may bleed into. Edges left out
    ///   keep SwiftUI's own inset — the surrounding chrome already owns that
    ///   space — and are published as a zero inset so a `SafeArea` element
    ///   doesn't pad a second time for something the host already handled.
    func hypenEdgeToEdgeHost(edges: Edge.Set) -> some View {
        modifier(HypenEdgeToEdgeHost(edges: edges))
    }
}

/// Lets hosted Hypen content out of the safe area and tells the renderer, in
/// points, what it is now bleeding under.
struct HypenEdgeToEdgeHost: ViewModifier {
    let edges: Edge.Set

    @State private var windowInsets: UIEdgeInsets = .zero

    func body(content: Content) -> some View {
        // `Edge.Set` speaks leading/trailing while `HypenSafeAreaInsets` (like
        // UIKit) speaks physical left/right. The gallery only ever bleeds both
        // horizontal edges together, so a single check covers them and no
        // layout-direction mapping is needed here.
        let bleedsHorizontally = edges.contains(.leading) || edges.contains(.trailing)

        return content
            // `.container` only, never `.keyboard`: the content still shrinks
            // when the keyboard appears, so the keyboard behaviour documented
            // in `GalleryBrowserView.body` is untouched. All this gives up is
            // the device's own unsafe regions.
            .ignoresSafeArea(.container, edges: edges)
            // State the insets explicitly instead of leaving it to the
            // renderer's GeometryReader: what a GeometryProxy reports for a
            // view that has just opted out of the safe area is precisely the
            // detail a demo should not depend on. The override merges per edge
            // over the platform values, and here every edge is supplied, so
            // what `SafeArea` pads by is exactly what this host put around it.
            .hypenSafeAreaInsets(
                HypenSafeAreaInsets(
                    top: edges.contains(.top) ? windowInsets.top : 0,
                    right: bleedsHorizontally ? windowInsets.right : 0,
                    bottom: edges.contains(.bottom) ? windowInsets.bottom : 0,
                    left: bleedsHorizontally ? windowInsets.left : 0
                )
            )
            .onAppear { windowInsets = Self.currentWindowInsets() }
            // Re-read whenever the hosting area resizes: rotation trades the
            // notch inset for the landscape side insets.
            .onGeometryChange(for: CGSize.self) { proxy in
                proxy.size
            } action: { _ in
                windowInsets = Self.currentWindowInsets()
            }
    }

    /// The device's real safe-area insets, read from the active window.
    ///
    /// Deliberately not read from a `GeometryReader`: the window keeps
    /// reporting the physical insets no matter what the views inside it do
    /// with the safe area, which is what makes this value stable for content
    /// that has opted out of it.
    @MainActor
    private static func currentWindowInsets() -> UIEdgeInsets {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first(where: { $0.activationState == .foregroundActive }) ?? scenes.first
        return scene?.keyWindow?.safeAreaInsets ?? .zero
    }
}

// MARK: - URL Normalization

private func normalizeUrl(_ raw: String) -> String {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return "" }
    if trimmed.hasPrefix("https://") {
        return "wss://" + String(trimmed.dropFirst("https://".count))
    }
    if trimmed.hasPrefix("http://") {
        return "ws://" + String(trimmed.dropFirst("http://".count))
    }
    if trimmed.hasPrefix("ws://") || trimmed.hasPrefix("wss://") {
        return trimmed
    }
    return "ws://" + trimmed
}


private func extractNameFromUrl(_ url: String) -> String {
    var stripped = url
    for prefix in ["ws://", "wss://", "http://", "https://"] {
        if stripped.hasPrefix(prefix) {
            stripped = String(stripped.dropFirst(prefix.count))
            break
        }
    }
    let hostPart = stripped.split(separator: "/").first.map(String.init) ?? stripped
    let host = hostPart.split(separator: ":").first.map(String.init) ?? hostPart
    switch host {
    case "127.0.0.1", "localhost": return "Local"
    case "10.0.2.2": return "Local (Emulator)"
    default: return host
    }
}

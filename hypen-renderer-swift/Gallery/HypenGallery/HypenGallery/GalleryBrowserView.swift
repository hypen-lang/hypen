//
//  GalleryBrowserView.swift
//  HypenGallery
//
//  Top-level browser shell: persistent toolbar + Home / App content switch.
//  Mirrors hypen-renderer-android/app/.../MainActivity.kt's GalleryBrowser.
//

import SwiftUI
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
    /// When inside an app, the toolbar collapses into a floating pill by
    /// default so the Hypen view gets full screen real estate. Tap the pill
    /// to expand into the full toolbar; submitting / tapping outside / going
    /// home collapses it again. Home and component-gallery screens always
    /// show the full toolbar — there's no rendered app underneath to hide
    /// behind there.
    @State private var isToolbarExpanded: Bool = false

    /// Present the legacy component gallery as a sheet.
    @State private var showComponentGallery: Bool = false
    @State private var componentPath = NavigationPath()

    private var currentUrl: String {
        if case .app(let url) = currentScreen { return url }
        return ""
    }

    private var canGoBack: Bool { !history.isEmpty }

    /// Inside an app, hide the full toolbar by default and show the pill
    /// instead — tap to expand. Anywhere else (home, etc.), show the full
    /// toolbar always.
    private var isAppScreen: Bool {
        if case .app = currentScreen { return true }
        return false
    }
    private var showFullToolbar: Bool { !isFullscreen && (!isAppScreen || isToolbarExpanded) }
    private var showPill: Bool { !isFullscreen && isAppScreen && !isToolbarExpanded }

    var body: some View {
        ZStack(alignment: .top) {
            // Content fills the full screen so the rendered Hypen app gets
            // every pixel. The toolbar / pill float on top.
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)

            // Tap-outside-to-collapse — only present while the toolbar is
            // expanded over an app. Sized to cover the rest of the screen
            // below the toolbar (top inset is approximate; SwiftUI doesn't
            // give us the actual toolbar height for free, but anywhere
            // below ~88pt is safe — toolbar + status bar.).
            if isAppScreen && isToolbarExpanded {
                Color.clear
                    .contentShape(Rectangle())
                    .onTapGesture { isToolbarExpanded = false }
                    .padding(.top, 88)
                    .ignoresSafeArea(edges: .bottom)
            }

            // Floating pill — small, top-centered, appears only on app screen
            // when the toolbar is collapsed. Hypen content fills the screen
            // edge-to-edge so the surrounding ZStack stretches into the
            // top safe-area / Dynamic Island region; without explicit
            // padding the pill sits behind the island. Use the window's
            // safe-area inset so the pill clears it on every device.
            if showPill {
                BrowserPill(
                    currentUrl: currentUrl,
                    isConnected: isConnected,
                    onTap: { isToolbarExpanded = true }
                )
                .padding(.top, topSafeAreaInset() + 6)
                .transition(.move(edge: .top).combined(with: .opacity))
            }

            // Full toolbar — default for non-app screens; expanded mode for app.
            if showFullToolbar {
                BrowserToolbar(
                    currentUrl: currentUrl,
                    isConnected: isConnected,
                    isLoading: isLoading,
                    canGoBack: canGoBack,
                    isFullscreen: isFullscreen,
                    onUrlSubmit: { submitted in
                        connect(to: submitted)
                        isToolbarExpanded = false
                    },
                    onBackTap: {
                        isToolbarExpanded = false
                        goBack()
                    },
                    onHomeTap: {
                        isToolbarExpanded = false
                        goHome()
                    },
                    onRefreshTap: {
                        refresh()
                        isToolbarExpanded = false
                    },
                    onFullscreenToggle: {
                        isFullscreen.toggle()
                        isToolbarExpanded = false
                    }
                )
                .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: isFullscreen)
        .animation(.easeInOut(duration: 0.18), value: isToolbarExpanded)
        .onChange(of: currentScreen) { _, newValue in
            // Re-collapse on every screen change — entering a fresh app
            // should always start full-bleed.
            if case .app = newValue { isToolbarExpanded = false }
        }
        .background(Color(.systemBackground))
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
            guard let item = newValue else { return }
            // Route a hypengallery:// deep link into the component sheet and
            // jump straight to the requested item.
            componentPath = NavigationPath()
            componentPath.append(item)
            showComponentGallery = true
            deepLinkItem = nil
        }
        .onChange(of: previewUrl) { _, newValue in
            if let url = newValue {
                connect(to: url)
                previewUrl = nil
            }
        }
    }

    // MARK: - Content

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

/// Top safe-area inset for the active key window. Used to position the
/// floating BrowserPill below the Dynamic Island / status bar. Returns 0
/// before the window scene is up.
private func topSafeAreaInset() -> CGFloat {
    UIApplication.shared.connectedScenes
        .compactMap { $0 as? UIWindowScene }
        .flatMap(\.windows)
        .first(where: \.isKeyWindow)?
        .safeAreaInsets.top ?? 0
}

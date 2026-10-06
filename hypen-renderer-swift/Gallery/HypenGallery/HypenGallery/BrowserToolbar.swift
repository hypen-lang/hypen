//
//  BrowserToolbar.swift
//  HypenGallery
//
//  Top-of-screen browser toolbar: back / home / refresh / URL bar / fullscreen.
//  Mirrors hypen-renderer-android/app/.../BrowserToolbar.kt.
//

import SwiftUI

struct BrowserToolbar: View {
    let currentUrl: String
    let isConnected: Bool
    let isLoading: Bool
    let canGoBack: Bool
    let isFullscreen: Bool
    let onUrlSubmit: (String) -> Void
    let onBackTap: () -> Void
    let onHomeTap: () -> Void
    let onRefreshTap: () -> Void
    let onFullscreenToggle: () -> Void

    // Local editing state. `draftUrl` mirrors the text field while editing.
    // Importantly, we do NOT bind `draftUrl` directly to `currentUrl` — the
    // `onChange(of: currentUrl)` handler below only syncs external updates when
    // the field is not focused, so typing never gets clobbered by a parent
    // update. This is the iOS analogue of the `LaunchedEffect(currentUrl,
    // isEditing)` pattern we use on Android's BrowserToolbar.
    @State private var draftUrl: String
    @FocusState private var isFocused: Bool

    init(
        currentUrl: String,
        isConnected: Bool,
        isLoading: Bool,
        canGoBack: Bool,
        isFullscreen: Bool,
        onUrlSubmit: @escaping (String) -> Void,
        onBackTap: @escaping () -> Void,
        onHomeTap: @escaping () -> Void,
        onRefreshTap: @escaping () -> Void,
        onFullscreenToggle: @escaping () -> Void
    ) {
        self.currentUrl = currentUrl
        self.isConnected = isConnected
        self.isLoading = isLoading
        self.canGoBack = canGoBack
        self.isFullscreen = isFullscreen
        self.onUrlSubmit = onUrlSubmit
        self.onBackTap = onBackTap
        self.onHomeTap = onHomeTap
        self.onRefreshTap = onRefreshTap
        self.onFullscreenToggle = onFullscreenToggle
        self._draftUrl = State(initialValue: currentUrl)
    }

    var body: some View {
        HStack(spacing: 4) {
            iconButton(
                systemName: "chevron.backward",
                enabled: canGoBack,
                accessibilityLabel: "Back",
                action: onBackTap
            )

            iconButton(
                systemName: "house.fill",
                enabled: true,
                accessibilityLabel: "Home",
                action: onHomeTap
            )

            Group {
                if isLoading {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .frame(width: 36, height: 36)
                } else {
                    iconButton(
                        systemName: "arrow.clockwise",
                        enabled: isConnected,
                        accessibilityLabel: "Refresh",
                        action: onRefreshTap
                    )
                }
            }

            urlBar

            iconButton(
                systemName: isFullscreen ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right",
                enabled: true,
                accessibilityLabel: isFullscreen ? "Exit fullscreen" : "Enter fullscreen",
                action: onFullscreenToggle
            )
        }
        .padding(.horizontal, 8)
        // Extra top padding on top of vertical 8 so the URL pill
        // clears the Dynamic Island's curved bottom edge on iPhone
        // 14 Pro and later. SwiftUI's default safe-area-top inset
        // clears the status-bar text baseline but not the Island's
        // pill shape, which extends a few points further down — the
        // result was a visible overlap between the toolbar's URL
        // capsule and the Island. Older devices (no Island) just
        // get a slightly taller toolbar, no visual regression.
        .padding(.top, 6)
        .padding(.bottom, 8)
        .background(Color(.systemBackground))
        .overlay(alignment: .bottom) {
            Divider().opacity(0.5)
        }
        // Keep `draftUrl` in sync with the authoritative `currentUrl` only when
        // the field is NOT focused — prevents navigation/refresh updates from
        // interrupting the user mid-typing.
        .onChange(of: currentUrl) { _, newValue in
            if !isFocused { draftUrl = newValue }
        }
    }

    // MARK: - URL Bar

    private var urlBar: some View {
        HStack(spacing: 6) {
            if isConnected && !isFocused {
                Circle()
                    .fill(Color.accentColor)
                    .frame(width: 8, height: 8)
            }

            TextField("Enter URL or scan QR", text: $draftUrl)
                .textContentType(.URL)
                .keyboardType(.URL)
                .autocorrectionDisabled(true)
                .textInputAutocapitalization(.never)
                .submitLabel(.go)
                .focused($isFocused)
                .font(.callout)
                .foregroundStyle(.primary)
                .onSubmit {
                    submit()
                }

            if isFocused && !draftUrl.isEmpty {
                Button {
                    draftUrl = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                        .font(.system(size: 16))
                }
                // Prevents the clear button from stealing focus from the TextField.
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12)
        .frame(height: 36)
        .frame(maxWidth: .infinity)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color(.secondarySystemBackground))
        )
        .contentShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        // `simultaneousGesture` lets us claim the tap-to-focus behavior for
        // the whole pill area without swallowing the TextField's own cursor
        // positioning gesture.
        .simultaneousGesture(
            TapGesture().onEnded {
                if !isFocused {
                    isFocused = true
                }
            }
        )
    }

    // MARK: - Actions

    private func submit() {
        let trimmed = draftUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        isFocused = false
        onUrlSubmit(trimmed)
    }

    // MARK: - Helpers

    @ViewBuilder
    private func iconButton(
        systemName: String,
        enabled: Bool,
        accessibilityLabel: String,
        action: @escaping () -> Void
    ) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 17, weight: .regular))
                .frame(width: 36, height: 36)
        }
        .disabled(!enabled)
        .accessibilityLabel(accessibilityLabel)
    }
}

#Preview {
    VStack(spacing: 0) {
        BrowserToolbar(
            currentUrl: "ws://localhost:3000",
            isConnected: true,
            isLoading: false,
            canGoBack: true,
            isFullscreen: false,
            onUrlSubmit: { _ in },
            onBackTap: {},
            onHomeTap: {},
            onRefreshTap: {},
            onFullscreenToggle: {}
        )
        Spacer()
    }
}


// MARK: - Collapsed pill

/// Collapsed browser chrome: a small floating pill, about the width of the
/// Dynamic Island, showing connection status + the current host. Mirrors the
/// collapsed "island" of the desktop `hypen-browser` shell
/// (`hypen-browser/src/shell.rs`): dark chip, status dot, URL, chevron.
///
/// On Dynamic Island devices the pill is pure black and hangs directly off
/// the Island's bottom edge so the two read as one shape — the Island simply
/// "grows" a URL label. Elsewhere it is the desktop-style dark chip sitting
/// just under the status bar.
struct CollapsedUrlPill: View {
    let currentUrl: String
    let isConnected: Bool
    let isLoading: Bool
    let blendsWithDynamicIsland: Bool
    let onTap: () -> Void

    /// Dynamic Island geometry (points), measured on the iPhone 17 Pro
    /// simulator: 125.3 wide, top edge at y=14, bottom at y=50.3. The pill
    /// starts exactly at the Island's top so nothing peeks out above it; its
    /// upper part is hidden under the cutout and only the label band shows.
    static let islandWidth: CGFloat = 126
    static let islandTop: CGFloat = 14
    static let islandHeight: CGFloat = 37
    /// Visible label band below the Island.
    static let labelHeight: CGFloat = 28

    private var statusColor: Color {
        if isLoading { return Color(red: 0.54, green: 0.56, blue: 0.60) }
        return isConnected ? Color(red: 0.13, green: 0.77, blue: 0.37) : Color(red: 0.94, green: 0.27, blue: 0.27)
    }

    var body: some View {
        if blendsWithDynamicIsland {
            // A detached black chip parked just under the Island, exactly the
            // Island's width, so it reads as a deliberate companion element
            // rather than a smeared Island. (Stretching the Island itself into
            // a taller capsule looked like a blob.)
            label
                .frame(width: Self.islandWidth, height: 24)
                .background(Color.black, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .padding(.top, Self.islandTop + Self.islandHeight + 6)
                .contentShape(Rectangle())
                .onTapGesture(perform: onTap)
                .ignoresSafeArea(.container, edges: .top)
                .accessibilityLabel("Browser chrome, collapsed. \(displayHost)")
                .accessibilityAddTraits(.isButton)
        } else {
            label
                .frame(height: 32)
                .background(Color(red: 0.12, green: 0.12, blue: 0.14), in: Capsule())
                .overlay(Capsule().strokeBorder(Color(red: 0.15, green: 0.15, blue: 0.17), lineWidth: 1))
                .frame(minWidth: 120, maxWidth: 180)
                .padding(.top, 6)
                .contentShape(Capsule())
                .onTapGesture(perform: onTap)
                .accessibilityLabel("Browser chrome, collapsed. \(displayHost)")
                .accessibilityAddTraits(.isButton)
        }
    }

    private var label: some View {
        HStack(spacing: 6) {
            Circle().fill(statusColor).frame(width: 7, height: 7)
            Text(displayHost)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color(red: 0.96, green: 0.96, blue: 0.96))
                .lineLimit(1)
                .truncationMode(.middle)
            Image(systemName: "chevron.down")
                .font(.system(size: 9, weight: .semibold))
                .foregroundStyle(Color(red: 0.54, green: 0.56, blue: 0.60))
        }
        .padding(.horizontal, 12)
    }

    /// `ws://localhost:3000/path` → `localhost:3000` — what fits in a pill.
    private var displayHost: String {
        var stripped = currentUrl
        for prefix in ["wss://", "ws://", "https://", "http://"] where stripped.hasPrefix(prefix) {
            stripped = String(stripped.dropFirst(prefix.count))
            break
        }
        let host = stripped.split(separator: "/", maxSplits: 1).first.map(String.init) ?? stripped
        return host.isEmpty ? currentUrl : host
    }
}

#Preview("Collapsed pill") {
    VStack(spacing: 24) {
        CollapsedUrlPill(currentUrl: "ws://localhost:3000", isConnected: true, isLoading: false, blendsWithDynamicIsland: false, onTap: {})
        CollapsedUrlPill(currentUrl: "wss://hypen-social.ian-dae.workers.dev", isConnected: false, isLoading: true, blendsWithDynamicIsland: false, onTap: {})
    }
    .padding()
    .background(Color.gray)
}

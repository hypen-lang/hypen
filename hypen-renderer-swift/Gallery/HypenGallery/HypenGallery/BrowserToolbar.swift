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
        .padding(.vertical, 8)
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

//
//  BrowserPill.swift
//  HypenGallery
//
//  A small floating pill that hovers over the Hypen view, showing the
//  connection URL + a red/green status dot. Tapping expands into the full
//  BrowserToolbar. Mirrors hypen-renderer-android's BrowserPill.
//

import SwiftUI

struct BrowserPill: View {
    let currentUrl: String
    let isConnected: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                Circle()
                    .fill(isConnected ? Color(red: 0.13, green: 0.77, blue: 0.37) : Color(red: 0.94, green: 0.27, blue: 0.27))
                    .frame(width: 8, height: 8)

                Text(displayUrl(currentUrl))
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .frame(maxWidth: 280)
            .background(
                Capsule(style: .continuous)
                    .fill(.ultraThinMaterial)
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.06), lineWidth: 0.5)
            )
            .shadow(color: .black.opacity(0.12), radius: 6, x: 0, y: 2)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Show toolbar")
        .accessibilityValue(currentUrl.isEmpty ? "no connection" : currentUrl)
    }
}

/// Trim noise from the URL so the pill stays readable at small sizes —
/// drop the ws/http scheme and any trailing slash. The full URL is still
/// available (and editable) in the expanded toolbar.
private func displayUrl(_ raw: String) -> String {
    if raw.isEmpty { return "no connection" }
    var s = raw
    for prefix in ["wss://", "ws://", "https://", "http://"] {
        if s.hasPrefix(prefix) {
            s = String(s.dropFirst(prefix.count))
            break
        }
    }
    if s.hasSuffix("/") { s.removeLast() }
    return s
}

#Preview {
    VStack(spacing: 12) {
        BrowserPill(
            currentUrl: "ws://localhost:3000",
            isConnected: true,
            onTap: {}
        )
        BrowserPill(
            currentUrl: "wss://demo.hypen.space/long/path/that/will/truncate",
            isConnected: false,
            onTap: {}
        )
    }
    .padding()
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Color.gray.opacity(0.2))
}

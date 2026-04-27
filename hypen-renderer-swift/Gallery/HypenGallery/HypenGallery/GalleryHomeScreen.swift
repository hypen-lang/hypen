//
//  GalleryHomeScreen.swift
//  HypenGallery
//
//  Home screen showing built-in demo apps, recent apps, and quick actions.
//  Mirrors hypen-renderer-android/app/.../HomeScreen.kt.
//

import SwiftUI

struct GalleryHomeScreen: View {
    @ObservedObject var storage: HypenAppStorage
    let onAppTap: (HypenAppEntry) -> Void
    let onComponentGalleryTap: () -> Void

    private let columns = [
        GridItem(.flexible(), spacing: 12),
        GridItem(.flexible(), spacing: 12),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Hypen Gallery")
                    .font(.largeTitle)
                    .fontWeight(.bold)
                    .padding(.top, 8)

                sectionHeader("Demo Apps")

                LazyVGrid(columns: columns, spacing: 12) {
                    ForEach(BuiltInApps.apps) { app in
                        AppCard(app: app) {
                            onAppTap(app)
                        }
                    }
                }

                quickActions

                if !storage.recentApps.isEmpty {
                    sectionHeader("Recent")

                    LazyVGrid(columns: columns, spacing: 12) {
                        ForEach(storage.recentApps) { app in
                            AppCard(
                                app: app,
                                onDelete: { storage.remove(id: app.id) },
                                action: { onAppTap(app) }
                            )
                        }
                    }
                }

                Spacer(minLength: 32)
            }
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
        }
    }

    // MARK: - Subviews

    @ViewBuilder
    private func sectionHeader(_ title: String) -> some View {
        Text(title)
            .font(.title3)
            .fontWeight(.semibold)
            .foregroundStyle(.secondary)
            .padding(.top, 8)
    }

    private var quickActions: some View {
        VStack(spacing: 12) {
            // Component Gallery — full-width card
            Button(action: onComponentGalleryTap) {
                HStack {
                    Image(systemName: "square.grid.2x2")
                        .font(.title3)
                        .foregroundStyle(.tint)
                    Text("Component Gallery")
                        .font(.body)
                        .fontWeight(.medium)
                        .foregroundStyle(.primary)
                    Spacer()
                    Image(systemName: "chevron.right")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .padding(16)
                .background(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.primary.opacity(0.1), lineWidth: 1)
                        .background(
                            RoundedRectangle(cornerRadius: 12, style: .continuous)
                                .fill(Color(.secondarySystemBackground))
                        )
                )
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 8)
    }
}

// MARK: - App Card

private struct AppCard: View {
    let app: HypenAppEntry
    var onDelete: (() -> Void)? = nil
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                VStack(spacing: 12) {
                    iconBadge

                    Text(app.name)
                        .font(.headline)
                        .foregroundStyle(.primary)
                        .lineLimit(1)

                    if !app.description.isEmpty {
                        Text(app.description)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.center)
                    }

                    if !app.isBuiltIn && app.lastConnected > 0 {
                        Text(relativeTimestamp)
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(16)
                .aspectRatio(1, contentMode: .fit)

                if let onDelete {
                    Button(action: onDelete) {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 18))
                            .foregroundStyle(.red.opacity(0.8))
                            .padding(6)
                    }
                    .buttonStyle(.plain)
                }
            }
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(Color(.secondarySystemBackground))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var iconBadge: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.accentColor.opacity(0.15))
                .frame(width: 52, height: 52)
            Text(initials)
                .font(.headline)
                .fontWeight(.semibold)
                .foregroundStyle(Color.accentColor)
        }
    }

    private var initials: String {
        String(app.name.prefix(2)).uppercased()
    }

    private var relativeTimestamp: String {
        let now = Date().timeIntervalSince1970
        let diff = now - app.lastConnected
        switch diff {
        case ..<60: return "Just now"
        case ..<3_600: return "\(Int(diff / 60))m ago"
        case ..<86_400: return "\(Int(diff / 3_600))h ago"
        case ..<604_800: return "\(Int(diff / 86_400))d ago"
        default:
            let formatter = DateFormatter()
            formatter.dateFormat = "MMM d"
            return formatter.string(from: Date(timeIntervalSince1970: app.lastConnected))
        }
    }
}

#Preview {
    GalleryHomeScreen(
        storage: HypenAppStorage(),
        onAppTap: { _ in },
        onComponentGalleryTap: {}
    )
}

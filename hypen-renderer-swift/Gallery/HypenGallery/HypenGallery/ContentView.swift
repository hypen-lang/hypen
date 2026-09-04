//
//  ContentView.swift
//  HypenGallery
//
//  Root view. The gallery is now a browser-style app with a persistent
//  toolbar, a home screen, and a component-gallery sheet. Mirrors
//  hypen-renderer-android's gallery app.
//

import SwiftUI
import HypenSwift

struct ContentView: View {
    @Binding var deepLinkItem: GalleryItem?
    @Binding var previewUrl: String?

    var body: some View {
        GalleryBrowserView(
            deepLinkItem: $deepLinkItem,
            previewUrl: $previewUrl
        )
    }
}

// MARK: - Component List View

struct ComponentListView: View {
    let onItemSelected: (GalleryItem) -> Void

    var body: some View {
        List {
            Section {
                ForEach(GalleryItems.components) { item in
                    GalleryItemRow(item: item)
                        .onTapGesture {
                            onItemSelected(item)
                        }
                }
            } header: {
                Text("Components (\(GalleryItems.components.count))")
                    .font(.headline)
                    .fontWeight(.bold)
            }

            Section {
                ForEach(GalleryItems.applicators) { item in
                    GalleryItemRow(item: item)
                        .onTapGesture {
                            onItemSelected(item)
                        }
                }
            } header: {
                Text("Applicators (\(GalleryItems.applicators.count))")
                    .font(.headline)
                    .fontWeight(.bold)
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle("Component Gallery")
    }
}

// MARK: - Gallery Item Row

struct GalleryItemRow: View {
    let item: GalleryItem

    var body: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text(item.name)
                    .font(.headline)
                    .fontWeight(.medium)

                Text(item.description)
                    .font(.caption)
                    .foregroundColor(.secondary)
            }

            Spacer()

            Text(item.path)
                .font(.caption2)
                .fontWeight(.medium)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(
                    RoundedRectangle(cornerRadius: 6)
                        .fill(item.isApplicator ? Color.purple.opacity(0.15) : Color.blue.opacity(0.15))
                )
                .foregroundColor(item.isApplicator ? .purple : .blue)
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

// MARK: - Component Preview View

struct ComponentPreviewView: View {
    let item: GalleryItem

    private var wsURL: String {
        "ws://\(GalleryItems.serverHost):\(GalleryItems.serverPort)\(item.path)?platform=ios"
    }

    var body: some View {
        HypenView(
            url: wsURL,
            loadingContent: {
                VStack(spacing: 16) {
                    ProgressView()
                        .scaleEffect(1.5)

                    Text("Connecting to server...")
                        .font(.caption)
                        .foregroundColor(.secondary)

                    Text(wsURL)
                        .font(.caption2)
                        .foregroundColor(.secondary)
                        .multilineTextAlignment(.center)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            },
            errorContent: { message in
                VStack(spacing: 16) {
                    Image(systemName: "wifi.exclamationmark")
                        .font(.system(size: 48))
                        .foregroundColor(.red)

                    Text("Connection Error")
                        .font(.headline)
                        .foregroundColor(.red)

                    Text(message)
                        .font(.body)
                        .multilineTextAlignment(.center)
                        .padding(.horizontal)

                    Divider()
                        .padding(.vertical)

                    VStack(spacing: 8) {
                        Text("Make sure the component-gallery-server is running:")
                            .font(.caption)
                            .foregroundColor(.secondary)

                        Text("cd component-gallery-server && bun run server.ts")
                            .font(.caption)
                            .fontDesign(.monospaced)
                            .padding(8)
                            .background(Color(.systemGray6))
                            .cornerRadius(6)
                    }
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        )
        .id(item.id)
        // Same edge-to-edge hosting as the browser shell, minus the top: this
        // preview lives under a navigation bar that already owns that space,
        // so only the bottom (home indicator) and the landscape side insets
        // are actually unsafe here.
        .hypenEdgeToEdgeHost(edges: [.bottom, .horizontal])
        .navigationTitle("\(item.name) Preview")
        .navigationBarTitleDisplayMode(.inline)
    }
}

// MARK: - Preview

#Preview {
    ContentView(deepLinkItem: .constant(nil), previewUrl: .constant(nil))
}

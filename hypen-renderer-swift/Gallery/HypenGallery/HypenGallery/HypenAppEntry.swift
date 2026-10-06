//
//  HypenAppEntry.swift
//  HypenGallery
//
//  Represents a Hypen app entry (built-in or user-added) shown in the gallery.
//  Mirrors hypen-renderer-android/app/.../HypenAppEntry.kt.
//

import Foundation

/// Represents a Hypen app entry in the gallery.
struct HypenAppEntry: Identifiable, Hashable, Codable {
    let id: String
    var name: String
    var url: String
    var description: String
    var iconUrl: String?
    var lastConnected: TimeInterval
    var isBuiltIn: Bool

    init(
        id: String = UUID().uuidString,
        name: String,
        url: String,
        description: String = "",
        iconUrl: String? = nil,
        lastConnected: TimeInterval = 0,
        isBuiltIn: Bool = false
    ) {
        self.id = id
        self.name = name
        self.url = url
        self.description = description
        self.iconUrl = iconUrl
        self.lastConnected = lastConnected
        self.isBuiltIn = isBuiltIn
    }
}

/// Built-in demo apps that are always shown in the gallery.
/// These match the Android gallery's BuiltInApps list.
enum BuiltInApps {
    static let apps: [HypenAppEntry] = [
        HypenAppEntry(
            id: "counter",
            name: "Counter",
            url: "ws://localhost:3000",
            description: "A simple counter demo app",
            isBuiltIn: true
        ),
        HypenAppEntry(
            id: "todo",
            name: "Todo List",
            url: "ws://localhost:3001",
            description: "Manage your tasks",
            isBuiltIn: true
        ),
        HypenAppEntry(
            id: "weather",
            name: "Weather",
            url: "ws://localhost:3002",
            description: "Check the weather forecast",
            isBuiltIn: true
        ),
        HypenAppEntry(
            id: "notes",
            name: "Notes",
            url: "ws://localhost:3003",
            description: "Quick note taking app",
            isBuiltIn: true
        ),
        HypenAppEntry(
            id: "calculator",
            name: "Calculator",
            url: "ws://localhost:3004",
            description: "Basic calculator",
            isBuiltIn: true
        ),
        HypenAppEntry(
            id: "profile",
            name: "Profile",
            url: "ws://localhost:3005",
            description: "User profile demo",
            isBuiltIn: true
        ),
        // Served by component-gallery-server rather than a standalone example.
        // It lives here, in the browser shell, because that is the host that
        // renders Hypen content fully edge-to-edge — the component-preview
        // sheet keeps its navigation bar, so only its bottom edge bleeds.
        HypenAppEntry(
            id: "safearea",
            name: "SafeArea",
            url: "ws://\(GalleryItems.serverHost):\(GalleryItems.serverPort)/components/safearea",
            description: "Notch & home-indicator insets",
            isBuiltIn: true
        ),
    ]
}

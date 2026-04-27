//
//  AppStorage.swift
//  HypenGallery
//
//  Persists recently-connected Hypen apps via UserDefaults.
//  Mirrors hypen-renderer-android/app/.../AppStorage.kt.
//

import Foundation

/// Manages persistent storage of Hypen app entries using UserDefaults.
@MainActor
final class HypenAppStorage: ObservableObject {
    private let defaults: UserDefaults
    private let key = "hypen_gallery_recent_apps"
    private let maxApps = 50

    @Published private(set) var recentApps: [HypenAppEntry] = []

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.recentApps = loadFromDisk()
    }

    /// Add or update an app by URL. Updates name + lastConnected timestamp and
    /// moves the entry to the top of the list.
    @discardableResult
    func addOrUpdate(name: String, url: String) -> HypenAppEntry {
        var apps = recentApps
        let existing = apps.first { $0.url == url }
        let entry = HypenAppEntry(
            id: existing?.id ?? UUID().uuidString,
            name: name,
            url: url,
            description: existing?.description ?? "",
            iconUrl: existing?.iconUrl,
            lastConnected: Date().timeIntervalSince1970,
            isBuiltIn: false
        )

        apps.removeAll { $0.url == url }
        apps.insert(entry, at: 0)
        if apps.count > maxApps {
            apps = Array(apps.prefix(maxApps))
        }

        recentApps = apps
        save()
        return entry
    }

    func remove(id: String) {
        recentApps.removeAll { $0.id == id }
        save()
    }

    func clearAll() {
        recentApps = []
        save()
    }

    // MARK: - Persistence

    private func loadFromDisk() -> [HypenAppEntry] {
        guard let data = defaults.data(forKey: key) else { return [] }
        return (try? JSONDecoder().decode([HypenAppEntry].self, from: data)) ?? []
    }

    private func save() {
        if let data = try? JSONEncoder().encode(recentApps) {
            defaults.set(data, forKey: key)
        }
    }
}

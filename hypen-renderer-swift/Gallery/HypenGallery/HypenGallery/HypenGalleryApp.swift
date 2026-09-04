//
//  HypenGalleryApp.swift
//  HypenGallery
//
//  Created by Ian Rumac on 31.01.2026..
//

import SwiftUI

@main
struct HypenGalleryApp: App {
    @State private var deepLinkItem: GalleryItem?
    @State private var previewUrl: String?

    init() {
        self.init(arguments: ProcessInfo.processInfo.arguments)
    }

    init(arguments: [String]) {
        _deepLinkItem = State(initialValue: GalleryLaunchArguments.galleryItem(from: arguments))
        _previewUrl = State(initialValue: nil)
    }

    var body: some Scene {
        WindowGroup {
            ContentView(deepLinkItem: $deepLinkItem, previewUrl: $previewUrl)
                .onOpenURL { url in
                    handleDeepLink(url)
                }
        }
    }

    private func handleDeepLink(_ url: URL) {
        NSLog("[HypenGallery] Deep link received: %@", url.absoluteString)

        if url.scheme == "hypenpreview" && url.host == "connect" {
            // hypenpreview://connect?url=ws://localhost:3000
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
            if let wsUrl = components?.queryItems?.first(where: { $0.name == "url" })?.value {
                NSLog("[HypenGallery] Preview deep link, connecting to: %@", wsUrl)
                previewUrl = wsUrl
            }
            return
        }

        guard url.scheme == "hypengallery" else { return }

        // URL format: hypengallery://component/column or hypengallery://applicator/padding
        // Also support: hypengallery://column (shorthand)
        let pathComponents = url.pathComponents.filter { $0 != "/" }
        let host = url.host ?? ""

        var itemName: String?

        if pathComponents.isEmpty {
            // hypengallery://column format
            itemName = host
        } else if pathComponents.count == 1 {
            // hypengallery://component/column or hypengallery:///column
            itemName = pathComponents[0]
        }

        if let name = itemName, let item = GalleryItems.find(byName: name) {
            NSLog("[HypenGallery] Found item: %@ at path %@", item.name, item.path)
            deepLinkItem = item
        } else {
            NSLog("[HypenGallery] Item not found for: %@", itemName ?? "nil")
        }
    }
}

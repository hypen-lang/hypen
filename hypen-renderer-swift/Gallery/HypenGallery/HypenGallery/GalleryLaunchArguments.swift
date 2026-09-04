//
//  GalleryLaunchArguments.swift
//  HypenGallery
//
//  Non-interactive routing used by screenshot automation.
//

import Foundation

enum GalleryLaunchArguments {
    static let galleryItemFlag = "--gallery-item"

    static func galleryItemName(from arguments: [String]) -> String? {
        for (index, argument) in arguments.enumerated() {
            if argument == galleryItemFlag,
               arguments.indices.contains(index + 1) {
                let value = arguments[index + 1].trimmingCharacters(in: .whitespacesAndNewlines)
                return value.isEmpty ? nil : value
            }

            let prefix = galleryItemFlag + "="
            if argument.hasPrefix(prefix) {
                let value = String(argument.dropFirst(prefix.count))
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                return value.isEmpty ? nil : value
            }
        }
        return nil
    }

    static func galleryItem(from arguments: [String]) -> GalleryItem? {
        guard let name = galleryItemName(from: arguments) else { return nil }
        return GalleryItems.find(byName: name)
    }
}

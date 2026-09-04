//
//  HypenGalleryTests.swift
//  HypenGalleryTests
//
//  Created by Ian Rumac on 31.01.2026..
//

import Testing
@testable import HypenGallery

struct HypenGalleryTests {

    @Test func parsesGalleryLaunchArguments() {
        let badge = GalleryLaunchArguments.galleryItem(from: ["HypenGallery", "--gallery-item", "Badge"])
        #expect(badge?.name == "Badge")
        #expect(badge?.path == "/components/badge")

        let borderRadius = GalleryLaunchArguments.galleryItem(
            from: ["HypenGallery", "--gallery-item=borderRadius"]
        )
        #expect(borderRadius?.name == "borderRadius")
        #expect(borderRadius?.path == "/applicators/borderRadius")

        let justifyContent = GalleryLaunchArguments.galleryItem(
            from: ["HypenGallery", "--gallery-item", "justifyContent"]
        )
        #expect(justifyContent?.name == "verticalAlignment")
        #expect(justifyContent?.path == "/applicators/justifyContent")

        let alignItems = GalleryLaunchArguments.galleryItem(
            from: ["HypenGallery", "--gallery-item=ALIGNITEMS"]
        )
        #expect(alignItems?.name == "horizontalAlignment")
        #expect(alignItems?.path == "/applicators/alignItems")

        #expect(GalleryLaunchArguments.galleryItem(from: ["HypenGallery"]) == nil)
        #expect(GalleryLaunchArguments.galleryItem(from: ["HypenGallery", "--gallery-item", ""]) == nil)
        #expect(
            GalleryLaunchArguments.galleryItem(
                from: ["HypenGallery", "--gallery-item", "does-not-exist"]
            ) == nil
        )
    }

}

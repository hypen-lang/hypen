// swift-tools-version: 6.0
// The swift-tools-version declares the minimum version of Swift required to build this package.

import PackageDescription

let package = Package(
    name: "HypenSwift",
    platforms: [
        .iOS(.v15),
        .macOS(.v12),
        .tvOS(.v15),
        .watchOS(.v8)
    ],
    products: [
        .library(
            name: "HypenSwift",
            targets: ["HypenSwift"]
        ),
    ],
    targets: [
        .target(
            name: "HypenSwift",
            path: "Sources/HypenSwift"
        ),
        .testTarget(
            name: "HypenSwiftTests",
            dependencies: ["HypenSwift"],
            path: "Tests/HypenSwiftTests"
        ),
    ]
)

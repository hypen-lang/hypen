// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "HypenServer",
    platforms: [
        .macOS(.v13),
        .iOS(.v16),
        .tvOS(.v16),
        .watchOS(.v9)
    ],
    products: [
        .library(
            name: "HypenServer",
            targets: ["HypenServer"]
        ),
        .library(
            name: "HypenEngine",
            targets: ["HypenEngine"]
        ),
    ],
    dependencies: [
        .package(url: "https://github.com/vapor/websocket-kit.git", from: "2.15.0"),
        .package(url: "https://github.com/apple/swift-nio.git", from: "2.65.0"),
    ],
    targets: [
        .systemLibrary(
            name: "hypen_engineFFI",
            path: "Sources/hypen_engineFFI"
        ),
        .target(
            name: "HypenEngine",
            dependencies: ["hypen_engineFFI"],
            path: "Sources/HypenEngine"
        ),
        .target(
            name: "HypenServer",
            dependencies: [
                "HypenEngine",
                .product(name: "WebSocketKit", package: "websocket-kit"),
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio"),
                .product(name: "NIOWebSocket", package: "swift-nio"),
            ],
            path: "Sources/HypenServer"
        ),
        .testTarget(
            name: "HypenServerTests",
            dependencies: ["HypenServer"],
            path: "Tests/HypenServerTests"
        ),
    ]
)

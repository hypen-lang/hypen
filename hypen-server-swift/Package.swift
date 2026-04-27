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
        // The Rust engine ships as a pre-built XCFramework so consumers
        // don't need a Rust toolchain. CI rebuilds for every release and
        // rewrites the URL + checksum below before tagging.
        //
        // For local development, run scripts/build-xcframework.sh and
        // switch this target to `.binaryTarget(name:..., path: "hypen_engineFFI.xcframework")`.
        .binaryTarget(
            name: "hypen_engineFFI",
            path: "hypen_engineFFI.xcframework"
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

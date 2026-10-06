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
        .executableTarget(name: "HypenDeviceLab", dependencies: ["HypenServer"], path: "Tests/DeviceLab"),
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
        // Device Capability Protocol end-to-end server: driven over a real
        // WebSocket by the TypeScript web client in Tests/DeviceE2E
        // (`Tests/DeviceE2E/run.sh`).
        .executableTarget(
            name: "HypenDeviceE2EServer",
            dependencies: ["HypenServer"],
            path: "Tests/DeviceE2E/Server"
        ),
        .testTarget(
            name: "HypenServerTests",
            // HypenEngine: DeviceBrokerBindingTests drives the generated
            // UniFFI device broker bindings directly. NIO + WebSocketKit:
            // WebSocketTransportOrderingTests runs WebSocketKitTransport
            // over a real loopback WebSocket.
            dependencies: [
                "HypenServer",
                "HypenEngine",
                .product(name: "WebSocketKit", package: "websocket-kit"),
                .product(name: "NIOCore", package: "swift-nio"),
                .product(name: "NIOPosix", package: "swift-nio"),
                .product(name: "NIOHTTP1", package: "swift-nio"),
                .product(name: "NIOWebSocket", package: "swift-nio"),
            ],
            path: "Tests/HypenServerTests"
        ),
    ]
)

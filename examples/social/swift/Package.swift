// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "HypenInstagramSwift",
    platforms: [
        .macOS(.v13),
    ],
    dependencies: [
        .package(path: "../../../hypen-renderer-swift"),
        .package(path: "../../../hypen-server-swift"),
    ],
    targets: [
        .executableTarget(
            name: "InstagramServer",
            dependencies: [
                .product(name: "HypenSwift", package: "hypen-renderer-swift"),
                .product(name: "HypenServer", package: "hypen-server-swift"),
            ],
            path: "Sources/InstagramServer",
            exclude: [
                "WebSocketServer.swift",
            ],
            linkerSettings: [
                .linkedLibrary("sqlite3"),
                .unsafeFlags([
                    "-L", "../../../target/release",
                ]),
            ]
        ),
    ]
)

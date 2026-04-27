// HypenSwift - A SwiftUI renderer for Hypen declarative UI
//
// This library provides SwiftUI components for rendering Hypen UI
// from a remote server via WebSocket.

@_exported import SwiftUI

// MARK: - Public API

/// Re-export main types for convenience
public typealias Element = HypenElement
public typealias Modifier = HypenModifier

// MARK: - Version

public enum HypenSwift {
    public static let version = "1.0.0"
}

import Foundation
import os.log

/// Log level for controlling what messages are shown
public enum HypenLogLevel: Int, Comparable {
    case debug = 0
    case info = 1
    case warn = 2
    case error = 3
    case none = 4

    public static func < (lhs: HypenLogLevel, rhs: HypenLogLevel) -> Bool {
        return lhs.rawValue < rhs.rawValue
    }
}

/// Configurable logger for Hypen framework
public final class HypenLogger: @unchecked Sendable {
    /// Shared instance for global configuration
    public static let shared = HypenLogger()

    /// Current log level (default: error-only)
    public var level: HypenLogLevel = .error

    /// Enable or disable debug mode
    public func setDebugMode(_ enabled: Bool) {
        level = enabled ? .debug : .error
    }

    /// Check if debug mode is enabled
    public var isDebugMode: Bool {
        return level == .debug
    }

    private init() {}
}

/// Tagged logger instance for debug logging
public struct DebugLogger: Sendable {
    let tag: String

    public init(_ tag: String) {
        self.tag = tag
    }

    private func shouldLog(_ level: HypenLogLevel) -> Bool {
        return level >= HypenLogger.shared.level
    }

    public func debug(_ message: String, _ args: CVarArg...) {
        guard shouldLog(.debug) else { return }
        let formatted = String(format: message, arguments: args)
        NSLog("[%@] DEBUG: %@", tag, formatted)
    }

    public func info(_ message: String, _ args: CVarArg...) {
        guard shouldLog(.info) else { return }
        let formatted = String(format: message, arguments: args)
        NSLog("[%@] INFO: %@", tag, formatted)
    }

    public func warn(_ message: String, _ args: CVarArg...) {
        guard shouldLog(.warn) else { return }
        let formatted = String(format: message, arguments: args)
        NSLog("[%@] WARN: %@", tag, formatted)
    }

    public func error(_ message: String, _ args: CVarArg...) {
        guard shouldLog(.error) else { return }
        let formatted = String(format: message, arguments: args)
        NSLog("[%@] ERROR: %@", tag, formatted)
    }

    /// Create a child logger with a sub-tag
    public func child(_ subTag: String) -> DebugLogger {
        return DebugLogger("\(tag):\(subTag)")
    }
}

// MARK: - Framework Loggers

/// Predefined loggers for framework components
public enum HypenLoggers {
    public static let renderer = DebugLogger("HypenSwift:Renderer")
    public static let remote = DebugLogger("HypenSwift:Remote")
    public static let view = DebugLogger("HypenSwift:View")
    public static let fonts = DebugLogger("HypenSwift:Fonts")
    public static let patch = DebugLogger("HypenSwift:Patch")
}

// MARK: - Convenience Functions

/// Enable or disable debug logging globally
public func setDebugMode(_ enabled: Bool) {
    HypenLogger.shared.setDebugMode(enabled)
}

/// Check if debug mode is enabled
public func isDebugMode() -> Bool {
    return HypenLogger.shared.isDebugMode
}

/// Set the global log level
public func setLogLevel(_ level: HypenLogLevel) {
    HypenLogger.shared.level = level
}

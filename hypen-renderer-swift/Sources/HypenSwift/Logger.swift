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

/// A pluggable sink for Hypen log output.
///
/// Implement this to route Hypen's logs into your own logging stack —
/// `os.Logger`, swift-log, an analytics pipeline, an in-app console. The SDK
/// keeps ownership of level filtering and message formatting; a handler is
/// only ever called for messages that passed `HypenLogger.shared.level`, and
/// receives the final, already-formatted strings.
public protocol HypenLogHandler: Sendable {
    func debug(tag: String, message: String)
    func info(tag: String, message: String)
    func warn(tag: String, message: String)
    func error(tag: String, message: String)
}

/// A `HypenLogHandler` backed by a single closure, for call sites that don't
/// want to declare a type:
///
/// ```swift
/// setLogHandler { level, tag, message in
///     myLogger.log(level: level, "[\(tag)] \(message)")
/// }
/// ```
public struct HypenClosureLogHandler: HypenLogHandler {
    private let emit: @Sendable (HypenLogLevel, String, String) -> Void

    /// - Parameter emit: invoked as `emit(level, tag, message)`. Never called
    ///   with `.none`.
    public init(_ emit: @escaping @Sendable (HypenLogLevel, String, String) -> Void) {
        self.emit = emit
    }

    public func debug(tag: String, message: String) { emit(.debug, tag, message) }
    public func info(tag: String, message: String) { emit(.info, tag, message) }
    public func warn(tag: String, message: String) { emit(.warn, tag, message) }
    public func error(tag: String, message: String) { emit(.error, tag, message) }
}

/// Configurable logger for Hypen framework
public final class HypenLogger: @unchecked Sendable {
    /// Shared instance for global configuration
    public static let shared = HypenLogger()

    /// Current log level (default: error-only)
    public var level: HypenLogLevel = .error

    /// Optional sink for log output. When non-nil it replaces the default
    /// `NSLog` output; when nil (the default) logs go to `NSLog` exactly as
    /// before.
    ///
    /// Like `level`, this is a plain `var` on an `@unchecked Sendable`
    /// singleton: **set it once at startup**, before any Hypen view or engine
    /// begins logging. Mutating it while logging is in flight is a data race.
    public var handler: (any HypenLogHandler)?

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

    // Messages are @autoclosure so interpolated strings on hot paths are
    // never built when the level check filters them out. Prefer the
    // no-args interpolation form for per-patch/per-render logging; the
    // CVarArg form still evaluates its arguments eagerly at the call site.
    // A custom handler does not change this: the guard runs first, so a
    // filtered message is never built and the handler is never called.
    public func debug(_ message: @autoclosure () -> String, _ args: CVarArg...) {
        guard shouldLog(.debug) else { return }
        let formatted = args.isEmpty ? message() : String(format: message(), arguments: args)
        if let handler = HypenLogger.shared.handler {
            handler.debug(tag: tag, message: formatted)
        } else {
            NSLog("[%@] DEBUG: %@", tag, formatted)
        }
    }

    public func info(_ message: @autoclosure () -> String, _ args: CVarArg...) {
        guard shouldLog(.info) else { return }
        let formatted = args.isEmpty ? message() : String(format: message(), arguments: args)
        if let handler = HypenLogger.shared.handler {
            handler.info(tag: tag, message: formatted)
        } else {
            NSLog("[%@] INFO: %@", tag, formatted)
        }
    }

    public func warn(_ message: @autoclosure () -> String, _ args: CVarArg...) {
        guard shouldLog(.warn) else { return }
        let formatted = args.isEmpty ? message() : String(format: message(), arguments: args)
        if let handler = HypenLogger.shared.handler {
            handler.warn(tag: tag, message: formatted)
        } else {
            NSLog("[%@] WARN: %@", tag, formatted)
        }
    }

    public func error(_ message: @autoclosure () -> String, _ args: CVarArg...) {
        guard shouldLog(.error) else { return }
        let formatted = args.isEmpty ? message() : String(format: message(), arguments: args)
        if let handler = HypenLogger.shared.handler {
            handler.error(tag: tag, message: formatted)
        } else {
            NSLog("[%@] ERROR: %@", tag, formatted)
        }
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

/// Route all Hypen logs into a custom handler.
///
/// Pass `nil` to restore the default `NSLog` output. Set this once at
/// startup — see `HypenLogger.handler`.
public func setLogHandler(_ handler: (any HypenLogHandler)?) {
    HypenLogger.shared.handler = handler
}

/// Route all Hypen logs into a closure, invoked as `(level, tag, message)`.
///
/// Set this once at startup — see `HypenLogger.handler`.
public func setLogHandler(_ emit: @escaping @Sendable (HypenLogLevel, String, String) -> Void) {
    HypenLogger.shared.handler = HypenClosureLogHandler(emit)
}

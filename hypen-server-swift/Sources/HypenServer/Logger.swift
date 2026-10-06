import Foundation

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
/// `os.Logger`, swift-log, an analytics pipeline, a structured JSON sink. The
/// SDK keeps ownership of level filtering and message formatting; a handler is
/// only ever called for messages that passed `HypenLoggerConfig.shared.level`,
/// and receives the final, already-formatted strings.
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

/// Global logging configuration for the Hypen server.
public final class HypenLoggerConfig: @unchecked Sendable {
    /// Shared instance for global configuration
    public static let shared = HypenLoggerConfig()

    /// Current log level.
    ///
    /// Defaults to `.debug` in DEBUG builds and `.info` otherwise, which
    /// reproduces the previous `#if DEBUG`-gated behaviour exactly: debug
    /// lines only in debug builds, info/warn/error always.
    #if DEBUG
    public var level: HypenLogLevel = .debug
    #else
    public var level: HypenLogLevel = .info
    #endif

    /// Optional sink for log output. When non-nil it replaces the default
    /// `print` output; when nil (the default) logs go to `print` exactly as
    /// before.
    ///
    /// Like `level`, this is a plain `var` on an `@unchecked Sendable`
    /// singleton: **set it once at startup**, before the server begins
    /// serving. Mutating it while logging is in flight is a data race.
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

/// Simple structured logger for the Hypen server.
public struct HypenLogger: Sendable {
    public let module: String

    public init(_ module: String) {
        self.module = module
    }

    private func shouldLog(_ level: HypenLogLevel) -> Bool {
        return level >= HypenLoggerConfig.shared.level
    }

    // Messages are @autoclosure so interpolated strings on hot paths are
    // never built when the level check filters them out. The CVarArg form
    // still evaluates its arguments eagerly at the call site. A custom
    // handler does not change this: the guard runs first, so a filtered
    // message is never built and the handler is never called.
    public func info(_ message: @autoclosure () -> String, _ args: any CVarArg...) {
        guard shouldLog(.info) else { return }
        let formatted = args.isEmpty ? message() : String(format: message(), arguments: args)
        if let handler = HypenLoggerConfig.shared.handler {
            handler.info(tag: module, message: formatted)
        } else {
            print("[\(module)] INFO: \(formatted)")
        }
    }

    public func debug(_ message: @autoclosure () -> String, _ args: any CVarArg...) {
        guard shouldLog(.debug) else { return }
        let formatted = args.isEmpty ? message() : String(format: message(), arguments: args)
        if let handler = HypenLoggerConfig.shared.handler {
            handler.debug(tag: module, message: formatted)
        } else {
            print("[\(module)] DEBUG: \(formatted)")
        }
    }

    public func warn(_ message: @autoclosure () -> String, _ args: any CVarArg...) {
        guard shouldLog(.warn) else { return }
        let formatted = args.isEmpty ? message() : String(format: message(), arguments: args)
        if let handler = HypenLoggerConfig.shared.handler {
            handler.warn(tag: module, message: formatted)
        } else {
            print("[\(module)] WARN: \(formatted)")
        }
    }

    public func warning(_ message: @autoclosure () -> String, _ args: any CVarArg...) {
        guard shouldLog(.warn) else { return }
        let formatted = args.isEmpty ? message() : String(format: message(), arguments: args)
        if let handler = HypenLoggerConfig.shared.handler {
            handler.warn(tag: module, message: formatted)
        } else {
            print("[\(module)] WARN: \(formatted)")
        }
    }

    public func error(_ message: @autoclosure () -> String, _ args: any CVarArg...) {
        guard shouldLog(.error) else { return }
        let formatted = args.isEmpty ? message() : String(format: message(), arguments: args)
        if let handler = HypenLoggerConfig.shared.handler {
            handler.error(tag: module, message: formatted)
        } else {
            print("[\(module)] ERROR: \(formatted)")
        }
    }
}

public enum HypenLoggers {
    public static let server = HypenLogger("HypenServer")
    public static let client = HypenLogger("HypenClient")
    public static let module = HypenLogger("HypenModule")
    public static let engine = HypenLogger("HypenEngine")
}

// MARK: - Convenience Functions

/// Enable or disable debug logging globally
public func setDebugMode(_ enabled: Bool) {
    HypenLoggerConfig.shared.setDebugMode(enabled)
}

/// Check if debug mode is enabled
public func isDebugMode() -> Bool {
    return HypenLoggerConfig.shared.isDebugMode
}

/// Set the global log level
public func setLogLevel(_ level: HypenLogLevel) {
    HypenLoggerConfig.shared.level = level
}

/// Route all Hypen logs into a custom handler.
///
/// Pass `nil` to restore the default `print` output. Set this once at
/// startup — see `HypenLoggerConfig.handler`.
public func setLogHandler(_ handler: (any HypenLogHandler)?) {
    HypenLoggerConfig.shared.handler = handler
}

/// Route all Hypen logs into a closure, invoked as `(level, tag, message)`.
///
/// Set this once at startup — see `HypenLoggerConfig.handler`.
public func setLogHandler(_ emit: @escaping @Sendable (HypenLogLevel, String, String) -> Void) {
    HypenLoggerConfig.shared.handler = HypenClosureLogHandler(emit)
}

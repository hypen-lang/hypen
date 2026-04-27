import Foundation

/// Simple structured logger for the Hypen server.
public struct HypenLogger: Sendable {
    public let module: String

    public init(_ module: String) {
        self.module = module
    }

    public func info(_ message: String, _ args: any CVarArg...) {
        let formatted = args.isEmpty ? message : String(format: message, arguments: args)
        print("[\(module)] INFO: \(formatted)")
    }

    public func debug(_ message: String, _ args: any CVarArg...) {
        #if DEBUG
        let formatted = args.isEmpty ? message : String(format: message, arguments: args)
        print("[\(module)] DEBUG: \(formatted)")
        #endif
    }

    public func warn(_ message: String, _ args: any CVarArg...) {
        let formatted = args.isEmpty ? message : String(format: message, arguments: args)
        print("[\(module)] WARN: \(formatted)")
    }

    public func warning(_ message: String, _ args: any CVarArg...) {
        let formatted = args.isEmpty ? message : String(format: message, arguments: args)
        print("[\(module)] WARN: \(formatted)")
    }

    public func error(_ message: String, _ args: any CVarArg...) {
        let formatted = args.isEmpty ? message : String(format: message, arguments: args)
        print("[\(module)] ERROR: \(formatted)")
    }
}

public enum HypenLoggers {
    public static let server = HypenLogger("HypenServer")
    public static let client = HypenLogger("HypenClient")
    public static let module = HypenLogger("HypenModule")
    public static let engine = HypenLogger("HypenEngine")
}

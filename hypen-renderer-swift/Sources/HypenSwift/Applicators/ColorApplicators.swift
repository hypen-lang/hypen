import SwiftUI

// MARK: - Background Color Applicator

public struct BackgroundColorApplicator: ApplicatorHandler {
    public let name = "backgroundcolor"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let color = ColorParser.parse(value) {
            modifier.backgroundColor = color
        }
    }
}

// MARK: - Background Applicator (alias)

public struct BackgroundApplicator: ApplicatorHandler {
    public let name = "background"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let color = ColorParser.parse(value) {
            modifier.backgroundColor = color
        }
    }
}

// MARK: - Foreground Color Applicator

public struct ForegroundColorApplicator: ApplicatorHandler {
    public let name = "foregroundcolor"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let color = ColorParser.parse(value) {
            modifier.foregroundColor = color
        }
    }
}

// MARK: - Color Applicator (for text)

public struct ColorApplicator: ApplicatorHandler {
    public let name = "color"

    public init() {}

    public func apply(modifier: inout HypenModifier, value: Any?, context: ApplicatorContext) {
        if let color = ColorParser.parse(value) {
            modifier.foregroundColor = color
        }
    }
}
